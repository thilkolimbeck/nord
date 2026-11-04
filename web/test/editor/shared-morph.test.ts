/**
 * Plan section 15.2, model/morph.ts (shared, frozen): which fields carry morphs, the effective
 * value base + Σ amount × position (rounded, clamped), the continuous rotary speed, end points for
 * editing, and MorphedValues as the engines' reader: moving a source yields 'morph' changes of the
 * fields it moves, a morph amount edit yields its field, panic rests every source.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DESCRIPTORS } from '../../src/editor/model/descriptors.ts';
import { initProgram } from '../../src/editor/model/init.ts';
import { NS4_KEYS } from '../../src/editor/model/keys.ts';
import {
  activeMorphs, amountForEnd, effectiveFraction, effectiveValue, hasMorphs, MORPH_PARENTS, MORPH_SOURCES, morphEnd,
  morphKey, MorphedValues, morphRange, morphTarget, positionOf, REST, SOURCE_OF_CONTROLLER,
} from '../../src/editor/model/morph.ts';
import { ParamStore } from '../../src/editor/model/store.ts';

test('119 fields carry three morph amounts each: the 357 morph fields of the layout', () => {
  assert.equal(MORPH_PARENTS.length, 119);
  const amounts = NS4_KEYS.filter((k) => /\.morph(?:Wheel|AfterTouch|CtrlPedal)$/.test(k));
  assert.equal(amounts.length, 357);
  for (const k of amounts) {
    const t = morphTarget(k);
    assert.ok(t !== null, k);
    assert.equal(morphKey(t.parent, t.source), k);
  }
  assert.ok(hasMorphs('synthASound.fltFreq'));
  assert.ok(hasMorphs('organ.effectsLeslieSpeed'));
  assert.ok(!hasMorphs('synthASound.fltType'));
  assert.equal(morphTarget('synthASound.fltFreq'), null);
  assert.deepEqual(morphRange('synthAFx.dlyRateClkDiv'), { min: -16383, max: 16383 });
  assert.deepEqual(morphRange('organADrawbars.org_Preset_kDb1'), { min: -8, max: 8 });
  assert.deepEqual(SOURCE_OF_CONTROLLER, { wheel: 'wheel', pressure: 'afterTouch', pedal: 'ctrlPedal' });
});

test('effective value: base plus amount × position per source, rounded and clamped to the field', () => {
  const s = new ParamStore(initProgram());
  const f = 'synthASound.fltFreq';
  s.setMany([[f, 60], [morphKey(f, 'wheel'), 40], [morphKey(f, 'ctrlPedal'), -20]], 'ui');
  assert.equal(effectiveValue(s, f, REST), 60);
  assert.equal(effectiveValue(s, f, { ...REST, wheel: 1 }), 100);
  assert.equal(effectiveValue(s, f, { ...REST, wheel: 0.5 }), 80);
  assert.equal(effectiveValue(s, f, { wheel: 1, afterTouch: 1, ctrlPedal: 1 }), 80);
  s.set(morphKey(f, 'wheel'), 127);
  assert.equal(effectiveValue(s, f, { ...REST, wheel: 1 }), 127, 'clamped at the field max');
  s.set(morphKey(f, 'ctrlPedal'), -127);
  assert.equal(effectiveValue(s, f, { ...REST, ctrlPedal: 1 }), 0, 'clamped at the field min');
  assert.equal(effectiveValue(s, 'synthASound.fltType', { ...REST, wheel: 1 }), s.get('synthASound.fltType'));
  assert.deepEqual(activeMorphs(s, f), ['wheel', 'ctrlPedal']);
});

test('signed fields and the continuous rotary speed', () => {
  const s = new ParamStore(initProgram());
  const amt = 'synthASound.oscEnvAmt';
  s.setMany([[amt, -30], [morphKey(amt, 'afterTouch'), 120]], 'ui');
  assert.equal(effectiveValue(s, amt, { ...REST, afterTouch: 1 }), 60, 'clamped at +60');
  assert.equal(effectiveValue(s, amt, { ...REST, afterTouch: 0.25 }), 0);
  const speed = 'organ.effectsLeslieSpeed';
  s.setMany([[speed, 0], [morphKey(speed, 'wheel'), 1]], 'ui');
  assert.equal(effectiveFraction(s, speed, { ...REST, wheel: 0.3 }), 0.3);
  assert.equal(effectiveValue(s, speed, { ...REST, wheel: 0.3 }), 0);
  assert.equal(effectiveValue(s, speed, { ...REST, wheel: 0.6 }), 1);
});

test('end points: what a source reaches at full travel, and the amount for a wanted end', () => {
  const s = new ParamStore(initProgram());
  const lvl = 'synth.layerLevelSynA';
  s.set(lvl, 100);
  assert.equal(morphEnd(s, lvl, 'wheel'), 100);
  const amount = amountForEnd(s, lvl, 'wheel', 40);
  assert.equal(amount, -60);
  s.set(morphKey(lvl, 'wheel'), amount);
  assert.equal(morphEnd(s, lvl, 'wheel'), 40);
  assert.equal(amountForEnd(s, lvl, 'wheel', 500), 27, 'the end is clamped to the field first');
  const db = 'organADrawbars.org_Preset_kDb1';
  s.set(db, 8);
  assert.equal(amountForEnd(s, db, 'ctrlPedal', 0), -8);
});

test('positions from 7-bit controller values', () => {
  assert.equal(positionOf(0), 0);
  assert.equal(positionOf(127), 1);
  assert.equal(positionOf(64), 64 / 127);
  assert.equal(positionOf(-3), 0);
  assert.equal(positionOf(500), 1);
  assert.equal(positionOf(Number.NaN), 0);
});

test('MorphedValues: the engines read effective values; a move yields morph changes of the moved fields', () => {
  const s = new ParamStore(initProgram());
  const f = 'synthBSound.fltFreq';
  const lvl = 'piano.layerLevelPnoA';
  s.setMany([[f, 50], [morphKey(f, 'wheel'), 20], [lvl, 100], [morphKey(lvl, 'afterTouch'), -50]], 'ui');
  const m = new MorphedValues(s);
  assert.equal(m.get(f), 50);
  const wheel = m.move('wheel', 1);
  assert.deepEqual(wheel, [{ key: f, value: 70, previous: 50, origin: 'morph' }]);
  assert.equal(m.get(f), 70);
  assert.equal(s.get(f), 50, 'the store keeps the stored value');
  assert.deepEqual(m.move('wheel', 1), [], 'no move, no change');
  assert.deepEqual(m.move('afterTouch', 0.5).map((c) => [c.key, c.value]), [[lvl, 75]]);
  assert.deepEqual(m.positions, { wheel: 1, afterTouch: 0.5, ctrlPedal: 0 });
  const rest = m.rest().map((c) => `${c.key} ${c.previous}→${c.value}`).sort();
  assert.deepEqual(rest, [`${lvl} 75→100`, `${f} 70→50`].sort());
  assert.equal(m.get(f), 50);
  assert.equal(m.get(lvl), 100);
  assert.deepEqual(m.positions, REST);
});

test('MorphedValues.expand: a morph amount edit while its source is off rest adds its field', () => {
  const s = new ParamStore(initProgram());
  const f = 'synthASound.lfoAmt';
  const m = new MorphedValues(s);
  let last: readonly unknown[] = [];
  s.onChange((batch) => {
    last = m.expand(batch);
  });
  s.set(morphKey(f, 'ctrlPedal'), 30);
  assert.equal(last.length, 1, 'pedal at rest: the amount alone');
  m.move('ctrlPedal', 1);
  s.set(morphKey(f, 'ctrlPedal'), 40);
  assert.deepEqual(last.at(-1), { key: f, value: Math.min(127, s.get(f) + 40), previous: Math.min(127, s.get(f) + 40), origin: 'morph' });
  s.load(initProgram(), 'load');
  assert.ok((last as Array<{ origin: string }>).every((c) => c.origin === 'load'), 'a load passes unchanged');
});

test('every source and every amount field is covered by a descriptor range', () => {
  for (const parent of MORPH_PARENTS) {
    for (const source of MORPH_SOURCES) {
      const d = DESCRIPTORS.get(morphKey(parent, source))!;
      assert.ok(d.min < 0 && d.max > 0, `${parent} ${source}`);
      assert.equal(d.min, -d.max);
    }
  }
});
