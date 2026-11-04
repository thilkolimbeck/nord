/**
 * The contract between the synth voice and the AudioWorklet processors (plan section 15.7). Two
 * processors live in one module, built by Vite as a same-origin file (no blob:, no eval, so the
 * strict CSP `script-src 'self'` allows it):
 *
 * - 'nord-osc': one voice's oscillator, band-limited (PolyBLEP family) for the analog categories
 *   the native nodes only approximate: Sync, Shape, Shape Sine, Multi, Super. Unison copies are
 *   rendered inside, spread in stereo. No inputs; one stereo output.
 * - 'nord-filter': one voice's filter stage in front of the VCA: mode 'ladder' is the LP M
 *   transistor ladder (4 poles, a tanh per stage, drive at its input); mode 'drive' is the drive
 *   stage alone, in front of the native biquads of the other filter types. One stereo in, one out.
 *
 * Parameters are AudioParams the voice connects its modulation sources to, exactly as it does
 * with OscillatorNode.detune and BiquadFilterNode.detune: 'pitch' takes the voice's pitch source
 * (cents re A4), 'ctrl' its osc ctrl source (0..1 plus modulation), 'detune' its cutoff source
 * (cents). Static settings travel as processorOptions; live wave changes and the end of a voice as
 * port messages. Lifetime: an AudioWorkletNode has no start or stop, so the voice's wrapper keeps a
 * silent ConstantSourceNode as its clock (started and stopped with the voice, its onended is the
 * graph's onEnded) and posts { type: 'end' } so the processor returns false and frees its CPU.
 *
 * Pure: names, numbers and validators only. Shared by audio/worklet/** (builder B5); frozen.
 */
import type { AnalogCategory, OscSpec } from '../mapping.ts';

export const OSC_PROCESSOR = 'nord-osc';
export const FILTER_PROCESSOR = 'nord-filter';
export const PROCESSOR_NAMES: readonly string[] = [OSC_PROCESSOR, FILTER_PROCESSOR];

/** An AudioParamDescriptor (the processor's static parameterDescriptors). */
export interface ParamSpec {
  readonly name: string;
  readonly defaultValue: number;
  readonly minValue: number;
  readonly maxValue: number;
  readonly automationRate: 'a-rate' | 'k-rate';
}

/** 'nord-osc' parameters. */
export const OSC_PARAMS: readonly ParamSpec[] = [
  /** Cents re A4 (440 Hz): frequency = 440 · 2^(pitch / 1200). The voice's pitch source connects here. */
  { name: 'pitch', defaultValue: 0, minValue: -14400, maxValue: 14400, automationRate: 'a-rate' },
  /** Osc ctrl: 0..1 is the knob's range; modulation may push it outside, the processor clamps to 0..1. */
  { name: 'ctrl', defaultValue: 0, minValue: -4, maxValue: 5, automationRate: 'a-rate' },
];

/** 'nord-filter' parameters. */
export const FILTER_PARAMS: readonly ParamSpec[] = [
  /** Cutoff in Hz before modulation (the filter frequency knob, capped at 0.45 × sample rate inside). */
  { name: 'frequency', defaultValue: 1000, minValue: 10, maxValue: 24000, automationRate: 'a-rate' },
  /** Cutoff modulation in cents (keyboard tracking, filter envelope, LFO): the voice's cutoff source connects here. */
  { name: 'detune', defaultValue: 0, minValue: -19200, maxValue: 19200, automationRate: 'a-rate' },
  /** Ladder feedback 0..1 (1 is the edge of self-oscillation); ignored in 'drive' mode. */
  { name: 'resonance', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
  /** Input gain of the drive stage: 1 = clean (drive off), up to 16. */
  { name: 'drive', defaultValue: 1, minValue: 1, maxValue: 16, automationRate: 'k-rate' },
];

/** The analog categories the oscillator processor renders. */
export const WORKLET_OSC_KINDS = ['sync', 'shape', 'shapeSine', 'multi', 'super'] as const;
export type WorkletOscKind = (typeof WORKLET_OSC_KINDS)[number];

/** processorOptions of 'nord-osc'. */
export interface OscOptions {
  readonly kind: WorkletOscKind;
  /** The wave within the category (OscSpec.wave, the oscWave value; meaning per M p.29–30, as oscillators.ts). */
  readonly wave: number;
  /** Unison copies 1..4 and their detune spread in cents (mapping.ts unison). */
  readonly copies: number;
  readonly spreadCents: number;
  /** Seed of the per-voice random start phases, so tests and renders repeat. */
  readonly seed: number;
}

export type FilterMode = 'ladder' | 'drive';

/** processorOptions of 'nord-filter'. */
export interface FilterOptions {
  readonly mode: FilterMode;
}

/** AudioWorkletNodeOptions besides processorOptions and parameterData. */
export const OSC_NODE_OPTIONS = { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] } as const;
export const FILTER_NODE_OPTIONS = { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] } as const;

/** Messages the voice posts to a processor's port. */
export type ToProcessor =
  /** Another wave of a worklet category while the voice sounds (oscCat, oscWave changed live). */
  | { readonly type: 'wave'; readonly kind: WorkletOscKind; readonly wave: number }
  /** The voice ends: output silence from audio time `at` on and return false from process(). */
  | { readonly type: 'end'; readonly at: number };

/** Messages a processor posts back (only on failure; the voice then logs and goes on silent). */
export type FromProcessor = { readonly type: 'error'; readonly message: string };

const KIND_SET: ReadonlySet<string> = new Set<string>(WORKLET_OSC_KINDS);

export function isWorkletKind(category: AnalogCategory | string): category is WorkletOscKind {
  return KIND_SET.has(category);
}

/** The processor kind for an oscillator spec, or null where the native nodes stay (Pure, Sub, Misc, FM). */
export function workletKind(spec: OscSpec): WorkletOscKind | null {
  return spec.bank === 'analog' && isWorkletKind(spec.category) ? spec.category : null;
}

/** Validates a message on the processor side (a malformed one is ignored). */
export function isToProcessor(m: unknown): m is ToProcessor {
  if (typeof m !== 'object' || m === null) return false;
  const r = m as Record<string, unknown>;
  if (r['type'] === 'end') return typeof r['at'] === 'number' && Number.isFinite(r['at']);
  if (r['type'] === 'wave') {
    return typeof r['kind'] === 'string' && isWorkletKind(r['kind'])
      && typeof r['wave'] === 'number' && Number.isInteger(r['wave']) && r['wave'] >= 0;
  }
  return false;
}

/** Validates processorOptions of 'nord-osc' (the processor refuses others with an error message). */
export function isOscOptions(o: unknown): o is OscOptions {
  if (typeof o !== 'object' || o === null) return false;
  const r = o as Record<string, unknown>;
  const int = (v: unknown, lo: number, hi: number): boolean => typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi;
  return typeof r['kind'] === 'string' && isWorkletKind(r['kind']) && int(r['wave'], 0, 127) && int(r['copies'], 1, 4)
    && typeof r['spreadCents'] === 'number' && Number.isFinite(r['spreadCents']) && r['spreadCents'] >= 0
    && int(r['seed'], 0, 2 ** 32 - 1);
}

/** The slice of BaseAudioContext the capability check reads; structural so tests can fake it. */
export interface WorkletHost {
  readonly audioWorklet?: { addModule(url: string, options?: { credentials?: string }): Promise<void> };
}

/**
 * Whether this context can run the worklet engine: an audioWorklet with addModule and the
 * AudioWorkletNode constructor. Without it (old browsers, the Node tests) the native voice plays.
 */
export function supportsAudioWorklet(ctx: WorkletHost, scope: object = globalThis): boolean {
  return typeof ctx.audioWorklet?.addModule === 'function'
    && typeof (scope as { AudioWorkletNode?: unknown }).AudioWorkletNode === 'function';
}
