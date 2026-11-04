/**
 * Hand-kept facts the tables do not carry, keyed by layer-free pattern: short labels of the
 * synth, organ, piano and program controls, their status (plan sections 3.2 and 13.2–13.4), the
 * reason a control is unverified or silent, labels the manual gives for fields without a
 * Stage 4 display table, labels that depend on another field (piano timbre and variation by
 * piano type), and per-option status. Everything else is derived from the layout and the display
 * tables in descriptors.ts. "M p.N" is the Stage 4 manual (v1.6X).
 */
import {
  ARP_DIVISIONS, ARP_FREE_OPTIONS, BPM_MAX, BPM_MIN, divisionOptions, LFO_DIVISIONS, RAW_RATE_OPTIONS,
} from './clock.ts';
import type { EnumOption, ParamKind } from './descriptors.ts';
import {
  DELAY_DIVISIONS, DELAY_STEPS, delayFreeSeconds, type FxDivision, fxDivisionOf, FX_UNIT_PARAMS, FX_UNITS, type FxUnit,
  MOD1_DIVISIONS, mod1FreeHz, parseFxKey, ringModHz,
} from './fx.ts';
import type { ParamStatus } from './sections.ts';

export interface Curated {
  readonly label?: string;
  readonly status?: ParamStatus;
  readonly note?: string;
  /** Kind when the tables do not settle it (manual labels, masks, opaque references). */
  readonly kind?: ParamKind;
  /** Labels from the manual for a field without a display table. */
  readonly options?: readonly EnumOption[];
  /** Status and reason of single values of a tabled field, by value. */
  readonly optionStatus?: Readonly<Record<number, { readonly status: ParamStatus; readonly note: string }>>;
  /** Manual labels that depend on another field's value (piano timbre by piano type); `fallback` for other values. */
  readonly optionsBy?: OptionSets;
  /** For a stored field (no sound): the short line under its control; default STORED_LINE. */
  readonly stored?: string;
}

/** The line under a stored control when its entry names none. */
export const STORED_LINE = 'stored setting, no sound';
const PEDAL_LINE = 'pedal assignment, stored';
const SAMPLES_NOTE = 'acts on an own sample in samples mode; an approximation of the option (M p.28)';

/**
 * Option lists chosen by the value of another field ('{L}' in `dep` is the field's own synth layer).
 * With `dep2` and `pick` two fields choose: the set is sets[pick(dep value, dep2 value)] (the Mod 1
 * rate's labels follow both the type and Mst Clk, plan 15.9).
 */
export interface OptionSets {
  readonly dep: string;
  readonly dep2?: string;
  readonly pick?: (dep: number, dep2: number) => number;
  readonly sets: Readonly<Record<number, readonly EnumOption[]>>;
  readonly fallback: readonly EnumOption[];
}

const NO_TABLE = 'no Stage 4 display table: the number is the stored step';
const PATTERN = 'the pattern content (accent, step duration, pan) is not decoded: every step plays, a flat pattern';
const SYNCED = 'with Mst Clk a division of the master clock; the division list and how the stored step maps onto it '
  + 'are assumed';
const OFF_1_2_3: readonly EnumOption[] = [
  { value: 0, label: 'off' }, { value: 1, label: '1' }, { value: 2, label: '2' }, { value: 3, label: '3' }];
const LAYER_NAMES: readonly EnumOption[] = [{ value: 0, label: 'A' }, { value: 1, label: 'B' }, { value: 2, label: 'C' }];
/** Layer enable mask bits: bit 0 = layer A, bit 1 = layer B (as the retired Stage 3 converter wrote them), bit 2 = layer C. */
const LAYER_BITS: readonly EnumOption[] = [{ value: 1, label: 'A' }, { value: 2, label: 'B' }, { value: 4, label: 'C' }];
const MASK_NOTE = 'bit order assumed (bit 0 = A, bit 1 = B, bit 2 = C), unverified on hardware';

const OFF_ON: readonly EnumOption[] = [{ value: 0, label: 'off' }, { value: 1, label: 'on' }];
const AB_NAMES: readonly EnumOption[] = LAYER_NAMES.slice(0, 2);
const AB_BITS: readonly EnumOption[] = LAYER_BITS.slice(0, 2);
const AB_MASK_NOTE = 'bit order assumed (bit 0 = A, bit 1 = B), unverified on hardware';
const FOCUS_NOTE = 'manual p.15, 43: the layer the panel edits';
const ROUTER = 'zones are read at the next note-on';
const APPROX = 'the browser approximates this; no Nord sound';

/** Organ layer fields of one layer (M p.18–21; plan section 13.2). Drawbars: 0–8 as on the panel. */
function organLayer(x: 'A' | 'B'): Record<string, Curated> {
  const drawbar = (n: number): [string, Curated] => [`organ${x}Drawbars.org_Preset_kDb${n}`, {
    label: `drawbar ${n}`, status: 'live', kind: 'continuous', options: DRAWBAR,
    note: 'M p.19–21: 0 silent to 8 full; the footage depends on the model' }];
  const v = `organ${x}VibPerc.org_Preset_k`;
  return {
    [`organ${x}.kbZone`]: { label: 'kb zone', status: 'live', note: `M p.18, 39; ${ROUTER}` },
    [`organ${x}.octaveShift`]: { label: 'octave', status: 'live' },
    [`organ${x}.sustainEnable`]: { label: 'sustain', status: 'live' },
    [`organ${x}.model`]: { label: 'model', status: 'live', note: 'M p.18–21; additive approximation of each model' },
    [`organ${x}.presetEnable`]: { label: 'preset', status: 'stored',
      note: 'off = Drawbar Live (M p.19, 21): drawbar live plays the stage 4\'s physical drawbars; the editor plays the '
        + 'stored ones' },
    ...Object.fromEntries([1, 2, 3, 4, 5, 6, 7, 8, 9].map(drawbar)),
    [`${v}VibratoEnable`]: { label: 'vib/chorus', status: 'live' },
    [`${v}B3PercEnable`]: { label: 'perc', status: 'live', note: 'M p.20: B3 only' },
    [`${v}B3PercHarmonic`]: { label: '3rd', status: 'live', note: 'M p.20: on = 3rd harmonic, off = 2nd' },
    [`${v}B3PercSpeed`]: { label: 'fast', status: 'unverified', note: 'M p.20: decay slow or fast; the decay times are a guess' },
    [`${v}B3PercLevel`]: { label: 'soft', status: 'unverified', note: 'M p.20: volume normal or soft; the levels are a guess' },
  };
}

/** Piano layer fields of one layer (M p.23–26; plan section 13.3). */
function pianoLayer(x: 'A' | 'B'): Record<string, Curated> {
  const p = `piano${x}.`;
  return {
    [`${p}kbZone`]: { label: 'kb zone', status: 'live', note: `M p.23, 39; ${ROUTER}` },
    [`${p}octaveShift`]: { label: 'octave', status: 'live' },
    [`${p}pStickEnable`]: { label: 'pitch stick', status: 'live' },
    [`${p}sustainEnable`]: { label: 'sustain', status: 'live' },
    [`${p}bank`]: { label: 'type', status: 'live', note: 'M p.24: piano type; synthesized approximation, no Nord samples' },
    [`${p}nameHash`]: { label: 'model', status: 'live', kind: 'opaque',
      note: 'M p.24: the model picks the sound family within the type; synthesized approximation, no Nord samples' },
    [`${p}entry`]: { label: 'slot', status: 'stored',
      note: 'the model\'s slot in the stage 4\'s piano memory; set to 0 when the model changes' },
    [`${p}variation`]: { label: 'variation', status: 'unverified', optionsBy: {
      dep: `${p}bank`, sets: { 3: CLAV_PICKUPS }, fallback: VARIATIONS },
    note: 'M p.24: clav pickup model A–D; the field is assumed, no effect for other types' },
    [`${p}acoustic`]: { label: 'acoustics', status: 'unverified', kind: 'mask', options: ACOUSTICS,
      note: 'M p.25: string resonance and soft release; the bits are assumed' },
    [`${p}pedalNoise`]: { label: 'pedal noise', status: 'unverified', note: `M p.25; ${APPROX}` },
    [`${p}kbdTouch`]: { label: 'kb touch', status: 'unverified', note: 'M p.25: the touch curves are a guess' },
    [`${p}dynComp`]: { label: 'dyn comp', status: 'unverified', options: OFF_1_2_3,
      note: 'M p.25 labels off, 1, 2, 3; no display table; the ranges are a guess' },
    [`${p}unison`]: { label: 'unison', status: 'unverified', options: OFF_1_2_3,
      note: 'M p.26 labels off, 1, 2, 3; no display table; the detune is a guess' },
    [`${p}eq`]: { label: 'timbre', status: 'unverified', optionsBy: {
      dep: `${p}bank`, sets: { 2: TIMBRE_ELECTRIC, 3: TIMBRE_CLAV }, fallback: TIMBRE_ACOUSTIC },
    note: 'M p.26 labels per piano type; the value order is a guess' },
  };
}

const DRAWBAR: readonly EnumOption[] = [0, 1, 2, 3, 4, 5, 6, 7, 8].map((v) => ({ value: v, label: String(v) }));
const CLAV_PICKUPS: readonly EnumOption[] = ['A', 'B', 'C', 'D'].map((label, value) => ({ value, label }));
const VARIATIONS: readonly EnumOption[] = ['1', '2', '3', '4'].map((label, value) => ({ value, label }));
/** Acoustics bits (assumed): string res = 1, soft release = 2; the default 1 is string res on. */
const ACOUSTICS: readonly EnumOption[] = [{ value: 1, label: 'string res' }, { value: 2, label: 'soft release' }];
const labels = (names: readonly string[]): EnumOption[] => names.map((label, value) => ({ value, label }));
/** Timbre labels of M p.26, in the order of the manual's lists (guessed value order, plan section 13.3). */
const TIMBRE_ACOUSTIC = labels(['off', 'Soft', 'Mid', 'Bright']);
const TIMBRE_ELECTRIC = labels(['off', 'Soft', 'Mid', 'Bright', 'Dyno 1', 'Dyno 2']);
const TIMBRE_CLAV = labels(['off', 'Soft', 'Treble', 'Soft+Treble', 'Brilliant', 'Soft+Brilliant', 'Treble+Brilliant',
  'Soft+Treble+Brilliant']);
/** Master clock: the stored number is the tempo in BPM (M p.39–40). */
const BPM: readonly EnumOption[] = Array.from({ length: BPM_MAX - BPM_MIN + 1 },
  (_, i) => ({ value: BPM_MIN + i, label: `${BPM_MIN + i} bpm` }));

// ---------------------------------------------------------------------------------------------
// Layer effects (M p.48–53; plan sections 15.1 and 15.10). One entry per field of each block; the
// synth blocks share one pattern ('synth{L}Fx.…'). Every effects sound is a Web Audio
// approximation; the panel marks the controls '≈' (ui/control-model.ts).

const FX_APPROX = 'a Web Audio approximation of the effect, no Nord effect';

/** The effects units' titles, as the region's groups and the report name them (M p.48–53). */
export const FX_UNIT_TITLES: Readonly<Record<FxUnit, string>> = {
  mod1: 'mod 1', mod2: 'mod 2', delay: 'delay', amp: 'amp · eq', comp: 'comp', reverb: 'reverb',
};

/** The unit of an effects block field (morph amounts: their parent's); null for other keys. */
export function fxUnitOf(key: string): FxUnit | null {
  const p = parseFxKey(key);
  if (p === null) return null;
  return FX_UNITS.find((u) => (FX_UNIT_PARAMS[u] as readonly string[]).includes(p.param)) ?? null;
}
const FX_RATE = 'no Stage 4 display table; the rate curve is assumed';
const FREE_DIV = 'the division list and how the stored step maps onto it are assumed (M p.49)';

/** '0.10 Hz', '1.0 Hz', '1.2 kHz': rates of the effects' assumed curves. */
function hzLabel(hz: number): string {
  if (hz >= 1000) return `${(hz / 1000).toFixed(1)} kHz`;
  if (hz >= 100) return `${Math.round(hz)} Hz`;
  if (hz >= 10) return `${hz.toFixed(1)} Hz`;
  return `${hz.toFixed(2)} Hz`;
}

/** '12 ms', '410 ms', '1.20 s': free delay times. */
function secondsLabel(s: number): string {
  return s < 1 ? `${Math.round(s * 1000)} ms` : `${s.toFixed(2)} s`;
}

const steps = (n: number, label: (v: number) => string): EnumOption[] =>
  Array.from({ length: n }, (_, value) => ({ value, label: label(value) }));
const divisionsOver = (n: number, list: readonly FxDivision[]): EnumOption[] =>
  steps(n, (v) => fxDivisionOf(v, n, list).label);

/** Mod 1 rate labels (plan 15.1): free Hz, a master clock division, the ring modulator's pitch, the A-Wah's sensitivity. */
const MOD1_FREE = steps(128, (v) => hzLabel(mod1FreeHz(v)));
const MOD1_SYNCED = divisionsOver(128, MOD1_DIVISIONS);
const MOD1_RM = steps(128, (v) => hzLabel(ringModHz(v)));
const MOD1_SENS = steps(128, (v) => `sens ${((v / 127) * 10).toFixed(1)}`);
const MOD1_POSITION = steps(128, (v) => `pos ${((v / 127) * 10).toFixed(1)}`);
/** Mod 1 types (table 713-1): A-PAN 0/1, TREM 2/3, RM 4/5, A-WAH 6/7, WAH 8/9, PUMP 10/11 (odd = variation or PED). */
function mod1Set(type: number, clock: number): number {
  if (type === 4 || type === 5) return 2;
  if (type === 6 || type === 7) return 3;
  // WAH variation is PED: without a pedal the rate sets the static position (M p.49).
  if (type === 9) return 4;
  return clock !== 0 ? 1 : 0;
}
/** Delay tempo labels: free time, or a master clock division (M p.51). */
const DELAY_FREE = steps(DELAY_STEPS, (v) => secondsLabel(delayFreeSeconds(v)));
const DELAY_SYNCED = divisionsOver(DELAY_STEPS, DELAY_DIVISIONS);
/** Amp/EQ mid gain (±15 dB like bass and treble, assumed); with the LP or HP filter type the filter's resonance. */
const EQ_MID = steps(121, (i) => {
  const db = (i - 60) / 4;
  return `${db > 0 ? '+' : ''}${db.toFixed(1)} dB`;
}).map((o) => ({ ...o, value: o.value - 60 }));
const FILTER_RES = steps(121, (i) => `res ${((i / 120) * 10).toFixed(1)}`).map((o) => ({ ...o, value: o.value - 60 }));

/** The 32 fields of one effects block (`b`: 'organFx', 'pianoAFx', 'pianoBFx' or 'synth{L}Fx'). */
function fxBlock(b: string): Record<string, Curated> {
  const k = (p: string): string => `${b}.${p}`;
  const live = (label: string, note?: string): Curated => ({ label, status: 'live', ...(note === undefined ? {} : { note }) });
  const nv = (label: string, note: string): Curated => ({ label, status: 'unverified', note: `${note}; ${FX_APPROX}` });
  return {
    [k('fx1Enable')]: live('on', 'M p.49: Mod 1 on'),
    [k('fx1Type')]: nv('type', 'M p.49: A-Pan, Trem, RM, A-Wah, Wah, Pump; each type\'s variation (or PED) is a guess'),
    [k('fx1RateClkDiv')]: {
      label: 'rate', status: 'unverified', kind: 'continuous',
      optionsBy: { dep: k('fx1Type'), dep2: k('fx1ClkEnable'), pick: mod1Set,
        sets: { 1: MOD1_SYNCED, 2: MOD1_RM, 3: MOD1_SENS, 4: MOD1_POSITION }, fallback: MOD1_FREE },
      note: `${FX_RATE}: free 0.1–10 Hz; RM the sine's pitch 20 Hz–2 kHz; A-Wah the sensitivity; with Mst Clk ${FREE_DIV}; `
        + FX_APPROX,
    },
    [k('fx1ClkEnable')]: live('mst clk', 'M p.49: the rate becomes a division of the master clock (A-Pan, Trem, Wah, Pump)'),
    [k('fx1Amt')]: nv('amount', 'M p.49: depth or dry/wet; the curve is a guess'),
    [k('fx2Enable')]: live('on', 'M p.50: Mod 2 on'),
    [k('fx2Type')]: nv('type', 'M p.50: Phaser, Flanger, Chorus, Vibe, Ensemble, Spin; the variations are a guess'),
    [k('fx2Rate')]: nv('rate', 'M p.50: 0.05–10 Hz assumed'),
    [k('fx2Amt')]: nv('amount', 'M p.50: depth, feedback or colour per type; the curve is a guess'),
    [k('dlyEnable')]: live('on', 'M p.50: delay on'),
    [k('dlyRateClkDiv')]: {
      label: 'tempo', status: 'unverified', kind: 'continuous',
      optionsBy: { dep: k('dlyClkEnable'), sets: { 1: DELAY_SYNCED }, fallback: DELAY_FREE },
      note: 'no Stage 4 display table: free 10 ms–2.5 s, larger = longer (assumed); with Mst Clk 1/32 to 1/2 with '
        + `triplet, dotted and swing (M p.51), ${FREE_DIV.replace(' (M p.49)', '')}; ${FX_APPROX}`,
    },
    [k('dlyClkEnable')]: live('mst clk', 'M p.51: the delay time becomes a division of the master clock'),
    [k('dlyMix')]: nv('dry/wet', 'M p.50: equal-power mix; the curve is a guess'),
    [k('dlyFbkAmt')]: nv('feedback', 'M p.50: from one repeat to a very long tail; the curve is a guess'),
    [k('dlyMode')]: nv('analog', 'M p.51: tempo changes bend the pitch, soft saturation in the loop'),
    [k('dlyFbkPingPong')]: live('ping pong', 'M p.50: the repeats alternate left and right'),
    [k('dlyFbkFilt')]: nv('filter', 'M p.51: a filter in the feedback loop; the frequencies are a guess'),
    [k('dlyFbFxType')]: nv('loop fx', 'M p.50–51: an effect in the feedback loop; its models are a guess'),
    [k('ampEnable')]: live('on', 'M p.51: amp sim / EQ on'),
    [k('ampTypeNew')]: nv('type', 'M p.51–52: amp models and filters are invented EQ curves; To Rotary sends the layer '
      + 'to the organ\'s rotary'),
    [k('ampDrive')]: nv('drive', 'M p.51: tube-style overdrive; the curve is a guess'),
    [k('ampBass')]: live('bass', 'M p.51: low shelf at 100 Hz'),
    [k('ampMid')]: {
      label: 'mid', status: 'unverified', kind: 'continuous',
      optionsBy: { dep: k('ampTypeNew'), sets: { 8: FILTER_RES, 9: FILTER_RES }, fallback: EQ_MID },
      note: `no Stage 4 display table: ±15 dB assumed like bass and treble; with the LP or HP filter type the filter's `
        + `resonance (M p.52, assumed); ${FX_APPROX}`,
    },
    [k('ampMidFreq')]: live('mid freq', 'M p.51: the mid band\'s frequency; the LP and HP filters\' cutoff (M p.39, 52)'),
    [k('ampTreble')]: live('treble', 'M p.51: high shelf at 4 kHz'),
    [k('cmpEnable')]: live('on', 'M p.52: compressor on'),
    [k('cmpAmt')]: nv('amount', 'M p.52: threshold, ratio and make-up gain together; the curve is a guess'),
    [k('cmpResponse')]: nv('fast', 'M p.52: fast recovers sooner; the times are a guess'),
    [k('rvbEnable')]: live('on', 'M p.52: reverb on'),
    [k('rvbType')]: nv('type', 'M p.52: generated impulse responses, no Nord reverb; the variations are a guess'),
    [k('rvbAmt')]: nv('dry/wet', 'M p.52: fully wet at 10.0; the curve is a guess'),
    [k('rvbColor')]: nv('colour', 'M p.53: dark or bright; the filters are a guess'),
  };
}

const LAYER_FX_NOTE = 'M p.48: the layer whose effects the region edits; no sound';
const GROUP_NOTE = 'M p.48: group = one setting for every layer of the section, edits stay in sync; per layer = each '
  + 'layer its own; 1 = group assumed (the layout default)';
const GLOBAL_NOTE = (unit: string): string => `M p.48, 52: one ${unit} on the sum of every section, with the settings of `
  + 'the block in fx focus; switching it off gives every block those settings';
const GROUP_OPTIONS: readonly EnumOption[] = [{ value: 0, label: 'per layer' }, { value: 1, label: 'group' }];

/** Extern (M p.46–47, 63; plan 15.6): what a synth layer sends over MIDI out in extern mode. */
const EXTERN_SENDS = 'sent over midi out only while you switch extern out on';
const CC_NUMBERS: readonly EnumOption[] = [{ value: 0, label: 'off' },
  ...Array.from({ length: 120 }, (_, i) => ({ value: i + 1, label: `CC ${i}` }))];
const BANK_VALUES: readonly EnumOption[] = [{ value: 0, label: '--' },
  ...Array.from({ length: 128 }, (_, i) => ({ value: i + 1, label: String(i) }))];
const MIDI_VALUES: readonly EnumOption[] = Array.from({ length: 128 }, (_, value) => ({ value, label: String(value) }));

/** Aux keyboard and output routing (M p.43, 58–59; plan 15.8): stored settings, no sound. */
const AUX_NOTE = 'the aux keyboard is a second midi keyboard on its own channel (M p.43, 58); the editor does not map it';
const BUS_NOTE = 'buses route the stage 4\'s physical outputs (M p.59, per program mode); the browser has one stereo '
  + 'output; the value order is assumed from the manual\'s lists';
const AB_CONTROL = labels(['--', 'A-', '-B', 'AB']);
const ABC_CONTROL = labels(['---', 'A--', '-B-', '--C', 'AB-', 'A-C', '-BC', 'ABC']);
const BUSES = ['Main', 'Sub I', 'Sub II', 'Sub III'];
const BUS = labels(BUSES);
const BUS_LESLIE = labels([...BUSES, '← organ', 'Auto']);
const BUS_PREV = labels([...BUSES, '← prev layer']);
const bus = (options: readonly EnumOption[]): Curated => ({ label: 'bus', status: 'stored', kind: 'enum', options, note: BUS_NOTE });

/** The note of every morph amount (plan 15.2): the editor plays them, the scaling is assumed. */
export const MORPH_NOTE = 'signed delta in stored steps, assumed; how the Stage 4 scales it is unverified (M p.38–39)';

export const CURATED: Readonly<Record<string, Curated>> = {
  // Program (M p.15, 38–45; plan section 13.4)
  'common.layerScene': { label: 'scene', status: 'live', note: 'M p.15, 43: which layer scene plays and is edited' },
  'common.pdlLayerSceneEnable': { label: 'scene pedal', status: 'stored', options: OFF_ON, kind: 'bool',
    stored: PEDAL_LINE, note: 'M p.60: a pedal switches the layer scene; the editor has no pedal input' },
  'common.splitEnabled': { label: 'split', status: 'live', note: 'M p.39: off = every layer plays every key' },
  'common.splitEnabledLow': { label: 'low', status: 'live', note: 'M p.39: split point between zones 1 and 2' },
  'common.splitEnabledMid': { label: 'mid', status: 'live', note: 'M p.39: split point between zones 2 and 3' },
  'common.splitEnabledHigh': { label: 'high', status: 'live', note: 'M p.39: split point between zones 3 and 4' },
  'common.splitPosLow': { label: 'low point', status: 'live', note: 'the split note is assumed to belong to the upper zone' },
  'common.splitPosMid': { label: 'mid point', status: 'live', note: 'the split note is assumed to belong to the upper zone' },
  'common.splitPosHigh': { label: 'high point', status: 'live', note: 'the split note is assumed to belong to the upper zone' },
  'common.splitWidthLow': { label: 'low xfade', status: 'unverified', note: 'M p.39: crossfade width; the curve is a guess' },
  'common.splitWidthMid': { label: 'mid xfade', status: 'unverified', note: 'M p.39: crossfade width; the curve is a guess' },
  'common.splitWidthHigh': { label: 'high xfade', status: 'unverified', note: 'M p.39: crossfade width; the curve is a guess' },
  'common.transposeEnable': { label: 'transpose on', status: 'live', note: 'M p.40: affects all layers of the program' },
  'common.transposeValue': { label: 'transpose', status: 'live', note: 'M p.40: affects all layers of the program' },
  'common.masterClockRate': { label: 'master clock', status: 'live', kind: 'continuous', options: BPM,
    note: 'M p.39–40: tempo in BPM; the arpeggiators, synth LFOs and layer effects with Mst Clk follow it' },
  'common.masterClockKbdSync': { label: 'kb sync', status: 'unverified', kind: 'enum',
    options: labels(['off', 'on', 'soft']),
    note: 'M p.40 labels off, on, soft (no display table, value order assumed): the first synth key after all keys were '
      + 'lifted resets the clock, with soft only after more than a quarter note; which keys may reset it follows the '
      + 'layers\' kb sync (M p.37), combined as assumed' },
  'common.pdlTapEnable': { label: 'tap pedal', status: 'stored', options: OFF_ON, kind: 'bool', stored: PEDAL_LINE,
    note: 'M p.40: a pedal taps the tempo; the editor has no pedal input (the tap key next to the master clock taps it)' },

  // Organ section, scene I (M p.18–22, 53)
  'common.sectionEnableOrg_I': { label: 'organ on', status: 'live' },
  'organ.layerEnableOrg_I': { label: 'layers on', status: 'live', kind: 'mask', options: AB_BITS, note: AB_MASK_NOTE },
  'organ.layerFocusOrg_I': { label: 'focus', status: 'live', kind: 'enum', options: AB_NAMES, note: FOCUS_NOTE },
  'organ.layerLevelOrgA': { label: 'level', status: 'live' },
  'organ.layerLevelOrgB': { label: 'level', status: 'live' },
  'organ.orgPStickEnable': { label: 'pitch stick', status: 'live', note: 'M p.18: bends the whole organ' },
  ...organLayer('A'),
  ...organLayer('B'),
  'organ.vibratoTypeB3': { label: 'b3 vib type', status: 'unverified', kind: 'enum',
    options: labels(['V1', 'C1', 'V2', 'C2', 'V3', 'C3']), note: 'M p.19: B3 and B3 Bass scanner; value order assumed' },
  'organ.vibratoTypeVox': { label: 'vox vib type', status: 'unverified', kind: 'enum',
    options: labels(['V1', 'V2', 'V3']), note: 'M p.20; value order assumed; the depths are a guess' },
  'organ.vibratoTypeFarfisa': { label: 'farf vib type', status: 'unverified', kind: 'enum',
    options: labels(['V1', 'V2', 'C2', 'C3']), note: 'M p.21; value order assumed; the depths are a guess' },
  'organ.polyPercEnable': { label: 'poly perc', status: 'live', kind: 'bool', options: OFF_ON,
    note: 'M p.20: percussion on every stroke, not single-triggered; no display table' },
  'organ.effectsLeslieEnable': { label: 'rotary', status: 'live', note: 'M p.53: the organ goes through the rotary speaker' },
  'organ.effectsLeslieSpeed': { label: 'speed', status: 'unverified', note: 'M p.53; the rotor speeds and ramps are a guess' },
  'organ.effectsLeslieStopMode': { label: 'stop', status: 'live', note: 'M p.53: with slow, the rotors stop' },
  'organ.leslieStopPreset': { label: 'stop pos', status: 'stored',
    note: 'M p.53: the rotor angle when the rotary stops; the rotor stop angles are not modelled' },
  'organ.effectsLeslieDrv': { label: 'drive', status: 'unverified', note: 'M p.53; the drive curve is a guess' },
  'organ.leslieMicDistance': { label: 'mic', status: 'unverified', kind: 'bool',
    options: [{ value: 0, label: 'normal' }, { value: 1, label: 'close' }],
    note: 'M p.53: close mic; no display table, 0 normal and 1 close assumed' },
  'organ.leslieRotorAngle': { label: 'rotor angle', status: 'stored',
    note: 'the stored angle of the rotary\'s drum; the rotor stop angles are not modelled' },
  'organ.leslieHornAngle': { label: 'horn angle', status: 'stored',
    note: 'the stored angle of the rotary\'s horn; the rotor stop angles are not modelled' },

  // Piano section, scene I (M p.23–26)
  'common.sectionEnablePno_I': { label: 'piano on', status: 'live' },
  'piano.layerEnablePno_I': { label: 'layers on', status: 'live', kind: 'mask', options: AB_BITS, note: AB_MASK_NOTE },
  'piano.layerFocusPno_I': { label: 'focus', status: 'live', kind: 'enum', options: AB_NAMES, note: FOCUS_NOTE },
  'piano.layerLevelPnoA': { label: 'level', status: 'live' },
  'piano.layerLevelPnoB': { label: 'level', status: 'live' },
  ...pianoLayer('A'),
  ...pianoLayer('B'),

  // Synth section, scene I (scene II copies take their facts from these, descriptors.ts)
  'common.sectionEnableSyn_I': { label: 'synth on', status: 'live' },
  'synth.layerEnableSyn_I': { label: 'layers on', status: 'live', kind: 'mask', options: LAYER_BITS, note: MASK_NOTE },
  'synth.layerFocusSyn_I': { label: 'focus', status: 'live', kind: 'enum', options: LAYER_NAMES, note: FOCUS_NOTE },
  'synth.layerLevelSyn{L}': { label: 'level', status: 'live' },
  'synth.layerPanSyn{L}': { label: 'pan', status: 'unverified', note: `${NO_TABLE}; equal-power pan assumed` },
  'synth.multiLayerFlt': { label: 'filter group', status: 'live', kind: 'bool', options: OFF_ON,
    note: 'M p.32: switching it on gives every synth layer the focused layer\'s filter settings, and edits stay in sync; '
      + 'no display table, 1 = on assumed' },
  'synth.multiLayerArp': { label: 'arp group', status: 'live',
    note: 'M p.35: switching it on gives every synth layer the focused layer\'s arpeggiator settings, and edits stay in '
      + 'sync; grouped arpeggios step together' },
  'synth.multiLayerLFO': { label: 'lfo group', status: 'live', kind: 'bool', options: OFF_ON,
    note: 'M p.34: switching it on gives every synth layer the focused layer\'s LFO settings, edits stay in sync and the '
      + 'LFOs restart in phase; no display table, 1 = on assumed' },
  'synth.kbdHoldEnableCommon': { label: 'kb hold', status: 'unverified',
    note: 'M p.36: notes keep sounding after the keys are lifted; that the next key after all keys were lifted starts a '
      + 'new chord (while keys are down new notes join) is assumed' },

  // Oscillator
  'synth{L}.mode': { label: 'mode', status: 'live', optionStatus: {
    0: { status: 'unverified', note: 'own samples only (imported on this device); nord samples are not available, so a '
      + 'layer without an own sample stays silent' } } },
  'synth{L}Sound.oscBank': { label: 'type', status: 'live', optionStatus: {
    1: { status: 'unverified', note: 'FM approximated; partial and pitch values partly decoded' },
    2: { status: 'unverified', note: 'FM approximated; partial and pitch values partly decoded' },
    3: { status: 'layout', note: 'Nord wavetables are proprietary: not implemented, the layer stays silent' } } },
  'synth{L}Sound.oscCat': { label: 'category', status: 'live' },
  'synth{L}Sound.oscWave': { label: 'wave', status: 'live' },
  'synth{L}Sound.oscCtrl': { label: 'osc ctrl', status: 'unverified',
    note: 'meaning per category from the manual; the curve is a guess' },
  'synth{L}Sound.oscTuneCoarse': { label: 'pitch', status: 'live' },
  'synth{L}Sound.oscTuneFine': { label: 'fine', status: 'live' },
  'synth{L}Sound.smpDynamic': { label: 'sample dyn', status: 'unverified', note: SAMPLES_NOTE },
  'synth{L}Sound.smpTimbre': { label: 'bright', status: 'unverified', note: SAMPLES_NOTE },
  'synth{L}.libName': { kind: 'opaque', note: 'sample library reference' },
  'synth{L}.smpId': { kind: 'opaque', note: 'sample slot reference' },

  // Osc envelope
  'synth{L}Sound.oscEnvAtk': { label: 'attack', status: 'live' },
  'synth{L}Sound.oscEnvDcy': { label: 'decay', status: 'live' },
  'synth{L}Sound.oscEnvRls': { label: 'release', status: 'live' },
  'synth{L}Sound.oscEnvDst': { label: 'to pitch', status: 'live', note: 'off: the envelope modulates osc ctrl; on: pitch' },
  'synth{L}Sound.oscEnvAmt': { label: 'env amt', status: 'unverified',
    note: 'depth in semitones or osc ctrl units is a guess' },
  'synth{L}Sound.oscEnvVel': { label: 'velocity', status: 'unverified', note: 'on/off; the depth curve is a guess' },

  // Filter
  'synth{L}Sound.fltEnable': { label: 'filter on', status: 'live' },
  'synth{L}Sound.fltType': { label: 'type', status: 'live', optionStatus: {
    2: { status: 'unverified', note: 'ladder filter approximated with two biquads and soft clipping' } } },
  'synth{L}Sound.fltFreq': { label: 'freq', status: 'live' },
  'synth{L}Sound.fltRes': { label: 'res', status: 'unverified', note: `${NO_TABLE}; the Q curve is a guess` },
  'synth{L}Sound.fltKbdTrk': { label: 'kbd trk', status: 'live' },
  'synth{L}Sound.fltDrive': { label: 'drive', status: 'unverified', options: OFF_1_2_3,
    note: 'manual p.31–32 labels off, 1, 2, 3; no display table; the drive curve is a guess' },
  'synth{L}Sound.fltEnvAmt': { label: 'env amt', status: 'unverified', note: 'depth in octaves is a guess' },
  'synth{L}Sound.fltEnvAtk': { label: 'attack', status: 'live' },
  'synth{L}Sound.fltEnvDcy': { label: 'decay', status: 'live' },
  'synth{L}Sound.fltEnvRls': { label: 'release', status: 'live' },
  'synth{L}Sound.fltEnvVel': { label: 'velocity', status: 'unverified', note: 'on/off; the depth is a guess' },

  // Amp envelope
  'synth{L}Sound.ampEnvAtk': { label: 'attack', status: 'live' },
  'synth{L}Sound.ampEnvDcy': { label: 'decay', status: 'live' },
  'synth{L}Sound.ampEnvRls': { label: 'release', status: 'live' },
  'synth{L}Sound.ampEnvVel': { label: 'velocity', status: 'unverified', options: OFF_1_2_3,
    note: 'manual p.33–34 labels off and three settings; no display table; the curve is a guess' },

  // LFO and vibrato
  'synth{L}Sound.lfoWave': { label: 'wave', status: 'live' },
  'synth{L}Sound.lfoDst': { label: 'dest', status: 'live' },
  'synth{L}Sound.lfoRateClkDiv': { label: 'rate', status: 'unverified', kind: 'continuous',
    optionsBy: { dep: 'synth{L}Sound.lfoClkEnable', sets: { 1: divisionOptions(LFO_DIVISIONS) }, fallback: RAW_RATE_OPTIONS },
    note: `${NO_TABLE}; free: the Hz curve is a guess; ${SYNCED} (M p.34)` },
  'synth{L}Sound.lfoAmt': { label: 'amount', status: 'unverified', note: `${NO_TABLE}; the depth is a guess` },
  'synth{L}Sound.lfoClkEnable': { label: 'mst clk', status: 'live',
    note: 'M p.34: the LFO rate becomes a division of the master clock tempo' },
  'synth{L}.vibMode': { label: 'vibrato', status: 'live',
    note: 'WHL follows MIDI CC1, A.T. channel pressure, PED CC11 (MIDI input only)' },
  'synth{L}Sound.vibRate': { label: 'vib rate', status: 'live' },
  'synth{L}Sound.vibAmt': { label: 'vib amt', status: 'unverified', note: 'depth in cents is a guess' },
  'synth{L}.vibDly': { label: 'vib delay', status: 'unverified',
    note: 'the table has 0.1–3.0 s; the manual lists only 0.2, 0.7, 1.2 and 2.0 s' },

  // Voice
  'synth{L}.voiceMode': { label: 'voice', status: 'live', kind: 'enum',
    options: [{ value: 0, label: 'poly' }, { value: 1, label: 'mono' }, { value: 2, label: 'legato' }],
    note: 'manual p.35 labels; no display table' },
  'synth{L}.voicePrio': { label: 'priority', status: 'live' },
  'synth{L}.glideRate': { label: 'glide', status: 'unverified', note: 'the table (0.0–10.0) has no time unit' },
  'synth{L}.oscUnison': { label: 'unison', status: 'unverified', options: OFF_1_2_3,
    note: 'manual p.35 labels; no display table; detune and voice count are a guess' },

  // Keyboard
  'synth{L}.octaveShift': { label: 'octave', status: 'live' },
  'synth{L}.pStickEnable': { label: 'pitch stick', status: 'live' },
  'synth{L}.pitchStickRange': { label: 'stick range', status: 'live' },
  'synth{L}.sustainEnable': { label: 'sustain', status: 'live' },
  'synth{L}.kbZone': { label: 'kb zone', status: 'live', note: `M p.39; ${ROUTER}` },
  'synth{L}.kbdHoldEnableLayer': { label: 'kb hold', status: 'live',
    note: 'M p.36: exclude keeps the layer out of KB Hold' },

  // Arpeggiator and gate
  'synth{L}.arpRun': { label: 'run', status: 'live', note: 'M p.35: the arpeggiator or gate runs' },
  'synth{L}.arpMode': { label: 'mode', status: 'live',
    note: 'M p.35: Arp plays the held notes one after the other, Poly plays them together, Gate opens and closes the '
      + 'sound on every step' },
  'synth{L}.arpDir': { label: 'direction', status: 'live', note: 'M p.17, 35; no effect on the gate' },
  'synth{L}.arpZigZag': { label: 'zigzag', status: 'unverified',
    note: 'M p.17, 35: two steps forward, one back; how it turns at the ends is a guess' },
  'synth{L}.arpKbdSync': { label: 'kb sync', status: 'unverified',
    note: 'M p.37: the first key after all keys were lifted restarts the arpeggio or gate; with mst clk it may reset the '
      + 'master clock instead (see the master clock\'s kb sync; the combination is assumed)' },
  'synth{L}.arpRange': { label: 'range', status: 'unverified',
    note: 'M p.17, 35: up to 4 octaves in steps of a third of an octave, the 0.0–10.0 display spread linearly over them '
      + '(assumed); in Gate mode the envelope: soft at 0, hard at 10' },
  'synth{L}.arpRateClkDiv': { label: 'rate', status: 'unverified', kind: 'continuous',
    optionsBy: { dep: 'synth{L}.arpClkEnable', sets: { 1: divisionOptions(ARP_DIVISIONS) }, fallback: ARP_FREE_OPTIONS },
    note: `${NO_TABLE}; free: quarter-note BPM with a step of an eighth note (M p.36), 30–240 BPM spread linearly `
      + `(assumed); ${SYNCED} (M p.36)` },
  'synth{L}.arpClkEnable': { label: 'mst clk', status: 'live',
    note: 'M p.36: the rate becomes a division of the master clock tempo' },
  'synth{L}.arpPtnEnable': { label: 'pattern', status: 'unverified', note: `M p.35–36; ${PATTERN}` },
  'synth{L}.arpPtnLen': { label: 'pattern len', status: 'unverified', note: `M p.36: 2–16 steps; ${PATTERN}` },

  // Aux keyboard and output routing (M p.43, 58–59; plan 15.8): editable, stored and exported, no sound.
  'common.auxKbdEnable': { label: 'aux kb', status: 'stored', kind: 'bool', options: OFF_ON, note: AUX_NOTE },
  'common.auxKbdVelCurve': { label: 'aux vel', status: 'stored', kind: 'enum', options: labels(['soft', 'medium', 'hard']),
    note: `${AUX_NOTE}; velocity curve, value order assumed` },
  'organ.auxKbdControl': { label: 'organ', status: 'stored', kind: 'enum', options: AB_CONTROL,
    note: `${AUX_NOTE}; which organ layers it plays, value order assumed` },
  'piano.auxKbdControl': { label: 'piano', status: 'stored', kind: 'enum', options: AB_CONTROL,
    note: `${AUX_NOTE}; which piano layers it plays, value order assumed` },
  'synth.auxKbdControl': { label: 'synth', status: 'stored', kind: 'enum', options: ABC_CONTROL,
    note: `${AUX_NOTE}; which synth layers it plays, value order assumed` },
  'common.audioRoutingBusOrg': { ...bus(BUS), label: 'organ' },
  'common.audioRoutingBusLeslie': { ...bus(BUS_LESLIE), label: 'rotary' },
  'common.audioRoutingBusPnoA': { ...bus(BUS), label: 'piano a' },
  'common.audioRoutingBusPnoB': { ...bus(BUS_PREV), label: 'piano b' },
  'common.audioRoutingBusSynA': { ...bus(BUS), label: 'synth a' },
  'common.audioRoutingBusSynB': { ...bus(BUS_PREV), label: 'synth b' },
  'common.audioRoutingBusSynC': { ...bus(BUS_PREV), label: 'synth c' },

  // Extern (M p.46–47, 63; plan 15.6)
  'synth{L}.externEnable': { label: 'extern', status: 'live',
    note: `M p.46: the layer plays its extern midi channel and makes no sound here; ${EXTERN_SENDS}` },
  'synth{L}.externVelCurve': { label: 'vel curve', status: 'unverified', kind: 'enum',
    options: labels(['soft', 'mid', 'hard']), note: `M p.63 labels soft, mid, hard; value order and curves assumed; ${EXTERN_SENDS}` },
  'synth{L}.externModWheelEnable': { label: 'wheel', status: 'live', kind: 'bool', options: OFF_ON,
    note: `M p.63: CC1 goes to the extern channel; ${EXTERN_SENDS}` },
  'synth{L}.externAftertouchEnable': { label: 'a.t.', status: 'live', kind: 'bool', options: OFF_ON,
    note: `M p.63: channel pressure goes to the extern channel; ${EXTERN_SENDS}` },
  'synth{L}.externCtrlPedalEnable': { label: 'ctrl ped', status: 'live', kind: 'bool', options: OFF_ON,
    note: `M p.63: CC11 goes to the extern channel; ${EXTERN_SENDS}` },
  'synth{L}.externSwellPedalEnable': { label: 'swell ped', status: 'stored', kind: 'bool', options: OFF_ON,
    stored: 'stored setting, not sent', note: 'the editor has no swell pedal (M p.63)' },
  'synth{L}.externVolPedalEnable': { label: 'vol ped', status: 'stored', kind: 'bool', options: OFF_ON,
    stored: 'stored setting, not sent', note: 'the editor has no volume pedal (M p.63)' },
  'synth{L}.externCCNumber1': { label: 'cc 1', status: 'unverified', kind: 'enum', options: CC_NUMBERS,
    note: `M p.63: which controller the first value goes out on; off and CC 0–119 as stored value − 1, assumed; ${EXTERN_SENDS}` },
  'synth{L}.externCCValue1': { label: 'cc 1 value', status: 'live', kind: 'continuous', options: MIDI_VALUES,
    note: `M p.47, 63: the controller value, morphable; ${EXTERN_SENDS}` },
  'synth{L}.externCCNumber2': { label: 'cc 2', status: 'unverified', kind: 'enum', options: CC_NUMBERS,
    note: `M p.63: which controller the second value goes out on; off and CC 0–119 as stored value − 1, assumed; ${EXTERN_SENDS}` },
  'synth{L}.externCCValue2': { label: 'cc 2 value', status: 'live', kind: 'continuous', options: MIDI_VALUES,
    note: `M p.47, 63: the controller value, morphable; ${EXTERN_SENDS}` },
  'synth{L}.externSendOnLoad': { label: 'send on load', status: 'live', kind: 'bool', options: OFF_ON,
    note: `M p.55, 63: a program load sends bank select, program change, volume and both controllers; ${EXTERN_SENDS}` },
  'synth{L}.externBCValue_MSB': { label: 'bank msb', status: 'unverified', kind: 'continuous', options: BANK_VALUES,
    note: `M p.63: bank select MSB (CC0) before the program change; -- (off) and 0–127 as stored value − 1, assumed; ${EXTERN_SENDS}` },
  'synth{L}.externBCValue_LSB': { label: 'bank lsb', status: 'unverified', kind: 'continuous', options: BANK_VALUES,
    note: `M p.63: bank select LSB (CC32) before the program change; -- (off) and 0–127 as stored value − 1, assumed; ${EXTERN_SENDS}` },
  'synth{L}.externPCValue': { label: 'program', status: 'live', kind: 'continuous', options: MIDI_VALUES,
    note: `M p.63: the program change number; ${EXTERN_SENDS}` },

  // Layer effects (M p.48–53; plan 15.1)
  'common.fxEnable': { label: 'fx on', status: 'live',
    note: 'M p.48: every layer effect and the global units; the rotary is not a layer effect and keeps playing (assumed)' },
  'common.fxSectionFocus': { label: 'fx focus', status: 'unverified', kind: 'enum', options: labels(['organ', 'piano', 'synth']),
    note: 'M p.48: the section whose effects the region edits; value order assumed (panel order); no sound' },
  'piano.fxLayerFocusPno': { label: 'piano fx layer', status: 'live', kind: 'enum', options: AB_NAMES, note: LAYER_FX_NOTE },
  'synth.fxLayerFocusSyn': { label: 'synth fx layer', status: 'live', kind: 'enum', options: LAYER_NAMES, note: LAYER_FX_NOTE },
  'piano.effectsSectionModePno': { label: 'group', status: 'unverified', kind: 'bool', options: GROUP_OPTIONS, note: GROUP_NOTE },
  'synth.effectsSectionModeSyn': { label: 'group', status: 'unverified', kind: 'bool', options: GROUP_OPTIONS, note: GROUP_NOTE },
  'common.effectsDlyGlobal': { label: 'global', status: 'unverified', note: GLOBAL_NOTE('delay') },
  'common.effectsCmpGlobal': { label: 'global', status: 'unverified', note: GLOBAL_NOTE('compressor') },
  'common.effectsRvbGlobal': { label: 'global', status: 'unverified', note: GLOBAL_NOTE('reverb') },
  ...fxBlock('organFx'),
  ...fxBlock('pianoAFx'),
  ...fxBlock('pianoBFx'),
  ...fxBlock('synth{L}Fx'),
};
