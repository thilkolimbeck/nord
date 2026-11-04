/**
 * The layer effects blocks of a Stage 4 program (manual p.48–53, plan section 15.1): six blocks of
 * the same 32 fields, one shared by both organ layers and one per piano and synth layer, plus the
 * section-wide switches (Layer Effects on, FX focus, group mode, global delay, compressor and
 * reverb). Names, keys and the FX focus only: shared by the effects engine (audio/fx), the MIDI
 * controller map (midi/cc-map.ts) and the effects region (ui). Pure: no DOM, no Web Audio.
 *
 * Assumptions, unverified on hardware (plan 15.1): `common.fxSectionFocus` counts organ 0, piano 1,
 * synth 2 (panel order); the piano and synth group switches are 1 = group (one setting for every
 * layer of the section, the layout default) and 0 = per layer (Nord Sound Manager writes 0 for
 * converted Stage 3 programs, whose two panels had their own effects).
 */
import { isNs4Key, type Ns4Key } from './keys.ts';
import type { ValueReader } from './labels.ts';
import { type LayerOf, SECTION_LAYERS, type SectionId } from './scene.ts';

/** The six effects blocks, in panel order. */
export const FX_BLOCKS = ['organFx', 'pianoAFx', 'pianoBFx', 'synthAFx', 'synthBFx', 'synthCFx'] as const;
export type FxBlock = (typeof FX_BLOCKS)[number];

/** The 32 fields of every block (morph amounts aside), grouped by unit in panel order. */
export const FX_UNIT_PARAMS = {
  mod1: ['fx1Enable', 'fx1Type', 'fx1RateClkDiv', 'fx1ClkEnable', 'fx1Amt'],
  mod2: ['fx2Enable', 'fx2Type', 'fx2Rate', 'fx2Amt'],
  delay: ['dlyEnable', 'dlyRateClkDiv', 'dlyClkEnable', 'dlyMix', 'dlyFbkAmt', 'dlyMode', 'dlyFbkPingPong',
    'dlyFbkFilt', 'dlyFbFxType'],
  amp: ['ampEnable', 'ampTypeNew', 'ampDrive', 'ampBass', 'ampMid', 'ampMidFreq', 'ampTreble'],
  comp: ['cmpEnable', 'cmpAmt', 'cmpResponse'],
  reverb: ['rvbEnable', 'rvbType', 'rvbAmt', 'rvbColor'],
} as const;
export type FxUnit = keyof typeof FX_UNIT_PARAMS;
/**
 * The order of the units in every chain (assumed: the order of the manual's chapter, p.48–53;
 * the manual says only that the rotary speaker comes after all of them, p.52–53).
 */
export const FX_UNITS: readonly FxUnit[] = ['mod1', 'mod2', 'delay', 'amp', 'comp', 'reverb'];
export type FxParam = (typeof FX_UNIT_PARAMS)[FxUnit][number];
export const FX_PARAMS: readonly FxParam[] = FX_UNITS.flatMap((u) => FX_UNIT_PARAMS[u]);

/** Layer Effects ON (p.48): every layer effect and the global units, not the rotary. */
export const FX_ENABLE_KEY: Ns4Key = 'common.fxEnable';
/** The units that have a Global mode (Shift+On, p.48): one instance on the sum of every section. */
export const FX_GLOBAL_KEYS: Readonly<Record<'delay' | 'comp' | 'reverb', Ns4Key>> = {
  delay: 'common.effectsDlyGlobal',
  comp: 'common.effectsCmpGlobal',
  reverb: 'common.effectsRvbGlobal',
};
export type GlobalUnit = keyof typeof FX_GLOBAL_KEYS;
/** Group mode of the piano and synth effects (p.48); 1 = group, assumed. The organ has one block anyway. */
export const FX_GROUP_KEYS: Readonly<Record<'piano' | 'synth', Ns4Key>> = {
  piano: 'piano.effectsSectionModePno',
  synth: 'synth.effectsSectionModeSyn',
};
export const FX_GROUP_ON = 1;
/** FX focus (p.48): the section, and per section the layer whose block the effects region edits. */
export const FX_FOCUS_KEYS = {
  section: 'common.fxSectionFocus',
  piano: 'piano.fxLayerFocusPno',
  synth: 'synth.fxLayerFocusSyn',
} as const satisfies Readonly<Record<string, Ns4Key>>;
/** Value order of `common.fxSectionFocus` (assumed: panel order). */
export const FX_SECTION_ORDER: readonly SectionId[] = ['organ', 'piano', 'synth'];

/** Every key of the effects region that is not inside a block. */
export const FX_COMMON_KEYS: readonly Ns4Key[] = [FX_ENABLE_KEY, FX_FOCUS_KEYS.section, ...Object.values(FX_GLOBAL_KEYS),
  FX_GROUP_KEYS.piano, FX_FOCUS_KEYS.piano, FX_GROUP_KEYS.synth, FX_FOCUS_KEYS.synth];

const BLOCK_SET: ReadonlySet<string> = new Set<string>(FX_BLOCKS);
const PARAM_SET: ReadonlySet<string> = new Set<string>(FX_PARAMS);

export function isFxBlock(s: string): s is FxBlock {
  return BLOCK_SET.has(s);
}

export function isFxParam(s: string): s is FxParam {
  return PARAM_SET.has(s);
}

/** The layout key of one field of one block: ('synthBFx', 'dlyMix') → 'synthBFx.dlyMix'. */
export function fxKey(block: FxBlock, param: FxParam): Ns4Key {
  const key = `${block}.${param}`;
  if (!isNs4Key(key)) throw new Error(`${key} is not a Stage 4 field`);
  return key;
}

/** Block and field of a block key (morph amounts included: their parent's field); null for every other key. */
export function parseFxKey(key: string): { readonly block: FxBlock; readonly param: FxParam } | null {
  const dot = key.indexOf('.');
  if (dot < 0) return null;
  const block = key.slice(0, dot);
  const rest = key.slice(dot + 1);
  const param = rest.includes('.') ? rest.slice(0, rest.indexOf('.')) : rest;
  return isFxBlock(block) && isFxParam(param) ? { block, param } : null;
}

/** The block a section's layer plays through: both organ layers share 'organFx'. */
export function fxBlockOf<S extends SectionId>(section: S, layer: LayerOf<S>): FxBlock {
  if (section === 'organ') return 'organFx';
  const block = `${section}${layer}Fx`;
  if (!isFxBlock(block)) throw new Error(`${section} has no layer ${layer}`);
  return block;
}

/** The section of a block. */
export function fxSectionOf(block: FxBlock): SectionId {
  return block.startsWith('organ') ? 'organ' : block.startsWith('piano') ? 'piano' : 'synth';
}

/** The layers that play through a block: A and B for 'organFx', else the block's own layer. */
export function fxLayersOf(block: FxBlock): readonly string[] {
  return block === 'organFx' ? SECTION_LAYERS.organ : [block.charAt(block.length - 3)];
}

/** The blocks of a section, in layer order. */
export function fxBlocksOf(section: SectionId): readonly FxBlock[] {
  return FX_BLOCKS.filter((b) => fxSectionOf(b) === section);
}

/** The block the effects region edits now (FX focus, p.48); an out-of-range focus value counts as the first. */
export function fxFocusBlock(values: ValueReader): FxBlock {
  const section = FX_SECTION_ORDER[values.get(FX_FOCUS_KEYS.section)] ?? 'organ';
  if (section === 'organ') return 'organFx';
  const layers = SECTION_LAYERS[section];
  const layer = layers[values.get(FX_FOCUS_KEYS[section])] ?? layers[0]!;
  return fxBlockOf(section, layer);
}

/** The store entries that put the FX focus on a block (section focus, and the section's layer focus). */
export function fxFocusEntries(block: FxBlock): Array<readonly [Ns4Key, number]> {
  const section = fxSectionOf(block);
  const out: Array<readonly [Ns4Key, number]> = [[FX_FOCUS_KEYS.section, FX_SECTION_ORDER.indexOf(section)]];
  if (section !== 'organ') {
    const layer = block.charAt(block.length - 3) as LayerOf<'piano' | 'synth'>;
    out.push([FX_FOCUS_KEYS[section], (SECTION_LAYERS[section] as readonly string[]).indexOf(layer)]);
  }
  return out;
}

/** Whether a section's effects are in group mode (one setting for every layer, p.48); the organ has one block. */
export function fxGroupOn(values: ValueReader, section: SectionId): boolean {
  return section !== 'organ' && values.get(FX_GROUP_KEYS[section]) === FX_GROUP_ON;
}

/** Whether a unit runs in Global mode (on the sum of every section, p.48, 52). */
export function fxGlobalOn(values: ValueReader, unit: FxUnit): boolean {
  return unit in FX_GLOBAL_KEYS && values.get(FX_GLOBAL_KEYS[unit as GlobalUnit]) !== 0;
}

/** Layer Effects ON (p.48). */
export function fxEnabled(values: ValueReader): boolean {
  return values.get(FX_ENABLE_KEY) !== 0;
}

// ---------------------------------------------------------------------------------------------
// Rates and times (plan 15.1). None has a Stage 4 display table: the curves and division lists are
// assumptions (nv), shared so the effects engine and the panel's labels agree.

/** A master clock division of an effect: its length in quarter notes; swing (S) alternates long and short repeats. */
export interface FxDivision {
  readonly label: string;
  readonly beats: number;
  readonly swing: boolean;
}

function fxDivision(label: string): FxDivision {
  const m = /^(\d+)\/(\d+)([TDS]?)$/.exec(label);
  if (m === null) throw new Error(`bad division ${label}`);
  const whole = (Number(m[1]) / Number(m[2])) * 4;
  const kind = m[3];
  return { label, beats: whole * (kind === 'T' ? 2 / 3 : kind === 'D' ? 1.5 : 1), swing: kind === 'S' };
}

/** Mod 1 with Mst Clk (p.49): the LFO's division list, slow to fast as the rate step grows (assumed). */
export const MOD1_DIVISIONS: readonly FxDivision[] =
  ['8/1', '4/1', '2/1', '1/1', '1/2', '1/2T', '1/4', '1/4T', '1/8', '1/8T', '1/16', '1/16T', '1/32'].map(fxDivision);

/**
 * Delay with Mst Clk (p.51: "1/2 to 1/32 notes … swing (S), triplet (T) and dotted (D)"), short to
 * long as the 14-bit tempo step grows (assumed; the default step 11008 lands on 1/8D).
 */
export const DELAY_DIVISIONS: readonly FxDivision[] = ['1/32', '1/16T', '1/16', '1/16S', '1/8T', '1/16D', '1/8', '1/8S',
  '1/4T', '1/8D', '1/4', '1/2T', '1/4D', '1/2'].map(fxDivision);

/** The stored steps of dlyRateClkDiv (14 bits). */
export const DELAY_STEPS = 16384;

function stepOf(step: number, steps: number): number {
  return Math.min(steps - 1, Math.max(0, Math.round(Number.isFinite(step) ? step : 0)));
}

/** The division a stored step selects: the range split evenly over the list (as model/clock.ts divisionOf). */
export function fxDivisionOf(step: number, steps: number, list: readonly FxDivision[]): FxDivision {
  return list[Math.min(list.length - 1, Math.floor((stepOf(step, steps) * list.length) / steps))]!;
}

/** Free delay time: 10 ms at step 0 to 2.5 s at 16383, exponential (default 11008 ≈ 0.41 s). */
export function delayFreeSeconds(step: number): number {
  return 0.01 * 250 ** (stepOf(step, DELAY_STEPS) / (DELAY_STEPS - 1));
}

/** Free Mod 1 rate (fx1RateClkDiv): 0.1 Hz at step 0 to 10 Hz at 127, exponential (default 64 ≈ 1 Hz). */
export function mod1FreeHz(step: number): number {
  return 0.1 * 100 ** (stepOf(step, 128) / 127);
}

/** Ring modulation's sine (Mod 1 RM, p.49: "The pitch of the sine wave is set with the Rate knob"): 20 Hz to 2 kHz. */
export function ringModHz(step: number): number {
  return 20 * 100 ** (stepOf(step, 128) / 127);
}

/** Mod 2 rate (fx2Rate, label 0.0–10.0): 0.05 Hz to 10 Hz, exponential (default 5.0 ≈ 0.7 Hz). */
export function mod2RateHz(step: number): number {
  return 0.05 * 200 ** (stepOf(step, 128) / 127);
}

/** Seconds of one division at a tempo (30–240 BPM). */
export function fxDivisionSeconds(bpm: number, d: FxDivision): number {
  return (60 / Math.min(240, Math.max(30, bpm))) * d.beats;
}
