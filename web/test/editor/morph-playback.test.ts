/**
 * Plan section 15.2 (builder B2): morph playback on the shared fake audio context. The engines
 * read MorphedValues, so a moved source reaches them as 'morph' changes: the synth cutoff, an
 * organ drawbar and a piano layer level follow; an amount edited while its source is off rest
 * plays at once (MorphedValues.expand); panic rests every source. The organ rotary speed reads
 * the unrounded fraction and runs between slow and fast (audio/organ/rotary.ts, M p.53).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SynthEngine } from '../../src/editor/audio/engine.ts';
import { filterSpec } from '../../src/editor/audio/mapping.ts';
import { OrganEngine } from '../../src/editor/audio/organ/engine.ts';
import {
  drawbarKey, drawbarLevel, ROTOR_SPEEDS, rotorTargets, wheelFrequency, wheelIndex,
} from '../../src/editor/audio/organ/params.ts';
import { morphedRotorTargets } from '../../src/editor/audio/organ/rotary.ts';
import { PianoEngine } from '../../src/editor/audio/piano/engine.ts';
import type { SynthLayer } from '../../src/editor/model/keys.ts';
import { ScreenControllers } from '../../src/editor/input/controllers.ts';
import { PlayBus } from '../../src/editor/input/events.ts';
import { initProgram } from '../../src/editor/model/init.ts';
import { morphKey, MorphedValues, positionOf, SOURCE_OF_CONTROLLER } from '../../src/editor/model/morph.ts';
import type { Change } from '../../src/editor/model/store.ts';
import { ParamStore } from '../../src/editor/model/store.ts';
import {
  asContext, asNode, FakeBiquad, FakeContext, FakeGain, type FakeNode, FakeOscillator, installAudioGlobals,
} from './fake-audio.ts';

installAudioGlobals();

const close = (a: number, b: number, eps = 1e-9): boolean => Math.abs(a - b) < eps;

interface Applies {
  applyChanges(batch: readonly Change[]): void;
}

/** The page's wiring (plan 15.12, main): store batches expanded, controller moves and panic as 'morph' changes. */
function wire(store: ParamStore, engine: Applies) {
  const morphed = new MorphedValues(store);
  store.onChange((b) => engine.applyChanges(morphed.expand(b)));
  const bus = new PlayBus();
  bus.on((e) => {
    if (e.type === 'controller') engine.applyChanges(morphed.move(SOURCE_OF_CONTROLLER[e.kind], positionOf(e.value)));
    else if (e.type === 'panic') engine.applyChanges(morphed.rest());
  });
  const controllers = new ScreenControllers(bus);
  controllers.attach(bus);
  return { morphed, bus, controllers };
}

test('synth: the wheel morph moves the cutoff of sounding voices; panic returns it', () => {
  const ctx = new FakeContext();
  const store = new ParamStore(initProgram());
  const f = 'synthASound.fltFreq';
  store.setMany([[f, 40], [morphKey(f, 'wheel'), 60]], 'ui');
  let engine: SynthEngine | null = null;
  const { morphed, bus, controllers } = wire(store, { applyChanges: (b) => engine?.applyChanges(b) });
  engine = new SynthEngine(asContext(ctx), morphed, undefined, asNode(new FakeGain(ctx)));
  const e: { layer: SynthLayer; gain: number } = { layer: 'A', gain: 1 };
  engine.handle({ type: 'noteOn', key: 60, note: 60, velocity: 100, layers: [e] });
  const rest = filterSpec(store, 'A', ctx.sampleRate).freq;
  assert.ok(engine.voices().flatMap((v) => v.filterHz).every((hz) => hz === rest));

  controllers.set('wheel', 127);
  assert.equal(morphed.get(f), 100);
  const full = filterSpec(morphed, 'A', ctx.sampleRate).freq;
  assert.ok(full > rest);
  const after = engine.voices().flatMap((v) => v.filterHz);
  assert.ok(after.length > 0 && after.every((hz) => hz === full), 'every voice filter at the morphed cutoff');
  assert.equal(store.get(f), 40, 'the store keeps the stored value');

  store.set(morphKey(f, 'wheel'), 20); // an amount edit while the wheel is up plays at once
  assert.ok(engine.voices().flatMap((v) => v.filterHz).every((hz) => hz === filterSpec(morphed, 'A', ctx.sampleRate).freq));
  assert.equal(morphed.get(f), 60);

  bus.emit({ type: 'panic' });
  assert.equal(controllers.value('wheel'), 0);
  assert.equal(morphed.get(f), 40);
});

/** The tonewheel oscillator at a frequency (as organ-engine.test.ts). */
function wheelAt(ctx: FakeContext, n: number): FakeOscillator {
  const hz = wheelFrequency(n);
  const w = ctx.sources.find((s): s is FakeOscillator => s instanceof FakeOscillator && Math.abs(s.frequency.value - hz) < 1e-9
    && [...s.outputs].length > 0 && [...s.detune.inputs].length > 0 && s.type === 'sine');
  assert.ok(w !== undefined, `wheel ${n}`);
  return w;
}

function busOf(wheel: FakeOscillator): FakeGain {
  const contact = [...wheel.outputs].find((o): o is FakeGain => o instanceof FakeGain)!;
  const bus = [...contact.outputs][0];
  assert.ok(bus instanceof FakeGain);
  return bus;
}

function organSetup() {
  const ctx = new FakeContext();
  const store = new ParamStore(initProgram());
  let engine: OrganEngine | null = null;
  const w = wire(store, { applyChanges: (b) => engine?.applyChanges(b) });
  engine = new OrganEngine({ ctx: asContext(ctx), values: w.morphed, out: asNode(ctx.destination) });
  return { ctx, store, engine, ...w };
}

test('organ: a drawbar morph steps the drawbar bus of a sounding B3 note (rounded to 0–8, p.39)', () => {
  const { ctx, store, engine, controllers } = organSetup();
  const db5 = drawbarKey('A', 5);
  store.set(morphKey(db5, 'ctrlPedal'), 8);
  engine.handle({ type: 'noteOn', key: 60, note: 60, velocity: 100, layers: [{ layer: 'A', gain: 1 }] });
  const bus5 = busOf(wheelAt(ctx, wheelIndex(60, 19)));
  assert.equal(bus5.gain.value, 0, 'init registration 888800000');
  controllers.set('pedal', 127);
  assert.equal(bus5.gain.value, 1);
  controllers.set('pedal', 64); // 8 × 64/127 = 4.03 → 4
  assert.ok(close(bus5.gain.value, drawbarLevel(4)));
  controllers.set('pedal', 0);
  assert.equal(bus5.gain.value, 0);
  assert.equal(store.get(db5), 0);
});

test('organ rotary: the speed morph sets rotor speeds between slow and fast; stop mode starts from 0 Hz', () => {
  const { store, engine, morphed, controllers } = organSetup();
  const speed = 'organ.effectsLeslieSpeed';
  store.set(morphKey(speed, 'wheel'), 1);
  assert.deepEqual(engine.rotorTargets, { horn: 0.83, drum: 0.67 });
  controllers.set('wheel', 38); // 0.299…: rounds to slow, plays 30 % of the way
  const f = 38 / 127;
  assert.equal(morphed.get(speed), 0);
  assert.ok(close(engine.rotorTargets.horn, 0.83 + (6.7 - 0.83) * f));
  assert.ok(close(engine.rotorTargets.drum, 0.67 + (5.7 - 0.67) * f));
  controllers.set('wheel', 127);
  assert.deepEqual(engine.rotorTargets, { horn: 6.7, drum: 5.7 });
  store.set('organ.effectsLeslieStopMode', 1);
  controllers.set('wheel', 64);
  const g = 64 / 127;
  assert.ok(close(engine.rotorTargets.horn, 6.7 * g), 'from stopped');
  assert.ok(close(engine.rotorTargets.drum, 5.7 * g));
  controllers.set('wheel', 0);
  assert.deepEqual(engine.rotorTargets, { horn: 0, drum: 0 });
  store.set(morphKey(speed, 'wheel'), -1);
  store.set(speed, 1);
  controllers.set('wheel', 127);
  assert.deepEqual(engine.rotorTargets, { horn: 0, drum: 0 }, 'a negative morph slows a fast rotary down to stop');
});

test('morphedRotorTargets: the plain store and the resting ends give the switch speeds', () => {
  const store = new ParamStore(initProgram());
  assert.deepEqual(morphedRotorTargets(store), rotorTargets(store));
  store.set('organ.effectsLeslieSpeed', 1);
  assert.deepEqual(morphedRotorTargets(store), rotorTargets(store));
  const reader = (fraction: number, stop = 0) => ({
    get: (k: string) => (k === 'organ.effectsLeslieStopMode' ? stop : Math.round(fraction) || 0),
    fraction: () => fraction,
  }) as unknown as MorphedValues;
  assert.deepEqual(morphedRotorTargets(reader(0)), { horn: ROTOR_SPEEDS.horn.slow, drum: ROTOR_SPEEDS.drum.slow });
  assert.deepEqual(morphedRotorTargets(reader(1)), { horn: ROTOR_SPEEDS.horn.fast, drum: ROTOR_SPEEDS.drum.fast });
  assert.deepEqual(morphedRotorTargets(reader(0, 1)), { horn: 0, drum: 0 });
  assert.ok(close(morphedRotorTargets(reader(0.5)).horn, (0.83 + 6.7) / 2));
  assert.deepEqual(morphedRotorTargets(reader(Number.NaN)), { horn: 0.83, drum: 0.67 }, 'non-finite counts as slow');
});

/** The piano layer's level GainNode: input → 4 timbre filters → level (as piano-engine.test.ts). */
function pianoLevel(engine: PianoEngine): FakeGain {
  let node = engine.layerNodes('A').input as unknown as FakeNode;
  for (let i = 0; i < 4; i++) node = [...node.outputs].find((n) => n instanceof FakeBiquad) as FakeBiquad;
  return [...node.outputs][0] as FakeGain;
}

test('piano: an aftertouch morph on the layer level follows the pressure strip and springs back', () => {
  const ctx = new FakeContext();
  const store = new ParamStore(initProgram());
  store.set(morphKey('piano.layerLevelPnoA', 'afterTouch'), -127);
  let engine: PianoEngine | null = null;
  const { morphed, controllers } = wire(store, { applyChanges: (b) => engine?.applyChanges(b) });
  engine = new PianoEngine({ ctx: asContext(ctx), values: morphed, out: asNode(ctx.createGain()) });
  const level = pianoLevel(engine);
  const rest = level.gain.value;
  assert.ok(rest > 0);
  controllers.set('pressure', 127);
  assert.equal(level.gain.value, 0, 'full pressure takes the level to 0');
  controllers.release('pressure');
  assert.equal(controllers.value('pressure'), 0);
  assert.ok(close(level.gain.value, rest));
});
