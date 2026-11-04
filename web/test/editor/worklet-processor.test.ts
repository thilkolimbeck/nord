/**
 * The processor module (plan section 15.7, audio/worklet/processor.ts) in a fake
 * AudioWorkletGlobalScope: it registers 'nord-osc' and 'nord-filter' with the protocol's parameter
 * descriptors, renders through the callback the audio thread calls, validates its options and
 * messages (a malformed one is ignored, invalid options report an error and stay silent), and ends
 * a voice on 'end'. Outside a worklet it registers nothing.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FILTER_PARAMS, FILTER_PROCESSOR, OSC_PARAMS, OSC_PROCESSOR } from '../../src/editor/audio/worklet/protocol.ts';

interface FakePort {
  onmessage: ((event: { data: unknown }) => void) | null;
  readonly sent: unknown[];
  postMessage(m: unknown): void;
}

type Processor = {
  readonly port: FakePort;
  process(inputs: Float32Array[][], outputs: Float32Array[][], params: Record<string, Float32Array>): boolean;
};
type ProcessorClass = (new (options: { processorOptions?: unknown }) => Processor) & {
  readonly parameterDescriptors: readonly unknown[];
};

const registry = new Map<string, ProcessorClass>();
const scope = globalThis as unknown as Record<string, unknown>;
/** The module under a query, so each import below evaluates it afresh. */
const MODULE = new URL('../../src/editor/audio/worklet/processor.ts', import.meta.url).href;

test('outside a worklet the module registers nothing and does not throw', async () => {
  await import(`${MODULE}?outside`);
  assert.equal(registry.size, 0);
});

async function load(): Promise<void> {
  if (registry.size > 0) return;
  Object.assign(scope, {
    sampleRate: 48000,
    currentTime: 0,
    AudioWorkletProcessor: class {
      readonly port: FakePort = { onmessage: null, sent: [], postMessage(m: unknown) { this.sent.push(m); } };
    },
    registerProcessor: (name: string, cls: ProcessorClass) => registry.set(name, cls),
  });
  await import(`${MODULE}?worklet`);
}

const BLOCK = 128;

function block(): [Float32Array, Float32Array] {
  return [new Float32Array(BLOCK), new Float32Array(BLOCK)];
}

test('both processors register with the protocol descriptors', async () => {
  await load();
  assert.deepEqual([...registry.keys()].sort(), [FILTER_PROCESSOR, OSC_PROCESSOR].sort());
  assert.deepEqual(registry.get(OSC_PROCESSOR)!.parameterDescriptors, OSC_PARAMS);
  assert.deepEqual(registry.get(FILTER_PROCESSOR)!.parameterDescriptors, FILTER_PARAMS);
  assert.equal(typeof registry.get(OSC_PROCESSOR)!.prototype.process, 'function', 'the audio thread finds its callback');
});

test("nord-osc renders, ignores malformed messages and ends on 'end'", async () => {
  await load();
  const Osc = registry.get(OSC_PROCESSOR)!;
  const p = new Osc({ processorOptions: { kind: 'super', wave: 0, copies: 2, spreadCents: 6, seed: 3 } });
  assert.deepEqual(p.port.sent, []);
  const out = block();
  const params = { pitch: Float32Array.of(0), ctrl: Float32Array.of(0.5) };
  assert.equal(p.process([], [out], params), true);
  assert.ok(out[0].some((v) => v !== 0) && out[1].some((v) => v !== 0));
  p.port.onmessage!({ data: { type: 'eval', code: 'x' } });
  p.port.onmessage!({ data: { type: 'end', at: Number.NaN } });
  assert.equal(p.process([], [block()], params), true, 'malformed messages change nothing');
  p.port.onmessage!({ data: { type: 'end', at: 0 } });
  const after = block();
  assert.equal(p.process([], [after], params), false);
  assert.ok(after[0].every((v) => v === 0));
});

test('invalid options: an error message, then silence', async () => {
  await load();
  const p = new (registry.get(OSC_PROCESSOR)!)({ processorOptions: { kind: 'fm', wave: 0, copies: 1, spreadCents: 0, seed: 1 } });
  assert.deepEqual(p.port.sent, [{ type: 'error', message: 'nord-osc: invalid processorOptions' }]);
  assert.equal(p.process([], [block()], { pitch: Float32Array.of(0), ctrl: Float32Array.of(0) }), false);
  const f = new (registry.get(FILTER_PROCESSOR)!)({ processorOptions: { mode: 'comb' } });
  assert.equal(f.port.sent.length, 1);
});

test('nord-filter filters its input and lets go after the input is gone', async () => {
  await load();
  const f = new (registry.get(FILTER_PROCESSOR)!)({ processorOptions: { mode: 'ladder' } });
  const params = {
    frequency: Float32Array.of(300), detune: Float32Array.of(0), resonance: Float32Array.of(0), drive: Float32Array.of(1),
  };
  const input = Float32Array.from({ length: BLOCK }, (_, i) => (i % 2 === 0 ? 0.5 : -0.5));
  const out = block();
  assert.equal(f.process([[input]], [out], params), true);
  assert.ok(Math.max(...out[0].map(Math.abs)) < 0.05, 'a Nyquist square is filtered away at 300 Hz');
  assert.deepEqual(out[0], out[1]);
  let blocks = 0;
  while (f.process([[]], [block()], params) && blocks < 1000) blocks += 1;
  assert.ok(blocks > 0 && blocks < 1000, 'the tail ends');
});
