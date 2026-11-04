/**
 * Building blocks of the layer effects (plan section 15.1): smoothed parameter writes that skip
 * unchanged targets, LFOs (phase-shifted sines, optionally started on a master clock beat), the
 * shaping curves, a Slot that switches a unit in and out with a 20 ms crossfade and builds it on
 * first use, and a Selector that crossfades between a unit's types, also built on first use.
 */
import type { ClockReader } from './types.ts';

/** Parameter smoothing (10 ms, as the synth engine). */
export const SMOOTH = 0.01;
/** The unit and type crossfades: ≈ 20 ms to −40 dB. */
export const XFADE = 0.005;

const LAST = new WeakMap<AudioParam, number>();

/** Glide a parameter to `value` (setTargetAtTime); a target equal to the last one set here is skipped. */
export function glide(param: AudioParam, value: number, t: number, tau = SMOOTH): void {
  const v = Number.isFinite(value) ? value : 0;
  if (LAST.get(param) === v) return;
  LAST.set(param, v);
  param.setTargetAtTime(v, t, tau);
}

/** Set a parameter's value at once (a node's initial state); later glides start from it. */
export function setNow(param: AudioParam, value: number): void {
  param.value = value;
  LAST.set(param, value);
}

/** Forget the last target of a parameter (after other automation was scheduled on it). */
export function forget(param: AudioParam): void {
  LAST.delete(param);
}

/** A gain node at an initial gain. */
export function gainNode(ctx: BaseAudioContext, gain = 1): GainNode {
  const g = ctx.createGain();
  setNow(g.gain, gain);
  return g;
}

/** A biquad filter. */
export function biquad(ctx: BaseAudioContext, type: BiquadFilterType, frequency: number, q = 0.707, gainDb = 0): BiquadFilterNode {
  const f = ctx.createBiquadFilter();
  f.type = type;
  setNow(f.frequency, frequency);
  setNow(f.Q, q);
  setNow(f.gain, gainDb);
  return f;
}

/**
 * When an LFO starts: now, or with a clock the next beat of the master clock's grid (plus `offset`
 * seconds), so synced LFOs begin on the beat. The phase drifts once the rate changes (approximation).
 */
export function lfoStart(ctx: BaseAudioContext, clock: ClockReader | null, offset = 0): number {
  const now = ctx.currentTime;
  if (clock === null) return now;
  const beat = 60 / Math.min(240, Math.max(30, clock.bpm()));
  const anchor = clock.anchor();
  if (!Number.isFinite(anchor)) return now;
  const k = Math.ceil((now - anchor - offset) / beat);
  return Math.max(now, anchor + offset + k * beat);
}

/** A sine LFO shifted by `phaseDeg` degrees (a one-harmonic PeriodicWave); 0 is a plain sine. */
export function sineLfo(ctx: BaseAudioContext, hz: number, phaseDeg = 0): OscillatorNode {
  const o = ctx.createOscillator();
  if (phaseDeg !== 0) {
    const p = (phaseDeg * Math.PI) / 180;
    o.setPeriodicWave(ctx.createPeriodicWave(new Float32Array([0, Math.sin(p)]), new Float32Array([0, Math.cos(p)])));
  }
  setNow(o.frequency, hz);
  return o;
}

/** A shaped LFO (square, sawtooth). */
export function shapeLfo(ctx: BaseAudioContext, type: OscillatorType, hz: number): OscillatorNode {
  const o = ctx.createOscillator();
  o.type = type;
  setNow(o.frequency, hz);
  return o;
}

/** A WaveShaper curve sampled over −1..1. */
export function curve(fn: (x: number) => number, n = 1025): Float32Array<ArrayBuffer> {
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) c[i] = fn((i / (n - 1)) * 2 - 1);
  return c;
}

/** A wave shaper with a curve. */
export function shaper(ctx: BaseAudioContext, c: Float32Array<ArrayBuffer> | null, oversample: OverSampleType = 'none'): WaveShaperNode {
  const s = ctx.createWaveShaper();
  s.curve = c;
  s.oversample = oversample;
  return s;
}

/** One unit or type: a subgraph between `input` and `output`. */
export interface Stage<S> {
  readonly input: AudioNode;
  readonly output: AudioNode;
  /** Follow new settings at time `t`. */
  update(s: S, t: number): void;
  /** Cut tails at once (panic, load). */
  silence?(t: number): void;
  /** A performance controller (the Mod 1 PED types). */
  controller?(kind: string, value: number, t: number): void;
  /** Stop and disconnect every node. */
  dispose(): void;
}

/**
 * A unit switched in or out (its Enable, Layer Effects ON, Global mode): off, the signal passes
 * dry; on, it runs through the stage. The stage is built the first time the unit switches on and
 * kept until dispose, so an idle unit costs two gain nodes. `cutTail`: switching off also cuts the
 * stage's tail (delay, reverb: silent within 20 ms, plan 15.1).
 */
export class Slot<S> {
  readonly input: GainNode;
  readonly output: GainNode;
  readonly #ctx: BaseAudioContext;
  readonly #build: () => Stage<S>;
  readonly #cutTail: boolean;
  readonly #dry: GainNode;
  #wet: GainNode | null = null;
  #stage: Stage<S> | null = null;
  #on = false;

  constructor(ctx: BaseAudioContext, build: () => Stage<S>, cutTail = false) {
    this.#ctx = ctx;
    this.#build = build;
    this.#cutTail = cutTail;
    this.input = gainNode(ctx);
    this.output = gainNode(ctx);
    this.#dry = gainNode(ctx);
    this.input.connect(this.#dry).connect(this.output);
  }

  get on(): boolean {
    return this.#on;
  }

  /** The stage once built (tests, controllers). */
  get stage(): Stage<S> | null {
    return this.#stage;
  }

  /** The crossfade gains (tests): dry passes the signal around the stage, wet carries the stage. */
  get gains(): { readonly dry: AudioParam; readonly wet: AudioParam | null } {
    return { dry: this.#dry.gain, wet: this.#wet?.gain ?? null };
  }

  /** Switch the unit and, while on, follow `settings` (read lazily: an off unit reads nothing). */
  set(on: boolean, settings: () => S, t: number): void {
    if (on && this.#stage === null) {
      this.#stage = this.#build();
      this.#wet = gainNode(this.#ctx, 0);
      this.input.connect(this.#stage.input);
      this.#stage.output.connect(this.#wet).connect(this.output);
    }
    if (on) this.#stage!.update(settings(), t);
    if (on !== this.#on && !on && this.#cutTail) this.#stage?.silence?.(t);
    this.#on = on;
    glide(this.#dry.gain, on ? 0 : 1, t, XFADE);
    if (this.#wet !== null) glide(this.#wet.gain, on ? 1 : 0, t, XFADE);
  }

  silence(t: number): void {
    this.#stage?.silence?.(t);
  }

  controller(kind: string, value: number, t: number): void {
    this.#stage?.controller?.(kind, value, t);
  }

  dispose(): void {
    this.#stage?.dispose();
    for (const n of [this.input, this.output, this.#dry, this.#wet]) n?.disconnect();
  }
}

/**
 * The types of a unit (Mod 1's six, Mod 2's six, the delay loop's effects): only the selected one
 * is heard, a change crossfades in 20 ms; each type is built the first time it is selected and
 * kept until dispose (built types keep running silently: a CPU cost, not a sound).
 */
export class Selector<K extends string, S> {
  readonly input: GainNode;
  readonly output: GainNode;
  readonly #ctx: BaseAudioContext;
  readonly #build: (k: K) => Stage<S>;
  readonly #built = new Map<K, { readonly stage: Stage<S>; readonly gate: GainNode }>();
  #current: K | null = null;

  constructor(ctx: BaseAudioContext, build: (k: K) => Stage<S>) {
    this.#ctx = ctx;
    this.#build = build;
    this.input = gainNode(ctx);
    this.output = gainNode(ctx);
  }

  get current(): K | null {
    return this.#current;
  }

  /** The stage of a type once built. */
  stage(k: K): Stage<S> | null {
    return this.#built.get(k)?.stage ?? null;
  }

  select(k: K, s: S, t: number): void {
    let entry = this.#built.get(k);
    if (entry === undefined) {
      const stage = this.#build(k);
      const gate = gainNode(this.#ctx, 0);
      this.input.connect(stage.input);
      stage.output.connect(gate).connect(this.output);
      entry = { stage, gate };
      this.#built.set(k, entry);
    }
    entry.stage.update(s, t);
    if (this.#current !== k) {
      for (const [key, e] of this.#built) glide(e.gate.gain, key === k ? 1 : 0, t, XFADE);
      this.#current = k;
    }
  }

  silence(t: number): void {
    for (const e of this.#built.values()) e.stage.silence?.(t);
  }

  controller(kind: string, value: number, t: number): void {
    if (this.#current !== null) this.#built.get(this.#current)!.stage.controller?.(kind, value, t);
  }

  dispose(): void {
    for (const e of this.#built.values()) {
      e.stage.dispose();
      e.gate.disconnect();
    }
    this.input.disconnect();
    this.output.disconnect();
  }
}

/** Disconnect nodes and stop sources, ignoring nodes that were never started. */
export function release(nodes: ReadonlyArray<AudioNode | null>): void {
  for (const n of nodes) {
    if (n === null) continue;
    if ('stop' in n && typeof (n as AudioScheduledSourceNode).stop === 'function') {
      try {
        (n as AudioScheduledSourceNode).stop();
      }
      catch {
        // never started
      }
    }
    n.disconnect();
  }
}

/** A dry/wet pair around a stage: input ─► dry ─► output, wet ─► output; the stage connects into `wet`. */
export interface DryWet {
  readonly dry: GainNode;
  readonly wet: GainNode;
}

export function dryWet(ctx: BaseAudioContext, input: AudioNode, output: AudioNode): DryWet {
  const dry = gainNode(ctx);
  const wet = gainNode(ctx, 0);
  input.connect(dry).connect(output);
  wet.connect(output);
  return { dry, wet };
}
