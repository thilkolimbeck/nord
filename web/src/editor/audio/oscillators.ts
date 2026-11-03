/**
 * Oscillator sources on native Web Audio nodes (plan section 4.1, decision 2a). One graph per
 * voice: unison copies of a core, each core built for the osc type and category of mapping.ts
 * OscSpec. Pitch arrives in cents on every OscillatorNode's detune from the voice's pitch source
 * (frequency stays at 440 Hz × ratio); osc ctrl arrives as a 0..1 signal from the voice's ctrl
 * source and is scaled into the parameter it drives:
 *
 * - Pure: native sine, triangle, saw, square; pulse 33 % and 10 % as PeriodicWave; white noise.
 * - Sub Osc: a saw plus a square, pulse or sine one octave down; osc ctrl = sub level.
 * - Sync, Shape Sine: a static PeriodicWave of the synced or shaped cycle for the current osc ctrl
 *   value, rebuilt when it changes; envelope and LFO cannot sweep it (marked coarse).
 * - Shape: the base wave minus a delayed copy (pulse-width method); osc ctrl moves the delay.
 * - Multi, Super: stacks of detuned saws (squares, sines); osc ctrl = detune spread.
 * - Misc: pink and red noise, Bell as FM.
 * - FM-H, FM-I: a sine modulator into the carrier's frequency; osc ctrl = modulation index.
 *   Ratios and index ranges are guesses (feasibility doc: partial and pitch values partly decoded).
 */
import type { OscSpec } from './mapping.ts';
import {
  basic, type BasicShape, cycle, multiIntervals, noise, type NoiseColour, shapeBase, shapeSineSample, spreadOffsets,
  syncSample, toCoefficients,
} from './waveforms.ts';

export interface OscInputs {
  /** Pitch in cents re A4: connected to every oscillator's detune. */
  readonly pitch: AudioNode;
  /** Osc ctrl 0..1 (plus modulation). */
  readonly ctrl: AudioNode;
}

export interface OscGraph {
  readonly output: GainNode;
  start(t: number): void;
  stop(t: number): void;
  /** Calls `fn` once, after every source of the graph has stopped (on the audio clock). */
  onEnded(fn: () => void): void;
  /** Static waves (Sync, Shape Sine) follow a new osc ctrl value. */
  setCtrl(ctrl: number): void;
  /** Pitch-dependent parts (the Shape pulse width) follow a new base pitch, cents re A4. */
  retune(cents: number, t: number): void;
  disconnect(): void;
}

const A4 = 440;
/** Static waves are rebuilt in 1/32 steps of osc ctrl. */
const CTRL_STEPS = 32;
const NOISE_SECONDS = 2;
/** At most this many oscillators per voice: stacks shrink as unison grows. */
const NODE_BUDGET = 8;

const waveCache = new WeakMap<BaseAudioContext, Map<string, PeriodicWave>>();
const bufferCache = new WeakMap<BaseAudioContext, Map<string, AudioBuffer>>();

function periodicWave(ctx: BaseAudioContext, id: string, fn: (p: number) => number): PeriodicWave {
  let map = waveCache.get(ctx);
  if (map === undefined) {
    map = new Map();
    waveCache.set(ctx, map);
  }
  let wave = map.get(id);
  if (wave === undefined) {
    const { real, imag } = toCoefficients(cycle(fn));
    wave = ctx.createPeriodicWave(real, imag);
    map.set(id, wave);
  }
  return wave;
}

function noiseBuffer(ctx: BaseAudioContext, colour: NoiseColour): AudioBuffer {
  let map = bufferCache.get(ctx);
  if (map === undefined) {
    map = new Map();
    bufferCache.set(ctx, map);
  }
  let buf = map.get(colour);
  if (buf === undefined) {
    const length = Math.round(ctx.sampleRate * NOISE_SECONDS);
    buf = ctx.createBuffer(1, length, ctx.sampleRate);
    buf.getChannelData(0).set(noise(colour, length, colour === 'white' ? 1 : colour === 'pink' ? 2 : 3));
    map.set(colour, buf);
  }
  return buf;
}

function quantise(ctrl: number): number {
  return Math.round(Math.min(1, Math.max(0, ctrl)) * CTRL_STEPS) / CTRL_STEPS;
}

function period(cents: number): number {
  return 1 / (A4 * 2 ** (cents / 1200));
}

/** Collects the nodes of one graph so start, stop and disconnect reach all of them. */
class Builder {
  readonly sources: Array<{ node: AudioScheduledSourceNode; offset: number }> = [];
  readonly nodes: AudioNode[] = [];
  readonly ctrlHooks: Array<(ctrl: number) => void> = [];
  readonly retuneHooks: Array<(cents: number, t: number) => void> = [];
  /** Connections from the voice's pitch and ctrl sources, undone on disconnect. */
  readonly links: Array<readonly [AudioNode, AudioParam | AudioNode]> = [];

  readonly ctx: BaseAudioContext;
  readonly inputs: OscInputs;

  constructor(ctx: BaseAudioContext, inputs: OscInputs) {
    this.ctx = ctx;
    this.inputs = inputs;
  }

  gain(value: number): GainNode {
    const g = this.ctx.createGain();
    g.gain.value = value;
    this.nodes.push(g);
    return g;
  }

  /** An oscillator at 440 Hz × ratio with a fixed detune on top of the voice pitch. */
  osc(wave: OscillatorType | PeriodicWave, ratio: number, detune: number): OscillatorNode {
    const o = this.ctx.createOscillator();
    if (wave instanceof PeriodicWave) o.setPeriodicWave(wave);
    else o.type = wave;
    o.frequency.value = A4 * ratio;
    o.detune.value = detune;
    this.inputs.pitch.connect(o.detune);
    this.links.push([this.inputs.pitch, o.detune]);
    this.sources.push({ node: o, offset: 0 });
    this.nodes.push(o);
    return o;
  }

  noise(colour: NoiseColour, offset: number): AudioBufferSourceNode {
    const src = this.ctx.createBufferSource();
    src.buffer = noiseBuffer(this.ctx, colour);
    src.loop = true;
    this.sources.push({ node: src, offset: offset % NOISE_SECONDS });
    this.nodes.push(src);
    return src;
  }

  /** osc ctrl × scale into a parameter. */
  ctrlTo(param: AudioParam, scale: number): GainNode {
    const g = this.gain(scale);
    this.inputs.ctrl.connect(g);
    this.links.push([this.inputs.ctrl, g]);
    g.connect(param);
    return g;
  }
}

const BASIC_NATIVE: Readonly<Partial<Record<BasicShape, OscillatorType>>> = {
  sine: 'sine', triangle: 'triangle', saw: 'sawtooth', square: 'square',
};

function basicOsc(b: Builder, shape: BasicShape, ratio: number, detune: number): OscillatorNode {
  const native = BASIC_NATIVE[shape];
  return b.osc(native ?? periodicWave(b.ctx, `basic:${shape}`, (p) => basic(shape, p)), ratio, detune);
}

/** One copy of the oscillator for a spec; returns its output node. */
function core(b: Builder, spec: OscSpec, detune: number, copy: number, copies: number, cents: number): AudioNode {
  const out = b.gain(1);
  const fm = (ratio: number, maxIndex: number): void => {
    const car = b.osc('sine', 1, detune);
    const mod = b.osc('sine', ratio, detune);
    const depth = b.gain(0);
    mod.connect(depth);
    depth.connect(car.frequency);
    b.ctrlTo(depth.gain, maxIndex * A4 * ratio);
    car.connect(out);
  };
  const ctrl = spec.ctrl;

  if (spec.bank !== 'analog') {
    if (spec.bank === 'fm-h') fm(spec.algorithm + 1, 6);
    else fm(2 ** (spec.semitones / 12), 2 + spec.algorithm);
    return out;
  }

  switch (spec.category) {
    case 'pure': {
      const shapes: BasicShape[] = ['sine', 'triangle', 'saw', 'square', 'pulse33', 'pulse10'];
      const shape = shapes[spec.wave];
      if (shape === undefined) b.noise('white', copy * 0.37).connect(out);
      else basicOsc(b, shape, 1, detune).connect(out);
      return out;
    }
    case 'sub': {
      const main = basicOsc(b, 'saw', 1, detune);
      const mainGain = b.gain(0.7);
      main.connect(mainGain).connect(out);
      const subShape: BasicShape = (['square', 'pulse33', 'sine'] as const)[spec.wave] ?? 'square';
      const sub = basicOsc(b, subShape, 0.5, detune);
      const subGain = b.gain(0);
      sub.connect(subGain).connect(out);
      b.ctrlTo(subGain.gain, 0.8);
      return out;
    }
    case 'sync':
    case 'shapeSine': {
      const wave = spec.wave;
      const make = (c: number): PeriodicWave => periodicWave(b.ctx, `${spec.category}:${wave}:${c}`,
        (p) => (spec.category === 'sync' ? syncSample(wave, c, p) : shapeSineSample(wave, c, p)));
      let current = quantise(ctrl);
      const o = b.osc(make(current), 1, detune);
      o.connect(out);
      b.ctrlHooks.push((c) => {
        const q = quantise(c);
        if (q === current) return;
        current = q;
        o.setPeriodicWave(make(q));
      });
      return out;
    }
    case 'shape': {
      const wave = spec.wave;
      const o = b.osc(periodicWave(b.ctx, `shape:${wave}`, (p) => shapeBase(wave, p)), 1, detune);
      const delay = b.ctx.createDelay(0.2);
      b.nodes.push(delay);
      const invert = b.gain(-1);
      const mix = b.gain(0.5);
      o.connect(mix);
      o.connect(delay).connect(invert).connect(mix);
      mix.connect(out);
      const width = b.ctrlTo(delay.delayTime, 0);
      const tune = (c: number, t: number): void => {
        const T = Math.min(0.2, period(c + detune));
        delay.delayTime.setValueAtTime(Math.min(0.19, 0.5 * T), t);
        width.gain.setValueAtTime(-0.45 * T, t);
      };
      tune(cents, b.ctx.currentTime);
      b.retuneHooks.push(tune);
      return out;
    }
    case 'multi': {
      const intervals = multiIntervals(spec.wave);
      const spread = spreadOffsets(intervals.length, 25);
      out.gain.value = 1 / Math.sqrt(intervals.length);
      intervals.forEach((interval, i) => {
        const o = basicOsc(b, 'saw', 1, detune + interval);
        b.ctrlTo(o.detune, spread[i]!);
        o.connect(out);
      });
      return out;
    }
    case 'super': {
      const n = copies === 1 ? 7 : Math.max(2, Math.floor(NODE_BUDGET / copies));
      const bright = spec.wave === 3 || spec.wave === 4;
      const shape: BasicShape = spec.wave === 1 || spec.wave === 4 ? 'square' : spec.wave === 2 ? 'sine' : 'saw';
      const organ = [0, 1200, 1900, 2400, 3100, 3600, 0];
      const spread = spreadOffsets(n, bright ? 60 : 45);
      out.gain.value = 1 / Math.sqrt(n);
      for (let i = 0; i < n; i++) {
        const o = basicOsc(b, shape, 1, detune + (spec.wave === 2 ? organ[i % organ.length]! : 0));
        b.ctrlTo(o.detune, spread[i]!);
        o.connect(out);
      }
      return out;
    }
    case 'misc': {
      if (spec.wave === 0) b.noise('pink', copy * 0.41).connect(out);
      else if (spec.wave === 1) b.noise('red', copy * 0.43).connect(out);
      else fm(3.5, 1 + 5 * ctrl);
      return out;
    }
  }
}

/** The oscillator graph of one voice: unison copies, each detuned and panned, summed into `output`. */
export function buildOscGraph(ctx: BaseAudioContext, spec: OscSpec, inputs: OscInputs,
  unison: { copies: number; spreadCents: number }, cents: number): OscGraph {
  const b = new Builder(ctx, inputs);
  const copies = Math.max(1, Math.round(unison.copies));
  const output = b.gain(1 / Math.sqrt(copies));
  const detunes = spreadOffsets(copies, unison.spreadCents);
  const pans = spreadOffsets(copies, 0.6);
  for (let i = 0; i < copies; i++) {
    const out = core(b, spec, detunes[i]!, i, copies, cents);
    if (copies === 1) out.connect(output);
    else {
      const pan = ctx.createStereoPanner();
      pan.pan.value = pans[i]!;
      b.nodes.push(pan);
      out.connect(pan).connect(output);
    }
  }
  return {
    output,
    start(t: number): void {
      for (const s of b.sources) {
        if (s.node instanceof AudioBufferSourceNode) s.node.start(t, s.offset);
        else s.node.start(t);
      }
    },
    stop(t: number): void {
      for (const s of b.sources) s.node.stop(t);
    },
    onEnded(fn: () => void): void {
      let left = b.sources.length;
      if (left === 0) {
        fn();
        return;
      }
      for (const s of b.sources) {
        s.node.onended = () => {
          s.node.onended = null;
          if (--left === 0) fn();
        };
      }
    },
    setCtrl(ctrl: number): void {
      for (const fn of b.ctrlHooks) fn(ctrl);
    },
    retune(c: number, t: number): void {
      for (const fn of b.retuneHooks) fn(c, t);
    },
    disconnect(): void {
      for (const [from, to] of b.links) {
        try {
          if (to instanceof AudioParam) from.disconnect(to);
          else from.disconnect(to);
        } catch {
          // Already disconnected (the voice's sources went first).
        }
      }
      for (const n of b.nodes) n.disconnect();
    },
  };
}
