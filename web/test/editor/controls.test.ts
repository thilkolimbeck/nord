/** What controls show, without the DOM (ui/control-model.ts): kinds, value text and markers, range, description, morphs, rebinding. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DESCRIPTORS, descriptorOf } from '../../src/editor/model/descriptors.ts';
import { initProgram } from '../../src/editor/model/init.ts';
import { LAYERS, type Ns4Key } from '../../src/editor/model/keys.ts';
import { keysOf, PANEL } from '../../src/editor/model/sections.ts';
import { ParamStore } from '../../src/editor/model/store.ts';
import {
  controlKind, descriptionText, displayParamLine, displayStateLine, keyForLayer, morphAmounts, morphLabel, optionText,
  rangeText, valueView,
} from '../../src/editor/ui/control-model.ts';

const store = (): ParamStore => new ParamStore(initProgram());
const synth = PANEL.find((r) => r.id === 'synth')!;

test('every synth control has a working kind; layout regions are readouts', () => {
  for (const g of synth.groups) {
    for (const key of keysOf(g, 'A')) {
      const d = descriptorOf(key);
      assert.notEqual(controlKind(d), 'readout', key);
      assert.ok(d.label.length > 0, key);
    }
  }
  for (const r of PANEL.filter((x) => x.status === 'layout')) {
    for (const g of r.groups) for (const key of keysOf(g, null)) assert.equal(controlKind(descriptorOf(key)), 'readout', key);
  }
  // Live organ, piano and program regions: every field has a working control, except the read-only
  // program groups and the piano model hash (drawn by its own model select).
  for (const r of PANEL.filter((x) => x.status === 'live' && x.id !== 'synth')) {
    for (const g of r.groups) {
      for (const key of keysOf(g, null)) {
        const readOnly = ['presets', 'aux-kb', 'output'].includes(g.id) || key.endsWith('.nameHash');
        assert.equal(controlKind(descriptorOf(key)) === 'readout', readOnly, key);
      }
    }
  }
  assert.equal(controlKind(descriptorOf('synthASound.fltFreq')), 'fader');
  assert.equal(controlKind(descriptorOf('synthASound.fltType')), 'select');
  assert.equal(controlKind(descriptorOf('synthASound.fltEnable')), 'key');
  assert.equal(controlKind(descriptorOf('synth.layerEnableSyn_I')), 'mask');
  assert.equal(controlKind(descriptorOf('synthA.mode')), 'select', 'samples carries a not-implemented marker');
});

test('a live value shows the Stage 4 label with its unit and no markers', () => {
  const s = store();
  const d = descriptorOf('synthASound.fltFreq');
  assert.deepEqual(valueView(d, 127, s),
    { text: '32 kHz', nv: false, coarse: false, stored: false, approx: false, suffixes: [] });
  assert.equal(rangeText(d, s), '14 Hz–32 kHz');
  assert.equal(descriptionText(d, 127, s), 'range 14 Hz–32 kHz');
});

test('unverified, stored and coarse values carry their markers and notes', () => {
  const s = store();
  const res = descriptorOf('synthASound.fltRes');
  assert.deepEqual(valueView(res, 64, s).suffixes, ['nv']);
  assert.equal(descriptionText(res, 64, s), `range 0–127. not verified: ${res.note!}`);

  const arp = descriptorOf('synthA.arpRun');
  const v = valueView(arp, 0, s);
  assert.deepEqual([v.text, v.stored, v.nv], ['off', true, false]);
  assert.ok(/^range off–on\. no sound in MVP: /.test(descriptionText(arp, 0, s)));

  const drive = descriptorOf('synthASound.fltDrive');
  assert.deepEqual(valueView(drive, 2, s).suffixes, ['nv', 'coarse']);
  assert.ok(/coarse: /.test(descriptionText(drive, 2, s)));
  assert.deepEqual(valueView(drive, 2, s, false).suffixes, ['nv'], 'the engine can switch coarse off');
});

test('a value without a Stage 4 label is not verified, even on a live field', () => {
  const s = store();
  const wave = descriptorOf('synthASound.oscWave');
  const v = valueView(wave, 127, s);
  assert.deepEqual([v.text, v.nv], ['127', true]);
  assert.ok(/not verified: /.test(descriptionText(wave, 127, s)));
});

test('enum options name their status', () => {
  assert.equal(optionText({ value: 3, label: '4 (WAVE)', status: 'layout' }), '4 (WAVE) · not implemented');
  assert.equal(optionText({ value: 2, label: 'LP M', status: 'unverified' }), 'LP M · nv');
  assert.equal(optionText({ value: 0, label: 'LP12' }), 'LP12');
  const bank = descriptorOf('synthASound.oscBank');
  assert.deepEqual(bank.options!.map(optionText).at(-1), '4 (WAVE) · not implemented');
});

test('ranges of enums, switches and masks use their labels', () => {
  const s = store();
  assert.equal(rangeText(descriptorOf('synthASound.fltType'), s), 'LP12–HP');
  assert.equal(rangeText(descriptorOf('synthASound.fltEnable'), s), 'off–on');
  assert.equal(rangeText(descriptorOf('synth.layerEnableSyn_I'), s), 'none–A+B+C');
  assert.ok(/^1 \(PURE\)–/.test(rangeText(descriptorOf('synthASound.oscCat'), s)), 'dependency table: options of the current bank');
});

test('every synth control has a non-empty description with its range', () => {
  const s = store();
  for (const g of synth.groups) {
    for (const key of keysOf(g, 'B')) {
      const d = descriptorOf(key);
      assert.ok(/^range \S/.test(descriptionText(d, s.get(key), s)), key);
    }
  }
});

test('the morph indicator lists the non-zero amounts', () => {
  const s = store();
  const d = descriptorOf('synthASound.fltFreq');
  assert.equal(morphLabel(morphAmounts(d, s, descriptorOf)), null);
  s.set('synthASound.fltFreq.morphWheel', 40);
  s.set('synthASound.fltFreq.morphAfterTouch', -3);
  assert.equal(morphLabel(morphAmounts(d, s, descriptorOf)), 'morph: wheel +40, aftertouch -3');
  assert.deepEqual(morphAmounts(descriptorOf('synthASound.fltType'), s, descriptorOf), []);
});

test('rebinding maps a layer key to the focused layer and leaves common keys alone', () => {
  assert.equal(keyForLayer('synthASound.fltFreq', 'C'), 'synthCSound.fltFreq');
  assert.equal(keyForLayer('synthB.voiceMode', 'A'), 'synthA.voiceMode');
  assert.equal(keyForLayer('synth.layerLevelSynA', 'B'), 'synth.layerLevelSynB');
  assert.equal(keyForLayer('synth.multiLayerFlt', 'C'), 'synth.multiLayerFlt');
  assert.equal(keyForLayer('common.sectionEnableSyn_I', 'B'), 'common.sectionEnableSyn_I');
  for (const g of synth.groups) {
    for (const layer of LAYERS) {
      const fromA = keysOf(g, 'A').map((k) => keyForLayer(k, layer));
      assert.deepEqual(fromA, keysOf(g, layer), `${g.id} → ${layer}`);
      for (const k of fromA) assert.ok(DESCRIPTORS.has(k as Ns4Key));
    }
  }
});

test('display lines name layer, label, value, range, status and edits', () => {
  const s = store();
  const freq = descriptorOf('synthBSound.fltFreq');
  assert.equal(displayParamLine(freq, 127, s), 'b · freq · 32 kHz · 14 Hz–32 kHz');
  assert.equal(displayParamLine(descriptorOf('synthASound.fltRes'), 10, s), 'a · res · 10 nv · 0–127');
  assert.equal(displayParamLine(descriptorOf('common.sectionEnableSyn_I'), 1, s), 'synth · synth on · on · off–on');
  assert.equal(displayStateLine(freq, 127, s, 2), 'live · edited 2');
  assert.equal(displayStateLine(descriptorOf('synthASound.fltRes'), 10, s, 0), 'not verified · edited 0');
  assert.equal(displayStateLine(descriptorOf('synthA.arpRun'), 0, s, 1), 'no sound in MVP · edited 1');
  assert.equal(displayStateLine(null, 0, s, 0), 'edited 0');
});
