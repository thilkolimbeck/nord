/**
 * Layer effects settings (plan section 15.1, manual p.48–53): one block's stored fields → the
 * numbers the effects units play. Pure: no Web Audio. Where the Stage 4 has a display table the
 * value comes from its label (0.0–10.0, dB, Hz); the rate and time curves are the shared guesses of
 * model/fx.ts. Everything here is an approximation; the models are invented, nothing is measured
 * on a Stage 4.
 */
import { descriptorOf, toSi } from '../../model/descriptors.ts';
import {
  DELAY_DIVISIONS, DELAY_STEPS, delayFreeSeconds, type FxBlock, fxDivisionOf, fxDivisionSeconds, fxEnabled,
  fxGlobalOn, fxKey, type FxParam, type FxUnit, MOD1_DIVISIONS, mod1FreeHz, mod2RateHz, ringModHz,
} from '../../model/fx.ts';
import type { ValueReader } from '../../model/labels.ts';
import type { ClockReader } from './types.ts';

// ---------------------------------------------------------------------------------------------
// Helpers

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, Number.isFinite(x) ? x : lo));
}

function raw(values: ValueReader, block: FxBlock, param: FxParam): number {
  const v = values.get(fxKey(block, param));
  return Number.isFinite(v) ? v : 0;
}

/** The value of a field in base units from its Stage 4 label, or `fallback(raw)` without one. */
function si(values: ValueReader, block: FxBlock, param: FxParam, fallback: (raw: number) => number): number {
  const key = fxKey(block, param);
  const v = values.get(key);
  const parsed = toSi(descriptorOf(key), v, values);
  return parsed === null || !Number.isFinite(parsed) ? fallback(v) : parsed;
}

/** A 0.0–10.0 knob (tables 709-2, 717-5, 741-6, …) as 0..1. */
export function knob(values: ValueReader, block: FxBlock, param: FxParam): number {
  return clamp(si(values, block, param, (r) => (r / 127) * 10) / 10, 0, 1);
}

/** The master clock tempo the effects follow: the ClockReader, else common.masterClockRate (30..240 BPM). */
export function tempoOf(values: ValueReader, clock: ClockReader | null): number {
  const bpm = clock === null ? values.get('common.masterClockRate') : clock.bpm();
  return clamp(bpm, 30, 240);
}

/** The Enable field of each unit. */
export const ENABLE_PARAM: Readonly<Record<FxUnit, FxParam>> = {
  mod1: 'fx1Enable', mod2: 'fx2Enable', delay: 'dlyEnable', amp: 'ampEnable', comp: 'cmpEnable', reverb: 'rvbEnable',
};

/** Whether a unit's switch of a block is on (its own Enable only). */
export function unitSwitch(values: ValueReader, block: FxBlock, unit: FxUnit): boolean {
  return raw(values, block, ENABLE_PARAM[unit]) !== 0;
}

/**
 * Whether a block's unit plays in the block's own chain: Layer Effects ON (p.48), the unit's
 * Enable, and not in Global mode (then the one global instance plays it, p.48, 52).
 */
export function unitOn(values: ValueReader, block: FxBlock, unit: FxUnit): boolean {
  return fxEnabled(values) && unitSwitch(values, block, unit) && !fxGlobalOn(values, unit);
}

// ---------------------------------------------------------------------------------------------
// Mod 1 (p.49)

export const MOD1_FAMILIES = ['pan', 'trem', 'rm', 'awah', 'wah', 'pump'] as const;
export type Mod1Family = (typeof MOD1_FAMILIES)[number];

export interface Mod1Settings {
  readonly family: Mod1Family;
  /** The odd type values: the variation, or PED for Wah and Pump (p.49). */
  readonly variation: boolean;
  /** LFO rate in Hz (free, or the Mst Clk division); RM: the sine's pitch; A-Wah: unused. */
  readonly rateHz: number;
  /** The rate knob as 0..1: A-Wah sensitivity, the Wah PED static position (p.49). */
  readonly knob: number;
  /** Depth or dry/wet, 0..1. */
  readonly amount: number;
  /** Mst Clk on for a type that follows it (A-Pan, Trem, Wah, Pump, p.49). */
  readonly synced: boolean;
}

const MOD1_CLOCKED: ReadonlySet<Mod1Family> = new Set(['pan', 'trem', 'wah', 'pump']);

export function mod1Settings(values: ValueReader, block: FxBlock, clock: ClockReader | null): Mod1Settings {
  const type = clamp(Math.round(raw(values, block, 'fx1Type')), 0, 11);
  const family = MOD1_FAMILIES[type >> 1]!;
  const step = raw(values, block, 'fx1RateClkDiv');
  const synced = MOD1_CLOCKED.has(family) && raw(values, block, 'fx1ClkEnable') !== 0;
  const rateHz = family === 'rm' ? ringModHz(step)
    : synced ? 1 / fxDivisionSeconds(tempoOf(values, clock), fxDivisionOf(step, 128, MOD1_DIVISIONS))
      : mod1FreeHz(step);
  return { family, variation: (type & 1) === 1, rateHz, knob: clamp(step / 127, 0, 1),
    amount: knob(values, block, 'fx1Amt'), synced };
}

// ---------------------------------------------------------------------------------------------
// Mod 2 (p.50)

export const MOD2_FAMILIES = ['phaser', 'flanger', 'chorus', 'vibe', 'ensemble', 'spin'] as const;
export type Mod2Family = (typeof MOD2_FAMILIES)[number];

export interface Mod2Settings {
  readonly family: Mod2Family;
  readonly variation: boolean;
  readonly rateHz: number;
  /** Depth, feedback or colour per type, 0..1. */
  readonly amount: number;
}

export function mod2Settings(values: ValueReader, block: FxBlock): Mod2Settings {
  const type = clamp(Math.round(raw(values, block, 'fx2Type')), 0, 11);
  return {
    family: MOD2_FAMILIES[type >> 1]!, variation: (type & 1) === 1,
    rateHz: mod2RateHz(raw(values, block, 'fx2Rate')), amount: knob(values, block, 'fx2Amt'),
  };
}

// ---------------------------------------------------------------------------------------------
// Delay (p.50–51)

export const DELAY_FILTERS = ['none', 'lp', 'hp', 'bp'] as const;
export type DelayFilter = (typeof DELAY_FILTERS)[number];
/** The effects in the delay loop (table 749-8; values 0 and 1 are both "none"). */
export const LOOP_FX = ['none', 'none', 'ensemble', 'vibe', 'chorus', 'flam', 'space'] as const;
export type LoopFx = 'none' | 'ensemble' | 'vibe' | 'chorus' | 'flam' | 'space';
/** The longest repeat the delay lines hold (1/2 at 30 BPM is 4 s; plan 15.1 named 2.6 s). */
export const DELAY_MAX_SECONDS = 4.5;

export interface DelaySettings {
  /** Left and right line times in seconds (equal except for swing divisions). */
  readonly left: number;
  readonly right: number;
  readonly synced: boolean;
  /** Dry/wet 0..1 (equal power). */
  readonly mix: number;
  /** Feedback gain 0..0.95 (p.50: lowest one tap, highest a very long tail). */
  readonly feedback: number;
  readonly analog: boolean;
  readonly pingPong: boolean;
  readonly filter: DelayFilter;
  readonly loopFx: LoopFx;
  readonly loopVariation: boolean;
}

export function delaySettings(values: ValueReader, block: FxBlock, clock: ClockReader | null): DelaySettings {
  const step = raw(values, block, 'dlyRateClkDiv');
  const synced = raw(values, block, 'dlyClkEnable') !== 0;
  let left: number;
  let right: number;
  if (synced) {
    const d = fxDivisionOf(step, DELAY_STEPS, DELAY_DIVISIONS);
    const s = fxDivisionSeconds(tempoOf(values, clock), d);
    // Swing (S): repeats alternate 2/3 and 1/3 of two steps; exact in ping pong (left then right), approximated otherwise.
    left = d.swing ? (4 / 3) * s : s;
    right = d.swing ? (2 / 3) * s : s;
  }
  else left = right = delayFreeSeconds(step);
  const fxType = clamp(Math.round(raw(values, block, 'dlyFbFxType')), 0, 11);
  return {
    left: clamp(left, 0.001, DELAY_MAX_SECONDS), right: clamp(right, 0.001, DELAY_MAX_SECONDS), synced,
    mix: knob(values, block, 'dlyMix'),
    feedback: 0.95 * knob(values, block, 'dlyFbkAmt'),
    analog: raw(values, block, 'dlyMode') !== 0,
    pingPong: raw(values, block, 'dlyFbkPingPong') !== 0,
    filter: DELAY_FILTERS[clamp(Math.round(raw(values, block, 'dlyFbkFilt')), 0, 3)]!,
    loopFx: LOOP_FX[fxType === 0 ? 0 : (fxType >> 1) + 1]!,
    loopVariation: fxType >= 2 && (fxType & 1) === 1,
  };
}

/** Equal-power dry/wet gains for a mix 0..1. */
export function equalPower(mix: number): { readonly dry: number; readonly wet: number } {
  const m = clamp(mix, 0, 1);
  return { dry: Math.cos((m * Math.PI) / 2), wet: Math.sin((m * Math.PI) / 2) };
}

// ---------------------------------------------------------------------------------------------
// Amp sim / EQ (p.51–52)

/** ampTypeNew (table 755-6): off, Twin, JC, Small (each with variation), To Rotary, LP filter, HP filter. */
export type AmpModel = 'off' | 'twin' | 'jc' | 'small' | 'rotary' | 'lp' | 'hp';

export interface AmpSettings {
  readonly model: AmpModel;
  readonly variation: boolean;
  /** Drive label 0.0–10.0. */
  readonly drive: number;
  readonly bassDb: number;
  /** Mid gain ±15 dB (no table: assumed like bass and treble). */
  readonly midDb: number;
  /** Mid frequency, also the LP/HP filters' cutoff (table 724-6, 200 Hz–8 kHz). */
  readonly midHz: number;
  readonly trebleDb: number;
  /** The LP/HP filters' resonance from ampMid: −60..60 → Q 0.7..12 (assumed: the manual's RES knob, p.52). */
  readonly q: number;
}

function ampModelOf(type: number): { model: AmpModel; variation: boolean } {
  const t = clamp(Math.round(type), 0, 9);
  if (t === 0) return { model: 'off', variation: false };
  if (t <= 6) return { model: (['twin', 'jc', 'small'] as const)[(t - 1) >> 1]!, variation: ((t - 1) & 1) === 1 };
  return { model: t === 7 ? 'rotary' : t === 8 ? 'lp' : 'hp', variation: false };
}

export function ampSettings(values: ValueReader, block: FxBlock): AmpSettings {
  const mid = clamp(raw(values, block, 'ampMid'), -60, 60);
  return {
    ...ampModelOf(raw(values, block, 'ampTypeNew')),
    drive: 10 * knob(values, block, 'ampDrive'),
    bassDb: clamp(si(values, block, 'ampBass', (r) => r / 4), -15, 15),
    midDb: mid / 4,
    midHz: clamp(si(values, block, 'ampMidFreq', (r) => 200 * 40 ** (r / 127)), 20, 20000),
    trebleDb: clamp(si(values, block, 'ampTreble', (r) => r / 4), -15, 15),
    q: 0.7 * (12 / 0.7) ** ((mid + 60) / 120),
  };
}

/** Whether a model sends the chain's signal to the rotary instead of the output (p.52–53). */
export function toRotary(values: ValueReader, block: FxBlock): boolean {
  return unitOn(values, block, 'amp') && ampSettings(values, block).model === 'rotary';
}

// ---------------------------------------------------------------------------------------------
// Compressor (p.52)

export interface CompSettings {
  readonly thresholdDb: number;
  readonly ratio: number;
  readonly makeUpDb: number;
  readonly attack: number;
  readonly release: number;
  readonly knee: number;
}

/** Amount label a (0.0–10.0): threshold −4a dB, ratio 1.5 + 0.65a, make-up +0.6a dB; release 250 ms, fast 60 ms. */
export function compSettings(values: ValueReader, block: FxBlock): CompSettings {
  const a = 10 * knob(values, block, 'cmpAmt');
  return {
    thresholdDb: -4 * a, ratio: 1.5 + 0.65 * a, makeUpDb: 0.6 * a, attack: 0.003,
    release: raw(values, block, 'cmpResponse') !== 0 ? 0.06 : 0.25, knee: 6,
  };
}

// ---------------------------------------------------------------------------------------------
// Reverb (p.52–53)

export const REVERB_TYPES = ['spring', 'booth', 'room', 'stage', 'hall', 'cathedral'] as const;
export type ReverbType = (typeof REVERB_TYPES)[number];
export type ReverbColor = 'none' | 'dark' | 'bright';

export interface ReverbSettings {
  readonly type: ReverbType;
  /** Spring: the second spring; Booth, Room: pre-delay; Stage, Hall, Cathedral: chorale (p.52). */
  readonly variation: boolean;
  /** The impulse response's index (rvbType 0..11). */
  readonly ir: number;
  /** Dry/wet 0..1, fully wet at 10.0 (p.52). */
  readonly mix: number;
  readonly color: ReverbColor;
  /** A slowly modulated delay on the wet path (the chorale variations). */
  readonly chorale: boolean;
}

export function reverbSettings(values: ValueReader, block: FxBlock): ReverbSettings {
  const t = clamp(Math.round(raw(values, block, 'rvbType')), 0, 11);
  const type = REVERB_TYPES[t >> 1]!;
  const variation = (t & 1) === 1;
  return {
    type, variation, ir: t, mix: knob(values, block, 'rvbAmt'),
    color: (['none', 'dark', 'bright'] as const)[clamp(Math.round(raw(values, block, 'rvbColor')), 0, 2)]!,
    chorale: variation && (type === 'stage' || type === 'hall' || type === 'cathedral'),
  };
}
