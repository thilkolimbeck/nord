/**
 * Mod 1 (manual p.49, plan section 15.1): A-Pan, Tremolo, Ring Modulator, Auto-Wah, Wah and Pump,
 * each with its variation (Wah and Pump: PED, the control pedal). Approximations on Web Audio
 * nodes; the shapes and ranges are invented, nothing is measured on a Stage 4.
 */
import { type Mod1Family, type Mod1Settings } from './params.ts';
import {
  biquad, curve, dryWet, type DryWet, forget, gainNode, glide, lfoStart, release, Selector, setNow, shapeLfo, shaper, sineLfo,
  type Stage,
} from './nodes.ts';
import type { ClockReader } from './types.ts';

/** The control pedal as Mod 1 reads it: its position, and whether it moved since the program loaded (p.49). */
export interface PedalState {
  value: number;
  moved: boolean;
}

/** Wah sweep (plan 15.1): a resonant low-pass from 400 Hz to 2.5 kHz. */
const WAH_LOW = 400;
const WAH_CENTS = 1200 * Math.log2(2500 / WAH_LOW);
/** A-Wah: a band-pass from 350 Hz up to 350 Hz × 2^(4 × sensitivity), driven by the input's envelope. */
const AWAH_LOW = 350;
/** Envelope follower gain: a signal envelope near 0.5 reaches the top of the sweep (assumed). */
const FOLLOWER_GAIN = 2;

class PanFx implements Stage<Mod1Settings> {
  readonly input: GainNode;
  readonly output: StereoPannerNode;
  readonly #lfo: OscillatorNode;
  readonly #plain: GainNode;
  readonly #hard: GainNode;
  readonly #shape: WaveShaperNode;

  constructor(ctx: BaseAudioContext, clock: ClockReader | null, s: Mod1Settings) {
    this.input = gainNode(ctx);
    this.output = ctx.createStereoPanner();
    setNow(this.output.pan, 0);
    this.input.connect(this.output);
    this.#lfo = sineLfo(ctx, s.rateHz);
    this.#plain = gainNode(ctx, 0);
    this.#hard = gainNode(ctx, 0);
    // Variation: a harder shape (the sine through tanh ×3).
    this.#shape = shaper(ctx, curve((x) => Math.tanh(3 * x) / Math.tanh(3)));
    this.#lfo.connect(this.#plain).connect(this.output.pan);
    this.#lfo.connect(this.#shape).connect(this.#hard).connect(this.output.pan);
    this.#lfo.start(lfoStart(ctx, s.synced ? clock : null));
  }

  update(s: Mod1Settings, t: number): void {
    glide(this.#lfo.frequency, s.rateHz, t);
    glide(this.#plain.gain, s.variation ? 0 : s.amount, t);
    glide(this.#hard.gain, s.variation ? s.amount : 0, t);
  }

  dispose(): void {
    release([this.#lfo, this.#plain, this.#hard, this.#shape, this.input, this.output]);
  }
}

class TremFx implements Stage<Mod1Settings> {
  readonly input: GainNode;
  readonly output: GainNode;
  readonly #sine: OscillatorNode;
  readonly #square: OscillatorNode;
  readonly #sineDepth: GainNode;
  readonly #squareDepth: GainNode;

  constructor(ctx: BaseAudioContext, clock: ClockReader | null, s: Mod1Settings) {
    this.input = gainNode(ctx);
    this.output = gainNode(ctx, 1);
    this.input.connect(this.output);
    this.#sine = sineLfo(ctx, s.rateHz);
    this.#square = shapeLfo(ctx, 'square', s.rateHz);
    this.#sineDepth = gainNode(ctx, 0);
    this.#squareDepth = gainNode(ctx, 0);
    this.#sine.connect(this.#sineDepth).connect(this.output.gain);
    this.#square.connect(this.#squareDepth).connect(this.output.gain);
    const at = lfoStart(ctx, s.synced ? clock : null);
    this.#sine.start(at);
    this.#square.start(at);
  }

  /** gain = 1 − amount × (0.5 + 0.5 × LFO): amount 0 is full level (p.49); variation: a square LFO. */
  update(s: Mod1Settings, t: number): void {
    glide(this.#sine.frequency, s.rateHz, t);
    glide(this.#square.frequency, s.rateHz, t);
    glide(this.output.gain, 1 - s.amount / 2, t);
    glide(this.#sineDepth.gain, s.variation ? 0 : -s.amount / 2, t);
    glide(this.#squareDepth.gain, s.variation ? -s.amount / 2 : 0, t);
  }

  dispose(): void {
    release([this.#sine, this.#square, this.#sineDepth, this.#squareDepth, this.input, this.output]);
  }
}

class RingModFx implements Stage<Mod1Settings> {
  readonly input: GainNode;
  readonly output: GainNode;
  readonly #mix: DryWet;
  readonly #sin: OscillatorNode;
  readonly #cos: OscillatorNode;
  readonly #ringL: GainNode;
  readonly #ringR: GainNode;
  readonly #rSin: GainNode;
  readonly #rCos: GainNode;
  readonly #split: ChannelSplitterNode;
  readonly #merge: ChannelMergerNode;

  constructor(ctx: BaseAudioContext, s: Mod1Settings) {
    this.input = gainNode(ctx);
    this.output = gainNode(ctx);
    this.#mix = dryWet(ctx, this.input, this.output);
    this.#split = ctx.createChannelSplitter(2);
    this.#merge = ctx.createChannelMerger(2);
    this.#ringL = gainNode(ctx, 0);
    this.#ringR = gainNode(ctx, 0);
    this.input.connect(this.#split);
    this.#split.connect(this.#ringL, 0);
    this.#split.connect(this.#ringR, 1);
    this.#ringL.connect(this.#merge, 0, 0);
    this.#ringR.connect(this.#merge, 0, 1);
    this.#merge.connect(this.#mix.wet);
    // The ring's gain is the sine: output = input × sine. Variation: the right channel's sine 90° on (stereo).
    this.#sin = sineLfo(ctx, s.rateHz);
    this.#cos = sineLfo(ctx, s.rateHz, 90);
    this.#rSin = gainNode(ctx, 1);
    this.#rCos = gainNode(ctx, 0);
    this.#sin.connect(this.#ringL.gain);
    this.#sin.connect(this.#rSin).connect(this.#ringR.gain);
    this.#cos.connect(this.#rCos).connect(this.#ringR.gain);
    const at = ctx.currentTime;
    this.#sin.start(at);
    this.#cos.start(at);
  }

  update(s: Mod1Settings, t: number): void {
    glide(this.#sin.frequency, s.rateHz, t);
    glide(this.#cos.frequency, s.rateHz, t);
    glide(this.#rSin.gain, s.variation ? 0 : 1, t);
    glide(this.#rCos.gain, s.variation ? 1 : 0, t);
    glide(this.#mix.dry.gain, 1 - s.amount, t);
    glide(this.#mix.wet.gain, s.amount, t);
  }

  dispose(): void {
    release([this.#sin, this.#cos, this.#rSin, this.#rCos, this.#ringL, this.#ringR, this.#split, this.#merge,
      this.#mix.dry, this.#mix.wet, this.input, this.output]);
  }
}

class AutoWahFx implements Stage<Mod1Settings> {
  readonly input: GainNode;
  readonly output: GainNode;
  readonly #mix: DryWet;
  readonly #rect: WaveShaperNode;
  readonly #smooth: BiquadFilterNode;
  readonly #depth: GainNode;
  readonly #bp: BiquadFilterNode;
  readonly #lp: BiquadFilterNode;
  readonly #bpOut: GainNode;
  readonly #lpOut: GainNode;

  constructor(ctx: BaseAudioContext) {
    this.input = gainNode(ctx);
    this.output = gainNode(ctx);
    this.#mix = dryWet(ctx, this.input, this.output);
    // Envelope follower: rectifier ─► 15 Hz low-pass ─► depth (cents) ─► the filters' detune.
    this.#rect = shaper(ctx, curve((x) => Math.abs(x)));
    this.#smooth = biquad(ctx, 'lowpass', 15);
    this.#depth = gainNode(ctx, 0);
    this.input.connect(this.#rect).connect(this.#smooth).connect(this.#depth);
    this.#bp = biquad(ctx, 'bandpass', AWAH_LOW, 5);
    this.#lp = biquad(ctx, 'lowpass', AWAH_LOW, 8);
    this.#depth.connect(this.#bp.detune);
    this.#depth.connect(this.#lp.detune);
    this.#bpOut = gainNode(ctx, 1);
    this.#lpOut = gainNode(ctx, 0);
    this.input.connect(this.#bp).connect(this.#bpOut).connect(this.#mix.wet);
    this.input.connect(this.#lp).connect(this.#lpOut).connect(this.#mix.wet);
  }

  /** The rate knob is the sensitivity (p.49); variation: a resonant low-pass instead of the band-pass. */
  update(s: Mod1Settings, t: number): void {
    glide(this.#depth.gain, 4800 * s.knob * FOLLOWER_GAIN, t);
    glide(this.#bpOut.gain, s.variation ? 0 : 1, t);
    glide(this.#lpOut.gain, s.variation ? 1 : 0, t);
    glide(this.#mix.dry.gain, 1 - s.amount, t);
    glide(this.#mix.wet.gain, s.amount, t);
  }

  dispose(): void {
    release([this.#rect, this.#smooth, this.#depth, this.#bp, this.#lp, this.#bpOut, this.#lpOut, this.#mix.dry,
      this.#mix.wet, this.input, this.output]);
  }
}

class WahFx implements Stage<Mod1Settings> {
  readonly input: GainNode;
  readonly output: GainNode;
  readonly #mix: DryWet;
  readonly #filter: BiquadFilterNode;
  readonly #lfo: OscillatorNode;
  readonly #depth: GainNode;
  readonly #pedal: PedalState;
  #last: Mod1Settings | null = null;

  constructor(ctx: BaseAudioContext, clock: ClockReader | null, s: Mod1Settings, pedal: PedalState) {
    this.#pedal = pedal;
    this.input = gainNode(ctx);
    this.output = gainNode(ctx);
    this.#mix = dryWet(ctx, this.input, this.output);
    this.#filter = biquad(ctx, 'lowpass', WAH_LOW, 6);
    this.input.connect(this.#filter).connect(this.#mix.wet);
    this.#lfo = sineLfo(ctx, s.rateHz);
    this.#depth = gainNode(ctx, 0);
    this.#lfo.connect(this.#depth).connect(this.#filter.detune);
    this.#lfo.start(lfoStart(ctx, s.synced ? clock : null));
  }

  /**
   * Normal: an LFO sweeps the filter. PED: the control pedal sets the position once it has moved
   * since the program loaded; before that the rate knob sets a static position (p.49).
   */
  update(s: Mod1Settings, t: number): void {
    this.#last = s;
    glide(this.#lfo.frequency, s.rateHz, t);
    const position = this.#pedal.moved ? this.#pedal.value / 127 : s.knob;
    glide(this.#filter.detune, s.variation ? position * WAH_CENTS : WAH_CENTS / 2, t);
    glide(this.#depth.gain, s.variation ? 0 : WAH_CENTS / 2, t);
    glide(this.#mix.dry.gain, 1 - s.amount, t);
    glide(this.#mix.wet.gain, s.amount, t);
  }

  controller(kind: string, _value: number, t: number): void {
    if (kind === 'pedal' && this.#last !== null && this.#last.variation) this.update(this.#last, t);
  }

  dispose(): void {
    release([this.#lfo, this.#depth, this.#filter, this.#mix.dry, this.#mix.wet, this.input, this.output]);
  }
}

/** Pump's duck over one LFO cycle: down to 1 − amount at the wrap, back up over 80 % of the cycle. */
export function pumpDuck(phase: number): number {
  const p = Math.min(1, Math.max(0, phase));
  return p < 0.8 ? (1 - p / 0.8) ** 2 : 0;
}

class PumpFx implements Stage<Mod1Settings> {
  readonly input: GainNode;
  readonly output: GainNode;
  readonly #saw: OscillatorNode;
  readonly #shape: WaveShaperNode;
  readonly #depth: GainNode;
  readonly #ctx: BaseAudioContext;
  #last: Mod1Settings | null = null;
  #pedalWasHigh = false;

  constructor(ctx: BaseAudioContext, clock: ClockReader | null, s: Mod1Settings) {
    this.#ctx = ctx;
    this.input = gainNode(ctx);
    this.output = gainNode(ctx, 1);
    this.input.connect(this.output);
    // A rising sawtooth wraps at half its period; −1 just after the wrap is the deepest point.
    this.#saw = shapeLfo(ctx, 'sawtooth', s.rateHz);
    this.#shape = shaper(ctx, curve((x) => pumpDuck((x + 1) / 2)));
    this.#depth = gainNode(ctx, 0);
    this.#saw.connect(this.#shape).connect(this.#depth).connect(this.output.gain);
    // Start half a cycle early so the wrap (the duck) lands on the beat.
    this.#saw.start(lfoStart(ctx, s.synced ? clock : null, s.synced ? -0.5 / s.rateHz : 0));
  }

  update(s: Mod1Settings, t: number): void {
    this.#last = s;
    glide(this.#saw.frequency, s.rateHz, t);
    glide(this.#depth.gain, s.variation ? 0 : -s.amount, t);
    if (!s.variation) glide(this.output.gain, 1, t);
  }

  /** PED: a duck each time the control pedal rises through 64 (assumed; the Stage 4 uses a switch pedal, p.49). */
  controller(kind: string, value: number, t: number): void {
    if (kind !== 'pedal') return;
    const high = value >= 64;
    const s = this.#last;
    if (high && !this.#pedalWasHigh && s !== null && s.variation) {
      const g = this.output.gain;
      const at = Math.max(t, this.#ctx.currentTime);
      g.cancelScheduledValues(at);
      g.setTargetAtTime(1 - s.amount, at, 0.0017);
      g.setTargetAtTime(1, at + 0.005, (0.8 / s.rateHz) / 4);
      forget(g);
    }
    this.#pedalWasHigh = high;
  }

  dispose(): void {
    release([this.#saw, this.#shape, this.#depth, this.input, this.output]);
  }
}

/** Mod 1 of one chain: the six types behind a Selector, and the control pedal state for the PED types. */
export class Mod1 implements Stage<Mod1Settings> {
  readonly #sel: Selector<Mod1Family, Mod1Settings>;
  readonly pedal: PedalState = { value: 0, moved: false };
  #last: Mod1Settings | null = null;

  constructor(ctx: BaseAudioContext, clock: ClockReader | null) {
    this.#sel = new Selector<Mod1Family, Mod1Settings>(ctx, (k) => {
      const s = this.#last!;
      switch (k) {
        case 'pan': return new PanFx(ctx, clock, s);
        case 'trem': return new TremFx(ctx, clock, s);
        case 'rm': return new RingModFx(ctx, s);
        case 'awah': return new AutoWahFx(ctx);
        case 'wah': return new WahFx(ctx, clock, s, this.pedal);
        case 'pump': return new PumpFx(ctx, clock, s);
      }
    });
  }

  get input(): AudioNode {
    return this.#sel.input;
  }

  get output(): AudioNode {
    return this.#sel.output;
  }

  /** The type playing now (tests). */
  get family(): Mod1Family | null {
    return this.#sel.current;
  }

  stage(k: Mod1Family): Stage<Mod1Settings> | null {
    return this.#sel.stage(k);
  }

  update(s: Mod1Settings, t: number): void {
    this.#last = s;
    this.#sel.select(s.family, s, t);
  }

  controller(kind: string, value: number, t: number): void {
    if (kind === 'pedal') {
      this.pedal.value = Math.min(127, Math.max(0, value));
      this.pedal.moved = true;
    }
    this.#sel.controller(kind, value, t);
  }

  /** A program loaded: the PED types fall back to the rate knob until the pedal moves again (p.49). */
  programLoaded(): void {
    this.pedal.moved = false;
  }

  dispose(): void {
    this.#sel.dispose();
  }
}
