/** The app preset (plan section 5.1, AC 10): lossless JSON round trip and the validation messages. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Ns4Program, TEMPLATE_BYTES } from '../../src/ns4/index.ts';
import { DESCRIPTORS } from '../../src/editor/model/descriptors.ts';
import { initProgram } from '../../src/editor/model/init.ts';
import { NS4_KEYS, type Ns4Key } from '../../src/editor/model/keys.ts';
import { ParamStore, type ProgramSnapshot } from '../../src/editor/model/store.ts';
import { decodeBase64Strict, encodeBase64 } from '../../src/editor/formats/base64.ts';
import { importNs4p } from '../../src/editor/formats/ns4p-import.ts';
import {
  KEYS_CRC32, MIGRATIONS, parsePreset, PRESET_FORMAT, PRESET_SCHEMA, PresetError, presetFileName, readPreset,
  toPresetDocument, toPresetJson,
} from '../../src/editor/formats/preset.ts';

/** A small deterministic PRNG (mulberry32), so a failing random case can be replayed. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomSnapshot(seed: number): ProgramSnapshot {
  const next = rng(seed);
  const values = {} as Record<Ns4Key, number>;
  for (const key of NS4_KEYS) {
    const d = DESCRIPTORS.get(key)!;
    values[key] = d.min + Math.floor(next() * (d.max - d.min + 1));
  }
  const name = `pad ${seed} · äöü "quoted" \\ ✓`;
  return { name, category: Math.floor(next() * 47), values, source: null };
}

function roundTrip(s: ProgramSnapshot): ProgramSnapshot {
  return parsePreset(toPresetJson(s, '0.1.0'));
}

/** A valid preset document as a mutable object, for breaking one part at a time. */
function doc(s: ProgramSnapshot = initProgram()): Record<string, any> {
  return JSON.parse(toPresetJson(s, '0.1.0'));
}

function refused(text: string, message: string | RegExp, short?: string): void {
  assert.throws(() => parsePreset(text), (err: unknown) => {
    assert.ok(err instanceof PresetError, String(err));
    if (typeof message === 'string') assert.equal(err.message, message);
    else assert.ok(message.test(err.message), err.message);
    if (short !== undefined) assert.equal(err.short, short);
    return true;
  });
}

test('the init program survives JSON deep-equal', () => {
  const init = initProgram();
  assert.deepEqual(roundTrip(init), init);
});

test('randomised snapshots survive JSON deep-equal, including range limits', () => {
  for (const seed of [1, 2, 3, 42, 2026]) {
    const s = randomSnapshot(seed);
    assert.deepEqual(roundTrip(s), s, `seed ${seed}`);
  }
  const values = { ...initProgram().values };
  for (const key of NS4_KEYS) values[key] = DESCRIPTORS.get(key)!.max;
  const max = { ...initProgram(), values, category: 46 };
  assert.deepEqual(roundTrip(max), max);
  for (const key of NS4_KEYS) values[key] = DESCRIPTORS.get(key)!.min;
  const min = { ...initProgram(), values, category: 0, name: '' };
  assert.deepEqual(roundTrip(min), min);
});

test('an imported program survives JSON deep-equal, source bytes included', () => {
  const { snapshot } = importNs4p('Warm Pad.ns4p', TEMPLATE_BYTES);
  assert.ok(snapshot.source !== null);
  const back = roundTrip(snapshot);
  assert.deepEqual(back, snapshot);
  assert.ok(back.source!.bytes instanceof Uint8Array);
  assert.deepEqual(Array.from(back.source!.bytes), Array.from(TEMPLATE_BYTES));
});

test('store → preset → store gives the same state', () => {
  const store = new ParamStore(importNs4p('Lead.ns4p', TEMPLATE_BYTES).snapshot);
  store.set('synthASound.fltFreq', 12);
  store.setName('Lead edited');
  const saved = store.snapshot();
  const other = new ParamStore(initProgram());
  other.load(parsePreset(toPresetJson(saved, '0.1.0')), 'load');
  assert.deepEqual(other.snapshot(), saved);
});

test('the document: format, schema, layout, values in layout order, deterministic', () => {
  const s = randomSnapshot(7);
  const d = toPresetDocument(s, '0.1.0');
  assert.equal(d.format, PRESET_FORMAT);
  assert.equal(d.schema, PRESET_SCHEMA);
  assert.equal(d.app, 'nord editor 0.1.0');
  assert.deepEqual(d.layout, { model: 'Nord Stage 4', fields: 955, keysCrc32: KEYS_CRC32 });
  assert.ok(/^[0-9a-f]{8}$/.test(KEYS_CRC32), KEYS_CRC32);
  assert.deepEqual(Object.keys(d.values), [...NS4_KEYS]);
  assert.equal(d.source, null);
  assert.equal(toPresetJson(s, '0.1.0'), toPresetJson(s, '0.1.0'));
  assert.ok(toPresetJson(s, '0.1.0').endsWith('}\n'));
  assert.ok(!toPresetJson(s, '0.1.0', 0).includes('\n'));
  assert.deepEqual(parsePreset(toPresetJson(s, '0.1.0', 0)), s);
});

test('unknown top-level keys are ignored; a missing source is no source', () => {
  const d = doc();
  d['savedBy'] = 'someone';
  delete d['source'];
  assert.deepEqual(parsePreset(JSON.stringify(d)), initProgram());
});

test('each validation failure gives its message', () => {
  refused('{', /^not a preset file: /, 'not a preset file');
  refused('[1, 2]', 'not a preset file: not a JSON object');
  refused('null', 'not a preset file: not a JSON object');
  refused(' '.repeat(1024 * 1024 + 1), 'not a preset file: larger than 1 MB', 'not a preset file');

  const cases: Array<[(d: Record<string, any>) => void, string, string]> = [
    [(d) => { delete d['format']; }, 'not an editor preset', 'not an editor preset'],
    [(d) => { d['format'] = 'something-else'; }, 'not an editor preset', 'not an editor preset'],
    [(d) => { delete d['schema']; }, 'preset schema missing', 'preset schema missing'],
    [(d) => { d['schema'] = 0; }, 'preset schema missing', 'preset schema missing'],
    [(d) => { d['schema'] = 1.5; }, 'preset schema missing', 'preset schema missing'],
    [(d) => { d['schema'] = '1'; }, 'preset schema missing', 'preset schema missing'],
    [(d) => { d['layout'].model = 'Nord Stage 3'; }, 'made for another Stage 4 layout', 'made for another Stage 4 layout'],
    [(d) => { d['layout'].keysCrc32 = '00000000'; }, 'made for another Stage 4 layout', 'made for another Stage 4 layout'],
    [(d) => { delete d['layout']; }, 'made for another Stage 4 layout', 'made for another Stage 4 layout'],
    [(d) => { delete d['values']; }, 'values missing', 'preset values invalid'],
    [(d) => { delete d['values']['synthASound.fltFreq']; }, 'synthASound.fltFreq: missing', 'preset values invalid'],
    [(d) => { d['values']['synthASound.fltBogus'] = 1; }, 'synthASound.fltBogus: unknown field', 'preset values invalid'],
    [(d) => { d['values']['synthASound.fltFreq'] = 300; }, 'synthASound.fltFreq: 300 is outside 0..127', 'preset values invalid'],
    [(d) => { d['values']['synthASound.fltFreq'] = -1; }, 'synthASound.fltFreq: -1 is outside 0..127', 'preset values invalid'],
    [(d) => { d['values']['synthASound.fltFreq'] = 1.5; }, 'synthASound.fltFreq: 1.5 is not an integer', 'preset values invalid'],
    [(d) => { d['values']['synthASound.fltFreq'] = '64'; }, 'synthASound.fltFreq: "64" is not an integer', 'preset values invalid'],
    [(d) => { d['values']['synthASound.fltFreq'] = null; }, 'synthASound.fltFreq: null is not an integer', 'preset values invalid'],
    [(d) => { d['name'] = 5; }, 'name invalid', 'name invalid'],
    [(d) => { delete d['name']; }, 'name invalid', 'name invalid'],
    [(d) => { d['category'] = 47; }, 'category invalid', 'category invalid'],
    [(d) => { d['category'] = -1; }, 'category invalid', 'category invalid'],
    [(d) => { d['category'] = 'pad'; }, 'category invalid', 'category invalid'],
  ];
  for (const [breakIt, message, short] of cases) {
    const d = doc();
    breakIt(d);
    refused(JSON.stringify(d), message, short);
  }
});

test('an unreadable source program is refused with the reason', () => {
  const imported = doc(importNs4p('Pad.ns4p', TEMPLATE_BYTES).snapshot);
  const breakSource = (fn: (src: Record<string, any>) => void): string => {
    const d = structuredClone(imported);
    fn(d['source']);
    return JSON.stringify(d);
  };
  const short = 'source program unreadable';
  refused(breakSource((s) => { s['bytesBase64'] = 'not base64!'; }), 'source program unreadable: bytes are not base64', short);
  refused(breakSource((s) => { s['bytesBase64'] = 'QUJD'; }), /^source program unreadable: /, short);
  refused(breakSource((s) => { s['kind'] = 'ns3f'; }), 'source program unreadable: kind "ns3f" is not "ns4p"', short);
  refused(breakSource((s) => { delete s['fileName']; }), 'source program unreadable: file name missing', short);
  refused(breakSource((s) => { s['formatVersion'] = 312; }),
    "source program unreadable: format version 312 differs from the file's 313", short);

  // A corrupted file inside the preset shows the engine's own message.
  const bytes = Uint8Array.from(TEMPLATE_BYTES);
  bytes[bytes.length - 1]! ^= 0xff;
  let engine = '';
  try { Ns4Program.fromBytes(bytes); } catch (err) { engine = (err as Error).message; }
  assert.notEqual(engine, '');
  refused(breakSource((s) => { s['bytesBase64'] = encodeBase64(bytes); }), `source program unreadable: ${engine}`, short);
  const d = doc();
  d['source'] = 'Pad.ns4p';
  refused(JSON.stringify(d), 'source program unreadable: not an object', short);
});

test('a newer schema is refused, never guessed', () => {
  const d = doc();
  d['schema'] = PRESET_SCHEMA + 1;
  refused(JSON.stringify(d), 'made by a newer editor (schema 2); this editor reads schema 1', 'made by a newer editor');
  d['schema'] = 99;
  refused(JSON.stringify(d), 'made by a newer editor (schema 99); this editor reads schema 1');
});

test('the current schema needs no migration and gives no notes', () => {
  assert.deepEqual(Object.keys(MIGRATIONS), []);
  assert.deepEqual(readPreset(toPresetJson(initProgram(), '0.1.0')).notes, []);
});

test('the download name says app preset and is safe for file systems', () => {
  assert.equal(presetFileName('Warm Pad'), 'Warm Pad · app-preset.json');
  assert.equal(presetFileName('a/b\\c:d*e?f"g<h>i|j'), 'a-b-c-d-e-f-g-h-i-j · app-preset.json');
  assert.equal(presetFileName('  '), 'untitled · app-preset.json');
  assert.equal(presetFileName('..hidden'), 'hidden · app-preset.json');
  assert.equal(presetFileName('line\nbreak'), 'line-break · app-preset.json');
});

test('base64 encodes like btoa and decodes strictly', () => {
  const next = rng(9);
  for (let n = 0; n < 40; n++) {
    const bytes = Uint8Array.from({ length: n }, () => Math.floor(next() * 256));
    const want = btoa(String.fromCharCode(...bytes));
    assert.equal(encodeBase64(bytes), want, `length ${n}`);
    assert.deepEqual(Array.from(decodeBase64Strict(want)), Array.from(bytes));
  }
  for (const bad of ['QUJ', 'QUJD=', 'QU JD', 'QUJD\n', 'Q===', '====', 'QUJ*']) {
    assert.throws(() => decodeBase64Strict(bad), /not base64/, bad);
  }
});
