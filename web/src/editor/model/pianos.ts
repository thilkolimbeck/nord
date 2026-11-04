/**
 * The Stage 4 piano models the editor knows by name (295 hashes from the engine's PIANO_NAMES,
 * read only), sorted into the six piano types of manual p.24 and into sound families, so the
 * piano panel can list them by type and the browser piano can pick a synthesis recipe for each
 * (plan section 13.3). The program stores the type (`piano{X}.bank`) and the model's name hash
 * (`piano{X}.nameHash`) separately; the type of a name is not in any table, so the sorting
 * below is guessed from the names and marked unverified. No Nord sample is used or bundled:
 * the editor synthesizes an approximation per family. Pure: no DOM, no Web Audio.
 */
import { PIANO_NAMES } from '../../ns4/generated/tables-ns4.ts';

/** Piano types in the order of `piano{X}.bank` (table 244-3: Grand, Upright, Electric, Clav, Digital, Misc). */
export type PianoType = 'grand' | 'upright' | 'electric' | 'clav' | 'digital' | 'misc';
export const PIANO_TYPES: readonly PianoType[] = ['grand', 'upright', 'electric', 'clav', 'digital', 'misc'];

/** The synthesis recipe a model gets (plan section 13.3). */
export type PianoFamily =
  | 'grand' | 'upright' | 'fortepiano' | 'electric-grand'
  | 'tine' | 'reed' | 'fm' | 'digital-acoustic' | 'digital-electric'
  | 'clavinet' | 'harpsichord' | 'vibraphone' | 'marimba';

/** Sizes of manual p.24: Sml has no string resonance samples, Med for the middle range, Lrg and XL for all keys. */
export type PianoSize = 'Sml' | 'Med' | 'Lrg' | 'XL';

export interface PianoModel {
  /** The value of `piano{X}.nameHash`. */
  readonly hash: number;
  /** The name as the table has it. */
  readonly name: string;
  /** The name with runs of spaces collapsed, for display. */
  readonly label: string;
  /** Guessed from the name (unverified): the type list the Stage 4 files it under. */
  readonly type: PianoType;
  readonly family: PianoFamily;
  /** From the name's last word; null when the name has none. */
  readonly size: PianoSize | null;
  /** 1-based position among models with the same label (several hashes share a name), in hash order. */
  readonly ordinal: number;
  /** How many models share this label. */
  readonly count: number;
}

/** The family a type plays when the stored name hash is unknown or belongs to another type. */
export const DEFAULT_FAMILY: Readonly<Record<PianoType, PianoFamily>> = {
  grand: 'grand', upright: 'upright', electric: 'tine', clav: 'clavinet', digital: 'fm', misc: 'vibraphone',
};

/**
 * Name rules, first match wins: [pattern, type, family]. Manual p.24: Grand holds acoustic and
 * electric grands, Electric the tine and reed pianos, Clav the clavinets and harpsichords, Digital
 * the digital and layered pianos, Misc everything else.
 */
const RULES: ReadonlyArray<readonly [RegExp, PianoType, PianoFamily]> = [
  [/Clavinet/, 'clav', 'clavinet'],
  [/Harpsi/, 'clav', 'harpsichord'],
  [/Vibraphone/, 'misc', 'vibraphone'],
  [/Marimba/, 'misc', 'marimba'],
  [/Rain Piano/, 'misc', 'upright'],
  [/^(?:MKS20|MK80) A\.Piano|^DigiGrand/, 'digital', 'digital-acoustic'],
  [/^(?:MKS20|MK80) E\.Piano/, 'digital', 'digital-electric'],
  [/^DX|^JD800/, 'digital', 'fm'],
  [/Wurlitzer/, 'electric', 'reed'],
  [/^EP\d|^E[Pp]iano|Ballad EP|Hybrid EP|Silver EP|BlueSwede/, 'electric', 'tine'],
  [/Electric ?Grand|^EGrand/, 'grand', 'electric-grand'],
  [/Upright/, 'upright', 'upright'],
  [/ForteP|Forte Pno/, 'grand', 'fortepiano'],
  [/Grand|Steinway/, 'grand', 'grand'],
];

const SIZE_RE = /\s(Sml|Med|Lrg|XL)$/;

/** Type and family for a piano name (the rules above); null when no rule matches. */
export function classifyPiano(name: string): { readonly type: PianoType; readonly family: PianoFamily } | null {
  for (const [re, type, family] of RULES) if (re.test(name)) return { type, family };
  return null;
}

function compare(a: string, b: string): number {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x < y ? -1 : x > y ? 1 : 0;
}

/** Every known model, by type (PIANO_TYPES order), then label, then hash. */
export const PIANO_MODELS: readonly PianoModel[] = (() => {
  const raw = Object.entries(PIANO_NAMES).map(([hash, name]) => {
    const kind = classifyPiano(name);
    if (kind === null) throw new Error(`piano '${name}' matches no type rule`);
    const label = name.replace(/\s+/g, ' ').trim();
    const size = (SIZE_RE.exec(label)?.[1] ?? null) as PianoSize | null;
    return { hash: Number(hash), name, label, size, ...kind };
  });
  raw.sort((a, b) => PIANO_TYPES.indexOf(a.type) - PIANO_TYPES.indexOf(b.type) || compare(a.label, b.label)
    || a.hash - b.hash);
  const seen = new Map<string, number>();
  const counts = new Map<string, number>();
  for (const m of raw) counts.set(m.label, (counts.get(m.label) ?? 0) + 1);
  return raw.map((m) => {
    const ordinal = (seen.get(m.label) ?? 0) + 1;
    seen.set(m.label, ordinal);
    return { ...m, ordinal, count: counts.get(m.label)! };
  });
})();

const BY_HASH: ReadonlyMap<number, PianoModel> = new Map(PIANO_MODELS.map((m) => [m.hash, m]));

/** The model with this name hash, or null (hash 0, or a piano the table does not know). */
export function pianoModel(hash: number): PianoModel | null {
  return BY_HASH.get(hash) ?? null;
}

/** The models filed under one type, in PIANO_MODELS order. */
export function modelsOfType(type: PianoType): PianoModel[] {
  return PIANO_MODELS.filter((m) => m.type === type);
}

/** The type of a `piano{X}.bank` value; out of range → grand. */
export function pianoType(bank: number): PianoType {
  return PIANO_TYPES[bank] ?? 'grand';
}

/**
 * The family a layer plays: the stored model's family when its type matches the stored bank,
 * else the bank's default family (an unknown hash, hash 0, or a model of another type).
 */
export function pianoFamily(bank: number, hash: number): PianoFamily {
  const type = pianoType(bank);
  const model = pianoModel(hash);
  return model !== null && model.type === type ? model.family : DEFAULT_FAMILY[type];
}
