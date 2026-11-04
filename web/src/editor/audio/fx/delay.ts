/**
 * Delay (manual p.50–51, plan section 15.1): two delay lines (left, right) with feedback, ping
 * pong, a filter and an effect inside the loop, normal or analog mode, free time or a master clock
 * division. Approximations on Web Audio nodes:
 *
 *   input ─► split ─► dL, dR (ping pong: everything into dL) ─► merge ─► duck ─► wet ─► output
 *                        ▲                                       │
 *                        └── split ◄─ mute ◄─ feedback ◄─ sat ◄─ loop fx ◄─ filter ◄┘
 *                            (normal: L→dL, R→dR; ping pong: L→dR, R→dL)
 *
 * Normal mode: a new time jumps behind a 15 ms dip, so repeats never bend in pitch (p.50:
 * "Tapping will never result in a pitch change"; the plan's two-line crossfade is approximated by
 * the dip). Analog mode: the time glides (τ 0.15 s), so repeats bend, and a soft tanh saturates
 * the loop (p.51).
 */
import { mod2RateHz } from '../../model/fx.ts';
import { DELAY_MAX_SECONDS, type DelayFilter, type DelaySettings, equalPower, type LoopFx } from './params.ts';
import { mod2Type } from './mod2.ts';
import {
  biquad, curve, dryWet, type DryWet, gainNode, glide, release, Selector, setNow, shaper, type Stage,
} from './nodes.ts';

const ANALOG_TAU = 0.15;
const DIP = 0.015;
/** The analog loop's saturation: tanh with pre-gain 1.5, unity slope at zero. */
const ANALOG_CURVE = curve((x) => Math.tanh(1.5 * x) / 1.5);

interface LoopSettings {
  readonly variation: boolean;
}

/** FLAM: the right side 20 ms later (variation 40 ms). */
class Flam implements Stage<LoopSettings> {
  readonly input: GainNode;
  readonly output: ChannelMergerNode;
  readonly #split: ChannelSplitterNode;
  readonly #offset: DelayNode;

  constructor(ctx: BaseAudioContext) {
    this.input = gainNode(ctx);
    this.#split = ctx.createChannelSplitter(2);
    this.output = ctx.createChannelMerger(2);
    this.#offset = ctx.createDelay(0.05);
    this.input.connect(this.#split);
    this.#split.connect(this.output, 0, 0);
    this.#split.connect(this.#offset, 1).connect(this.output, 0, 1);
  }

  update(s: LoopSettings, t: number): void {
    glide(this.#offset.delayTime, s.variation ? 0.04 : 0.02, t);
  }

  dispose(): void {
    release([this.#split, this.#offset, this.input, this.output]);
  }
}

/** SPACE: four all-pass stages diffuse the repeats, mixed 50 % (variation 100 %). */
class Space implements Stage<LoopSettings> {
  readonly input: GainNode;
  readonly output: GainNode;
  readonly #mix: DryWet;
  readonly #stages: BiquadFilterNode[];

  constructor(ctx: BaseAudioContext) {
    this.input = gainNode(ctx);
    this.output = gainNode(ctx);
    this.#mix = dryWet(ctx, this.input, this.output);
    this.#stages = [210, 650, 1700, 4100].map((hz) => biquad(ctx, 'allpass', hz, 0.5));
    let prev: AudioNode = this.input;
    for (const s of this.#stages) prev = prev.connect(s);
    prev.connect(this.#mix.wet);
  }

  update(s: LoopSettings, t: number): void {
    glide(this.#mix.dry.gain, s.variation ? 0 : 0.5, t);
    glide(this.#mix.wet.gain, s.variation ? 1 : 0.5, t);
  }

  dispose(): void {
    release([...this.#stages, this.#mix.dry, this.#mix.wet, this.input, this.output]);
  }
}

class Thru implements Stage<LoopSettings> {
  readonly input: GainNode;
  readonly output: GainNode;
  constructor(ctx: BaseAudioContext) {
    this.input = gainNode(ctx);
    this.output = this.input;
  }
  update(): void {}
  dispose(): void {
    this.input.disconnect();
  }
}

/** The loop's Ensemble, Vibe and Chorus: the Mod 2 models at a fixed medium rate and depth (assumed). */
const LOOP_MOD2_RATE = mod2RateHz(64);

/**
 * The peak gain of the loop's Mod 2 models at amount 0.5, [normal, variation]: they keep their dry
 * path, so dry and wet add up where they are in phase (low frequencies). Chorus: 1 + 0.7 (one
 * delay per side; the third is silent at amount 0.5), variation 1 + 0.8. Vibe: 0.7 + 0.7 (all-pass
 * stages). Ensemble: 1 + 0.5 × the three panned lines (pan ±0.7 on a stereo input: 1 + cos 0.3·π/2,
 * 1 and sin 0.3·π/2 on the louder side, ≈ 3.345), variation 1 + 0.5 × 3. Inside the loop each model
 * is trimmed by the inverse, so the loop gain never exceeds the feedback (≤ 0.95) and the repeats
 * always decay; untrimmed, a chorus at feedback 0.95 grows by 1.6 per pass until it overflows.
 */
export const LOOP_MOD2_PEAK: Readonly<Record<'ensemble' | 'vibe' | 'chorus', readonly [number, number]>> = {
  chorus: [1.7, 1.8],
  vibe: [1.4, 1.4],
  ensemble: [1 + 0.5 * (2 + Math.cos(0.15 * Math.PI) + Math.sin(0.15 * Math.PI)), 2.5],
};

function loopType(ctx: BaseAudioContext, k: LoopFx): Stage<LoopSettings> {
  if (k === 'none') return new Thru(ctx);
  if (k === 'flam') return new Flam(ctx);
  if (k === 'space') return new Space(ctx);
  const s = { family: k, variation: false, rateHz: LOOP_MOD2_RATE, amount: 0.5 } as const;
  const inner = mod2Type(ctx, k, s);
  const peak = LOOP_MOD2_PEAK[k];
  const trim = gainNode(ctx, 1 / peak[0]);
  inner.output.connect(trim);
  return {
    input: inner.input, output: trim,
    update: (ls, t) => {
      inner.update({ ...s, variation: ls.variation }, t);
      glide(trim.gain, 1 / peak[ls.variation ? 1 : 0], t);
    },
    dispose: () => {
      inner.dispose();
      trim.disconnect();
    },
  };
}

const FILTER: Readonly<Record<DelayFilter, { type: BiquadFilterType; hz: number; q: number }>> = {
  none: { type: 'peaking', hz: 1000, q: 0.7 }, // a peaking band at 0 dB: flat
  lp: { type: 'lowpass', hz: 2500, q: 0.707 },
  hp: { type: 'highpass', hz: 400, q: 0.707 },
  bp: { type: 'bandpass', hz: 900, q: 1 },
};

export class Delay implements Stage<DelaySettings> {
  readonly input: GainNode;
  readonly output: GainNode;
  readonly #ctx: BaseAudioContext;
  readonly #mix: DryWet;
  readonly #split: ChannelSplitterNode;
  readonly #inL: GainNode;
  readonly #inR: GainNode;
  readonly #crossIn: GainNode;
  readonly #dl: DelayNode;
  readonly #dr: DelayNode;
  readonly #merge: ChannelMergerNode;
  readonly #duck: GainNode;
  readonly #filter: BiquadFilterNode;
  readonly #loopFx: Selector<LoopFx, LoopSettings>;
  readonly #sat: WaveShaperNode;
  readonly #fb: GainNode;
  readonly #mute: GainNode;
  readonly #loopSplit: ChannelSplitterNode;
  readonly #ll: GainNode;
  readonly #rr: GainNode;
  readonly #lr: GainNode;
  readonly #rl: GainNode;
  #times: readonly [number, number] | null = null;
  #filterKind: DelayFilter | null = null;
  #analog: boolean | null = null;
  #mutedUntil = 0;

  constructor(ctx: BaseAudioContext) {
    this.#ctx = ctx;
    this.input = gainNode(ctx);
    this.output = gainNode(ctx);
    this.#mix = dryWet(ctx, this.input, this.output);
    this.#split = ctx.createChannelSplitter(2);
    this.#inL = gainNode(ctx, 1);
    this.#inR = gainNode(ctx, 1);
    this.#crossIn = gainNode(ctx, 0);
    this.#dl = ctx.createDelay(DELAY_MAX_SECONDS);
    this.#dr = ctx.createDelay(DELAY_MAX_SECONDS);
    this.#merge = ctx.createChannelMerger(2);
    this.#duck = gainNode(ctx, 1);
    this.input.connect(this.#split);
    this.#split.connect(this.#inL, 0).connect(this.#dl);
    this.#split.connect(this.#inR, 1).connect(this.#dr);
    this.#split.connect(this.#crossIn, 1).connect(this.#dl);
    this.#dl.connect(this.#merge, 0, 0);
    this.#dr.connect(this.#merge, 0, 1);
    this.#merge.connect(this.#duck).connect(this.#mix.wet);
    // The loop.
    this.#filter = biquad(ctx, 'peaking', 1000, 0.7, 0);
    this.#loopFx = new Selector<LoopFx, LoopSettings>(ctx, (k) => loopType(ctx, k));
    this.#sat = shaper(ctx, null);
    this.#fb = gainNode(ctx, 0);
    this.#mute = gainNode(ctx, 1);
    this.#loopSplit = ctx.createChannelSplitter(2);
    this.#merge.connect(this.#filter).connect(this.#loopFx.input);
    this.#loopFx.output.connect(this.#sat).connect(this.#fb).connect(this.#mute).connect(this.#loopSplit);
    this.#ll = gainNode(ctx, 1);
    this.#rr = gainNode(ctx, 1);
    this.#lr = gainNode(ctx, 0);
    this.#rl = gainNode(ctx, 0);
    this.#loopSplit.connect(this.#ll, 0).connect(this.#dl);
    this.#loopSplit.connect(this.#rr, 1).connect(this.#dr);
    this.#loopSplit.connect(this.#lr, 0).connect(this.#dr);
    this.#loopSplit.connect(this.#rl, 1).connect(this.#dl);
  }

  /** The current line times (tests). */
  get times(): readonly [number, number] | null {
    return this.#times;
  }

  /** The current loop effect's stage (tests). */
  get loopStage(): Stage<LoopSettings> | null {
    const k = this.#loopFx.current;
    return k === null ? null : this.#loopFx.stage(k);
  }

  /** The mix, feedback, routing and mute parameters by name (tests and inspection). */
  get params(): Readonly<Record<'dry' | 'wet' | 'feedback' | 'inR' | 'crossIn' | 'll' | 'rr' | 'lr' | 'rl' | 'duck' | 'mute',
    AudioParam>> {
    return {
      dry: this.#mix.dry.gain, wet: this.#mix.wet.gain, feedback: this.#fb.gain, inR: this.#inR.gain,
      crossIn: this.#crossIn.gain, ll: this.#ll.gain, rr: this.#rr.gain, lr: this.#lr.gain, rl: this.#rl.gain,
      duck: this.#duck.gain, mute: this.#mute.gain,
    };
  }

  update(s: DelaySettings, t: number): void {
    const { dry, wet } = equalPower(s.mix);
    glide(this.#mix.dry.gain, dry, t);
    glide(this.#mix.wet.gain, wet, t);
    glide(this.#fb.gain, s.feedback, t);
    // Ping pong: the input on the left, repeats cross L↔R (p.50).
    const pp = s.pingPong;
    glide(this.#inR.gain, pp ? 0 : 1, t);
    glide(this.#crossIn.gain, pp ? 1 : 0, t);
    glide(this.#ll.gain, pp ? 0 : 1, t);
    glide(this.#rr.gain, pp ? 0 : 1, t);
    glide(this.#lr.gain, pp ? 1 : 0, t);
    glide(this.#rl.gain, pp ? 1 : 0, t);
    if (s.filter !== this.#filterKind) {
      const f = FILTER[s.filter];
      this.#filter.type = f.type;
      glide(this.#filter.frequency, f.hz, t);
      glide(this.#filter.Q, f.q, t);
      glide(this.#filter.gain, 0, t);
      this.#filterKind = s.filter;
    }
    if (s.analog !== this.#analog) {
      this.#sat.curve = s.analog ? ANALOG_CURVE : null;
      this.#analog = s.analog;
    }
    this.#loopFx.select(s.loopFx, { variation: s.loopVariation }, t);
    this.#retime(s, t);
  }

  #retime(s: DelaySettings, t: number): void {
    const next: [number, number] = [s.left, s.right];
    const prev = this.#times;
    if (prev !== null && prev[0] === next[0] && prev[1] === next[1]) return;
    this.#times = next;
    const lines = [this.#dl, this.#dr] as const;
    if (prev === null) {
      lines.forEach((d, i) => setNow(d.delayTime, next[i]!));
      return;
    }
    if (s.analog) {
      // The tape-like glide: repeats bend in pitch.
      lines.forEach((d, i) => d.delayTime.setTargetAtTime(next[i]!, t, ANALOG_TAU));
      return;
    }
    // Normal: dip, jump, back up; never a pitch change.
    const at = Math.max(t, this.#mutedUntil);
    const g = this.#duck.gain;
    g.cancelScheduledValues(at);
    g.setTargetAtTime(0, at, DIP / 4);
    lines.forEach((d, i) => {
      d.delayTime.cancelScheduledValues(at);
      d.delayTime.setValueAtTime(next[i]!, at + DIP);
    });
    g.setTargetAtTime(1, at + DIP, DIP / 4);
  }

  /** Panic and load: the repeats stop within ≈ 10 ms; the loop stays muted until the lines are empty. */
  silence(t: number): void {
    const window = Math.max(this.#times?.[0] ?? 0, this.#times?.[1] ?? 0) + 0.03;
    const until = t + window;
    this.#mutedUntil = until;
    for (const g of [this.#duck.gain, this.#mute.gain]) {
      g.cancelScheduledValues(t);
      g.setTargetAtTime(0, t, 0.003);
      g.setValueAtTime(0, until);
      g.setTargetAtTime(1, until, 0.003);
    }
  }

  dispose(): void {
    this.#loopFx.dispose();
    release([this.#split, this.#inL, this.#inR, this.#crossIn, this.#dl, this.#dr, this.#merge, this.#duck,
      this.#filter, this.#sat, this.#fb, this.#mute, this.#loopSplit, this.#ll, this.#rr, this.#lr, this.#rl,
      this.#mix.dry, this.#mix.wet, this.input, this.output]);
  }
}
