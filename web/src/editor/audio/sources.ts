/**
 * Hook points of the synth voice (plan sections 15.3 and 15.7): a voice asks its layer's source
 * providers for its oscillator graph before it builds the native one (oscillators.ts), and its
 * filter providers before it builds native biquads. Own samples (audio/samples, builder B3) and the
 * AudioWorklet engine (audio/worklet, builder B5) are providers; without providers, or when every
 * provider declines, the voice plays exactly as before. Types and two pure helpers; shared and frozen.
 */
import type { SynthLayer } from '../model/keys.ts';
import type { ValueReader } from '../model/labels.ts';
import { type FilterSpec, type OscSpec, type Silent, silentReason } from './mapping.ts';
import type { OscGraph, OscInputs } from './oscillators.ts';

/** Everything a provider may use to build one voice's source. */
export interface SourceRequest {
  readonly ctx: BaseAudioContext;
  readonly values: ValueReader;
  readonly layer: SynthLayer;
  readonly note: number;
  /** 1..127. */
  readonly velocity: number;
  /** What the native builder would play, or why the layer is silent there (samples mode, wave type, extern). */
  readonly spec: OscSpec | Silent;
  /** The voice's pitch (cents re A4, connect it to a detune-like parameter) and osc ctrl (0..1 plus modulation). */
  readonly inputs: OscInputs;
  readonly unison: { readonly copies: number; readonly spreadCents: number };
  /** The voice's pitch now, cents re A4, for parts that depend on it statically. */
  readonly cents: number;
}

/** Builds voice sources for some layers or specs. */
export interface SourceProvider {
  readonly id: string;
  /**
   * Whether the provider makes a layer play that silentReason() calls silent (samples mode with an
   * own sample assigned). The engine then starts voices on that layer.
   */
  covers(values: ValueReader, layer: SynthLayer): boolean;
  /** One voice's source graph (started and stopped by the voice), or null to leave it to the next provider. */
  build(req: SourceRequest): OscGraph | null;
}

/** What a filter provider builds from: the voice's filter settings and its cutoff modulation. */
export interface FilterRequest {
  readonly ctx: BaseAudioContext;
  readonly values: ValueReader;
  readonly layer: SynthLayer;
  readonly spec: FilterSpec;
  /** The voice's cutoff modulation in cents (keyboard tracking, filter envelope, LFO): connect it to a detune-like parameter. */
  readonly cutoff: AudioNode;
}

/** A filter stage in the voice: mixer ─► input … output ─► VCA (drive included). */
export interface FilterStage {
  readonly input: AudioNode;
  readonly output: AudioNode;
  /** Live change of frequency, resonance or drive (the voice calls it for 'filterParams'). */
  update(spec: FilterSpec, t: number): void;
  disconnect(): void;
}

export interface FilterProvider {
  readonly id: string;
  /** A filter stage for this spec, or null: the native biquads (voice.ts) take it. */
  build(req: FilterRequest): FilterStage | null;
}

/** The providers a synth engine hands every voice through its layer taps; tried in order. */
export interface VoiceHooks {
  readonly sources: readonly SourceProvider[];
  readonly filters: readonly FilterProvider[];
}

export const NO_HOOKS: VoiceHooks = { sources: [], filters: [] };

/** The first provider's graph, or null for the native builder. */
export function buildSource(providers: readonly SourceProvider[], req: SourceRequest): OscGraph | null {
  for (const p of providers) {
    const graph = p.build(req);
    if (graph !== null) return graph;
  }
  return null;
}

/** Why a layer cannot sound, or null: silentReason() unless a provider covers the layer. */
export function layerSilence(values: ValueReader, layer: SynthLayer, providers: readonly SourceProvider[]): string | null {
  const reason = silentReason(values, layer);
  if (reason === null) return null;
  return providers.some((p) => p.covers(values, layer)) ? null : reason;
}
