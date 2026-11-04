/**
 * The files box's new logic (plan sections 15.3 and 15.8), without the DOM: the inline delete
 * confirmation, deleting a saved preset, and app presets with own sample references and embedded
 * files (download and import through the page's sample hooks).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PresetExtras } from '../../src/editor/formats/preset.ts';
import type { StorageLike } from '../../src/editor/formats/storage.ts';
import { initProgram } from '../../src/editor/model/init.ts';
import { ParamStore } from '../../src/editor/model/store.ts';
import { SampleAssignments, sampleRef } from '../../src/editor/model/user-samples.ts';
import { deleteQuestion, InlineConfirm } from '../../src/editor/ui/files-model.ts';
import { FileActions, type PresetSamples } from '../../src/editor/ui/files.ts';

class FakeStorage implements StorageLike {
  readonly data = new Map<string, string>();
  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }
  removeItem(key: string): void {
    this.data.delete(key);
  }
}

const HASH = `sha256-${'ab'.repeat(32)}`;

function setup(samples?: PresetSamples, storage: StorageLike = new FakeStorage()): {
  actions: FileActions; store: ParamStore; printed: Array<{ lines: readonly string[]; kind: string }>;
  downloads: Array<{ name: string; data: string | Uint8Array }>;
} {
  const store = new ParamStore(initProgram());
  const printed: Array<{ lines: readonly string[]; kind: string }> = [];
  const downloads: Array<{ name: string; data: string | Uint8Array }> = [];
  const actions = new FileActions({
    store, printout: { print: (lines, kind) => printed.push({ lines, kind }) }, storage,
    appVersion: '0.1.0', download: (name, data) => downloads.push({ name, data }),
    ...(samples === undefined ? {} : { samples }),
  });
  return { actions, store, printed, downloads };
}

test('the inline confirmation asks about one item at a time and deletes only on confirm', () => {
  const ask = new InlineConfirm<{ id: string; name: string }>((x) => x.name);
  assert.equal(ask.pending, null);
  assert.equal(ask.confirm(), null, 'nothing asked, nothing deleted');
  assert.equal(ask.ask({ id: '1', name: 'Warm Pad' }).text, 'delete "Warm Pad"?');
  ask.ask({ id: '2', name: 'Bass' });
  assert.equal(ask.pending!.item.id, '2', 'a second delete key replaces the open question');
  ask.cancel();
  assert.equal(ask.confirm(), null);
  ask.ask({ id: '3', name: 'Lead' });
  assert.deepEqual(ask.confirm(), { id: '3', name: 'Lead' });
  assert.equal(ask.pending, null);
  assert.equal(deleteQuestion('pad.wav'), 'delete "pad.wav"?');
});

test('a saved preset can be deleted; the working copy stays', () => {
  const { actions, store, printed } = setup();
  store.setName('Warm Pad');
  const slot = actions.save()!;
  actions.autosaveNow();
  assert.equal((actions.slots() as { slots: unknown[] }).slots.length, 1);
  assert.ok(actions.removeSlot(slot));
  assert.deepEqual(actions.slots(), { slots: [] });
  assert.equal(printed.at(-1)!.lines[0], 'app preset "Warm Pad" deleted from this browser');
  assert.ok(actions.restoreWorkingCopy(), 'the working copy is not a slot');
});

test('a download carries the sample references, and the files only with embed on', async () => {
  const asked: boolean[] = [];
  const hooks: PresetSamples = {
    extras: async (embed) => {
      asked.push(embed);
      const embedded = new Map(embed ? [[HASH, { name: 'pad.wav', mime: 'audio/wav', bytesBase64: 'AAAA' }]] : []);
      return { samples: { B: sampleRef(HASH, 'pad.wav') }, embedded };
    },
    apply: async () => [],
    clear: () => undefined,
  };
  const { actions, downloads, printed } = setup(hooks);
  await actions.downloadPreset();
  const plain = JSON.parse(downloads[0]!.data as string) as Record<string, unknown>;
  assert.deepEqual(Object.keys(plain['userSamples'] as object), ['B']);
  assert.equal(plain['embeddedSamples'], undefined);
  await actions.downloadPreset(true);
  assert.deepEqual(asked, [false, true]);
  const embedded = JSON.parse(downloads[1]!.data as string) as Record<string, unknown>;
  // The writer (formats/preset.ts) embeds only files an assignment uses.
  assert.ok(embedded['embeddedSamples'] === undefined || HASH in (embedded['embeddedSamples'] as object));
  assert.ok(/^app preset downloaded: /.test(printed.at(-1)!.lines[0]!), printed.at(-1)!.lines[0]!);
});

test('a download with embed on: the hook\'s notes are printed; a failing hook keeps the references', async () => {
  const refs = { B: sampleRef(HASH, 'pad.wav') };
  const noted: PresetSamples = {
    extras: async () => ({ samples: refs, embedded: new Map(), notes: ['layer b: own sample "pad.wav" is not on this device'] }),
    apply: async () => [],
    clear: () => undefined,
    current: () => refs,
  };
  const a = setup(noted);
  await a.actions.downloadPreset(true);
  assert.ok(a.printed.at(-1)!.lines.includes('layer b: own sample "pad.wav" is not on this device'));
  const failing: PresetSamples = { ...noted, extras: async () => { throw new Error('the database connection is closing'); } };
  const b = setup(failing);
  await b.actions.downloadPreset(true);
  const doc = JSON.parse(b.downloads[0]!.data as string) as Record<string, unknown>;
  assert.deepEqual(Object.keys(doc['userSamples'] as object), ['B'], 'the assignments stay in the file');
  assert.ok(b.printed.at(-1)!.lines.includes('own samples not embedded: the database connection is closing'));
});

test('a download that would exceed the 48 MB import limit keeps the references and drops the files', async () => {
  const refs = { A: sampleRef(HASH, 'big.wav') };
  const hooks: PresetSamples = {
    extras: async () => ({ samples: refs,
      embedded: new Map([[HASH, { name: 'big.wav', mime: 'audio/wav', bytesBase64: 'A'.repeat(48 * 1024 * 1024) }]]) }),
    apply: async () => [],
    clear: () => undefined,
    current: () => refs,
  };
  const { actions, downloads, printed } = setup(hooks);
  await actions.downloadPreset(true);
  const text = downloads[0]!.data as string;
  assert.ok(text.length < 1024 * 1024, 'no file the import would refuse');
  const doc = JSON.parse(text) as Record<string, unknown>;
  assert.equal(doc['embeddedSamples'], undefined);
  assert.deepEqual(Object.keys(doc['userSamples'] as object), ['A']);
  assert.ok(printed.at(-1)!.lines.some((l) => /not embedded: the preset would be larger than 48 MB/.test(l)));
});

test('an import hands its extras to the page and prints their notes; a .ns4p clears the assignments', async () => {
  const applied: PresetExtras[] = [];
  let cleared = 0;
  const hooks: PresetSamples = {
    extras: async () => ({ samples: { A: sampleRef(HASH, 'pad.wav') }, embedded: new Map() }),
    apply: async (x) => {
      applied.push(x);
      return ['layer a: own sample "pad.wav" is not on this device: import the file again or load the preset that embeds it'];
    },
    clear: () => { cleared += 1; },
  };
  const first = setup(hooks);
  await first.actions.downloadPreset();
  const text = first.downloads[0]!.data as string;
  const second = setup(hooks);
  const bytes = new TextEncoder().encode(text);
  const ok = await second.actions.importPreset({ name: 'p.json', size: bytes.length,
    arrayBuffer: async () => bytes.buffer.slice(0) as ArrayBuffer });
  assert.ok(ok);
  assert.equal(applied.length, 1);
  assert.equal(applied[0]!.samples.A?.hash, HASH);
  assert.ok(second.printed.at(-1)!.lines.some((l) => /not on this device/.test(l)));
  assert.equal(cleared, 0);
  const big = { name: 'big.json', size: 2 * 1024 * 1024, arrayBuffer: async () => new TextEncoder().encode(' '.repeat(10)).buffer as ArrayBuffer };
  assert.equal(await second.actions.importPreset(big), false, 'over 1 MB without embedded samples is refused');
  assert.ok(/larger than 1 MB/.test(second.printed.at(-1)!.lines[0]!), second.printed.at(-1)!.lines[0]!);
});

/** Page-like sample hooks over a plain assignments object, as main.ts wires them. */
function pageSamples(): { hooks: PresetSamples; assignments: SampleAssignments; applied: PresetExtras[] } {
  const assignments = new SampleAssignments();
  const applied: PresetExtras[] = [];
  const hooks: PresetSamples = {
    extras: async () => ({ samples: assignments.all(), embedded: new Map() }),
    apply: async (x) => {
      applied.push(x);
      assignments.load(x.samples);
      return [];
    },
    clear: () => assignments.load({}),
    current: () => assignments.all(),
    onChange: (fn) => assignments.onChange(() => fn()),
  };
  return { hooks, assignments, applied };
}

test('a saved slot keeps the own sample assignments and loading it restores them', async () => {
  const storage = new FakeStorage();
  const first = pageSamples();
  const a = setup(first.hooks, storage);
  first.assignments.set('B', sampleRef(HASH, 'pad.wav'));
  a.store.setName('Warm Pad');
  const slot = a.actions.save()!;
  first.assignments.load({});
  assert.ok(a.actions.loadSlot(slot));
  await Promise.resolve();
  assert.equal(first.assignments.get('B')?.hash, HASH);
  assert.equal(first.applied.length, 1);
  assert.deepEqual(first.applied[0]!.embedded.size, 0, 'browser slots never carry files');
});

test('the working copy keeps the assignments across a reload, and an assignment change autosaves', async () => {
  const storage = new FakeStorage();
  const before = pageSamples();
  const a = setup(before.hooks, storage);
  const off = a.actions.watchStore();
  before.assignments.set('A', sampleRef(HASH, 'pad.wav'));
  // The change scheduled an autosave; write it now as a page hide would.
  a.actions.autosaveNow();
  off();
  a.actions.dispose();

  const after = pageSamples();
  const b = setup(after.hooks, storage);
  assert.ok(b.actions.restoreWorkingCopy());
  await Promise.resolve();
  assert.equal(after.assignments.get('A')?.hash, HASH);
  assert.equal(after.assignments.get('A')?.name, 'pad.wav');
});

test('an assignment change alone schedules the autosave', async () => {
  const storage = new FakeStorage();
  const page = pageSamples();
  const store = new ParamStore(initProgram());
  const actions = new FileActions({
    store, printout: { print: () => undefined }, storage, appVersion: '0.1.0', autosaveDelay: 0, samples: page.hooks,
  });
  const off = actions.watchStore();
  page.assignments.set('C', sampleRef(HASH, 'pad.wav'));
  await new Promise((r) => setTimeout(r, 5));
  off();
  const text = storage.getItem('ns4-editor:v1:working');
  assert.ok(text !== null && text.includes(HASH), 'working copy written with the reference');
  actions.dispose();
});
