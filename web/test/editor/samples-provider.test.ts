/**
 * Plan section 15.3, the own-sample source provider (audio/samples/provider.ts) on the fake audio
 * context: which layers it covers, the root offset on detune with the voice's pitch connected, loop
 * points and one-shot, the four smpDynamic options, Bright, unison, the playbackRate fallback, the
 * ended callback, and a note through the synth engine.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SynthEngine } from '../../src/editor/audio/engine.ts';
import type { OscInputs } from '../../src/editor/audio/oscillators.ts';
import {
  BRIGHT_SHELF_DB, BRIGHT_SHELF_HZ, buildSampleGraph, loopPoints, rootOffsetCents, sampleDynamics, SampleSources,
} from '../../src/editor/audio/samples/provider.ts';
import { layerSilence, type SourceRequest } from '../../src/editor/audio/sources.ts';
import { initProgram } from '../../src/editor/model/init.ts';
import type { SynthLayer } from '../../src/editor/model/keys.ts';
import { ParamStore } from '../../src/editor/model/store.ts';
import { SampleAssignments, sampleRef, type SampleInfo, type UserSampleRef } from '../../src/editor/model/user-samples.ts';
import {
  asContext, asNode, FakeAudioBuffer, FakeBiquad, FakeBufferSource, FakeConstantSource, FakeContext, FakeGain,
  type FakeNode, installAudioGlobals,
} from './fake-audio.ts';

installAudioGlobals();

const H = `sha256-${'ab'.repeat(32)}`;
const H2 = `sha256-${'cd'.repeat(32)}`;
const INFO: SampleInfo = { sampleRate: 48000, channels: 1, frames: 96000, seconds: 2, attackEnd: 0.125 };

/** The shared fake, keeping the buffer sources it made and the offset each was started at. */
class SampleContext extends FakeContext {
  readonly bufferSources: Array<FakeBufferSource & { offset?: number | undefined }> = [];
  readonly biquads: FakeBiquad[] = [];
  noDetune = false;
  override createBufferSource(): FakeBufferSource {
    const src = super.createBufferSource() as FakeBufferSource & { offset?: number | undefined };
    const start = src.start.bind(src);
    src.start = (when?: number, offset?: number) => {
      src.offset = offset;
      start(when);
    };
    if (this.noDetune) Object.defineProperty(src, 'detune', { value: undefined });
    this.bufferSources.push(src);
    return src;
  }
  override createBiquadFilter(): FakeBiquad {
    const b = super.createBiquadFilter();
    this.biquads.push(b);
    return b;
  }
}

function rig(ref: UserSampleRef | null = sampleRef(H, 'pad.wav'), layer: SynthLayer = 'A') {
  const ctx = new SampleContext();
  const store = new ParamStore(initProgram());
  store.set(`synth${layer}.mode`, 0);
  const assignments = new SampleAssignments();
  if (ref !== null) assignments.set(layer, ref);
  const sources = new SampleSources(assignments);
  const buffer = new FakeAudioBuffer(1, 96000, 48000) as unknown as AudioBuffer;
  const inputs = {
    pitch: new FakeConstantSource(ctx), ctrl: new FakeConstantSource(ctx),
  };
  const request = (over: Partial<SourceRequest> = {}): SourceRequest => ({
    ctx: asContext(ctx), values: store, layer, note: 60, velocity: 127, spec: { silent: 'samples mode' },
    inputs: inputs as unknown as OscInputs, unison: { copies: 1, spreadCents: 0 }, cents: -900, ...over,
  });
  return { ctx, store, assignments, sources, buffer, inputs, request };
}

/** The node a chain of single connections from `from` ends at, and the nodes on the way. */
function path(from: FakeNode): FakeNode[] {
  const out: FakeNode[] = [from];
  let n = from;
  while (n.outputs.size === 1) {
    const next = [...n.outputs][0]!;
    if (!('outputs' in next)) break;
    n = next as FakeNode;
    out.push(n);
  }
  return out;
}

test('covers: samples mode, not extern, an assigned sample with its buffer', () => {
  const r = rig();
  assert.equal(r.sources.covers(r.store, 'A'), false, 'no buffer yet');
  assert.deepEqual(r.sources.missing(), [H]);
  assert.ok(/samples/.test(layerSilence(r.store, 'A', [r.sources])!));
  r.sources.setBuffer(H, r.buffer, INFO);
  assert.equal(r.sources.covers(r.store, 'A'), true);
  assert.deepEqual(r.sources.missing(), []);
  assert.equal(layerSilence(r.store, 'A', [r.sources]), null, 'the engine plays the layer');
  assert.equal(r.sources.covers(r.store, 'B'), false, 'layer b has no sample');
  r.store.set('synthA.externEnable', 1);
  assert.equal(r.sources.covers(r.store, 'A'), false, 'an extern layer never sounds here');
  r.store.set('synthA.externEnable', 0);
  r.store.set('synthA.mode', 1);
  assert.equal(r.sources.covers(r.store, 'A'), false, 'analog mode plays the oscillators');
  r.store.set('synthA.mode', 0);
  r.sources.setBuffer(H, null, null);
  assert.equal(r.sources.covers(r.store, 'A'), false, 'deleted: silent again');
  assert.deepEqual(r.sources.missing(), [H]);
});

test('build: only for a covered layer with a silent spec', () => {
  const r = rig();
  assert.equal(r.sources.build(r.request()), null, 'no buffer');
  r.sources.setBuffer(H, r.buffer, null);
  assert.deepEqual(r.sources.info(H), { sampleRate: 48000, channels: 1, frames: 96000, seconds: 2, attackEnd: 0 },
    'info computed when not given');
  const analog = r.request({ spec: { bank: 'analog', category: 'pure', wave: 0, ctrl: 0 } as never });
  assert.equal(r.sources.build(analog), null, 'a playable analog spec is the native builder\'s');
  assert.ok(r.sources.build(r.request()) !== null);
});

test('root note: detune carries −(root − 69) × 100 cents and the voice pitch is connected', () => {
  const r = rig({ ...sampleRef(H, 'pad.wav'), root: 48 });
  r.sources.setBuffer(H, r.buffer, INFO);
  const g = r.sources.build(r.request())!;
  assert.equal(rootOffsetCents(69), 0);
  assert.equal(rootOffsetCents(60), 900);
  const [src] = r.ctx.bufferSources;
  assert.equal(src!.buffer, r.buffer as unknown as FakeAudioBuffer);
  assert.equal(src!.detune.value, 2100);
  assert.ok(src!.detune.inputs.has(r.inputs.pitch), 'pitch modulation reaches the sample');
  g.start(1);
  assert.deepEqual([src!.startAt, src!.offset], [1, 0]);
  g.disconnect();
  assert.equal(src!.detune.inputs.size, 0, 'disconnect undoes the pitch link');
});

test('loop and one-shot: buffer source loop settings, clamped to the file', () => {
  assert.deepEqual(loopPoints({ loop: 'one-shot', loopStart: 0.5, loopEnd: 1 }, 2), { loop: false, loopStart: 0, loopEnd: 0 });
  assert.deepEqual(loopPoints({ loop: 'loop', loopStart: 0.5, loopEnd: 1 }, 2), { loop: true, loopStart: 0.5, loopEnd: 1 });
  assert.deepEqual(loopPoints({ loop: 'loop', loopStart: 0.5, loopEnd: 0 }, 2), { loop: true, loopStart: 0.5, loopEnd: 0 });
  assert.deepEqual(loopPoints({ loop: 'loop', loopStart: 0.5, loopEnd: 9 }, 2), { loop: true, loopStart: 0.5, loopEnd: 0 },
    'an end past the file is the end');
  assert.deepEqual(loopPoints({ loop: 'loop', loopStart: 5, loopEnd: 0 }, 2), { loop: true, loopStart: 0, loopEnd: 0 },
    'an empty loop plays the whole file');

  const r = rig({ ...sampleRef(H, 'pad.wav'), loop: 'loop', loopStart: 0.25, loopEnd: 1.5 });
  r.sources.setBuffer(H, r.buffer, INFO);
  r.sources.build(r.request());
  const src = r.ctx.bufferSources[0]!;
  assert.deepEqual([src.loop, src.loopStart, src.loopEnd], [true, 0.25, 1.5]);

  const once = rig();
  once.sources.setBuffer(H, once.buffer, INFO);
  const g = once.sources.build(once.request())!;
  assert.equal(once.ctx.bufferSources[0]!.loop, false);
  let ended = 0;
  g.onEnded(() => ended++);
  g.start(0);
  g.stop(5);
  once.ctx.advance(5);
  assert.equal(ended, 1, 'onEnded once the source stopped');
});

test('smpDynamic: NATURAL, NO DYN, NO DYN & FAST ATK, FAST ATK', () => {
  assert.deepEqual(sampleDynamics(0, 127), { level: 1, lowpassHz: 20000, fastAttack: false });
  const soft = sampleDynamics(0, 1);
  assert.ok(Math.abs(soft.level - (0.35 + 0.65 / 127 ** 2)) < 1e-12);
  assert.equal(soft.lowpassHz, 2000);
  assert.ok(Math.abs(sampleDynamics(0, 64).lowpassHz! - 2000 * 10 ** (63 / 126)) < 1e-6, 'opens exponentially');
  assert.deepEqual(sampleDynamics(1, 1), { level: 1, lowpassHz: null, fastAttack: false });
  assert.deepEqual(sampleDynamics(2, 1), { level: 1, lowpassHz: null, fastAttack: true });
  assert.deepEqual({ ...sampleDynamics(3, 1), level: 0 }, { level: 0, lowpassHz: 2000, fastAttack: true });

  for (const [option, lowpass, offset] of [[0, true, 0], [1, false, 0], [2, false, 0.125], [3, true, 0.125]] as const) {
    const r = rig();
    r.sources.setBuffer(H, r.buffer, INFO);
    r.store.set('synthASound.smpDynamic', option);
    const g = r.sources.build(r.request({ velocity: 40 }))!;
    g.start(0);
    const lp = r.ctx.biquads.filter((b) => b.type === 'lowpass');
    assert.equal(lp.length, lowpass ? 1 : 0, `option ${option}: low-pass`);
    if (lowpass) assert.ok(Math.abs(lp[0]!.frequency.value - sampleDynamics(0, 40).lowpassHz!) < 1e-6);
    const out = g.output as unknown as FakeGain;
    assert.ok(Math.abs(out.gain.value - (lowpass ? sampleDynamics(0, 40).level : 1)) < 1e-12, `option ${option}: level`);
    assert.equal(r.ctx.bufferSources[0]!.offset, offset, `option ${option}: start point`);
  }
});

test('Bright: a high shelf in the sample graph, before the output', () => {
  const r = rig();
  r.sources.setBuffer(H, r.buffer, INFO);
  r.store.set('synthASound.smpDynamic', 1);
  r.sources.build(r.request());
  assert.equal(r.ctx.biquads.length, 0, 'bright off: no filter at all with NO DYN');
  r.store.set('synthASound.smpTimbre', 1);
  const g = r.sources.build(r.request())!;
  const shelf = r.ctx.biquads.find((b) => b.type === 'highshelf')!;
  assert.deepEqual([shelf.frequency.value, shelf.gain.value], [BRIGHT_SHELF_HZ, BRIGHT_SHELF_DB]);
  const src = r.ctx.bufferSources.at(-1)!;
  assert.ok(path(src).includes(shelf), 'source → … → shelf');
  assert.equal(path(src).at(-1), g.output as unknown as FakeNode, '… → output');
});

test('unison: one source per copy, detuned around the root offset and panned', () => {
  const r = rig();
  r.sources.setBuffer(H, r.buffer, INFO);
  const g = r.sources.build(r.request({ unison: { copies: 3, spreadCents: 10 } }))!;
  assert.deepEqual(r.ctx.bufferSources.map((s) => s.detune.value), [890, 900, 910]);
  assert.equal(r.ctx.count('stereoPanner'), 3);
  let ended = 0;
  g.onEnded(() => ended++);
  g.start(0);
  g.stop(1);
  r.ctx.advance(1);
  assert.equal(ended, 1, 'once, after every copy');
});

test('without detune on buffer sources, playbackRate is set once at note-on', () => {
  const r = rig();
  r.ctx.noDetune = true;
  r.sources.setBuffer(H, r.buffer, INFO);
  r.sources.build(r.request({ cents: 300 }));
  const src = r.ctx.bufferSources[0]!;
  assert.ok(Math.abs(src.playbackRate.value - 2 ** (1200 / 1200)) < 1e-12, 'C4 root, note at +300 cents re A4: one octave up');
});

test('through the synth engine: a samples-mode layer with an own sample plays its buffer', () => {
  const r = rig(sampleRef(H2, 'keys.wav'), 'B');
  r.store.set('synthA.mode', 0);
  r.sources.setBuffer(H2, r.buffer, INFO);
  const engine = new SynthEngine(asContext(r.ctx), r.store, undefined, asNode(new FakeGain(r.ctx)),
    { hooks: { sources: [r.sources], filters: [] } });
  engine.handle({ type: 'noteOn', key: 60, note: 60, velocity: 100, layers: [{ layer: 'A', gain: 1 }, { layer: 'B', gain: 1 }] });
  assert.equal(engine.activeCount, 1, 'layer a in samples mode has no own sample: silent; layer b plays');
  assert.equal(r.ctx.bufferSources.filter((s) => s.buffer === (r.buffer as unknown)).length, 1);
  engine.dispose();
});
