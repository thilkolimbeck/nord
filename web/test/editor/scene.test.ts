/** Layer scenes (plan section 13.4): scene-free field names map to the _I/_II field of the active scene. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { initProgram } from '../../src/editor/model/init.ts';
import { isNs4Key, type Ns4Key } from '../../src/editor/model/keys.ts';
import {
  activeKey, activeScene, enabledLayers, focusEntry, focusedLayer, inactiveSceneKey, isSceneField, layerMask, layerOn,
  layerToggle, parseSceneKey, SCENE_FIELDS, SCENE_KEY, SCENE_KEYS, sceneFree, sceneKey, sceneTwin, sceneValue,
  SECTION_FIELDS, SECTION_LAYERS, sectionEntry, sectionOn, SECTIONS,
} from '../../src/editor/model/scene.ts';
import { HIDDEN } from '../../src/editor/model/sections.ts';
import { ParamStore } from '../../src/editor/model/store.ts';

function store(edits: Partial<Record<Ns4Key, number>> = {}): ParamStore {
  const s = new ParamStore(initProgram());
  s.setMany(Object.entries(edits) as Array<[Ns4Key, number]>, 'ui');
  return s;
}

test('the scene keys are the 18 _I/_II fields of the layout', () => {
  assert.equal(SCENE_FIELDS.length, 9);
  assert.equal(SCENE_KEYS.length, 18);
  for (const key of SCENE_KEYS) assert.ok(isNs4Key(key) && /_(I|II)$/.test(key), key);
  assert.deepEqual(SCENE_KEYS.slice(0, 3), ['common.sectionEnableOrg_I', 'organ.layerEnableOrg_I', 'organ.layerFocusOrg_I']);
  assert.equal(SCENE_KEYS[9], 'common.sectionEnableOrg_II');
  // Every other layout key ending in _I or _II would be a scene field this module misses.
  const hiddenII = HIDDEN.filter((k) => k.endsWith('_II'));
  assert.deepEqual([...hiddenII].sort(), SCENE_KEYS.filter((k) => k.endsWith('_II')).sort());
});

test('sceneKey and activeKey follow common.layerScene', () => {
  assert.equal(sceneKey('common.sectionEnableOrg', 'I'), 'common.sectionEnableOrg_I');
  assert.equal(sceneKey('synth.layerEnableSyn', 'II'), 'synth.layerEnableSyn_II');
  const s = store();
  assert.equal(SCENE_KEY, 'common.layerScene');
  assert.equal(activeScene(s), 'I');
  assert.equal(activeKey(s, 'piano.layerFocusPno'), 'piano.layerFocusPno_I');
  s.set('common.layerScene', 1);
  assert.equal(activeScene(s), 'II');
  assert.equal(activeKey(s, 'piano.layerFocusPno'), 'piano.layerFocusPno_II');
  assert.equal(sceneValue(s, 'common.sectionEnablePno'), 1, 'scene II keeps the layout default: piano on');
  assert.equal(sceneValue(s, 'common.sectionEnablePno', 'I'), 0);
});

test('parseSceneKey, sceneTwin and sceneFree recognise only scene keys', () => {
  assert.deepEqual(parseSceneKey('organ.layerEnableOrg_II'), { field: 'organ.layerEnableOrg', scene: 'II' });
  assert.deepEqual(parseSceneKey('common.sectionEnableSyn_I'), { field: 'common.sectionEnableSyn', scene: 'I' });
  for (const other of ['common.layerScene', 'synthASound.fltFreq', 'common.sectionEnableOrg', 'organ.layerEnableOrg_III']) {
    assert.equal(parseSceneKey(other), null, other);
    assert.equal(sceneFree(other), other);
  }
  assert.equal(sceneTwin('synth.layerFocusSyn_I'), 'synth.layerFocusSyn_II');
  assert.equal(sceneTwin('synth.layerFocusSyn_II'), 'synth.layerFocusSyn_I');
  assert.equal(sceneTwin('synthASound.fltFreq'), null);
  assert.equal(sceneFree('piano.layerEnablePno_II'), 'piano.layerEnablePno');
  assert.ok(isSceneField('organ.layerFocusOrg'));
  assert.ok(!isSceneField('organ.layerFocusOrg_I'));
});

test('inactiveSceneKey is true only for the scene that is not active', () => {
  const s = store();
  assert.equal(inactiveSceneKey(s, 'common.sectionEnableOrg_II'), true);
  assert.equal(inactiveSceneKey(s, 'common.sectionEnableOrg_I'), false);
  assert.equal(inactiveSceneKey(s, 'organA.model'), false);
  s.set('common.layerScene', 1);
  assert.equal(inactiveSceneKey(s, 'common.sectionEnableOrg_I'), true);
  assert.equal(inactiveSceneKey(s, 'common.sectionEnableOrg_II'), false);
});

test('enabledLayers: none while the section is off, else the mask bits in layer order', () => {
  const s = store();
  // The init program: scene I plays synth layer A only.
  assert.deepEqual(SECTIONS.map((sec) => enabledLayers(s, sec)), [[], [], ['A']]);
  s.setMany([['common.sectionEnableOrg_I', 1], ['organ.layerEnableOrg_I', 3]], 'ui');
  assert.deepEqual(enabledLayers(s, 'organ'), ['A', 'B']);
  s.set('organ.layerEnableOrg_I', 2);
  assert.deepEqual(enabledLayers(s, 'organ'), ['B']);
  s.set('synth.layerEnableSyn_I', 5);
  assert.deepEqual(enabledLayers(s, 'synth'), ['A', 'C']);
  assert.equal(layerOn(s, 'synth', 'C'), true);
  assert.equal(layerOn(s, 'synth', 'B'), false);
  s.set('common.sectionEnableSyn_I', 0);
  assert.deepEqual(enabledLayers(s, 'synth'), []);
  assert.equal(layerOn(s, 'synth', 'C'), true, 'the bit stays set while the section is off');
  assert.equal(sectionOn(s, 'synth'), false);
});

test('scene II has its own switches; switching the scene changes what plays', () => {
  const s = store();
  s.set('common.layerScene', 1);
  // Layout defaults of scene II: piano on with layer A; organ and synth off.
  assert.deepEqual(SECTIONS.map((sec) => enabledLayers(s, sec)), [[], ['A'], []]);
  assert.deepEqual(enabledLayers(s, 'synth', 'I'), ['A'], 'scene I can still be read explicitly');
  assert.equal(layerMask(s, 'synth', 'I'), 1);
});

test('focusedLayer reads the scene focus; out-of-range values fall back to A', () => {
  const s = store();
  assert.equal(focusedLayer(s, 'organ'), 'A');
  s.set('organ.layerFocusOrg_I', 1);
  assert.equal(focusedLayer(s, 'organ'), 'B');
  s.set('synth.layerFocusSyn_I', 2);
  assert.equal(focusedLayer(s, 'synth'), 'C');
  s.set('common.layerScene', 1);
  assert.equal(focusedLayer(s, 'synth'), 'A', 'scene II has its own focus');
  assert.equal(focusedLayer({ get: () => 3 }, 'synth'), 'A');
});

test('entries for the store touch only the named scene and keep the other bits', () => {
  const s = store({ 'synth.layerEnableSyn_I': 5 });
  assert.deepEqual(layerToggle(s, 'synth', 'B', true), ['synth.layerEnableSyn_I', 7]);
  assert.deepEqual(layerToggle(s, 'synth', 'A', false), ['synth.layerEnableSyn_I', 4]);
  assert.deepEqual(layerToggle(s, 'piano', 'B', true, 'II'), ['piano.layerEnablePno_II', 3]);
  assert.deepEqual(focusEntry('organ', 'B', 'II'), ['organ.layerFocusOrg_II', 1]);
  assert.deepEqual(focusEntry('synth', 'C', 'I'), ['synth.layerFocusSyn_I', 2]);
  assert.deepEqual(sectionEntry('piano', true, 'I'), ['common.sectionEnablePno_I', 1]);
  s.setMany([layerToggle(s, 'synth', 'B', true)], 'ui');
  assert.equal(s.get('synth.layerEnableSyn_I'), 7);
  assert.equal(s.get('synth.layerEnableSyn_II'), 1, 'scene II untouched');
});

test('section tables name existing scene fields and layers', () => {
  for (const sec of SECTIONS) {
    const f = SECTION_FIELDS[sec];
    for (const field of [f.on, f.mask, f.focus]) assert.ok(isSceneField(field), field);
  }
  assert.deepEqual(SECTION_LAYERS, { organ: ['A', 'B'], piano: ['A', 'B'], synth: ['A', 'B', 'C'] });
});
