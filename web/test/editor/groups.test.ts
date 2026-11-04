/**
 * Plan section 14: synth Groups (manual p.32 filter, p.34 LFO, p.35 arpeggiator). Switching a Group
 * on gives every layer the focused layer's shared settings; while it is on an edit of any layer
 * reaches all three (controls write through writeControl); switching it off keeps the values; the
 * engine follows (a voice on layer B takes layer A's filter edit) and the LFO Group restarts every
 * LFO in phase.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SynthEngine } from '../../src/editor/audio/engine.ts';
import type { RoutedNoteOn } from '../../src/editor/audio/section.ts';
import { activeGroupOf, setSynthGroup, setSynthParam, SYNTH_GROUPS } from '../../src/editor/model/actions.ts';
import { descriptorOf } from '../../src/editor/model/descriptors.ts';
import { initProgram } from '../../src/editor/model/init.ts';
import { expandPattern, LAYERS, layerKey, type SynthLayer } from '../../src/editor/model/keys.ts';
import { ParamStore } from '../../src/editor/model/store.ts';
import { writeControl } from '../../src/editor/ui/control-model.ts';
import { asContext, asNode, FakeContext, FakeGain, FakeOscillator, installAudioGlobals } from './fake-audio.ts';

installAudioGlobals();

const all = (s: ParamStore, pattern: string): number[] => LAYERS.map((l) => s.get(layerKey(l, pattern)));

test('the group fields: filter, LFO and arpeggiator settings of a layer, morphs included', () => {
  for (const g of Object.values(SYNTH_GROUPS)) {
    for (const p of g.patterns) assert.equal(expandPattern(p).length, 3, p);
  }
  assert.ok(SYNTH_GROUPS.filter.patterns.includes('synth{L}Sound.fltFreq'));
  assert.ok(SYNTH_GROUPS.filter.patterns.includes('synth{L}Sound.fltFreq.morphWheel'));
  assert.ok(SYNTH_GROUPS.lfo.patterns.includes('synth{L}Sound.lfoClkEnable'));
  assert.ok(SYNTH_GROUPS.arp.patterns.includes('synth{L}.arpRateClkDiv'));
  assert.ok(!SYNTH_GROUPS.filter.patterns.includes('synth{L}Sound.ampEnvAtk'), 'the amp envelope is not grouped');
});

test('switching a group on copies the focused layer\'s settings to every layer (M p.32)', () => {
  const s = new ParamStore(initProgram());
  s.setMany([['synthASound.fltFreq', 40], ['synthBSound.fltFreq', 90], ['synthCSound.fltFreq', 120],
    ['synthBSound.fltType', 4], ['synthBSound.ampEnvAtk', 50], ['synth.layerFocusSyn_I', 1]], 'ui');
  const batches: number[] = [];
  s.onChange((b) => batches.push(b.length));
  setSynthGroup(s, 'filter', true);
  assert.equal(s.get('synth.multiLayerFlt'), 1);
  assert.deepEqual(all(s, 'synth{L}Sound.fltFreq'), [90, 90, 90], 'layer B is focused: its filter wins');
  assert.deepEqual(all(s, 'synth{L}Sound.fltType'), [4, 4, 4]);
  assert.equal(s.get('synthASound.ampEnvAtk'), descriptorOf('synthASound.ampEnvAtk').default, 'other fields stay');
  assert.equal(batches.length, 1, 'one batch');
});

test('while a group is on, an edit of any layer reaches all three; off keeps them but edits split again', () => {
  const s = new ParamStore(initProgram());
  setSynthGroup(s, 'lfo', true);
  assert.equal(activeGroupOf(s, 'synthCSound.lfoAmt'), 'lfo');
  assert.equal(activeGroupOf(s, 'synthCSound.fltFreq'), null, 'the filter group is off');
  setSynthParam(s, 'synthCSound.lfoAmt', 77);
  assert.deepEqual(all(s, 'synth{L}Sound.lfoAmt'), [77, 77, 77]);
  setSynthParam(s, 'synthASound.fltFreq', 10);
  assert.deepEqual(all(s, 'synth{L}Sound.fltFreq').slice(0, 1), [10]);
  assert.notEqual(s.get('synthBSound.fltFreq'), 10, 'not grouped: one layer');
  setSynthGroup(s, 'lfo', false);
  assert.deepEqual(all(s, 'synth{L}Sound.lfoAmt'), [77, 77, 77], 'the same settings until changed (M p.14–15)');
  setSynthParam(s, 'synthBSound.lfoAmt', 5);
  assert.deepEqual(all(s, 'synth{L}Sound.lfoAmt'), [77, 5, 77]);
});

test('controls write through the group: the group switch and grouped faders and selects', () => {
  const s = new ParamStore(initProgram());
  s.set('synthASound.fltRes', 99);
  writeControl(s, descriptorOf('synth.multiLayerFlt'), 1);
  assert.deepEqual(all(s, 'synth{L}Sound.fltRes'), [99, 99, 99]);
  writeControl(s, descriptorOf('synthBSound.fltFreq'), 33);
  assert.deepEqual(all(s, 'synth{L}Sound.fltFreq'), [33, 33, 33]);
  writeControl(s, descriptorOf('synth.multiLayerArp'), 1);
  writeControl(s, descriptorOf('synthCSound.oscTuneCoarse'), 12);
  assert.equal(s.get('synthCSound.oscTuneCoarse'), 12);
  assert.notEqual(s.get('synthASound.oscTuneCoarse'), 12, 'the oscillator is never grouped');
  assert.notEqual(s.get('synthBSound.oscTuneCoarse'), 12);
  writeControl(s, descriptorOf('synthA.arpRun'), 1);
  assert.deepEqual(all(s, 'synth{L}.arpRun'), [1, 1, 1], 'the arp group shares arp run');
});

function engineSetup() {
  const ctx = new FakeContext();
  const store = new ParamStore(initProgram());
  store.set('synth.layerEnableSyn_I', 3);
  const engine = new SynthEngine(asContext(ctx), store, undefined, asNode(new FakeGain(ctx)),
    { timer: { start: () => 1, stop: () => undefined } });
  store.onChange((b) => engine.applyChanges(b));
  const on = (note: number, layer: SynthLayer): void => {
    const e: RoutedNoteOn<SynthLayer> = { type: 'noteOn', key: note, note, velocity: 100, layers: [{ layer, gain: 1 }] };
    engine.handle(e);
  };
  return { ctx, store, engine, on };
}

test('with the filter group on, a voice on layer B follows an edit of layer A\'s filter', () => {
  const { store, engine, on } = engineSetup();
  on(60, 'B');
  const before = engine.voices()[0]!.filterHz[0]!;
  writeControl(store, descriptorOf('synthASound.fltFreq'), 20);
  assert.equal(engine.voices()[0]!.filterHz[0], before, 'not grouped: B keeps its filter');
  writeControl(store, descriptorOf('synth.multiLayerFlt'), 1);
  writeControl(store, descriptorOf('synthASound.fltFreq'), 100);
  const after = engine.voices()[0]!.filterHz[0]!;
  assert.notEqual(after, before);
  assert.equal(store.get('synthBSound.fltFreq'), 100);
});

test('the LFO group restarts the LFOs of every layer in phase (M p.34)', () => {
  const { ctx, store } = engineSetup();
  ctx.advance(1.234);
  const before = ctx.sources.length;
  setSynthGroup(store, 'lfo', true);
  const fresh = ctx.sources.slice(before).filter((s) => s instanceof FakeOscillator);
  assert.equal(fresh.length, 3, 'one new LFO source per layer');
  assert.ok(fresh.every((s) => s.startAt === 1.234), 'all start together');
  setSynthGroup(store, 'lfo', false);
  assert.equal(ctx.sources.length, before + 3, 'switching it off restarts nothing');
});
