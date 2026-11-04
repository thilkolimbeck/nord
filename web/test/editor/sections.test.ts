/** Every Stage 4 field sits in exactly one group or in HIDDEN (AC3: all sections on screen). */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NS4_KEYS, type Ns4Key } from '../../src/editor/model/keys.ts';
import { HIDDEN, isHidden, keysOf, morphParent, PANEL, PLACEMENT } from '../../src/editor/model/sections.ts';

test('every layout key is in exactly one group or in HIDDEN', () => {
  const seen = new Map<Ns4Key, string>();
  const place = (key: Ns4Key, where: string): void => {
    assert.ok(!seen.has(key), `${key} in ${seen.get(key)} and ${where}`);
    seen.set(key, where);
  };
  for (const region of PANEL) for (const group of region.groups) for (const k of keysOf(group, null)) place(k, group.id);
  for (const k of HIDDEN) place(k, 'HIDDEN');
  assert.deepEqual(NS4_KEYS.filter((k) => !seen.has(k)), []);
  assert.equal(seen.size, 955);
  assert.equal(PLACEMENT.size + HIDDEN.length, 955);
});

test('six regions, all live since plan section 15; the rotary is an organ group', () => {
  assert.deepEqual(PANEL.map((r) => r.id), ['program', 'organ', 'piano', 'synth', 'extern', 'effects']);
  assert.deepEqual(PANEL.filter((r) => r.status === 'live').map((r) => r.id),
    ['program', 'organ', 'piano', 'synth', 'extern', 'effects']);
  const program = PANEL.find((r) => r.id === 'program')!;
  assert.deepEqual(program.groups.filter((g) => g.status !== 'live').map((g) => [g.id, g.status]),
    [['presets', 'layout'], ['aux-kb', 'stored'], ['output', 'stored']]);
  assert.equal(PLACEMENT.get('organ.effectsLeslieSpeed')!.group.id, 'rotary');
  assert.equal(PLACEMENT.get('organ.effectsLeslieSpeed')!.region.id, 'organ');
  assert.equal(PLACEMENT.get('common.sectionEnableSyn_I')!.region.id, 'synth');
  assert.equal(PLACEMENT.get('common.sectionEnableOrg_I')!.region.id, 'organ');
  assert.equal(PLACEMENT.get('common.sectionEnablePno_I')!.region.id, 'piano');
  for (const region of PANEL) {
    assert.ok(region.title.length > 0 && region.groups.length > 0, region.id);
    if (region.status === 'layout') for (const g of region.groups) assert.equal(g.status, 'layout', g.id);
  }
  const groupIds = PANEL.flatMap((r) => r.groups.map((g) => g.id));
  assert.equal(new Set(groupIds).size, groupIds.length);
});

test('synth groups follow the editor design; one layer at a time', () => {
  const synth = PANEL.find((r) => r.id === 'synth')!;
  assert.deepEqual(synth.groups.map((g) => g.title),
    ['layers', 'oscillator', 'filter', 'amp env', 'lfo · vibrato', 'voice', 'keyboard', 'osc env', 'arp']);
  const perLayer = synth.groups.filter((g) => g.id !== 'layers').flatMap((g) => keysOf(g, 'B'));
  assert.equal(perLayer.length, 59);
  assert.ok(perLayer.every((k) => k.startsWith('synthB')), 'layer B only');
  const strip = keysOf(synth.groups[0]!, 'C');
  assert.ok(strip.includes('synth.layerLevelSynC') && !strip.includes('synth.layerLevelSynA'));
});

test('HIDDEN holds morphs, scene II copies, reserved bits, hashes and pattern masks', () => {
  for (const key of NS4_KEYS) {
    if (/\.morph(Wheel|AfterTouch|CtrlPedal)$/.test(key) || key.endsWith('_II') || key.includes('reserved')) {
      assert.ok(isHidden(key), key);
    }
  }
  for (const key of ['common.synPresetNameHashA', 'synthC.smpNameHash', 'synthA.arpPtnAcc', 'synthB.libName'] as const) {
    assert.ok(isHidden(key), key);
  }
  assert.equal(HIDDEN.filter((k) => morphParent(k) !== null).length, 357);
  assert.ok(!isHidden('synthASound.fltFreq'));
  assert.equal(morphParent('synthASound.fltFreq.morphCtrlPedal'), 'synthASound.fltFreq');
  assert.equal(morphParent('synthASound.fltFreq'), null);
});
