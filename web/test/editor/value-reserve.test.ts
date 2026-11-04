/**
 * The value cell's reserved width (ui/control-model.ts valueReserve) and the panel's short labels
 * (shortLabel): a control keeps the width of the longest value and markers it can show, over
 * every value and every value of the fields its labels depend on, so no row moves while a value
 * changes.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { coarsePatterns } from '../../src/editor/audio/mapping.ts';
import { descriptorOf, formatValue, type ParamDescriptor } from '../../src/editor/model/descriptors.ts';
import { initProgram } from '../../src/editor/model/init.ts';
import { LAYERS, type Ns4Key } from '../../src/editor/model/keys.ts';
import type { ValueReader } from '../../src/editor/model/labels.ts';
import { PANEL, keysOf } from '../../src/editor/model/sections.ts';
import { ParamStore } from '../../src/editor/model/store.ts';
import {
  controlKind, controlPattern, descriptionText, displayParamLine, isCoarse, MAY_BE_COARSE, morphAmountChars, morphRows,
  rangeText, shortLabel, spokenValue, valueReserve, valueView,
} from '../../src/editor/ui/control-model.ts';

const store = (): ParamStore => new ParamStore(initProgram());
const len = (s: string): number => [...s].length;

/** The widest text and markers over every value, by brute force through valueView, for the given dependency values. */
function widest(d: ParamDescriptor, values: ValueReader, coarse: boolean): { text: number; marks: number } {
  let text = 0;
  let marks = 0;
  for (let v = d.min; v <= d.max; v++) {
    const view = valueView(d, v, values, coarse);
    text = Math.max(text, len(view.text));
    marks = Math.max(marks, len(view.suffixes.join(' ')));
  }
  return { text, marks };
}

const withDeps = (base: ValueReader, deps: Readonly<Record<string, number>>): ValueReader =>
  ({ get: (k: Ns4Key) => (Object.hasOwn(deps, k) ? deps[k]! : base.get(k)) });

test('short labels: layer level off and transpose in semi; the Stage 4 wording stays for screen readers', () => {
  const s = store();
  assert.equal(shortLabel('volume off'), 'off');
  assert.equal(shortLabel('-6 semitones'), '-6 semi');
  assert.equal(shortLabel('0 semitones'), '0 semi');
  assert.equal(shortLabel('+/- 6 semitones'), '+/- 6 semitones', 'only a plain amount is shortened');
  assert.equal(shortLabel('-0.1 dB'), '-0.1 dB');
  for (const key of ['organ.layerLevelOrgA', 'piano.layerLevelPnoB', 'synth.layerLevelSynC'] as const) {
    const d = descriptorOf(key);
    assert.equal(formatValue(d, 0, s).text, 'volume off', 'the table keeps its label');
    assert.equal(valueView(d, 0, s).text, 'off', key);
    assert.equal(spokenValue(d, 0, s), 'volume off', key);
    assert.equal(rangeText(d, s), 'off–0.0 dB');
    assert.ok(descriptionText(d, 0, s).startsWith('range volume off–0.0 dB'), key);
  }
  const transpose = descriptorOf('common.transposeValue');
  assert.equal(valueView(transpose, -6, s).text, '-6 semi');
  assert.equal(spokenValue(transpose, -6, s), '-6 semitones');
  assert.equal(displayParamLine(transpose, -6, s), 'program · transpose · -6 semi · -6 semi–6 semi');
  // A morph end value that reaches the bottom of a layer level shows the short form too.
  s.set('synth.layerLevelSynA', 10);
  s.set('synth.layerLevelSynA.morphWheel', -127);
  const wheel = morphRows(descriptorOf('synth.layerLevelSynA'), s)[0]!;
  assert.equal(wheel.endText, '→ off');
  assert.equal(wheel.endSpoken, 'volume off');
});

test('the reserve covers every value: layer level, transpose, delay rate, amp mid', () => {
  const s = store();
  assert.deepEqual(valueReserve(descriptorOf('organ.layerLevelOrgA')), { text: '-84.2 dB'.length, marks: 0 });
  assert.deepEqual(valueReserve(descriptorOf('common.transposeValue')), { text: '-6 semi'.length, marks: 0 });
  for (const key of ['organFx.dlyRateClkDiv', 'synthBFx.ampMid', 'synth.layerLevelSynA'] as const) {
    const d = descriptorOf(key);
    const r = valueReserve(d);
    const off = widest(d, withDeps(s, Object.fromEntries(d.deps.map((k) => [k, 0]))), false);
    const on = widest(d, withDeps(s, Object.fromEntries(d.deps.map((k) => [k, 1]))), false);
    assert.deepEqual(r, { text: Math.max(off.text, on.text), marks: Math.max(off.marks, on.marks) }, key);
  }
});

test('a field whose labels follow another field reserves for every value of that field', () => {
  const s = store();
  // The fx unit 1 rate: Hz, bpm divisions or 'sens' by the effect type and the clock switch.
  const d = descriptorOf('synthAFx.fx1RateClkDiv');
  assert.deepEqual(d.deps, ['synthAFx.fx1Type', 'synthAFx.fx1ClkEnable']);
  let text = 0;
  let marks = 0;
  for (let type = 0; type <= descriptorOf('synthAFx.fx1Type').max; type++) {
    for (const clk of [0, 1]) {
      const w = widest(d, withDeps(s, { 'synthAFx.fx1Type': type, 'synthAFx.fx1ClkEnable': clk }), false);
      text = Math.max(text, w.text);
      marks = Math.max(marks, w.marks);
    }
  }
  const r = valueReserve(d);
  assert.deepEqual(r, { text, marks });
  assert.ok(r.text > widest(d, s, false).text, 'wider than the values of the current effect type alone');
  // The arp rate follows the layer's master clock switch.
  const arp = descriptorOf('synthA.arpRateClkDiv');
  const clk = [0, 1].map((v) => widest(arp, withDeps(s, { 'synthA.arpClkEnable': v }), false));
  assert.deepEqual(valueReserve(arp), { text: Math.max(...clk.map((w) => w.text)), marks: Math.max(...clk.map((w) => w.marks)) });
});

test('a field the engine can mark coarse reserves the coarse marker, before it is set', () => {
  const drive = descriptorOf('synthASound.fltDrive');
  assert.ok(isCoarse(drive));
  assert.equal(controlKind(drive), 'select');
  assert.deepEqual(valueReserve(drive), { text: 0, marks: 'nv coarse'.length }, 'a select keeps only its markers');
  const type = descriptorOf('synthBSound.fltType');
  assert.ok(!isCoarse(type), 'not coarse until the engine says so');
  assert.ok(valueReserve(type).marks >= 'coarse'.length);
  const ctrl = descriptorOf('synthCSound.oscCtrl');
  assert.equal(controlKind(ctrl), 'fader');
  assert.equal(valueReserve(ctrl).marks, len(valueView(ctrl, 0, store(), true).suffixes.join(' ')));
  // Every pattern the engine can mark coarse is known to the reserve.
  const s = store();
  const states: Array<Readonly<Record<string, number>>> = [{}, { 'synthASound.fltType': 2 }];
  for (let bank = 0; bank <= descriptorOf('synthASound.oscBank').max; bank++) {
    for (let cat = 0; cat <= descriptorOf('synthASound.oscCat').max; cat++) {
      states.push({ 'synthASound.oscBank': bank, 'synthASound.oscCat': cat, 'synthASound.oscEnvDst': 0, 'synthASound.oscEnvAmt': 10 });
    }
  }
  for (const st of states) for (const p of coarsePatterns(withDeps(s, st), 'A')) assert.ok(MAY_BE_COARSE.has(p), p);
});

test('selects and masks reserve only markers; keys and faders their text', () => {
  assert.equal(valueReserve(descriptorOf('synth.layerEnableSyn_I')).text, 0);
  assert.equal(valueReserve(descriptorOf('common.splitPosLow')).text, 0);
  assert.deepEqual(valueReserve(descriptorOf('common.transposeEnable')), { text: 'off'.length, marks: 0 });
  // 32-bit hashes are not walked: ten digits.
  assert.equal(valueReserve(descriptorOf('pianoA.nameHash')).text, 10);
});

test('one reserve per control pattern, whatever layer, scene or effects block a control is bound to', () => {
  for (const [a, b] of [['synthASound.fltFreq', 'synthCSound.fltFreq'], ['organFx.dlyMix', 'synthBFx.dlyMix'],
    ['organ.layerLevelOrgA', 'organ.layerLevelOrgB'], ['common.sectionEnableOrg_I', 'common.sectionEnableOrg_II']] as const) {
    assert.equal(controlPattern(a), controlPattern(b));
    assert.equal(valueReserve(descriptorOf(a)), valueReserve(descriptorOf(b)), `${a} ${b}`);
  }
});

test('every panel control: the shown text never outgrows its reserve, over random programs', () => {
  let seed = 7;
  const rand = (): number => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    return seed / 2 ** 31;
  };
  const keys = PANEL.filter((r) => r.status === 'live').flatMap((r) => r.groups.flatMap((g) => LAYERS.flatMap((l) => keysOf(g, l))));
  const unique = [...new Set(keys)].filter((k) => descriptorOf(k).kind !== 'opaque');
  for (let round = 0; round < 20; round++) {
    const s = store();
    for (const k of unique) {
      const d = descriptorOf(k);
      s.set(k, d.min + Math.floor(rand() * (d.max - d.min + 1)));
    }
    for (const k of unique) {
      const d = descriptorOf(k);
      const r = valueReserve(d);
      const view = valueView(d, s.get(k), s, isCoarse(d) || MAY_BE_COARSE.has(controlPattern(k)));
      if (r.text > 0) assert.ok(len(view.text) <= r.text, `${k}: '${view.text}' > ${r.text}`);
      assert.ok(len(view.suffixes.join(' ')) <= r.marks, `${k}: '${view.suffixes.join(' ')}' > ${r.marks}`);
    }
  }
});

test('morph rows reserve their widest amount', () => {
  assert.equal(morphAmountChars(-127, 127), 4);
  assert.equal(morphAmountChars(-16383, 16383), 6);
  assert.equal(morphAmountChars(-1, 1), 2);
});
