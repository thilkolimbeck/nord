/**
 * Generated reverb impulse responses (plan section 15.1, manual p.52–53): seeded noise with an
 * exponential decay to −60 dB, darkening over time, decorrelated left and right, a short pattern
 * of early reflections for the small rooms and a dispersive "drip" chirp for the springs. Invented
 * shapes: no Nord impulse response is used or imitated. Pure: plain Float32Arrays, no Web Audio.
 */
import type { ReverbType } from './params.ts';

export interface ImpulseSpec {
  readonly type: ReverbType;
  /** Time to fall by 60 dB, in seconds (RT60). */
  readonly decay: number;
  /** Silence before the response, in seconds. */
  readonly preDelay: number;
  /** Discrete early reflections (the small rooms). */
  readonly early: boolean;
  /** Spring chirp repetition period in seconds and its top frequency; null for rooms. */
  readonly spring: { readonly period: number; readonly topHz: number } | null;
}

const SPECS: readonly ImpulseSpec[] = (() => {
  const s = (type: ReverbType, decay: number, preDelay = 0, early = false,
    spring: ImpulseSpec['spring'] = null): ImpulseSpec => ({ type, decay, preDelay, early, spring });
  return [
    s('spring', 2.0, 0, false, { period: 0.032, topHz: 3200 }),
    s('spring', 3.0, 0, false, { period: 0.043, topHz: 2400 }),
    s('booth', 0.3, 0, true), s('booth', 0.3, 0.025, true),
    s('room', 0.8, 0, true), s('room', 0.8, 0.035, true),
    // The chorale variations (odd) share the plain response; the reverb unit adds the modulation.
    s('stage', 1.6), s('stage', 1.6), s('hall', 2.8), s('hall', 2.8), s('cathedral', 5.5), s('cathedral', 5.5),
  ];
})();

/** The response of rvbType 0..11 (out-of-range values clamp). */
export function impulseSpec(index: number): ImpulseSpec {
  const i = Math.min(11, Math.max(0, Math.round(Number.isFinite(index) ? index : 0)));
  return SPECS[i]!;
}

/** mulberry32: a small deterministic PRNG, uniform in [0, 1). */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Length of a response in samples: pre-delay plus the decay to −60 dB. */
export function impulseLength(spec: ImpulseSpec, sampleRate: number): number {
  return Math.max(1, Math.ceil((spec.preDelay + spec.decay) * sampleRate));
}

const LN_1000 = Math.log(1000); // −60 dB in nepers

function channel(spec: ImpulseSpec, sampleRate: number, seed: number, side: 0 | 1): Float32Array {
  const n = impulseLength(spec, sampleRate);
  const out = new Float32Array(n);
  const rand = seededRandom(seed);
  const pre = Math.round(spec.preDelay * sampleRate);
  const tail = n - pre;
  let lp = 0;
  for (let i = 0; i < tail; i++) {
    const t = i / sampleRate;
    const env = Math.exp((-LN_1000 * t) / spec.decay);
    // Darker as it decays: a one-pole low-pass whose pole moves from 0.05 to 0.7.
    const pole = 0.05 + 0.65 * Math.min(1, t / spec.decay);
    lp = pole * lp + (1 - pole) * (rand() * 2 - 1);
    out[pre + i] = lp * env;
  }
  if (spec.early) {
    // Early reflections: a dozen taps in the first 40 ms, louder than the diffuse tail, different per side.
    for (let k = 0; k < 12; k++) {
      const at = pre + Math.round((0.002 + rand() * 0.038) * sampleRate);
      if (at < n) out[at] = out[at]! + (rand() < 0.5 ? -1 : 1) * (0.9 - 0.06 * k);
    }
  }
  if (spec.spring !== null) {
    // Spring drip: a falling chirp at every round trip of the wave along the spring.
    const period = spec.spring.period * (side === 0 ? 1 : 1.07);
    const chirpLen = 0.025;
    for (let start = 0.004; start < spec.decay; start += period) {
      const amp = 0.6 * Math.exp((-LN_1000 * start) / spec.decay);
      let phase = 0;
      const s0 = pre + Math.round(start * sampleRate);
      const m = Math.min(n - s0, Math.round(chirpLen * sampleRate));
      for (let j = 0; j < m; j++) {
        const tau = j / sampleRate;
        const f = spec.spring.topHz * (400 / spec.spring.topHz) ** (tau / chirpLen);
        phase += (2 * Math.PI * f) / sampleRate;
        out[s0 + j] = out[s0 + j]! + amp * Math.sin(phase) * Math.exp(-tau / 0.008);
      }
    }
  }
  // A short fade over the last 5 % so the response ends at zero.
  const fade = Math.max(1, Math.floor(tail * 0.05));
  for (let i = 0; i < fade; i++) {
    const g = Math.cos(((i + 1) / fade) * (Math.PI / 2)) ** 2;
    out[n - fade + i] = out[n - fade + i]! * g;
  }
  return out;
}

/**
 * The stereo response of a spec: left and right from different seeds (decorrelated), scaled to a
 * peak of 1. The same seed gives the same samples.
 */
export function generateImpulse(spec: ImpulseSpec, sampleRate: number, seed = 1): [Float32Array, Float32Array] {
  const l = channel(spec, sampleRate, seed * 2 + 1, 0);
  const r = channel(spec, sampleRate, seed * 2 + 2, 1);
  let peak = 0;
  for (const ch of [l, r]) for (const x of ch) peak = Math.max(peak, Math.abs(x));
  if (peak > 0) for (const ch of [l, r]) for (let i = 0; i < ch.length; i++) ch[i] = ch[i]! / peak;
  return [l, r];
}
