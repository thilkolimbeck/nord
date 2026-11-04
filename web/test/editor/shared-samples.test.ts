/**
 * Plan section 15.3, the shared parts of own samples (frozen): the content hash, the sample
 * reference an app preset carries and its validation, the per-layer assignments, the store's
 * problem texts and byte formatting. The IndexedDB store itself is builder B3's (samples*.test.ts).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  contentHash, formatBytes, MAX_SAMPLE_BYTES, SAMPLE_PROBLEM_TEXT, SampleStoreError,
} from '../../src/editor/formats/samples-db.ts';
import {
  HASH_RE, layerSamplesJson, parseLayerSamples, parseSampleRef, SampleAssignments, sampleRef,
} from '../../src/editor/model/user-samples.ts';

const H = `sha256-${'ab'.repeat(32)}`;

test('content hash: SHA-256 of the file bytes, as sha256-<hex>', async () => {
  const abc = new TextEncoder().encode('abc');
  const hash = await contentHash(abc);
  assert.equal(hash, 'sha256-ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.ok(HASH_RE.test(hash));
  assert.equal(await contentHash(abc.buffer.slice(0) as ArrayBuffer), hash, 'ArrayBuffer and Uint8Array alike');
});

test('a sample reference: defaults, and validation of every member', () => {
  const ref = sampleRef(H, 'pad.wav');
  assert.deepEqual(ref, { hash: H, name: 'pad.wav', root: 60, loop: 'one-shot', loopStart: 0, loopEnd: 0 });
  assert.deepEqual(parseSampleRef(ref), ref);
  assert.deepEqual(parseSampleRef({ ...ref, loop: 'loop', loopStart: 0.5, loopEnd: 1.25 }),
    { ...ref, loop: 'loop', loopStart: 0.5, loopEnd: 1.25 });
  assert.equal(parseSampleRef({ ...ref, hash: 'md5-x' }), 'hash invalid');
  assert.equal(parseSampleRef({ ...ref, root: 128 }), 'root invalid');
  assert.equal(parseSampleRef({ ...ref, root: 60.5 }), 'root invalid');
  assert.equal(parseSampleRef({ ...ref, loop: 'pingpong' }), 'loop invalid');
  assert.equal(parseSampleRef({ ...ref, loopStart: -1 }), 'loopStart invalid');
  assert.equal(parseSampleRef({ ...ref, loopStart: 2, loopEnd: 1 }), 'loopEnd invalid');
  assert.equal(parseSampleRef(null), 'not an object');
});

test('userSamples in a preset: per layer, bad entries dropped with a note, JSON in layer order', () => {
  const a = sampleRef(H, 'a.wav');
  const c = { ...sampleRef(`sha256-${'cd'.repeat(32)}`, 'c.flac'), root: 48 };
  const { samples, notes } = parseLayerSamples({ C: c, A: a, D: a, B: { hash: 'x' } });
  assert.deepEqual(samples, { A: a, C: c });
  assert.deepEqual(notes, ['own samples: unknown layer D, ignored', 'own samples: layer b: hash invalid, ignored']);
  assert.deepEqual(Object.keys(layerSamplesJson(samples)!), ['A', 'C']);
  assert.equal(layerSamplesJson({}), null);
  assert.deepEqual(parseLayerSamples(undefined), { samples: {}, notes: [] });
  assert.deepEqual(parseLayerSamples([1]).notes, ['own samples: not an object, ignored']);
});

test('assignments: set, clear, load, hashes in use, listeners', () => {
  const s = new SampleAssignments();
  const seen: number[] = [];
  const off = s.onChange((x) => seen.push(Object.keys(x).length));
  s.set('B', sampleRef(H, 'b.wav'));
  assert.equal(s.get('B')?.name, 'b.wav');
  assert.equal(s.get('A'), null);
  s.load({ A: sampleRef(H, 'a.wav'), C: sampleRef(H, 'c.wav') });
  assert.equal(s.get('B'), null, 'a load replaces every assignment');
  assert.deepEqual([...s.hashes()], [H]);
  s.set('A', null);
  off();
  s.set('C', null);
  assert.deepEqual(seen, [1, 2, 1]);
});

test('store problems carry a short text; bytes format for the manager', () => {
  const e = new SampleStoreError('too-large', 'pad.wav');
  assert.equal(e.problem, 'too-large');
  assert.equal(e.message, `${SAMPLE_PROBLEM_TEXT['too-large']} (pad.wav)`);
  assert.ok(new RegExp(`${MAX_SAMPLE_BYTES / 1024 / 1024} MB`).test(SAMPLE_PROBLEM_TEXT['too-large']));
  assert.equal(formatBytes(900), '900 B');
  assert.equal(formatBytes(812 * 1024), '812 KB');
  assert.equal(formatBytes(3.4 * 1024 * 1024), '3.4 MB');
  assert.equal(formatBytes(-1), '–');
});
