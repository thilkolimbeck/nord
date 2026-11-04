/** Parameter ids: the generated key list is the engine's Stage 4 layout, in order. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NS4_LAYOUT } from '../../src/ns4/layout.ts';
import { expandPattern, isNs4Key, layerKey, layerOf, LAYERS, NS4_KEYS, patternOf } from '../../src/editor/model/keys.ts';

test('NS4_KEYS is the engine layout, in layout order', () => {
  assert.deepEqual([...NS4_KEYS], [...NS4_LAYOUT.fields.keys()]);
  assert.equal(NS4_KEYS.length, 955);
  assert.equal(new Set(NS4_KEYS).size, 955);
});

test('isNs4Key accepts layout keys only', () => {
  assert.ok(isNs4Key('synthASound.fltFreq'));
  assert.ok(isNs4Key('synth.layerLevelSynC.morphWheel'));
  assert.ok(!isNs4Key('synthDSound.fltFreq'));
  assert.ok(!isNs4Key('constructor'));
});

test('layerKey and expandPattern fill in the layer', () => {
  assert.equal(layerKey('B', 'synth{L}Sound.fltFreq'), 'synthBSound.fltFreq');
  assert.equal(layerKey('C', 'synth.layerPanSyn{L}'), 'synth.layerPanSynC');
  assert.throws(() => layerKey('A', 'synth{L}Sound.nope'), /names no Stage 4 field/);
  assert.deepEqual(expandPattern('synth{L}.vibDly'), ['synthA.vibDly', 'synthB.vibDly', 'synthC.vibDly']);
  assert.deepEqual(expandPattern('common.layerScene'), ['common.layerScene']);
  assert.throws(() => expandPattern('common.nope'), /not a Stage 4 field/);
});

test('layerOf finds the synth layer of a key', () => {
  assert.equal(layerOf('synthBSound.fltFreq'), 'B');
  assert.equal(layerOf('synthA.vibDly'), 'A');
  assert.equal(layerOf('synthCFx.rvbAmt'), 'C');
  assert.equal(layerOf('synth.layerLevelSynC.morphWheel'), 'C');
  assert.equal(layerOf('synth.layerPanSynA'), 'A');
  assert.equal(layerOf('synth.layerEnableSyn_I'), null);
  assert.equal(layerOf('synth.reserved_was_pan_a_morph'), null);
  assert.equal(layerOf('pianoA.kbZone'), null);
  assert.equal(layerOf('common.audioRoutingBusSynA'), null);
});

test('patternOf and layerKey are inverse for every key', () => {
  let layered = 0;
  for (const key of NS4_KEYS) {
    const layer = layerOf(key);
    const pattern = patternOf(key);
    if (layer === null) {
      assert.equal(pattern, key);
      continue;
    }
    layered += 1;
    assert.ok(pattern.includes('{L}'), key);
    assert.equal(layerKey(layer, pattern), key);
    assert.deepEqual(LAYERS.map((l) => layerKey(l, pattern)).filter((k) => k === key), [key]);
  }
  // 3 x (synthX 56 + synthXSound 57 + synthXFx 62) + 3 x (level and its 3 morphs, pan)
  assert.equal(layered, 3 * (56 + 57 + 62) + 3 * 5);
});
