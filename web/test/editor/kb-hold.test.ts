/**
 * Plan section 14: KB hold in the synth engine (manual p.36), on the fake audio context. Notes
 * keep sounding after key-up; the next key after all keys were lifted starts a new chord; while
 * keys are down new notes join; exclude keeps a layer out; KB Hold off, exclude and panic release
 * the kept notes; the sustain pedal still works on top; the arpeggiator keeps running on held notes.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type ArpTimer, SynthEngine } from '../../src/editor/audio/engine.ts';
import { holdOn } from '../../src/editor/audio/mapping.ts';
import type { RoutedNoteOn } from '../../src/editor/audio/section.ts';
import { VoiceAllocator } from '../../src/editor/audio/voice-alloc.ts';
import { initProgram } from '../../src/editor/model/init.ts';
import type { Ns4Key, SynthLayer } from '../../src/editor/model/keys.ts';
import { ParamStore } from '../../src/editor/model/store.ts';
import { asContext, asNode, FakeContext, FakeGain, installAudioGlobals } from './fake-audio.ts';

installAudioGlobals();

const timer: ArpTimer = { start: () => 1, stop: () => undefined };

function setup(edits: ReadonlyArray<readonly [Ns4Key, number]> = [['synth.kbdHoldEnableCommon', 1]]) {
  const ctx = new FakeContext();
  const store = new ParamStore(initProgram());
  store.setMany([...edits], 'ui');
  const alloc = new VoiceAllocator();
  const engine = new SynthEngine(asContext(ctx), store, alloc, asNode(new FakeGain(ctx)), { timer });
  store.onChange((batch) => engine.applyChanges(batch));
  const on = (note: number, layers: SynthLayer[] = ['A']): void => {
    const e: RoutedNoteOn<SynthLayer> = { type: 'noteOn', key: note, note, velocity: 100, layers: layers.map((layer) => ({ layer, gain: 1 })) };
    engine.handle(e);
  };
  const off = (note: number): void => engine.handle({ type: 'noteOff', key: note, note });
  const state = (layer: SynthLayer = 'A'): Array<[number, string]> => alloc.voices()
    .filter((v) => v.layer === layer).map((v) => [v.note, v.state] as [number, string]).sort((a, b) => a[0] - b[0]);
  return { ctx, store, alloc, engine, on, off, state };
}

test('kb hold keeps notes after key-up; the default layer setting is include', () => {
  const { store, on, off, state, engine } = setup();
  assert.ok(holdOn(store, 'A'));
  on(60);
  on(64);
  off(60);
  off(64);
  assert.deepEqual(state(), [[60, 'held'], [64, 'held']]);
  assert.deepEqual(engine.held().A, { keys: [], hold: [60, 64], arp: 'off' });
});

test('a new chord after all keys were lifted replaces the held one; while keys are down notes join', () => {
  const { on, off, state, engine } = setup();
  on(60);
  off(60);
  on(64);
  assert.deepEqual(state(), [[60, 'releasing'], [64, 'held']], 'the new key let go of the old chord');
  on(67);
  off(64);
  off(67);
  assert.deepEqual(engine.held().A.hold, [64, 67], 'legato: the second key joined the first');
  on(60);
  assert.deepEqual(state().filter(([, s]) => s === 'held'), [[60, 'held']]);
});

test('a held note struck again restarts it without hanging', () => {
  const { on, off, state, engine } = setup();
  on(60);
  off(60);
  on(60);
  assert.deepEqual(state(), [[60, 'releasing'], [60, 'held']]);
  off(60);
  assert.deepEqual(engine.held().A.hold, [60]);
});

test('exclude keeps a layer out of kb hold', () => {
  const { on, off, state } = setup([['synth.kbdHoldEnableCommon', 1], ['synth.layerEnableSyn_I', 3],
    ['synthB.kbdHoldEnableLayer', 0]]);
  on(60, ['A', 'B']);
  off(60);
  assert.deepEqual(state('A'), [[60, 'held']]);
  assert.deepEqual(state('B'), [[60, 'releasing']]);
});

test('a drone on one layer survives keys played on an excluded layer', () => {
  const { on, off, state } = setup([['synth.kbdHoldEnableCommon', 1], ['synth.layerEnableSyn_I', 3],
    ['synthB.kbdHoldEnableLayer', 0]]);
  on(48, ['A']);
  off(48);
  on(72, ['B']);
  off(72);
  assert.deepEqual(state('A'), [[48, 'held']], 'layer B\'s keys do not start a new chord on layer A');
});

test('kb hold off, or excluding the layer, releases the kept notes', () => {
  const { store, on, off, state } = setup([['synth.kbdHoldEnableCommon', 1], ['synth.layerEnableSyn_I', 3]]);
  on(60, ['A', 'B']);
  off(60);
  store.set('synthB.kbdHoldEnableLayer', 0);
  assert.deepEqual(state('B'), [[60, 'releasing']]);
  assert.deepEqual(state('A'), [[60, 'held']]);
  store.set('synth.kbdHoldEnableCommon', 0);
  assert.deepEqual(state('A'), [[60, 'releasing']]);
});

test('kb hold off leaves keys that are still down alone', () => {
  const { store, on, off, state } = setup();
  on(60);
  on(64);
  off(60);
  store.set('synth.kbdHoldEnableCommon', 0);
  assert.deepEqual(state(), [[60, 'releasing'], [64, 'held']]);
  off(64);
  assert.deepEqual(state(), [[60, 'releasing'], [64, 'releasing']]);
});

test('panic clears kb hold', () => {
  const { on, off, engine, alloc } = setup();
  on(60);
  off(60);
  engine.handle({ type: 'panic' });
  assert.equal(alloc.activeCount, 0);
  assert.deepEqual(engine.held().A.hold, []);
  on(64);
  off(64);
  assert.deepEqual(engine.held().A.hold, [64], 'hold still works after a panic');
});

test('the sustain pedal on top of kb hold: replaced notes are sustained until the pedal comes up', () => {
  const { on, off, state, engine } = setup();
  engine.handle({ type: 'sustain', on: true });
  on(60);
  off(60);
  assert.deepEqual(state(), [[60, 'held']], 'kept by hold, not by the pedal');
  on(64);
  assert.deepEqual(state(), [[60, 'sustained'], [64, 'held']], 'the replaced chord rings on the pedal');
  engine.handle({ type: 'sustain', on: false });
  assert.deepEqual(state(), [[60, 'releasing'], [64, 'held']], 'pedal up: the held note stays held');
});

test('without kb hold nothing changes: key-up releases, the pedal sustains', () => {
  const { on, off, state, engine } = setup([]);
  on(60);
  off(60);
  assert.deepEqual(state(), [[60, 'releasing']]);
  engine.handle({ type: 'sustain', on: true });
  on(62);
  off(62);
  assert.deepEqual(state().filter(([n]) => n === 62), [[62, 'sustained']]);
});

test('the arpeggiator keeps running on held notes; a new chord replaces its input', () => {
  const { ctx, store, on, off, engine } = setup([['synth.kbdHoldEnableCommon', 1], ['synthA.arpRun', 1]]);
  on(60);
  on(64);
  off(60);
  off(64);
  for (let t = 0.025; t <= 1; t += 0.025) {
    ctx.advance(t);
    engine.tick();
  }
  const notes = engine.arpLog().filter((e) => e.type === 'on').map((e) => (e as { note: number }).note);
  assert.ok(notes.length >= 3 && notes.includes(60) && notes.includes(64), `arpeggio after key-up: ${notes}`);
  on(67);
  off(67);
  const n = engine.arpLog().length;
  for (let t = 1.025; t <= 2; t += 0.025) {
    ctx.advance(t);
    engine.tick();
  }
  const later = engine.arpLog().slice(n).filter((e) => e.type === 'on').map((e) => (e as { note: number }).note);
  assert.ok(later.length >= 3 && later.every((x) => x === 67), `only the new chord: ${later}`);
  store.set('synth.kbdHoldEnableCommon', 0);
  assert.deepEqual(engine.held().A.hold, []);
});
