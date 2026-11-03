/**
 * App presets in the browser's storage (plan section 5.1): named slots plus an autosaved working
 * copy, kept apart (plan section 11, decision 7). Keys:
 *
 *     ns4-editor:v1:index        JSON list of slots: id, name, savedAt (ISO date)
 *     ns4-editor:v1:slot:<id>    the slot's preset JSON (preset.ts)
 *     ns4-editor:v1:working      the working copy's preset JSON
 *
 * Storage can be missing, blocked (private modes, site data off) or full. Every access sits in a
 * try/catch: slot operations throw a StorageError with a readable message, the working copy
 * reports failure by its return value, and nothing here touches the editor's state, so downloads
 * keep working whatever the storage does. The caller passes the Storage object (or null), so this
 * module stays free of browser globals.
 */
import type { ProgramSnapshot } from '../model/store.ts';
import { parsePreset, toPresetJson } from './preset.ts';

/** The part of the Web Storage API used here; window.localStorage satisfies it. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface SlotInfo {
  readonly id: string;
  readonly name: string;
  /** ISO 8601. */
  readonly savedAt: string;
}

export type StorageProblem = 'unavailable' | 'blocked' | 'full' | 'missing' | 'corrupt';

const MESSAGES: Readonly<Record<StorageProblem, string>> = {
  unavailable: 'browser storage is not available here; download the app preset to keep it',
  blocked: 'browser storage is blocked; download the app preset to keep it',
  full: 'browser storage is full; download the app preset to keep it, or remove saved presets',
  missing: 'this saved preset is no longer in browser storage',
  corrupt: 'the saved presets list in browser storage is unreadable',
};

export class StorageError extends Error {
  override name = 'StorageError';
  readonly problem: StorageProblem;

  constructor(problem: StorageProblem) {
    super(MESSAGES[problem]);
    this.problem = problem;
  }
}

export const PREFIX = 'ns4-editor:v1:';
export const INDEX_KEY = `${PREFIX}index`;
export const WORKING_KEY = `${PREFIX}working`;
export function slotKey(id: string): string {
  return `${PREFIX}slot:${id}`;
}

/** The error a storage call threw, as a problem: quota errors are 'full', the rest 'blocked'. */
export function problemOf(err: unknown): StorageProblem {
  const e = err as { name?: unknown; code?: unknown } | null;
  const name = typeof e?.name === 'string' ? e.name : '';
  if (name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED' || e?.code === 22) return 'full';
  return 'blocked';
}

function isSlot(v: unknown): v is SlotInfo {
  const s = v as Record<string, unknown> | null;
  return typeof s === 'object' && s !== null && typeof s['id'] === 'string' && typeof s['name'] === 'string'
    && typeof s['savedAt'] === 'string';
}

export class PresetSlots {
  readonly #storage: StorageLike | null;
  readonly #appVersion: string;
  readonly #now: () => Date;

  constructor(storage: StorageLike | null, appVersion: string, now: () => Date = () => new Date()) {
    this.#storage = storage;
    this.#appVersion = appVersion;
    this.#now = now;
  }

  /** Whether a storage object was given at all (it may still refuse every call). */
  get available(): boolean {
    return this.#storage !== null;
  }

  #store(): StorageLike {
    if (this.#storage === null) throw new StorageError('unavailable');
    return this.#storage;
  }

  #get(key: string): string | null {
    const storage = this.#store();
    try {
      return storage.getItem(key);
    } catch (err) {
      throw new StorageError(problemOf(err));
    }
  }

  #set(key: string, value: string): void {
    const storage = this.#store();
    try {
      storage.setItem(key, value);
    } catch (err) {
      throw new StorageError(problemOf(err));
    }
  }

  #remove(key: string): void {
    try {
      this.#store().removeItem(key);
    } catch {
      // Nothing to do: a slot that cannot be removed stays, the index decides what is listed.
    }
  }

  #index(): SlotInfo[] {
    const text = this.#get(INDEX_KEY);
    if (text === null) return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new StorageError('corrupt');
    }
    if (!Array.isArray(parsed)) throw new StorageError('corrupt');
    return parsed.filter(isSlot).map((s) => ({ id: s.id, name: s.name, savedAt: s.savedAt }));
  }

  /** Saved slots, newest first; StorageError when storage is unavailable, blocked or the index unreadable. */
  list(): SlotInfo[] {
    return this.#index().sort((a, b) => (a.savedAt < b.savedAt ? 1 : a.savedAt > b.savedAt ? -1 : 0));
  }

  /** Save under `name`; a slot with the same name is replaced. StorageError when it cannot be written. */
  save(name: string, snapshot: ProgramSnapshot): SlotInfo {
    const index = this.#index();
    const existing = index.find((s) => s.name === name);
    const id = existing?.id ?? String(index.reduce((max, s) => Math.max(max, Number.parseInt(s.id, 10) || 0), 0) + 1);
    const info: SlotInfo = { id, name, savedAt: this.#now().toISOString() };
    const previous = existing === undefined ? null : this.#get(slotKey(id));
    this.#set(slotKey(id), toPresetJson(snapshot, this.#appVersion, 0));
    try {
      this.#set(INDEX_KEY, JSON.stringify([...index.filter((s) => s.id !== id), info]));
    } catch (err) {
      // Keep slot and index consistent: put the old slot back, or drop the orphan.
      if (previous !== null) {
        try { this.#set(slotKey(id), previous); } catch { /* the index still lists the old slot */ }
      } else this.#remove(slotKey(id));
      throw err;
    }
    return info;
  }

  /** The snapshot saved in a slot; StorageError when it is gone, PresetError when it is invalid. */
  load(id: string): ProgramSnapshot {
    const text = this.#get(slotKey(id));
    if (text === null) throw new StorageError('missing');
    return parsePreset(text);
  }

  /** Remove a slot and its index entry. */
  remove(id: string): void {
    const index = this.#index();
    this.#set(INDEX_KEY, JSON.stringify(index.filter((s) => s.id !== id)));
    this.#remove(slotKey(id));
  }

  /** Autosave the working copy; returns the problem instead of throwing, null on success. */
  saveWorkingCopy(snapshot: ProgramSnapshot): StorageProblem | null {
    try {
      this.#set(WORKING_KEY, toPresetJson(snapshot, this.#appVersion, 0));
      return null;
    } catch (err) {
      return err instanceof StorageError ? err.problem : 'blocked';
    }
  }

  /** The autosaved working copy, or null when there is none, it is unreadable or storage refuses. */
  loadWorkingCopy(): ProgramSnapshot | null {
    try {
      const text = this.#get(WORKING_KEY);
      return text === null ? null : parsePreset(text);
    } catch {
      return null;
    }
  }

  clearWorkingCopy(): void {
    if (this.#storage !== null) this.#remove(WORKING_KEY);
  }
}
