/**
 * Field values → physical values for the browser synth (plan section 4.3). Pure: no Web Audio.
 * Where the Stage 4 has a display table the value comes from its label (Hz, seconds, dB,
 * semitones, cents); where it has none the curve is a guess, marked as such here and in the UI
 * ('nv'). Every function returns finite numbers over the field's range, except decay times,
 * where Infinity means the envelope holds.
 */
import { descriptorOf, toSi } from '../model/descriptors.ts';
import { layerKey, type Ns4Key, type SynthLayer } from '../model/keys.ts';
import type { ValueReader } from '../model/labels.ts';
import {
  ARP_DIVISIONS, arpFreeStepSeconds, type ClockDivision, divisionOf, divisionSeconds, LFO_DIVISIONS,
} from '../model/clock.ts';
import { enabledLayers as sceneEnabledLayers } from '../model/scene.ts';
import { ARP_DIRECTIONS, ARP_MODES, type ArpSettings } from './arp.ts';
import type { LayerVoicing } from './voice-alloc.ts';

// ---------------------------------------------------------------------------------------------
// Helpers

function key(layer: SynthLayer, pattern: string): Ns4Key {
  return layerKey(layer, pattern);
}

/** The field's value in base units from its Stage 4 label, or `fallback` when it has none. */
function si(values: ValueReader, k: Ns4Key, fallback: number): number {
  const v = toSi(descriptorOf(k), values.get(k), values);
  return v === null || Number.isNaN(v) ? fallback : v;
}

/** The label number of a 0.0–10.0 style field (oscCtrl, fltEnvAmt, glide, vibAmt, oscEnvAmt). */
function knob(values: ValueReader, k: Ns4Key): number {
  return si(values, k, 0);
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

/** lo·(hi/lo)^t for t in 0..1: an exponential sweep. */
function expSweep(t: number, lo: number, hi: number): number {
  return lo * (hi / lo) ** clamp(t, 0, 1);
}

// ---------------------------------------------------------------------------------------------
// Layers and voicing

/**
 * The synth layers switched on in the active layer scene (none while the synth section is off
 * there). The router decides which layers play a note; this serves the silent-layer notes and
 * plain note-ons outside the router.
 */
export function enabledLayers(values: ValueReader): SynthLayer[] {
  return sceneEnabledLayers(values, 'synth');
}

const VOICE_MODES: readonly LayerVoicing['mode'][] = ['poly', 'mono', 'legato'];
const PRIORITIES: readonly LayerVoicing['priority'][] = ['none', 'low', 'high'];

export function voicing(values: ValueReader, layer: SynthLayer): LayerVoicing {
  return {
    layer,
    mode: VOICE_MODES[values.get(key(layer, 'synth{L}.voiceMode'))] ?? 'poly',
    priority: PRIORITIES[values.get(key(layer, 'synth{L}.voicePrio'))] ?? 'none',
    sustain: values.get(key(layer, 'synth{L}.sustainEnable')) !== 0,
  };
}

/** Layer level: the dB label as a gain; 'volume off' is 0. */
export function layerGain(values: ValueReader, layer: SynthLayer): number {
  const db = si(values, key(layer, 'synth.layerLevelSyn{L}'), 0);
  return db === -Infinity ? 0 : 10 ** (db / 20);
}

/** Layer pan, unverified: the stored step -60..60 as StereoPanner pan -1..1. */
export function layerPan(values: ValueReader, layer: SynthLayer): number {
  return clamp(values.get(key(layer, 'synth.layerPanSyn{L}')) / 60, -1, 1);
}

// ---------------------------------------------------------------------------------------------
// Oscillator

export type AnalogCategory = 'pure' | 'sub' | 'sync' | 'shape' | 'shapeSine' | 'multi' | 'super' | 'misc';
export const ANALOG_CATEGORIES: readonly AnalogCategory[] =
  ['pure', 'sub', 'sync', 'shape', 'shapeSine', 'multi', 'super', 'misc'];

export type OscSpec =
  | { readonly bank: 'analog'; readonly category: AnalogCategory; readonly wave: number; readonly ctrl: number }
  | { readonly bank: 'fm-h' | 'fm-i'; readonly algorithm: number; readonly wave: number; readonly semitones: number;
    readonly ctrl: number };

export interface Silent {
  readonly silent: string;
}

/** Osc ctrl, unverified: the 0.0–10.0 label as 0..1. */
export function oscCtrl(values: ValueReader, layer: SynthLayer): number {
  return clamp(knob(values, key(layer, 'synth{L}Sound.oscCtrl')) / 10, 0, 1);
}

/** Why a layer cannot sound (samples mode, wave type, extern), or null when it can. */
export function silentReason(values: ValueReader, layer: SynthLayer): string | null {
  if (values.get(key(layer, 'synth{L}.externEnable')) !== 0) return 'extern (MIDI out) is not implemented';
  if (values.get(key(layer, 'synth{L}.mode')) === 0) return 'samples mode is not implemented (Nord samples)';
  if (values.get(key(layer, 'synth{L}Sound.oscBank')) === 3) return 'the wave oscillator type is not implemented (Nord wavetables)';
  return null;
}

export function oscSpec(values: ValueReader, layer: SynthLayer): OscSpec | Silent {
  const reason = silentReason(values, layer);
  if (reason !== null) return { silent: reason };
  const bank = values.get(key(layer, 'synth{L}Sound.oscBank'));
  const cat = values.get(key(layer, 'synth{L}Sound.oscCat'));
  const wave = values.get(key(layer, 'synth{L}Sound.oscWave'));
  const ctrl = oscCtrl(values, layer);
  if (bank === 0) return { bank: 'analog', category: ANALOG_CATEGORIES[cat] ?? 'pure', wave, ctrl };
  // FM-I: the wave label is the modulator's pitch offset in semitones (-12..51); FM-H has none.
  const semitones = bank === 2 ? si(values, key(layer, 'synth{L}Sound.oscWave'), 0) : 0;
  return { bank: bank === 1 ? 'fm-h' : 'fm-i', algorithm: cat, wave, semitones, ctrl };
}

/** Unison, unverified: off/1/2/3 → copies and their detune spread in cents. */
export function unison(values: ValueReader, layer: SynthLayer): { copies: number; spreadCents: number } {
  const step = clamp(values.get(key(layer, 'synth{L}.oscUnison')), 0, 3);
  return { copies: step + 1, spreadCents: [0, 6, 12, 20][step]! };
}

// ---------------------------------------------------------------------------------------------
// Pitch

/** Pitch in cents relative to A4 (440 Hz): note, coarse, fine and octave shift. */
export function pitchCents(values: ValueReader, layer: SynthLayer, note: number): number {
  const coarse = si(values, key(layer, 'synth{L}Sound.oscTuneCoarse'), 0);
  const fine = si(values, key(layer, 'synth{L}Sound.oscTuneFine'), 0);
  const octave = values.get(key(layer, 'synth{L}.octaveShift'));
  return (note - 69) * 100 + coarse * 100 + fine + octave * 1200;
}

/** The pitch stick range as semitones up and down: '+/- 2' → 2/2, '+2 / -12' → 2/12; 0 when the stick is off. */
export function bendRange(values: ValueReader, layer: SynthLayer): { up: number; down: number } {
  if (values.get(key(layer, 'synth{L}.pStickEnable')) === 0) return { up: 0, down: 0 };
  const k = key(layer, 'synth{L}.pitchStickRange');
  const label = descriptorOf(k).options?.find((o) => o.value === values.get(k))?.label ?? '';
  const both = /^\+\/-\s*(\d+)$/.exec(label);
  if (both !== null) return { up: Number(both[1]), down: Number(both[1]) };
  const split = /^\+(\d+)\s*\/\s*-(\d+)$/.exec(label);
  if (split !== null) return { up: Number(split[1]), down: Number(split[2]) };
  return { up: 2, down: 2 };
}

/** Pitch bend -8192..8191 → cents with the layer's stick range. */
export function bendCents(values: ValueReader, layer: SynthLayer, bend: number): number {
  const r = bendRange(values, layer);
  const b = clamp(bend, -8192, 8191);
  return b >= 0 ? (b / 8191) * r.up * 100 : (b / 8192) * r.down * 100;
}

/** Glide, unverified: 0.0–10.0 → 0…0.5 s per semitone, exponential; 0 is off. */
export function glideSecondsPerSemitone(values: ValueReader, layer: SynthLayer): number {
  const x = clamp(knob(values, key(layer, 'synth{L}.glideRate')) / 10, 0, 1);
  return x === 0 ? 0 : 0.5 * (Math.exp(5 * x) - 1) / (Math.exp(5) - 1);
}

// ---------------------------------------------------------------------------------------------
// Envelopes

export interface EnvTimes {
  readonly attack: number;
  /** Infinity holds. */
  readonly decay: number;
  readonly release: number;
}

const ENV_PATTERNS = {
  osc: ['synth{L}Sound.oscEnvAtk', 'synth{L}Sound.oscEnvDcy', 'synth{L}Sound.oscEnvRls'],
  flt: ['synth{L}Sound.fltEnvAtk', 'synth{L}Sound.fltEnvDcy', 'synth{L}Sound.fltEnvRls'],
  amp: ['synth{L}Sound.ampEnvAtk', 'synth{L}Sound.ampEnvDcy', 'synth{L}Sound.ampEnvRls'],
} as const;

/** Envelope times in seconds from the Stage 4 labels (tables 568-8 … 601-5). */
export function envelope(values: ValueReader, layer: SynthLayer, which: 'osc' | 'flt' | 'amp'): EnvTimes {
  const [a, d, r] = ENV_PATTERNS[which];
  return {
    attack: si(values, key(layer, a), 0.001),
    decay: si(values, key(layer, d), 1),
    release: si(values, key(layer, r), 0.01),
  };
}

/** Velocity on the osc or filter envelope, unverified: on → depth × (0.3 + 0.7 × velocity / 127). */
export function velocityDepth(on: boolean, velocity: number): number {
  return on ? 0.3 + 0.7 * clamp(velocity, 0, 127) / 127 : 1;
}

/** Amp velocity, unverified: off/1/2/3 → sensitivity 0, ⅓, ⅔, 1; the peak gain for a velocity. */
export function ampPeak(values: ValueReader, layer: SynthLayer, velocity: number): number {
  const sens = clamp(values.get(key(layer, 'synth{L}Sound.ampEnvVel')), 0, 3) / 3;
  return 1 - sens * (1 - clamp(velocity, 1, 127) / 127);
}

export interface OscEnvDepth {
  /** Cents at full envelope when it goes to pitch, else 0. */
  readonly pitchCents: number;
  /** Osc ctrl units (0..1 range) at full envelope when it goes to osc ctrl, else 0. */
  readonly ctrl: number;
}

/** Osc env amount, unverified: -10…10 → ±24 semitones to pitch, or ±the full osc ctrl range. */
export function oscEnvDepth(values: ValueReader, layer: SynthLayer, velocity: number): OscEnvDepth {
  const amt = clamp(knob(values, key(layer, 'synth{L}Sound.oscEnvAmt')) / 10, -1, 1);
  const vel = velocityDepth(values.get(key(layer, 'synth{L}Sound.oscEnvVel')) !== 0, velocity);
  const toPitch = values.get(key(layer, 'synth{L}Sound.oscEnvDst')) !== 0;
  return toPitch ? { pitchCents: amt * 2400 * vel, ctrl: 0 } : { pitchCents: 0, ctrl: amt * vel };
}

// ---------------------------------------------------------------------------------------------
// Filter

export type FilterType = 'lp12' | 'lp24' | 'lpm' | 'lphp' | 'bp' | 'hp';
const FILTER_TYPES: readonly FilterType[] = ['lp12', 'lp24', 'lpm', 'lphp', 'bp', 'hp'];

export interface FilterSpec {
  readonly enabled: boolean;
  readonly type: FilterType;
  /** Cutoff in Hz, capped below Nyquist. */
  readonly freq: number;
  readonly q: number;
  /** LP+HP: the highpass cutoff the res knob sets. */
  readonly hpFreq: number;
  /** off/1/2/3 */
  readonly drive: number;
  /** Keyboard tracking 0, ⅓, ⅔, 1. */
  readonly kbdTrack: number;
}

/** Cutoff from the Stage 4 label (table 587-6), capped at 0.45 × the sample rate. */
export function filterFreqHz(values: ValueReader, layer: SynthLayer, sampleRate: number): number {
  return Math.min(si(values, key(layer, 'synth{L}Sound.fltFreq'), 20000), 0.45 * sampleRate);
}

/** Resonance, unverified: stored step 0..127 → Q 0.5…20, exponential. */
export function resonanceQ(step: number): number {
  return expSweep(step / 127, 0.5, 20);
}

/** LP+HP, unverified: the res knob's step 0..127 → highpass cutoff 20 Hz…20 kHz, exponential. */
export function lphpHighpassHz(step: number, sampleRate: number): number {
  return Math.min(expSweep(step / 127, 20, 20000), 0.45 * sampleRate);
}

export function filterSpec(values: ValueReader, layer: SynthLayer, sampleRate: number): FilterSpec {
  const res = values.get(key(layer, 'synth{L}Sound.fltRes'));
  return {
    enabled: values.get(key(layer, 'synth{L}Sound.fltEnable')) !== 0,
    type: FILTER_TYPES[values.get(key(layer, 'synth{L}Sound.fltType'))] ?? 'lp24',
    freq: filterFreqHz(values, layer, sampleRate),
    q: resonanceQ(res),
    hpFreq: lphpHighpassHz(res, sampleRate),
    drive: clamp(values.get(key(layer, 'synth{L}Sound.fltDrive')), 0, 3),
    kbdTrack: clamp(values.get(key(layer, 'synth{L}Sound.fltKbdTrk')), 0, 3) / 3,
  };
}

/** Keyboard tracking (table 595-4): detune in cents, (note - 60) × 100 × k. */
export function kbdTrackCents(kbdTrack: number, note: number): number {
  return (note - 60) * 100 * kbdTrack;
}

/** Drive, unverified: off/1/2/3 → pre-gain 1/2/4/8 into a tanh shaper. */
export function driveGain(step: number): number {
  return 2 ** clamp(Math.round(step), 0, 3);
}

/** Filter env amount, unverified: 0.0–10.0 → 0…8 octaves, in cents, times the velocity depth. */
export function filterEnvCents(values: ValueReader, layer: SynthLayer, velocity: number): number {
  const oct = clamp(knob(values, key(layer, 'synth{L}Sound.fltEnvAmt')), 0, 10) * 0.8;
  const vel = velocityDepth(values.get(key(layer, 'synth{L}Sound.fltEnvVel')) !== 0, velocity);
  return oct * 1200 * vel;
}

// ---------------------------------------------------------------------------------------------
// LFO and vibrato

export type LfoShape = 'triangle' | 'saw' | 'invsaw' | 'square' | 'sh';
const LFO_SHAPES: readonly LfoShape[] = ['triangle', 'saw', 'invsaw', 'square', 'sh'];
export type LfoTarget = 'none' | 'ctrl' | 'pitch' | 'filter';
const LFO_TARGETS: readonly LfoTarget[] = ['none', 'ctrl', 'pitch', 'filter'];

export interface LfoSpec {
  readonly shape: LfoShape;
  readonly target: LfoTarget;
  readonly rateHz: number;
  /** Depth in the target's unit: cents (pitch, filter) or osc ctrl units. */
  readonly depth: number;
}

/** LFO rate, unverified: stored step 0..127 → 0.03…60 Hz, exponential. */
export function lfoRateHz(step: number): number {
  return expSweep(step / 127, 0.03, 60);
}

/** LFO amount, unverified: step/127 → ±1200 cents (pitch), ±4 octaves (filter), ±the osc ctrl range. */
export function lfoDepth(step: number, target: LfoTarget): number {
  const a = clamp(step, 0, 127) / 127;
  if (target === 'pitch') return a * 1200;
  if (target === 'filter') return a * 4800;
  if (target === 'ctrl') return a;
  return 0;
}

/** The master clock tempo in BPM (common.masterClockRate stores the BPM itself, 30–240; M p.39–40). */
export function clockBpm(values: ValueReader): number {
  return values.get('common.masterClockRate');
}

/**
 * The LFO rate: free (lfoRateHz), or with Mst Clk on one cycle per master clock division (M p.34);
 * the division list and its mapping from the stored step are assumed (model/clock.ts).
 */
export function lfoSpec(values: ValueReader, layer: SynthLayer): LfoSpec {
  const target = LFO_TARGETS[values.get(key(layer, 'synth{L}Sound.lfoDst'))] ?? 'none';
  const step = values.get(key(layer, 'synth{L}Sound.lfoRateClkDiv'));
  const synced = values.get(key(layer, 'synth{L}Sound.lfoClkEnable')) !== 0;
  return {
    shape: LFO_SHAPES[values.get(key(layer, 'synth{L}Sound.lfoWave'))] ?? 'triangle',
    target,
    rateHz: synced ? 1 / divisionSeconds(clockBpm(values), divisionOf(step, LFO_DIVISIONS)) : lfoRateHz(step),
    depth: lfoDepth(values.get(key(layer, 'synth{L}Sound.lfoAmt')), target),
  };
}

/** Whether a layer's LFO follows the master clock (its phase restarts when the clock is reset, M p.37). */
export function lfoSynced(values: ValueReader, layer: SynthLayer): boolean {
  return values.get(key(layer, 'synth{L}Sound.lfoClkEnable')) !== 0;
}

// ---------------------------------------------------------------------------------------------
// Arpeggiator and gate (M p.17, 35–37; audio/arp.ts)

/** Length of an arpeggiated note as a fraction of its step: assumed (the pattern durations are not decoded). */
export const ARP_NOTE_LENGTH = 0.5;

export interface ArpSpec extends ArpSettings {
  /** Arp Run. */
  readonly run: boolean;
  /** KB Sync of the layer (M p.37). */
  readonly kbSync: boolean;
  /** Mst Clk: the rate is a master clock division (M p.36). */
  readonly clockSync: boolean;
  /** Seconds of a free-running step: an eighth note at the rate's BPM (M p.36; the BPM curve is assumed). */
  readonly freeStep: number;
  /** The master clock division of the rate step (assumed list, model/clock.ts). */
  readonly division: ClockDivision;
  /** Gate mode: the Range/Env knob as envelope hardness, 0 soft … 1 hard (M p.35). */
  readonly hardness: number;
}

/**
 * Arpeggio range, unverified: the Range knob (0.0–10.0 on the display, 0–127 stored) spread over
 * 0–4 octaves in steps of a third of an octave (M p.17: "up to 4 octaves in steps of 1/3 of an
 * octave"), as semitones above the highest held note.
 */
export function arpRangeSemitones(step: number): number {
  return 4 * Math.round((clamp(step, 0, 127) * 12) / 127);
}

/** The pattern's step count with Pattern on (arpPtnLen 1–15 shows as 2–16 steps, table 432-7), else null. */
export function arpPatternSteps(values: ValueReader, layer: SynthLayer): number | null {
  if (values.get(key(layer, 'synth{L}.arpPtnEnable')) === 0) return null;
  return values.get(key(layer, 'synth{L}.arpPtnLen')) + 1;
}

export function arpSpec(values: ValueReader, layer: SynthLayer): ArpSpec {
  const range = values.get(key(layer, 'synth{L}.arpRange'));
  const rate = values.get(key(layer, 'synth{L}.arpRateClkDiv'));
  return {
    run: values.get(key(layer, 'synth{L}.arpRun')) !== 0,
    mode: ARP_MODES[values.get(key(layer, 'synth{L}.arpMode'))] ?? 'arp',
    direction: ARP_DIRECTIONS[values.get(key(layer, 'synth{L}.arpDir'))] ?? 'up',
    zigzag: values.get(key(layer, 'synth{L}.arpZigZag')) !== 0,
    rangeSemitones: arpRangeSemitones(range),
    patternSteps: arpPatternSteps(values, layer),
    noteLength: ARP_NOTE_LENGTH,
    kbSync: values.get(key(layer, 'synth{L}.arpKbdSync')) !== 0,
    clockSync: values.get(key(layer, 'synth{L}.arpClkEnable')) !== 0,
    freeStep: arpFreeStepSeconds(rate),
    division: divisionOf(rate, ARP_DIVISIONS),
    hardness: clamp(range, 0, 127) / 127,
  };
}

/** Gate envelope time constant, unverified: soft (0) a fifth of the step, hard (1) about 1 ms. */
export function gateTau(period: number, hardness: number): number {
  return 0.001 + period * 0.2 * (1 - clamp(hardness, 0, 1));
}

// ---------------------------------------------------------------------------------------------
// KB hold (M p.36)

/** Whether KB Hold keeps a layer's notes after key-up: KB Hold on and the layer included. */
export function holdOn(values: ValueReader, layer: SynthLayer): boolean {
  return values.get('synth.kbdHoldEnableCommon') !== 0 && values.get(key(layer, 'synth{L}.kbdHoldEnableLayer')) !== 0;
}

export type VibMode = 'none' | 'on' | 'delay' | 'wheel' | 'pressure' | 'pedal';
const VIB_MODES: readonly VibMode[] = ['none', 'on', 'delay', 'wheel', 'pressure', 'pedal'];

export interface VibSpec {
  readonly mode: VibMode;
  readonly rateHz: number;
  /** Full depth in cents before the mode's scaling. */
  readonly cents: number;
  /** Seconds until full depth in delay mode. */
  readonly delay: number;
}

/** Vibrato: rate from its label (602-6); amount 0.0–10.0 → 0…50 cents (unverified); delay label (453-5). */
export function vibSpec(values: ValueReader, layer: SynthLayer): VibSpec {
  return {
    mode: VIB_MODES[values.get(key(layer, 'synth{L}.vibMode'))] ?? 'none',
    rateHz: si(values, key(layer, 'synth{L}Sound.vibRate'), 5),
    cents: clamp(knob(values, key(layer, 'synth{L}Sound.vibAmt')), 0, 10) * 5,
    delay: si(values, key(layer, 'synth{L}.vibDly'), 0.7),
  };
}

/** The vibrato depth in cents for a mode, given the controllers (0..127). */
export function vibDepthCents(v: VibSpec, ctl: { wheel: number; pressure: number; pedal: number }): number {
  switch (v.mode) {
    case 'none': return 0;
    case 'on':
    case 'delay': return v.cents;
    case 'wheel': return v.cents * clamp(ctl.wheel, 0, 127) / 127;
    case 'pressure': return v.cents * clamp(ctl.pressure, 0, 127) / 127;
    case 'pedal': return v.cents * clamp(ctl.pedal, 0, 127) / 127;
  }
}

// ---------------------------------------------------------------------------------------------
// Coarse markers (plan section 11, decision 2)

/**
 * The layer patterns the native engine only roughly follows right now: drive always; the LP M
 * filter type; Sync and Shape Sine waves (a static cycle per osc ctrl value); and osc ctrl when
 * such a wave is swept by the osc envelope or the LFO, which the static cycle cannot follow.
 */
export function coarsePatterns(values: ValueReader, layer: SynthLayer): Set<string> {
  const out = new Set<string>(['synth{L}Sound.fltDrive']);
  if (values.get(key(layer, 'synth{L}Sound.fltType')) === 2) out.add('synth{L}Sound.fltType');
  const spec = oscSpec(values, layer);
  if ('bank' in spec && spec.bank === 'analog' && (spec.category === 'sync' || spec.category === 'shapeSine')) {
    out.add('synth{L}Sound.oscWave');
    out.add('synth{L}Sound.oscCat');
    const envSweeps = values.get(key(layer, 'synth{L}Sound.oscEnvDst')) === 0
      && values.get(key(layer, 'synth{L}Sound.oscEnvAmt')) !== 0;
    const lfo = lfoSpec(values, layer);
    if (envSweeps || (lfo.target === 'ctrl' && lfo.depth > 0)) out.add('synth{L}Sound.oscCtrl');
  }
  return out;
}

/** Enabled layers that stay silent, with the reason, for the print-out. */
export function silentLayers(values: ValueReader): Array<{ layer: SynthLayer; reason: string }> {
  return enabledLayers(values).flatMap((layer) => {
    const reason = silentReason(values, layer);
    return reason === null ? [] : [{ layer, reason }];
  });
}
