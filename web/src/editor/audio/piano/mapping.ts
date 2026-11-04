/**
 * Piano field values → physical values for the browser piano (plan section 13.3). Pure: no Web Audio.
 * Touch, dynamic compression, unison and timbre have no Stage 4 display table: their curves and
 * the order of the timbre values are guessed (status unverified), from the manual's descriptions
 * (Nord Stage 4 manual v1.6X p.25–26).
 */
import { descriptorOf, toSi } from '../../model/descriptors.ts';
import { layerKey, type Ns4Key } from '../../model/keys.ts';
import type { ValueReader } from '../../model/labels.ts';
import { type PianoFamily, pianoFamily, pianoModel, type PianoModel, type PianoType, pianoType } from '../../model/pianos.ts';
import type { PianoLayer } from '../../model/scene.ts';
import type { FilterKind } from './recipes.ts';

export const PIANO_LAYERS: readonly PianoLayer[] = ['A', 'B'];

/** The key of a piano layer pattern ('piano{L}.bank', 'piano.layerLevelPno{L}'). */
export function pianoKey(layer: PianoLayer, pattern: string): Ns4Key {
  return layerKey(layer, pattern);
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

// ---------------------------------------------------------------------------------------------
// Touch and dynamics (p.25)

/** KB Touch heavy, med, light (table 249-8): x = (velocity/127)^γ; heavy "facilitates playing softly". */
export const TOUCH_GAMMA: readonly number[] = [1.6, 1.2, 0.85];
/** Dyn Comp off, 1, 2, 3: the dynamic range in dB; compression "rais[es] its minimum sound level". */
export const DYN_RANGE_DB: readonly number[] = [40, 32, 24, 16];
/** One note at velocity 100, touch med, dyn comp off and 0 dB layer level peaks at about this. */
export const REF_PEAK = 0.5;

/** The touch value 0..1 of a velocity: drives brightness, and through dynLevel the loudness. */
export function touchX(velocity: number, touch: number): number {
  const gamma = TOUCH_GAMMA[touch] ?? TOUCH_GAMMA[1]!;
  return (clamp(velocity, 0, 127) / 127) ** gamma;
}

/** Loudness of a touch value: 10^(−R(1 − x)/20) with R the dyn comp range. Timbre keeps the plain x. */
export function dynLevel(x: number, dynComp: number): number {
  const range = DYN_RANGE_DB[dynComp] ?? DYN_RANGE_DB[0]!;
  return 10 ** ((-range * (1 - clamp(x, 0, 1))) / 20);
}

/** The voice output scale that makes velocity 100, touch med, dyn comp off peak at REF_PEAK. */
export const LEVEL_SCALE = REF_PEAK / dynLevel(touchX(100, 1), 0);

// ---------------------------------------------------------------------------------------------
// Unison (p.26)

export interface UnisonSpec {
  /** 1 (off) or 2 copies. */
  readonly copies: number;
  /** ± cents of the two copies. */
  readonly cents: number;
  /** ± pan of the two copies. */
  readonly pan: number;
}

const UNISON_CENTS: readonly number[] = [0, 4, 8, 16];

export function unisonSpec(unison: number): UnisonSpec {
  const cents = UNISON_CENTS[unison] ?? 0;
  return cents === 0 ? { copies: 1, cents: 0, pan: 0 } : { copies: 2, cents, pan: 0.6 };
}

/** Each unison copy's gain: between equal peak (≈ 0.79 with the ±0.6 pans) and equal power (1). */
export const UNISON_COPY_GAIN = 0.8;

// ---------------------------------------------------------------------------------------------
// Timbre (p.26)

export interface EqBand {
  readonly type: FilterKind;
  readonly freq: number;
  readonly gain: number;
  readonly Q: number;
}

const ls = (freq: number, gain: number): EqBand => ({ type: 'lowshelf', freq, gain, Q: 0.707 });
const hs = (freq: number, gain: number): EqBand => ({ type: 'highshelf', freq, gain, Q: 0.707 });
const pk = (freq: number, gain: number, Q = 1): EqBand => ({ type: 'peaking', freq, gain, Q });

const ACOUSTIC_TIMBRE: readonly (readonly EqBand[])[] = [
  [],
  [hs(3000, -6), ls(200, 2)], // Soft
  [ls(200, -4), pk(1000, 3, 0.7), hs(5000, -4)], // Mid
  [hs(3000, 6)], // Bright
];
const DYNO1 = [pk(2500, 6, 1.2), hs(8000, 3)];
const ELECTRIC_TIMBRE: readonly (readonly EqBand[])[] = [
  [],
  [hs(2500, -6)], // Soft
  [pk(1500, 5)], // Mid
  [pk(1500, 4), hs(5000, 4)], // Bright
  DYNO1, // Dyno 1
  [...DYNO1, ls(120, 5), pk(600, -3)], // Dyno 2
];

/**
 * The timbre filters of a piano{X}.eq value for the layer's type (piano{X}.bank). Clav reads the
 * value as a mask: 1 Soft, 2 Treble, 4 Brilliant. Values without a label are flat.
 */
export function timbreBands(type: PianoType, eq: number): readonly EqBand[] {
  if (type === 'clav') {
    const bands: EqBand[] = [];
    if ((eq & 1) !== 0) bands.push(hs(2000, -6));
    if ((eq & 2) !== 0) bands.push(hs(3000, 5));
    if ((eq & 4) !== 0) bands.push(pk(5000, 6));
    return bands;
  }
  const set = type === 'electric' ? ELECTRIC_TIMBRE : ACOUSTIC_TIMBRE;
  return set[eq] ?? [];
}

/** The most bands any timbre uses (Dyno 2): the layer keeps this many filters. */
export const TIMBRE_BANDS = 4;

// ---------------------------------------------------------------------------------------------
// Layer settings

/** piano{X}.acoustic bits (assumed; the default 1 is string res on, as the converter assumes). */
export const STRING_RES_BIT = 1;
export const SOFT_RELEASE_BIT = 2;

export interface LayerSettings {
  readonly type: PianoType;
  readonly family: PianoFamily;
  /** The stored model when it belongs to the stored type, else null. */
  readonly model: PianoModel | null;
  /** Semitones (12 × octave shift). */
  readonly shift: number;
  readonly touch: number;
  readonly dynComp: number;
  readonly unison: number;
  readonly variation: number;
  readonly stringRes: boolean;
  readonly softRelease: boolean;
  readonly sustain: boolean;
  readonly pStick: boolean;
  readonly pedalNoise: boolean;
  readonly eq: number;
}

export function layerSettings(values: ValueReader, layer: PianoLayer): LayerSettings {
  const get = (pattern: string): number => values.get(pianoKey(layer, pattern));
  const bank = get('piano{L}.bank');
  const hash = get('piano{L}.nameHash');
  const type = pianoType(bank);
  const model = pianoModel(hash);
  const acoustic = get('piano{L}.acoustic');
  return {
    type,
    family: pianoFamily(bank, hash),
    model: model !== null && model.type === type ? model : null,
    shift: 12 * get('piano{L}.octaveShift'),
    touch: get('piano{L}.kbdTouch'),
    dynComp: get('piano{L}.dynComp'),
    unison: get('piano{L}.unison'),
    variation: get('piano{L}.variation'),
    stringRes: (acoustic & STRING_RES_BIT) !== 0,
    softRelease: (acoustic & SOFT_RELEASE_BIT) !== 0,
    sustain: get('piano{L}.sustainEnable') !== 0,
    pStick: get('piano{L}.pStickEnable') !== 0,
    pedalNoise: get('piano{L}.pedalNoise') !== 0,
    eq: get('piano{L}.eq'),
  };
}

/** Layer level (table 230-7): the dB label as a gain; 'volume off' is 0. */
export function layerGain(values: ValueReader, layer: PianoLayer): number {
  const key = pianoKey(layer, 'piano.layerLevelPno{L}');
  const db = toSi(descriptorOf(key), values.get(key), values);
  return db === null || Number.isNaN(db) || db === -Infinity ? 0 : 10 ** (db / 20);
}

/** The pitch stick bends a layer ±2 semitones when its switch is on (p.23). */
export const BEND_CENTS = 200;

export function bendCents(values: ValueReader, layer: PianoLayer, bend: number): number {
  if (values.get(pianoKey(layer, 'piano{L}.pStickEnable')) === 0) return 0;
  const b = clamp(bend, -8192, 8191);
  return b >= 0 ? (b / 8191) * BEND_CENTS : (b / 8192) * BEND_CENTS;
}
