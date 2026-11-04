/**
 * Own samples as the page manages them (plan sections 15.3 and 15.9), on a fake store and a fake
 * decoder: import decodes before storing, the buffers reach the sound engine, assignments and their
 * root and loop, delete, missing samples, embedding and storing embedded files; and the texts of
 * the samples list and the layer's readout.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  type EmbeddedSample, MAX_SAMPLE_BYTES, type SampleMeta, type SampleStore, type SampleUsage,
} from '../../src/editor/formats/samples-db.ts';
import { initProgram } from '../../src/editor/model/init.ts';
import { ParamStore } from '../../src/editor/model/store.ts';
import { SampleAssignments, type SampleHash, type SampleInfo } from '../../src/editor/model/user-samples.ts';
import {
  missingNote, noteName, OwnSamples, sampleLine, secondsText, usageLine,
} from '../../src/editor/ui/own-samples.ts';
import { LONGEST_NORD_TEXT, nordSampleText, samplesMode } from '../../src/editor/ui/sample-layer.ts';
import { SAMPLE_NAMES } from '../../src/ns4/generated/tables-ns4.ts';

const INFO: SampleInfo = { sampleRate: 44100, channels: 2, frames: 88200, seconds: 2, attackEnd: 0.01 };

function hashOf(bytes: ArrayBuffer): SampleHash {
  const first = new Uint8Array(bytes)[0] ?? 0;
  return `sha256-${first.toString(16).padStart(2, '0').repeat(32)}`;
}

class FakeStore implements SampleStore {
  readonly files = new Map<SampleHash, { meta: SampleMeta; bytes: ArrayBuffer }>();
  async put(file: { name: string; mime: string; bytes: ArrayBuffer }, decoded: SampleInfo): Promise<SampleMeta> {
    const hash = hashOf(file.bytes);
    const known = this.files.get(hash);
    if (known !== undefined) return known.meta;
    const meta: SampleMeta = { ...decoded, hash, name: file.name, mime: file.mime, bytes: file.bytes.byteLength,
      added: '2026-11-04T00:00:00.000Z' };
    this.files.set(hash, { meta, bytes: file.bytes });
    return meta;
  }
  async get(hash: SampleHash): Promise<{ meta: SampleMeta; bytes: ArrayBuffer } | null> {
    return this.files.get(hash) ?? null;
  }
  async list(): Promise<SampleMeta[]> {
    return [...this.files.values()].map((f) => f.meta).reverse();
  }
  async delete(hash: SampleHash): Promise<void> {
    this.files.delete(hash);
  }
  async usage(): Promise<SampleUsage> {
    const list = [...this.files.values()];
    return { count: list.length, bytes: list.reduce((n, f) => n + f.meta.bytes, 0), originUsage: null, originQuota: null };
  }
}

function file(first: number, name: string, size = 1000): { name: string; size: number; type: string; arrayBuffer(): Promise<ArrayBuffer> } {
  const bytes = new Uint8Array(size);
  bytes[0] = first;
  return { name, size, type: 'audio/wav', arrayBuffer: async () => bytes.buffer };
}

function setup(opts: { decodeFails?: boolean; openFails?: boolean } = {}): {
  own: OwnSamples; store: FakeStore; assignments: SampleAssignments; buffers: Map<SampleHash, unknown>; decoded: number[];
} {
  const store = new FakeStore();
  const assignments = new SampleAssignments();
  const buffers = new Map<SampleHash, unknown>();
  const decoded: number[] = [];
  const own = new OwnSamples({
    open: async () => {
      if (opts.openFails === true) throw new Error('this browser keeps no sample storage here');
      return store;
    },
    decode: async (bytes) => {
      decoded.push(bytes.byteLength);
      if (opts.decodeFails === true) throw new Error('this browser cannot decode the file as audio');
      return { buffer: { length: bytes.byteLength } as unknown as AudioBuffer, info: INFO };
    },
    assignments,
    sink: { setBuffer: (hash, buffer) => { if (buffer === null) buffers.delete(hash); else buffers.set(hash, buffer); } },
  });
  return { own, store, assignments, buffers, decoded };
}

test('import decodes first, stores the file once by hash and hands the buffer to the sound engine', async () => {
  const { own, store, buffers } = setup();
  const r = await own.import(file(1, 'pad.wav'));
  assert.ok(r.ok, r.message);
  assert.equal(r.message, 'own sample stored on this device: pad.wav · 2.0 s · 1000 B');
  assert.equal(store.files.size, 1);
  assert.equal(buffers.size, 1);
  await own.import(file(1, 'pad copy.wav'));
  assert.equal(store.files.size, 1, 'the same content is one sample');
  assert.equal(own.list.length, 1);
  assert.deepEqual(own.usage, { count: 1, bytes: 1000, originUsage: null, originQuota: null });
});

test('a file the browser cannot decode is not stored; a file over the limit is refused unread', async () => {
  const bad = setup({ decodeFails: true });
  const r = await bad.own.import(file(2, 'notes.txt'));
  assert.deepEqual([r.ok, r.message], [false, 'notes.txt: this browser cannot decode the file as audio']);
  assert.equal(bad.store.files.size, 0);
  const big = setup();
  const r2 = await big.own.import({ ...file(3, 'huge.wav'), size: MAX_SAMPLE_BYTES + 1 });
  assert.ok(!r2.ok);
  assert.ok(/larger than 32 MB/.test(r2.message), r2.message);
  assert.deepEqual(big.decoded, []);
});

test('no sample storage: the state says why, imports say it too', async () => {
  const { own } = setup({ openFails: true });
  await own.open();
  assert.deepEqual(own.state, { kind: 'unavailable', message: 'this browser keeps no sample storage here' });
  const r = await own.import(file(4, 'a.wav'));
  assert.equal(r.message, 'a.wav: this browser keeps no sample storage here');
});

test('assign, root and loop; loop end 0 is the end of the file and never before the start', async () => {
  const { own, assignments } = setup();
  const { meta } = await own.import(file(5, 'loop.wav'));
  own.assign('B', meta!.hash);
  assert.deepEqual(assignments.get('B'), { hash: meta!.hash, name: 'loop.wav', root: 60, loop: 'one-shot', loopStart: 0, loopEnd: 0 });
  own.update('B', { root: 48, loop: 'loop', loopStart: 0.5, loopEnd: 1.5 });
  assert.deepEqual([assignments.get('B')!.root, assignments.get('B')!.loop, assignments.get('B')!.loopEnd], [48, 'loop', 1.5]);
  own.update('B', { loopStart: 1.6 });
  assert.equal(assignments.get('B')!.loopEnd, 0, 'an end before the start becomes the end of the file');
  own.assign('B', meta!.hash);
  assert.equal(assignments.get('B')!.root, 48, 'picking the same sample keeps root and loop');
  assert.deepEqual(own.usersOf(meta!.hash), ['B']);
  own.assign('B', null);
  assert.equal(assignments.get('B'), null);
});

test('delete: the buffer goes, layers that used it fall silent with a note', async () => {
  const { own, buffers } = setup();
  const { meta } = await own.import(file(6, 'hit.wav'));
  own.assign('C', meta!.hash);
  const r = await own.remove(meta!.hash);
  assert.deepEqual([r.ok, r.message], [true, 'own sample deleted from this device: hit.wav; layer c now silent']);
  assert.equal(buffers.size, 0);
  assert.deepEqual(own.missingNotes(), [missingNote('C', { name: 'hit.wav' })]);
  assert.equal(missingNote('C', { name: 'hit.wav' }),
    'layer c: own sample "hit.wav" is not on this device: import the file again or load the preset that embeds it');
});

test('loaded assignments get their buffers from the store; embedded files are stored and counted', async () => {
  const { own, store, assignments, buffers } = setup();
  const { meta } = await own.import(file(7, 'keys.wav'));
  // A fresh page: the buffer is not loaded until an assignment needs it.
  const fresh = setup();
  for (const [h, f] of store.files) fresh.store.files.set(h, f);
  fresh.assignments.load({ A: { hash: meta!.hash, name: 'keys.wav', root: 60, loop: 'one-shot', loopStart: 0, loopEnd: 0 } });
  await fresh.own.open();
  assert.ok(fresh.buffers.has(meta!.hash));
  // Embedding: only assigned samples, as base64.
  own.assign('A', meta!.hash);
  const { embedded, notes: embedNotes } = await own.embedded();
  assert.deepEqual(embedNotes, []);
  assert.deepEqual([...embedded.keys()], [meta!.hash]);
  assert.equal(embedded.get(meta!.hash)!.name, 'keys.wav');
  // Storing embedded files on another device.
  const other = setup();
  const notes = await other.own.storeEmbedded(embedded as ReadonlyMap<SampleHash, EmbeddedSample>);
  assert.deepEqual(notes, ['1 own sample stored on this device']);
  assert.equal(other.store.files.size, 1);
  assert.equal(other.own.list[0]!.name, 'keys.wav');
  void assignments;
  void buffers;
});

test('texts: list lines, the total line, note names, the nord sample readout', () => {
  assert.equal(sampleLine({ name: 'pad.wav', seconds: 3.24, bytes: 812 * 1024 }), 'pad.wav · 3.2 s · 812 KB');
  assert.equal(secondsText(58.4), '58 s');
  assert.equal(usageLine({ count: 2, bytes: 3.4 * 1024 * 1024 }), '2 own samples · 3.4 MB · kept only in this browser, never uploaded');
  assert.equal(usageLine({ count: 1, bytes: 10 }), '1 own sample · 10 B · kept only in this browser, never uploaded');
  assert.deepEqual([0, 60, 61, 127].map(noteName), ['C-1', 'C4', 'C#4', 'G9']);
  assert.equal(nordSampleText(84103840), 'nord sample: Oboe Multi_ST 4.1 (not available)');
  assert.equal(nordSampleText(1), 'nord sample: not decoded');
  const s = new ParamStore(initProgram());
  assert.ok(!samplesMode(s, 'A'));
  s.set('synthA.mode', 0);
  assert.ok(samplesMode(s, 'A'));
});

test('embedding notes every assigned sample it cannot embed: not on this device, or no storage here', async () => {
  const { own, assignments } = setup();
  assert.deepEqual(await own.embedded(), { embedded: new Map(), notes: [] }, 'nothing assigned: nothing to note');
  assignments.load({ B: { hash: `sha256-${'cd'.repeat(32)}`, name: 'gone.wav', root: 60, loop: 'one-shot', loopStart: 0, loopEnd: 0 } });
  const missing = await own.embedded();
  assert.equal(missing.embedded.size, 0);
  assert.deepEqual(missing.notes, [missingNote('B', { name: 'gone.wav' })]);
  const blocked = setup({ openFails: true });
  blocked.assignments.load({ A: { hash: `sha256-${'ef'.repeat(32)}`, name: 'pad.wav', root: 60, loop: 'one-shot', loopStart: 0, loopEnd: 0 } });
  const none = await blocked.own.embedded();
  assert.deepEqual(none.notes, ['layer a: own sample "pad.wav" not embedded: this browser keeps no sample storage here']);
});

test('a stored sample that cannot be decoded here says why; loading and missing samples have no failure note', async () => {
  const ok = setup();
  const { meta } = await ok.own.import(file(9, 'odd.wav'));
  const broken = setup({ decodeFails: true });
  for (const [h, f] of ok.store.files) broken.store.files.set(h, f);
  const ref = { hash: meta!.hash, name: 'odd.wav', root: 60, loop: 'one-shot', loopStart: 0, loopEnd: 0 } as const;
  broken.assignments.load({ A: ref, B: { ...ref, hash: `sha256-${'cd'.repeat(32)}`, name: 'gone.wav' } });
  assert.equal(broken.own.failedNote('A'), null, 'not tried yet: loading');
  await broken.own.open();
  assert.equal(broken.own.failedNote('A'), 'own sample "odd.wav" does not play here: this browser cannot decode the file as audio');
  assert.equal(broken.own.failedNote('B'), null, 'not on this device: the missing note says so');
  assert.equal(broken.own.failedNote('C'), null, 'no assignment');
  ok.own.assign('A', meta!.hash);
  await ok.own.loadAssigned();
  assert.equal(ok.own.failedNote('A'), null, 'it plays');
});

test('the nord sample readout reserves the longest text any program can show', () => {
  const texts = [nordSampleText(1), ...Object.keys(SAMPLE_NAMES).map((k) => nordSampleText(Number(k)))];
  for (const t of texts) assert.ok(t.length <= LONGEST_NORD_TEXT.length, t);
  assert.ok(texts.includes(LONGEST_NORD_TEXT));
});
