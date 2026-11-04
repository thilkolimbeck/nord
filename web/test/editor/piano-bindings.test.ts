/** Plan section 13.3: every live and unverified piano field drives the browser piano; scene II keys resolve to scene I. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BINDINGS, bindingOf, expandPianoPattern, pianoLayerOf, pianoPatternOf, soundingKeys,
} from '../../src/editor/audio/piano/bindings.ts';
import { DESCRIPTORS } from '../../src/editor/model/descriptors.ts';

test('every live and unverified field of the piano region has a piano binding', () => {
  const missing = soundingKeys().filter((k) => bindingOf(k) === null);
  assert.deepEqual(missing, []);
});

test('every binding names piano-region layout fields; the router-owned ones do nothing', () => {
  for (const [pattern, b] of Object.entries(BINDINGS)) {
    for (const key of expandPianoPattern(pattern)) {
      assert.equal(DESCRIPTORS.get(key)?.region, 'piano', key);
      assert.equal(bindingOf(key), b, key);
    }
    assert.ok(b.target.length > 0, pattern);
    if (b.effect === 'router' || b.effect === 'focus') assert.equal(b.apply, 'none', pattern);
  }
  for (const k of ['common.sectionEnablePno_I', 'piano.layerEnablePno_I', 'pianoA.kbZone', 'pianoB.kbZone'] as const) {
    assert.equal(bindingOf(k)!.effect, 'router', k);
  }
  assert.equal(BINDINGS['piano.layerLevelPno{L}']!.apply, 'live');
  assert.equal(BINDINGS['piano{L}.eq']!.apply, 'live');
  assert.equal(BINDINGS['piano{L}.acoustic']!.apply, 'live');
  assert.equal(BINDINGS['piano{L}.nameHash']!.apply, 'next-note');
  assert.equal(BINDINGS['piano{L}.pedalNoise']!.apply, 'next-pedal');
});

test('scene II keys resolve to their scene I binding; stored, effects and other sections have none', () => {
  assert.equal(bindingOf('common.sectionEnablePno_II'), bindingOf('common.sectionEnablePno_I'));
  assert.equal(bindingOf('piano.layerFocusPno_II'), bindingOf('piano.layerFocusPno_I'));
  for (const k of ['pianoA.entry', 'pianoB.entry', 'piano.auxKbdControl', 'piano.layerLevelPnoA.morphWheel',
    'synth.layerFocusSyn_I', 'synthASound.fltFreq', 'organA.model', 'common.transposeValue'] as const) {
    assert.equal(bindingOf(k), null, k);
  }
  for (const d of DESCRIPTORS.values()) {
    if (d.key.startsWith('pianoAFx.') || d.key.startsWith('pianoBFx.')) assert.equal(bindingOf(d.key), null, d.key);
  }
});

test('piano layer keys and patterns', () => {
  assert.equal(pianoLayerOf('pianoB.eq'), 'B');
  assert.equal(pianoLayerOf('piano.layerLevelPnoA'), 'A');
  assert.equal(pianoLayerOf('piano.layerLevelPnoA.morphWheel'), 'A');
  assert.equal(pianoLayerOf('pianoAFx.ampEnable'), null);
  assert.equal(pianoLayerOf('piano.layerEnablePno_I'), null);
  assert.equal(pianoPatternOf('pianoB.nameHash'), 'piano{L}.nameHash');
  assert.equal(pianoPatternOf('piano.layerLevelPnoB'), 'piano.layerLevelPno{L}');
  assert.deepEqual(expandPianoPattern('piano{L}.bank'), ['pianoA.bank', 'pianoB.bank']);
});
