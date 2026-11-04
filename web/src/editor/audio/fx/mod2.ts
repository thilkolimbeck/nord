/**
 * Mod 2 (manual p.50, plan section 15.1): Phaser, Flanger, Chorus, Vibe, Ensemble and Spin, each
 * with its variation. Approximations on Web Audio nodes (all-pass biquads and modulated delays);
 * the delay loop reuses Ensemble, Vibe and Chorus (p.50–51). Every feedback cycle holds a DelayNode
 * (Web Audio rule): the phaser's feedback is one render quantum late, which colours it; the
 * flanger has no cycle (its swept delay must go below one render quantum).
 */
import { type Mod2Family, type Mod2Settings } from './params.ts';
import { biquad, dryWet, type DryWet, gainNode, glide, release, Selector, setNow, sineLfo, type Stage } from './nodes.ts';

/** Phaser sweep 300 Hz–3 kHz: centre and half range in cents. */
const PHASER_CENTRE = Math.sqrt(300 * 3000);
const PHASER_CENTS = 600 * Math.log2(3000 / 300);
/** Spin's rate glide (the rotor's inertia, plan 15.1). */
const SPIN_TAU = 0.7;

function delayLine(ctx: BaseAudioContext, seconds: number, max = 0.05): DelayNode {
  const d = ctx.createDelay(max);
  setNow(d.delayTime, seconds);
  return d;
}

class Phaser implements Stage<Mod2Settings> {
  readonly input: GainNode;
  readonly output: GainNode;
  readonly #mix: DryWet;
  readonly #sum: GainNode;
  readonly #stages: BiquadFilterNode[] = [];
  readonly #lfoA: OscillatorNode;
  readonly #lfoB: OscillatorNode;
  readonly #depthA: GainNode;
  readonly #depthA4: GainNode;
  readonly #depthB: GainNode;
  readonly #out4: GainNode;
  readonly #out6: GainNode;
  readonly #fb: GainNode;
  readonly #fbDelay: DelayNode;

  constructor(ctx: BaseAudioContext, s: Mod2Settings) {
    this.input = gainNode(ctx);
    this.output = gainNode(ctx);
    this.#mix = dryWet(ctx, this.input, this.output);
    setNow(this.#mix.dry.gain, 0.6);
    this.#sum = gainNode(ctx);
    this.input.connect(this.#sum);
    let prev: AudioNode = this.#sum;
    for (let i = 0; i < 6; i++) {
      const ap = biquad(ctx, 'allpass', PHASER_CENTRE, 0.6);
      prev.connect(ap);
      prev = ap;
      this.#stages.push(ap);
    }
    // Normal: four stages on one LFO; variation (Bi-Phase): six, the last three on a second LFO a quarter cycle on.
    this.#out4 = gainNode(ctx, 1);
    this.#out6 = gainNode(ctx, 0);
    this.#stages[3]!.connect(this.#out4).connect(this.#mix.wet);
    this.#stages[5]!.connect(this.#out6).connect(this.#mix.wet);
    this.#lfoA = sineLfo(ctx, s.rateHz);
    this.#lfoB = sineLfo(ctx, s.rateHz, 90);
    this.#depthA = gainNode(ctx, PHASER_CENTS);
    this.#depthA4 = gainNode(ctx, PHASER_CENTS);
    this.#depthB = gainNode(ctx, 0);
    this.#lfoA.connect(this.#depthA);
    this.#lfoA.connect(this.#depthA4).connect(this.#stages[3]!.detune);
    this.#lfoB.connect(this.#depthB);
    for (let i = 0; i < 3; i++) this.#depthA.connect(this.#stages[i]!.detune);
    for (let i = 3; i < 6; i++) this.#depthB.connect(this.#stages[i]!.detune);
    // Feedback 0 … 0.7 by amount (the Small Stone has none at the minimum).
    this.#fb = gainNode(ctx, 0);
    this.#fbDelay = delayLine(ctx, 128 / ctx.sampleRate);
    this.#out4.connect(this.#fb);
    this.#out6.connect(this.#fb);
    this.#fb.connect(this.#fbDelay).connect(this.#sum);
    const at = ctx.currentTime;
    this.#lfoA.start(at);
    this.#lfoB.start(at);
  }

  update(s: Mod2Settings, t: number): void {
    glide(this.#lfoA.frequency, s.rateHz, t);
    glide(this.#lfoB.frequency, s.rateHz, t);
    glide(this.#out4.gain, s.variation ? 0 : 1, t);
    glide(this.#out6.gain, s.variation ? 1 : 0, t);
    glide(this.#depthA4.gain, s.variation ? 0 : PHASER_CENTS, t);
    glide(this.#depthB.gain, s.variation ? PHASER_CENTS : 0, t);
    glide(this.#fb.gain, 0.7 * s.amount, t);
    glide(this.#mix.wet.gain, 0.6, t);
  }

  dispose(): void {
    release([this.#lfoA, this.#lfoB, this.#depthA, this.#depthA4, this.#depthB, ...this.#stages, this.#out4,
      this.#out6, this.#fb, this.#fbDelay, this.#sum, this.#mix.dry, this.#mix.wet, this.input, this.output]);
  }
}

/** The flanger's feedback (0.75) as taps: the comb's first three echoes, 1, g, g². */
const FLANGER_TAPS = [1, 0.75, 0.75 ** 2] as const;

/**
 * Flanger: a feedback comb unrolled into three feed-forward taps at d, 2d and 3d (gains 1, g, g²),
 * so no DelayNode sits in a cycle: Web Audio clamps a delay inside a cycle to one render quantum
 * (2.67 ms at 48 kHz), which would flatten the lower half of the 0.5–5 ms sweep.
 */
class Flanger implements Stage<Mod2Settings> {
  readonly input: GainNode;
  readonly output: GainNode;
  readonly #mix: DryWet;
  readonly #split: ChannelSplitterNode;
  readonly #merge: ChannelMergerNode;
  readonly #lines: DelayNode[] = [];
  readonly #taps: GainNode[] = [];
  readonly #mults: GainNode[] = [];
  readonly #lfo: OscillatorNode;
  readonly #depthL: GainNode;
  readonly #depthR: GainNode;

  constructor(ctx: BaseAudioContext, s: Mod2Settings) {
    this.input = gainNode(ctx);
    this.output = gainNode(ctx);
    this.#mix = dryWet(ctx, this.input, this.output);
    setNow(this.#mix.dry.gain, 0.6);
    this.#split = ctx.createChannelSplitter(2);
    this.#merge = ctx.createChannelMerger(2);
    this.input.connect(this.#split);
    // A delay of 0.5–5 ms swept; amount = sweep depth (0: static resonant peaks, p.50). Normal: the right side inverted (stereo).
    this.#lfo = sineLfo(ctx, s.rateHz);
    this.#depthL = gainNode(ctx, 0);
    this.#depthR = gainNode(ctx, 0);
    this.#lfo.connect(this.#depthL);
    this.#lfo.connect(this.#depthR);
    for (const side of [0, 1] as const) {
      FLANGER_TAPS.forEach((g, i) => {
        const k = i + 1;
        const d = delayLine(ctx, 0.00275 * k);
        const tap = gainNode(ctx, g);
        const mult = gainNode(ctx, k);
        this.#split.connect(d, side);
        d.connect(tap).connect(this.#merge, 0, side);
        (side === 0 ? this.#depthL : this.#depthR).connect(mult).connect(d.delayTime);
        this.#lines.push(d);
        this.#taps.push(tap);
        this.#mults.push(mult);
      });
    }
    this.#merge.connect(this.#mix.wet);
    this.#lfo.start(ctx.currentTime);
  }

  update(s: Mod2Settings, t: number): void {
    const d = 0.00225 * s.amount;
    glide(this.#lfo.frequency, s.rateHz, t);
    glide(this.#depthL.gain, d, t);
    glide(this.#depthR.gain, s.variation ? d : -d, t);
    glide(this.#mix.wet.gain, 0.6, t);
  }

  dispose(): void {
    release([this.#lfo, this.#depthL, this.#depthR, ...this.#mults, ...this.#lines, ...this.#taps, this.#split,
      this.#merge, this.#mix.dry, this.#mix.wet, this.input, this.output]);
  }
}

class Vibe implements Stage<Mod2Settings> {
  readonly input: GainNode;
  readonly output: GainNode;
  readonly #mix: DryWet;
  readonly #split: ChannelSplitterNode;
  readonly #merge: ChannelMergerNode;
  readonly #stages: BiquadFilterNode[] = [];
  readonly #lfo: OscillatorNode;
  readonly #depthL: GainNode;
  readonly #depthR: GainNode;

  /** Four all-pass stages per side at staggered centres (Uni-Vibe-like), dry plus wet; variation: mono. */
  constructor(ctx: BaseAudioContext, s: Mod2Settings) {
    this.input = gainNode(ctx);
    this.output = gainNode(ctx);
    this.#mix = dryWet(ctx, this.input, this.output);
    setNow(this.#mix.dry.gain, 0.7);
    this.#split = ctx.createChannelSplitter(2);
    this.#merge = ctx.createChannelMerger(2);
    this.input.connect(this.#split);
    this.#lfo = sineLfo(ctx, s.rateHz);
    this.#depthL = gainNode(ctx, 0);
    this.#depthR = gainNode(ctx, 0);
    this.#lfo.connect(this.#depthL);
    this.#lfo.connect(this.#depthR);
    for (const side of [0, 1] as const) {
      let prev: AudioNode | null = null;
      for (const hz of [180, 520, 1500, 4300]) {
        const ap = biquad(ctx, 'allpass', hz, 0.7);
        if (prev === null) this.#split.connect(ap, side);
        else prev.connect(ap);
        (side === 0 ? this.#depthL : this.#depthR).connect(ap.detune);
        this.#stages.push(ap);
        prev = ap;
      }
      prev!.connect(this.#merge, 0, side);
    }
    this.#merge.connect(this.#mix.wet);
    this.#lfo.start(ctx.currentTime);
  }

  update(s: Mod2Settings, t: number): void {
    const cents = 1200 * s.amount;
    glide(this.#lfo.frequency, s.rateHz, t);
    glide(this.#depthL.gain, cents, t);
    glide(this.#depthR.gain, s.variation ? cents : -cents, t);
    glide(this.#mix.wet.gain, 0.7, t);
  }

  dispose(): void {
    release([this.#lfo, this.#depthL, this.#depthR, ...this.#stages, this.#split, this.#merge, this.#mix.dry,
      this.#mix.wet, this.input, this.output]);
  }
}

class Chorus implements Stage<Mod2Settings> {
  readonly input: GainNode;
  readonly output: GainNode;
  readonly #mix: DryWet;
  readonly #split: ChannelSplitterNode;
  readonly #merge: ChannelMergerNode;
  readonly #d1: DelayNode;
  readonly #d2: DelayNode;
  readonly #d3: DelayNode;
  readonly #dv: DelayNode;
  readonly #lfos: OscillatorNode[];
  readonly #depths: GainNode[];
  readonly #stereo: GainNode;
  readonly #third: GainNode;
  readonly #single: GainNode;

  /**
   * Two modulated delays (7 and 11 ms, LFOs 90° apart) left and right; a third (15 ms) fades in
   * above amount 5.0 (p.50: "above 50 %"). Variation: one delay, deeper and faster.
   */
  constructor(ctx: BaseAudioContext, s: Mod2Settings) {
    this.input = gainNode(ctx);
    this.output = gainNode(ctx);
    this.#mix = dryWet(ctx, this.input, this.output);
    this.#split = ctx.createChannelSplitter(2);
    this.#merge = ctx.createChannelMerger(2);
    this.#d1 = delayLine(ctx, 0.007);
    this.#d2 = delayLine(ctx, 0.011);
    this.#d3 = delayLine(ctx, 0.015);
    this.#dv = delayLine(ctx, 0.009);
    this.#stereo = gainNode(ctx, 1);
    this.#third = gainNode(ctx, 0);
    this.#single = gainNode(ctx, 0);
    this.input.connect(this.#split);
    this.#split.connect(this.#d1, 0);
    this.#split.connect(this.#d2, 1);
    this.#d1.connect(this.#merge, 0, 0);
    this.#d2.connect(this.#merge, 0, 1);
    this.#merge.connect(this.#stereo).connect(this.#mix.wet);
    this.input.connect(this.#d3).connect(this.#third).connect(this.#mix.wet);
    this.input.connect(this.#dv).connect(this.#single).connect(this.#mix.wet);
    this.#lfos = [0, 90, 180, 0].map((p) => sineLfo(ctx, s.rateHz, p));
    this.#depths = this.#lfos.map(() => gainNode(ctx, 0));
    const targets = [this.#d1, this.#d2, this.#d3, this.#dv];
    this.#lfos.forEach((o, i) => o.connect(this.#depths[i]!).connect(targets[i]!.delayTime));
    const at = ctx.currentTime;
    for (const o of this.#lfos) o.start(at);
  }

  update(s: Mod2Settings, t: number): void {
    const depth = 0.003 * s.amount;
    for (let i = 0; i < 3; i++) {
      glide(this.#lfos[i]!.frequency, s.rateHz, t);
      glide(this.#depths[i]!.gain, depth, t);
    }
    glide(this.#lfos[3]!.frequency, 2 * s.rateHz, t);
    glide(this.#depths[3]!.gain, 2 * depth, t);
    glide(this.#stereo.gain, s.variation ? 0 : 0.7, t);
    glide(this.#third.gain, s.variation ? 0 : 0.5 * Math.max(0, Math.min(1, (s.amount - 0.5) * 2)), t);
    glide(this.#single.gain, s.variation ? 0.8 : 0, t);
    glide(this.#mix.wet.gain, 1, t);
  }

  dispose(): void {
    release([...this.#lfos, ...this.#depths, this.#d1, this.#d2, this.#d3, this.#dv, this.#stereo, this.#third,
      this.#single, this.#split, this.#merge, this.#mix.dry, this.#mix.wet, this.input, this.output]);
  }
}

class Ensemble implements Stage<Mod2Settings> {
  readonly input: GainNode;
  readonly output: GainNode;
  readonly #mix: DryWet;
  readonly #lines: DelayNode[];
  readonly #pans: StereoPannerNode[];
  readonly #lfos: OscillatorNode[];
  readonly #depths: GainNode[];
  readonly #wet: GainNode;

  /** Three delays (5, 7, 9 ms), LFOs 120° apart, spread left, centre, right; variation: mono. */
  constructor(ctx: BaseAudioContext, s: Mod2Settings) {
    this.input = gainNode(ctx);
    this.output = gainNode(ctx);
    this.#mix = dryWet(ctx, this.input, this.output);
    this.#wet = gainNode(ctx, 0.5);
    this.#wet.connect(this.#mix.wet);
    this.#lines = [0.005, 0.007, 0.009].map((d) => delayLine(ctx, d));
    this.#pans = this.#lines.map(() => ctx.createStereoPanner());
    this.#lfos = [0, 120, 240].map((p) => sineLfo(ctx, s.rateHz, p));
    this.#depths = this.#lfos.map(() => gainNode(ctx, 0));
    this.#lines.forEach((d, i) => {
      this.input.connect(d).connect(this.#pans[i]!).connect(this.#wet);
      this.#lfos[i]!.connect(this.#depths[i]!).connect(d.delayTime);
    });
    const at = ctx.currentTime;
    for (const o of this.#lfos) o.start(at);
  }

  update(s: Mod2Settings, t: number): void {
    const spread = [-0.7, 0, 0.7];
    this.#lfos.forEach((o, i) => {
      glide(o.frequency, s.rateHz, t);
      glide(this.#depths[i]!.gain, 0.002 * s.amount, t);
      glide(this.#pans[i]!.pan, s.variation ? 0 : spread[i]!, t);
    });
    glide(this.#mix.wet.gain, 1, t);
  }

  dispose(): void {
    release([...this.#lfos, ...this.#depths, ...this.#lines, ...this.#pans, this.#wet, this.#mix.dry, this.#mix.wet,
      this.input, this.output]);
  }
}

class Spin implements Stage<Mod2Settings> {
  readonly input: GainNode;
  readonly output: GainNode;
  readonly #lp: BiquadFilterNode;
  readonly #hp: BiquadFilterNode;
  readonly #route: { lpRotor: GainNode; hpRotor: GainNode; lpStatic: GainNode; hpStatic: GainNode };
  readonly #am: GainNode;
  readonly #doppler: DelayNode;
  readonly #pan: StereoPannerNode;
  readonly #lfo: OscillatorNode;
  readonly #lfo90: OscillatorNode;
  readonly #amDepth: GainNode;
  readonly #dopDepth: GainNode;
  readonly #panDepth: GainNode;

  /**
   * One rotor: an 800 Hz crossover, amplitude modulation 0.3 and ±0.3 ms Doppler on the highs (by
   * amount), the rate gliding like a rotor (τ 0.7 s); variation: the lows rotate instead.
   */
  constructor(ctx: BaseAudioContext, s: Mod2Settings) {
    this.input = gainNode(ctx);
    this.output = gainNode(ctx);
    this.#lp = biquad(ctx, 'lowpass', 800);
    this.#hp = biquad(ctx, 'highpass', 800);
    this.input.connect(this.#lp);
    this.input.connect(this.#hp);
    this.#route = {
      lpRotor: gainNode(ctx, 0), hpRotor: gainNode(ctx, 1), lpStatic: gainNode(ctx, 1), hpStatic: gainNode(ctx, 0),
    };
    this.#am = gainNode(ctx, 1);
    this.#doppler = delayLine(ctx, 0.001);
    this.#pan = ctx.createStereoPanner();
    this.#lp.connect(this.#route.lpRotor).connect(this.#am);
    this.#hp.connect(this.#route.hpRotor).connect(this.#am);
    this.#am.connect(this.#doppler).connect(this.#pan).connect(this.output);
    this.#lp.connect(this.#route.lpStatic).connect(this.output);
    this.#hp.connect(this.#route.hpStatic).connect(this.output);
    this.#lfo = sineLfo(ctx, s.rateHz);
    this.#lfo90 = sineLfo(ctx, s.rateHz, 90);
    this.#amDepth = gainNode(ctx, 0);
    this.#dopDepth = gainNode(ctx, 0);
    this.#panDepth = gainNode(ctx, 0);
    this.#lfo.connect(this.#amDepth).connect(this.#am.gain);
    this.#lfo90.connect(this.#dopDepth).connect(this.#doppler.delayTime);
    this.#lfo.connect(this.#panDepth).connect(this.#pan.pan);
    const at = ctx.currentTime;
    this.#lfo.start(at);
    this.#lfo90.start(at);
  }

  update(s: Mod2Settings, t: number): void {
    glide(this.#lfo.frequency, s.rateHz, t, SPIN_TAU);
    glide(this.#lfo90.frequency, s.rateHz, t, SPIN_TAU);
    glide(this.#amDepth.gain, 0.3 * s.amount, t);
    glide(this.#am.gain, 1 - 0.3 * s.amount, t);
    glide(this.#dopDepth.gain, 0.0003 * s.amount, t);
    glide(this.#panDepth.gain, 0.6 * s.amount, t);
    glide(this.#route.hpRotor.gain, s.variation ? 0 : 1, t);
    glide(this.#route.lpStatic.gain, s.variation ? 0 : 1, t);
    glide(this.#route.lpRotor.gain, s.variation ? 1 : 0, t);
    glide(this.#route.hpStatic.gain, s.variation ? 1 : 0, t);
  }

  dispose(): void {
    release([this.#lfo, this.#lfo90, this.#amDepth, this.#dopDepth, this.#panDepth, this.#lp, this.#hp,
      ...Object.values(this.#route), this.#am, this.#doppler, this.#pan, this.input, this.output]);
  }
}

/** One Mod 2 type (also the delay loop's Ensemble, Vibe and Chorus). */
export function mod2Type(ctx: BaseAudioContext, family: Mod2Family, s: Mod2Settings): Stage<Mod2Settings> {
  switch (family) {
    case 'phaser': return new Phaser(ctx, s);
    case 'flanger': return new Flanger(ctx, s);
    case 'chorus': return new Chorus(ctx, s);
    case 'vibe': return new Vibe(ctx, s);
    case 'ensemble': return new Ensemble(ctx, s);
    case 'spin': return new Spin(ctx, s);
  }
}

/** Mod 2 of one chain: the six types behind a Selector. */
export class Mod2 implements Stage<Mod2Settings> {
  readonly #sel: Selector<Mod2Family, Mod2Settings>;
  #last: Mod2Settings | null = null;

  constructor(ctx: BaseAudioContext) {
    this.#sel = new Selector<Mod2Family, Mod2Settings>(ctx, (k) => mod2Type(ctx, k, this.#last!));
  }

  get input(): AudioNode {
    return this.#sel.input;
  }

  get output(): AudioNode {
    return this.#sel.output;
  }

  get family(): Mod2Family | null {
    return this.#sel.current;
  }

  update(s: Mod2Settings, t: number): void {
    this.#last = s;
    this.#sel.select(s.family, s, t);
  }

  silence(t: number): void {
    this.#sel.silence(t);
  }

  dispose(): void {
    this.#sel.dispose();
  }
}
