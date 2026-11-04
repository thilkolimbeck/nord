/**
 * The experimental Stage 4 export (plan section 5.4, AC 12): export → Ns4Program.fromBytes → every
 * field equals the snapshot and every bit no field covers equals the donor's; an unedited export
 * of an opened 3.13 file keeps its body byte for byte; a bad snapshot throws ExportError and
 * yields no bytes; a 3.07 file falls back to the neutral template. Also the file keys' export and
 * report actions and the onLoad callback. The opened files come from the test corpus (corpus.ts);
 * no private file is read.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildCbin } from '../../src/ns4/cbin.ts';
import { loadTemplate, Ns4Program, TEMPLATE_BYTES } from '../../src/ns4/index.ts';
import { NS4_LAYOUT } from '../../src/ns4/layout.ts';
import { DESCRIPTORS } from '../../src/editor/model/descriptors.ts';
import { initProgram } from '../../src/editor/model/init.ts';
import { NS4_KEYS, type Ns4Key } from '../../src/editor/model/keys.ts';
import { ParamStore, type ProgramSnapshot } from '../../src/editor/model/store.ts';
import { ExportError, exportExperimentalNs4p, ns4pFileName } from '../../src/editor/formats/ns4p-export.ts';
import { importNs4p } from '../../src/editor/formats/ns4p-import.ts';
import { parsePreset, toPresetJson } from '../../src/editor/formats/preset.ts';
import { FileActions, type FileLike } from '../../src/editor/ui/files.ts';
import { CORPUS, RANDOM } from './corpus.ts';

/** Opened files: the random corpus programs (format 3.13, bank 0, location 0, own undecoded bits). */
const OUTPUTS = RANDOM;

/** A body-sized mask with a 1 bit for every bit no layout field covers. */
const UNCOVERED: Uint8Array = (() => {
  const covered = new Uint8Array(NS4_LAYOUT.bodyBytes);
  for (const f of NS4_LAYOUT.fields.values()) {
    for (let bit = f.bodyBit; bit < f.bodyBit + f.width; bit++) covered[bit >> 3]! |= 0x80 >> (bit & 7);
  }
  return covered.map((b) => ~b & 0xff);
})();

function assertFieldsEqual(back: Ns4Program, s: ProgramSnapshot, label: string): void {
  for (const key of NS4_KEYS) {
    if (back.value(key) !== s.values[key]) assert.fail(`${label}: ${key} reads back ${back.value(key)}, snapshot ${s.values[key]}`);
  }
}

function assertUncoveredEqual(a: Uint8Array, b: Uint8Array, label: string): void {
  assert.equal(a.length, b.length, label);
  let checked = 0;
  for (let i = 0; i < UNCOVERED.length; i++) {
    if ((a[i]! ^ b[i]!) & UNCOVERED[i]!) assert.fail(`${label}: undecoded bits of body byte ${i} changed`);
    if (UNCOVERED[i] !== 0) checked += 1;
  }
  assert.ok(checked > 50, `${label}: the mask covers ${checked} bytes`);
}

/** Edits a user could make: synth values across layers, a layout-only field, a morph amount. */
function edited(s: ProgramSnapshot): ProgramSnapshot {
  const store = new ParamStore(s);
  store.setMany([
    ['synthASound.fltFreq', 74], ['synthASound.fltRes', 40], ['synthASound.ampEnvAtk', 30],
    ['synthBSound.oscTuneCoarse', -12], ['synth.layerEnableSyn_I', 0b011], ['synth.layerPanSynB', -20],
    ['organADrawbars.org_Preset_kDb3', 2], ['synthASound.fltFreq.morphWheel', 40],
  ], 'ui');
  store.setName('Edited Pad');
  return store.snapshot();
}

test('the corpus programs are found', () => {
  assert.ok(OUTPUTS.length >= 64, String(OUTPUTS.length));
});

test('from the init program: fields equal the snapshot, undecoded bits equal the neutral template', () => {
  for (const s of [initProgram(), edited(initProgram())]) {
    const out = exportExperimentalNs4p(s);
    assert.equal(out.donor, 'neutral');
    assert.equal(out.fileName, `${s.name}.ns4p`);
    const back = Ns4Program.fromBytes(out.bytes);
    assertFieldsEqual(back, s, s.name);
    assertUncoveredEqual(back.body, loadTemplate().body, s.name);
    assert.deepEqual({ ...back.header, crc: 0 }, { ...loadTemplate().header, crc: 0, category: s.category });
    assert.ok(out.notes[0]!.startsWith('donor: the neutral template (no stage 4 program was opened)'), out.notes[0]);
    assert.ok(out.notes.some((n) => /untested on stage 4 hardware/.test(n)), out.notes.join(' | '));
  }
  // init differs from the neutral template by the synth switch and the layer A bit.
  assert.equal(exportExperimentalNs4p(initProgram()).edits, 2);
});

test('from an opened 3.13 file with edits: fields equal the snapshot, undecoded bits equal the file', () => {
  for (const [name, bytes] of OUTPUTS.slice(0, 40)) {
    const s = edited(importNs4p(`${name}.ns4p`, bytes).snapshot);
    const out = exportExperimentalNs4p(s);
    assert.equal(out.donor, 'source', name);
    assert.equal(out.fileName, 'Edited Pad.ns4p');
    const back = Ns4Program.fromBytes(out.bytes);
    assertFieldsEqual(back, s, name);
    const source = Ns4Program.fromBytes(bytes);
    assertUncoveredEqual(back.body, source.body, name);
    assert.equal(back.header.bank, 0);
    assert.equal(back.header.location, 0);
    assert.equal(back.header.category, s.category);
    assert.ok(out.notes[0]!.startsWith(`donor: ${name}.ns4p (the opened program, format 3.13)`), out.notes[0]);
  }
});

test('an unedited export of an opened 3.13 file keeps its body byte for byte', () => {
  for (const [name, bytes] of CORPUS) {
    const out = exportExperimentalNs4p(importNs4p(`${name}.ns4p`, bytes).snapshot);
    assert.equal(out.edits, 0, name);
    assert.deepEqual(Ns4Program.fromBytes(out.bytes).body, Ns4Program.fromBytes(bytes).body, name);
  }
  // A corpus program has bank 0 and location 0, as an export writes them: the whole file comes back.
  const [name, bytes] = OUTPUTS[0]!;
  assert.deepEqual(exportExperimentalNs4p(importNs4p(`${name}.ns4p`, bytes).snapshot).bytes, bytes);
});

test('aux kb and output settings (now editable, plan 15.8) round trip through the app preset and the export', () => {
  const AUX_OUT: Array<readonly [Ns4Key, number]> = [
    ['common.auxKbdEnable', 1], ['common.auxKbdVelCurve', 2], ['organ.auxKbdControl', 3], ['piano.auxKbdControl', 1],
    ['synth.auxKbdControl', 7], ['common.audioRoutingBusOrg', 2], ['common.audioRoutingBusLeslie', 4],
    ['common.audioRoutingBusPnoA', 1], ['common.audioRoutingBusPnoB', 0], ['common.audioRoutingBusSynA', 3],
    ['common.audioRoutingBusSynB', 4], ['common.audioRoutingBusSynC', 2],
  ];
  for (const [key, v] of AUX_OUT) {
    const d = DESCRIPTORS.get(key)!;
    assert.ok(v >= d.min && v <= d.max, `${key}: ${v} in ${d.min}..${d.max}`);
  }
  for (const [name, bytes] of [['init', null] as const, ...OUTPUTS.slice(0, 8)]) {
    const base = bytes === null ? initProgram() : importNs4p(`${name}.ns4p`, bytes).snapshot;
    const store = new ParamStore(base);
    store.setMany(AUX_OUT, 'ui');
    const s = store.snapshot();
    // App preset: the values come back as written.
    const back = new ParamStore(initProgram());
    back.load(parsePreset(toPresetJson(s, '0.1.0')), 'load');
    for (const [key, v] of AUX_OUT) assert.equal(back.get(key), v, `${name}: ${key}`);
    // Export: every field reads back as the snapshot, the undecoded bits as the donor's.
    const out = exportExperimentalNs4p(s);
    const program = Ns4Program.fromBytes(out.bytes);
    assertFieldsEqual(program, s, name);
    if (bytes !== null) {
      assertUncoveredEqual(program.body, Ns4Program.fromBytes(bytes).body, name);
      // Only the touched fields differ from the opened file.
      const opened = Ns4Program.fromBytes(bytes);
      for (const key of NS4_KEYS) {
        if (AUX_OUT.some(([k]) => k === key)) continue;
        assert.equal(program.value(key), opened.value(key), `${name}: ${key} untouched`);
      }
    }
  }
});

test('a source kept in an app preset serves as donor after the preset round trip', () => {
  const [name, bytes] = OUTPUTS[1]!;
  const s = importNs4p(`${name}.ns4p`, bytes).snapshot;
  const store = new ParamStore(s);
  assert.equal(toPresetJson(store.snapshot(), '0.1.0').includes('bytesBase64'), true);
  assert.equal(exportExperimentalNs4p(store.snapshot()).donor, 'source');
});

test('a value outside its field, or not an integer, throws ExportError and yields no bytes', () => {
  const init = initProgram();
  const [key, d] = [...DESCRIPTORS].find(([, x]) => x.enc === 'u' && x.max < 2 ** x.width - 1 && x.kind === 'continuous')!;
  const cases: Array<[string, number, RegExp]> = [
    [key, d.max + 1, new RegExp(`^export refused: ${key.replace(/\./g, '\\.')}: ${d.max + 1} is outside`)],
    [key, d.min - 1, /^export refused: /],
    ['synthASound.fltFreq', 2.5, /^export refused: synthASound\.fltFreq is 2\.5, not an integer$/],
    ['synthASound.fltFreq', Number.NaN, /^export refused: .*not an integer$/],
  ];
  for (const [k, value, re] of cases) {
    const s: ProgramSnapshot = { ...init, values: { ...init.values, [k]: value } };
    let result: unknown = 'not set';
    assert.throws(() => { result = exportExperimentalNs4p(s); }, (err: unknown) => {
      assert.ok(err instanceof ExportError, String(err));
      assert.ok(re.test(err.message), err.message);
      return true;
    });
    assert.equal(result, 'not set', 'no bytes returned');
  }
  const missing = { ...init.values } as Partial<Record<Ns4Key, number>>;
  delete missing['synthASound.fltRes'];
  assert.throws(() => exportExperimentalNs4p({ ...init, values: missing as Record<Ns4Key, number> }),
    (err: unknown) => err instanceof ExportError && /synthASound\.fltRes is undefined/.test(err.message));
});

test('an unknown category is written as none', () => {
  const out = exportExperimentalNs4p({ ...initProgram(), category: 99 });
  assert.equal(Ns4Program.fromBytes(out.bytes).header.category, 17);
  assert.ok(out.notes.includes('category 99 is unknown; written as none'));
});

test('a 3.07 file falls back to the neutral template', () => {
  const src = Ns4Program.fromBytes(TEMPLATE_BYTES);
  const body = src.body;
  new DataView(body.buffer).setUint32(0, 307, false);
  const old = buildCbin({ ...src.header, version: 307 }, body);
  const s = edited(importNs4p('Old.ns4p', old).snapshot);
  assert.equal(s.source?.formatVersion, 307);
  const out = exportExperimentalNs4p(s);
  assert.equal(out.donor, 'neutral');
  const back = Ns4Program.fromBytes(out.bytes);
  assert.equal(back.formatVersion, 313);
  assertFieldsEqual(back, s, 'Old');
  assertUncoveredEqual(back.body, loadTemplate().body, 'Old');
  assert.ok(out.notes[0]!.startsWith('donor: the neutral template (Old.ns4p is format 3.07, only 3.13 files serve as donor)'),
    out.notes[0]);
});

test('file name: the program name, characters file systems refuse replaced', () => {
  assert.equal(ns4pFileName('Warm Pad'), 'Warm Pad.ns4p');
  assert.equal(ns4pFileName('a/b:c*?'), 'a-b-c--.ns4p');
  assert.equal(ns4pFileName('  ..hidden  '), 'hidden.ns4p');
  assert.equal(ns4pFileName('   '), 'untitled.ns4p');
});

interface Printed { lines: readonly string[]; kind: string }

function harness(onLoad?: () => void) {
  const printed: Printed[] = [];
  const downloads: Array<{ fileName: string; data: string | Uint8Array; type: string }> = [];
  const store = new ParamStore(initProgram());
  const actions = new FileActions({
    store, storage: null, appVersion: '0.1.0', ...(onLoad === undefined ? {} : { onLoad }),
    printout: { print: (lines, kind) => { printed.push({ lines, kind }); } },
    download: (fileName, data, type) => { downloads.push({ fileName, data, type }); },
    now: () => new Date(2026, 10, 3, 12, 0),
  });
  return { printed, downloads, store, actions };
}

function file(name: string, data: Uint8Array | string): FileLike {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  return { name, size: bytes.length, arrayBuffer: async () => Uint8Array.from(bytes).buffer };
}

test('file keys: export downloads the verified file and prints the notes', () => {
  const { printed, downloads, store, actions } = harness();
  store.setName('Lead / 2');
  assert.equal(actions.exportNs4p(), 'Lead - 2.ns4p');
  assert.equal(downloads.length, 1);
  assert.equal(downloads[0]!.type, 'application/octet-stream');
  assertFieldsEqual(Ns4Program.fromBytes(downloads[0]!.data as Uint8Array), store.snapshot(), 'download');
  assert.equal(printed.at(-1)!.kind, 'result');
  assert.equal(printed.at(-1)!.lines[0], 'stage 4 program downloaded (experimental): Lead - 2.ns4p');
});

test('file keys: a failed export prints an error and downloads nothing', () => {
  const { printed, downloads, store, actions } = harness();
  const [name, bytes] = OUTPUTS[0]!;
  const s = importNs4p(`${name}.ns4p`, bytes).snapshot;
  const broken = Uint8Array.from(s.source!.bytes);
  broken[broken.length - 1]! ^= 1;
  store.load({ ...s, source: { ...s.source!, bytes: broken } }, 'load');
  assert.equal(actions.exportNs4p(), null);
  assert.equal(downloads.length, 0);
  assert.equal(printed.at(-1)!.kind, 'error');
  assert.ok(/^stage 4 program not exported: the opened program .* is unreadable: /.test(printed.at(-1)!.lines[0]!), printed.at(-1)!.lines[0]!);
});

test('file keys: report downloads plain text named after the program', () => {
  const { downloads, store, actions } = harness();
  store.setName('Warm Pad');
  store.set('synthASound.fltFreq', 74);
  assert.equal(actions.downloadReport(), 'Warm Pad · parameter-report.txt');
  const { data, type } = downloads[0]!;
  assert.equal(type, 'text/plain;charset=utf-8');
  assert.equal(typeof data, 'string');
  assert.ok(/^nord stage 4 parameter report, for reading only\n/.test(data as string), data as string);
  assert.ok(/program: Warm Pad · nord editor 0\.1\.0 · 2026-11-03\n/.test(data as string), data as string);
  assert.ok(/\n1 changed value\n$/.test(data as string), data as string);
});

test('onLoad runs after a .ns4p open and a preset import, not after a failed one', async () => {
  let loads = 0;
  const { actions } = harness(() => { loads += 1; });
  const [name, bytes] = OUTPUTS[0]!;
  assert.equal(await actions.openNs4p(file(`${name}.ns4p`, bytes)), true);
  assert.equal(loads, 1);
  assert.equal(await actions.importPreset(file('p.json', toPresetJson(initProgram(), '0.1.0'))), true);
  assert.equal(loads, 2);
  assert.equal(await actions.openNs4p(file('bad.ns4p', new Uint8Array(10))), false);
  assert.equal(await actions.importPreset(file('bad.json', '{}')), false);
  assert.equal(loads, 2);
});
