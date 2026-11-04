/**
 * Plan section 15.1: the layer effects chains and the global units on the fake context: unit
 * bypass, type switches, ping pong, To Rotary, Global mode (bypassed in every chain, one global
 * instance), Layer Effects ON, panic, load, morphs, the Mod 1 pedal, dispose, and the engines
 * playing through the real chains.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fxChainFactory, LayerFxChain } from '../../src/editor/audio/fx/chain.ts';
import type { Amp } from '../../src/editor/audio/fx/amp.ts';
import { type Delay, LOOP_MOD2_PEAK } from '../../src/editor/audio/fx/delay.ts';
import { globalFxFactory, GlobalUnits } from '../../src/editor/audio/fx/global.ts';
import type { Mod1 } from '../../src/editor/audio/fx/mod1.ts';
import type { Mod2 } from '../../src/editor/audio/fx/mod2.ts';
import { impulseBuffer, type Reverb } from '../../src/editor/audio/fx/reverb.ts';
import type { ClockReader, FxChain, FxHooks } from '../../src/editor/audio/fx/types.ts';
import { makeSynthFactory, type SynthEngine } from '../../src/editor/audio/engine.ts';
import { PianoEngine } from '../../src/editor/audio/piano/engine.ts';
import { OrganEngine } from '../../src/editor/audio/organ/engine.ts';
import type { SectionContext } from '../../src/editor/audio/section.ts';
import { FX_BLOCKS, type FxBlock, fxFocusEntries, fxKey, mod2RateHz } from '../../src/editor/model/fx.ts';
import { initProgram } from '../../src/editor/model/init.ts';
import type { Ns4Key } from '../../src/editor/model/keys.ts';
import type { ValueReader } from '../../src/editor/model/labels.ts';
import { MorphedValues, morphKey } from '../../src/editor/model/morph.ts';
import { type Entry, ParamStore } from '../../src/editor/model/store.ts';
import {
  asContext, asNode, FakeContext, FakeGain, type FakeNode, type FakeOscillator, type FakeParam, installAudioGlobals,
} from './fake-audio.ts';

installAudioGlobals();

const UNIT_ENABLES = ['fx1Enable', 'fx2Enable', 'dlyEnable', 'ampEnable', 'cmpEnable', 'rvbEnable'] as const;

/** A store with Layer Effects on, no global unit and every unit of every block off. */
function quietStore(): ParamStore {
  const s = new ParamStore(initProgram());
  const entries: Entry[] = [['common.fxEnable', 1], ['common.effectsDlyGlobal', 0], ['common.effectsCmpGlobal', 0],
    ['common.effectsRvbGlobal', 0]];
  for (const b of FX_BLOCKS) for (const p of UNIT_ENABLES) entries.push([fxKey(b, p), 0]);
  s.setMany(entries, 'ui');
  return s;
}

function rig(block: FxBlock = 'synthAFx', values?: ValueReader) {
  const ctx = new FakeContext();
  const store = quietStore();
  const chain = new LayerFxChain({ ctx: asContext(ctx), values: values ?? store, block, clock: null });
  store.onChange((b) => chain.applyChanges(b));
  return { ctx, store, chain };
}

const v = (p: AudioParam | null | undefined): number => (p as unknown as FakeParam).value;

/** Whether a signal path leads from `from` to `to` (node edges only). */
function reaches(from: unknown, to: unknown): boolean {
  const seen = new Set<FakeNode>();
  const queue = [from as FakeNode];
  while (queue.length > 0) {
    const n = queue.shift()!;
    if (n === to) return true;
    if (seen.has(n)) continue;
    seen.add(n);
    for (const o of n.outputs) if ('outputs' in o) queue.push(o as FakeNode);
  }
  return false;
}

test('an idle chain passes the signal and builds no unit (lazy)', () => {
  const { ctx, chain } = rig();
  assert.ok(reaches(chain.input, chain.output));
  for (const slot of Object.values(chain.units)) {
    assert.equal(slot.on, false);
    assert.equal(slot.stage, null);
    assert.equal(v(slot.gains.dry), 1);
  }
  assert.equal(ctx.count('oscillator'), 0);
  assert.equal(ctx.count('convolver'), 0);
  assert.equal(v(chain.output.gain), 1);
  assert.equal(v(chain.rotarySend!.gain), 0);
});

test('Enable switches a unit in and out with a crossfade; the stage is built once', () => {
  const { store, chain } = rig();
  for (const [unit, param] of [['mod1', 'fx1Enable'], ['mod2', 'fx2Enable'], ['delay', 'dlyEnable'],
    ['amp', 'ampEnable'], ['comp', 'cmpEnable'], ['reverb', 'rvbEnable']] as const) {
    const slot = chain.units[unit];
    store.set(fxKey('synthAFx', param), 1);
    assert.equal(slot.on, true, unit);
    const stage = slot.stage;
    assert.ok(stage !== null, unit);
    assert.equal(v(slot.gains.dry), 0, `${unit} dry`);
    assert.equal(v(slot.gains.wet), 1, `${unit} wet`);
    store.set(fxKey('synthAFx', param), 0);
    assert.equal(slot.on, false);
    assert.equal(v(slot.gains.dry), 1);
    assert.equal(v(slot.gains.wet), 0);
    store.set(fxKey('synthAFx', param), 1);
    assert.equal(slot.stage, stage, `${unit} kept, not rebuilt`);
  }
  // Another block's fields do not reach this chain.
  store.set('synthBFx.fx1Enable', 1);
  assert.equal(chain.units.mod1.on, true);
  store.set('synthAFx.fx1Enable', 0);
  store.set('synthBFx.fx1Type', 4);
  assert.equal(chain.units.mod1.on, false);
});

test('type switches crossfade between Mod 1 and Mod 2 types, each built once', () => {
  const { store, chain } = rig();
  store.setMany([['synthAFx.fx1Enable', 1], ['synthAFx.fx1Type', 0], ['synthAFx.fx2Enable', 1],
    ['synthAFx.fx2Type', 0]], 'ui');
  const mod1 = chain.units.mod1.stage as Mod1;
  const mod2 = chain.units.mod2.stage as Mod2;
  assert.equal(mod1.family, 'pan');
  assert.equal(mod2.family, 'phaser');
  for (const [t, fam] of [[2, 'trem'], [4, 'rm'], [6, 'awah'], [8, 'wah'], [10, 'pump'], [1, 'pan']] as const) {
    store.set('synthAFx.fx1Type', t);
    assert.equal(mod1.family, fam);
  }
  for (const [t, fam] of [[2, 'flanger'], [4, 'chorus'], [6, 'vibe'], [8, 'ensemble'], [10, 'spin']] as const) {
    store.set('synthAFx.fx2Type', t);
    assert.equal(mod2.family, fam);
  }
  assert.ok(mod1.stage('trem') !== null && mod1.stage('pump') !== null);
});

test('delay: ping pong feeds the input left and crosses the repeats L↔R', () => {
  const { store, chain } = rig();
  store.setMany([['synthAFx.dlyEnable', 1], ['synthAFx.dlyFbkPingPong', 0]], 'ui');
  const d = chain.units.delay.stage as Delay;
  const p = d.params;
  assert.deepEqual([v(p.inR), v(p.crossIn), v(p.ll), v(p.rr), v(p.lr), v(p.rl)], [1, 0, 1, 1, 0, 0]);
  store.set('synthAFx.dlyFbkPingPong', 1);
  assert.deepEqual([v(p.inR), v(p.crossIn), v(p.ll), v(p.rr), v(p.lr), v(p.rl)], [0, 1, 0, 0, 1, 1]);
  store.set('synthAFx.dlyFbkAmt', 127);
  assert.ok(Math.abs(v(p.feedback) - 0.95) < 1e-9);
  store.set('synthAFx.dlyMix', 127);
  assert.ok(Math.abs(v(p.dry)) < 1e-9 && Math.abs(v(p.wet) - 1) < 1e-9);
});

test('flanger: no delay line sits in a feedback cycle, so its sweep can go below one render quantum', () => {
  const { ctx, store, chain } = rig();
  const before = ctx.count('delay');
  store.setMany([['synthAFx.fx2Enable', 1], ['synthAFx.fx2Type', 2], ['synthAFx.fx2Amt', 127]], 'ui');
  assert.equal((chain.units.mod2.stage as Mod2).family, 'flanger');
  assert.ok(ctx.count('delay') > before);
  // Every delay reachable from the chain input: none reaches itself again.
  const seen = new Set<FakeNode>();
  const queue = [chain.input as unknown as FakeNode];
  const delays: FakeNode[] = [];
  while (queue.length > 0) {
    const n = queue.shift()!;
    if (seen.has(n)) continue;
    seen.add(n);
    if (n.kind === 'delay') delays.push(n);
    for (const o of n.outputs) if ('outputs' in o) queue.push(o as FakeNode);
  }
  assert.ok(delays.length >= 6, 'three taps per side');
  for (const d of delays) assert.ok(![...d.outputs].some((o) => reaches(o, d)), 'a delay in a cycle');
  // The shortest tap sweeps 0.5–5 ms (2.75 ms ± 2.25 ms at amount 10.0).
  const minBase = Math.min(...delays.map((d) => (d as unknown as { delayTime: FakeParam }).delayTime.value));
  assert.ok(Math.abs(minBase - 0.00275) < 1e-9);
});

test('amp: the overdrive goes in and out by a crossfade; the shaper\'s curve never changes', () => {
  const { store, chain } = rig();
  store.setMany([['synthAFx.ampEnable', 1], ['synthAFx.ampTypeNew', 0], ['synthAFx.ampDrive', 0]], 'ui');
  const amp = chain.units.amp.stage as Amp;
  const curve = amp.driveShaper.curve;
  assert.ok(curve !== null, 'the drive curve is set once');
  assert.deepEqual([v(amp.paths.driven), v(amp.paths.clean)], [0, 1], 'drive 0, model off: the clean path');
  store.set('synthAFx.ampDrive', 20);
  assert.deepEqual([v(amp.paths.driven), v(amp.paths.clean)], [1, 0]);
  assert.equal(amp.driveShaper.curve, curve);
  store.set('synthAFx.ampDrive', 0);
  assert.deepEqual([v(amp.paths.driven), v(amp.paths.clean)], [0, 1]);
  store.set('synthAFx.ampTypeNew', 1); // Twin at drive 0
  assert.deepEqual([v(amp.paths.driven), v(amp.paths.clean)], [1, 0]);
  assert.equal(amp.driveShaper.curve, curve);
});

test('delay: the loop\'s Ensemble, Vibe and Chorus are trimmed so the repeats always decay', () => {
  const { store, chain } = rig();
  store.setMany([['synthAFx.dlyEnable', 1], ['synthAFx.dlyFbkAmt', 127], ['synthAFx.dlyFbkFilt', 0]], 'ui');
  const d = chain.units.delay.stage as Delay;
  const fb = v(d.params.feedback);
  for (const [type, fam, variation] of [[2, 'ensemble', 0], [3, 'ensemble', 1], [4, 'vibe', 0], [5, 'vibe', 1],
    [6, 'chorus', 0], [7, 'chorus', 1]] as const) {
    store.set('synthAFx.dlyFbFxType', type);
    const trim = v((d.loopStage!.output as GainNode).gain);
    const peak = LOOP_MOD2_PEAK[fam][variation];
    assert.ok(Math.abs(trim * peak - 1) < 1e-9, `${fam} ${variation}: trimmed to unity peak`);
    assert.ok(fb * peak * trim < 1, `${fam} ${variation}: loop gain below 1`);
  }
  // The peaks: chorus dry 1 + one 0.7 line, vibe 0.7 + 0.7, ensemble dry 1 + 0.5 × three panned lines.
  assert.deepEqual(LOOP_MOD2_PEAK.chorus, [1.7, 1.8]);
  assert.deepEqual(LOOP_MOD2_PEAK.vibe, [1.4, 1.4]);
  assert.ok(Math.abs(LOOP_MOD2_PEAK.ensemble[0] - 2.6725) < 1e-4);
});

test('delay follows the master clock tempo and the free time', () => {
  const { store, chain } = rig();
  store.setMany([['synthAFx.dlyEnable', 1], ['synthAFx.dlyClkEnable', 0], ['synthAFx.dlyRateClkDiv', 0]], 'ui');
  const d = chain.units.delay.stage as Delay;
  assert.ok(Math.abs(d.times![0] - 0.01) < 1e-9);
  store.setMany([['synthAFx.dlyClkEnable', 1], ['synthAFx.dlyRateClkDiv', 16383], ['common.masterClockRate', 120]], 'ui');
  assert.ok(Math.abs(d.times![0] - 1) < 1e-9, '1/2 at 120 BPM');
  store.set('common.masterClockRate', 60);
  assert.ok(Math.abs(d.times![0] - 2) < 1e-9, 'a tempo change re-times a synced delay');
});

test('a tempo change re-times the synth layer delays through the engine clock (main wiring)', () => {
  const ctx = new FakeContext();
  const store = quietStore();
  let synth: SynthEngine | null = null;
  const made: FxChain[] = [];
  const clock: ClockReader = {
    bpm: () => synth?.syncClock().bpm ?? store.get('common.masterClockRate'),
    anchor: () => synth?.syncClock().anchor ?? 0,
  };
  const fx: FxHooks = {
    chain: (x) => {
      const ch = fxChainFactory(x);
      made.push(ch);
      return ch;
    },
    rotary: () => null,
    clock,
  };
  synth = makeSynthFactory()({ ctx: asContext(ctx), values: store, out: asNode(new FakeGain(ctx)), fx }) as SynthEngine;
  store.onChange((b) => synth!.applyChanges(b));
  store.setMany([['synthAFx.dlyEnable', 1], ['synthAFx.dlyClkEnable', 1], ['synthAFx.dlyRateClkDiv', 16383],
    ['common.masterClockRate', 120]], 'ui');
  const chainA = made.find((m) => m.block === 'synthAFx') as LayerFxChain;
  const d = chainA.units.delay.stage as Delay;
  assert.ok(Math.abs(d.times![0] - 1) < 1e-9, '1/2 at 120 BPM');
  store.set('common.masterClockRate', 60);
  assert.ok(Math.abs(d.times![0] - 2) < 1e-9, 'the new tempo, not the previous one');
  store.set('common.masterClockRate', 90);
  assert.ok(Math.abs(d.times![0] - 4 / 3) < 1e-9);
  assert.equal(synth.clock.bpm, 90);
});

test('To Rotary moves the signal from the output to the rotary send; organFx has none', () => {
  const { store, chain } = rig('pianoAFx');
  store.setMany([['pianoAFx.ampEnable', 1], ['pianoAFx.ampTypeNew', 7]], 'ui');
  assert.equal(chain.sendingToRotary, true);
  assert.equal(v(chain.output.gain), 0);
  assert.equal(v(chain.rotarySend!.gain), 1);
  store.set('pianoAFx.ampTypeNew', 1);
  assert.equal(v(chain.output.gain), 1);
  assert.equal(v(chain.rotarySend!.gain), 0);
  const organ = rig('organFx');
  assert.equal(organ.chain.rotarySend, null);
  organ.store.setMany([['organFx.ampEnable', 1], ['organFx.ampTypeNew', 7]], 'ui');
  assert.equal(v(organ.chain.output.gain), 1, 'organ To Rotary: plays as Off, output stays');
});

test('Global mode: every chain bypasses the unit, one global instance plays the focus block', () => {
  const ctx = new FakeContext();
  const store = quietStore();
  const out = new FakeGain(ctx);
  const chains = FX_BLOCKS.map((block) => new LayerFxChain({ ctx: asContext(ctx), values: store, block, clock: null }));
  const global = new GlobalUnits({ ctx: asContext(ctx), values: store, out: asNode(out), clock: null });
  store.onChange((b) => {
    chains.forEach((c) => c.applyChanges(b));
    global.applyChanges(b);
  });
  assert.ok(reaches(global.input, out), 'the sum passes through');
  store.setMany(FX_BLOCKS.flatMap((b): Entry[] => [[fxKey(b, 'dlyEnable'), 1], [fxKey(b, 'rvbEnable'), 1]]), 'ui');
  assert.ok(chains.every((c) => c.units.delay.on && c.units.reverb.on));
  assert.equal(global.units.delay.on, false);
  const delaysBefore = ctx.count('delay');
  store.set('common.effectsDlyGlobal', 1);
  assert.ok(chains.every((c) => !c.units.delay.on), 'bypassed in every chain');
  assert.ok(chains.every((c) => c.units.reverb.on), 'other units stay');
  assert.equal(global.units.delay.on, true);
  assert.ok(ctx.count('delay') > delaysBefore, 'the global delay is built once');
  // The global instance plays the focus block's settings.
  store.setMany([...fxFocusEntries('synthCFx'), ['synthCFx.dlyClkEnable', 0], ['synthCFx.dlyRateClkDiv', 0]], 'ui');
  const gd = global.units.delay.stage as Delay;
  assert.ok(Math.abs(gd.times![0] - 0.01) < 1e-9);
  store.set('synthCFx.dlyEnable', 0);
  assert.equal(global.units.delay.on, false, 'the focus block\'s Enable switches the global unit');
  store.set('synthCFx.dlyEnable', 1);
  store.set('common.effectsRvbGlobal', 1);
  store.set('common.effectsCmpGlobal', 1);
  assert.ok(chains.every((c) => !c.units.reverb.on));
  assert.equal(global.units.reverb.on, true);
  assert.equal(global.units.comp.on, false, 'the focus block\'s compressor is off');
  // Layer Effects off: nothing plays, in the chains or globally.
  store.setMany(FX_BLOCKS.map((b): Entry => [fxKey(b, 'fx1Enable'), 1]), 'ui');
  store.set('common.fxEnable', 0);
  for (const c of chains) for (const slot of Object.values(c.units)) assert.equal(slot.on, false);
  for (const slot of Object.values(global.units)) assert.equal(slot.on, false);
  store.set('common.fxEnable', 1);
  assert.ok(chains.every((c) => c.units.mod1.on));
  global.dispose();
  for (const c of chains) c.dispose();
});

test('panic cuts the delay and reverb tails; a disabled reverb cuts its tail too', () => {
  const { ctx, store, chain } = rig();
  store.setMany([['synthAFx.dlyEnable', 1], ['synthAFx.rvbEnable', 1], ['synthAFx.rvbType', 8]], 'ui');
  const d = chain.units.delay.stage as Delay;
  const r = chain.units.reverb.stage as Reverb;
  const convolvers = ctx.count('convolver');
  ctx.advance(1);
  chain.silence();
  assert.equal(ctx.count('convolver'), convolvers + 1, 'a fresh convolver replaces the ringing one');
  const duck = (d.params.duck as unknown as FakeParam).events;
  assert.ok(duck.some((e) => e.kind === 'target' && e.value === 0 && e.time === 1), 'repeats fade at once');
  assert.ok(duck.some((e) => e.kind === 'target' && e.value === 1 && e.time > 1), 'and come back once the lines are empty');
  assert.equal(r.ir, 8);
  store.set('synthAFx.rvbEnable', 0);
  assert.equal(ctx.count('convolver'), convolvers + 2);
});

test('a reverb type change crossfades to a new convolver; impulse responses are shared per context', () => {
  const ctx = new FakeContext();
  const store = quietStore();
  const a = new LayerFxChain({ ctx: asContext(ctx), values: store, block: 'synthAFx', clock: null });
  const b = new LayerFxChain({ ctx: asContext(ctx), values: store, block: 'synthBFx', clock: null });
  store.onChange((x) => [a, b].forEach((c) => c.applyChanges(x)));
  store.setMany([['synthAFx.rvbEnable', 1], ['synthBFx.rvbEnable', 1], ['synthAFx.rvbType', 2],
    ['synthBFx.rvbType', 2]], 'ui');
  const ra = a.units.reverb.stage as Reverb;
  const rb = b.units.reverb.stage as Reverb;
  assert.equal(ra.ir, 2);
  store.set('synthAFx.rvbType', 10);
  assert.equal(ra.ir, 10);
  assert.equal(rb.ir, 2);
  assert.equal(ctx.count('convolver'), 3, 'two reverbs, one swap');
  assert.equal(impulseBuffer(asContext(ctx), 2), impulseBuffer(asContext(ctx), 2), 'one buffer per type and context');
  a.dispose();
  b.dispose();
});

test('a load re-reads every field, silences the tails and forgets the pedal', () => {
  const { ctx, store, chain } = rig();
  const next = quietStore().snapshot();
  const values = { ...next.values, 'synthAFx.rvbEnable': 1, 'synthAFx.rvbType': 6, 'synthAFx.fx1Enable': 1,
    'synthAFx.fx1Type': 9 } as Record<Ns4Key, number>;
  store.load({ ...next, values }, 'load');
  assert.equal(chain.units.reverb.on, true);
  assert.equal((chain.units.reverb.stage as Reverb).ir, 6);
  assert.equal((chain.units.mod1.stage as Mod1).family, 'wah');
  chain.controller('pedal', 100);
  assert.equal((chain.units.mod1.stage as Mod1).pedal.moved, true);
  const convs = ctx.count('convolver');
  store.load({ ...next, values }, 'load');
  assert.equal((chain.units.mod1.stage as Mod1).pedal.moved, false, 'PED falls back to the rate knob (p.49)');
  assert.equal(ctx.count('convolver'), convs + 1, 'the load cut the reverb tail');
});

test('morphs reach the rates and mixes (the chain reads the morphed values)', () => {
  const ctx = new FakeContext();
  const store = quietStore();
  const morphed = new MorphedValues(store);
  const chain = new LayerFxChain({ ctx: asContext(ctx), values: morphed, block: 'synthAFx', clock: null });
  store.onChange((b) => chain.applyChanges(morphed.expand(b)));
  store.setMany([['synthAFx.dlyEnable', 1], ['synthAFx.dlyMix', 0], ['synthAFx.fx2Enable', 1], ['synthAFx.fx2Type', 2],
    ['synthAFx.fx2Rate', 0], [morphKey('synthAFx.dlyMix', 'wheel'), 127],
    [morphKey('synthAFx.fx2Rate', 'ctrlPedal'), 127]], 'ui');
  const d = chain.units.delay.stage as Delay;
  assert.equal(v(d.params.wet), 0);
  chain.applyChanges(morphed.move('wheel', 1));
  assert.ok(Math.abs(v(d.params.wet) - 1) < 1e-9, 'wheel up: fully wet');
  const lfos = ctx.sources.filter((s) => s.kind === 'oscillator') as FakeOscillator[];
  assert.ok(lfos.some((o) => Math.abs(o.frequency.value - mod2RateHz(0)) < 1e-9));
  chain.applyChanges(morphed.move('ctrlPedal', 1));
  assert.ok(lfos.some((o) => Math.abs(o.frequency.value - mod2RateHz(127)) < 1e-9), 'pedal: the flanger LFO speeds up');
  chain.applyChanges(morphed.rest());
  assert.equal(v(d.params.wet), 0);
});

test('Mod 1 Pump PED ducks when the control pedal rises through 64', () => {
  const { store, chain } = rig();
  store.setMany([['synthAFx.fx1Enable', 1], ['synthAFx.fx1Type', 11], ['synthAFx.fx1Amt', 127]], 'ui');
  const pump = (chain.units.mod1.stage as Mod1).stage('pump')!;
  const g = (pump.output as unknown as FakeGain).gain;
  const before = g.events.length;
  chain.controller('pedal', 30);
  assert.equal(g.events.length, before, 'no duck below 64');
  chain.controller('pedal', 100);
  assert.ok(g.events.slice(before).some((e) => e.kind === 'target' && Math.abs(e.value) < 1e-9), 'duck to 1 − amount');
  const n = g.events.length;
  chain.controller('pedal', 110);
  assert.equal(g.events.length, n, 'one duck per rise');
});

test('dispose stops every LFO and disconnects the chain', () => {
  const { ctx, store, chain } = rig();
  store.setMany([['synthAFx.fx1Enable', 1], ['synthAFx.fx2Enable', 1], ['synthAFx.rvbEnable', 1]], 'ui');
  const oscs = ctx.sources.filter((s) => s.kind === 'oscillator');
  assert.ok(oscs.length > 0);
  chain.dispose();
  ctx.advance(10);
  assert.equal(ctx.live().filter((s) => s.kind === 'oscillator').length, 0);
  assert.equal((chain.input as unknown as FakeGain).outputs.size, 0);
  chain.applyChanges([{ key: 'synthAFx.fx1Enable', value: 0, previous: 1, origin: 'ui' }]); // gitleaks:allow
  chain.silence();
});

test('the engines play through the real chains; To Rotary reaches the organ rotary', () => {
  const ctx = new FakeContext();
  const store = quietStore();
  const master = new FakeGain(ctx);
  const global = globalFxFactory({ ctx: asContext(ctx), values: store, out: asNode(master), clock: null });
  let organ: OrganEngine | null = null;
  const made: FxChain[] = [];
  const fx: FxHooks = {
    chain: (x) => {
      const ch = fxChainFactory(x);
      made.push(ch);
      return ch;
    },
    rotary: () => organ?.rotaryInput ?? null,
    clock: null,
  };
  const c: SectionContext = { ctx: asContext(ctx), values: store, out: global.input, fx };
  organ = new OrganEngine(c);
  const piano = new PianoEngine(c);
  const synth = makeSynthFactory()(c);
  store.onChange((b) => {
    organ!.applyChanges(b);
    piano.applyChanges(b);
    synth.applyChanges(b);
    global.applyChanges(b);
  });
  assert.ok(reaches(global.input, master));
  assert.deepEqual(made.map((m) => m.block).sort(), [...FX_BLOCKS].sort());
  store.setMany([['synthBFx.ampEnable', 1], ['synthBFx.ampTypeNew', 7]], 'ui');
  const synthB = made.find((m) => m.block === 'synthBFx') as LayerFxChain;
  assert.equal(synthB.sendingToRotary, true);
  assert.ok((synthB.rotarySend as unknown as FakeGain).outputs.has(organ.rotaryInput as unknown as FakeGain),
    'the send is wired to the organ rotary');
  assert.equal(v(synthB.rotarySend!.gain), 1);
  synth.handle({ type: 'controller', kind: 'pedal', value: 90 });
  synth.panic();
  piano.panic();
  organ.panic();
  synth.dispose();
  piano.dispose();
  organ.dispose();
  global.dispose();
});
