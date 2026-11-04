/** Plan sections 13.1 and 13.2: every live and unverified organ field drives the organ, and only organ fields. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  expandOrganPattern, ORGAN_BINDINGS, organBindingOf, organLayerOf, organPatternOf, organSoundingKeys,
} from '../../src/editor/audio/organ/bindings.ts';
import { DESCRIPTORS } from '../../src/editor/model/descriptors.ts';
import type { Ns4Key } from '../../src/editor/model/keys.ts';
import { PLACEMENT } from '../../src/editor/model/sections.ts';

test('every live and unverified field of the organ region (rotary included) has an organ binding', () => {
  const missing = organSoundingKeys().filter((k) => organBindingOf(k) === null);
  assert.deepEqual(missing, []);
});

test('every binding names layout fields placed in the organ region or the rotary group', () => {
  const keys = Object.keys(ORGAN_BINDINGS).flatMap(expandOrganPattern);
  assert.ok(keys.length >= 50, `${keys.length} keys`);
  for (const key of keys) {
    const p = PLACEMENT.get(key);
    assert.ok(p !== undefined, `${key} has no control`);
    assert.ok(p.region.id === 'organ' || p.group.id === 'rotary', `${key} sits in ${p.region.id}/${p.group.id}`);
  }
});

test('stored organ fields, morphs, effects and other sections have no organ binding', () => {
  const none: Ns4Key[] = ['organA.presetEnable', 'organB.presetEnable', 'organ.leslieStopPreset',
    'organ.leslieRotorAngle', 'organ.leslieHornAngle', 'organ.auxKbdControl', 'organFx.rvbAmt',
    'synthASound.fltFreq', 'common.splitEnabled', 'common.layerScene'];
  for (const k of none) assert.equal(organBindingOf(k), null, k);
  for (const d of DESCRIPTORS.values()) {
    if (/\.morph(?:Wheel|AfterTouch|CtrlPedal)$/.test(d.key)) assert.equal(organBindingOf(d.key), null, d.key);
  }
});

test('scene II keys resolve to their scene I binding; router-owned keys do nothing at once', () => {
  for (const f of ['common.sectionEnableOrg', 'organ.layerEnableOrg', 'organ.layerFocusOrg']) {
    assert.deepEqual(organBindingOf(`${f}_II` as Ns4Key), organBindingOf(`${f}_I` as Ns4Key), f);
  }
  for (const k of ['common.sectionEnableOrg_I', 'organ.layerEnableOrg_II', 'organA.kbZone', 'organB.kbZone'] as const) {
    assert.equal(organBindingOf(k)?.effect, 'router', k);
    assert.equal(organBindingOf(k)?.apply, 'next-note', k);
  }
  assert.equal(organBindingOf('organ.layerFocusOrg_I')?.apply, 'none');
});

test('apply rules of plan 13.2: drawbars, level, vibrato and rotary live; model, octave, percussion next note', () => {
  const apply = (k: Ns4Key): string | undefined => organBindingOf(k)?.apply;
  for (const k of ['organBDrawbars.org_Preset_kDb9', 'organ.layerLevelOrgA', 'organAVibPerc.org_Preset_kVibratoEnable',
    'organ.vibratoTypeFarfisa', 'organ.effectsLeslieSpeed', 'organ.effectsLeslieDrv', 'organ.leslieMicDistance',
    'organ.orgPStickEnable'] as const) assert.equal(apply(k), 'live', k);
  for (const k of ['organA.model', 'organB.octaveShift', 'organA.sustainEnable', 'organBVibPerc.org_Preset_kB3PercSpeed',
    'organ.polyPercEnable'] as const) assert.equal(apply(k), 'next-note', k);
  for (const [, b] of Object.entries(ORGAN_BINDINGS)) assert.ok(b.target.length > 0);
});

test('organ layer patterns', () => {
  assert.equal(organLayerOf('organBDrawbars.org_Preset_kDb3'), 'B');
  assert.equal(organLayerOf('organ.layerLevelOrgA'), 'A');
  assert.equal(organLayerOf('organ.layerLevelOrgA.morphWheel'), null);
  assert.equal(organLayerOf('organ.vibratoTypeB3'), null);
  assert.equal(organLayerOf('organFx.rvbAmt'), null);
  assert.equal(organPatternOf('organAVibPerc.org_Preset_kB3PercLevel'), 'organ{X}VibPerc.org_Preset_kB3PercLevel');
  assert.equal(organPatternOf('organ.layerLevelOrgB'), 'organ.layerLevelOrg{X}');
  assert.deepEqual(expandOrganPattern('organ{X}.model'), ['organA.model', 'organB.model']);
});
