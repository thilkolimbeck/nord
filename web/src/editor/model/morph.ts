/**
 * Morphs (manual p.38–39, plan section 15.2): 119 fields carry three morph amounts each, one per
 * source: the modulation wheel, aftertouch and the control pedal. The editor reads an amount as a
 * signed delta in the field's stored steps (unverified, marked nv): with every source at its
 * position p in 0..1,
 *
 *   effective = clamp(round(base + Σ amount_source × p_source), field min, field max)
 *
 * The wheel position is CC1 / 127 (or the on-screen wheel), aftertouch channel pressure / 127,
 * the control pedal CC11 / 127 (p.56). At rest every source is 0 and every field plays its stored
 * value. The organ rotary speed (a switch with a morph of -1..1) is the one field whose morph is
 * continuous (p.53, "speeds other than just fast, slow or stopped"): `fraction` gives it unrounded.
 *
 * MorphedValues wraps the store as the ValueReader every engine reads, so the sound follows the
 * effective values without any mapping code knowing about morphs. Moving a source yields Change
 * records with origin 'morph' for the fields it moves; they go to the engines (router.applyChanges)
 * and never into the store or out over MIDI. Pure: no DOM, no Web Audio.
 */
import { DESCRIPTORS, type Morphs } from './descriptors.ts';
import { NS4_KEYS, type Ns4Key } from './keys.ts';
import type { ValueReader } from './labels.ts';
import type { Change } from './store.ts';

export type MorphSource = 'wheel' | 'afterTouch' | 'ctrlPedal';
export const MORPH_SOURCES: readonly MorphSource[] = ['wheel', 'afterTouch', 'ctrlPedal'];
/** The short names the panel uses (p.38: WHEEL, A.T., CTRLPED). */
export const MORPH_SOURCE_LABELS: Readonly<Record<MorphSource, string>> = {
  wheel: 'wheel', afterTouch: 'a.t.', ctrlPedal: 'ctrl ped',
};

/** The play bus names the same three controllers (input/events.ts PlayEvent 'controller'). */
export type ControllerKind = 'wheel' | 'pressure' | 'pedal';
export const SOURCE_OF_CONTROLLER: Readonly<Record<ControllerKind, MorphSource>> = {
  wheel: 'wheel', pressure: 'afterTouch', pedal: 'ctrlPedal',
};

/** Each source's position, 0 (rest: wheel down, no pressure, pedal heel) … 1 (full). */
export type Positions = Readonly<Record<MorphSource, number>>;
export const REST: Positions = { wheel: 0, afterTouch: 0, ctrlPedal: 0 };

const DESCRIPTOR_KEY: Readonly<Record<MorphSource, keyof Morphs>> = {
  wheel: 'wheel', afterTouch: 'afterTouch', ctrlPedal: 'ctrlPedal',
};

/** A 7-bit controller value (0..127) as a position 0..1. */
export function positionOf(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value / 127));
}

/** The 119 fields with morph amounts, in layout order. */
export const MORPH_PARENTS: readonly Ns4Key[] = NS4_KEYS.filter((k) => DESCRIPTORS.get(k)!.morphs !== null);

const PARENT_SET: ReadonlySet<Ns4Key> = new Set(MORPH_PARENTS);
const TARGETS: ReadonlyMap<Ns4Key, { readonly parent: Ns4Key; readonly source: MorphSource }> = (() => {
  const out = new Map<Ns4Key, { parent: Ns4Key; source: MorphSource }>();
  for (const parent of MORPH_PARENTS) {
    const m = DESCRIPTORS.get(parent)!.morphs!;
    for (const source of MORPH_SOURCES) out.set(m[DESCRIPTOR_KEY[source]], { parent, source });
  }
  return out;
})();

/** Whether a field carries morph amounts. */
export function hasMorphs(key: Ns4Key): boolean {
  return PARENT_SET.has(key);
}

/** The morph amount key of a field for one source; throws for a field without morphs. */
export function morphKey(parent: Ns4Key, source: MorphSource): Ns4Key {
  const m = DESCRIPTORS.get(parent)?.morphs;
  if (m === null || m === undefined) throw new Error(`${parent} has no morphs`);
  return m[DESCRIPTOR_KEY[source]];
}

/** Field and source of a morph amount key; null for every other key. */
export function morphTarget(key: Ns4Key): { readonly parent: Ns4Key; readonly source: MorphSource } | null {
  return TARGETS.get(key) ?? null;
}

/** The range of a field's morph amounts (the layout range of the amount fields, e.g. -127..127). */
export function morphRange(parent: Ns4Key): { readonly min: number; readonly max: number } {
  const d = DESCRIPTORS.get(morphKey(parent, 'wheel'))!;
  return { min: d.min, max: d.max };
}

/** The sources with a non-zero amount on a field. */
export function activeMorphs(values: ValueReader, parent: Ns4Key): MorphSource[] {
  if (!hasMorphs(parent)) return [];
  return MORPH_SOURCES.filter((s) => values.get(morphKey(parent, s)) !== 0);
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

/** Σ amount × position over the sources, unrounded; 0 for fields without morphs. */
export function morphSum(values: ValueReader, parent: Ns4Key, positions: Positions): number {
  if (!hasMorphs(parent)) return 0;
  let sum = 0;
  for (const s of MORPH_SOURCES) {
    const p = positions[s];
    if (p !== 0) sum += values.get(morphKey(parent, s)) * p;
  }
  return sum;
}

/** The effective value, unrounded but clamped to the field (the rotary speed reads it). */
export function effectiveFraction(values: ValueReader, key: Ns4Key, positions: Positions): number {
  const base = values.get(key);
  if (!hasMorphs(key)) return base;
  const d = DESCRIPTORS.get(key)!;
  return clamp(base + morphSum(values, key, positions), d.min, d.max);
}

/** The value the field plays at these positions: stored value plus morphs, rounded and clamped. */
export function effectiveValue(values: ValueReader, key: Ns4Key, positions: Positions): number {
  const base = values.get(key);
  if (!hasMorphs(key)) return base;
  const d = DESCRIPTORS.get(key)!;
  return clamp(Math.round(base + morphSum(values, key, positions)), d.min, d.max);
}

/** The value one source reaches at full travel, the others at rest: the morph's end point as the panel shows it (p.38). */
export function morphEnd(values: ValueReader, parent: Ns4Key, source: MorphSource): number {
  return effectiveValue(values, parent, { ...REST, [source]: 1 });
}

/** The amount that makes one source end at `end` (clamped to the amount range), for editing by end point. */
export function amountForEnd(values: ValueReader, parent: Ns4Key, source: MorphSource, end: number): number {
  const d = DESCRIPTORS.get(parent)!;
  const r = morphRange(parent);
  return clamp(Math.round(clamp(end, d.min, d.max) - values.get(parent)), r.min, r.max);
}

/**
 * The store as the engines read it: morph parents return their effective value at the current
 * source positions, every other key its stored value.
 */
export class MorphedValues implements ValueReader {
  readonly #base: ValueReader;
  #positions: Positions;

  constructor(base: ValueReader, positions: Positions = REST) {
    this.#base = base;
    this.#positions = { ...positions };
  }

  get positions(): Positions {
    return this.#positions;
  }

  get(key: Ns4Key): number {
    return effectiveValue(this.#base, key, this.#positions);
  }

  /** The effective value unrounded (clamped): the organ rotary speed between slow and fast. */
  fraction(key: Ns4Key): number {
    return effectiveFraction(this.#base, key, this.#positions);
  }

  /**
   * Move one source to `position` (0..1). Returns one 'morph' change per field with a non-zero
   * amount for that source (value and previous are the rounded effective values; the fraction may
   * change without them), so the engines re-read those fields. Empty when nothing moves.
   */
  move(source: MorphSource, position: number): Change[] {
    const p = Math.min(1, Math.max(0, Number.isFinite(position) ? position : 0));
    if (p === this.#positions[source]) return [];
    const before = this.#positions;
    this.#positions = { ...before, [source]: p };
    const out: Change[] = [];
    for (const parent of MORPH_PARENTS) {
      if (this.#base.get(morphKey(parent, source)) === 0) continue;
      out.push({
        key: parent, value: effectiveValue(this.#base, parent, this.#positions),
        previous: effectiveValue(this.#base, parent, before), origin: 'morph',
      });
    }
    return out;
  }

  /** Every source back to rest (panic: "reset incoming CC messages", p.56). */
  rest(): Change[] {
    return MORPH_SOURCES.flatMap((s) => this.move(s, 0));
  }

  /**
   * A store batch as the engines need it: unchanged, plus, for every morph amount that changed
   * while its source is off rest, a 'morph' change of its field (the amount itself drives no
   * audio parameter). Load and init batches pass unchanged: the engines reload everything.
   */
  expand(batch: readonly Change[]): readonly Change[] {
    if (batch.some((c) => c.origin === 'load' || c.origin === 'init')) return batch;
    const extra: Change[] = [];
    const seen = new Set<Ns4Key>();
    for (const c of batch) {
      const t = morphTarget(c.key);
      if (t === null || this.#positions[t.source] === 0 || seen.has(t.parent)) continue;
      seen.add(t.parent);
      extra.push({ key: t.parent, value: this.get(t.parent), previous: this.get(t.parent), origin: 'morph' });
    }
    return extra.length === 0 ? batch : [...batch, ...extra];
  }
}
