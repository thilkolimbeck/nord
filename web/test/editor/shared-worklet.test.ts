/**
 * Plan section 15.7, audio/worklet/protocol.ts and the voice hooks (shared, frozen): parameter
 * descriptors, which oscillator specs the worklet renders, message and option validation, the
 * capability check; the voice takes a source provider's graph before the native one, a provider
 * that covers a samples-mode layer makes it play, and the coarse markers go with the worklet.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SynthEngine } from '../../src/editor/audio/engine.ts';
import { coarsePatterns, type OscSpec, silentReason } from '../../src/editor/audio/mapping.ts';
import type { OscGraph } from '../../src/editor/audio/oscillators.ts';
import { layerSilence, type SourceProvider, type SourceRequest } from '../../src/editor/audio/sources.ts';
import {
  FILTER_PARAMS, isOscOptions, isToProcessor, OSC_PARAMS, PROCESSOR_NAMES, supportsAudioWorklet, WORKLET_OSC_KINDS,
  workletKind,
} from '../../src/editor/audio/worklet/protocol.ts';
import { initProgram } from '../../src/editor/model/init.ts';
import type { SynthLayer } from '../../src/editor/model/keys.ts';
import type { ValueReader } from '../../src/editor/model/labels.ts';
import { ParamStore } from '../../src/editor/model/store.ts';
import { asContext, asNode, FakeConstantSource, FakeContext, FakeGain, installAudioGlobals } from './fake-audio.ts';

installAudioGlobals();

test('parameter descriptors are well formed and unique per processor', () => {
  assert.equal(new Set(PROCESSOR_NAMES).size, 2);
  for (const list of [OSC_PARAMS, FILTER_PARAMS]) {
    assert.equal(new Set(list.map((p) => p.name)).size, list.length);
    for (const p of list) assert.ok(p.minValue <= p.defaultValue && p.defaultValue <= p.maxValue, p.name);
  }
  assert.deepEqual(OSC_PARAMS.map((p) => p.name), ['pitch', 'ctrl']);
  assert.deepEqual(FILTER_PARAMS.map((p) => p.name), ['frequency', 'detune', 'resonance', 'drive']);
});

test('the worklet renders Sync, Shape, Shape Sine, Multi and Super; the rest stays native', () => {
  const analog = (category: string): OscSpec => ({ bank: 'analog', category: category as never, wave: 0, ctrl: 0 });
  for (const k of WORKLET_OSC_KINDS) assert.equal(workletKind(analog(k)), k);
  for (const k of ['pure', 'sub', 'misc']) assert.equal(workletKind(analog(k)), null);
  assert.equal(workletKind({ bank: 'fm-h', algorithm: 0, wave: 0, semitones: 0, ctrl: 0 }), null);
});

test('messages and options are validated', () => {
  assert.ok(isToProcessor({ type: 'end', at: 1.5 }));
  assert.ok(isToProcessor({ type: 'wave', kind: 'super', wave: 2 }));
  assert.ok(!isToProcessor({ type: 'end', at: Number.NaN }));
  assert.ok(!isToProcessor({ type: 'wave', kind: 'pure', wave: 0 }));
  assert.ok(!isToProcessor({ type: 'eval', code: 'x' }));
  assert.ok(!isToProcessor(null));
  const ok = { kind: 'sync', wave: 3, copies: 2, spreadCents: 6, seed: 7 };
  assert.ok(isOscOptions(ok));
  assert.ok(!isOscOptions({ ...ok, copies: 5 }));
  assert.ok(!isOscOptions({ ...ok, kind: 'fm' }));
});

test('capability check: addModule and AudioWorkletNode, else the native voice', () => {
  const ctx = { audioWorklet: { addModule: () => Promise.resolve() } };
  assert.equal(supportsAudioWorklet(ctx, { AudioWorkletNode: class {} }), true);
  assert.equal(supportsAudioWorklet(ctx, {}), false);
  assert.equal(supportsAudioWorklet({}, { AudioWorkletNode: class {} }), false);
  assert.equal(supportsAudioWorklet(new FakeContext() as never), false, 'the Node fake has no audioWorklet');
});

test('coarse markers: none while the worklet engine runs', () => {
  const s = new ParamStore(initProgram());
  s.set('synthASound.fltType', 2);
  assert.ok(coarsePatterns(s, 'A').has('synth{L}Sound.fltType'));
  assert.equal(coarsePatterns(s, 'A', true).size, 0);
});

/** A provider that plays samples mode on layer A and records its requests; its graph is one constant source. */
function sampleProvider(ctx: FakeContext): SourceProvider & { requests: SourceRequest[] } {
  const requests: SourceRequest[] = [];
  return {
    id: 'test-samples', requests,
    covers: (values: ValueReader, layer: SynthLayer) => layer === 'A' && values.get('synthA.mode') === 0,
    build: (req) => {
      requests.push(req);
      if (!('silent' in req.spec)) return null;
      const src = new FakeConstantSource(ctx);
      const output = new FakeGain(ctx);
      src.connect(output);
      const graph: OscGraph = {
        output: output as unknown as GainNode,
        start: (t) => src.start(t), stop: (t) => src.stop(t),
        onEnded: (fn) => {
          src.onended = fn;
        },
        setCtrl: () => undefined, retune: () => undefined, disconnect: () => output.disconnect(),
      };
      return graph;
    },
  };
}

test('a source provider builds the voice of a layer it covers; the native graph plays the rest', () => {
  const ctx = new FakeContext();
  const store = new ParamStore(initProgram());
  store.set('synthA.mode', 0);
  assert.ok(/samples/.test(silentReason(store, 'A')!));
  const provider = sampleProvider(ctx);
  assert.equal(layerSilence(store, 'A', [provider]), null);
  assert.ok(/samples/.test(layerSilence(store, 'A', [])!));
  const engine = new SynthEngine(asContext(ctx), store, undefined, asNode(new FakeGain(ctx)), { hooks: { sources: [provider], filters: [] } });
  engine.handle({ type: 'noteOn', key: 60, note: 60, velocity: 99, layers: [{ layer: 'A', gain: 1 }] });
  assert.equal(engine.activeCount, 1, 'the covered samples-mode layer plays');
  assert.equal(provider.requests.length, 1);
  const req = provider.requests[0]!;
  assert.deepEqual([req.layer, req.note, req.velocity, 'silent' in req.spec], ['A', 60, 99, true]);
  assert.equal(ctx.count('oscillator') > 0, true, 'LFO and vibrato oscillators exist, but the voice has no native source');
  store.set('synthA.mode', 1);
  const before = ctx.count('oscillator');
  engine.handle({ type: 'noteOn', key: 62, note: 62, velocity: 99, layers: [{ layer: 'A', gain: 1 }] });
  assert.equal(provider.requests.length, 2, 'asked first, declined');
  assert.ok(ctx.count('oscillator') > before, 'the native builder plays the analog layer');
  engine.dispose();
});
