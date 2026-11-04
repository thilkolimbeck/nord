/**
 * The pure DSP of the AudioWorklet engine (plan section 15.7): band-limited oscillators for the
 * analog categories Sync, Shape, Shape Sine, Multi and Super (M p.29–30), the LP M transistor
 * ladder (M p.31) and the filter drive (M p.32). No Web Audio and no DOM: the processor
 * (processor.ts) and the Node tests run the same code. The waves follow waveforms.ts, the native
 * engine's definitions, so both engines play the same shapes; every curve is an approximation
 * (unverified: nothing here is measured on a Stage 4).
 *
 * Band limiting (PolyBLEP family): a naive wave plus a two-sample polynomial correction at every
 * jump. The correction runs one sample late (BlepLine), so a jump anywhere inside a sample interval,
 * a hard-sync reset at any slave phase included, also corrects the sample before it. Kinks
 * (triangle tips, folds) are not corrected.
 */
import {
  type BasicShape, multiIntervals, shapeSineSample, syncRatio,
} from '../waveforms.ts';
import type { WorkletOscKind } from './protocol.ts';

/** The largest phase step per sample (just below Nyquist); a partial above it is muted. */
export const MAX_INC = 0.49;

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

function frac(x: number): number {
  return x - Math.floor(x);
}

// ---------------------------------------------------------------------------------------------
// PolyBLEP

/**
 * Two-point PolyBLEP correction with one sample of latency. For a jump of height h (value after −
 * before) that happened `ago` samples before the sample being made (0 ≤ ago < 1), the sample before
 * the jump gets +h/2·ago² and the sample after it −h/2·(1 − ago)²: at the jump both meet halfway.
 */
export class BlepLine {
  #held = 0;
  #heldFix = 0;
  #fix = 0;

  /** A jump of `height` (after − before), `ago` samples before the sample being made now. */
  step(height: number, ago: number): void {
    const h = 0.5 * height;
    const b = 1 - ago;
    this.#heldFix += h * ago * ago;
    this.#fix -= h * b * b;
  }

  /** The naive sample made now in; the corrected sample before it out. */
  push(naive: number): number {
    const out = this.#held + this.#heldFix;
    this.#held = naive;
    this.#heldFix = this.#fix;
    this.#fix = 0;
    return out;
  }
}

/** A shape's jumps: phase in [0, 1) and height (value just after − just before, moving forward). */
export type Edges = ReadonlyArray<readonly [phase: number, height: number]>;

const NO_EDGES: Edges = [];
const SAW_EDGES: Edges = [[0, -2]];
const SQUARE_EDGES: Edges = [[0, 2], [0.5, -2]];
const PULSE33_EDGES: Edges = [[0, 2], [1 / 3, -2]];
const PULSE10_EDGES: Edges = [[0, 2], [0.1, -2]];
/** Shape Sine ESaw: the saw half a cycle late, so it jumps at phase 0.5. */
const HALF_SAW_EDGES: Edges = [[0.5, -2]];

/** The jumps of a basic shape (waveforms.ts basic); sine and triangle have none. */
export function edgesOf(shape: BasicShape): Edges {
  switch (shape) {
    case 'saw': return SAW_EDGES;
    case 'square': return SQUARE_EDGES;
    case 'pulse33': return PULSE33_EDGES;
    case 'pulse10': return PULSE10_EDGES;
    default: return NO_EDGES;
  }
}

/**
 * Report to `line` every jump of `edges` a phase passed moving from `from` (in [0, 1)) by `inc` in
 * one sample (|inc| < 1; a phase moving backwards passes its jumps the other way, so their sign
 * flips), each scaled by `scale`. A phase exactly on a jump has already passed it.
 */
export function passEdges(from: number, inc: number, edges: Edges, scale: number, line: BlepLine): void {
  if (inc === 0 || scale === 0) return;
  const to = from + inc;
  for (let i = 0; i < edges.length; i++) {
    const edge = edges[i]!;
    const e = edge[0];
    if (inc > 0) {
      const x = from < e ? e : e + 1;
      if (x <= to) line.step(edge[1] * scale, (to - x) / inc);
    } else {
      const x = from >= e ? e : e - 1;
      if (x > to) line.step(-edge[1] * scale, (to - x) / inc);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Oscillator cores (one unison copy each)

/** One copy of a worklet oscillator. */
export interface OscCore {
  /** The naive value of the next sample at phase step `dt` and osc ctrl 0..1; jumps go to `line`. */
  next(dt: number, ctrl: number, line: BlepLine): number;
}

/** Sync waves in table order (M p.29): Sine, Triangle, Saw, Square, Pulse 33, Pulse 10, Chop Saw 1, Chop Saw 2, Chop Square. */
const SYNC_SHAPES: readonly BasicShape[] = ['sine', 'triangle', 'saw', 'square', 'pulse33', 'pulse10', 'saw', 'saw', 'square'];

/**
 * Hard sync (M p.29): a slave at 1…8 × the master's pitch (waveforms.ts syncRatio, osc ctrl), reset
 * at every master cycle; the reset is a jump at a fractional sample position, corrected like any
 * other. The Chop waves window the slave with a falling ramp (Chop Saw 1, Chop Square) or a
 * half-cycle gate (Chop Saw 2), as waveforms.ts syncSample.
 */
export class SyncCore implements OscCore {
  readonly #code: number;
  readonly #edges: Edges;
  /** 0 none, 1 falling ramp, 2 half-cycle gate. */
  readonly #window: 0 | 1 | 2;
  #master: number;
  #slave: number;

  constructor(wave: number, phase = 0) {
    const shape = SYNC_SHAPES[wave] ?? 'saw';
    this.#code = SHAPE_CODES.indexOf(shape);
    this.#edges = edgesOf(shape);
    this.#window = wave === 6 || wave === 8 ? 1 : wave === 7 ? 2 : 0;
    this.#master = frac(phase);
    this.#slave = 0;
  }

  #win(m: number): number {
    return this.#window === 1 ? 1 - m : this.#window === 2 ? (m < 0.5 ? 1 : 0) : 1;
  }

  next(dt: number, ctrl: number, line: BlepLine): number {
    const ds = Math.min(dt * syncRatio(ctrl), MAX_INC);
    const m0 = this.#master;
    let m1 = m0 + dt;
    const s0 = this.#slave;
    if (m1 >= 1) {
      m1 -= 1;
      const ago = dt > 0 ? m1 / dt : 0;
      // The slave runs up to the reset, jumps back to phase 0 there and runs on for `ago` samples.
      const before = ds * (1 - ago);
      passEdges(s0, before, this.#edges, this.#win(m0), line);
      const atReset = frac(s0 + before);
      const endWindow = this.#window === 0 ? 1 : 0;
      line.step(shapeAt(this.#code, 0) - endWindow * shapeAt(this.#code, atReset), ago);
      const after = ds * ago;
      passEdges(0, after, this.#edges, 1, line);
      this.#slave = frac(after);
    } else {
      passEdges(s0, ds, this.#edges, this.#win(m1), line);
      const s1 = s0 + ds;
      if (this.#window === 2 && m0 < 0.5 && m1 >= 0.5) {
        const ago = (m1 - 0.5) / dt;
        line.step(-shapeAt(this.#code, frac(s1 - ds * ago)), ago);
      }
      this.#slave = frac(s1);
    }
    this.#master = m1;
    return this.#win(m1) * shapeAt(this.#code, this.#slave);
  }
}

/** shapeBase() of waveforms.ts for a phase already in [0, 1): Triangle, Saw, Square, Half Sine, Parabolic. */
export function shapeBaseAt(wave: number, x: number): number {
  switch (wave) {
    case 0: return x < 0.25 ? 4 * x : x < 0.75 ? 2 - 4 * x : 4 * x - 4;
    case 2: return x < 0.5 ? 1 : -1;
    case 3: return 2 * Math.abs(Math.sin(Math.PI * x)) - 1;
    case 4: return 1 - 8 * (x - 0.5) * (x - 0.5);
    default: return 2 * x - 1;
  }
}

/**
 * Shape (M p.29): the base wave minus a copy `w` of a cycle later, halved (the native engine's
 * delay method, per sample here): w = 0.5 − 0.45 × osc ctrl, so Shape Saw is a pulse from 50 % to
 * 5 % (PWM by two band-limited saws) and Shape Square a square narrowing to spikes.
 */
export class ShapeCore implements OscCore {
  readonly #wave: number;
  readonly #edges: Edges;
  #p: number;
  #w = Number.NaN;
  #q = 0;

  constructor(wave: number, phase = 0) {
    this.#wave = wave;
    this.#edges = wave === 2 ? SQUARE_EDGES : wave === 0 || wave === 3 || wave === 4 ? NO_EDGES : SAW_EDGES;
    this.#p = frac(phase);
  }

  next(dt: number, ctrl: number, line: BlepLine): number {
    const w = 0.5 - 0.45 * clamp(ctrl, 0, 1);
    const p0 = this.#p;
    if (Number.isNaN(this.#w)) {
      this.#w = w;
      this.#q = frac(p0 - w);
    }
    passEdges(p0, dt, this.#edges, 0.5, line);
    passEdges(this.#q, dt - (w - this.#w), this.#edges, -0.5, line);
    const p1 = frac(p0 + dt);
    this.#p = p1;
    this.#w = w;
    this.#q = frac(p1 - w);
    return 0.5 * (shapeBaseAt(this.#wave, p1) - shapeBaseAt(this.#wave, this.#q));
  }
}

/**
 * Shape Sine (M p.30): a sine turned into the selected wave by osc ctrl, per sample (waveforms.ts
 * shapeSineSample: phase distortion, soft clip, squeeze, fold, crossfades), so the osc envelope and
 * the LFO sweep it at audio rate. The crossfaded ESaw and ESquare jumps are corrected.
 */
export class ShapeSineCore implements OscCore {
  readonly #wave: number;
  #p: number;

  constructor(wave: number, phase = 0) {
    this.#wave = wave;
    this.#p = frac(phase);
  }

  next(dt: number, ctrl: number, line: BlepLine): number {
    const c = clamp(ctrl, 0, 1);
    const p0 = this.#p;
    if (this.#wave === 5) passEdges(p0, dt, HALF_SAW_EDGES, c, line);
    else if (this.#wave === 6) passEdges(p0, dt, SQUARE_EDGES, c, line);
    const p1 = frac(p0 + dt);
    this.#p = p1;
    return shapeSineSample(this.#wave, c, p1);
  }
}

/** basic() of waveforms.ts for a phase already in [0, 1), by shape code (the hot loops avoid string switches). */
export function shapeAt(code: number, x: number): number {
  switch (code) {
    case 0: return Math.sin(2 * Math.PI * x);
    case 1: return x < 0.25 ? 4 * x : x < 0.75 ? 2 - 4 * x : 4 * x - 4;
    case 2: return 2 * x - 1;
    case 3: return x < 0.5 ? 1 : -1;
    case 4: return x < 1 / 3 ? 1 : -1;
    default: return x < 0.1 ? 1 : -1;
  }
}

/** The codes of shapeAt in BasicShape order. */
export const SHAPE_CODES: readonly BasicShape[] = ['sine', 'triangle', 'saw', 'square', 'pulse33', 'pulse10'];

/** Osc ctrl changes smaller than this keep a stack's detune ratios (under 0.3 cents of detune at the widest spread). */
const STACK_CTRL_STEP = 1 / 256;

/**
 * A stack of oscillators at fixed intervals (cents), detuned against each other by osc ctrl ×
 * `spreadCents` (Multi, M p.30: "the OSC CTRL parameter determines the amount of Detune"; Super),
 * summed at 1/√n.
 */
export class StackCore implements OscCore {
  readonly #code: number;
  readonly #edges: Edges;
  /** 2^(interval / 1200) per oscillator. */
  readonly #base: Float64Array;
  readonly #spreadCents: number;
  readonly #phases: Float64Array;
  readonly #ratios: Float64Array;
  readonly #gain: number;
  #ctrl = Number.NaN;

  constructor(shape: BasicShape, intervals: readonly number[], spreadCents: number, phases: readonly number[]) {
    const n = intervals.length;
    this.#code = SHAPE_CODES.indexOf(shape);
    this.#edges = edgesOf(shape);
    this.#base = Float64Array.from(intervals, (c) => 2 ** (c / 1200));
    this.#spreadCents = spreadCents;
    this.#phases = Float64Array.from({ length: n }, (_, i) => frac(phases[i] ?? 0));
    this.#ratios = new Float64Array(n);
    this.#gain = 1 / Math.sqrt(n);
  }

  get size(): number {
    return this.#phases.length;
  }

  /** The oscillators' frequency ratios at the last osc ctrl value, for inspection. */
  get ratios(): readonly number[] {
    return Array.from(this.#ratios);
  }

  next(dt: number, ctrl: number, line: BlepLine): number {
    const c = clamp(ctrl, 0, 1);
    const n = this.#phases.length;
    if (!(Math.abs(c - this.#ctrl) < STACK_CTRL_STEP)) {
      // The detunes c × spreadOffsets(n, spread) are evenly spaced, so their ratios are a geometric series.
      this.#ctrl = c;
      const width = (c * this.#spreadCents) / 1200;
      let m = n > 1 ? 2 ** -width : 1;
      const step = n > 1 ? 2 ** ((2 * width) / (n - 1)) : 1;
      for (let i = 0; i < n; i++) {
        this.#ratios[i] = this.#base[i]! * m;
        m *= step;
      }
    }
    const code = this.#code;
    const gain = this.#gain;
    const phases = this.#phases;
    const ratios = this.#ratios;
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const inc = dt * ratios[i]!;
      const p0 = phases[i]!;
      let p1 = p0 + inc;
      if (inc > MAX_INC) {
        phases[i] = p1 - Math.floor(p1);
        continue;
      }
      if (code === 2) {
        // Saw, the common case, inline: one jump of -2 at the wrap.
        if (p1 >= 1) {
          p1 -= 1;
          line.step(-2 * gain, p1 / inc);
        }
        phases[i] = p1;
        sum += 2 * p1 - 1;
        continue;
      }
      passEdges(p0, inc, this.#edges, gain, line);
      if (p1 >= 1) p1 -= 1;
      phases[i] = p1;
      sum += shapeAt(code, p1);
    }
    return sum * gain;
  }
}

/** Super Organ's intervals (cents), as oscillators.ts. */
const SUPER_ORGAN = [0, 1200, 1900, 2400, 3100, 3600, 0];

/**
 * Oscillators per copy of a Super stack: 7, fewer per copy in unison (M p.30: unison raises the
 * count; at most 16 per voice for the CPU).
 */
export function superCount(copies: number): number {
  return Math.min(7, Math.max(4, Math.floor(16 / Math.max(1, copies))));
}

/**
 * One copy's core for a worklet kind and wave (table order as display-ns4 and waveforms.ts).
 * `phase` is the copy's start phase; `random` gives the other start phases of a stack.
 */
export function makeCore(kind: WorkletOscKind, wave: number, copies: number, phase: number, random: () => number): OscCore {
  const phases = (n: number): number[] => Array.from({ length: n }, (_, i) => (i === 0 ? phase : random()));
  switch (kind) {
    case 'sync': return new SyncCore(wave, phase);
    case 'shape': return new ShapeCore(wave, phase);
    case 'shapeSine': return new ShapeSineCore(wave, phase);
    case 'multi': {
      const intervals = multiIntervals(wave);
      return new StackCore('saw', intervals, 25, phases(intervals.length));
    }
    case 'super': {
      // Super Saw, Super Square, Super Organ, Super Saw Bright, Super Square Bright (oscillators.ts).
      const n = superCount(copies);
      const bright = wave === 3 || wave === 4;
      const shape: BasicShape = wave === 1 || wave === 4 ? 'square' : wave === 2 ? 'sine' : 'saw';
      const intervals = Array.from({ length: n }, (_, i) => (wave === 2 ? SUPER_ORGAN[i % SUPER_ORGAN.length]! : 0));
      return new StackCore(shape, intervals, bright ? 60 : 45, phases(n));
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Drive and the LP M ladder

/** tanh by a rational approximation that meets ±1 smoothly at |x| = 3 (error below 2 %). */
export function softTanh(x: number): number {
  if (x >= 3) return 1;
  if (x <= -3) return -1;
  const a = x * x;
  return (x * (27 + a)) / (27 + 9 * a);
}

/** softTanh(x) / x (1 at 0): the ladder's per-stage gain. */
function tanhOver(x: number): number {
  const a = x * x;
  return a < 9 ? (27 + a) / (27 + 9 * a) : 1 / Math.abs(x);
}

/**
 * The drive stage (M p.32, unverified): tanh(g·x) / tanh(g) for an input gain g > 1, so ±1 stays ±1
 * and quiet signals rise by about g; g ≤ 1 is clean. The voice sets g from mapping.ts driveGain
 * (off/1/2/3 → 1, 2, 4, 8), as the native WaveShaper curve.
 */
export function driveSample(x: number, gain: number): number {
  return gain <= 1 ? x : softTanh(gain * x) / softTanh(gain);
}

/**
 * Feedback at resonance 1. The linear ladder self-oscillates from a loop gain of 4 on, so this
 * self-oscillates from resonance 0.9 (the tuning of Mystran's cheap zero-delay ladder).
 */
export const LADDER_FEEDBACK = 40 / 9;
/**
 * The share of the ladder's passband loss at high resonance that the input gain makes up: the M
 * filter keeps more of the low end than a plain 24 dB low pass (M p.31). A guess.
 */
export const LADDER_COMPENSATION = 0.5;

/** The ladder's tuning coefficient for a cutoff in Hz at twice `sampleRate` (2× oversampled). */
export function ladderCoefficient(hz: number, sampleRate: number): number {
  const fc = clamp(hz, 10, 0.45 * sampleRate);
  return Math.tan((Math.PI * fc) / (2 * sampleRate));
}

/**
 * A 4-pole transistor ladder (LP M, M p.31): four zero-delay one-poles in a resonance loop, a tanh
 * per stage evaluated from the stage states (Mystran's "cheap non-linear zero-delay filter"
 * scheme: stable for any cutoff and feedback, self-oscillation limited by the tanh).
 */
export class Ladder {
  #s0 = 0;
  #s1 = 0;
  #s2 = 0;
  #s3 = 0;

  /** One step at the oversampled rate: input `x`, coefficient `f` (ladderCoefficient), feedback `k` (0..LADDER_FEEDBACK). */
  step(x: number, f: number, k: number): number {
    const s0 = this.#s0;
    const s1 = this.#s1;
    const s2 = this.#s2;
    const s3 = this.#s3;
    const t0 = tanhOver(x - k * s3);
    const t1 = tanhOver(s0);
    const t2 = tanhOver(s1);
    const t3 = tanhOver(s2);
    const t4 = tanhOver(s3);
    const g0 = 1 / (1 + f * t1);
    const g1 = 1 / (1 + f * t2);
    const g2 = 1 / (1 + f * t3);
    const g3 = 1 / (1 + f * t4);
    const f3 = f * t3 * g3;
    const f2 = f * t2 * g2 * f3;
    const f1 = f * t1 * g1 * f2;
    const f0 = f * t0 * g0 * f1;
    const y3 = (g3 * s3 + f3 * g2 * s2 + f2 * g1 * s1 + f1 * g0 * s0 + f0 * x) / (1 + k * f0);
    const xx = t0 * (x - k * y3);
    const y0 = t1 * g0 * (s0 + f * xx);
    const y1 = t2 * g1 * (s1 + f * y0);
    const y2 = t3 * g2 * (s2 + f * y1);
    this.#s0 = s0 + 2 * f * (xx - y0);
    this.#s1 = s1 + 2 * f * (y0 - y1);
    this.#s2 = s2 + 2 * f * (y1 - y2);
    this.#s3 = s3 + 2 * f * (y2 - t4 * y3);
    return y3;
  }

  /** Take over another ladder's state (a stereo pair that played the same signal so far). */
  copyFrom(other: Ladder): void {
    this.#s0 = other.#s0;
    this.#s1 = other.#s1;
    this.#s2 = other.#s2;
    this.#s3 = other.#s3;
  }

  /** Flush tiny states to zero (denormals cost CPU on some machines). */
  flush(): void {
    const tiny = 1e-15;
    if (Math.abs(this.#s0) < tiny) this.#s0 = 0;
    if (Math.abs(this.#s1) < tiny) this.#s1 = 0;
    if (Math.abs(this.#s2) < tiny) this.#s2 = 0;
    if (Math.abs(this.#s3) < tiny) this.#s3 = 0;
  }
}
