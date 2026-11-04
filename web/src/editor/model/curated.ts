/**
 * Hand-kept facts the tables do not carry, keyed by layer-free pattern: short labels of the
 * synth, organ, piano and program controls, their status (plan sections 3.2 and 13.2–13.4), the
 * reason a control is unverified or silent, labels the manual gives for fields without a
 * Stage 4 display table, labels that depend on another field (piano timbre and variation by
 * piano type), and per-option status. Everything else is derived from the layout and the display
 * tables in descriptors.ts. "M p.N" is the Stage 4 manual (v1.6X).
 */
import type { EnumOption, ParamKind } from './descriptors.ts';
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
}

/** Option lists chosen by the value of another field. */
export interface OptionSets {
  readonly dep: string;
  readonly sets: Readonly<Record<number, readonly EnumOption[]>>;
  readonly fallback: readonly EnumOption[];
}

const NO_TABLE = 'no Stage 4 display table: the number is the stored step';
const NO_SOUND = 'not in the MVP sound; stored and exported';
const OFF_1_2_3: readonly EnumOption[] = [
  { value: 0, label: 'off' }, { value: 1, label: '1' }, { value: 2, label: '2' }, { value: 3, label: '3' }];
const LAYER_NAMES: readonly EnumOption[] = [{ value: 0, label: 'A' }, { value: 1, label: 'B' }, { value: 2, label: 'C' }];
/** Layer enable mask bits: bit 0 = layer A, bit 1 = layer B (as the converter writes them), bit 2 = layer C. */
const LAYER_BITS: readonly EnumOption[] = [{ value: 1, label: 'A' }, { value: 2, label: 'B' }, { value: 4, label: 'C' }];
const MASK_NOTE = 'bit order from the converter (bit 0 = A, bit 1 = B, bit 2 = C), unverified on hardware';

const OFF_ON: readonly EnumOption[] = [{ value: 0, label: 'off' }, { value: 1, label: 'on' }];
const AB_NAMES: readonly EnumOption[] = LAYER_NAMES.slice(0, 2);
const AB_BITS: readonly EnumOption[] = LAYER_BITS.slice(0, 2);
const AB_MASK_NOTE = 'bit order from the converter (bit 0 = A, bit 1 = B), unverified on hardware';
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
      note: 'off = Drawbar Live (M p.19, 21): the Stage 4 plays its physical drawbars; the editor always plays the stored ones' },
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
    [`${p}entry`]: { label: 'slot', status: 'stored', note: 'model slot; set to 1/20 when the model changes' },
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
const BPM: readonly EnumOption[] = Array.from({ length: 211 }, (_, i) => ({ value: 30 + i, label: `${30 + i} bpm` }));

export const CURATED: Readonly<Record<string, Curated>> = {
  // Program (M p.15, 38–45; plan section 13.4)
  'common.layerScene': { label: 'scene', status: 'live', note: 'M p.15, 43: which layer scene plays and is edited' },
  'common.pdlLayerSceneEnable': { label: 'scene pedal', status: 'stored', options: OFF_ON, kind: 'bool',
    note: 'M p.60: a pedal switches the layer scene; no pedal input in the editor' },
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
  'common.masterClockRate': { label: 'master clock', status: 'stored', kind: 'continuous', options: BPM,
    note: 'M p.39–40: tempo in BPM; no arpeggiator, LFO sync or delay in the editor' },
  'common.masterClockKbdSync': { label: 'kb sync', status: 'stored', kind: 'enum',
    options: labels(['off', 'on', 'soft']), note: 'M p.40 labels off, on, soft; no display table' },
  'common.pdlTapEnable': { label: 'tap pedal', status: 'stored', options: OFF_ON, kind: 'bool',
    note: 'M p.40: tap tempo from a pedal; no pedal input in the editor' },

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
    options: labels(['V1', 'C1', 'V2', 'C2', 'V3', 'C3']), note: 'M p.19: B3 and B3 Bass scanner; value order from the converter' },
  'organ.vibratoTypeVox': { label: 'vox vib type', status: 'unverified', kind: 'enum',
    options: labels(['V1', 'V2', 'V3']), note: 'M p.20; value order from the converter; the depths are a guess' },
  'organ.vibratoTypeFarfisa': { label: 'farf vib type', status: 'unverified', kind: 'enum',
    options: labels(['V1', 'V2', 'C2', 'C3']), note: 'M p.21; value order from the converter; the depths are a guess' },
  'organ.polyPercEnable': { label: 'poly perc', status: 'live', kind: 'bool', options: OFF_ON,
    note: 'M p.20: percussion on every stroke, not single-triggered; no display table' },
  'organ.effectsLeslieEnable': { label: 'rotary', status: 'live', note: 'M p.53: the organ goes through the rotary speaker' },
  'organ.effectsLeslieSpeed': { label: 'speed', status: 'unverified', note: 'M p.53; the rotor speeds and ramps are a guess' },
  'organ.effectsLeslieStopMode': { label: 'stop', status: 'live', note: 'M p.53: with slow, the rotors stop' },
  'organ.leslieStopPreset': { label: 'stop pos', status: 'stored', note: 'M p.53: stop angle; not applied in the editor' },
  'organ.effectsLeslieDrv': { label: 'drive', status: 'unverified', note: 'M p.53; the drive curve is a guess' },
  'organ.leslieMicDistance': { label: 'mic', status: 'unverified', kind: 'bool',
    options: [{ value: 0, label: 'normal' }, { value: 1, label: 'close' }],
    note: 'M p.53: close mic; no display table, 0 normal and 1 close assumed' },
  'organ.leslieRotorAngle': { label: 'rotor angle', status: 'stored', note: 'stored rotor angle; not applied in the editor' },
  'organ.leslieHornAngle': { label: 'horn angle', status: 'stored', note: 'stored horn angle; not applied in the editor' },

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
  'synth.multiLayerFlt': { label: 'filter group', status: 'stored', note: NO_SOUND },
  'synth.multiLayerArp': { label: 'arp group', status: 'stored', note: NO_SOUND },
  'synth.multiLayerLFO': { label: 'lfo group', status: 'stored', note: NO_SOUND },
  'synth.kbdHoldEnableCommon': { label: 'kb hold', status: 'stored', note: NO_SOUND },

  // Oscillator
  'synth{L}.mode': { label: 'mode', status: 'live', optionStatus: {
    0: { status: 'layout', note: 'samples mode needs Nord samples: not implemented, the layer stays silent' } } },
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
  'synth{L}Sound.smpDynamic': { label: 'sample dyn', status: 'stored', note: 'sample option; samples are not in the MVP' },
  'synth{L}Sound.smpTimbre': { label: 'bright', status: 'stored', note: 'sample option; samples are not in the MVP' },
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
  'synth{L}Sound.lfoRateClkDiv': { label: 'rate', status: 'unverified', note: `${NO_TABLE}; the Hz curve is a guess` },
  'synth{L}Sound.lfoAmt': { label: 'amount', status: 'unverified', note: `${NO_TABLE}; the depth is a guess` },
  'synth{L}Sound.lfoClkEnable': { label: 'mst clk', status: 'stored', note: 'no master clock in the MVP' },
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
  'synth{L}.kbdHoldEnableLayer': { label: 'kb hold', status: 'stored', note: NO_SOUND },

  // Arpeggiator and gate
  'synth{L}.arpRun': { label: 'run', status: 'stored', note: NO_SOUND },
  'synth{L}.arpMode': { label: 'mode', status: 'stored', note: NO_SOUND },
  'synth{L}.arpDir': { label: 'direction', status: 'stored', note: NO_SOUND },
  'synth{L}.arpZigZag': { label: 'zigzag', status: 'stored', note: NO_SOUND },
  'synth{L}.arpKbdSync': { label: 'kb sync', status: 'stored', note: NO_SOUND },
  'synth{L}.arpRange': { label: 'range', status: 'stored', note: NO_SOUND },
  'synth{L}.arpRateClkDiv': { label: 'rate', status: 'stored', note: `${NO_SOUND}; ${NO_TABLE}` },
  'synth{L}.arpClkEnable': { label: 'mst clk', status: 'stored', note: NO_SOUND },
  'synth{L}.arpPtnEnable': { label: 'pattern', status: 'stored', note: NO_SOUND },
  'synth{L}.arpPtnLen': { label: 'pattern len', status: 'stored', note: NO_SOUND },
};
