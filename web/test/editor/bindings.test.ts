/**
 * AC 4 / plan sections 4.1 and 13.1: every live and unverified synth field drives an audio
 * parameter, and only those; router-owned keys of the synth region are listed as no-ops whatever
 * their status, and scene II keys resolve to their scene I binding.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BINDINGS, bindingOf, soundingKeys } from '../../src/editor/audio/bindings.ts';
import { isRouterKey } from '../../src/editor/audio/router.ts';
import { DESCRIPTORS } from '../../src/editor/model/descriptors.ts';
import { expandPattern } from '../../src/editor/model/keys.ts';

test('every live and unverified synth field has a binding', () => {
  const keys = soundingKeys();
  assert.ok(keys.length >= 3 * 44, `only ${keys.length} sounding keys`);
  const missing = keys.filter((k) => bindingOf(k) === null);
  assert.deepEqual(missing, []);
});

test('every binding names synth-region fields that sound, or router-owned keys', () => {
  for (const pattern of Object.keys(BINDINGS)) {
    for (const key of expandPattern(pattern)) {
      const d = DESCRIPTORS.get(key)!;
      assert.equal(d.region, 'synth', key);
      if (isRouterKey(key)) {
        assert.ok(['layers', 'focus'].includes(BINDINGS[pattern]!.effect), `${key} is router-owned: a no-op effect`);
      }
      else assert.ok(d.status === 'live' || d.status === 'unverified', `${key} is ${d.status}`);
    }
  }
});

test('stored-only fields (no sound) have no binding, router-owned keys aside', () => {
  for (const d of DESCRIPTORS.values()) {
    if (isRouterKey(d.key)) continue;
    if (d.status === 'stored' || d.status === 'layout') assert.equal(bindingOf(d.key), null, d.key);
  }
});

test('scene II keys resolve to the scene I binding; organ and piano switches have none here', () => {
  assert.equal(bindingOf('common.sectionEnableSyn_II'), BINDINGS['common.sectionEnableSyn_I']);
  assert.equal(bindingOf('synth.layerEnableSyn_II'), BINDINGS['synth.layerEnableSyn_I']);
  assert.equal(bindingOf('synth.layerFocusSyn_II'), BINDINGS['synth.layerFocusSyn_I']);
  assert.equal(bindingOf('organ.layerEnableOrg_II'), null);
  assert.equal(bindingOf('common.sectionEnablePno_I'), null);
  assert.equal(bindingOf('common.layerScene'), null, 'the program region has no synth binding');
  for (const k of ['synthA.kbZone', 'synthB.kbZone', 'synthC.kbZone'] as const) {
    assert.equal(bindingOf(k)?.apply, 'next-note', k);
  }
});

test('live bindings reach an audio parameter; only the layer focus sounds nowhere', () => {
  for (const [pattern, b] of Object.entries(BINDINGS)) {
    assert.ok(b.target.length > 0, pattern);
    if (b.apply === 'none') assert.equal(pattern, 'synth.layerFocusSyn_I');
    if (b.effect === 'envTimes') assert.equal(b.apply, 'next-stage', pattern);
  }
  assert.equal(BINDINGS['synth{L}Sound.fltFreq']!.apply, 'live');
  assert.equal(BINDINGS['synth{L}.oscUnison']!.apply, 'next-note');
});
