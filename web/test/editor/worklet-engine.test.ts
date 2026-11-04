/**
 * The AudioWorklet providers (plan section 15.7, audio/worklet/engine.ts) and the voice's hooks
 * (audio/voice.ts) on the fake audio context, with a fake AudioWorkletNode: both providers decline
 * without support, before the module loaded and after a failure; loaded, the source provider builds
 * one 'nord-osc' node per voice for Sync, Shape, Shape Sine, Multi and Super (pitch and osc ctrl on
 * its parameters, a silent clock for start, stop and onEnded, 'end' posted on stop), the filter
 * provider a 'nord-filter' ladder for LP M and a drive stage in front of the native biquads; the
 * synth voice plays through them and follows live changes.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SynthEngine } from '../../src/editor/audio/engine.ts';
import { driveGain, type FilterSpec, filterSpec, type OscSpec, resonanceQ } from '../../src/editor/audio/mapping.ts';
import type { SourceRequest } from '../../src/editor/audio/sources.ts';
import { createWorkletVoices, filterParams, ladderResonance } from '../../src/editor/audio/worklet/engine.ts';
import {
  FILTER_PARAMS, FILTER_PROCESSOR, isOscOptions, OSC_PARAMS, OSC_PROCESSOR, type ParamSpec,
} from '../../src/editor/audio/worklet/protocol.ts';
import { initProgram } from '../../src/editor/model/init.ts';
import { ParamStore } from '../../src/editor/model/store.ts';
import {
  asContext, asNode, FakeConstantSource, FakeContext, FakeGain, FakeNode, FakeParam, installAudioGlobals,
} from './fake-audio.ts';

installAudioGlobals();

class FakePort {
  readonly sent: unknown[] = [];
  onmessage: ((event: { data: unknown }) => void) | null = null;
  postMessage(m: unknown): void {
    this.sent.push(m);
  }
}

/** Processors the fake audio thread knows: addModule registers them, as the real module does. */
const registered = new WeakMap<FakeContext, Set<string>>();

class FakeWorkletNode extends FakeNode {
  readonly name: string;
  readonly options: AudioWorkletNodeOptions;
  readonly parameters: Map<string, FakeParam>;
  readonly port = new FakePort();
  onprocessorerror: (() => void) | null = null;

  constructor(ctx: FakeContext, name: string, options: AudioWorkletNodeOptions = {}) {
    if (!(registered.get(ctx)?.has(name) ?? false)) throw new Error(`InvalidStateError: ${name} is not registered`);
    super(ctx, 'audioWorklet');
    this.name = name;
    this.options = options;
    const list: readonly ParamSpec[] = name === OSC_PROCESSOR ? OSC_PARAMS : FILTER_PARAMS;
    this.parameters = new Map(list.map((p) => [p.name, new FakeParam(options.parameterData?.[p.name] ?? p.defaultValue)]));
  }

  param(name: string): FakeParam {
    return this.parameters.get(name)!;
  }
}

/** A fake context with an audioWorklet whose addModule registers both processors (or fails). */
class WorkletContext extends FakeContext {
  readonly modules: string[] = [];
  refuse = false;
  readonly nodes: FakeWorkletNode[] = [];
  readonly audioWorklet = {
    addModule: (url: string): Promise<void> => {
      this.modules.push(url);
      if (this.refuse) return Promise.reject(new Error('blocked by the CSP'));
      registered.set(this, new Set([OSC_PROCESSOR, FILTER_PROCESSOR]));
      return Promise.resolve();
    },
  };
}

Object.assign(globalThis, {
  AudioWorkletNode: class extends FakeWorkletNode {
    constructor(ctx: WorkletContext, name: string, options?: AudioWorkletNodeOptions) {
      super(ctx, name, options);
      ctx.nodes.push(this);
    }
  },
});

const MODULE_URL = '/nord/assets/processor-test.js';

function sourceRequest(ctx: FakeContext, spec: OscSpec | { silent: string }, copies = 2): SourceRequest & {
  pitch: FakeConstantSource; ctrl: FakeConstantSource;
} {
  const pitch = new FakeConstantSource(ctx);
  const ctrl = new FakeConstantSource(ctx);
  return {
    ctx: asContext(ctx), values: new ParamStore(initProgram()), layer: 'A', note: 60, velocity: 100, spec,
    inputs: { pitch: asNode(pitch), ctrl: asNode(ctrl) }, unison: { copies, spreadCents: 6 }, cents: -900, pitch, ctrl,
  };
}

const SYNC: OscSpec = { bank: 'analog', category: 'sync', wave: 2, ctrl: 0.3 };

function spec(over: Partial<FilterSpec>): FilterSpec {
  return { enabled: true, type: 'lpm', freq: 1200, q: resonanceQ(64), hpFreq: 20, drive: 0, kbdTrack: 0, ...over };
}

test('without AudioWorklet both providers decline and load resolves false', async () => {
  const ctx = new FakeContext();
  const w = createWorkletVoices(asContext(ctx));
  assert.equal(await w.load(MODULE_URL), false);
  assert.equal(w.ready, false);
  assert.equal(w.sources.build(sourceRequest(ctx, SYNC)), null);
  assert.equal(w.filters.build({ ctx: asContext(ctx), values: new ParamStore(initProgram()), layer: 'A', spec: spec({}),
    cutoff: asNode(new FakeConstantSource(ctx)) }), null);
  const scope = globalThis as unknown as Record<string, unknown>;
  const Node = scope['AudioWorkletNode'];
  delete scope['AudioWorkletNode'];
  const wc = new WorkletContext();
  assert.equal(await createWorkletVoices(asContext(wc)).load(MODULE_URL), false, 'no AudioWorkletNode constructor');
  assert.deepEqual(wc.modules, []);
  scope['AudioWorkletNode'] = Node;
});

test('before the module loaded and after addModule failed the providers decline', async () => {
  const ctx = new WorkletContext();
  const w = createWorkletVoices(asContext(ctx));
  assert.equal(w.sources.build(sourceRequest(ctx, SYNC)), null, 'not loaded yet');
  const loading = w.load(MODULE_URL);
  assert.equal(w.load(MODULE_URL), loading, 'one load per context');
  assert.equal(await loading, true);
  assert.deepEqual(ctx.modules, [MODULE_URL]);
  assert.equal(w.ready, true);
  const refused = new WorkletContext();
  refused.refuse = true;
  const r = createWorkletVoices(asContext(refused));
  const warn = console.warn;
  console.warn = () => undefined;
  try {
    assert.equal(await r.load(MODULE_URL), false);
  } finally {
    console.warn = warn;
  }
  assert.equal(r.ready, false);
  assert.equal(r.sources.build(sourceRequest(refused, SYNC)), null);
});

test('the source provider takes the worklet kinds only', async () => {
  const ctx = new WorkletContext();
  const w = createWorkletVoices(asContext(ctx));
  await w.load(MODULE_URL);
  for (const category of ['pure', 'sub', 'misc'] as const) {
    assert.equal(w.sources.build(sourceRequest(ctx, { bank: 'analog', category, wave: 0, ctrl: 0 })), null, category);
  }
  assert.equal(w.sources.build(sourceRequest(ctx, { bank: 'fm-h', algorithm: 0, wave: 0, semitones: 0, ctrl: 0 })), null);
  assert.equal(w.sources.build(sourceRequest(ctx, { silent: 'samples mode' })), null);
  assert.equal(w.sources.covers(new ParamStore(initProgram()), 'A'), false, 'it never makes a silent layer play');
  for (const category of ['sync', 'shape', 'shapeSine', 'multi', 'super'] as const) {
    assert.notEqual(w.sources.build(sourceRequest(ctx, { bank: 'analog', category, wave: 1, ctrl: 0 })), null, category);
  }
});

test('an oscillator graph: one node, pitch and ctrl on its parameters, a clock, end on stop', async () => {
  const ctx = new WorkletContext();
  const w = createWorkletVoices(asContext(ctx));
  await w.load(MODULE_URL);
  const req = sourceRequest(ctx, SYNC, 3);
  const graph = w.sources.build(req)!;
  assert.equal(ctx.nodes.length, 1);
  const node = ctx.nodes[0]!;
  assert.equal(node.name, OSC_PROCESSOR);
  const o = node.options.processorOptions as Record<string, unknown>;
  assert.ok(isOscOptions(o));
  assert.deepEqual([o['kind'], o['wave'], o['copies'], o['spreadCents']], ['sync', 2, 3, 6]);
  assert.deepEqual([node.options.numberOfInputs, node.options.outputChannelCount], [0, [2]]);
  assert.ok(req.pitch.outputs.has(node.param('pitch')) && req.ctrl.outputs.has(node.param('ctrl')));
  assert.ok(node.outputs.has(graph.output as unknown as FakeNode));
  const clock = [...node.param('pitch').inputs].find((n) => n !== req.pitch) as FakeConstantSource;
  assert.equal(clock.offset.value, 0, 'the clock adds nothing to the pitch');
  graph.start(0.5);
  assert.deepEqual([clock.started, clock.startAt], [true, 0.5]);
  let ended = 0;
  graph.onEnded(() => {
    ended += 1;
  });
  graph.stop(1e7);
  graph.stop(2);
  assert.deepEqual(node.port.sent, [{ type: 'end', at: 1e7 }, { type: 'end', at: 2 }]);
  ctx.advance(1);
  assert.equal(ended, 0);
  ctx.advance(2);
  assert.equal(ended, 1);
  graph.disconnect();
  assert.ok(!req.pitch.outputs.has(node.param('pitch')) && !req.ctrl.outputs.has(node.param('ctrl')));
  assert.equal(node.outputs.size, 0);
  assert.deepEqual(node.port.sent.at(-1), { type: 'end', at: 0 });
  const seeds = [w.sources.build(sourceRequest(ctx, SYNC)), w.sources.build(sourceRequest(ctx, SYNC))]
    .map((_, i) => (ctx.nodes[1 + i]!.options.processorOptions as { seed: number }).seed);
  assert.notEqual(seeds[0], seeds[1], 'each voice its own start phases');
});

test('the filter provider: a ladder for LP M, a drive stage before native biquads, nothing else', async () => {
  const ctx = new WorkletContext();
  const w = createWorkletVoices(asContext(ctx));
  await w.load(MODULE_URL);
  const values = new ParamStore(initProgram());
  const cutoff = new FakeConstantSource(ctx);
  const build = (s: FilterSpec) => w.filters.build({ ctx: asContext(ctx), values, layer: 'A', spec: s, cutoff: asNode(cutoff) });

  assert.equal(build(spec({ type: 'lp24' })), null, 'plain LP24: native');
  assert.equal(build(spec({ enabled: false })), null);

  const ladder = build(spec({ drive: 2 }))!;
  const node = ctx.nodes.at(-1)!;
  assert.deepEqual([node.name, (node.options.processorOptions as { mode: string }).mode], [FILTER_PROCESSOR, 'ladder']);
  assert.ok(ladder.input === (node as unknown as AudioNode) && ladder.output === (node as unknown as AudioNode));
  assert.deepEqual([node.param('frequency').value, node.param('drive').value], [1200, driveGain(2)]);
  assert.ok(Math.abs(node.param('resonance').value - 64 / 127) < 1e-9);
  assert.ok(cutoff.outputs.has(node.param('detune')), 'cutoff modulation in cents');
  ladder.update(spec({ freq: 300, q: resonanceQ(127), drive: 2 }), 1);
  assert.deepEqual([node.param('frequency').value, node.param('resonance').value], [300, 1]);
  ladder.disconnect();
  assert.ok(!cutoff.outputs.has(node.param('detune')));

  const biquads = ctx.count('biquadFilter');
  const driven = build(spec({ type: 'hp', drive: 3 }))!;
  const dn = ctx.nodes.at(-1)!;
  assert.equal((dn.options.processorOptions as { mode: string }).mode, 'drive');
  assert.equal(dn.param('drive').value, 8);
  assert.equal(ctx.count('biquadFilter') - biquads, 1, 'the native highpass after the drive');
  assert.notEqual(driven.output, driven.input);
  assert.ok(!cutoff.outputs.has(dn.param('detune')), 'the biquad takes the cutoff, not the drive stage');
});

test('ladder resonance: the res knob position read back from the Q curve', () => {
  assert.equal(ladderResonance(resonanceQ(0)), 0);
  assert.equal(ladderResonance(resonanceQ(127)), 1);
  for (const step of [10, 64, 100]) assert.ok(Math.abs(ladderResonance(resonanceQ(step)) - step / 127) < 1e-9);
  assert.equal(ladderResonance(0), 0);
  assert.deepEqual(filterParams(spec({ freq: 500, q: resonanceQ(0), drive: 0 })), { frequency: 500, resonance: 0, drive: 1 });
});

test('a processor error turns the engine off for new voices', async () => {
  const ctx = new WorkletContext();
  const w = createWorkletVoices(asContext(ctx));
  await w.load(MODULE_URL);
  assert.notEqual(w.sources.build(sourceRequest(ctx, SYNC)), null);
  const warn = console.warn;
  const warned: unknown[] = [];
  console.warn = (...a: unknown[]) => warned.push(a);
  try {
    ctx.nodes[0]!.port.onmessage!({ data: { type: 'error', message: 'nord-osc: invalid processorOptions' } });
  } finally {
    console.warn = warn;
  }
  assert.equal(warned.length, 1);
  assert.equal(w.ready, false, 'the coarse markers come back');
  assert.equal(w.sources.build(sourceRequest(ctx, SYNC)), null);
});

test('ready changes are announced: on after the load, off after a processor error, once each', async () => {
  const ctx = new WorkletContext();
  const w = createWorkletVoices(asContext(ctx));
  const seen: boolean[] = [];
  const off = w.onReadyChange((ready) => seen.push(ready));
  await w.load(MODULE_URL);
  assert.deepEqual(seen, [true]);
  w.sources.build(sourceRequest(ctx, SYNC));
  const warn = console.warn;
  console.warn = () => undefined;
  try {
    ctx.nodes[0]!.onprocessorerror!();
    ctx.nodes[0]!.onprocessorerror!();
  } finally {
    console.warn = warn;
  }
  assert.deepEqual(seen, [true, false]);
  off();
  const refused = new WorkletContext();
  refused.refuse = true;
  const r = createWorkletVoices(asContext(refused));
  const none: boolean[] = [];
  r.onReadyChange((ready) => none.push(ready));
  console.warn = () => undefined;
  try {
    await r.load(MODULE_URL);
  } finally {
    console.warn = warn;
  }
  assert.deepEqual(none, [], 'a refused module never was ready');
});

/** A synth engine on the worklet context with the worklet hooks; layer A is Sync Saw through LP M. */
async function synth(load = true) {
  const ctx = new WorkletContext();
  const store = new ParamStore(initProgram());
  store.set('synthASound.oscBank', 0);
  store.set('synthASound.oscCat', 2);
  store.set('synthASound.oscWave', 2);
  store.set('synthASound.fltEnable', 1);
  store.set('synthASound.fltType', 2);
  const w = createWorkletVoices(asContext(ctx));
  if (load) await w.load(MODULE_URL);
  const engine = new SynthEngine(asContext(ctx), store, undefined, asNode(new FakeGain(ctx)),
    { hooks: { sources: [w.sources], filters: [w.filters] } });
  store.onChange((b) => engine.applyChanges(b));
  const on = (note: number): void => engine.handle({ type: 'noteOn', key: note, note, velocity: 100, layers: [{ layer: 'A', gain: 1 }] });
  return { ctx, store, engine, on, w };
}

test('the synth voice plays through the worklet nodes and follows live changes', async () => {
  const { ctx, store, engine, on } = await synth();
  const oscillators = ctx.count('oscillator');
  const biquads = ctx.count('biquadFilter');
  on(60);
  assert.equal(engine.activeCount, 1);
  assert.deepEqual(ctx.nodes.map((n) => n.name).sort(), [FILTER_PROCESSOR, OSC_PROCESSOR]);
  assert.equal(ctx.count('oscillator'), oscillators, 'no native oscillator for the voice');
  assert.equal(ctx.count('biquadFilter'), biquads, 'no native biquad for LP M');
  const osc = ctx.nodes.find((n) => n.name === OSC_PROCESSOR)!;
  const flt = ctx.nodes.find((n) => n.name === FILTER_PROCESSOR)!;
  const want = filterSpec(store, 'A', ctx.sampleRate);
  assert.deepEqual(engine.voices()[0]!.filterHz, [want.freq]);
  assert.equal(flt.param('frequency').value, want.freq);
  assert.ok(flt.param('detune').inputs.size > 0, 'the voice cutoff source drives the ladder');
  assert.ok(osc.param('pitch').inputs.size >= 2 && osc.param('ctrl').inputs.size >= 1);

  store.set('synthASound.fltFreq', 40);
  const moved = filterSpec(store, 'A', ctx.sampleRate).freq;
  assert.equal(flt.param('frequency').value, moved);
  assert.deepEqual(engine.voices()[0]!.filterHz, [moved]);

  store.set('synthASound.fltType', 0);
  assert.equal(flt.outputs.size, 0, 'LP12: the ladder is gone');
  assert.equal(ctx.count('biquadFilter') - biquads, 1, 'a native LP12 biquad');

  store.set('synthASound.oscCat', 0);
  assert.ok(ctx.count('oscillator') > oscillators, 'Pure: the native oscillator');
  assert.equal((osc.port.sent.at(-1) as { type: string }).type, 'end', 'the worklet source crossfades out');

  engine.handle({ type: 'noteOff', key: 60, note: 60 });
  ctx.advance(60);
  assert.equal(engine.activeCount, 0);
  assert.equal(osc.outputs.size, 0, 'the old graph let go');
  engine.dispose();
});

test('before the module loaded the voice keeps the native graph', async () => {
  const { ctx, engine, on } = await synth(false);
  const oscillators = ctx.count('oscillator');
  on(60);
  assert.equal(ctx.nodes.length, 0);
  assert.ok(ctx.count('oscillator') > oscillators);
  engine.dispose();
});
