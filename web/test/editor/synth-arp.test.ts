/**
 * Plan section 14: the arpeggiator, gate, master clock and LFO clock sync inside the synth engine,
 * on the fake audio context with a manual timer. A held chord becomes repeating voice starts at the
 * rate (free BPM or a master clock division), a tempo change moves the steps, KB sync restarts on the
 * first key, Poly plays the chord, Gate automates the layer's gate GainNode, Arp Run off hands the
 * held notes back to plain voices, the master clock's keyboard sync resets synced arpeggios and
 * LFOs, and every field that now sounds has a binding or a clock handler.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BINDINGS, bindingOf, soundingKeys } from '../../src/editor/audio/bindings.ts';
import { CLOCK_KEYS } from '../../src/editor/audio/clock.ts';
import { ARP_HORIZON, type ArpTimer, SynthEngine } from '../../src/editor/audio/engine.ts';
import { lfoSpec } from '../../src/editor/audio/mapping.ts';
import type { RoutedNoteOn } from '../../src/editor/audio/section.ts';
import { VoiceAllocator } from '../../src/editor/audio/voice-alloc.ts';
import { DESCRIPTORS } from '../../src/editor/model/descriptors.ts';
import { initProgram } from '../../src/editor/model/init.ts';
import { expandPattern, type Ns4Key, type SynthLayer } from '../../src/editor/model/keys.ts';
import { ParamStore } from '../../src/editor/model/store.ts';
import { asContext, asNode, FakeContext, FakeGain, FakeOscillator, FakeStereoPanner, installAudioGlobals } from './fake-audio.ts';

installAudioGlobals();

class ManualTimer implements ArpTimer {
  fn: (() => void) | null = null;
  starts = 0;
  start(fn: () => void): unknown {
    this.fn = fn;
    this.starts++;
    return this.starts;
  }
  stop(): void {
    this.fn = null;
  }
}

class GainContext extends FakeContext {
  readonly gains: FakeGain[] = [];
  override createGain(): FakeGain {
    const g = super.createGain();
    this.gains.push(g);
    return g;
  }
}

function setup(edits: ReadonlyArray<readonly [Ns4Key, number]> = []) {
  const ctx = new GainContext();
  const store = new ParamStore(initProgram());
  store.setMany(edits.map(([k, v]) => [k, v] as const), 'ui');
  const timer = new ManualTimer();
  const alloc = new VoiceAllocator();
  const engine = new SynthEngine(asContext(ctx), store, alloc, asNode(new FakeGain(ctx)), { timer, random: () => 0.3 });
  store.onChange((batch) => engine.applyChanges(batch));
  const noteOn = (note: number, layers: SynthLayer[] = ['A'], velocity = 100): void => {
    const e: RoutedNoteOn<SynthLayer> = { type: 'noteOn', key: note, note, velocity, layers: layers.map((layer) => ({ layer, gain: 1 })) };
    engine.handle(e);
  };
  const noteOff = (note: number): void => engine.handle({ type: 'noteOff', key: note, note });
  /** Advance the audio clock to `t` in 25 ms timer ticks. */
  const run = (t: number): void => {
    while (ctx.currentTime < t - 1e-9) {
      ctx.advance(Math.min(t, ctx.currentTime + 0.025));
      timer.fn?.();
    }
  };
  const onTimes = (layer: SynthLayer = 'A'): number[] => engine.arpLog()
    .filter((e) => e.layer === layer && e.type === 'on').map((e) => Number(e.time.toFixed(4)));
  const onNotes = (layer: SynthLayer = 'A'): number[] => engine.arpLog()
    .filter((e) => e.layer === layer && e.type === 'on').map((e) => (e as { note: number }).note);
  /** The gate GainNode of each layer: the gains that feed a pan, in layer order. */
  const gates = (): FakeGain[] => ctx.gains.filter((g) => [...g.outputs].some((n) => n instanceof FakeStereoPanner));
  return { ctx, store, timer, alloc, engine, noteOn, noteOff, run, onTimes, onNotes, gates };
}

const steps = (times: readonly number[]): number[] => times.slice(1).map((t, i) => Number((t - times[i]!).toFixed(4)));

test('arp on with a held chord: repeating voice starts at the free rate, up through the chord', () => {
  const { store, timer, engine, noteOn, run, onTimes, onNotes } = setup();
  assert.equal(timer.fn, null, 'no timer while no arpeggiator runs');
  store.set('synthA.arpRun', 1);
  assert.notEqual(timer.fn, null, 'the timer runs with Arp Run');
  noteOn(60);
  noteOn(64);
  noteOn(67);
  run(2);
  const times = onTimes();
  const step = 30 / (30 + (54 * 210) / 127);
  assert.ok(times.length >= 7 && times.length <= 9, `about 8 steps in 2 s: ${times.length}`);
  for (const d of steps(times)) assert.ok(Math.abs(d - step) < 2e-3, `step ${d}, want ${step}`);
  assert.deepEqual(onNotes().slice(0, 6), [60, 64, 67, 60, 64, 67]);
  assert.ok(engine.voices().length <= 3, 'no voice per key: the arpeggio plays one note at a time');
  assert.ok(times.at(-1)! < 2 + ARP_HORIZON + 1e-9, 'nothing scheduled beyond the horizon');
});

test('mst clk: the step follows a master clock division, and a tempo change moves it', () => {
  const { store, noteOn, run, onTimes } = setup([['synthA.arpClkEnable', 1], ['common.masterClockRate', 120]]);
  store.set('synthA.arpRun', 1);
  noteOn(60);
  run(1.5);
  const before = onTimes();
  for (const d of steps(before)) assert.ok(Math.abs(d - 0.25) < 1e-6, `1/8 at 120 BPM: ${d}`);
  store.set('common.masterClockRate', 60);
  const n = before.length;
  run(4);
  const after = onTimes().slice(n + 1);
  assert.ok(after.length >= 3);
  for (const d of steps(after)) assert.ok(Math.abs(d - 0.5) < 1e-6, `1/8 at 60 BPM: ${d}`);
  // A faster division on the same clock.
  store.set('synthA.arpRateClkDiv', 127);
  const m = onTimes().length;
  run(5);
  for (const d of steps(onTimes().slice(m + 1))) assert.ok(Math.abs(d - 0.125) < 1e-6, `1/32 at 60 BPM: ${d}`);
});

test('kb sync: the first key after all keys were lifted restarts the arpeggio on the key', () => {
  const { store, ctx, noteOn, noteOff, run, onTimes } = setup([['synthA.arpRun', 1]]);
  noteOn(60);
  run(0.6);
  noteOff(60);
  run(1.37);
  const withoutSync = onTimes().length;
  noteOn(62);
  run(1.38);
  assert.equal(onTimes().length, withoutSync, 'without kb sync the chord waits for the grid');
  noteOff(62);
  store.set('synthA.arpKbdSync', 1);
  run(2.111);
  noteOn(64);
  assert.equal(onTimes().at(-1), Number(ctx.currentTime.toFixed(4)), 'kb sync: the first step is the key');
});

test('poly mode plays the held chord together on every step', () => {
  const { store, noteOn, run, engine } = setup([['synthA.arpRun', 1], ['synthA.arpMode', 1]]);
  noteOn(60);
  noteOn(64);
  run(0.8);
  const byTime = new Map<number, number[]>();
  for (const e of engine.arpLog()) {
    if (e.type === 'on') byTime.set(e.time, [...(byTime.get(e.time) ?? []), e.note]);
  }
  assert.ok(byTime.size >= 3);
  for (const notes of byTime.values()) assert.deepEqual(notes.sort(), [60, 64]);
  store.set('synthA.arpRun', 0);
});

test('gate mode: notes sound directly, the layer gate opens and closes on every step; off opens it again', () => {
  const { store, noteOn, run, gates, engine, alloc } = setup([['synthA.arpMode', 2], ['synthA.arpClkEnable', 1]]);
  store.set('synthA.arpRun', 1);
  noteOn(60);
  assert.equal(alloc.voices().length, 1, 'gate mode: the key starts its voice at once');
  run(1);
  const gate = gates()[0]!;
  const targets = gate.gain.events.filter((e) => e.kind === 'target') as Array<{ value: number; time: number; tau: number }>;
  const opens = targets.filter((e) => e.value === 1).map((e) => e.time);
  const closes = targets.filter((e) => e.value === 0).map((e) => e.time);
  assert.ok(opens.length >= 4);
  for (const d of steps(opens)) assert.ok(Math.abs(d - 0.25) < 1e-6, `1/8 at 120 BPM: ${d}`);
  for (let i = 0; i < closes.length; i++) assert.ok(Math.abs(closes[i]! - opens[i]! - 0.125) < 1e-6, 'closes half a step later');
  // Range/Env is the hardness: soft at 0 (a long time constant), hard at 127.
  assert.ok(targets[0]!.tau > 0.04);
  store.set('synthA.arpRange', 127);
  run(1.5);
  const hard = gate.gain.events.filter((e) => e.kind === 'target').at(-1) as { tau: number };
  assert.ok(hard.tau < 0.002, `hard gate tau ${hard.tau}`);
  assert.ok(engine.arpLog().every((e) => e.type === 'gate'), 'the gate plays no notes of its own');
  store.set('synthA.arpRun', 0);
  const last = gate.gain.events.slice(-2);
  assert.deepEqual(last.map((e) => e.kind), ['cancel', 'target']);
  assert.equal((last[1] as { value: number }).value, 1);
  assert.equal(alloc.voices().length, 1, 'the held note keeps sounding');
});

test('arp run on and off hands held notes between voices and the arpeggio', () => {
  const { store, noteOn, run, alloc, timer, onTimes } = setup();
  noteOn(60);
  noteOn(67);
  assert.deepEqual(alloc.voices().map((v) => [v.note, v.state]), [[60, 'held'], [67, 'held']]);
  store.set('synthA.arpRun', 1);
  assert.ok(alloc.voices().filter((v) => v.state === 'held').length <= 1, 'the direct voices end; the arpeggio starts');
  run(0.5);
  assert.ok(onTimes().length >= 2);
  store.set('synthA.arpRun', 0);
  assert.equal(timer.fn, null, 'the timer stops with the last arpeggiator');
  const held = alloc.voices().filter((v) => v.state === 'held').map((v) => v.note).sort();
  assert.deepEqual(held, [60, 67], 'the keys still down sound as plain voices again');
});

test('arp notes of one layer leave another layer\'s voice of the same note alone', () => {
  const { store, noteOn, run, alloc } = setup([['synth.layerEnableSyn_I', 3]]);
  store.set('synthA.arpRun', 1);
  noteOn(60, ['A', 'B']);
  run(1);
  const b = alloc.voices().filter((v) => v.layer === 'B');
  assert.deepEqual(b.map((v) => [v.note, v.state]), [[60, 'held']], 'layer B plays the key directly and keeps it');
});

test('master clock kb sync: the first key resets the clock, synced arpeggios restart on it and synced LFOs restart', () => {
  const { store, ctx, noteOn, noteOff, run, onTimes, engine } = setup([
    ['synthA.arpRun', 1], ['synthA.arpClkEnable', 1], ['common.masterClockKbdSync', 1],
    ['synthASound.lfoClkEnable', 1]]);
  run(0.33);
  const lfosBefore = ctx.sources.filter((s) => s instanceof FakeOscillator && s.startAt === ctx.currentTime).length;
  assert.equal(lfosBefore, 0);
  noteOn(60);
  const t0 = ctx.currentTime;
  assert.equal(engine.clock.anchor, t0, 'the clock was reset on the key');
  assert.equal(onTimes()[0], Number(t0.toFixed(4)));
  const restarted = ctx.sources.filter((s) => s instanceof FakeOscillator && s.startAt === t0);
  assert.ok(restarted.length >= 1, 'the synced LFO restarted its phase');
  run(0.6);
  noteOff(60);
  // Soft: a key within a quarter note of the last key-up does not reset.
  store.set('common.masterClockKbdSync', 2);
  run(0.7);
  noteOn(62);
  assert.ok(Math.abs(engine.clock.anchor - 0.33) < 1e-9);
  noteOff(62);
  run(1.5);
  noteOn(64);
  assert.ok(Math.abs(engine.clock.anchor - 1.5) < 1e-9, 'after more than a quarter note it does');
  // Off: never.
  noteOff(64);
  store.set('common.masterClockKbdSync', 0);
  run(3);
  noteOn(65);
  assert.ok(Math.abs(engine.clock.anchor - 1.5) < 1e-9);
});

test('the LFO rate follows a master clock division with mst clk on, and the tempo', () => {
  const { store, ctx } = setup([['synthASound.lfoClkEnable', 1], ['synthASound.lfoRateClkDiv', 64]]);
  // Step 64 of 13 divisions is '1/4T'... check against the mapping, then a tempo change.
  const before = lfoSpec(store, 'A').rateHz;
  store.set('common.masterClockRate', 60);
  const after = lfoSpec(store, 'A').rateHz;
  assert.ok(Math.abs(after - before / 2) < 1e-9, 'half the tempo, half the rate');
  const lfo = ctx.sources.find((s) => s instanceof FakeOscillator
    && (s as FakeOscillator).frequency.events.some((e) => 'value' in e && Math.abs(e.value - after) < 1e-9));
  assert.ok(lfo !== undefined, 'the running LFO got the new rate');
  store.set('synthASound.lfoClkEnable', 0);
  assert.notEqual(lfoSpec(store, 'A').rateHz, after);
});

test('panic forgets the arpeggio; a load stops it and follows the new program', () => {
  const { store, noteOn, run, engine, onTimes, timer } = setup([['synthA.arpRun', 1]]);
  noteOn(60);
  run(0.5);
  engine.panic();
  assert.equal(engine.activeCount, 0);
  const n = onTimes().length;
  run(1.5);
  assert.equal(onTimes().length, n, 'no steps after panic: nothing is held');
  store.load(initProgram(), 'init');
  assert.equal(timer.fn, null, 'the init program has no arpeggiator');
  assert.equal(engine.held().A.arp, 'off');
});

test('a tempo dragged down while a synced arpeggio runs never doubles a step', () => {
  const { store, noteOn, run, onTimes } = setup([['synthA.arpClkEnable', 1], ['common.masterClockRate', 120]]);
  store.set('synthA.arpRun', 1);
  noteOn(60);
  for (let bpm = 120, t = 0.33; bpm >= 100; bpm--, t += 0.11) {
    run(t);
    store.set('common.masterClockRate', bpm);
  }
  run(4);
  const gaps = steps(onTimes());
  assert.ok(gaps.length > 10 && gaps.every((d) => d > 0.2), `steps ${gaps}`);
});

test('kb sync with kb hold: a step the old chord planned after the new key never sounds', () => {
  const { noteOn, noteOff, run, alloc, engine } = setup([
    ['synth.kbdHoldEnableCommon', 1], ['synthA.arpRun', 1], ['synthA.arpKbdSync', 1]]);
  noteOn(60);
  noteOff(60);
  run(0.7); // the tick at 0.7 planned the old chord's step at 0.754
  assert.ok(engine.arpLog().some((e) => e.type === 'on' && e.time > 0.7), 'a step is planned ahead');
  const n = engine.arpLog().length;
  noteOn(67);
  assert.deepEqual(alloc.voices().filter((v) => v.note === 60), [], 'the planned 60 is gone');
  run(1.5);
  const later = engine.arpLog().slice(n).filter((e) => e.type === 'on').map((e) => (e as { note: number }).note);
  assert.ok(later.length >= 3 && later.every((x) => x === 67), `only the new chord: ${later}`);
  assert.ok(alloc.voices().every((v) => v.note === 67));
});

test('gate kb sync: the gate steps on the key', () => {
  const { store, ctx, noteOn, run, engine } = setup([['synthA.arpMode', 2], ['synthA.arpKbdSync', 1]]);
  store.set('synthA.arpRun', 1);
  run(0.61);
  noteOn(60);
  const t0 = ctx.currentTime;
  run(0.8);
  assert.ok(engine.arpLog().some((e) => e.type === 'gate' && Math.abs(e.time - t0) < 1e-9), 'a gate step at the key');
});

test('a layer switched off, or out of the new scene, plays no arpeggio and lets go of kb hold notes', () => {
  const { store, noteOn, noteOff, run, onTimes, engine, alloc } = setup([
    ['synth.kbdHoldEnableCommon', 1], ['synthA.arpRun', 1], ['synth.layerEnableSyn_I', 3]]);
  noteOn(60);
  noteOff(60);
  noteOn(64, ['B']);
  noteOff(64);
  run(0.5);
  store.set('synth.layerEnableSyn_I', 2);
  const n = onTimes().length;
  run(0.62); // a step planned before the switch may still come
  const m = onTimes().length;
  run(2);
  assert.ok(m - n <= 1 && onTimes().length === m, 'no arpeggio steps on a layer that is off');
  assert.deepEqual(engine.held().A.hold, []);
  assert.deepEqual(engine.held().B.hold, [64], 'layer B still plays its drone');
  // Scene II without layer B: the scene switch lets go of B's drone.
  store.setMany([['common.sectionEnableSyn_II', 1], ['synth.layerEnableSyn_II', 1]], 'ui');
  store.set('common.layerScene', 1);
  assert.deepEqual(engine.held().B.hold, []);
  assert.deepEqual(alloc.voices().filter((v) => v.layer === 'B' && v.state === 'held'), []);
});

test('coverage: every field that now sounds has a binding, and the clock keys a handler', () => {
  const now: Ns4Key[] = ['synth.multiLayerFlt', 'synth.multiLayerArp', 'synth.multiLayerLFO', 'synth.kbdHoldEnableCommon',
    ...['synth{L}.kbdHoldEnableLayer', 'synth{L}Sound.lfoClkEnable', 'synth{L}.arpRun', 'synth{L}.arpMode',
      'synth{L}.arpDir', 'synth{L}.arpZigZag', 'synth{L}.arpKbdSync', 'synth{L}.arpRange', 'synth{L}.arpRateClkDiv',
      'synth{L}.arpClkEnable', 'synth{L}.arpPtnEnable', 'synth{L}.arpPtnLen'].flatMap(expandPattern)];
  const sounding = new Set(soundingKeys());
  for (const k of now) {
    assert.ok(sounding.has(k), `${k} sounds`);
    assert.notEqual(bindingOf(k), null, `${k} has a binding`);
    assert.notEqual(bindingOf(k)!.apply, 'none', k);
  }
  assert.equal(BINDINGS['synth{L}.arpRun']!.effect, 'arp');
  for (const k of CLOCK_KEYS) {
    const d = DESCRIPTORS.get(k)!;
    assert.equal(d.region, 'program');
    assert.ok(d.status === 'live' || d.status === 'unverified', k);
  }
  assert.equal(DESCRIPTORS.get('common.pdlTapEnable')!.status, 'stored', 'the tap pedal stays a stored pedal setting');
  assert.equal(DESCRIPTORS.get('common.pdlTapEnable')!.storedLine, 'pedal assignment, stored');
});
