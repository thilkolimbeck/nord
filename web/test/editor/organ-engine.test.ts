/** The browser organ on the shared fake audio context: voices start and end, panic, sustain, the guard, live changes. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OrganEngine, organFactory } from '../../src/editor/audio/organ/engine.ts';
import { drawbarKey, MAX_ORGAN_VOICES, mtof, wheelFrequency, wheelIndex } from '../../src/editor/audio/organ/params.ts';
import type { LayerHit, OrganLayer } from '../../src/editor/audio/section.ts';
import { initProgram } from '../../src/editor/model/init.ts';
import { ParamStore } from '../../src/editor/model/store.ts';
import {
  asContext, asNode, FakeConstantSource, FakeContext, FakeGain, FakeNode, FakeOscillator, FakeParam, installAudioGlobals,
} from './fake-audio.ts';

installAudioGlobals();

function setup() {
  const ctx = new FakeContext();
  const store = new ParamStore(initProgram());
  const engine = new OrganEngine({ ctx: asContext(ctx), values: store, out: asNode(ctx.destination) });
  store.onChange((batch) => engine.applyChanges(batch));
  const on = (note: number, layers: ReadonlyArray<LayerHit<OrganLayer>> = [{ layer: 'A', gain: 1 }]): void =>
    engine.handle({ type: 'noteOn', key: note, note, velocity: 100, layers });
  const off = (note: number): void => engine.handle({ type: 'noteOff', key: note, note });
  return { ctx, store, engine, on, off };
}

/** The tonewheel oscillator at a frequency. */
function wheelAt(ctx: FakeContext, n: number): FakeOscillator {
  const hz = wheelFrequency(n);
  const w = ctx.sources.find((s): s is FakeOscillator => s instanceof FakeOscillator && Math.abs(s.frequency.value - hz) < 1e-9
    && [...s.outputs].length > 0 && [...s.detune.inputs].length > 0 && s.type === 'sine');
  assert.ok(w !== undefined, `wheel ${n}`);
  return w;
}

/** The drawbar bus a wheel's (first) contact feeds. */
function busOf(wheel: FakeOscillator): FakeGain {
  const contact = [...wheel.outputs].find((o): o is FakeGain => o instanceof FakeGain)!;
  const bus = [...contact.outputs][0];
  assert.ok(bus instanceof FakeGain);
  return bus;
}

/** Gates started after `from` (one per voice). */
function gates(ctx: FakeContext, from = 0): FakeConstantSource[] {
  return ctx.sources.slice(from).filter((s): s is FakeConstantSource => s instanceof FakeConstantSource);
}

test('the factory builds an organ engine; nothing sounds before a note', () => {
  const ctx = new FakeContext();
  const engine = organFactory({ ctx: asContext(ctx), values: new ParamStore(initProgram()), out: asNode(ctx.destination) });
  assert.equal(engine.section, 'organ');
  assert.equal(engine.activeCount, 0);
  assert.equal((engine as OrganEngine).tonewheelsRunning, false, 'tonewheels start at the first B3 note');
});

test('a B3 note starts the 91 tonewheels once and nine contacts; noteOff frees it after the release', () => {
  const { ctx, engine, on, off } = setup();
  const before = ctx.count('oscillator');
  on(60);
  assert.equal(engine.activeCount, 1);
  assert.equal(ctx.count('oscillator') - before, 91);
  assert.deepEqual(engine.voices().map((v) => [v.layer, v.note, v.model, v.state]), [['A', 60, 'b3', 'held']]);
  const w = wheelAt(ctx, wheelIndex(60, 0));
  assert.equal([...w.outputs].length, 1, 'one contact on the 8′ wheel');
  on(64);
  assert.equal(ctx.count('oscillator') - before, 91, 'the generator is shared');
  off(60);
  assert.equal(engine.voices().find((v) => v.note === 60)?.state, 'releasing');
  assert.equal(engine.activeCount, 2, 'still releasing until the gate ends');
  ctx.advance(0.1);
  assert.equal(engine.activeCount, 1);
  assert.equal([...w.outputs].length, 0, 'the ended voice left the wheel');
  off(64);
  ctx.advance(0.2);
  assert.equal(engine.activeCount, 0);
});

test('the router gain scales the voice once, through its gate', () => {
  const { ctx, on } = setup();
  const from = ctx.sources.length;
  on(60, [{ layer: 'A', gain: 0.4 }]);
  const gate = gates(ctx, from)[0]!;
  const ramp = gate.offset.events.find((e) => e.kind === 'linear');
  assert.ok(ramp !== undefined && 'value' in ramp && ramp.value === 0.4);
  const contacts = [...gate.outputs].filter((o) => o instanceof FakeParam);
  assert.equal(contacts.length, 9, 'drives the nine contact gains');
});

test('noteOff releases the note on every layer it started on', () => {
  const { ctx, engine, on, off } = setup();
  on(60, [{ layer: 'A', gain: 1 }, { layer: 'B', gain: 0.5 }]);
  assert.equal(engine.activeCount, 2);
  off(60);
  assert.deepEqual(engine.voices().map((v) => v.state), ['releasing', 'releasing']);
  ctx.advance(1);
  assert.equal(engine.activeCount, 0);
});

test('panic frees held, sustained and releasing voices at once; late onended changes nothing', () => {
  const { ctx, store, engine, on, off } = setup();
  store.set('organA.sustainEnable', 1);
  on(64);
  off(64); // releasing
  engine.handle({ type: 'sustain', on: true });
  on(62);
  off(62); // sustained
  on(60); // held
  assert.deepEqual(engine.voices().map((v) => [v.note, v.state]),
    [[64, 'releasing'], [62, 'sustained'], [60, 'held']]);
  engine.panic();
  assert.equal(engine.activeCount, 0);
  assert.ok(ctx.advance(1) > 0, 'the killed voices end later');
  assert.equal(engine.activeCount, 0);
  on(67);
  assert.deepEqual(engine.voices().map((v) => v.note), [67]);
});

test('sustain holds only layers whose sustain switch is on', () => {
  const { ctx, store, engine, on, off } = setup();
  store.set('organA.sustainEnable', 1);
  engine.handle({ type: 'sustain', on: true });
  on(60, [{ layer: 'A', gain: 1 }, { layer: 'B', gain: 1 }]);
  off(60);
  assert.deepEqual(engine.voices().map((v) => [v.layer, v.state]), [['A', 'sustained'], ['B', 'releasing']]);
  ctx.advance(0.5);
  assert.equal(engine.activeCount, 1);
  engine.handle({ type: 'sustain', on: false });
  assert.equal(engine.voices()[0]?.state, 'releasing');
  ctx.advance(1);
  assert.equal(engine.activeCount, 0);
});

test(`the guard keeps at most ${MAX_ORGAN_VOICES} note-layers, stealing the oldest releasing first`, () => {
  const { engine, on, off } = setup();
  on(10);
  off(10); // releasing: stolen first
  for (let i = 0; i < 64; i++) on(20 + i, [{ layer: 'A', gain: 1 }, { layer: 'B', gain: 1 }]);
  assert.equal(engine.activeCount, MAX_ORGAN_VOICES);
  assert.ok(!engine.voices().some((v) => v.note === 10), 'the releasing voice went first');
  on(100);
  assert.equal(engine.activeCount, MAX_ORGAN_VOICES);
  assert.ok(!engine.voices().some((v) => v.note === 20 && v.layer === 'A'), 'then the oldest held');
  assert.ok(engine.voices().some((v) => v.note === 100));
});

test('a drawbar change reaches the sounding B3 voices through the drawbar buses', () => {
  const { ctx, store, on } = setup();
  on(60);
  const bus5 = busOf(wheelAt(ctx, wheelIndex(60, 19))); // 2⅔′ on db5
  const bus1 = busOf(wheelAt(ctx, wheelIndex(60, -12))); // 16′ on db1
  assert.equal(bus5.gain.value, 0, 'init registration 888800000');
  assert.equal(bus1.gain.value, 1);
  store.set(drawbarKey('A', 5), 8);
  assert.equal(bus5.gain.value, 1);
  store.set(drawbarKey('A', 1), 7);
  assert.ok(Math.abs(bus1.gain.value - 10 ** (-3 / 20)) < 1e-9);
});

test('a drawbar change rebuilds the wave of sounding Vox voices', () => {
  const { ctx, store, engine, on } = setup();
  store.set('organA.model', 1);
  on(60);
  assert.equal(engine.voices()[0]?.model, 'vox');
  const osc = ctx.sources.find((s): s is FakeOscillator => s instanceof FakeOscillator && s.type === 'custom'
    && Math.abs(s.frequency.value - mtof(48)) < 1e-9)!;
  assert.ok(osc !== undefined, 'Vox oscillator on the 16′ grid');
  const before = osc.wave;
  store.set(drawbarKey('A', 5), 8);
  assert.notEqual(osc.wave, before);
  assert.ok((osc.wave?.imag[6] ?? 0) > 0, 'the 2⅔′ partial (ratio 6) sounds');
});

test('percussion: single-triggered per layer, poly on every stroke, B3 only, mutes the 1′ bus', () => {
  const { ctx, store, engine, on, off } = setup();
  store.set(drawbarKey('A', 9), 8);
  on(50);
  const bus9 = busOf(wheelAt(ctx, wheelIndex(50, 36)));
  assert.equal(bus9.gain.value, 1);
  off(50);
  store.set('organAVibPerc.org_Preset_kB3PercEnable', 1);
  assert.equal(bus9.gain.value, 0, '1′ muted while percussion is on');
  const perc = (): boolean[] => engine.voices().filter((v) => v.state === 'held').map((v) => v.percussion);
  on(60);
  on(64);
  assert.deepEqual(perc(), [true, false], 'the second key, played while the first is held, has none');
  on(67, [{ layer: 'B', gain: 1 }]);
  assert.deepEqual(engine.voices().filter((v) => v.layer === 'B').map((v) => v.percussion), [false], 'B has its own switch');
  off(60);
  off(64);
  on(72);
  assert.equal(engine.voices().find((v) => v.note === 72)?.percussion, true, 'all keys released: it fires again');
  store.set('organ.polyPercEnable', 1);
  on(74);
  assert.equal(engine.voices().find((v) => v.note === 74)?.percussion, true, 'poly');
  store.set('organA.model', 5);
  on(76);
  assert.equal(engine.voices().find((v) => v.note === 76)?.percussion, false, 'B3 Bass has none');
});

test('model switching: a sounding voice keeps its model, the next note uses the new one', () => {
  const { ctx, store, engine, on } = setup();
  on(60);
  store.set('organA.model', 3); // PIPE1
  on(62);
  store.set('organA.model', 2); // FARF
  on(64);
  store.set('organA.model', 5); // B3 BASS
  on(36);
  assert.deepEqual(engine.voices().map((v) => [v.note, v.model]), [[60, 'b3'], [62, 'pipe1'], [64, 'farf'], [36, 'b3bass']]);
  const pipeOscs = ctx.sources.filter((s) => s instanceof FakeOscillator && s.type === 'custom'
    && [...s.outputs].length > 0 && Math.abs(s.frequency.value / mtof(62) - Math.round(s.frequency.value / mtof(62) * 2) / 2) < 1e-9);
  assert.ok(pipeOscs.length >= 4, 'one pipe per drawbar above 0 (init: four)');
});

test('octave shift moves the pitch of the next note; the pitch stick bends every organ oscillator', () => {
  const { ctx, store, engine, on } = setup();
  store.set('organA.model', 1);
  store.set('organA.octaveShift', 1);
  on(60);
  assert.equal(engine.voices()[0]?.pitch, 72);
  const vox = ctx.sources.find((s): s is FakeOscillator => s instanceof FakeOscillator && s.type === 'custom'
    && Math.abs(s.frequency.value - mtof(60)) < 1e-9)!;
  assert.ok(vox !== undefined);
  const bend = [...vox.detune.inputs][0] as FakeConstantSource;
  assert.ok(bend instanceof FakeConstantSource);
  engine.handle({ type: 'bend', value: 8191 });
  assert.equal(bend.offset.value, 0, 'pitch stick switched off');
  store.set('organ.orgPStickEnable', 1);
  assert.equal(bend.offset.value, 200);
});

test('rotary: speed ramps with the horn faster than the drum, stop mode, on/off', () => {
  const { ctx, store, engine } = setup();
  assert.deepEqual(engine.rotorTargets, { horn: 0.83, drum: 0.67 });
  const rotors = ctx.sources.filter((s): s is FakeOscillator => s instanceof FakeOscillator
    && [...s.outputs].length === 2 && [0.83, 0.67].includes(s.frequency.value));
  assert.equal(rotors.length, 4, 'sine and cosine per rotor');
  store.set('organ.effectsLeslieSpeed', 1);
  assert.deepEqual(engine.rotorTargets, { horn: 6.7, drum: 5.7 });
  const last = (o: FakeOscillator): { value: number; tau: number } => {
    const e = o.frequency.events.at(-1)!;
    assert.equal(e.kind, 'target');
    return e as { value: number; tau: number };
  };
  const horn = rotors.filter((o) => last(o).value === 6.7);
  const drum = rotors.filter((o) => last(o).value === 5.7);
  assert.equal(horn.length, 2);
  assert.equal(drum.length, 2);
  assert.deepEqual(horn.map((o) => last(o).tau), [0.3, 0.3]);
  assert.deepEqual(drum.map((o) => last(o).tau), [1.5, 1.5]);
  store.set('organ.effectsLeslieStopMode', 1);
  assert.deepEqual(engine.rotorTargets, { horn: 6.7, drum: 5.7 }, 'stop mode waits for slow');
  store.set('organ.effectsLeslieSpeed', 0);
  assert.deepEqual(engine.rotorTargets, { horn: 0, drum: 0 });
  assert.deepEqual(rotors.map((o) => last(o).tau).sort(), [0.4, 0.4, 2, 2]);
});

test('rotary off sends the organ straight to the output', () => {
  const { ctx, store, on } = setup();
  on(60); // makes the organ bus reachable from a source
  // The two switch gains are the only gains at 0 and 1 whose outputs are the destination or the rotary input.
  const out = ctx.destination;
  const toOut = (): FakeGain[] => [...allNodes(ctx)].filter((n): n is FakeGain => n instanceof FakeGain && n.outputs.has(out));
  assert.equal(toOut().length, 1, 'only the direct gain connects to out (the rotary uses panners)');
  const direct = toOut()[0]!;
  assert.equal(direct.gain.value, 0, 'rotary on by default: direct closed');
  store.set('organ.effectsLeslieEnable', 0);
  assert.equal(direct.gain.value, 1);
});

test('a load batch stops every voice; dispose stops every source', () => {
  const { ctx, store, engine, on } = setup();
  store.set('organA.model', 4); // PIPE2
  on(60);
  on(61);
  assert.equal(engine.activeCount, 2);
  store.load({ ...initProgram(), name: 'x' }, 'load');
  assert.equal(engine.activeCount, 0);
  on(60);
  assert.equal(engine.voices()[0]?.model, 'b3', 'the loaded program is read');
  engine.dispose();
  assert.equal(engine.activeCount, 0);
  ctx.advance(10);
  assert.deepEqual(ctx.live().map((s) => s.kind), [], 'every source stopped');
});

/** Every node reachable from the sources, following outputs. */
function allNodes(ctx: FakeContext): Set<FakeNode> {
  const seen = new Set<FakeNode>();
  const stack: FakeNode[] = [...ctx.sources];
  while (stack.length > 0) {
    const n = stack.pop()!;
    if (seen.has(n)) continue;
    seen.add(n);
    for (const o of n.outputs) if (o instanceof FakeNode) stack.push(o);
  }
  return seen;
}

test('the layer scanner follows the vibrato switch, type and the layer model at once', () => {
  const { ctx, store } = setup();
  const lfos = ctx.sources.filter((s): s is FakeOscillator => s instanceof FakeOscillator && s.frequency.value === 6.9);
  assert.equal(lfos.length, 2, 'one scanner LFO per layer');
  const depthA = [...lfos[0]!.outputs][0] as FakeGain;
  assert.equal(depthA.gain.value, 0, 'vibrato off');
  store.set('organAVibPerc.org_Preset_kVibratoEnable', 1); // init type C3
  assert.ok(Math.abs(depthA.gain.value - 0.00045) < 1e-12);
  store.set('organ.vibratoTypeB3', 0); // V1
  assert.ok(Math.abs(depthA.gain.value - 0.00012) < 1e-12);
  store.set('organA.model', 1); // VOX, init type V3
  assert.ok(Math.abs(depthA.gain.value - 0.0003) < 1e-12);
  assert.equal(lfos[0]!.frequency.value, 5.6);
  store.set('organA.model', 3); // PIPE1: detuned model, no modulation
  assert.equal(depthA.gain.value, 0);
  assert.equal(([...lfos[1]!.outputs][0] as FakeGain).gain.value, 0, 'layer B untouched');
});
