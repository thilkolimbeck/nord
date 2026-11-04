/**
 * The layer effects region's logic (plan sections 15.1 and 15.9), without the DOM: group mode,
 * Global mode, the FX focus following the layer keys, the region's focus and group keys, and the
 * controls rebinding from block to block.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  fxBlockKeys, fxKeyIn, setFxFocus, setFxGlobal, setFxGroup, setLayerFocus, setSynthParam,
} from '../../src/editor/model/actions.ts';
import { descriptorOf } from '../../src/editor/model/descriptors.ts';
import { FX_BLOCKS, fxFocusBlock } from '../../src/editor/model/fx.ts';
import { initProgram } from '../../src/editor/model/init.ts';
import type { Ns4Key } from '../../src/editor/model/keys.ts';
import { type Change, ParamStore } from '../../src/editor/model/store.ts';
import {
  controlPattern, descriptionText, displayParamLine, fxBoundKey, isApprox, keyForBlock, valueView, writeControl,
} from '../../src/editor/ui/control-model.ts';
import {
  FX_GLOBAL_LINE, FX_REGION_GROUPS, fxFocusKeys, fxGlobalShown, fxGroupKey,
} from '../../src/editor/ui/region-model.ts';

const store = (): ParamStore => new ParamStore(initProgram());

function batches(s: ParamStore): Change[][] {
  const out: Change[][] = [];
  s.onChange((b) => out.push([...b]));
  return out;
}

test('the six unit groups show every field of a block once, in chain order', () => {
  const params = FX_REGION_GROUPS.flatMap((g) => g.params);
  assert.equal(params.length, 32);
  assert.equal(new Set(params).size, 32);
  assert.deepEqual(FX_REGION_GROUPS.map((g) => g.title), ['mod 1', 'mod 2', 'delay', 'amp · eq', 'comp', 'reverb']);
  assert.deepEqual(FX_REGION_GROUPS.filter((g) => g.global !== null).map((g) => g.unit), ['delay', 'comp', 'reverb']);
});

test('focus keys: one per block, the FX focus pressed; a focus key moves the focus', () => {
  const s = store();
  assert.deepEqual(fxFocusKeys(s).map((k) => k.label), ['organ', 'piano a', 'piano b', 'synth a', 'synth b', 'synth c']);
  assert.equal(fxFocusKeys(s).filter((k) => k.active).length, 1);
  setFxFocus(s, 'synthCFx');
  assert.equal(fxFocusBlock(s), 'synthCFx');
  assert.deepEqual(fxFocusKeys(s).find((k) => k.active)!.block, 'synthCFx');
  setFxFocus(s, 'organFx');
  assert.equal(fxFocusBlock(s), 'organFx');
});

test('the FX focus follows a layer key (derived), as on the Stage 4 (M p.48)', () => {
  const s = store();
  const seen = batches(s);
  setLayerFocus(s, 'synth', 'B');
  assert.equal(fxFocusBlock(s), 'synthBFx');
  assert.equal(s.get('synth.layerFocusSyn_I'), 1);
  const last = seen.at(-1)!;
  assert.equal(last.find((c) => c.key === 'synth.layerFocusSyn_I')!.origin, 'ui');
  assert.ok(last.filter((c) => c.key !== 'synth.layerFocusSyn_I').every((c) => c.origin === 'derived'));
  setLayerFocus(s, 'organ', 'B');
  assert.equal(fxFocusBlock(s), 'organFx', 'both organ layers share one block');
  setLayerFocus(s, 'piano', 'B');
  assert.equal(fxFocusBlock(s), 'pianoBFx');
});

test('the group key: per section in focus; the organ has none', () => {
  const s = store();
  setFxFocus(s, 'organFx');
  assert.deepEqual(fxGroupKey(s), { section: 'organ', key: null, on: false });
  setFxFocus(s, 'pianoAFx');
  assert.deepEqual(fxGroupKey(s), { section: 'piano', key: 'piano.effectsSectionModePno', on: true });
  setFxFocus(s, 'synthBFx');
  assert.equal(fxGroupKey(s).key, 'synth.effectsSectionModeSyn');
});

test('group mode: switching on copies the focused block; while on, an edit writes every block of the section', () => {
  const s = store();
  setFxGroup(s, 'synth', false);
  setFxFocus(s, 'synthBFx');
  s.setMany([['synthBFx.dlyMix', 99], ['synthBFx.rvbType', 9], ['synthBFx.dlyMix.morphWheel', 12], ['synthAFx.dlyMix', 3]], 'ui');
  setFxGroup(s, 'synth', true);
  for (const b of ['synthAFx', 'synthCFx'] as const) {
    assert.equal(s.get(`${b}.dlyMix`), 99, b);
    assert.equal(s.get(`${b}.rvbType`), 9, b);
    assert.equal(s.get(`${b}.dlyMix.morphWheel`), 12, b);
  }
  assert.equal(s.get('pianoAFx.dlyMix'), s.get('pianoBFx.dlyMix'), 'another section is untouched');
  setSynthParam(s, 'synthCFx.fx2Amt', 17);
  assert.deepEqual(['synthAFx', 'synthBFx', 'synthCFx'].map((b) => s.get(`${b}.fx2Amt` as Ns4Key)), [17, 17, 17]);
  // Per layer: an edit stays in its block.
  setFxGroup(s, 'synth', false);
  setSynthParam(s, 'synthCFx.fx2Amt', 40);
  assert.deepEqual(['synthAFx', 'synthBFx', 'synthCFx'].map((b) => s.get(`${b}.fx2Amt` as Ns4Key)), [17, 17, 40]);
  // The organ block is never grouped with anything.
  setSynthParam(s, 'organFx.fx2Amt', 5);
  assert.equal(s.get('organFx.fx2Amt'), 5);
});

test('MIDI control in writes through the same rules with origin midi', () => {
  const s = store();
  const seen = batches(s);
  setFxGroup(s, 'piano', true);
  setSynthParam(s, 'pianoAFx.cmpAmt', 11, 'midi');
  assert.equal(s.get('pianoBFx.cmpAmt'), 11);
  assert.equal(seen.at(-1)!.find((c) => c.key === 'pianoAFx.cmpAmt')!.origin, 'midi');
  assert.equal(seen.at(-1)!.find((c) => c.key === 'pianoBFx.cmpAmt')!.origin, 'derived');
  s.set('synth.multiLayerFlt', 1);
  setSynthParam(s, 'synthBSound.fltFreq', 20, 'midi');
  assert.deepEqual(['A', 'B', 'C'].map((l) => s.get(`synth${l}Sound.fltFreq` as Ns4Key)), [20, 20, 20]);
  assert.equal(seen.at(-1)![0]!.origin, 'midi');
});

test('Global off copies the focus block\'s unit to the other five blocks (M p.48)', () => {
  const s = store();
  setFxFocus(s, 'pianoBFx');
  s.setMany([['pianoBFx.rvbAmt', 101], ['pianoBFx.rvbColor', 2], ['pianoBFx.rvbAmt.morphAfterTouch', -7],
    ['pianoBFx.dlyMix', 1]], 'ui');
  setFxGlobal(s, 'reverb', true);
  assert.equal(s.get('common.effectsRvbGlobal'), 1);
  assert.equal(s.get('organFx.rvbAmt'), descriptorOf('organFx.rvbAmt').default, 'on copies nothing');
  assert.ok(fxGlobalShown(s, 'reverb'));
  assert.ok(!fxGlobalShown(s, 'delay'));
  assert.ok(FX_GLOBAL_LINE.startsWith('global: one instance on every section'));
  setFxGlobal(s, 'reverb', false);
  for (const b of FX_BLOCKS) {
    assert.equal(s.get(`${b}.rvbAmt` as Ns4Key), 101, b);
    assert.equal(s.get(`${b}.rvbColor` as Ns4Key), 2, b);
    assert.equal(s.get(`${b}.rvbAmt.morphAfterTouch` as Ns4Key), -7, b);
  }
  assert.notEqual(s.get('organFx.dlyMix'), 1, 'another unit is untouched');
});

test('writeControl routes the group and Global switches and block fields to the actions', () => {
  const s = store();
  setFxFocus(s, 'synthAFx');
  s.set('synthAFx.ampDrive', 77);
  writeControl(s, descriptorOf('synth.effectsSectionModeSyn'), 0);
  writeControl(s, descriptorOf('synth.effectsSectionModeSyn'), 1);
  assert.equal(s.get('synthCFx.ampDrive'), 77, 'group on copied the focus block');
  writeControl(s, descriptorOf('synthBFx.ampBass'), 12);
  assert.equal(s.get('synthAFx.ampBass'), 12);
  s.set('synthAFx.cmpAmt', 30);
  writeControl(s, descriptorOf('common.effectsCmpGlobal'), 1);
  writeControl(s, descriptorOf('common.effectsCmpGlobal'), 0);
  assert.equal(s.get('organFx.cmpAmt'), 30, 'global off copied');
});

test('effects controls rebind by block: one pattern for every block', () => {
  const s = store();
  assert.equal(controlPattern('organFx.dlyMix'), '{FX}.dlyMix');
  assert.equal(controlPattern('synthCFx.dlyMix'), '{FX}.dlyMix');
  assert.equal(controlPattern('pianoAFx.fx1RateClkDiv'), controlPattern('synthBFx.fx1RateClkDiv'));
  assert.equal(keyForBlock('organFx.rvbAmt', 'pianoBFx'), 'pianoBFx.rvbAmt');
  assert.equal(keyForBlock('common.fxEnable', 'pianoBFx'), 'common.fxEnable');
  setFxFocus(s, 'synthBFx');
  assert.equal(fxBoundKey('organFx.cmpAmt', s), 'synthBFx.cmpAmt');
  assert.equal(fxKeyIn('synthAFx.dlyMix.morphWheel', 'organFx'), 'organFx.dlyMix.morphWheel');
  assert.equal(fxBlockKeys('organFx').length, 32 + 10 * 3);
});

test('effects controls carry ≈ and say why; the display names block and unit', () => {
  const s = store();
  const mix = descriptorOf('synthAFx.dlyMix');
  assert.ok(isApprox(mix));
  assert.deepEqual(valueView(mix, 64, s).suffixes, ['nv', '≈']);
  assert.ok(/approximation: an effect modelled in the browser, no Nord effect/.test(descriptionText(mix, 64, s)));
  assert.ok(!isApprox(descriptorOf('common.fxEnable')), 'fx on is a switch, not a sound model');
  assert.equal(displayParamLine(descriptorOf('organFx.rvbEnable'), 1, s), 'organ fx · reverb · on · on ≈ · off–on');
  assert.ok(displayParamLine(mix, 64, s).startsWith('synth a fx · delay · dry/wet · 5.0 nv ≈'));
});
