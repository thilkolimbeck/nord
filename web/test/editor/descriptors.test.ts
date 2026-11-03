/** Parameter descriptors: kinds, ranges, units, statuses and formatting (plan sections 3.1 and 3.2). */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NS4_LAYOUT } from '../../src/engine/layout.ts';
import { CURATED } from '../../src/editor/model/curated.ts';
import {
  clampValue, descriptorOf, DESCRIPTORS, formatValue, optionsFor, type ParamDescriptor, toSi, verified,
} from '../../src/editor/model/descriptors.ts';
import { initProgram } from '../../src/editor/model/init.ts';
import { expandPattern, LAYERS, NS4_KEYS, type Ns4Key } from '../../src/editor/model/keys.ts';
import type { ValueReader } from '../../src/editor/model/labels.ts';

const INIT = initProgram().values;
function reader(overrides: Readonly<Record<string, number>> = {}): ValueReader {
  return { get: (key) => overrides[key] ?? INIT[key] };
}
/** Synth region controls of one layer's own blocks (synthX, synthXSound), or of the section (layer null). */
const synthControls = (layer: 'A' | 'B' | 'C' | null): ParamDescriptor[] => [...DESCRIPTORS.values()]
  .filter((d) => d.region === 'synth' && (layer === null ? !/^synth[ABC]/.test(d.key) : d.key.startsWith(`synth${layer}`)));

test('one descriptor per layout field, in layout order, inside the layout range', () => {
  assert.deepEqual([...DESCRIPTORS.keys()], [...NS4_KEYS]);
  for (const d of DESCRIPTORS.values()) {
    const f = NS4_LAYOUT.fields.get(d.key)!;
    assert.ok(d.label.trim().length > 0, `${d.key} has no label`);
    assert.equal(d.label, d.label.toLowerCase(), `${d.key} label is not lowercase`);
    assert.ok(d.min <= d.default && d.default <= d.max, `${d.key} default outside range`);
    assert.ok(f.inRange(d.min) && f.inRange(d.max), `${d.key} range ${d.min}..${d.max} not storable`);
    assert.equal(d.width, f.width);
    if (d.enc !== 'raw') assert.deepEqual([d.min, d.max], [f.min, f.max], d.key);
    if (d.kind === 'continuous' && d.labelSource !== 'raw') assert.notEqual(d.unit, null, d.key);
    if (d.kind !== 'continuous') assert.equal(d.unit, null, d.key);
    if (d.kind === 'enum') assert.ok(d.options !== null || d.deps.length > 0, `${d.key} enum without options`);
    if (d.kind === 'mask') assert.ok(d.options !== null && d.options.length > 0, d.key);
    for (const o of d.options ?? []) {
      assert.ok(o.label.length > 0, d.key);
      if (d.kind !== 'mask') assert.ok(o.value >= d.min && o.value <= d.max, `${d.key} option ${o.value}`);
    }
  }
});

test('the MVP control set matches plan section 3.2', () => {
  for (const layer of LAYERS) {
    const controls = synthControls(layer);
    const count = (status: string): number => controls.filter((d) => d.status === status).length;
    assert.deepEqual([count('live'), count('unverified'), count('stored'), controls.length], [30, 14, 15, 59], layer);
  }
  // Section: on, layer mask, focus, level and pan of A, B and C (9 controls), 4 stored switches.
  const section = synthControls(null);
  assert.equal(section.filter((d) => d.status === 'stored').length, 4);
  assert.equal(section.filter((d) => d.status !== 'stored').length, 9);
  const kinds = Object.fromEntries(['synthASound.fltFreq', 'synthASound.fltType', 'synthASound.fltEnable',
    'synth.layerEnableSyn_I', 'synthASound.oscCat', 'synthA.smpNameHash', 'synthA.voiceMode', 'synthASound.fltRes']
    .map((k) => [k, descriptorOf(k as Ns4Key).kind]));
  assert.deepEqual(kinds, {
    'synthASound.fltFreq': 'continuous', 'synthASound.fltType': 'enum', 'synthASound.fltEnable': 'bool',
    'synth.layerEnableSyn_I': 'mask', 'synthASound.oscCat': 'enum', 'synthA.smpNameHash': 'opaque',
    'synthA.voiceMode': 'enum', 'synthASound.fltRes': 'continuous',
  });
});

test('statuses: synth controls curated, other regions layout, hidden synth data stored', () => {
  for (const d of DESCRIPTORS.values()) {
    if (d.region === null) {
      assert.equal(d.group, null);
      assert.ok(d.status === 'stored' || d.status === 'layout', d.key);
    } else if (d.region !== 'synth') {
      assert.equal(d.status, 'layout', d.key);
    } else {
      assert.notEqual(d.status, 'layout', d.key);
    }
    if (d.status === 'unverified' || d.status === 'stored') {
      if (d.region === 'synth') assert.ok(d.note !== null && d.note.length > 0, `${d.key} needs a note`);
    }
  }
  assert.equal(descriptorOf('synthASound.fltFreq.morphWheel').status, 'stored');
  assert.equal(descriptorOf('synthAFx.rvbAmt.morphWheel').status, 'layout');
  assert.equal(descriptorOf('synth.layerEnableSyn_II').status, 'stored');
  assert.equal(descriptorOf('organ.layerEnableOrg_II').status, 'layout');
});

test('every curated pattern names real fields, and its options fit them', () => {
  for (const [pattern, cur] of Object.entries(CURATED)) {
    for (const key of expandPattern(pattern)) {
      const f = NS4_LAYOUT.fields.get(key)!;
      for (const o of cur.options ?? []) {
        if (cur.kind === 'mask') assert.ok((o.value & (2 ** f.width - 1)) === o.value, `${key} bit ${o.value}`);
        else assert.ok(f.inRange(o.value), `${key} option ${o.value}`);
      }
      for (const value of Object.keys(cur.optionStatus ?? {})) assert.ok(f.inRange(Number(value)), key);
    }
  }
});

test('option status marks what the MVP cannot play', () => {
  const status = (key: Ns4Key, value: number): string | undefined =>
    descriptorOf(key).options!.find((o) => o.value === value)!.status;
  assert.equal(status('synthBSound.oscBank', 3), 'layout');
  assert.equal(status('synthBSound.oscBank', 1), 'unverified');
  assert.equal(status('synthBSound.oscBank', 0), undefined);
  assert.equal(status('synthCSound.fltType', 2), 'unverified');
  assert.equal(status('synthA.mode', 0), 'layout');
  assert.equal(status('organ.leslieStopPreset', 7), 'unverified');
});

test('morph amounts hang off their parent', () => {
  const d = descriptorOf('synthASound.fltFreq');
  assert.deepEqual(d.morphs, { wheel: 'synthASound.fltFreq.morphWheel',
    afterTouch: 'synthASound.fltFreq.morphAfterTouch', ctrlPedal: 'synthASound.fltFreq.morphCtrlPedal' });
  assert.equal([...DESCRIPTORS.values()].filter((x) => x.morphs !== null).length, 357 / 3);
  const m = descriptorOf('synthASound.fltFreq.morphWheel');
  assert.deepEqual([m.kind, m.labelSource, m.label, m.morphs], ['continuous', 'raw', 'freq · wheel morph', null]);
  assert.equal(formatValue(m, 40, reader()).text, '+40');
  assert.equal(formatValue(m, -3, reader()).text, '-3');
});

test('clampValue rounds and clamps to what the field holds', () => {
  const freq = descriptorOf('synthASound.fltFreq');
  assert.equal(clampValue(freq, -1), 0);
  assert.equal(clampValue(freq, 128), 127);
  assert.equal(clampValue(freq, 63.6), 64);
  assert.equal(clampValue(freq, 63.4), 63);
  assert.equal(clampValue(freq, Infinity), 127);
  assert.throws(() => clampValue(freq, Number.NaN), TypeError);
  const coarse = descriptorOf('synthASound.oscTuneCoarse');
  assert.deepEqual([clampValue(coarse, -25), clampValue(coarse, 25)], [-24, 24]);
  const hash = descriptorOf('synthA.smpNameHash');
  assert.deepEqual([hash.min, hash.max], [0, 2 ** 32 - 1]);
  assert.deepEqual([clampValue(hash, -1), clampValue(hash, 2 ** 32)], [0, 2 ** 32 - 1]);
  const dly = descriptorOf('synthA.vibDly');
  assert.equal(clampValue(dly, 0), 1);
});

test('formatValue shows the Stage 4 label, else the number with a marker', () => {
  const f = (key: Ns4Key, value: number, values: ValueReader = reader()) => formatValue(descriptorOf(key), value, values);
  assert.deepEqual(f('synthASound.fltFreq', 0), { text: '14 Hz', marker: null });
  assert.deepEqual(f('synthASound.fltFreq', 127), { text: '32 kHz', marker: null });
  assert.deepEqual(f('synthASound.ampEnvDcy', 127), { text: 'inf', marker: null });
  assert.deepEqual(f('synth.layerLevelSynA', 0), { text: 'volume off', marker: null });
  assert.deepEqual(f('synthASound.fltRes', 64), { text: '64', marker: 'raw' });
  assert.deepEqual(f('synth.layerPanSynB', 30), { text: '+30', marker: 'raw' });
  assert.deepEqual(f('synthA.octaveShift', 3), { text: '3', marker: 'not decoded' });
  assert.deepEqual(f('synthA.octaveShift', -1), { text: '-1', marker: null });
  assert.deepEqual(f('synthA.voiceMode', 2), { text: 'legato', marker: null });
  assert.deepEqual(f('synthASound.fltDrive', 0), { text: 'off', marker: null });
  assert.deepEqual(f('synth.layerEnableSyn_I', 5), { text: 'A+C', marker: null });
  assert.deepEqual(f('synth.layerEnableSyn_I', 0), { text: 'none', marker: null });
  assert.deepEqual(f('synthA.smpNameHash', 0x2eba2a), { text: '0x002eba2a', marker: 'raw' });
  assert.deepEqual(f('synthASound.oscCat', 1, reader({ 'synthASound.oscBank': 0 })), { text: '2 (SUB OSC)', marker: null });
  assert.deepEqual(f('synthASound.oscCat', 1, reader({ 'synthASound.oscBank': 1 })), { text: 'B', marker: null });
});

test('optionsFor follows the dependency fields', () => {
  const cat = descriptorOf('synthASound.oscCat');
  assert.equal(cat.options, null);
  assert.deepEqual([...cat.deps], ['synthASound.oscBank']);
  assert.deepEqual(optionsFor(cat, reader({ 'synthASound.oscBank': 0 })).map((o) => o.label),
    ['1 (PURE)', '2 (SUB OSC)', '3 (SYNC)', '4 (SHAPE)', '5 (SHAPE SINE)', '6 (MULTI)', '7 (SUPER)', '8 (MISC)']);
  assert.equal(optionsFor(cat, reader({ 'synthASound.oscBank': 3 })).length, 8);
  const wave = descriptorOf('synthASound.oscWave');
  assert.deepEqual([...wave.deps], ['synthASound.oscBank', 'synthASound.oscCat']);
  const analog = optionsFor(wave, reader({ 'synthASound.oscBank': 0, 'synthASound.oscCat': 0 }));
  assert.ok(analog.length > 0 && analog.length < 128);
  const zone = descriptorOf('synthB.kbZone');
  assert.ok(optionsFor(zone, reader()).length > 0);
  assert.deepEqual(optionsFor(descriptorOf('synthASound.fltType'), reader()).map((o) => o.label),
    ['LP12', 'LP24', 'LPM', 'LPHP', 'BP', 'HP']);
  assert.deepEqual(optionsFor(descriptorOf('synthASound.fltFreq'), reader()), []);
});

test('toSi gives base units for numeric labels only', () => {
  assert.equal(toSi(descriptorOf('synthASound.fltFreq'), 0, reader()), 14);
  assert.equal(toSi(descriptorOf('synthASound.fltFreq'), 127, reader()), 32000);
  assert.equal(toSi(descriptorOf('synthASound.ampEnvDcy'), 127, reader()), Infinity);
  assert.equal(toSi(descriptorOf('synthASound.oscEnvAtk'), 0, reader()), 0.5e-3);
  assert.equal(toSi(descriptorOf('synthASound.fltType'), 1, reader()), null);
  assert.equal(toSi(descriptorOf('synthASound.fltRes'), 64, reader()), null);
});

test('verified: live and labelled', () => {
  assert.ok(verified(descriptorOf('synthASound.fltFreq')));
  assert.ok(verified(descriptorOf('synthA.voiceMode')));
  assert.ok(!verified(descriptorOf('synthASound.fltRes')));
  assert.ok(!verified(descriptorOf('synthA.arpRun')));
  assert.ok(!verified(descriptorOf('organA.model')));
});
