/**
 * The editor's central state: the value of every Stage 4 field plus the program's name, category
 * and source file. Every write is clamped to the field (descriptors.ts clampValue), so the store
 * never holds a value the Stage 4 writer would refuse. Listeners subscribe per key, to every
 * batch or to name edits; a load replaces all values in one batch. No DOM, no Web Audio.
 */
import { clampValue, DESCRIPTORS } from './descriptors.ts';
import { NS4_KEYS, type Ns4Key } from './keys.ts';
import type { ValueReader } from './labels.ts';

/** Where a stored change came from: a control, MIDI, a file load, the init program, or a follow-up of another edit. */
export type StoreOrigin = 'ui' | 'midi' | 'load' | 'init' | 'derived';
/**
 * Where a change came from. 'morph' is never written to the store: a morph source (wheel,
 * aftertouch, control pedal) moved and a field's effective value changed (model/morph.ts,
 * plan section 15.2). Such changes reach the engines only; the MIDI output never sends them.
 */
export type Origin = StoreOrigin | 'morph';

export interface Change {
  readonly key: Ns4Key;
  readonly value: number;
  readonly previous: number;
  readonly origin: Origin;
}

/** The imported program file, kept as the export donor (plan section 11, decision 3). */
export interface SourceProgram {
  readonly kind: 'ns4p';
  readonly fileName: string;
  readonly formatVersion: number;
  readonly bytes: Uint8Array;
}

export interface ProgramSnapshot {
  readonly name: string;
  readonly category: number;
  /** All 955 fields. */
  readonly values: Readonly<Record<Ns4Key, number>>;
  readonly source: SourceProgram | null;
}

export type Entry = readonly [Ns4Key, number] | readonly [Ns4Key, number, StoreOrigin];

function copySource(source: SourceProgram | null): SourceProgram | null {
  return source === null ? null : { ...source, bytes: Uint8Array.from(source.bytes) };
}

export class ParamStore implements ValueReader {
  readonly #values = new Map<Ns4Key, number>();
  readonly #keyListeners = new Map<Ns4Key, Set<(value: number, change: Change) => void>>();
  readonly #batchListeners = new Set<(batch: readonly Change[]) => void>();
  readonly #nameListeners = new Set<(name: string) => void>();
  #name = '';
  #category = 0;
  #source: SourceProgram | null = null;
  #dirty = false;

  constructor(initial: ProgramSnapshot) {
    this.#replace(initial);
  }

  get(key: Ns4Key): number {
    const value = this.#values.get(key);
    if (value === undefined) throw new Error(`no Stage 4 field '${key}'`);
    return value;
  }

  /** Clamp and store one value; returns the value stored. No change, no notification. */
  set(key: Ns4Key, value: number, origin: StoreOrigin = 'ui'): number {
    this.setMany([[key, value]], origin);
    return this.get(key);
  }

  /** Clamp and store several values as one batch; an entry may carry its own origin ('derived'). */
  setMany(entries: readonly Entry[], origin: StoreOrigin): void {
    const batch: Change[] = [];
    for (const entry of entries) {
      const key = entry[0];
      const previous = this.get(key);
      const value = clampValue(DESCRIPTORS.get(key)!, entry[1]);
      if (value === previous) continue;
      this.#values.set(key, value);
      batch.push({ key, value, previous, origin: entry[2] ?? origin });
    }
    if (batch.length === 0) return;
    this.#dirty = true;
    this.#emit(batch);
  }

  /** Replace every value, the name, category and source (a file load or the init program); one batch. */
  load(snapshot: ProgramSnapshot, origin: 'load' | 'init'): void {
    const previous = new Map(this.#values);
    this.#replace(snapshot);
    const batch: Change[] = NS4_KEYS.map((key) => ({ key, value: this.#values.get(key)!, previous: previous.get(key)!, origin }));
    this.#emit(batch);
  }

  /** A deep copy of the whole state; load() restores it. */
  snapshot(): ProgramSnapshot {
    const values = {} as Record<Ns4Key, number>;
    for (const key of NS4_KEYS) values[key] = this.#values.get(key)!;
    return { name: this.#name, category: this.#category, values, source: copySource(this.#source) };
  }

  /** Store the program name; a change notifies the name listeners (no value batch). */
  setName(name: string): void {
    if (name === this.#name) return;
    this.#name = name;
    this.#dirty = true;
    const errors: unknown[] = [];
    for (const fn of [...this.#nameListeners]) {
      try { fn(name); } catch (err) { errors.push(err); }
    }
    if (errors.length > 0) throw errors[0];
  }

  get meta(): Readonly<Pick<ProgramSnapshot, 'name' | 'category' | 'source'>> {
    return { name: this.#name, category: this.#category, source: this.#source };
  }

  /** Whether anything changed since the last load. */
  get dirty(): boolean {
    return this.#dirty;
  }

  /** Call `fn` with the new value whenever `key` changes; returns the unsubscribe function. */
  subscribe(key: Ns4Key, fn: (value: number, change: Change) => void): () => void {
    this.get(key);
    let set = this.#keyListeners.get(key);
    if (set === undefined) {
      set = new Set();
      this.#keyListeners.set(key, set);
    }
    set.add(fn);
    return () => { set.delete(fn); };
  }

  /** Call `fn` with every batch of changes; returns the unsubscribe function. */
  onChange(fn: (batch: readonly Change[]) => void): () => void {
    this.#batchListeners.add(fn);
    return () => { this.#batchListeners.delete(fn); };
  }

  /** Call `fn` with the new name whenever setName() changes it (a load reports through onChange); returns the unsubscribe function. */
  onNameChange(fn: (name: string) => void): () => void {
    this.#nameListeners.add(fn);
    return () => { this.#nameListeners.delete(fn); };
  }

  #replace(snapshot: ProgramSnapshot): void {
    const next = new Map<Ns4Key, number>();
    for (const key of NS4_KEYS) {
      if (!Object.hasOwn(snapshot.values, key)) throw new Error(`snapshot has no value for '${key}'`);
      next.set(key, clampValue(DESCRIPTORS.get(key)!, snapshot.values[key]));
    }
    for (const key of Object.keys(snapshot.values)) {
      if (!next.has(key as Ns4Key)) throw new Error(`snapshot has an unknown field '${key}'`);
    }
    for (const [key, value] of next) this.#values.set(key, value);
    this.#name = snapshot.name;
    this.#category = snapshot.category;
    this.#source = copySource(snapshot.source);
    this.#dirty = false;
  }

  /** Key listeners first, then batch listeners; one failing listener does not stop the others. */
  #emit(batch: readonly Change[]): void {
    const errors: unknown[] = [];
    const call = (fn: () => void): void => {
      try { fn(); } catch (err) { errors.push(err); }
    };
    for (const change of batch) {
      const set = this.#keyListeners.get(change.key);
      if (set !== undefined) for (const fn of [...set]) call(() => fn(change.value, change));
    }
    for (const fn of [...this.#batchListeners]) call(() => fn(batch));
    if (errors.length > 0) throw errors[0];
  }
}
