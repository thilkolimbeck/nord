/**
 * Hand-kept facts the tables do not carry, keyed by layer-free pattern: short labels of the
 * synth controls, their MVP status (plan section 3.2, from the feasibility inventory), the
 * reason a control is unverified or silent, labels the manual gives for fields without a
 * Stage 4 display table, and per-option status. Everything else is derived from the layout
 * and the display tables in descriptors.ts.
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
}

const NO_TABLE = 'no Stage 4 display table: the number is the stored step';
const NO_SOUND = 'not in the MVP sound; stored and exported';
const OFF_1_2_3: readonly EnumOption[] = [
  { value: 0, label: 'off' }, { value: 1, label: '1' }, { value: 2, label: '2' }, { value: 3, label: '3' }];
const LAYER_NAMES: readonly EnumOption[] = [{ value: 0, label: 'A' }, { value: 1, label: 'B' }, { value: 2, label: 'C' }];
/** Layer enable mask bits: bit 0 = layer A, bit 1 = layer B (as the converter writes them), bit 2 = layer C. */
const LAYER_BITS: readonly EnumOption[] = [{ value: 1, label: 'A' }, { value: 2, label: 'B' }, { value: 4, label: 'C' }];
const MASK_NOTE = 'bit order from the converter (bit 0 = A, bit 1 = B, bit 2 = C), unverified on hardware';

export const CURATED: Readonly<Record<string, Curated>> = {
  // Synth section, scene I
  'common.sectionEnableSyn_I': { label: 'synth on', status: 'live' },
  'synth.layerEnableSyn_I': { label: 'layers on', status: 'live', kind: 'mask', options: LAYER_BITS, note: MASK_NOTE },
  'synth.layerEnableSyn_II': { label: 'layers on (scene ii)', kind: 'mask', options: LAYER_BITS, note: MASK_NOTE },
  'synth.layerFocusSyn_I': { label: 'focus', status: 'live', kind: 'enum', options: LAYER_NAMES,
    note: 'manual p.15, 43: the layer the panel edits' },
  'synth.layerFocusSyn_II': { label: 'focus (scene ii)', kind: 'enum', options: LAYER_NAMES },
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
  'synth{L}.kbZone': { label: 'kb zone', status: 'stored', note: 'the layer plays the whole keyboard in the MVP' },
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
