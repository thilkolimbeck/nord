/**
 * Reverb (manual p.52–53, plan section 15.1): a ConvolverNode with a generated impulse response
 * (impulse.ts; no Nord response used or imitated), cached per context and type, built on first
 * use; equal-power dry/wet, fully wet at 10.0 (p.52); colour dark or bright (p.53); the chorale
 * variations of Stage, Hall and Cathedral add a slowly modulated delay on the wet path.
 *
 *   input ─► dry ──────────────────────────────────────────────────────────► output
 *         └► convolver ─► fade ─► chorale delay ─► colour 1 ─► colour 2 ─► wet ─┘
 *
 * A type change or a panic swaps in a fresh convolver (the old one fades in 10–20 ms and is
 * disconnected later), so a tail never rings on after panic.
 */
import { generateImpulse, impulseLength, impulseSpec } from './impulse.ts';
import { equalPower, type ReverbColor, type ReverbSettings } from './params.ts';
import { biquad, dryWet, type DryWet, gainNode, glide, release, setNow, sineLfo, type Stage, XFADE } from './nodes.ts';

const CACHE = new WeakMap<BaseAudioContext, Map<number, AudioBuffer>>();

/** The impulse response of rvbType `index` for a context, generated once and shared by every chain. */
export function impulseBuffer(ctx: BaseAudioContext, index: number): AudioBuffer {
  let byType = CACHE.get(ctx);
  if (byType === undefined) {
    byType = new Map();
    CACHE.set(ctx, byType);
  }
  const cached = byType.get(index);
  if (cached !== undefined) return cached;
  const spec = impulseSpec(index);
  const data = generateImpulse(spec, ctx.sampleRate, index + 1);
  const buffer = ctx.createBuffer(2, impulseLength(spec, ctx.sampleRate), ctx.sampleRate);
  buffer.getChannelData(0).set(data[0]);
  buffer.getChannelData(1).set(data[1]);
  byType.set(index, buffer);
  return buffer;
}

/** Chorale: ±0.3 % pitch at 0.3 Hz is a delay swing of 0.003 / (2π · 0.3) s. */
const CHORALE_HZ = 0.3;
const CHORALE_DEPTH = 0.003 / (2 * Math.PI * CHORALE_HZ);
const RETIRE_AFTER = 0.1;

interface Conv {
  readonly node: ConvolverNode;
  readonly fade: GainNode;
  readonly ir: number;
}

export class Reverb implements Stage<ReverbSettings> {
  readonly input: GainNode;
  readonly output: GainNode;
  readonly #ctx: BaseAudioContext;
  readonly #mix: DryWet;
  readonly #wetIn: GainNode;
  readonly #chorale: DelayNode;
  readonly #lfo: OscillatorNode;
  readonly #lfoDepth: GainNode;
  readonly #c1: BiquadFilterNode;
  readonly #c2: BiquadFilterNode;
  #conv: Conv | null = null;
  #retired: Array<{ readonly conv: Conv; readonly at: number }> = [];
  #color: ReverbColor | null = null;

  constructor(ctx: BaseAudioContext) {
    this.#ctx = ctx;
    this.input = gainNode(ctx);
    this.output = gainNode(ctx);
    this.#mix = dryWet(ctx, this.input, this.output);
    this.#wetIn = gainNode(ctx);
    this.#chorale = ctx.createDelay(0.05);
    setNow(this.#chorale.delayTime, 0.01);
    this.#c1 = biquad(ctx, 'peaking', 1000, 0.7, 0);
    this.#c2 = biquad(ctx, 'peaking', 1000, 0.7, 0);
    this.#wetIn.connect(this.#chorale).connect(this.#c1).connect(this.#c2).connect(this.#mix.wet);
    this.#lfo = sineLfo(ctx, CHORALE_HZ);
    this.#lfoDepth = gainNode(ctx, 0);
    this.#lfo.connect(this.#lfoDepth).connect(this.#chorale.delayTime);
    this.#lfo.start(ctx.currentTime);
  }

  /** The impulse response playing now (tests); null before the first update. */
  get ir(): number | null {
    return this.#conv?.ir ?? null;
  }

  /** The convolvers built so far, the playing one last (tests). */
  get convolvers(): number {
    return this.#retired.length + (this.#conv === null ? 0 : 1);
  }

  update(s: ReverbSettings, t: number): void {
    this.#sweep();
    if (this.#conv === null || this.#conv.ir !== s.ir) this.#swap(s.ir, t, this.#conv !== null);
    const { dry, wet } = equalPower(s.mix);
    glide(this.#mix.dry.gain, dry, t);
    glide(this.#mix.wet.gain, wet, t);
    glide(this.#lfoDepth.gain, s.chorale ? CHORALE_DEPTH : 0, t);
    if (s.color !== this.#color) {
      // Dark: low-pass 3 kHz; bright: low shelf −3 dB @ 250 Hz and high shelf +3 dB @ 5 kHz (p.53); none: flat.
      const [a, b] = s.color === 'dark' ? [['lowpass', 3000, 0] as const, ['peaking', 1000, 0] as const]
        : s.color === 'bright' ? [['lowshelf', 250, -3] as const, ['highshelf', 5000, 3] as const]
          : [['peaking', 1000, 0] as const, ['peaking', 1000, 0] as const];
      for (const [node, [type, hz, db]] of [[this.#c1, a], [this.#c2, b]] as const) {
        node.type = type;
        glide(node.frequency, hz, t);
        glide(node.gain, db, t);
        glide(node.Q, 0.707, t);
      }
      this.#color = s.color;
    }
  }

  /** A fresh convolver for `ir`; the old one fades out (crossfade on a type change, a cut on panic). */
  #swap(ir: number, t: number, crossfade: boolean): void {
    const node = this.#ctx.createConvolver();
    node.normalize = true;
    node.buffer = impulseBuffer(this.#ctx, ir);
    const fade = gainNode(this.#ctx, crossfade ? 0 : 1);
    this.input.connect(node);
    node.connect(fade).connect(this.#wetIn);
    if (crossfade) glide(fade.gain, 1, t, XFADE);
    const old = this.#conv;
    if (old !== null) {
      this.input.disconnect(old.node);
      old.fade.gain.cancelScheduledValues(t);
      old.fade.gain.setTargetAtTime(0, t, crossfade ? XFADE : 0.003);
      this.#retired.push({ conv: old, at: t + RETIRE_AFTER });
    }
    this.#conv = { node, fade, ir };
  }

  /** Disconnect faded convolvers. */
  #sweep(): void {
    const now = this.#ctx.currentTime;
    this.#retired = this.#retired.filter((r) => {
      if (r.at > now) return true;
      release([r.conv.node, r.conv.fade]);
      return false;
    });
  }

  silence(t: number): void {
    this.#sweep();
    if (this.#conv !== null) this.#swap(this.#conv.ir, t, false);
  }

  dispose(): void {
    for (const r of this.#retired) release([r.conv.node, r.conv.fade]);
    this.#retired = [];
    if (this.#conv !== null) release([this.#conv.node, this.#conv.fade]);
    release([this.#lfo, this.#lfoDepth, this.#wetIn, this.#chorale, this.#c1, this.#c2, this.#mix.dry, this.#mix.wet,
      this.input, this.output]);
  }
}
