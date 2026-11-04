/**
 * Plan section 15.3, own samples in app presets (formats/preset.ts): `userSamples` and
 * `embeddedSamples` round trip, embedded files are checked against their hash, only assigned
 * samples are embedded, the size rule (1 MB, 48 MB with embedded samples), the missing-sample and
 * stored-sample notes, and collecting files to embed from a store.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { encodeBase64 } from '../../src/editor/formats/base64.ts';
import {
  collectEmbedded, embeddedBytes, embeddedSample, MAX_PRESET_BYTES, missingSampleNote, missingSampleNotes, NO_EXTRAS,
  type PresetExtras, presetSizeLimit, readPreset, readPresetExtras, storedSamplesNote, toPresetJson, toPresetJsonWith,
} from '../../src/editor/formats/preset.ts';
import {
  contentHash, MAX_PRESET_WITH_SAMPLES_BYTES, MAX_SAMPLE_BYTES, SampleStoreError,
} from '../../src/editor/formats/samples-db.ts';
import { initProgram } from '../../src/editor/model/init.ts';
import type { ProgramSnapshot } from '../../src/editor/model/store.ts';
import { sampleRef, type UserSampleRef } from '../../src/editor/model/user-samples.ts';

const snapshot = (): ProgramSnapshot => ({ ...initProgram(), name: 'pad', category: 3 });

async function sample(name: string, fill: number, size = 300): Promise<{ ref: UserSampleRef; bytes: Uint8Array }> {
  const bytes = new Uint8Array(size).map((_, i) => (i * 7 + fill) & 255);
  return { ref: sampleRef(await contentHash(bytes), name), bytes };
}

test('without extras the preset is the plain one, and reads no extras', () => {
  const s = snapshot();
  const text = toPresetJsonWith(s, '1.0.0', NO_EXTRAS);
  assert.equal(text, toPresetJson(s, '1.0.0'));
  assert.equal(toPresetJsonWith(s, '1.0.0', NO_EXTRAS, 0), toPresetJson(s, '1.0.0', 0));
  const extras = readPresetExtras(text);
  assert.deepEqual([extras.samples, extras.embedded.size, extras.notes], [{}, 0, []]);
});

test('userSamples and embeddedSamples round trip; the program reads as before', async () => {
  const a = await sample('pad.wav', 1);
  const c = await sample('keys.flac', 2);
  const extras: PresetExtras = {
    samples: { C: { ...c.ref, root: 48, loop: 'loop', loopStart: 0.25, loopEnd: 0 }, A: a.ref },
    embedded: new Map([[a.ref.hash, embeddedSample('pad.wav', 'audio/wav', a.bytes)],
      [c.ref.hash, embeddedSample('keys.flac', 'audio/flac', c.bytes.buffer as ArrayBuffer)]]),
  };
  const text = toPresetJsonWith(snapshot(), '1.0.0', extras);
  const doc = JSON.parse(text) as Record<string, unknown>;
  assert.deepEqual(Object.keys(doc['userSamples'] as object), ['A', 'C'], 'layers in order');
  assert.deepEqual(Object.keys(doc['embeddedSamples'] as object), [a.ref.hash, c.ref.hash].sort(), 'hashes sorted');
  assert.deepEqual(readPreset(text).snapshot, snapshot(), 'the program is untouched by the extras');

  const back = readPresetExtras(text);
  assert.deepEqual(back.notes, []);
  assert.deepEqual(back.samples, extras.samples);
  assert.deepEqual(new Uint8Array(embeddedBytes(back.embedded.get(a.ref.hash)!)), a.bytes);
  assert.deepEqual(back.embedded.get(c.ref.hash), { name: 'keys.flac', mime: 'audio/flac', bytesBase64: encodeBase64(c.bytes) });
  assert.equal(toPresetJsonWith(snapshot(), '1.0.0', back), text, 'stable through a second round');
});

test('only assigned samples are embedded; references alone without embedding', async () => {
  const a = await sample('pad.wav', 1);
  const other = await sample('private.wav', 9);
  const text = toPresetJsonWith(snapshot(), '1.0.0', {
    samples: { B: a.ref },
    embedded: new Map([[other.ref.hash, embeddedSample('private.wav', 'audio/wav', other.bytes)]]),
  });
  const doc = JSON.parse(text) as Record<string, unknown>;
  assert.equal(doc['embeddedSamples'], undefined, 'an unassigned file never leaves the device');
  assert.deepEqual(doc['userSamples'], { B: a.ref });
});

test('an embedded file that does not match its hash, or is malformed, is dropped with a note', async () => {
  const a = await sample('pad.wav', 1);
  const b = await sample('bass.wav', 2);
  const doc = JSON.parse(toPresetJsonWith(snapshot(), '1.0.0', {
    samples: { A: a.ref, B: b.ref },
    embedded: new Map([[a.ref.hash, embeddedSample('pad.wav', 'audio/wav', a.bytes)],
      [b.ref.hash, embeddedSample('bass.wav', 'audio/wav', b.bytes)]]),
  })) as Record<string, Record<string, unknown>>;
  const emb = doc['embeddedSamples']!;
  emb[b.ref.hash] = { ...(emb[b.ref.hash] as object), bytesBase64: encodeBase64(a.bytes) };
  emb['sha256-nothex'] = { name: 'x', mime: '', bytesBase64: '' };
  emb[`sha256-${'1'.repeat(64)}`] = { name: 'y.wav', mime: '', bytesBase64: '***' };
  emb[`sha256-${'2'.repeat(64)}`] = { name: 'z.wav' };
  doc['userSamples']!['C'] = { hash: 'nope' };
  const back = readPresetExtras(JSON.stringify(doc));
  assert.deepEqual([...back.embedded.keys()], [a.ref.hash]);
  assert.deepEqual(Object.keys(back.samples), ['A', 'B'], 'the reference stays; its layer is missing the file');
  assert.deepEqual(back.notes, [
    'own samples: layer c: hash invalid, ignored',
    'embedded sample "bass.wav": the bytes do not match their hash, ignored',
    'embedded sample "x": hash invalid, ignored',
    'embedded sample "y.wav": bytes are not base64, ignored',
    'embedded sample "z.wav": name, type or bytes missing, ignored',
  ]);
  const notObject = JSON.parse(toPresetJson(snapshot(), '1')) as Record<string, unknown>;
  notObject['embeddedSamples'] = [1];
  assert.deepEqual(readPresetExtras(JSON.stringify(notObject)).notes, ['embedded samples: not an object, ignored']);
  assert.deepEqual(readPresetExtras('not json').notes, [], 'readPreset reports bad text, not this');
});

test('an embedded file over the size limit is dropped before decoding', () => {
  const doc = JSON.parse(toPresetJson(snapshot(), '1')) as Record<string, unknown>;
  doc['embeddedSamples'] = { [`sha256-${'3'.repeat(64)}`]: { name: 'huge.wav', mime: '', bytesBase64: 'A'.repeat(Math.ceil(MAX_SAMPLE_BYTES / 3) * 4 + 4) } };
  assert.deepEqual(readPresetExtras(JSON.stringify(doc)).notes, ['embedded sample "huge.wav": larger than 32 MB, ignored']);
});

test('size rule: 1 MB, or 48 MB when the text embeds own samples', () => {
  const plain = toPresetJson(snapshot(), '1');
  assert.equal(presetSizeLimit(plain), MAX_PRESET_BYTES);
  const padded = plain.replace('{', `{"pad":"${' '.repeat(MAX_PRESET_BYTES)}",`);
  assert.throws(() => readPreset(padded), /larger than 1 MB/);
  const withSamples = padded.replace('{', '{"embeddedSamples":{},');
  assert.equal(presetSizeLimit(withSamples), MAX_PRESET_WITH_SAMPLES_BYTES);
  assert.deepEqual(readPreset(withSamples).snapshot, snapshot(), 'accepted with embedded samples');
  const tooBig = `{"embeddedSamples":{},"x":"${' '.repeat(MAX_PRESET_WITH_SAMPLES_BYTES)}"}`;
  assert.throws(() => readPreset(tooBig), /larger than 48 MB/);
  assert.deepEqual(readPresetExtras(tooBig).samples, {});
});

test('notes: missing samples per layer, stored samples', async () => {
  const a = await sample('pad.wav', 1);
  const b = await sample('bass.wav', 2);
  assert.equal(missingSampleNote('B', { name: 'pad.wav' }),
    'layer b: own sample "pad.wav" is not on this device: import the file again or load the preset that embeds it');
  assert.deepEqual(missingSampleNotes({ C: b.ref, A: a.ref }, (h) => h === a.ref.hash), [missingSampleNote('C', b.ref)]);
  assert.equal(storedSamplesNote(2), '2 own samples stored on this device');
  assert.equal(storedSamplesNote(1), '1 own sample stored on this device');
});

test('collecting files to embed: each assigned sample once, notes for the missing and the damaged', async () => {
  const a = await sample('pad.wav', 1);
  const b = await sample('bass.wav', 2);
  const c = await sample('lost.wav', 3);
  const asked: string[] = [];
  const got = await collectEmbedded({ A: a.ref, B: a.ref, C: c.ref }, async (hash) => {
    asked.push(hash);
    return hash === a.ref.hash ? { meta: { name: 'pad.wav', mime: 'audio/wav' }, bytes: a.bytes.buffer as ArrayBuffer } : null;
  });
  assert.deepEqual(asked, [a.ref.hash, c.ref.hash]);
  assert.deepEqual([...got.embedded.keys()], [a.ref.hash]);
  assert.deepEqual(got.notes, [missingSampleNote('C', c.ref)]);
  const damaged = await collectEmbedded({ B: b.ref }, () => Promise.reject(new SampleStoreError('corrupt')));
  assert.equal(damaged.embedded.size, 0);
  assert.ok(/^layer b: own sample "bass.wav" not embedded: a stored sample is damaged/.test(damaged.notes[0]!));
});
