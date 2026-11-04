/**
 * The morph editor's logic (plan sections 15.2 and 15.9), without the DOM: the three rows of a
 * field, their ranges and end values, the key's accessible name, the display line while an amount
 * is edited, and writes that follow the synth and effects groups.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setFxGroup } from '../../src/editor/model/actions.ts';
import { descriptorOf } from '../../src/editor/model/descriptors.ts';
import { initProgram } from '../../src/editor/model/init.ts';
import { MORPH_PARENTS } from '../../src/editor/model/morph.ts';
import { ParamStore } from '../../src/editor/model/store.ts';
import {
  displayParamLine, displayStateLine, morphEndText, morphKeyLabel, morphRows, writeControl,
} from '../../src/editor/ui/control-model.ts';

const store = (): ParamStore => new ParamStore(initProgram());

test('three rows per field: wheel, a.t., ctrl ped, signed ranges of the layout', () => {
  const s = store();
  const rows = morphRows(descriptorOf('synthASound.fltFreq'), s);
  assert.deepEqual(rows.map((r) => [r.label, r.key, r.min, r.max, r.amountText]), [
    ['wheel', 'synthASound.fltFreq.morphWheel', -127, 127, '0'],
    ['a.t.', 'synthASound.fltFreq.morphAfterTouch', -127, 127, '0'],
    ['ctrl ped', 'synthASound.fltFreq.morphCtrlPedal', -127, 127, '0'],
  ]);
  const drawbar = morphRows(descriptorOf('organADrawbars.org_Preset_kDb2'), s);
  assert.deepEqual([drawbar[0]!.min, drawbar[0]!.max], [-8, 8]);
  const delay = morphRows(descriptorOf('pianoBFx.dlyRateClkDiv'), s);
  assert.deepEqual([delay[0]!.min, delay[0]!.max], [-16383, 16383]);
  const speed = morphRows(descriptorOf('organ.effectsLeslieSpeed'), s);
  assert.deepEqual([speed[0]!.min, speed[0]!.max], [-1, 1]);
});

test('every morphable field has rows (119 fields, 357 amounts), all not verified', () => {
  const s = store();
  assert.equal(MORPH_PARENTS.length, 119);
  for (const parent of MORPH_PARENTS) {
    const rows = morphRows(descriptorOf(parent), s);
    assert.equal(rows.length, 3, parent);
    for (const r of rows) assert.equal(descriptorOf(r.key).status, 'unverified', r.key);
  }
});

test('the end value: where one source at full travel takes the field (M p.38)', () => {
  const s = store();
  const freq = descriptorOf('synthASound.fltFreq');
  s.set('synthASound.fltFreq', 60);
  s.set('synthASound.fltFreq.morphWheel', 40);
  const wheel = morphRows(freq, s)[0]!;
  assert.equal(wheel.amountText, '+40');
  const start = displayParamLine(freq, 60, s).split(' · ')[2]!;
  assert.ok(wheel.endText.startsWith('→ '));
  assert.notEqual(wheel.endText, `→ ${start}`);
  assert.equal(morphEndText(freq, 'wheel', s), `${start} → ${wheel.endText.slice(2)}`);
  // Clamped at the field's end.
  s.set('synthASound.fltFreq.morphAfterTouch', 127);
  assert.equal(morphRows(freq, s)[1]!.endText, `→ ${displayParamLine(freq, 127, s).split(' · ')[2]}`);
});

test('the m key names the amounts that are set', () => {
  const s = store();
  const d = descriptorOf('synth.layerLevelSynB');
  assert.equal(morphKeyLabel(d, s), 'morph: none set');
  s.set('synth.layerLevelSynB.morphCtrlPedal', -12);
  s.set('synth.layerLevelSynB.morphWheel', 3);
  assert.equal(morphKeyLabel(d, s), 'morph: wheel +3, ctrl ped -12');
});

test('the display shows layer, field, source, amount and start → end while an amount is edited', () => {
  const s = store();
  s.set('synthBSound.fltFreq.morphWheel', 40);
  const line = displayParamLine(descriptorOf('synthBSound.fltFreq.morphWheel'), 40, s);
  assert.ok(/^b · freq · wheel morph · \+40 nv · \S+ k?Hz → \S+ k?Hz$/.test(line), line);
  const organ = displayParamLine(descriptorOf('organBDrawbars.org_Preset_kDb4.morphCtrlPedal'), 0, s);
  assert.ok(/^organ b · drawbar 4 · ctrl pedal morph · 0 nv · \d → \d$/.test(organ), organ);
  const fx = displayParamLine(descriptorOf('organFx.rvbAmt.morphAfterTouch'), 0, s);
  assert.ok(/^organ fx · reverb · dry\/wet · aftertouch morph · 0 nv · /.test(fx), fx);
  assert.equal(displayStateLine(descriptorOf('synthBSound.fltFreq.morphWheel'), 40, s, 1), 'not verified · edited 1');
});

test('writing an amount follows the synth group and the effects group', () => {
  const s = store();
  s.set('synth.multiLayerFlt', 1);
  writeControl(s, descriptorOf('synthCSound.fltRes.morphWheel'), 25);
  assert.deepEqual(['A', 'B', 'C'].map((l) => s.get(`synth${l}Sound.fltRes.morphWheel` as 'synthASound.fltRes.morphWheel')),
    [25, 25, 25]);
  setFxGroup(s, 'piano', true);
  writeControl(s, descriptorOf('pianoBFx.ampDrive.morphWheel'), -9);
  assert.equal(s.get('pianoAFx.ampDrive.morphWheel'), -9);
  writeControl(s, descriptorOf('organ.layerLevelOrgA.morphWheel'), 200);
  assert.equal(s.get('organ.layerLevelOrgA.morphWheel'), 127, 'clamped to the amount range');
});
