/**
 * Plan section 13.5: the synth as a SectionEngine behind the router, on the shared fake audio
 * context. A shared output replaces the engine's own master; each voice gets its split crossfade
 * gain once, at note-on; layers that cannot sound are skipped; a mono retarget keeps the first
 * gain; the MasterBus keeps the -12 dB headroom and the limiter; the router plays the real synth;
 * a panic forgets the sustain pedal in every engine.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SynthEngine, synthFactory } from '../../src/editor/audio/engine.ts';
import { MasterBus } from '../../src/editor/audio/master.ts';
import { OrganEngine, organFactory } from '../../src/editor/audio/organ/engine.ts';
import { PianoEngine, pianoFactory } from '../../src/editor/audio/piano/engine.ts';
import { Router } from '../../src/editor/audio/router.ts';
import type { RoutedNoteOn } from '../../src/editor/audio/section.ts';
import { initProgram } from '../../src/editor/model/init.ts';
import type { SynthLayer } from '../../src/editor/model/keys.ts';
import { ParamStore } from '../../src/editor/model/store.ts';
import {
  asContext, asNode, FakeContext, FakeGain, FakeNode, FakeStereoPanner, installAudioGlobals,
} from './fake-audio.ts';

installAudioGlobals();

/** The shared fake, also keeping every GainNode it made. */
class GainContext extends FakeContext {
  readonly gains: FakeGain[] = [];
  override createGain(): FakeGain {
    const g = super.createGain();
    this.gains.push(g);
    return g;
  }
}

function setup() {
  const ctx = new GainContext();
  const out = new FakeGain(ctx);
  const store = new ParamStore(initProgram());
  const engine = new SynthEngine(asContext(ctx), store, undefined, asNode(out));
  store.onChange((batch) => engine.applyChanges(batch));
  const noteOn = (note: number, layers: Array<[SynthLayer, number]>): void => {
    const e: RoutedNoteOn<SynthLayer> = {
      type: 'noteOn', key: note, note, velocity: 100, layers: layers.map(([layer, gain]) => ({ layer, gain })),
    };
    engine.handle(e);
  };
  return { ctx, out, store, engine, noteOn };
}

test('with a shared output the synth builds no master and its layer pans feed that output', () => {
  const { ctx, out } = setup();
  assert.equal(ctx.count('dynamicsCompressor'), 0);
  const pans = [...ctx.gains.flatMap((g) => [...g.outputs])].filter((n) => n instanceof FakeStereoPanner);
  assert.equal(pans.length, 3, 'one pan per layer');
  for (const p of pans) assert.ok((p as FakeNode).outputs.has(out));
});

test('without a shared output the synth keeps its own master (as before section 13)', () => {
  const ctx = new FakeContext();
  const engine = new SynthEngine(asContext(ctx), new ParamStore(initProgram()));
  assert.equal(ctx.count('dynamicsCompressor'), 1);
  engine.dispose();
});

test('synthFactory builds the synth section on the context output', () => {
  const ctx = new FakeContext();
  const out = new FakeGain(ctx);
  const engine = synthFactory({ ctx: asContext(ctx), values: new ParamStore(initProgram()), out: asNode(out) });
  assert.equal(engine.section, 'synth');
  assert.equal(ctx.count('dynamicsCompressor'), 0);
});

test('each voice carries its hit\'s crossfade gain between the voice and the layer bus', () => {
  const { ctx, store, engine, noteOn } = setup();
  store.set('synth.layerEnableSyn_I', 3);
  noteOn(60, [['A', 0.5], ['B', 0.25]]);
  assert.deepEqual(engine.voices().map((v) => [v.layer, v.gain]), [['A', 0.5], ['B', 0.25]]);
  const xfade = ctx.gains.find((g) => g.gain.value === 0.25)!;
  assert.ok(xfade !== undefined);
  const [bus] = [...xfade.outputs];
  assert.ok(bus instanceof FakeGain, 'the xfade gain feeds the layer bus');
  assert.ok([...bus.outputs].some((n) => n instanceof FakeStereoPanner));
});

test('the crossfade gain is fixed at note-on and freed when the voice ends', () => {
  const { ctx, engine, noteOn } = setup();
  noteOn(60, [['A', 0.5]]);
  const xfade = ctx.gains.find((g) => g.gain.value === 0.5)!;
  assert.equal(xfade.outputs.size, 1);
  engine.handle({ type: 'noteOff', key: 60, note: 60 });
  assert.equal(engine.activeCount, 1, 'releasing');
  ctx.advance(60);
  assert.equal(engine.activeCount, 0);
  assert.equal(xfade.outputs.size, 0, 'disconnected with the voice');
});

test('hits on layers that cannot sound start no voice', () => {
  const { store, engine, noteOn } = setup();
  store.set('synthBSound.oscBank', 3); // wave oscillators: not implemented
  noteOn(60, [['A', 1], ['B', 1]]);
  assert.deepEqual(engine.voices().map((v) => v.layer), ['A']);
});

test('a mono retarget keeps the gain of the voice\'s first note', () => {
  const { store, engine, noteOn } = setup();
  store.set('synthA.voiceMode', 1); // mono
  noteOn(60, [['A', 0.5]]);
  noteOn(64, [['A', 1]]);
  assert.deepEqual(engine.voices().map((v) => [v.note, v.gain]), [[64, 0.5]]);
});

test('a routed note-off releases the note on every layer; panic leaves nothing', () => {
  const { store, engine, noteOn } = setup();
  store.set('synth.layerEnableSyn_I', 7);
  noteOn(60, [['A', 1], ['C', 1]]);
  noteOn(62, [['B', 1]]);
  assert.equal(engine.activeCount, 3);
  engine.handle({ type: 'noteOff', key: 60, note: 60 });
  engine.handle({ type: 'sustain', on: true });
  engine.panic();
  assert.equal(engine.activeCount, 0);
});

test('MasterBus: -12 dB into a limiter into the destination', () => {
  const ctx = new FakeContext();
  const master = new MasterBus(asContext(ctx));
  const input = master.input as unknown as FakeGain;
  assert.equal(input.gain.value, 0.25);
  const [limiter] = [...input.outputs];
  assert.equal((limiter as FakeNode).kind, 'dynamicsCompressor');
  assert.ok((limiter as FakeNode).outputs.has(ctx.destination));
  master.dispose();
  assert.equal(input.outputs.size, 0);
});

test('the router plays the real synth: split crossfade gain on the voice, transpose on its note', () => {
  const ctx = new GainContext();
  const master = new MasterBus(asContext(ctx));
  const store = new ParamStore(initProgram());
  const synth = synthFactory({ ctx: asContext(ctx), values: store, out: master.input }) as SynthEngine;
  const router = new Router(store, { synth });
  store.onChange((batch) => router.applyChanges(batch));
  store.setMany([
    ['common.splitEnabled', 1], ['common.splitEnabledMid', 1], ['common.splitPosMid', 4], ['common.splitWidthMid', 2],
    ['synthA.kbZone', 0], // '11oo': below C4, fading out over C4 ± 12
    ['common.transposeEnable', 1], ['common.transposeValue', -2],
  ], 'ui');
  router.handle({ type: 'noteOn', note: 60, velocity: 100, source: 'computer' });
  const [v] = synth.voices();
  assert.equal(v?.note, 58);
  assert.ok(Math.abs(v!.gain - Math.SQRT1_2) < 1e-9, String(v?.gain));
  router.handle({ type: 'noteOn', note: 80, velocity: 100, source: 'computer' });
  assert.equal(synth.voices().length, 1, 'above C4 + 12 the lower zone is silent');
  store.set('common.transposeValue', 3);
  router.handle({ type: 'noteOff', note: 60, source: 'computer' });
  assert.equal(router.activeCount, 1, 'released, still in its tail');
  ctx.advance(60);
  assert.equal(router.activeCount, 0);
});

test('a panic forgets the sustain pedal in every engine: later notes end at key-up', () => {
  const ctx = new GainContext();
  const master = new MasterBus(asContext(ctx));
  const store = new ParamStore(initProgram());
  const c = { ctx: asContext(ctx), values: store, out: master.input };
  const organ = organFactory(c) as OrganEngine;
  const piano = pianoFactory(c) as PianoEngine;
  const synth = synthFactory(c) as SynthEngine;
  const router = new Router(store, { organ, piano, synth });
  store.onChange((batch) => router.applyChanges(batch));
  store.setMany([
    ['common.sectionEnableOrg_I', 1], ['common.sectionEnablePno_I', 1], ['common.sectionEnableSyn_I', 1],
    ['organ.layerEnableOrg_I', 1], ['piano.layerEnablePno_I', 1], ['synth.layerEnableSyn_I', 1],
    ['organA.sustainEnable', 1], ['pianoA.sustainEnable', 1], ['synthA.sustainEnable', 1],
  ], 'ui');
  router.handle({ type: 'sustain', on: true });
  router.handle({ type: 'panic' });
  router.handle({ type: 'noteOn', note: 60, velocity: 100, source: 'computer' });
  assert.deepEqual([organ.activeCount > 0, piano.activeCount > 0, synth.activeCount > 0], [true, true, true],
    'every section plays the note');
  router.handle({ type: 'noteOff', note: 60, source: 'computer' });
  assert.ok(organ.voices().every((v) => v.state === 'releasing'), 'organ: released, not sustained');
  ctx.advance(60);
  assert.deepEqual([organ.activeCount, piano.activeCount, synth.activeCount], [0, 0, 0]);
});
