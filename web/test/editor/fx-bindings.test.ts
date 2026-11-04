/**
 * Plan section 15.1: every live and unverified field of the effects region has an effects binding
 * (one way: a binding for a field still at status layout is allowed, so this passes before and
 * after the statuses flip), and every binding names effects-region fields.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  expandFxPattern, FX_BINDINGS, fxBindingOf, fxPatternOf, fxSoundingKeys,
} from '../../src/editor/audio/fx/bindings.ts';
import { DESCRIPTORS } from '../../src/editor/model/descriptors.ts';
import { FX_BLOCKS, FX_COMMON_KEYS, FX_PARAMS, fxKey } from '../../src/editor/model/fx.ts';

test('every live and unverified effects-region field has a binding', () => {
  const missing = fxSoundingKeys().filter((k) => fxBindingOf(k) === null);
  assert.deepEqual(missing, []);
});

test('every field of the effects region has a binding, whatever its status today', () => {
  const region = [...DESCRIPTORS.values()].filter((d) => d.region === 'effects').map((d) => d.key);
  assert.equal(region.length, 6 * 32 + FX_COMMON_KEYS.length);
  assert.deepEqual(region.filter((k) => fxBindingOf(k) === null), []);
});

test('every binding names effects-region fields', () => {
  const keys = Object.keys(FX_BINDINGS).flatMap(expandFxPattern);
  assert.equal(keys.length, 6 * 32 + FX_COMMON_KEYS.length);
  for (const key of keys) assert.equal(DESCRIPTORS.get(key)?.region, 'effects', key);
  for (const b of Object.values(FX_BINDINGS)) assert.ok(b.target.length > 0);
});

test('patterns, morph amounts and other regions', () => {
  assert.equal(fxPatternOf('synthBFx.dlyMix'), '{B}.dlyMix');
  for (const block of FX_BLOCKS) for (const p of FX_PARAMS) assert.ok(fxBindingOf(fxKey(block, p)) !== null);
  assert.equal(fxBindingOf('synthAFx.dlyMix.morphWheel'), null, 'a morph moves its parent field');
  assert.equal(fxBindingOf('synthASound.fltFreq'), null);
  assert.equal(fxBindingOf('piano.effectsSectionModePno')?.apply, 'none');
  assert.equal(fxBindingOf('common.fxEnable')?.scope, 'all');
  assert.equal(fxBindingOf('common.fxSectionFocus')?.scope, 'global');
  assert.equal(fxBindingOf('organFx.rvbAmt')?.unit, 'reverb');
});
