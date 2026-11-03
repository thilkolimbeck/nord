/** AC 4 / plan section 4.1: every live and unverified synth field drives an audio parameter, and only those. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BINDINGS, bindingOf, soundingKeys } from '../../src/editor/audio/bindings.ts';
import { DESCRIPTORS } from '../../src/editor/model/descriptors.ts';
import { expandPattern } from '../../src/editor/model/keys.ts';

test('every live and unverified synth field has a binding', () => {
  const keys = soundingKeys();
  assert.ok(keys.length >= 3 * 44, `only ${keys.length} sounding keys`);
  const missing = keys.filter((k) => bindingOf(k) === null);
  assert.deepEqual(missing, []);
});

test('every binding names layout fields that sound in the MVP', () => {
  for (const pattern of Object.keys(BINDINGS)) {
    for (const key of expandPattern(pattern)) {
      const d = DESCRIPTORS.get(key)!;
      assert.equal(d.region, 'synth', key);
      assert.ok(d.status === 'live' || d.status === 'unverified', `${key} is ${d.status}`);
    }
  }
});

test('stored-only fields (no sound in MVP) have no binding', () => {
  for (const d of DESCRIPTORS.values()) {
    if (d.status === 'stored' || d.status === 'layout') assert.equal(bindingOf(d.key), null, d.key);
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
