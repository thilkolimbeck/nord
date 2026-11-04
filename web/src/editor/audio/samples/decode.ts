/**
 * Decoding an imported audio file (plan section 15.3): decodeAudioData (no user gesture needed on
 * an OfflineAudioContext), the facts the store keeps (SampleInfo, the FAST ATK start point) and the
 * limits. The file formats are whatever the browser decodes (wav, aiff, mp3, ogg, flac are usual).
 *
 * decodeAudioData resamples to the decoding context's rate, so main decodes once on an offline
 * context at import (for the facts) and again on the running context at audio start, which spares
 * the voices a second resampling. An AudioBuffer plays in any context either way.
 *
 * audio/ may not import formats/, so the limits are repeated here; samples-decode.test.ts checks
 * that they agree with formats/samples-db.ts (MAX_SAMPLE_BYTES, MAX_SAMPLE_SECONDS) and that the
 * error texts are the store's SAMPLE_PROBLEM_TEXT.
 */
import type { SampleInfo } from '../../model/user-samples.ts';

/** = formats/samples-db.ts MAX_SAMPLE_BYTES. */
export const DECODE_MAX_BYTES = 32 * 1024 * 1024;
/** = formats/samples-db.ts MAX_SAMPLE_SECONDS. */
export const DECODE_MAX_SECONDS = 60;
/** The −6 dB point of plan 15.3: the attack has passed where the level first reaches half the peak. */
export const ATTACK_LEVEL = 10 ** (-6 / 20);

/** The decode problems, named as formats/samples-db.ts SampleStoreProblem names them. */
export type DecodeProblem = 'too-large' | 'too-long' | 'not-audio';

const DECODE_TEXT: Readonly<Record<DecodeProblem, string>> = {
  'too-large': `the file is larger than ${DECODE_MAX_BYTES / 1024 / 1024} MB`,
  'too-long': `the audio is longer than ${DECODE_MAX_SECONDS} s`,
  'not-audio': 'this browser cannot decode the file as audio',
};

/** A file the editor refuses; `message` is short enough for the print-out. */
export class SampleDecodeError extends Error {
  readonly problem: DecodeProblem;
  constructor(problem: DecodeProblem) {
    super(DECODE_TEXT[problem]);
    this.name = 'SampleDecodeError';
    this.problem = problem;
  }
}

export interface DecodedSample {
  readonly buffer: AudioBuffer;
  readonly info: SampleInfo;
}

/** What decodes: an AudioContext or OfflineAudioContext (tests pass a fake). */
export interface AudioDecoder {
  decodeAudioData(data: ArrayBuffer): Promise<AudioBuffer>;
}

/**
 * Seconds from the start to the first frame whose level (any channel) reaches ATTACK_LEVEL of the
 * peak; 0 for silence. Where FAST ATK starts the sample (M p.28; the analysis is the editor's).
 */
export function attackEnd(channels: readonly Float32Array[], sampleRate: number): number {
  let peak = 0;
  for (const data of channels) {
    for (let i = 0; i < data.length; i++) {
      const a = Math.abs(data[i]!);
      if (a > peak) peak = a;
    }
  }
  if (!(peak > 0) || !(sampleRate > 0)) return 0;
  const threshold = peak * ATTACK_LEVEL;
  let first = Infinity;
  for (const data of channels) {
    const end = Math.min(data.length, first);
    for (let i = 0; i < end; i++) {
      if (Math.abs(data[i]!) >= threshold) {
        first = i;
        break;
      }
    }
  }
  return Number.isFinite(first) ? first / sampleRate : 0;
}

/** The facts of a decoded buffer. */
export function sampleInfo(buffer: AudioBuffer): SampleInfo {
  const channels: Float32Array[] = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c));
  return {
    sampleRate: buffer.sampleRate,
    channels: buffer.numberOfChannels,
    frames: buffer.length,
    seconds: buffer.length / buffer.sampleRate,
    attackEnd: attackEnd(channels, buffer.sampleRate),
  };
}

function defaultDecoder(): AudioDecoder | null {
  const Offline = (globalThis as { OfflineAudioContext?: new (channels: number, length: number, rate: number) => AudioDecoder })
    .OfflineAudioContext;
  return Offline === undefined ? null : new Offline(1, 1, 44100);
}

/**
 * Decode a file's bytes. The bytes stay usable: decodeAudioData detaches the buffer it gets, so it
 * gets a copy. Rejects with SampleDecodeError (too large, too long, not audio).
 */
export async function decodeSample(bytes: ArrayBuffer, decoder: AudioDecoder | null = defaultDecoder()): Promise<DecodedSample> {
  if (bytes.byteLength > DECODE_MAX_BYTES) throw new SampleDecodeError('too-large');
  if (bytes.byteLength === 0 || decoder === null) throw new SampleDecodeError('not-audio');
  let buffer: AudioBuffer;
  try {
    buffer = await decoder.decodeAudioData(bytes.slice(0));
  } catch {
    throw new SampleDecodeError('not-audio');
  }
  if (buffer.length === 0 || buffer.numberOfChannels === 0) throw new SampleDecodeError('not-audio');
  // A hair of tolerance: a 60.000 s file decodes to a few frames more at another rate.
  if (buffer.length / buffer.sampleRate > DECODE_MAX_SECONDS + 0.01) throw new SampleDecodeError('too-long');
  return { buffer, info: sampleInfo(buffer) };
}
