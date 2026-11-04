/** App presets in browser storage (plan section 5.1, AC 10): slots, working copy, blocked and full storage. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TEMPLATE_BYTES } from '../../src/ns4/index.ts';
import { initProgram } from '../../src/editor/model/init.ts';
import type { ProgramSnapshot } from '../../src/editor/model/store.ts';
import { importNs4p } from '../../src/editor/formats/ns4p-import.ts';
import { PresetError } from '../../src/editor/formats/preset.ts';
import {
  INDEX_KEY, PresetSlots, problemOf, slotKey, StorageError, type StorageLike, WORKING_KEY,
} from '../../src/editor/formats/storage.ts';
import { ParamStore } from '../../src/editor/model/store.ts';
import { FileActions } from '../../src/editor/ui/files.ts';

class FakeStorage implements StorageLike {
  readonly items = new Map<string, string>();
  /** Total characters allowed (keys and values), like a quota. */
  quota = Infinity;
  blocked = false;
  /** A key whose writes fail with a quota error. */
  failKey: string | null = null;

  #check(): void {
    if (this.blocked) throw Object.assign(new Error('The operation is insecure.'), { name: 'SecurityError' });
  }

  getItem(key: string): string | null {
    this.#check();
    return this.items.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.#check();
    let used = key.length + value.length;
    for (const [k, v] of this.items) if (k !== key) used += k.length + v.length;
    if (used > this.quota || key === this.failKey) throw Object.assign(new Error('quota exceeded'), { name: 'QuotaExceededError' });
    this.items.set(key, value);
  }

  removeItem(key: string): void {
    this.#check();
    this.items.delete(key);
  }
}

function clock(start = Date.UTC(2026, 10, 3, 12, 0)): () => Date {
  let t = start;
  return () => new Date((t += 60_000));
}

function edited(fltFreq: number, name: string): ProgramSnapshot {
  const init = initProgram();
  return { ...init, name, values: { ...init.values, 'synthASound.fltFreq': fltFreq } };
}

function storageError(problem: string) {
  return (err: unknown): boolean => err instanceof StorageError && err.problem === problem;
}

test('save, list and load round trip through a fake Storage', () => {
  const storage = new FakeStorage();
  const slots = new PresetSlots(storage, '0.1.0', clock());
  assert.deepEqual(slots.list(), []);
  const a = slots.save('Pad', edited(10, 'Pad'));
  const imported = importNs4p('Lead.ns4p', TEMPLATE_BYTES).snapshot;
  const b = slots.save('Lead', imported);
  assert.deepEqual([a.id, b.id], ['1', '2']);
  assert.deepEqual(slots.list().map((s) => s.name), ['Lead', 'Pad'], 'newest first');
  assert.deepEqual(slots.load(a.id), edited(10, 'Pad'));
  assert.deepEqual(slots.load(b.id), imported, 'source bytes included');
  assert.ok(storage.items.has(slotKey('1')) && storage.items.has(INDEX_KEY));
  assert.ok(!storage.items.get(slotKey('1'))!.includes('\n'), 'stored on one line');
});

test('saving under an existing name replaces that slot', () => {
  const slots = new PresetSlots(new FakeStorage(), '0.1.0', clock());
  const first = slots.save('Pad', edited(10, 'Pad'));
  const second = slots.save('Pad', edited(20, 'Pad'));
  assert.equal(second.id, first.id);
  assert.equal(slots.list().length, 1);
  assert.equal(slots.load(first.id).values['synthASound.fltFreq'], 20);
  assert.ok(second.savedAt > first.savedAt);
});

test('remove drops slot and index entry; a missing slot is reported', () => {
  const storage = new FakeStorage();
  const slots = new PresetSlots(storage, '0.1.0', clock());
  const a = slots.save('Pad', edited(10, 'Pad'));
  slots.save('Bass', edited(11, 'Bass'));
  slots.remove(a.id);
  assert.deepEqual(slots.list().map((s) => s.name), ['Bass']);
  assert.ok(!storage.items.has(slotKey(a.id)));
  assert.throws(() => slots.load(a.id), storageError('missing'));
  assert.equal(slots.save('Keys', edited(12, 'Keys')).id, '3', 'ids are never reused while higher ones exist');
});

test('the working copy is separate from the named presets', () => {
  const storage = new FakeStorage();
  const slots = new PresetSlots(storage, '0.1.0', clock());
  assert.equal(slots.loadWorkingCopy(), null);
  assert.equal(slots.saveWorkingCopy(edited(33, 'work')), null);
  assert.deepEqual(slots.list(), []);
  assert.deepEqual(slots.loadWorkingCopy(), edited(33, 'work'));
  assert.ok(storage.items.has(WORKING_KEY));
  slots.clearWorkingCopy();
  assert.equal(slots.loadWorkingCopy(), null);
});

test('blocked storage: slot calls throw a readable error, the working copy fails quietly', () => {
  const storage = new FakeStorage();
  const slots = new PresetSlots(storage, '0.1.0', clock());
  slots.save('Pad', edited(10, 'Pad'));
  storage.blocked = true;
  assert.throws(() => slots.list(), storageError('blocked'));
  assert.throws(() => slots.save('Lead', edited(5, 'Lead')), storageError('blocked'));
  assert.throws(() => slots.load('1'), storageError('blocked'));
  assert.throws(() => slots.save('x', initProgram()), /browser storage is blocked; download the app preset to keep it/);
  assert.equal(slots.saveWorkingCopy(initProgram()), 'blocked');
  assert.equal(slots.loadWorkingCopy(), null);
  slots.clearWorkingCopy();
});

test('no storage at all: unavailable, never a crash', () => {
  const slots = new PresetSlots(null, '0.1.0');
  assert.equal(slots.available, false);
  assert.throws(() => slots.list(), storageError('unavailable'));
  assert.throws(() => slots.save('Pad', initProgram()), storageError('unavailable'));
  assert.equal(slots.saveWorkingCopy(initProgram()), 'unavailable');
  assert.equal(slots.loadWorkingCopy(), null);
  slots.clearWorkingCopy();
});

test('full storage: the save is refused and the index stays consistent', () => {
  const storage = new FakeStorage();
  const slots = new PresetSlots(storage, '0.1.0', clock());
  slots.save('Pad', edited(10, 'Pad'));
  const used = [...storage.items].reduce((n, [k, v]) => n + k.length + v.length, 0);
  storage.quota = used + 100;
  assert.throws(() => slots.save('Lead', edited(5, 'Lead')), storageError('full'));
  assert.deepEqual(slots.list().map((s) => s.name), ['Pad']);
  assert.ok(!storage.items.has(slotKey('2')), 'no orphan slot');
  assert.equal(slots.saveWorkingCopy(initProgram()), 'full');

  // The slot is written but the index is not: the old slot comes back, a new one is dropped.
  const tight = new FakeStorage();
  const s2 = new PresetSlots(tight, '0.1.0', clock());
  s2.save('Pad', edited(10, 'Pad'));
  const before = new Map(tight.items);
  tight.failKey = INDEX_KEY;
  assert.throws(() => s2.save('Pad', edited(11, 'Pad')), storageError('full'));
  assert.deepEqual(tight.items, before, 'old slot restored');
  assert.throws(() => s2.save('Bass', edited(12, 'Bass')), storageError('full'));
  assert.deepEqual(tight.items, before, 'new slot dropped');
});

test('quota errors are recognised by name and legacy code', () => {
  assert.equal(problemOf({ name: 'QuotaExceededError' }), 'full');
  assert.equal(problemOf({ name: 'NS_ERROR_DOM_QUOTA_REACHED' }), 'full');
  assert.equal(problemOf({ name: 'Error', code: 22 }), 'full');
  assert.equal(problemOf({ name: 'SecurityError' }), 'blocked');
  assert.equal(problemOf(null), 'blocked');
});

test('corrupt entries: an unreadable index, slot or working copy', () => {
  const storage = new FakeStorage();
  const slots = new PresetSlots(storage, '0.1.0', clock());
  storage.items.set(INDEX_KEY, '{not json');
  assert.throws(() => slots.list(), storageError('corrupt'));
  storage.items.set(INDEX_KEY, JSON.stringify([{ id: '1', name: 'Pad', savedAt: '2026-11-03T12:00:00.000Z' }, { id: 2 }]));
  assert.deepEqual(slots.list().map((s) => s.id), ['1'], 'malformed entries are skipped');
  storage.items.set(slotKey('1'), '{"format":"nord-stage4-editor-preset","schema":9}');
  assert.throws(() => slots.load('1'), (err: unknown) => err instanceof PresetError && /newer editor/.test(err.message));
  storage.items.set(WORKING_KEY, 'garbage');
  assert.equal(slots.loadWorkingCopy(), null);
});

test('a name-only edit schedules the working-copy autosave', async () => {
  const storage = new FakeStorage();
  const store = new ParamStore(initProgram());
  const actions = new FileActions({
    store, storage, appVersion: '0.1.0', autosaveDelay: 0, printout: { print: () => {} },
  });
  const off = actions.watchStore();
  try {
    store.setName('Renamed');
    assert.equal(storage.items.has(WORKING_KEY), false, 'debounced, not written synchronously');
    await new Promise((resolve) => setTimeout(resolve, 5));
    const copy = new PresetSlots(storage, '0.1.0').loadWorkingCopy();
    assert.equal(copy?.name, 'Renamed');
  } finally {
    off();
    actions.dispose();
  }
});
