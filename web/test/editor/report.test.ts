/**
 * The parameter report (plan section 5.5, AC 13): a fixed snapshot gives exactly the fixture
 * text; the report says it is not a program file, is neither JSON nor a CBIN container, and has a
 * .txt name. After a deliberate change of the report, write the new text to the fixture and read
 * the diff before committing it.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { TEMPLATE_BYTES } from '../../src/ns4/index.ts';
import { initProgram } from '../../src/editor/model/init.ts';
import { NS4_KEYS } from '../../src/editor/model/keys.ts';
import { ParamStore, type ProgramSnapshot } from '../../src/editor/model/store.ts';
import { importNs4p } from '../../src/editor/formats/ns4p-import.ts';
import { NOT_A_PROGRAM, parameterReport, reportFileName } from '../../src/editor/formats/report.ts';

const FIXTURE = new URL('./fixtures/report-expected.txt', import.meta.url);
const OPTS = { appVersion: '0.1.0', date: '2026-11-03' };

/** Edits across the panel: synth values with units, an unverified one, a value that is not implemented,
 * a stored-only switch, layout-only regions, a morph amount and a scene II copy. */
function fixedSnapshot(): ProgramSnapshot {
  const store = new ParamStore(initProgram());
  store.setMany([
    ['synth.layerEnableSyn_I', 0b011],
    ['synthASound.fltFreq', 74],
    ['synthASound.fltRes', 64],
    ['synthASound.ampEnvAtk', 40],
    ['synthASound.ampEnvRls', 60],
    ['synth.layerPanSynA', -20],
    ['synthA.arpRun', 1],
    ['common.pdlTapEnable', 1],
    ['synthB.mode', 0],
    ['synthBSound.oscBank', 3],
    ['synthBSound.oscTuneCoarse', -12],
    ['common.transposeEnable', 1],
    ['common.transposeValue', -2],
    ['organADrawbars.org_Preset_kDb1', 3],
    ['synthAFx.rvbEnable', 1],
    ['synthASound.fltFreq.morphWheel', 40],
    ['common.sectionEnableSyn_II', 1],
  ], 'ui');
  store.setName('Warm Pad');
  return { ...store.snapshot(), category: 5 };
}

test('a fixed snapshot gives the fixture text', () => {
  const text = parameterReport(fixedSnapshot(), initProgram(), OPTS);
  assert.equal(text, readFileSync(FIXTURE, 'utf8'));
});

test('it says it is not a program file and is neither JSON nor CBIN', () => {
  const text = parameterReport(fixedSnapshot(), initProgram(), OPTS);
  const lines = text.split('\n');
  assert.equal(lines[0], 'nord stage 4 parameter report, for reading only');
  assert.equal(lines[1], NOT_A_PROGRAM);
  assert.ok(/not a program file/.test(NOT_A_PROGRAM), NOT_A_PROGRAM);
  assert.throws(() => JSON.parse(text));
  assert.ok(!text.startsWith('CBIN'));
  assert.ok(!text.includes('ns4p\u0000'));
  assert.ok(/^[\n\u0020-\u007e\u00a0-\uffff]*$/.test(text), 'plain printable text');
  assert.equal(reportFileName('Warm Pad'), 'Warm Pad · parameter-report.txt');
  assert.equal(reportFileName('a/b'), 'a-b · parameter-report.txt');
  assert.ok(reportFileName('').endsWith('.txt'));
});

test('every changed value is listed once, unchanged values not at all', () => {
  const s = fixedSnapshot();
  const base = initProgram();
  const changed = NS4_KEYS.filter((k) => s.values[k] !== base.values[k]);
  const text = parameterReport(s, base, OPTS);
  assert.ok(text.endsWith(`\n${changed.length} changed values\n`), text.slice(-40));
  const body = text.split('\n').filter((l) => l.startsWith('  '));
  assert.equal(body.length, changed.length);
});

test('every field of the layout can appear: a snapshot that changes every field lists every one', () => {
  const base = initProgram();
  // Flip each field to another value in its range through the store (it clamps).
  const store = new ParamStore(base);
  for (const key of NS4_KEYS) {
    const v = base.values[key];
    store.set(key, v + 1);
    if (store.get(key) === v) store.set(key, v - 1);
  }
  const s = store.snapshot();
  const text = parameterReport(s, base, OPTS);
  const changed = NS4_KEYS.filter((k) => s.values[k] !== base.values[k]).length;
  // Only fields with a single allowed value (reserved bits) cannot change.
  assert.ok(changed >= NS4_KEYS.length - 5, `${changed} of ${NS4_KEYS.length}`);
  assert.equal(text.split('\n').filter((l) => l.startsWith('  ')).length, changed);
});

test('no change: says so; an opened file is named in the header', () => {
  assert.ok(/\nno value differs from the baseline\n$/.test(parameterReport(initProgram(), initProgram(), OPTS)), parameterReport(initProgram(), initProgram(), OPTS));
  const { snapshot } = importNs4p('Template.ns4p', TEMPLATE_BYTES);
  assert.ok(/\nopened from: Template\.ns4p \(format 3\.13\)\n/.test(parameterReport(snapshot, initProgram(), OPTS)), parameterReport(snapshot, initProgram(), OPTS));
});
