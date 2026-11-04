/**
 * Plan section 15.1, model/fx.ts (shared, frozen): the six effects blocks and their 32 fields, the
 * effects switches, FX focus (assumed order organ, piano, synth), group and global mode.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DELAY_DIVISIONS, DELAY_STEPS, delayFreeSeconds, FX_BLOCKS, FX_COMMON_KEYS, FX_PARAMS, FX_UNIT_PARAMS, FX_UNITS,
  fxBlockOf, fxBlocksOf, fxDivisionOf, fxDivisionSeconds, fxEnabled, fxFocusBlock, fxFocusEntries, fxGlobalOn,
  fxGroupOn, fxKey, fxLayersOf, fxSectionOf, MOD1_DIVISIONS, mod1FreeHz, mod2RateHz, parseFxKey, ringModHz,
} from '../../src/editor/model/fx.ts';
import { initProgram } from '../../src/editor/model/init.ts';
import { NS4_KEYS } from '../../src/editor/model/keys.ts';
import { PANEL } from '../../src/editor/model/sections.ts';
import { ParamStore } from '../../src/editor/model/store.ts';

test('32 fields per block, six blocks: the effects keys of the layout, morphs aside', () => {
  assert.equal(FX_PARAMS.length, 32);
  assert.equal(new Set(FX_PARAMS).size, 32);
  assert.deepEqual(FX_UNITS, Object.keys(FX_UNIT_PARAMS));
  const layout = NS4_KEYS.filter((k) => parseFxKey(k) !== null && !k.includes('.morph'));
  assert.equal(layout.length, 6 * 32);
  for (const b of FX_BLOCKS) for (const p of FX_PARAMS) assert.ok(layout.includes(fxKey(b, p)));
  // The effects region of sections.ts lists the same fields.
  const region = PANEL.find((r) => r.id === 'effects')!;
  const synthFx = region.groups.find((g) => g.id === 'synth-fx')!;
  assert.deepEqual(new Set(synthFx.keys.map((k) => k.slice(k.indexOf('.') + 1))), new Set(FX_PARAMS));
  const common = region.groups.find((g) => g.id === 'fx-global')!;
  assert.deepEqual(new Set(common.keys), new Set(FX_COMMON_KEYS));
});

test('blocks, sections and layers', () => {
  assert.equal(fxBlockOf('organ', 'B'), 'organFx');
  assert.equal(fxBlockOf('piano', 'B'), 'pianoBFx');
  assert.equal(fxBlockOf('synth', 'C'), 'synthCFx');
  assert.deepEqual(fxBlocksOf('synth'), ['synthAFx', 'synthBFx', 'synthCFx']);
  assert.equal(fxSectionOf('pianoAFx'), 'piano');
  assert.deepEqual(fxLayersOf('organFx'), ['A', 'B']);
  assert.deepEqual(fxLayersOf('synthBFx'), ['B']);
  assert.deepEqual(parseFxKey('synthBFx.dlyMix.morphWheel'), { block: 'synthBFx', param: 'dlyMix' });
  assert.equal(parseFxKey('synthBSound.fltFreq'), null);
  assert.throws(() => fxKey('organFx', 'nope' as never));
});

test('FX focus: section 0 organ, 1 piano, 2 synth (assumed), then the section layer focus', () => {
  const s = new ParamStore(initProgram());
  for (const block of FX_BLOCKS) {
    s.setMany(fxFocusEntries(block), 'ui');
    assert.equal(fxFocusBlock(s), block);
  }
  const odd = { get: (k: string) => (k === 'common.fxSectionFocus' ? 2 : k === 'synth.fxLayerFocusSyn' ? 3 : 0) };
  assert.equal(fxFocusBlock(odd), 'synthAFx', 'an out-of-range layer focus counts as the first layer');
  assert.equal(fxFocusBlock({ get: () => 7 }), 'organFx', 'an out-of-range section focus counts as the organ');
});

test('switches: layer effects on, group and global mode', () => {
  const s = new ParamStore(initProgram());
  assert.equal(fxEnabled(s), true, 'layout default on');
  assert.equal(fxGroupOn(s, 'synth'), true, 'layout default 1 = group (assumed)');
  assert.equal(fxGroupOn(s, 'organ'), false);
  s.set('synth.effectsSectionModeSyn', 0);
  assert.equal(fxGroupOn(s, 'synth'), false);
  assert.equal(fxGlobalOn(s, 'reverb'), false);
  s.set('common.effectsRvbGlobal', 1);
  assert.equal(fxGlobalOn(s, 'reverb'), true);
  assert.equal(fxGlobalOn(s, 'mod1'), false, 'mod 1 has no global mode');
});

test('rates and times: free curves, division lists and their steps (assumed, nv)', () => {
  assert.equal(MOD1_DIVISIONS.length, 13);
  assert.deepEqual(DELAY_DIVISIONS.map((d) => d.label).slice(0, 3), ['1/32', '1/16T', '1/16']);
  for (let i = 1; i < DELAY_DIVISIONS.length; i++) {
    assert.ok(DELAY_DIVISIONS[i]!.beats >= DELAY_DIVISIONS[i - 1]!.beats, 'short to long');
  }
  assert.equal(fxDivisionOf(11008, DELAY_STEPS, DELAY_DIVISIONS).label, '1/8D', 'the layout default');
  assert.equal(fxDivisionOf(0, DELAY_STEPS, DELAY_DIVISIONS).label, '1/32');
  assert.equal(fxDivisionOf(16383, DELAY_STEPS, DELAY_DIVISIONS).label, '1/2');
  assert.equal(fxDivisionOf(127, 128, MOD1_DIVISIONS).label, '1/32');
  assert.ok(DELAY_DIVISIONS.find((d) => d.label === '1/8S')!.swing);
  assert.equal(fxDivisionSeconds(120, DELAY_DIVISIONS.find((d) => d.label === '1/8D')!), 0.375);
  const near = (a: number, b: number, eps = 1e-9): boolean => Math.abs(a - b) < eps;
  assert.ok(near(delayFreeSeconds(0), 0.01) && near(delayFreeSeconds(16383), 2.5));
  assert.ok(Math.abs(delayFreeSeconds(11008) - 0.41) < 0.01);
  assert.ok(near(mod1FreeHz(0), 0.1) && near(mod1FreeHz(127), 10));
  assert.ok(near(ringModHz(127), 2000) && near(mod2RateHz(0), 0.05) && near(mod2RateHz(127), 10));
  assert.equal(delayFreeSeconds(Number.NaN), 0.01);
});
