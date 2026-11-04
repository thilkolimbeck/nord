/**
 * Opening a .ns4p file (plan section 5.2, AC 11): for the bundled template and every program of
 * the test corpus (corpus.ts), the snapshot holds exactly the reader's values for all 955 fields,
 * all in range, and the file's bytes as the source. Bad files give the reader's message. No
 * private file is read.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeBits } from '../../src/ns4/bits.ts';
import { buildCbin } from '../../src/ns4/cbin.ts';
import { loadTemplate, NordFormatError, Ns4Program, TEMPLATE_BYTES } from '../../src/ns4/index.ts';
import { NS4_LAYOUT } from '../../src/ns4/layout.ts';
import { DESCRIPTORS } from '../../src/editor/model/descriptors.ts';
import { NS4_KEYS } from '../../src/editor/model/keys.ts';
import { ParamStore } from '../../src/editor/model/store.ts';
import { ImportError, importNs4p, MAX_NS4P_BYTES, programName } from '../../src/editor/formats/ns4p-import.ts';
import { CORPUS } from './corpus.ts';

function engineMessage(bytes: Uint8Array): string {
  try {
    Ns4Program.fromBytes(bytes);
  } catch (err) {
    assert.ok(err instanceof NordFormatError, String(err));
    return err.message;
  }
  return assert.fail('the engine accepted the file');
}

test('the corpus is built', () => {
  assert.ok(CORPUS.length > 60, String(CORPUS.length));
});

test('every field equals the reader, in range, for the template and every corpus program', () => {
  for (const [name, bytes] of CORPUS) {
    const program = Ns4Program.fromBytes(bytes);
    const { snapshot, notes } = importNs4p(`${name}.ns4p`, bytes);
    assert.equal(Object.keys(snapshot.values).length, 955, name);
    for (const key of NS4_KEYS) {
      const value = snapshot.values[key];
      if (value !== program.value(key)) assert.fail(`${name}: ${key} is ${value}, the reader says ${program.value(key)}`);
      const d = DESCRIPTORS.get(key)!;
      if (value < d.min || value > d.max) assert.fail(`${name}: ${key} ${value} outside ${d.min}..${d.max}`);
    }
    assert.equal(snapshot.category, program.header.category, name);
    assert.ok(!notes.some((n) => /out of range/.test(n)), `${name}: ${notes.join(' | ')}`);
    assert.deepEqual(snapshot.source && Array.from(snapshot.source.bytes), Array.from(bytes), name);
    assert.equal(snapshot.source?.formatVersion, program.formatVersion);
    // The store accepts the snapshot as it is: nothing is clamped on load.
    assert.deepEqual(new ParamStore(snapshot).snapshot().values, snapshot.values, name);
  }
});

test('meta: name from the file name, the source keeps a copy of the bytes', () => {
  const bytes = Uint8Array.from(TEMPLATE_BYTES);
  const { snapshot, notes } = importNs4p('Warm Pad.NS4P', bytes);
  assert.equal(snapshot.name, 'Warm Pad');
  assert.deepEqual({ ...snapshot.source, bytes: null }, { kind: 'ns4p', fileName: 'Warm Pad.NS4P', formatVersion: 313, bytes: null });
  bytes[0] = 0;
  assert.equal(snapshot.source!.bytes[0], TEMPLATE_BYTES[0], 'a copy, not a view');
  assert.equal(notes[0], 'stage 4 program, format 3.13');
  assert.equal(programName('.ns4p'), 'untitled');
  assert.equal(programName('My Lead'), 'My Lead');
});

test('bad files give the engine message', () => {
  const badMagic = Uint8Array.from(TEMPLATE_BYTES);
  badMagic[0] = 0x58;
  const badCrc = Uint8Array.from(TEMPLATE_BYTES);
  badCrc[badCrc.length - 1]! ^= 0x01;
  const cases: Array<[string, Uint8Array]> = [
    ['empty', new Uint8Array(0)],
    ['bad magic', badMagic],
    ['bad crc', badCrc],
    ['truncated', TEMPLATE_BYTES.subarray(0, 100)],
    ['text', new TextEncoder().encode('{"format":"nord-stage4-editor-preset"}')],
  ];
  for (const [name, bytes] of cases) {
    const want = engineMessage(bytes);
    assert.throws(() => importNs4p('x.ns4p', bytes), (err: unknown) => {
      assert.ok(err instanceof ImportError, `${name}: ${String(err)}`);
      assert.equal(err.message, want, name);
      return true;
    });
  }
  assert.throws(() => importNs4p('big.ns4p', new Uint8Array(MAX_NS4P_BYTES + 1)),
    (err: unknown) => err instanceof ImportError && /too large for a Stage 4 program/.test(err.message));
});

/** The neutral template (every field at its default, scene I off) with some fields set. */
function edit(fn: (p: Ns4Program) => void): Uint8Array {
  const p = loadTemplate();
  fn(p);
  return p.toBytes();
}

test('notes: approximated sections, layer modes, arp, layer effects, morphs, split (active scene)', () => {
  const bytes = edit((p) => {
    p.set('common.sectionEnableOrg_I', 1);
    p.set('common.sectionEnablePno_I', 1);
    p.set('common.sectionEnableSyn_I', 1);
    p.set('synth.layerEnableSyn_I', 0b111);
    p.set('synthA.mode', 0);
    p.set('synthB.mode', 1);
    p.set('synthBSound.oscBank', 3);
    p.set('synthC.mode', 1);
    p.set('synthCSound.oscBank', 0);
    p.set('synthC.externEnable', 1);
    p.set('synthC.arpRun', 1);
    p.set('organFx.rvbEnable', 1);
    p.set('pianoBFx.dlyEnable', 1);
    p.set('pianoBFx.ampEnable', 1);
    p.set('synthASound.fltFreq.morphWheel', 10);
    p.set('synthBSound.fltFreq.morphWheel', -10);
    p.set('common.splitEnabled', 1);
  });
  const { notes } = importNs4p('Busy.ns4p', bytes);
  const has = (re: RegExp): void => assert.ok(notes.some((n) => re.test(n)), `${re} in ${notes.join(' | ')}`);
  has(/^organ is on in scene I: it plays as an approximation/);
  has(/^piano is on in scene I: it plays as a synthesized approximation, no Nord samples/);
  has(/^organ has layer effects on \(reverb\): not implemented/);
  has(/^piano layer b has layer effects on \(amp, delay\): not implemented/);
  has(/^synth layer a uses samples mode/);
  has(/^synth layer b uses the wave oscillator type/);
  has(/^synth layer c has extern on/);
  has(/^synth layer c has the arpeggiator on/);
  has(/^2 morph amounts are set/);
  has(/^split is on: zones and crossfades play as approximated/);
  assert.ok(!notes.some((n) => /layer c uses/.test(n)), 'analog layer c needs no mode note');
  assert.ok(!notes.some((n) => /^scene II/.test(n)), 'scene I is active');

  // Scene II active: its switches decide what plays and what the notes say.
  const second = importNs4p('Second.ns4p', edit((p) => {
    p.set('common.layerScene', 1);
    p.set('common.sectionEnableSyn_I', 1);
    p.set('synth.layerEnableSyn_I', 1);
    p.set('common.sectionEnablePno_II', 1);
    p.set('common.sectionEnableSyn_II', 0);
  })).notes;
  assert.ok(second.includes('scene II is the active scene in this file: it plays, and the panels edit it'), second.join(' | '));
  assert.ok(second.some((n) => /^piano is on in scene II/.test(n)), second.join(' | '));
  assert.ok(second.includes('the synth section is off in scene II: switch a layer on to hear it'), second.join(' | '));

  const quiet = importNs4p('Init.ns4p', edit((p) => {
    p.set('common.sectionEnableSyn_I', 1);
    p.set('synth.layerEnableSyn_I', 1);
    p.set('synthA.mode', 1);
    p.set('synthASound.oscBank', 0);
  })).notes;
  assert.deepEqual(quiet, ['stage 4 program, format 3.13']);
  assert.deepEqual(importNs4p('Off.ns4p', edit(() => {})).notes,
    ['stage 4 program, format 3.13', 'the synth section is off in scene I: switch a layer on to hear it']);
});

test('a value outside its range is clamped and listed', () => {
  // A field whose bits can hold more than its range: write the raw maximum.
  const [key, f] = [...NS4_LAYOUT.fields].find(([, fl]) => fl.enc === 'u' && fl.max < 2 ** fl.width - 1)!;
  const src = Ns4Program.fromBytes(TEMPLATE_BYTES);
  const body = src.body;
  writeBits(body, f.bodyBit, f.width, 2 ** f.width - 1);
  const bytes = buildCbin(src.header, body);
  const { snapshot, notes } = importNs4p('Odd.ns4p', bytes);
  assert.equal(snapshot.values[key as never], f.max);
  assert.ok(notes.includes('1 value was out of range:'), notes.join(' | '));
  assert.ok(notes.includes(`${key}: ${2 ** f.width - 1} is outside ${f.min}..${f.max}, set to ${f.max}`), notes.join(' | '));
});

test('an older format and an unknown category are noted', () => {
  const src = Ns4Program.fromBytes(TEMPLATE_BYTES);
  const body = src.body;
  new DataView(body.buffer).setUint32(0, 307, false);
  const old = buildCbin({ ...src.header, version: 307, category: 99 }, body);
  const { snapshot, notes } = importNs4p('Old.ns4p', old);
  assert.equal(snapshot.source!.formatVersion, 307);
  assert.equal(snapshot.category, 17);
  assert.equal(notes[0], 'stage 4 program, format 3.07');
  assert.ok(notes.includes('category 99 is unknown; set to none'));
  assert.ok(notes.some((n) => /^format 3\.07 is older than 3\.13: the experimental stage 4 export starts from the neutral template/.test(n)));
});
