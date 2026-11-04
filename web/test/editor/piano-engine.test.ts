/** Plan section 13.3: the browser piano on the shared fake audio context: voices, cap, re-strike, pedal, panic, live changes. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HALF_PARTIALS_ABOVE, MAX_PIANO_VOICES, PianoEngine } from '../../src/editor/audio/piano/engine.ts';
import { touchX } from '../../src/editor/audio/piano/mapping.ts';
import type { PianoLayer, RoutedNoteOn } from '../../src/editor/audio/section.ts';
import { initProgram } from '../../src/editor/model/init.ts';
import type { Ns4Key } from '../../src/editor/model/keys.ts';
import { modelsOfType } from '../../src/editor/model/pianos.ts';
import { ParamStore } from '../../src/editor/model/store.ts';
import {
  asContext, asNode, FakeBiquad, FakeBufferSource, FakeConstantSource, FakeContext, FakeGain, type FakeNode,
  FakeOscillator, installAudioGlobals,
} from './fake-audio.ts';

installAudioGlobals();

/** The shared fake, also listing the gains it creates in order (the fake itself tracks only sources). */
class RecordingContext extends FakeContext {
  readonly gains: FakeGain[] = [];
  override createGain(): FakeGain {
    const g = super.createGain();
    this.gains.push(g);
    return g;
  }
}

function setup(changes: ReadonlyArray<readonly [Ns4Key, number]> = []) {
  const ctx = new RecordingContext();
  const out = ctx.createGain();
  const store = new ParamStore(initProgram());
  if (changes.length > 0) store.setMany(changes, 'ui');
  const engine = new PianoEngine({ ctx: asContext(ctx), values: store, out: asNode(out) });
  store.onChange((batch) => engine.applyChanges(batch));
  return { ctx, out, store, engine };
}

function on(note: number, velocity = 100, layers: readonly PianoLayer[] = ['A'], gain = 1): RoutedNoteOn<PianoLayer> {
  return { type: 'noteOn', key: note, note, velocity, layers: layers.map((layer) => ({ layer, gain })) };
}

const off = (note: number) => ({ type: 'noteOff', key: note, note }) as const;

/** The layer's level GainNode: input → 4 timbre filters → level. */
function chain(engine: PianoEngine, layer: PianoLayer): { bands: FakeBiquad[]; level: FakeGain } {
  let node = engine.layerNodes(layer).input as unknown as FakeNode;
  const bands: FakeBiquad[] = [];
  for (let i = 0; i < 4; i++) {
    node = [...node.outputs].find((n) => n instanceof FakeBiquad) as FakeBiquad;
    bands.push(node as FakeBiquad);
  }
  return { bands, level: [...node.outputs][0] as FakeGain };
}

const oscillators = (ctx: FakeContext): FakeOscillator[] => ctx.sources.filter((s) => s instanceof FakeOscillator) as FakeOscillator[];

test('a note starts a voice that frees itself after key-up', () => {
  const { ctx, out, engine } = setup();
  assert.equal(chain(engine, 'A').level.outputs.has(out), true);
  engine.handle(on(60));
  assert.equal(engine.activeCount, 1);
  const [v] = engine.voices();
  assert.deepEqual([v!.layer, v!.note, v!.pitch, v!.family, v!.state], ['A', 60, 60, 'grand', 'held']);
  assert.ok(ctx.live().length >= 11);
  ctx.advance(0.5);
  engine.handle(off(60));
  assert.equal(engine.voices()[0]!.state, 'releasing');
  ctx.advance(0.5 + 0.55 * 2.5);
  assert.equal(engine.activeCount, 0);
  assert.ok(oscillators(ctx).every((o) => o.ended && o.outputs.size === 0), 'every oscillator stopped and disconnected');
});

test('a held note decays by itself; noteOff names the sounding note on every layer', () => {
  const { ctx, engine } = setup();
  engine.handle(on(100, 100, ['A', 'B']));
  assert.equal(engine.activeCount, 2);
  ctx.advance(30);
  assert.equal(engine.activeCount, 0);
  engine.handle(on(60, 100, ['A', 'B']));
  engine.handle(off(61));
  assert.ok(engine.voices().every((v) => v.state === 'held'));
  engine.handle(off(60));
  assert.ok(engine.voices().every((v) => v.state === 'releasing'));
});

test('the octave shift and the model pick the pitch and the recipe of new voices', () => {
  const shifted = setup([['pianoA.octaveShift', 2]]);
  shifted.engine.handle(on(110));
  assert.equal(shifted.engine.activeCount, 0, 'a pitch above 127 is not played');
  const clav = modelsOfType('clav').find((m) => m.family === 'clavinet')!;
  const { store, engine } = setup();
  store.setMany([['pianoA.octaveShift', 1], ['pianoA.bank', 3], ['pianoA.nameHash', clav.hash]], 'ui');
  engine.handle(on(48));
  assert.deepEqual([engine.voices()[0]!.pitch, engine.voices()[0]!.family], [60, 'clavinet']);
  store.set('pianoA.bank', 0); // the clavinet's hash under Grand: the Grand default
  engine.handle(on(50));
  assert.equal(engine.voices()[1]!.family, 'grand');
  store.set('pianoB.bank', 5);
  engine.handle(on(52, 100, ['B']));
  assert.equal(engine.voices()[2]!.family, 'vibraphone');
});

test(`${MAX_PIANO_VOICES} voices over both layers: the oldest releasing voice is stolen first`, () => {
  const { engine } = setup();
  for (let n = 30; n < 90; n++) engine.handle(on(n, 100, ['A', 'B']));
  assert.equal(engine.activeCount, MAX_PIANO_VOICES);
  engine.handle(off(70)); // two voices of note 70 release
  engine.handle(on(95));
  assert.equal(engine.activeCount, MAX_PIANO_VOICES);
  const notes = engine.voices().map((v) => `${v.layer}${v.note}`);
  assert.ok(notes.includes('B70') && !notes.includes('A70'), 'the older releasing voice went');
  assert.ok(notes.includes('A30'), 'held voices stay while a releasing one is left');
  engine.handle(on(96));
  engine.handle(on(97));
  const after = engine.voices().map((v) => `${v.layer}${v.note}`);
  assert.ok(!after.includes('B70') && !after.includes('A30'), 'then the oldest held');
  assert.equal(engine.activeCount, MAX_PIANO_VOICES);
});

test(`above ${HALF_PARTIALS_ABOVE} sounding voices new voices get half their partials`, () => {
  const { engine } = setup();
  for (let n = 0; n < HALF_PARTIALS_ABOVE; n++) engine.handle(on(30 + (n % 6), 100, [n < 6 ? 'A' : 'B']));
  for (let n = 36; engine.activeCount < HALF_PARTIALS_ABOVE; n++) engine.handle(on(n, 100, ['A']));
  engine.handle(on(30, 100, ['A'])); // note 30 on A: a re-strike; 47 others sound
  const before = engine.voices().at(-1)!.sources;
  engine.handle(on(31, 100, ['B'])); // re-strike too, 47 others sound
  engine.handle(on(37, 100, ['B'])); // 48 others sound: half
  const half = engine.voices().at(-1)!.sources;
  assert.equal(before, 11, 'note 30: ten partials and the hammer');
  assert.equal(half, 6, 'note 37: five partials and the hammer');
});

test('re-strike: the same note on the same layer fades the old voice in 30 ms', () => {
  const { ctx, engine } = setup();
  engine.handle(on(60));
  const first = engine.voices()[0]!.id;
  engine.handle(on(60));
  assert.equal(engine.activeCount, 1);
  assert.notEqual(engine.voices()[0]!.id, first);
  engine.handle(on(60, 100, ['B']));
  assert.equal(engine.activeCount, 2);
  ctx.advance(0.04);
  assert.equal(engine.activeCount, 2);
  const faded = oscillators(ctx).filter((o) => o.ended);
  assert.ok(faded.length > 0 && faded.every((o) => o.stopAt <= 0.036), 'the first voice stopped after its fade');
});

test('the sustain pedal holds layers with the sustain switch on', () => {
  const { store, engine } = setup();
  engine.handle({ type: 'sustain', on: true });
  engine.handle(on(60, 100, ['A', 'B']));
  engine.handle(off(60));
  assert.deepEqual(engine.voices().map((v) => v.state), ['sustained', 'sustained']);
  engine.handle({ type: 'sustain', on: false });
  assert.deepEqual(engine.voices().map((v) => v.state), ['releasing', 'releasing']);

  store.set('pianoB.sustainEnable', 0);
  engine.handle({ type: 'sustain', on: true });
  engine.handle(on(62, 100, ['A', 'B']));
  engine.handle(off(62));
  const states = engine.voices().filter((v) => v.note === 62).map((v) => `${v.layer}:${v.state}`);
  assert.deepEqual(states, ['A:sustained', 'B:releasing']);
  engine.handle(on(64));
  assert.equal(engine.voices().find((v) => v.note === 64)!.state, 'held', 'the pedal never holds a key that is down');
});

test('string resonance: eligible voices build the comb bank; the send opens with the pedal', () => {
  const { store, engine } = setup();
  const a = engine.layerNodes('A');
  engine.handle(on(30)); // init: Grand without a model counts as Med: middle range only
  assert.equal(a.hasResonance, false);
  engine.handle(on(60));
  assert.equal(a.hasResonance, true);
  assert.equal(a.sendOpen, false);
  engine.handle({ type: 'sustain', on: true });
  assert.equal(a.sendOpen, true);
  store.set('pianoA.acoustic', 0);
  assert.equal(a.sendOpen, false, 'String Res off closes the send at once');
  store.set('pianoA.acoustic', 1);
  engine.handle({ type: 'sustain', on: false });
  assert.equal(a.sendOpen, false);
  store.set('pianoB.bank', 2); // Electric: no resonance
  engine.handle(on(60, 100, ['B']));
  assert.equal(engine.layerNodes('B').hasResonance, false);
});

test('pedal noise plays on enabled layers with the switch on, at pedal-down and pedal-up', () => {
  const { ctx, store, engine } = setup([['common.sectionEnablePno_I', 1], ['piano.layerEnablePno_I', 1]]);
  const bursts = (): number => ctx.sources.filter((s) => s instanceof FakeBufferSource).length;
  engine.handle({ type: 'sustain', on: true });
  assert.equal(bursts(), 1, 'layer A only: B is off in the scene');
  engine.handle({ type: 'sustain', on: true });
  assert.equal(bursts(), 1, 'a repeated pedal-down is no new event');
  engine.handle({ type: 'sustain', on: false });
  assert.equal(bursts(), 2);
  store.set('pianoA.pedalNoise', 0);
  engine.handle({ type: 'sustain', on: true });
  assert.equal(bursts(), 2);
});

test('panic frees every voice at once and the nodes fade within about 10 ms', () => {
  const { ctx, engine } = setup();
  engine.handle({ type: 'sustain', on: true });
  for (let n = 40; n < 60; n++) engine.handle(on(n, 90, ['A', 'B']));
  engine.handle(off(41));
  ctx.advance(0.2);
  engine.panic();
  assert.equal(engine.activeCount, 0);
  assert.equal(engine.pedal, false);
  assert.ok(oscillators(ctx).every((o) => o.stopAt <= 0.2 + 0.016));
  ctx.advance(0.25);
  assert.equal(ctx.live().filter((s) => s instanceof FakeOscillator).length, 0);
  engine.handle(off(40));
  assert.equal(engine.activeCount, 0);
});

test('layer level, timbre and pitch stick follow the store live; other sections are ignored', () => {
  const { ctx, store, engine } = setup();
  const a = chain(engine, 'A');
  assert.ok(Math.abs(a.level.gain.value - 1) < 1e-9);
  store.set('piano.layerLevelPnoA', 0);
  assert.equal(a.level.gain.value, 0);
  store.set('pianoA.eq', 3); // Grand: Bright
  assert.deepEqual([a.bands[0]!.type, a.bands[0]!.gain.value], ['highshelf', 6]);
  store.set('pianoA.bank', 2); // Electric: eq 3 is Bright with two bands
  assert.deepEqual([a.bands[0]!.type, a.bands[1]!.type], ['peaking', 'highshelf']);
  store.set('pianoA.eq', 0);
  assert.ok(a.bands.every((f) => f.type === 'peaking' && f.gain.value === 0), 'flat');

  const bend = engine.layerNodes('A').bend as unknown as FakeConstantSource;
  engine.handle({ type: 'bend', value: 8191 });
  assert.equal(bend.offset.value, 0, 'pitch stick off');
  store.set('pianoA.pStickEnable', 1);
  assert.equal(bend.offset.value, 200);
  const started = oscillators(ctx).length;
  engine.handle(on(60));
  const voiceOscs = oscillators(ctx).slice(started);
  assert.equal(voiceOscs.length, 3, 'tine: carrier, bell, modulator');
  assert.ok(voiceOscs.every((o) => bend.outputs.has(o.detune)), 'the bend reaches every oscillator of the voice');

  const count = engine.activeCount;
  store.set('synthASound.fltFreq', 40);
  store.set('synth.layerFocusSyn_I', 1);
  assert.equal(engine.activeCount, count);
});

test('unison doubles the oscillators and pans the copies', () => {
  const { ctx, store, engine } = setup();
  engine.handle(on(60));
  const plain = engine.voices()[0]!.sources;
  store.set('pianoA.unison', 2);
  const panners = ctx.count('stereoPanner');
  engine.handle(on(62));
  assert.equal(engine.voices()[1]!.sources, 2 * (plain - 1) + 1, 'oscillators doubled, one hammer');
  assert.equal(ctx.count('stereoPanner') - panners, 2);
});

test('touch: a soft note is quieter on heavy than on light; the harpsichord ignores velocity', () => {
  const levelFor = (changes: ReadonlyArray<readonly [Ns4Key, number]>, velocity: number): number => {
    const { ctx, engine } = setup(changes);
    const before = ctx.gains.length;
    engine.handle(on(60, velocity));
    const input = engine.layerNodes('A').input as unknown as FakeNode;
    // The voice's out gain: the GainNode it connects to the layer input.
    return ctx.gains.slice(before).reverse().find((g) => g.outputs.has(input))!.gain.value; // after the comb bank's wet gain
  };
  assert.ok(touchX(40, 0) < touchX(40, 2));
  assert.ok(levelFor([['pianoA.kbdTouch', 0]], 40) < levelFor([['pianoA.kbdTouch', 2]], 40));
  assert.ok(levelFor([['pianoA.dynComp', 3]], 20) > levelFor([['pianoA.dynComp', 0]], 20));
  const harpsi = modelsOfType('clav').find((m) => m.family === 'harpsichord')!;
  const h: ReadonlyArray<readonly [Ns4Key, number]> = [['pianoA.bank', 3], ['pianoA.nameHash', harpsi.hash]];
  assert.equal(levelFor(h, 10), levelFor(h, 127));
});

test('a load batch reloads: voices stop, layers follow the new program', () => {
  const { store, engine } = setup();
  engine.handle(on(60));
  const snap = store.snapshot();
  store.load({ ...snap, values: { ...snap.values, 'piano.layerLevelPnoB': 0 } }, 'load');
  assert.equal(engine.activeCount, 0);
  assert.equal(chain(engine, 'B').level.gain.value, 0);
  engine.dispose();
  engine.handle(on(60));
  assert.equal(engine.activeCount, 0);
});
