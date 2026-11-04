/**
 * Amp sim / EQ (manual p.51–52, plan section 15.1): a tube-style overdrive, an amp model as a fixed
 * EQ curve after it (Twin, JC, Small, each with a variation: invented curves, nothing measured),
 * the LP and HP filters (24 dB/oct, cutoff = mid frequency, resonance from mid) and the 3-band EQ.
 * "To Rotary" (p.52–53) is the chain's routing; here it plays as Off: a neutral EQ with drive.
 *
 *   input ─► pre ─► drive (4× oversampled) ─► dc block ─► post ─► driven ─┬─► model hp, lp, peak, shelf
 *     └──────────────────────────► clean ────────────────────────────────┘
 *         ─► filter 1, 2 (LP/HP modes) ─► bass 100 Hz ─► mid ─► treble 4 kHz ─► output
 *
 * The overdrive goes in and out by a crossfade between the clean and the driven path (both at unity
 * small-signal gain at drive 0), never by swapping the shaper's curve, so switching it is level-smooth.
 */
import type { AmpModel, AmpSettings } from './params.ts';
import { biquad, curve, gainNode, glide, release, shaper, type Stage } from './nodes.ts';

/** The drive curve: tanh with a bias (asymmetric, even harmonics); the pre-gain divides by K. */
const K = 4;
const BIAS = 0.3;
const SECH2_BIAS = 1 - Math.tanh(BIAS) ** 2;
const DRIVE_CURVE = curve((x) => Math.tanh(K * x + BIAS) - Math.tanh(BIAS), 4097);

/** The amp models drive harder (plan 15.1). */
const MODEL_DRIVE = 1.5;

/** Drive pre-gain 1 + 2 × label (label 0.0–10.0), × 1.5 for the amp models. */
export function drivePre(drive: number, model: AmpModel): number {
  const isModel = model === 'twin' || model === 'jc' || model === 'small';
  return (1 + 2 * Math.min(10, Math.max(0, drive))) * (isModel ? MODEL_DRIVE : 1);
}

/** Whether the overdrive is in the path: any drive, or an amp model. */
export function driveActive(s: AmpSettings): boolean {
  return s.drive > 0 || s.model === 'twin' || s.model === 'jc' || s.model === 'small';
}

interface Curve {
  readonly hp: number;
  readonly lp: number;
  readonly peakHz: number;
  readonly peakDb: number;
  readonly shelfHz: number;
  readonly shelfDb: number;
}

const NEUTRAL: Curve = { hp: 10, lp: 20000, peakHz: 1000, peakDb: 0, shelfHz: 3000, shelfDb: 0 };

/** The amp models' EQ curves (plan 15.1, invented). */
export function modelCurve(model: AmpModel, variation: boolean): Curve {
  switch (model) {
    case 'twin':
      return variation ? { ...NEUTRAL, hp: 70, peakHz: 1200, peakDb: 2, shelfHz: 3000, shelfDb: 2 }
        : { ...NEUTRAL, hp: 70, peakHz: 500, peakDb: -4, shelfHz: 3000, shelfDb: 6 };
    case 'jc':
      return variation ? { ...NEUTRAL, peakHz: 900, peakDb: 2, shelfHz: 4000, shelfDb: 1 }
        : { ...NEUTRAL, shelfHz: 4000, shelfDb: 5 };
    case 'small':
      return variation ? { ...NEUTRAL, hp: 250, lp: 3000, peakHz: 1200, peakDb: 4 }
        : { ...NEUTRAL, hp: 150, lp: 4500, peakHz: 1200, peakDb: 4 };
    default:
      return NEUTRAL;
  }
}

export class Amp implements Stage<AmpSettings> {
  readonly input: GainNode;
  readonly output: BiquadFilterNode;
  readonly #ctx: BaseAudioContext;
  readonly #pre: GainNode;
  readonly #drive: WaveShaperNode;
  readonly #dc: BiquadFilterNode;
  readonly #post: GainNode;
  readonly #driven: GainNode;
  readonly #clean: GainNode;
  readonly #mHp: BiquadFilterNode;
  readonly #mLp: BiquadFilterNode;
  readonly #mPeak: BiquadFilterNode;
  readonly #mShelf: BiquadFilterNode;
  readonly #f1: BiquadFilterNode;
  readonly #f2: BiquadFilterNode;
  readonly #bass: BiquadFilterNode;
  readonly #mid: BiquadFilterNode;
  readonly #treble: BiquadFilterNode;
  #filterMode: 'lp' | 'hp' | null | undefined = undefined;

  constructor(ctx: BaseAudioContext) {
    this.#ctx = ctx;
    const nyq = ctx.sampleRate / 2;
    this.input = gainNode(ctx);
    this.#pre = gainNode(ctx);
    this.#drive = shaper(ctx, DRIVE_CURVE, '4x');
    this.#dc = biquad(ctx, 'highpass', 15);
    this.#post = gainNode(ctx);
    this.#driven = gainNode(ctx, 0);
    this.#clean = gainNode(ctx, 1);
    this.#mHp = biquad(ctx, 'highpass', NEUTRAL.hp);
    this.#mLp = biquad(ctx, 'lowpass', Math.min(NEUTRAL.lp, nyq * 0.95));
    this.#mPeak = biquad(ctx, 'peaking', NEUTRAL.peakHz, 1, 0);
    this.#mShelf = biquad(ctx, 'highshelf', NEUTRAL.shelfHz, 0.707, 0);
    this.#f1 = biquad(ctx, 'peaking', 1000, 0.707, 0);
    this.#f2 = biquad(ctx, 'peaking', 1000, 0.707, 0);
    this.#bass = biquad(ctx, 'lowshelf', 100, 0.707, 0);
    this.#mid = biquad(ctx, 'peaking', 1000, 1, 0);
    this.#treble = biquad(ctx, 'highshelf', 4000, 0.707, 0);
    this.output = this.#treble;
    let prev: AudioNode = this.input;
    for (const n of [this.#pre, this.#drive, this.#dc, this.#post, this.#driven]) prev = prev.connect(n);
    this.input.connect(this.#clean);
    this.#driven.connect(this.#mHp);
    this.#clean.connect(this.#mHp);
    prev = this.#mHp;
    for (const n of [this.#mLp, this.#mPeak, this.#mShelf, this.#f1, this.#f2, this.#bass, this.#mid, this.#treble]) {
      prev = prev.connect(n);
    }
  }

  update(s: AmpSettings, t: number): void {
    // Overdrive: the driven path plays only while it drives (label 0 without a model is linear: the clean path).
    const driving = driveActive(s);
    glide(this.#driven.gain, driving ? 1 : 0, t);
    glide(this.#clean.gain, driving ? 0 : 1, t);
    const pre = drivePre(s.drive, s.model);
    glide(this.#pre.gain, pre / K, t);
    // Output compensated: the small-signal gain grows as √pre, not as pre (unity at drive 0, as the clean path).
    glide(this.#post.gain, 1 / (SECH2_BIAS * Math.sqrt(pre)), t);
    // Model curve.
    const c = modelCurve(s.model, s.variation);
    const nyq = this.#ctx.sampleRate / 2;
    glide(this.#mHp.frequency, c.hp, t);
    glide(this.#mLp.frequency, Math.min(c.lp, nyq * 0.95), t);
    glide(this.#mPeak.frequency, c.peakHz, t);
    glide(this.#mPeak.gain, c.peakDb, t);
    glide(this.#mShelf.frequency, c.shelfHz, t);
    glide(this.#mShelf.gain, c.shelfDb, t);
    // LP / HP filter modes: two biquads at the mid frequency, resonance from mid; the mid band is off (p.52).
    const mode = s.model === 'lp' || s.model === 'hp' ? s.model : null;
    if (mode !== this.#filterMode) {
      const type: BiquadFilterType = mode === 'lp' ? 'lowpass' : mode === 'hp' ? 'highpass' : 'peaking';
      this.#f1.type = type;
      this.#f2.type = type;
      glide(this.#f1.gain, 0, t);
      glide(this.#f2.gain, 0, t);
      this.#filterMode = mode;
    }
    const cutoff = Math.min(s.midHz, nyq * 0.95);
    glide(this.#f1.frequency, cutoff, t);
    glide(this.#f2.frequency, cutoff, t);
    glide(this.#f1.Q, mode === null ? 0.707 : s.q, t);
    glide(this.#f2.Q, 0.707, t);
    // 3-band EQ.
    glide(this.#bass.gain, s.bassDb, t);
    glide(this.#mid.frequency, cutoff, t);
    glide(this.#mid.gain, mode === null ? s.midDb : 0, t);
    glide(this.#treble.gain, s.trebleDb, t);
  }

  /** The filter nodes in order (tests). */
  get filters(): { readonly f1: BiquadFilterNode; readonly mid: BiquadFilterNode } {
    return { f1: this.#f1, mid: this.#mid };
  }

  get driveShaper(): WaveShaperNode {
    return this.#drive;
  }

  /** The crossfade gains of the driven and the clean path (tests). */
  get paths(): { readonly driven: AudioParam; readonly clean: AudioParam } {
    return { driven: this.#driven.gain, clean: this.#clean.gain };
  }

  dispose(): void {
    release([this.input, this.#pre, this.#drive, this.#dc, this.#post, this.#driven, this.#clean, this.#mHp, this.#mLp, this.#mPeak,
      this.#mShelf, this.#f1, this.#f2, this.#bass, this.#mid, this.#treble]);
  }
}
