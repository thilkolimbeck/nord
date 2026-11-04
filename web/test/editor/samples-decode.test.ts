/**
 * Plan section 15.3, decoding an imported file (audio/samples/decode.ts) with a fake decoder: the
 * facts the store keeps, the FAST ATK analysis (the first frame at −6 dB of the peak), the limits
 * and their texts (the same as the store's), and that the caller's bytes survive decodeAudioData
 * detaching what it gets.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ATTACK_LEVEL, attackEnd, type AudioDecoder, DECODE_MAX_BYTES, DECODE_MAX_SECONDS, decodeSample, SampleDecodeError,
  sampleInfo,
} from '../../src/editor/audio/samples/decode.ts';
import { MAX_SAMPLE_BYTES, MAX_SAMPLE_SECONDS, SAMPLE_PROBLEM_TEXT } from '../../src/editor/formats/samples-db.ts';
import { FakeAudioBuffer } from './fake-audio.ts';

/** A decoder that detaches its input, like decodeAudioData, and answers with `make`. */
function decoder(make: () => FakeAudioBuffer | Error): AudioDecoder & { seen: number[] } {
  const seen: number[] = [];
  return {
    seen,
    decodeAudioData(data: ArrayBuffer): Promise<AudioBuffer> {
      seen.push(data.byteLength);
      structuredClone(data, { transfer: [data] });
      const out = make();
      return out instanceof Error ? Promise.reject(out) : Promise.resolve(out as unknown as AudioBuffer);
    },
  };
}

function buffer(channels: number, frames: number, rate: number, fill?: (c: number, i: number) => number): FakeAudioBuffer {
  const b = new FakeAudioBuffer(channels, frames, rate);
  if (fill !== undefined) {
    for (let c = 0; c < channels; c++) {
      const d = b.getChannelData(c);
      for (let i = 0; i < frames; i++) d[i] = fill(c, i);
    }
  }
  return b;
}

async function refused(p: Promise<unknown>): Promise<SampleDecodeError> {
  const err = await p.then(() => null, (e: unknown) => e);
  assert.ok(err instanceof SampleDecodeError, `a SampleDecodeError, not ${String(err)}`);
  return err;
}

test('limits and texts agree with the store (audio may not import formats)', () => {
  assert.equal(DECODE_MAX_BYTES, MAX_SAMPLE_BYTES);
  assert.equal(DECODE_MAX_SECONDS, MAX_SAMPLE_SECONDS);
  for (const p of ['too-large', 'too-long', 'not-audio'] as const) {
    assert.equal(new SampleDecodeError(p).message, SAMPLE_PROBLEM_TEXT[p]);
  }
});

test('attack end: the first frame at −6 dB of the peak, over every channel; silence is 0', () => {
  const rate = 1000;
  const ramp = new Float32Array(1000).map((_, i) => Math.min(1, i / 100));
  assert.equal(attackEnd([ramp], rate), Math.ceil(100 * ATTACK_LEVEL) / rate);
  const late = new Float32Array(1000).map((_, i) => (i >= 300 ? -0.8 : 0));
  const early = new Float32Array(1000).map((_, i) => (i >= 40 ? 0.5 : 0));
  assert.equal(attackEnd([late, early], rate), 0.04, 'the right channel reaches half the peak first');
  assert.equal(attackEnd([new Float32Array(50)], rate), 0);
  assert.equal(attackEnd([], rate), 0);
});

test('decoding: the facts of the buffer, the input bytes left intact', async () => {
  const d = decoder(() => buffer(2, 44100 * 2, 44100, (c, i) => (i >= 441 ? 0.5 : 0)));
  const bytes = new Uint8Array(64).fill(3).buffer;
  const out = await decodeSample(bytes, d);
  assert.deepEqual(out.info, { sampleRate: 44100, channels: 2, frames: 88200, seconds: 2, attackEnd: 0.01 });
  assert.deepEqual(sampleInfo(out.buffer), out.info);
  assert.equal(bytes.byteLength, 64, 'the decoder got a copy');
  assert.deepEqual(d.seen, [64]);
});

test('refusals: too large (before decoding), not audio, empty, too long', async () => {
  const d = decoder(() => buffer(1, 10, 1000));
  assert.equal((await refused(decodeSample(new ArrayBuffer(DECODE_MAX_BYTES + 1), d))).problem, 'too-large');
  assert.deepEqual(d.seen, [], 'never decoded');
  assert.equal((await refused(decodeSample(new ArrayBuffer(0), d))).problem, 'not-audio');
  assert.equal((await refused(decodeSample(new ArrayBuffer(8), decoder(() => new Error('EncodingError'))))).problem,
    'not-audio');
  assert.equal((await refused(decodeSample(new ArrayBuffer(8), decoder(() => buffer(1, 0, 1000))))).problem, 'not-audio');
  assert.equal((await refused(decodeSample(new ArrayBuffer(8), decoder(() => buffer(1, 61 * 1000, 1000))))).problem,
    'too-long');
  assert.ok(await decodeSample(new ArrayBuffer(8), decoder(() => buffer(1, 60 * 1000, 1000))), '60 s is allowed');
  assert.equal((await refused(decodeSample(new ArrayBuffer(8), null))).problem, 'not-audio', 'no decoder in this browser');
});
