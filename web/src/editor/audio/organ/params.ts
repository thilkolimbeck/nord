/**
 * The organ's values as sound parameters (plan section 13.2): drawbar levels, tonewheel numbers,
 * per-model footages and registers, the vibrato/chorus scanner, percussion, gate times and the
 * rotary speaker's speeds, microphones and drive. "M p.N" is the Nord Stage 4 manual v1.6X.
 * Every number that does not come from the manual is a guess and marked so; the Stage 4 organ
 * engine is not documented. Pure: no Web Audio, no DOM.
 */
import { isNs4Key, type Ns4Key } from '../../model/keys.ts';
import { ns4Label, type ValueReader } from '../../model/labels.ts';
import { parseDisplay } from '../../model/units.ts';
import type { OrganLayer } from '../section.ts';

export const ORGAN_LAYERS: readonly OrganLayer[] = ['A', 'B'];

/** The organ models in the order of table 114-2 (M p.18–21). */
export type OrganModel = 'b3' | 'vox' | 'farf' | 'pipe1' | 'pipe2' | 'b3bass';
export const ORGAN_MODELS: readonly OrganModel[] = ['b3', 'vox', 'farf', 'pipe1', 'pipe2', 'b3bass'];

/** Organ voices (note-layers) at most: the Stage 4 organ has full polyphony (M p.19); this only bounds runaway MIDI. */
export const MAX_ORGAN_VOICES = 128;

export function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

/** Frequency of a MIDI note, A4 = 440 Hz; fractional notes allowed. */
export function mtof(note: number): number {
  return 440 * 2 ** ((note - 69) / 12);
}

/** A layer field: ('A', '.model') → 'organA.model', ('B', 'Drawbars.org_Preset_kDb3') → 'organBDrawbars.org_Preset_kDb3'. */
export function organKey(layer: OrganLayer, suffix: string): Ns4Key {
  const key = `organ${layer}${suffix}`;
  if (!isNs4Key(key)) throw new Error(`${key} is not a Stage 4 field`);
  return key;
}

/** Drawbar n (1..9) of a layer. */
export function drawbarKey(layer: OrganLayer, n: number): Ns4Key {
  return organKey(layer, `Drawbars.org_Preset_kDb${n}`);
}

const vibPerc = (layer: OrganLayer, name: string): Ns4Key => organKey(layer, `VibPerc.org_Preset_k${name}`);

export function modelOf(values: ValueReader, layer: OrganLayer): OrganModel {
  return ORGAN_MODELS[values.get(organKey(layer, '.model'))] ?? 'b3';
}

/** The nine drawbar positions 0..8 of a layer (M p.19: "0–8"). */
export function drawbars(values: ValueReader, layer: OrganLayer): number[] {
  return [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => clamp(Math.round(values.get(drawbarKey(layer, n))), 0, 8));
}

/**
 * The gain of a continuous drawbar: 0 is silent, each step below 8 is −3 dB (the Hammond
 * convention; unverified for the Stage 4).
 */
export function drawbarLevel(position: number): number {
  const v = clamp(Math.round(position), 0, 8);
  return v === 0 ? 0 : 10 ** ((-3 * (8 - v)) / 20);
}

// ── Tonewheels (B3 and B3 Bass, M p.19, 21) ─────────────────────────────────────────────────────

export const WHEELS = 91;

/** Wheel n (1..91) in equal temperament: wheel 1 = C1 (32.7 Hz), wheel 46 = 440 Hz (the 8′ of A4). */
export function wheelFrequency(n: number): number {
  return 440 * 2 ** ((n - 46) / 12);
}

/** Fold a wheel number into 1..91 by octaves: the B3 folds its top back; folding the bottom is an approximation. */
export function foldWheel(n: number): number {
  let w = Math.round(n);
  while (w < 1) w += 12;
  while (w > WHEELS) w -= 12;
  return w;
}

/** Semitone offsets of the B3 drawbars from the key's 8′ wheel: 16′ 5⅓′ 8′ 4′ 2⅔′ 2′ 1⅗′ 1⅓′ 1′ (M p.19). */
export const B3_OFFSETS: readonly number[] = [-12, 7, 0, 12, 19, 24, 28, 31, 36];
/** B3 Bass: "the two traditional B3 Bass 16′ and 8′ drawbars" (M p.21), assumed on db1 and db2. */
export const B3_BASS_OFFSETS: readonly number[] = [-12, 0];

/** The wheel of key `m` (MIDI, after octave shift) for a semitone offset from its 8′: MIDI 36 at 8′ is wheel 13. */
export function wheelIndex(m: number, offset: number): number {
  return foldWheel(m - 23 + offset);
}

export interface Contact {
  /** The drawbar (0-based) whose bus the contact feeds. */
  readonly drawbar: number;
  readonly wheel: number;
}

/** The wheel contacts of one key: nine for the B3, two (db1, db2) for B3 Bass, none for the other models. */
export function contactsFor(model: OrganModel, m: number): Contact[] {
  const offsets = model === 'b3' ? B3_OFFSETS : model === 'b3bass' ? B3_BASS_OFFSETS : [];
  return offsets.map((o, drawbar) => ({ drawbar, wheel: wheelIndex(m, o) }));
}

/**
 * Drawbar bus gains of the tonewheel path. With B3 percussion on, the 1′ drawbar (db9) is
 * muted, as on the original B3 (unverified for the Stage 4).
 */
export function tonewheelBusLevels(values: ValueReader, layer: OrganLayer): number[] {
  const levels = drawbars(values, layer).map(drawbarLevel);
  if (percussionSpec(values, layer).on) levels[8] = 0;
  return levels;
}

// ── Pipe 1 and Pipe 2 (M p.21) ──────────────────────────────────────────────────────────────────

/** "The pipe lengths available for both Pipe models correspond to those of the B3 model" (M p.21): pure ratios to 8′. */
export const PIPE_RATIOS: readonly number[] = [0.5, 1.5, 1, 2, 3, 4, 5, 6, 8];

/**
 * The gain of a layer's pipe sum: a registration of three full drawbars peaks at about 0.5 per
 * note, a full registration at 1.0 at most.
 */
export function pipeSumGain(levels: readonly number[]): number {
  const sum = levels.reduce((a, b) => a + b, 0);
  return sum <= 0 ? 1 / 6 : Math.min(1 / 6, 1 / sum);
}

/**
 * Vibrato on a Pipe "switches to a model which is tuned with less precision" (M p.21): a fixed
 * detune per note and footage from a seeded table within ±6 cents (the values are invented).
 */
export function pipeDetuneCents(m: number, drawbar: number): number {
  const i = (((Math.round(m) * 9 + drawbar) % DETUNE_TABLE.length) + DETUNE_TABLE.length) % DETUNE_TABLE.length;
  return DETUNE_TABLE[i]!;
}

const DETUNE_TABLE: readonly number[] = (() => {
  let a = 0x51ed27;
  const out: number[] = [];
  for (let i = 0; i < 61; i++) {
    a = (Math.imul(a, 1103515245) + 12345) >>> 0;
    out.push(Math.round(((a >>> 8) / 0xffffff * 12 - 6) * 100) / 100);
  }
  return out;
})();

// ── Vox and Farf (M p.20–21) ────────────────────────────────────────────────────────────────────

/**
 * Vox partial drawbars 1..7 as ratios to the 16′ fundamental. "The seven drawbars to the left
 * control the level of each partial" (M p.20); the footages 16′ 8′ 4′ 2′ 2⅔′ 1⅗′ 1′ are a guess
 * (they are printed on the panel only). Drawbar 8 does nothing; drawbar 9 is the soft/bright mix.
 */
export const VOX_RATIOS: readonly number[] = [1, 2, 4, 8, 6, 10, 16];

/** Vox drawbar 9: "the mix between a filtered signal sounding soft and dark, and an unfiltered signal sounding bright" (M p.20); 0 soft … 1 bright. */
export function voxBrightness(values: ValueReader, layer: OrganLayer): number {
  return clamp(values.get(drawbarKey(layer, 9)), 0, 8) / 8;
}

export type FarfTimbre = 'bass' | 'strings' | 'flute' | 'oboe' | 'trumpet' | 'bright';

export interface FarfRegister {
  readonly name: string;
  /** Ratio of the register's fundamental to the 16′ grid: 16′ 1, 8′ 2, 4′ 4, 2⅔′ 6. */
  readonly ratio: number;
  readonly timbre: FarfTimbre;
}

/** The Farf registers on drawbars 1..9 (M p.21 table). */
export const FARF_REGISTERS: readonly FarfRegister[] = [
  { name: 'Bass 16', ratio: 1, timbre: 'bass' },
  { name: 'Strings 16', ratio: 1, timbre: 'strings' },
  { name: 'Flute 8', ratio: 2, timbre: 'flute' },
  { name: 'Oboe 8', ratio: 2, timbre: 'oboe' },
  { name: 'Trumpet 8', ratio: 2, timbre: 'trumpet' },
  { name: 'Strings 8', ratio: 2, timbre: 'strings' },
  { name: 'Flute 4', ratio: 4, timbre: 'flute' },
  { name: 'Strings 4', ratio: 4, timbre: 'strings' },
  { name: '2⅔′', ratio: 6, timbre: 'bright' },
];

/** "Pulling a drawbar more than half way out will activate that register" (M p.20–21): LEDs 5–8 lit = on. */
export function farfRegisterOn(position: number): boolean {
  return position >= 5;
}

// ── Vibrato / chorus scanner (M p.19–21) ────────────────────────────────────────────────────────

export const B3_VIBRATO_TYPES = ['V1', 'C1', 'V2', 'C2', 'V3', 'C3'] as const;
export const VOX_VIBRATO_TYPES = ['V1', 'V2', 'V3'] as const;
export const FARF_VIBRATO_TYPES = ['V1', 'V2', 'C2', 'C3'] as const;

export interface ScannerSpec {
  /** The sweep rate in Hz. */
  readonly rateHz: number;
  /** Peak deviation of the swept delay in seconds (0: no modulation). */
  readonly depth: number;
  /** Dry and wet gains: vibrato is wet only, chorus mixes 1:1, off is dry only. */
  readonly dry: number;
  readonly wet: number;
  /** The type label, or 'off'. */
  readonly type: string;
}

/** Centre of the scanner's swept delay. */
export const SCANNER_CENTRE = 0.001;
const OFF: ScannerSpec = { rateHz: 6.9, depth: 0, dry: 1, wet: 0, type: 'off' };

function scan(rateHz: number, depthMs: number, chorus: boolean, type: string): ScannerSpec {
  return { rateHz, depth: depthMs / 1000, dry: chorus ? 0.5 : 0, wet: chorus ? 0.5 : 1, type };
}

export function vibratoOn(values: ValueReader, layer: OrganLayer): boolean {
  return values.get(vibPerc(layer, 'VibratoEnable')) !== 0;
}

/**
 * The scanner of a layer for a model, from its vibrato switch and the section's type for that model.
 * B3 and B3 Bass: 6.9 Hz, V1/V2/V3 0.12/0.25/0.45 ms (≈ 9, 19, 34 cents), C1–C3 the same with dry
 * (M p.19). Vox: 5.6 Hz, 0.08/0.16/0.3 ms (M p.20). Farf: 6.2 Hz, V1 0.1 ms, V2 0.25 ms, C2 0.2 ms
 * and C3 0.35 ms with dry (M p.21). Pipes: no modulation, a detuned model instead (pipeDetuneCents).
 * Rates and depths are guesses; the type orders are the converter's (unverified).
 */
export function scannerSpec(values: ValueReader, layer: OrganLayer, model: OrganModel = modelOf(values, layer)): ScannerSpec {
  if (!vibratoOn(values, layer)) return OFF;
  switch (model) {
    case 'b3':
    case 'b3bass': {
      const type = B3_VIBRATO_TYPES[values.get('organ.vibratoTypeB3')] ?? 'C3';
      const depth = type.endsWith('1') ? 0.12 : type.endsWith('2') ? 0.25 : 0.45;
      return scan(6.9, depth, type.startsWith('C'), type);
    }
    case 'vox': {
      const type = VOX_VIBRATO_TYPES[values.get('organ.vibratoTypeVox')] ?? 'V3';
      return scan(5.6, type === 'V1' ? 0.08 : type === 'V2' ? 0.16 : 0.3, false, type);
    }
    case 'farf': {
      const type = FARF_VIBRATO_TYPES[values.get('organ.vibratoTypeFarfisa')] ?? 'V2';
      const depth = { V1: 0.1, V2: 0.25, C2: 0.2, C3: 0.35 }[type];
      return scan(6.2, depth, type.startsWith('C'), type);
    }
    case 'pipe1':
    case 'pipe2':
      return { ...OFF, type: 'detuned' };
  }
}

// ── Percussion (M p.20) ─────────────────────────────────────────────────────────────────────────

export interface PercussionSpec {
  /** Percussion switched on and the layer's model is B3 ("only available for the B3 organ model", M p.20). */
  readonly on: boolean;
  /** 2nd harmonic (the 4′ wheel) or 3rd (the 2⅔′ wheel). */
  readonly harmonic: 2 | 3;
  /** The wheel offset from the key's 8′ wheel. */
  readonly offset: number;
  /** Peak gain: 1.0 normal, 0.5 soft (guess). */
  readonly peak: number;
  /** Seconds to −40 dB: 1.2 slow, 0.4 fast (guess). */
  readonly decay: number;
  /** Poly mode: every stroke has percussion (M p.20). */
  readonly poly: boolean;
}

export function percussionSpec(values: ValueReader, layer: OrganLayer): PercussionSpec {
  const third = values.get(vibPerc(layer, 'B3PercHarmonic')) !== 0;
  return {
    on: values.get(vibPerc(layer, 'B3PercEnable')) !== 0 && modelOf(values, layer) === 'b3',
    harmonic: third ? 3 : 2,
    offset: third ? 19 : 12,
    peak: values.get(vibPerc(layer, 'B3PercLevel')) !== 0 ? 0.5 : 1,
    decay: values.get(vibPerc(layer, 'B3PercSpeed')) !== 0 ? 0.4 : 1.2,
    poly: values.get('organ.polyPercEnable') !== 0,
  };
}

/**
 * Whether a new note gets percussion. "Single-triggered": only when no other key of the layer is
 * held; "You have to release all keys to be able to play new notes with the percussion effect"
 * (M p.20). Poly mode triggers it on every stroke. Sustained notes are not held keys.
 */
export function percussionFires(spec: PercussionSpec, heldKeysOnLayer: number): boolean {
  return spec.on && (spec.poly || heldKeysOnLayer === 0);
}

// ── Gate, level, pitch ──────────────────────────────────────────────────────────────────────────

export interface GateTimes {
  readonly attack: number;
  readonly release: number;
}

/** Key gate ramps per model (plan 13.2; guesses): organs switch, pipes speak and die away. */
export function gateTimes(model: OrganModel): GateTimes {
  switch (model) {
    case 'pipe1': return { attack: 0.03, release: 0.12 };
    case 'pipe2': return { attack: 0.06, release: 0.2 };
    case 'b3bass': return { attack: 0.005, release: 0.005 };
    default: return { attack: 0.001, release: 0.005 };
  }
}

/** A layer's level (table 095-7) as a gain; 'volume off' is 0. */
export function layerLevelGain(values: ValueReader, layer: OrganLayer): number {
  const key: Ns4Key = layer === 'A' ? 'organ.layerLevelOrgA' : 'organ.layerLevelOrgB';
  return dbGain(si(values, key, 0));
}

/** Octave shift in semitones: ±12 per step (M p.18); steps ±3…6 have no Stage 4 label but play. */
export function octaveSemitones(values: ValueReader, layer: OrganLayer): number {
  return 12 * clamp(values.get(organKey(layer, '.octaveShift')), -6, 6);
}

export function sustainSwitch(values: ValueReader, layer: OrganLayer): boolean {
  return values.get(organKey(layer, '.sustainEnable')) !== 0;
}

/** The pitch stick bends the whole organ by up to ±2 semitones when switched on (M p.18). */
export function organBendCents(values: ValueReader, bend: number): number {
  if (values.get('organ.orgPStickEnable') === 0) return 0;
  const b = clamp(bend, -8192, 8191);
  return b >= 0 ? (b / 8191) * 200 : (b / 8192) * 200;
}

// ── Rotary speaker (M p.53, 58) ─────────────────────────────────────────────────────────────────

export function rotaryOn(values: ValueReader): boolean {
  return values.get('organ.effectsLeslieEnable') !== 0;
}

export type Rotor = 'horn' | 'drum';

/** Rotor speeds in Hz, the classic speaker's (the Sound menu's "Normal" defaults, M p.58; unverified). */
export const ROTOR_SPEEDS: Readonly<Record<Rotor, { readonly slow: number; readonly fast: number }>> = {
  horn: { slow: 0.83, fast: 6.7 },
  drum: { slow: 0.67, fast: 5.7 },
};

/** Ramp time constants in seconds, up and down (guesses): the light horn follows fast, the drum slowly. */
export const ROTOR_TAU: Readonly<Record<Rotor, { readonly up: number; readonly down: number }>> = {
  horn: { up: 0.3, down: 0.4 },
  drum: { up: 1.5, down: 2.0 },
};

/** The rotor speeds the switches ask for: fast, slow, or with Stop mode and slow, 0 (the rotors stop, M p.53). */
export function rotorTargets(values: ValueReader): Readonly<Record<Rotor, number>> {
  const fast = values.get('organ.effectsLeslieSpeed') !== 0;
  if (!fast && values.get('organ.effectsLeslieStopMode') !== 0) return { horn: 0, drum: 0 };
  return { horn: ROTOR_SPEEDS.horn[fast ? 'fast' : 'slow'], drum: ROTOR_SPEEDS.drum[fast ? 'fast' : 'slow'] };
}

/** The time constant of a speed change from one target to another. */
export function rotorTau(rotor: Rotor, from: number, to: number): number {
  return to >= from ? ROTOR_TAU[rotor].up : ROTOR_TAU[rotor].down;
}

export interface MicSpec {
  /** Peak delay deviation (s) and amplitude modulation depth of each rotor. */
  readonly hornDev: number;
  readonly hornDepth: number;
  readonly drumDev: number;
  readonly drumDepth: number;
}

/** Close Mic (M p.53; value 1 = close, assumed) deepens the modulation. */
export function micSpec(values: ValueReader): MicSpec {
  const close = values.get('organ.leslieMicDistance') !== 0;
  return close
    ? { hornDev: 0.00035, hornDepth: 0.45, drumDev: 0.0001, drumDepth: 0.2 }
    : { hornDev: 0.00025, hornDepth: 0.3, drumDev: 0.0001, drumDepth: 0.15 };
}

/** The rotary drive label 0.0–10.0 (table 105-5). */
export function driveLabel(values: ValueReader): number {
  const v = si(values, 'organ.effectsLeslieDrv', NaN);
  return clamp(Number.isNaN(v) ? (values.get('organ.effectsLeslieDrv') / 127) * 10 : v, 0, 10);
}

/** Drive pre-gain 1 + 0.9 × label; the post-gain is 1/√pre. Label 0 is linear. */
export function drivePreGain(label: number): number {
  return 1 + 0.9 * clamp(label, 0, 10);
}

// ── helpers ─────────────────────────────────────────────────────────────────────────────────────

function si(values: ValueReader, key: Ns4Key, fallback: number): number {
  const label = ns4Label(key, values.get(key), values);
  const parsed = label === null ? null : parseDisplay(label);
  return parsed === null ? fallback : parsed.value;
}

function dbGain(db: number): number {
  return db === -Infinity ? 0 : 10 ** (db / 20);
}
