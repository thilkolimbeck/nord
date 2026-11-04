/**
 * Synthesis recipes of the browser piano (plan section 13.3, "Family recipes"): for one note of one
 * piano family, the sine or wave oscillators with their decay envelopes, the FM index, the filter
 * sweep, the static voice filters, the shaper, the noise bursts and the damper release time.
 * Pure: no Web Audio nodes; voice.ts turns a recipe into nodes.
 *
 * Every number is invented to sound plausible; none comes from Nord, and no Nord sample is used.
 * Manual references (Nord Stage 4 manual v1.6X): piano types p.24, Soft Release, String Res,
 * Pedal Noise p.25, Clav pickups p.24.
 */
import type { PianoFamily, PianoSize } from '../../model/pianos.ts';
import { TAU_DIVISOR } from '../envelope.ts';

/** At most this many source nodes per voice copy (oscillators and the attack noise). */
export const MAX_SOURCES = 12;
/** Linear attack of every partial, seconds. */
export const ATTACK = 0.002;
/** The first stage of the acoustic decay: −6 dB in its first 0.3 s, with a time constant of 0.15 s. */
export const STAGE1_SECONDS = 0.3;
export const STAGE1_TAU = 0.15;
/**
 * The level a first-stage setTargetAtTime aims at (relative to the peak), so that with STAGE1_TAU
 * it reaches exactly half the peak (−6 dB) after STAGE1_SECONDS.
 */
export const STAGE1_TARGET = (0.5 - Math.exp(-STAGE1_SECONDS / STAGE1_TAU)) / (1 - Math.exp(-STAGE1_SECONDS / STAGE1_TAU));
/** Acoustic families have no dampers from this MIDI note (F6) up. */
export const DAMPERLESS_FROM = 89;
/** Partials and wave harmonics stay below this fraction of the sample rate. */
export const NYQUIST_FRACTION = 0.45;

/** How a family behaves for release, soft release, string resonance and pedal noise (p.25). */
export type FamilyClass = 'acoustic' | 'electric' | 'plucked' | 'mallet';

export const FAMILY_CLASS: Readonly<Record<PianoFamily, FamilyClass>> = {
  grand: 'acoustic', upright: 'acoustic', fortepiano: 'acoustic', 'electric-grand': 'acoustic',
  'digital-acoustic': 'acoustic',
  tine: 'electric', reed: 'electric', fm: 'electric', 'digital-electric': 'electric',
  clavinet: 'plucked', harpsichord: 'plucked',
  vibraphone: 'mallet', marimba: 'mallet',
};

/** Families whose velocity does not change the sound: x is fixed (harpsichord, plan 13.3). */
export const FIXED_TOUCH: Readonly<Partial<Record<PianoFamily, number>>> = { harpsichord: 0.8 };

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

/** Equal temperament, A4 = 440 Hz. */
export function noteHz(m: number): number {
  return 440 * 2 ** ((m - 69) / 12);
}

/** A table time T (seconds to −40 dB) as an exponential time constant. */
export function tauOf(seconds: number): number {
  return seconds / TAU_DIVISOR;
}

// ---------------------------------------------------------------------------------------------
// Envelopes

/** The amplitude envelope of one partial: linear attack, optional first stage, exponential decay. */
export interface Env {
  /** Peak level (relative; the voice divides by the recipe's norm). */
  readonly amp: number;
  /** Seconds. */
  readonly attack: number;
  /** Acoustic two-stage decay: −6 dB over STAGE1_SECONDS, then `tau`. */
  readonly twoStage: boolean;
  /** Time constant of the (final) decay, seconds; finite and > 0. */
  readonly tau: number;
}

/** The envelope level `dt` seconds after note-on, before any release. */
export function envLevel(env: Env, dt: number): number {
  if (dt <= 0) return 0;
  if (env.attack > 0 && dt < env.attack) return env.amp * (dt / env.attack);
  const d = dt - Math.max(0, env.attack);
  if (!env.twoStage) return env.amp * Math.exp(-d / env.tau);
  if (d < STAGE1_SECONDS) return env.amp * (STAGE1_TARGET + (1 - STAGE1_TARGET) * Math.exp(-d / STAGE1_TAU));
  return 0.5 * env.amp * Math.exp(-(d - STAGE1_SECONDS) / env.tau);
}

/** Seconds after note-on when the held envelope falls to `floor` for good (0 when it never exceeds it). */
export function envEnd(env: Env, floor: number): number {
  if (env.amp <= floor) return 0;
  const a = Math.max(0, env.attack);
  if (!env.twoStage) return a + env.tau * Math.log(env.amp / floor);
  const half = 0.5 * env.amp;
  if (half <= floor) {
    // Falls below the floor during the first stage (the stage approaches STAGE1_TARGET·amp).
    const target = STAGE1_TARGET * env.amp;
    if (floor <= target) return a + STAGE1_SECONDS;
    return a + STAGE1_TAU * Math.log(((1 - STAGE1_TARGET) * env.amp) / (floor - target));
  }
  return a + STAGE1_SECONDS + env.tau * Math.log(half / floor);
}

/** Seconds after a release from `level` with time constant `tau` until `floor`. */
export function releaseEnd(level: number, tau: number, floor: number): number {
  return level <= floor || tau <= 0 ? 0 : tau * Math.log(level / floor);
}

// ---------------------------------------------------------------------------------------------
// Waves

export type WaveKind = 'reed' | 'pulse10' | 'harpsichord';

/** Coefficients for createPeriodicWave (index 0 unused); the browser normalises the wave to peak 1. */
export interface WaveSpec {
  readonly id: string;
  readonly real: Float32Array<ArrayBuffer>;
  readonly imag: Float32Array<ArrayBuffer>;
}

const MAX_HARMONICS: Readonly<Record<WaveKind, number>> = { reed: 8, pulse10: 24, harpsichord: 32 };
const waveCache = new Map<string, WaveSpec>();

/** The wave of a family with `harmonics` harmonics (at least 1, at most the family's maximum). */
export function waveSpec(kind: WaveKind, harmonics: number): WaveSpec {
  const n = clamp(Math.floor(harmonics), 1, MAX_HARMONICS[kind]);
  const id = `${kind}:${n}`;
  const cached = waveCache.get(id);
  if (cached !== undefined) return cached;
  const real = new Float32Array(new ArrayBuffer((n + 1) * 4));
  const imag = new Float32Array(new ArrayBuffer((n + 1) * 4));
  for (let j = 1; j <= n; j++) {
    if (kind === 'reed') imag[j] = (j % 2 === 1 ? 1 : 0.5) / j; // odd 1/j, even 0.5/j
    else if (kind === 'harpsichord') imag[j] = 1 / j ** 0.8;
    else real[j] = Math.sin(Math.PI * j * 0.1) / j; // a 10 % pulse, centred
  }
  const spec = { id, real, imag };
  waveCache.set(id, spec);
  return spec;
}

/** How many harmonics of f0 fit below NYQUIST_FRACTION of the sample rate (at least 1). */
export function harmonicsBelow(f0: number, sampleRate: number, max: number): number {
  return clamp(Math.floor((NYQUIST_FRACTION * sampleRate) / f0), 1, max);
}

// ---------------------------------------------------------------------------------------------
// Recipes

export type FilterKind = 'lowpass' | 'highpass' | 'bandpass' | 'lowshelf' | 'highshelf' | 'peaking';

export interface FilterSpec {
  readonly type: FilterKind;
  readonly freq: number;
  /** dB; shelves and peaking only. */
  readonly gain: number;
  readonly Q: number;
}

/** One oscillator: a sine, or the recipe's wave. */
export interface Component {
  /** Frequency as a multiple of f0. */
  readonly ratio: number;
  /** Fixed detune in cents (string doubling, a second string). */
  readonly detune: number;
  readonly env: Env;
  /** 1-based partial number; components of a doubled partial share it (the source budget drops whole partials). */
  readonly partial: number;
}

/** Two-operator FM on component 0: a modulator at f0 whose index falls from index0 to indexEnd. */
export interface FmSpec {
  readonly index0: number;
  readonly indexEnd: number;
  readonly tau: number;
}

/** A resonant low-pass whose cutoff falls from `from` to `to` (clavinet). */
export interface SweepSpec {
  readonly from: number;
  readonly to: number;
  readonly tau: number;
  readonly Q: number;
}

/** A filtered noise burst: hammer, mallet, damper thump, key-off thunk, jack. */
export interface NoiseSpec {
  readonly filter: 'lowpass' | 'bandpass' | 'highpass';
  readonly freq: number;
  readonly Q: number;
  /** Seconds. */
  readonly duration: number;
  /** Peak level relative to the voice's normalised peak. */
  readonly level: number;
}

export interface VoiceRecipe {
  readonly family: PianoFamily;
  /** Fundamental, Hz (before the pitch stick and the unison detune). */
  readonly f0: number;
  /** Empty when the note is too high to sound. */
  readonly components: readonly Component[];
  /** The wave every component plays; null: sines. */
  readonly wave: WaveSpec | null;
  readonly fm: FmSpec | null;
  readonly sweep: SweepSpec | null;
  /** Static voice filters, in order. */
  readonly filters: readonly FilterSpec[];
  /** tanh pre-gain of the bark or reed shaper; null: none. */
  readonly shaper: number | null;
  readonly attackNoise: NoiseSpec | null;
  /** Played when the damper falls (key-up or pedal-up). */
  readonly releaseNoise: NoiseSpec | null;
  /** T_rel: seconds to −40 dB once the damper falls; Infinity: key-up changes nothing (no dampers). */
  readonly releaseTime: number;
  /** The voice's peak bound: the sum of the component peaks; voices divide by it. */
  readonly norm: number;
}

export interface RecipeInput {
  readonly family: PianoFamily;
  /** The model's name when it belongs to the layer's type, else null. */
  readonly name: string | null;
  /** MIDI note after the layer's octave shift. */
  readonly note: number;
  /** Touch value 0..1 for brightness (never compressed by dyn comp). */
  readonly x: number;
  /** piano{X}.variation 0..3: Clav pickup A..D. */
  readonly variation: number;
  readonly sampleRate: number;
  /** Above HALF_PARTIALS_ABOVE sounding voices: additive families keep half their partials. */
  readonly halfPartials: boolean;
}

const db = (d: number): number => 10 ** (d / 20);

/** −34 dB damper thump (noise low-passed at 300 Hz, 40 ms). */
const THUMP: NoiseSpec = { filter: 'lowpass', freq: 300, Q: 0.7, duration: 0.04, level: db(-34) };

interface GrandOptions {
  readonly bMul: number;
  readonly t1Mul: number;
  readonly maxPartials: number;
  /** ± cents of the doubled partials 1–2 from MIDI 40 up; 0: no doubling. */
  readonly doubling: number;
  /** Added to the partial slope exponent (darker when positive). */
  readonly slope: number;
  /** Hammer level factor; 0: no hammer. */
  readonly hammer: number;
  /** Fixed hammer band-pass centre, Hz; null: 2·f0 within 800–5000 Hz. */
  readonly hammerHz: number | null;
  readonly releaseTime: number;
  readonly thump: boolean;
  readonly filters: readonly FilterSpec[];
}

const GRAND: GrandOptions = {
  bMul: 1, t1Mul: 1, maxPartials: 10, doubling: 0.7, slope: 0, hammer: 1, hammerHz: null, releaseTime: 0.55,
  thump: true, filters: [],
};

/** Keep whole partials in order while their components fit the budget. */
function fitBudget(comps: readonly Component[], budget: number, half: boolean): Component[] {
  const partials = [...new Set(comps.map((c) => c.partial))];
  const keep = half ? Math.ceil(partials.length / 2) : partials.length;
  const out: Component[] = [];
  for (const p of partials.slice(0, keep)) {
    const group = comps.filter((c) => c.partial === p);
    if (out.length + group.length > budget) break;
    out.push(...group);
  }
  return out;
}

function sumAmp(comps: readonly Component[]): number {
  return comps.reduce((s, c) => s + c.env.amp, 0);
}

function grandLike(inp: RecipeInput, o: GrandOptions): Omit<VoiceRecipe, 'family'> {
  const m = inp.note;
  const f0 = noteHz(m);
  const limit = NYQUIST_FRACTION * inp.sampleRate;
  const b = 3e-4 * o.bMul * (m <= 48 ? 1 : 2 ** ((m - 48) / 18));
  const t1 = 12 * 2 ** (-(m - 21) / 22) * o.t1Mul;
  const slope = 1.6 + o.slope - 0.8 * inp.x;
  const all: Component[] = [];
  for (let n = 1; n <= o.maxPartials; n++) {
    const ratio = n * Math.sqrt(1 + b * n * n);
    if (ratio * f0 >= limit) break;
    const amp = (1 / n) ** slope;
    const tau = tauOf(t1 / (1 + 0.35 * (n - 1)));
    if (o.doubling > 0 && m >= 40 && n <= 2) {
      for (const sign of [-1, 1]) {
        all.push({ ratio, detune: sign * o.doubling, partial: n, env: { amp: amp / 2, attack: ATTACK, twoStage: true, tau } });
      }
    } else {
      all.push({ ratio, detune: 0, partial: n, env: { amp, attack: ATTACK, twoStage: true, tau } });
    }
  }
  const hammer = o.hammer > 0 && all.length > 0;
  const components = fitBudget(all, MAX_SOURCES - (hammer ? 1 : 0), inp.halfPartials);
  return {
    f0, components, wave: null, fm: null, sweep: null, filters: o.filters, shaper: null,
    attackNoise: hammer
      ? { filter: 'bandpass', freq: o.hammerHz ?? clamp(2 * f0, 800, 5000), Q: 1, duration: 0.015, level: 0.15 * inp.x * o.hammer }
      : null,
    releaseNoise: o.thump ? THUMP : null,
    releaseTime: o.releaseTime,
    norm: sumAmp(components),
  };
}

interface TineOptions {
  readonly index0: number;
  readonly bellRatio: number | null;
  readonly tMul: number;
  readonly bark: boolean;
}

function tineLike(inp: RecipeInput, o: TineOptions): Omit<VoiceRecipe, 'family'> {
  const m = inp.note;
  const f0 = noteHz(m);
  const limit = NYQUIST_FRACTION * inp.sampleRate;
  const t = 4 * 2 ** (-(m - 48) / 24) * o.tMul;
  const components: Component[] = [];
  if (f0 < limit) {
    components.push({ ratio: 1, detune: 0, partial: 1, env: { amp: 1, attack: ATTACK, twoStage: false, tau: tauOf(t) } });
    const bellAmp = 0.15 * inp.x;
    if (o.bellRatio !== null && o.bellRatio * f0 < limit && bellAmp > 0) {
      components.push({ ratio: o.bellRatio, detune: 0, partial: 2, env: { amp: bellAmp, attack: ATTACK, twoStage: false, tau: 0.12 } });
    }
  }
  return {
    f0, components, wave: null,
    fm: components.length > 0 ? { index0: o.index0, indexEnd: 0.2 * o.index0, tau: 0.4 } : null,
    sweep: null, filters: [], shaper: o.bark ? 1 + 2 * inp.x ** 3 : null,
    attackNoise: null, releaseNoise: null, releaseTime: 0.25, norm: sumAmp(components),
  };
}

function waveVoice(inp: RecipeInput, kind: WaveKind, t: number, strings: readonly number[]): Pick<VoiceRecipe,
  'f0' | 'components' | 'wave' | 'norm'> {
  const f0 = noteHz(inp.note);
  if (f0 >= NYQUIST_FRACTION * inp.sampleRate) return { f0, components: [], wave: null, norm: 0 };
  const amp = 1 / strings.length;
  const components = strings.map((detune, i): Component => ({
    ratio: 1, detune, partial: i + 1, env: { amp, attack: ATTACK, twoStage: false, tau: tauOf(t) },
  }));
  return { f0, components, wave: waveSpec(kind, harmonicsBelow(f0, inp.sampleRate, MAX_HARMONICS[kind])), norm: 1 };
}

function mallet(inp: RecipeInput, ratios: readonly number[], amps: readonly number[], t1: number,
  divisors: readonly number[], noise: NoiseSpec, releaseTime: number): Omit<VoiceRecipe, 'family'> {
  const f0 = noteHz(inp.note);
  const limit = NYQUIST_FRACTION * inp.sampleRate;
  const all: Component[] = [];
  ratios.forEach((ratio, i) => {
    const amp = amps[i]!;
    if (ratio * f0 >= limit || amp <= 0) return;
    all.push({ ratio, detune: 0, partial: i + 1, env: { amp, attack: ATTACK, twoStage: false, tau: tauOf(t1 / divisors[i]!) } });
  });
  const components = fitBudget(all, MAX_SOURCES - 1, inp.halfPartials);
  return {
    f0, components, wave: null, fm: null, sweep: null, filters: [], shaper: null,
    attackNoise: components.length > 0 ? noise : null, releaseNoise: null, releaseTime, norm: sumAmp(components),
  };
}

/** Clav pickups by piano{X}.variation (p.24; the mapping 0..3 = A..D is unverified). */
export function clavPickup(variation: number, f0: number): FilterSpec[] {
  switch (variation) {
    case 0: return [{ type: 'lowpass', freq: 2000, gain: 0, Q: 0.707 }]; // A: neck, warmer
    case 1: return [{ type: 'highpass', freq: 400, gain: 0, Q: 0.707 }]; // B: bridge, bright
    case 3: return [{ type: 'highpass', freq: 2.2 * f0, gain: 0, Q: 0.707 }]; // D: out of phase, thin
    default: return []; // C: both in phase
  }
}

/** The recipe for one note of one family (plan section 13.3). */
export function recipe(inp: RecipeInput): VoiceRecipe {
  const x = clamp(inp.x, 0, 1);
  const i: RecipeInput = { ...inp, x, note: clamp(inp.note, 0, 127) };
  const m = i.note;
  const name = i.name ?? '';
  const limit = NYQUIST_FRACTION * i.sampleRate;
  const body = ((): Omit<VoiceRecipe, 'family'> => {
    switch (i.family) {
      case 'grand':
        return grandLike(i, GRAND);
      case 'upright': {
        const mellow = /Felt|Mellow|Soft/.test(name);
        return grandLike(i, {
          ...GRAND, bMul: 1.8, t1Mul: 0.7, doubling: /HonkyTonk/.test(name) ? 8 : 1.5,
          slope: mellow ? 0.4 : 0, hammer: mellow ? 0.4 : 1,
          filters: [{ type: 'lowpass', freq: 6000, gain: 0, Q: 0.707 }],
        });
      }
      case 'fortepiano':
        return grandLike(i, { ...GRAND, maxPartials: 8, bMul: 2, t1Mul: 0.45, hammerHz: 3000, releaseTime: 0.9 });
      case 'electric-grand':
        return grandLike(i, {
          ...GRAND, bMul: 3, t1Mul: 0.5, slope: 0.3, filters: [{ type: 'peaking', freq: 1200, gain: 4, Q: 1 }],
        });
      case 'digital-acoustic':
        return grandLike(i, {
          ...GRAND, maxPartials: 6, bMul: 0, doubling: 0, hammer: 0, releaseTime: 0.6, thump: false,
          filters: [{ type: 'lowpass', freq: 8000, gain: 0, Q: 0.707 }],
        });
      case 'tine':
        return tineLike(i, { index0: 0.5 + 2.5 * x * x, bellRatio: 13.6, tMul: 1, bark: true });
      case 'fm':
        return tineLike(i, { index0: 2 + 3 * x * x, bellRatio: 14, tMul: 0.7, bark: false });
      case 'digital-electric':
        return tineLike(i, { index0: 1.5, bellRatio: null, tMul: 0.8, bark: true });
      case 'reed':
        return {
          ...waveVoice(i, 'reed', 2.5 * 2 ** (-(m - 48) / 24), [0]),
          fm: null, sweep: null, filters: [{ type: 'lowpass', freq: 3000, gain: 0, Q: 0.707 }],
          shaper: 1 + 3 * x * x, attackNoise: null, releaseNoise: null, releaseTime: 0.2,
        };
      case 'clavinet': {
        const f0 = noteHz(m);
        return {
          ...waveVoice(i, 'pulse10', 1.8 * 2 ** (-(m - 48) / 24), [0]),
          fm: null,
          sweep: { from: Math.min(8 * f0 + 4000 * x, limit), to: Math.min(2 * f0 + 800, limit), tau: 0.15, Q: 4 },
          filters: clavPickup(i.variation, f0), shaper: null, attackNoise: null,
          releaseNoise: { filter: 'lowpass', freq: 500, Q: 0.7, duration: 0.015, level: db(-30) },
          releaseTime: 0.08,
        };
      }
      case 'harpsichord':
        return {
          ...waveVoice(i, 'harpsichord', 3 * 2 ** (-(m - 48) / 24), [0, 3]),
          fm: null, sweep: null, filters: [{ type: 'bandpass', freq: 1500, gain: 0, Q: 0.7 }], shaper: null,
          attackNoise: null, releaseNoise: { filter: 'bandpass', freq: 3000, Q: 1, duration: 0.01, level: db(-26) },
          releaseTime: 0.35,
        };
      case 'vibraphone':
        return mallet(i, [1, 3.98, 10.3], [1, 0.3 * x, 0.08 * x], 8 * 2 ** (-(m - 60) / 24), [1, 3, 8],
          { filter: 'lowpass', freq: 1500, Q: 0.7, duration: 0.008, level: db(-26) }, 0.7);
      case 'marimba':
        // Partial 3's decay (T₁/8) is not in the plan; it decays faster than partial 2 (T₁/4).
        return mallet(i, [1, 3.93, 9.2], [1, 0.25 * x, 0.05 * x], 1.2 * 2 ** (-(m - 60) / 24), [1, 4, 8],
          { filter: 'bandpass', freq: 800, Q: 1, duration: 0.01, level: 0.1 * x }, Infinity);
    }
  })();
  return { family: i.family, ...body };
}

/**
 * The release time when the damper falls (key-up without pedal, or pedal-up), p.25:
 * - acoustic families have no dampers from DAMPERLESS_FROM up: Infinity (the note keeps decaying);
 * - Soft Release: acoustic T_rel × 3.5 ("a slightly longer and less pronounced release"), electric
 *   × 0.5 ("dampened significantly"); clavinets and harpsichords "do not support" it; mallets ignore it.
 */
export function releaseSeconds(family: PianoFamily, base: number, note: number, softRelease: boolean): number {
  const cls = FAMILY_CLASS[family];
  if (!Number.isFinite(base)) return Infinity;
  if (cls === 'acoustic' && note >= DAMPERLESS_FROM) return Infinity;
  if (!softRelease) return base;
  if (cls === 'acoustic') return base * 3.5;
  if (cls === 'electric') return base * 0.5;
  return base;
}

/**
 * Whether a voice feeds the string resonance (p.25: the Med, Lrg and XL sizes of Grand and Upright
 * pianos; Med only in the middle range C3–C6; not Sml, not electric pianos). A model without a size
 * in its name (or the type's default family, hash 0) counts as Med: an assumption.
 */
export function resonates(family: PianoFamily, size: PianoSize | null, note: number): boolean {
  if (family !== 'grand' && family !== 'upright' && family !== 'fortepiano') return false;
  if (size === 'Sml') return false;
  if (size === 'Lrg' || size === 'XL') return true;
  return note >= 48 && note <= 84;
}

/** Whether the pedal noise sounds for a family (p.25: "on an acoustic or electric piano"). */
export function hasPedalNoise(family: PianoFamily): boolean {
  const cls = FAMILY_CLASS[family];
  return cls === 'acoustic' || cls === 'electric';
}
