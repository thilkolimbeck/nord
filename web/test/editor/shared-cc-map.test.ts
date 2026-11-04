/**
 * Plan section 15.4, midi/cc-map.ts (shared, frozen): Appendix II as data (manual p.68–69), every
 * mapped controller reaching a real field for every layer and block, value scaling in and out,
 * focus-addressed targets, the reverse map for sending, and NRPN assembly and encoding.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  addressText, APPENDIX_II, ccEntry, ccMessage, entryForKey, messagesFor, NrpnDecoder, nrpnEntry, nrpnMessages,
  PLAY_BUS_CCS, resolveTarget, scaleIn, scaleOut,
} from '../../src/editor/midi/cc-map.ts';
import { DESCRIPTORS } from '../../src/editor/model/descriptors.ts';
import { FX_BLOCKS, fxFocusEntries } from '../../src/editor/model/fx.ts';
import { initProgram } from '../../src/editor/model/init.ts';
import type { Ns4Key } from '../../src/editor/model/keys.ts';
import { SECTION_LAYERS } from '../../src/editor/model/scene.ts';
import { ParamStore } from '../../src/editor/model/store.ts';

test('Appendix II: 95 plain CCs and 51 NRPNs (2:32-34 as three), each address once', () => {
  const cc = APPENDIX_II.filter((e) => e.address.kind === 'cc');
  const nrpn = APPENDIX_II.filter((e) => e.address.kind === 'nrpn');
  assert.equal(cc.length, 95);
  assert.equal(nrpn.length, 51);
  assert.equal(new Set(APPENDIX_II.map((e) => addressText(e.address))).size, APPENDIX_II.length);
  for (const e of cc) assert.ok(e.address.kind === 'cc' && ![6, 38, 98, 99].includes(e.address.cc), e.name);
  assert.equal(ccEntry(59)?.name, 'Synth Filter Freq');
  assert.equal(nrpnEntry(3, 51)?.name, 'Synth Filter Type');
  assert.equal(nrpnEntry(2, 105)?.name, 'Reverb Type/Variation');
  assert.equal(ccEntry(1), null, 'the mod wheel is no panel controller');
  assert.equal(nrpnEntry(9, 9), null);
  for (const n of PLAY_BUS_CCS) {
    const e = ccEntry(n);
    assert.ok(e === null || e.target.kind === 'none', `CC ${n} stays with the play bus`);
  }
});

test('every mapped entry reaches a real field for every layer and block, with a scaling that fits its range', () => {
  const s = new ParamStore(initProgram());
  for (const e of APPENDIX_II) {
    const t = e.target;
    const keys: Ns4Key[] = [];
    if (t.kind === 'key') keys.push(t.key);
    else if (t.kind === 'layer') for (const l of SECTION_LAYERS[t.section]) keys.push(resolveTarget(e, s, { layer: l })!);
    else if (t.kind === 'fx') for (const b of FX_BLOCKS) keys.push(resolveTarget(e, s, { block: b })!);
    else if (t.kind === 'organVibratoType') keys.push('organ.vibratoTypeB3', 'organ.vibratoTypeVox', 'organ.vibratoTypeFarfisa');
    else continue;
    for (const k of keys) {
      const d = DESCRIPTORS.get(k);
      assert.ok(d !== undefined, `${e.name}: ${k}`);
      if (e.scaling === 'identity') assert.deepEqual([d.min, d.max], [0, 127], `${e.name}: ${k}`);
      if (e.scaling === 'switch') assert.equal(d.max - d.min, 1, `${e.name}: ${k}`);
      if (e.scaling === 'index') assert.ok(d.min >= 0 && d.max <= 127, `${e.name}: ${k}`);
      if (e.scaling === 'linear') assert.ok(!(d.min === 0 && d.max === 127), `${e.name}: ${k} would be identity`);
      assert.equal(entryForKey(k)?.entry, e, `${k} maps back to ${e.name}`);
    }
  }
  assert.equal(entryForKey('synthASound.fltEnable'), null, 'no controller for the filter switch (feasibility 3.4)');
  assert.equal(entryForKey('synthA.kbZone'), null);
});

test('layer targets follow the focused layer of the active scene; effects targets the FX focus', () => {
  const s = new ParamStore(initProgram());
  const freq = ccEntry(59)!;
  assert.equal(resolveTarget(freq, s), 'synthASound.fltFreq');
  s.set('synth.layerFocusSyn_I', 2);
  assert.equal(resolveTarget(freq, s), 'synthCSound.fltFreq');
  s.setMany([['common.layerScene', 1], ['synth.layerFocusSyn_II', 1]], 'ui');
  assert.equal(resolveTarget(freq, s), 'synthBSound.fltFreq', 'scene II focus');
  assert.equal(resolveTarget(freq, s, { layer: 'A' }), 'synthASound.fltFreq');
  const drawbar3 = ccEntry(18)!;
  s.set('organ.layerFocusOrg_II', 1);
  assert.equal(resolveTarget(drawbar3, s), 'organBDrawbars.org_Preset_kDb3');
  const mix = ccEntry(93)!;
  s.setMany(fxFocusEntries('pianoBFx'), 'ui');
  assert.equal(resolveTarget(mix, s), 'pianoBFx.dlyMix');
  s.setMany(fxFocusEntries('organFx'), 'ui');
  assert.equal(resolveTarget(mix, s), 'organFx.dlyMix');
  assert.equal(resolveTarget(ccEntry(0)!, s), null, 'bank select is not mapped');
});

test('the organ vibrato type follows the focused organ layer model; pipes have none', () => {
  const s = new ParamStore(initProgram());
  const vib = nrpnEntry(2, 19)!;
  const model = (v: number): void => {
    s.set('organA.model', v);
  };
  model(0);
  assert.equal(resolveTarget(vib, s), 'organ.vibratoTypeB3');
  model(1);
  assert.equal(resolveTarget(vib, s), 'organ.vibratoTypeVox');
  model(2);
  assert.equal(resolveTarget(vib, s), 'organ.vibratoTypeFarfisa');
  model(3);
  assert.equal(resolveTarget(vib, s), null);
  model(5);
  assert.equal(resolveTarget(vib, s), 'organ.vibratoTypeB3', 'B3 Bass uses the B3 scanner');
});

test('scaling in and out: identity, index, switch and linear', () => {
  const freq = ccEntry(59)!;
  assert.equal(scaleIn(freq, 'synthASound.fltFreq', 77), 77);
  assert.equal(scaleOut(freq, 'synthASound.fltFreq', 77), 77);
  const type = nrpnEntry(3, 51)!;
  assert.equal(scaleIn(type, 'synthASound.fltType', 3), 3);
  assert.equal(scaleIn(type, 'synthASound.fltType', 99), 5, 'clamped to the field');
  const run = ccEntry(77)!;
  assert.equal(scaleIn(run, 'synthA.arpRun', 63), 0);
  assert.equal(scaleIn(run, 'synthA.arpRun', 64), 1);
  assert.equal(scaleOut(run, 'synthA.arpRun', 1), 127);
  assert.equal(scaleOut(run, 'synthA.arpRun', 0), 0);
  const pan = ccEntry(40)!;
  assert.equal(scaleIn(pan, 'synth.layerPanSynA', 0), -60);
  assert.equal(scaleIn(pan, 'synth.layerPanSynA', 127), 60);
  assert.equal(scaleIn(pan, 'synth.layerPanSynA', 64), 0);
  for (const v of [-60, -31, 0, 17, 60]) {
    const back = scaleIn(pan, 'synth.layerPanSynA', scaleOut(pan, 'synth.layerPanSynA', v));
    assert.ok(Math.abs(back - v) <= 1, `pan ${v} round trip ${back}`);
  }
  const tempo = ccEntry(94)!;
  assert.equal(scaleIn(tempo, 'synthAFx.dlyRateClkDiv', 127), 16383);
  assert.equal(scaleOut(tempo, 'synthAFx.dlyRateClkDiv', 0), 0);
  const drawbar = ccEntry(16)!;
  assert.equal(scaleIn(drawbar, 'organADrawbars.org_Preset_kDb1', 127), 8);
  assert.equal(scaleOut(drawbar, 'organADrawbars.org_Preset_kDb1', 4), 64);
});

test('NRPN: assembled from CC99, CC98, CC6 and CC38 per channel, with running data entry', () => {
  const d = new NrpnDecoder();
  assert.equal(d.feed(0, 38, 5), null, 'no parameter selected yet');
  assert.equal(d.feed(0, 99, 3), null);
  assert.equal(d.feed(0, 98, 51), null);
  assert.equal(d.feed(1, 38, 9), null, 'another channel has its own selection');
  assert.equal(d.feed(0, 6, 0), null);
  assert.deepEqual(d.feed(0, 38, 2), { channel: 0, msb: 3, lsb: 51, value: 2 });
  assert.deepEqual(d.feed(0, 38, 4), { channel: 0, msb: 3, lsb: 51, value: 4 }, 'running data entry');
  d.feed(0, 6, 1);
  assert.equal(d.feed(0, 38, 4)?.value, 132, 'CC6 counts 128s');
  d.feed(0, 98, 50);
  assert.equal(d.feed(0, 38, 1)?.value, 1, 'a new selection clears the data MSB');
  assert.ok(NrpnDecoder.isTransport(99) && NrpnDecoder.isTransport(38) && !NrpnDecoder.isTransport(59));
  d.reset();
  assert.equal(d.feed(0, 38, 1), null);
});

test('messages: one CC or the four NRPN messages, on the given channel', () => {
  assert.deepEqual(ccMessage(0, 59, 200), [0xb0, 59, 127]);
  assert.deepEqual(nrpnMessages(15, 3, 51, 2), [[0xbf, 99, 3], [0xbf, 98, 51], [0xbf, 6, 0], [0xbf, 38, 2]]);
  assert.deepEqual(messagesFor(ccEntry(59)!, 1, 64), [[0xb1, 59, 64]]);
  assert.equal(messagesFor(nrpnEntry(2, 105)!, 0, 6).length, 4);
});
