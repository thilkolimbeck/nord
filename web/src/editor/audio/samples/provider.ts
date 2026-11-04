/**
 * Own samples in samples mode (plan section 15.3, M p.28): the source provider that plays a layer's
 * assigned sample in place of the oscillators, and the decoded buffers it plays. Everything after
 * the source (filter, amp envelope, LFO, effects) is the synth voice's, as the Stage 4 plays samples
 * through the synth (p.28). Nord's samples are not available: a layer in samples mode without an
 * own sample stays silent (mapping.ts silentReason); Nord's sample presets (amp envelope, filter
 * off, LFO off at load, p.28) are Nord content and are not applied.
 *
 * Per voice, per unison copy: an AudioBufferSourceNode, detuned and panned like the oscillators,
 * its detune fed by the voice's pitch (cents re A4) plus −(root − 69) × 100 cents, so the root note
 * plays the file at its own pitch and coarse, fine, octave shift, bend, glide, vibrato, LFO and the
 * osc envelope's pitch modulation apply as they do to an oscillator. Where a buffer source has no
 * detune parameter (older browsers), playbackRate is set once at note-on: no pitch modulation then.
 *
 * Approximations (all the editor's, none Nord's; the statuses say unverified):
 * - smpDynamic (p.28): an own sample has no built-in dynamics, so the editor supplies one. NATURAL:
 *   level × (0.35 + 0.65 × (velocity/127)²) and a low-pass from 2 kHz at velocity 1 opening to
 *   20 kHz at 127; NO DYN: neither; FAST ATK: playback starts at SampleInfo.attackEnd, with NATURAL
 *   dynamics; NO DYN & FAST ATK: both.
 * - smpTimbre Bright: a high shelf +6 dB at 4 kHz.
 * - osc ctrl has no meaning for a sample (setCtrl does nothing).
 * - One-shot plays the file once; the voice still ends with its amp envelope (voice.ts ends a voice
 *   on its envelope, so a short one-shot is followed by silence until the release has passed).
 */
import { layerKey, type SynthLayer } from '../../model/keys.ts';
import type { ValueReader } from '../../model/labels.ts';
import type { SampleAssignments, SampleHash, SampleInfo, UserSampleRef } from '../../model/user-samples.ts';
import type { OscGraph, OscInputs } from '../oscillators.ts';
import type { SourceProvider, SourceRequest } from '../sources.ts';
import { spreadOffsets } from '../waveforms.ts';
import { sampleInfo } from './decode.ts';

/** The MIDI note of A4, where the voice's pitch is 0 cents. */
const A4_NOTE = 69;
const BUTTERWORTH_Q = Math.SQRT1_2;
export const NATURAL_LOWPASS_MIN_HZ = 2000;
export const NATURAL_LOWPASS_MAX_HZ = 20000;
export const BRIGHT_SHELF_HZ = 4000;
export const BRIGHT_SHELF_DB = 6;

/** synth{L}Sound.smpDynamic in table order (575-6): NATURAL, NO DYN, NO DYN & FAST ATK, FAST ATK. */
export const SMP_DYNAMIC = ['natural', 'no-dyn', 'no-dyn-fast-atk', 'fast-atk'] as const;
export type SmpDynamic = (typeof SMP_DYNAMIC)[number];

/** Cents added to the voice's pitch so that `root` plays the file at its own pitch. */
export function rootOffsetCents(root: number): number {
  return (A4_NOTE - root) * 100;
}

/** What one smpDynamic option does at one velocity (1..127). */
export function sampleDynamics(option: number, velocity: number): {
  readonly level: number; readonly lowpassHz: number | null; readonly fastAttack: boolean;
} {
  const name: SmpDynamic = SMP_DYNAMIC[option] ?? 'natural';
  const natural = name === 'natural' || name === 'fast-atk';
  const fastAttack = name === 'fast-atk' || name === 'no-dyn-fast-atk';
  if (!natural) return { level: 1, lowpassHz: null, fastAttack };
  const v = Math.min(127, Math.max(1, velocity));
  const x = v / 127;
  return {
    level: 0.35 + 0.65 * x * x,
    lowpassHz: NATURAL_LOWPASS_MIN_HZ * (NATURAL_LOWPASS_MAX_HZ / NATURAL_LOWPASS_MIN_HZ) ** ((v - 1) / 126),
    fastAttack,
  };
}

/**
 * The buffer source's loop settings for a reference and a file length: one-shot plays once; loop
 * repeats loopStart..loopEnd, 0 meaning the end of the file. Points past the end are clamped; a
 * loop that ends up empty plays the whole file.
 */
export function loopPoints(ref: Pick<UserSampleRef, 'loop' | 'loopStart' | 'loopEnd'>, seconds: number): {
  readonly loop: boolean; readonly loopStart: number; readonly loopEnd: number;
} {
  if (ref.loop !== 'loop') return { loop: false, loopStart: 0, loopEnd: 0 };
  const dur = Math.max(0, seconds);
  let start = Math.min(Math.max(0, ref.loopStart), dur);
  let end = ref.loopEnd === 0 ? 0 : Math.min(ref.loopEnd, dur);
  if (end !== 0 && end >= dur) end = 0;
  const effectiveEnd = end === 0 ? dur : end;
  if (effectiveEnd - start <= 0) {
    start = 0;
    end = 0;
  }
  return { loop: true, loopStart: start, loopEnd: end };
}

interface Loaded {
  readonly buffer: AudioBuffer;
  readonly info: SampleInfo;
}

/** The settings one voice's sample graph is built from. */
export interface SampleVoiceSpec {
  readonly buffer: AudioBuffer;
  readonly info: SampleInfo;
  readonly ref: UserSampleRef;
  /** smpDynamic, 0..3. */
  readonly dynamic: number;
  /** smpTimbre: Bright on. */
  readonly bright: boolean;
  readonly velocity: number;
  /** The voice's pitch now (cents re A4): only for the playbackRate fallback. */
  readonly cents: number;
}

function hasDetune(src: AudioBufferSourceNode): boolean {
  return (src as { detune?: AudioParam }).detune !== undefined;
}

/** One voice's sample graph (unison copies summed into `output`). */
export function buildSampleGraph(ctx: BaseAudioContext, spec: SampleVoiceSpec, inputs: OscInputs,
  unison: { readonly copies: number; readonly spreadCents: number }): OscGraph {
  const nodes: AudioNode[] = [];
  const sources: AudioBufferSourceNode[] = [];
  const links: Array<readonly [AudioNode, AudioParam]> = [];
  const gain = (value: number): GainNode => {
    const g = ctx.createGain();
    g.gain.value = value;
    nodes.push(g);
    return g;
  };

  const copies = Math.max(1, Math.round(unison.copies));
  const dyn = sampleDynamics(spec.dynamic, spec.velocity);
  const sum = gain(1 / Math.sqrt(copies));
  let head: AudioNode = sum;
  if (dyn.lowpassHz !== null) {
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = dyn.lowpassHz;
    lp.Q.value = BUTTERWORTH_Q;
    nodes.push(lp);
    head = head.connect(lp);
  }
  if (spec.bright) {
    const shelf = ctx.createBiquadFilter();
    shelf.type = 'highshelf';
    shelf.frequency.value = BRIGHT_SHELF_HZ;
    shelf.gain.value = BRIGHT_SHELF_DB;
    nodes.push(shelf);
    head = head.connect(shelf);
  }
  const output = gain(dyn.level);
  head.connect(output);

  const seconds = spec.buffer.length / spec.buffer.sampleRate;
  const loop = loopPoints(spec.ref, seconds);
  const offset = dyn.fastAttack ? Math.min(Math.max(0, spec.info.attackEnd), seconds) : 0;
  const root = rootOffsetCents(spec.ref.root);
  const detunes = spreadOffsets(copies, unison.spreadCents);
  const pans = spreadOffsets(copies, 0.6);
  for (let i = 0; i < copies; i++) {
    const src = ctx.createBufferSource();
    src.buffer = spec.buffer;
    src.loop = loop.loop;
    src.loopStart = loop.loopStart;
    src.loopEnd = loop.loopEnd;
    const fixed = root + detunes[i]!;
    if (hasDetune(src)) {
      src.detune.value = fixed;
      inputs.pitch.connect(src.detune);
      links.push([inputs.pitch, src.detune]);
    } else {
      src.playbackRate.value = 2 ** ((spec.cents + fixed) / 1200);
    }
    sources.push(src);
    nodes.push(src);
    if (copies === 1) src.connect(sum);
    else {
      const pan = ctx.createStereoPanner();
      pan.pan.value = pans[i]!;
      nodes.push(pan);
      src.connect(pan).connect(sum);
    }
  }

  return {
    output,
    start(t: number): void {
      for (const s of sources) s.start(t, offset);
    },
    stop(t: number): void {
      for (const s of sources) s.stop(t);
    },
    onEnded(fn: () => void): void {
      let left = sources.length;
      for (const s of sources) {
        s.onended = () => {
          s.onended = null;
          if (--left === 0) fn();
        };
      }
    },
    setCtrl(): void {
      // osc ctrl has no meaning for a sample.
    },
    retune(): void {
      // Pitch arrives through detune (or is fixed at note-on in the fallback).
    },
    disconnect(): void {
      for (const [from, to] of links) {
        try {
          from.disconnect(to);
        } catch {
          // Already disconnected (the voice's sources went first).
        }
      }
      for (const n of nodes) n.disconnect();
    },
  };
}

export class SampleSources implements SourceProvider {
  readonly id = 'samples';
  readonly #assignments: SampleAssignments;
  readonly #buffers = new Map<SampleHash, Loaded>();

  constructor(assignments: SampleAssignments) {
    this.#assignments = assignments;
  }

  /** A decoded sample is ready to play (or with null: gone, e.g. deleted). Without info it is computed. */
  setBuffer(hash: SampleHash, buffer: AudioBuffer | null, info: SampleInfo | null): void {
    if (buffer === null) this.#buffers.delete(hash);
    else this.#buffers.set(hash, { buffer, info: info ?? sampleInfo(buffer) });
  }

  /** Whether a sample's buffer is here. */
  has(hash: SampleHash): boolean {
    return this.#buffers.has(hash);
  }

  /** The facts of a loaded sample (for loop faders in the UI), or null. */
  info(hash: SampleHash): SampleInfo | null {
    return this.#buffers.get(hash)?.info ?? null;
  }

  /** Assigned hashes without a buffer: missing on this device (main prints a note). */
  missing(): SampleHash[] {
    return [...this.#assignments.hashes()].filter((h) => !this.#buffers.has(h));
  }

  /** Samples mode, not extern, and an own sample with a buffer assigned. */
  covers(values: ValueReader, layer: SynthLayer): boolean {
    if (values.get(layerKey(layer, 'synth{L}.externEnable')) !== 0) return false;
    if (values.get(layerKey(layer, 'synth{L}.mode')) !== 0) return false;
    const ref = this.#assignments.get(layer);
    return ref !== null && this.#buffers.has(ref.hash);
  }

  build(req: SourceRequest): OscGraph | null {
    if (!('silent' in req.spec) || !this.covers(req.values, req.layer)) return null;
    const ref = this.#assignments.get(req.layer)!;
    const loaded = this.#buffers.get(ref.hash)!;
    return buildSampleGraph(req.ctx, {
      buffer: loaded.buffer,
      info: loaded.info,
      ref,
      dynamic: req.values.get(layerKey(req.layer, 'synth{L}Sound.smpDynamic')),
      bright: req.values.get(layerKey(req.layer, 'synth{L}Sound.smpTimbre')) !== 0,
      velocity: req.velocity,
      cents: req.cents,
    }, req.inputs, req.unison);
  }
}
