/**
 * The Stage 4's MIDI controller list (manual Appendix II, p.68–69) as data, and how a controller
 * value maps onto a field and back (plan section 15.4). Shared by MIDI control in (midi/cc-in.ts)
 * and the output to a Stage 4 (midi/send.ts); pure: no Web MIDI, no DOM.
 *
 * What the manual settles: the CC numbers, and NRPN as CC99 (MSB), CC98 (LSB), CC6 (data MSB,
 * "expected to be 0") and CC38 (the value), a complete package being those four messages (p.68);
 * the Global channel carries them (p.61–62, CTRL send/receive, default off on the instrument).
 * What it does not: the value scaling, the NRPN value tables of enums, and which layer a
 * layer-parametric controller addresses. The editor's assumptions, all unverified (nv):
 *
 * - scaling 'identity': a 0..127 field takes the value as it is;
 * - 'linear': any other range is spread over 0..127 (min at 0, max at 127, rounded);
 * - 'switch': a two-valued field via a plain CC is on from 64 (sent as 0 and 127);
 * - 'index': an NRPN value (and the CCs of focus, layer masks and FX focus) is the stored value;
 * - a layer-parametric controller addresses the focused layer of its section in the active scene
 *   (the Stage 4 sends panel moves for the layer in focus); an effects controller addresses the FX
 *   focus block (model/fx.ts fxFocusBlock); the organ vibrato type follows the focused organ
 *   layer's model.
 */
import { DESCRIPTORS } from '../model/descriptors.ts';
import { type FxBlock, fxFocusBlock, fxKey, type FxParam, FX_BLOCKS, parseFxKey } from '../model/fx.ts';
import { isNs4Key, type Ns4Key } from '../model/keys.ts';
import type { ValueReader } from '../model/labels.ts';
import { focusedLayer, SECTION_LAYERS, type SectionId } from '../model/scene.ts';

export type CcAddress =
  | { readonly kind: 'cc'; readonly cc: number }
  | { readonly kind: 'nrpn'; readonly msb: number; readonly lsb: number };

export type Scaling = 'identity' | 'linear' | 'switch' | 'index';

export type CcTarget =
  /** One fixed field. */
  | { readonly kind: 'key'; readonly key: Ns4Key }
  /** A field of the focused layer of a section: `pattern` with {L} for the layer letter. */
  | { readonly kind: 'layer'; readonly section: SectionId; readonly pattern: string }
  /** A field of the FX focus block. */
  | { readonly kind: 'fx'; readonly param: FxParam }
  /** organ.vibratoTypeB3, …Vox or …Farfisa, by the model of the focused organ layer (pipes: none). */
  | { readonly kind: 'organVibratoType' }
  /** Listed by the manual, not mapped by the editor: why. */
  | { readonly kind: 'none'; readonly why: string };

export interface CcEntry {
  /** The manual's parameter name. */
  readonly name: string;
  readonly address: CcAddress;
  readonly target: CcTarget;
  readonly scaling: Scaling;
  readonly page: 68 | 69;
}

/** The token for the layer letter in a layer target's pattern (as model/keys.ts LAYER_TOKEN). */
export const LAYER = '{L}';

const cc = (n: number): CcAddress => ({ kind: 'cc', cc: n });
const nrpn = (msb: number, lsb: number): CcAddress => ({ kind: 'nrpn', msb, lsb });
const key = (k: Ns4Key): CcTarget => ({ kind: 'key', key: k });
const org = (pattern: string): CcTarget => ({ kind: 'layer', section: 'organ', pattern });
const pno = (pattern: string): CcTarget => ({ kind: 'layer', section: 'piano', pattern });
const syn = (pattern: string): CcTarget => ({ kind: 'layer', section: 'synth', pattern });
const fx = (param: FxParam): CcTarget => ({ kind: 'fx', param });
const none = (why: string): CcTarget => ({ kind: 'none', why });
const e = (name: string, address: CcAddress, target: CcTarget, scaling: Scaling, page: 68 | 69 = 68): CcEntry =>
  ({ name, address, target, scaling, page });

const PERFORMANCE = 'a performance control, not program data';
const DRAWBARS = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) =>
  e(`Organ Drawbar ${n}`, cc(15 + n), org(`organ${LAYER}Drawbars.org_Preset_kDb${n}`), 'linear'));

/** Appendix II, in the manual's order (p.68 columns left to right, then p.69). */
export const APPENDIX_II: readonly CcEntry[] = [
  e('Bank Select MSB', cc(0), none('program selection: the editor loads programs from files, not by number'), 'index'),
  e('Bank Select LSB', cc(32), none('program selection: the editor loads programs from files, not by number'), 'index'),
  e('Volume (Global)', cc(7), none('the master level is not part of a program (p.38)'), 'identity'),
  e('Sustain Pedal', cc(64), none(`${PERFORMANCE}: the sustain pedal (play bus)`), 'switch'),
  e('Sostenuto Pedal', cc(66), none(`${PERFORMANCE}: not modelled`), 'switch'),
  e('Soft Pedal', cc(67), none(`${PERFORMANCE}: not modelled`), 'switch'),
  e('Ctrl Pedal (Expression)', cc(11), none(`${PERFORMANCE}: the control pedal, a morph source (play bus)`), 'identity'),
  e('Layer Scene', cc(8), key('common.layerScene'), 'switch'),
  e('Section FX Focus', cc(31), key('common.fxSectionFocus'), 'index'),
  e('Section Edit', cc(118), none('a panel mode, not program data'), 'switch'),
  e('Organ A Level', cc(13), key('organ.layerLevelOrgA'), 'identity'),
  e('Organ B Level', cc(14), key('organ.layerLevelOrgB'), 'identity'),
  e('Organ Section Enable Scene I', cc(9), key('common.sectionEnableOrg_I'), 'switch'),
  e('Organ Section Enable Scene II', cc(2), key('common.sectionEnableOrg_II'), 'switch'),
  e('Organ Layers Enable Scene I', cc(80), key('organ.layerEnableOrg_I'), 'index'),
  e('Organ Layers Enable Scene II', cc(81), key('organ.layerEnableOrg_II'), 'index'),
  e('Organ Layers Focus Scene I', cc(82), key('organ.layerFocusOrg_I'), 'index'),
  e('Organ Layers Focus Scene II', cc(83), key('organ.layerFocusOrg_II'), 'index'),
  e('Organ Octave Shift', cc(12), org(`organ${LAYER}.octaveShift`), 'linear'),
  e('Organ Model', nrpn(2, 16), org(`organ${LAYER}.model`), 'index'),
  ...DRAWBARS,
  e('Organ Percussion Enable', nrpn(2, 18), org(`organ${LAYER}VibPerc.org_Preset_kB3PercEnable`), 'index'),
  e('Organ Vibrato Type', nrpn(2, 19), { kind: 'organVibratoType' }, 'index'),
  e('Organ Vibrato Enable', nrpn(2, 20), org(`organ${LAYER}VibPerc.org_Preset_kVibratoEnable`), 'index'),
  e('Organ Percussion Harmonic', nrpn(2, 21), org(`organ${LAYER}VibPerc.org_Preset_kB3PercHarmonic`), 'index'),
  e('Organ Percussion Speed', nrpn(2, 22), org(`organ${LAYER}VibPerc.org_Preset_kB3PercSpeed`), 'index'),
  e('Organ Percussion Level', nrpn(2, 23), org(`organ${LAYER}VibPerc.org_Preset_kB3PercLevel`), 'index'),
  e('Piano A Level', cc(34), key('piano.layerLevelPnoA'), 'identity'),
  e('Piano B Level', cc(63), key('piano.layerLevelPnoB'), 'identity'),
  e('Piano Section Enable Scene I', cc(33), key('common.sectionEnablePno_I'), 'switch'),
  e('Piano Section Enable Scene II', cc(3), key('common.sectionEnablePno_II'), 'switch'),
  e('Piano Layers Enable Scene I', cc(72), key('piano.layerEnablePno_I'), 'index'),
  e('Piano Layers Enable Scene II', cc(88), key('piano.layerEnablePno_II'), 'index'),
  e('Piano Layers Focus Scene I', cc(109), key('piano.layerFocusPno_I'), 'index'),
  e('Piano Layers Focus Scene II', cc(112), key('piano.layerFocusPno_II'), 'index'),
  e('Piano Octave Shift', cc(35), pno(`piano${LAYER}.octaveShift`), 'linear'),
  e('Piano Type/Model/Variation (type)', nrpn(2, 32), pno(`piano${LAYER}.bank`), 'index'),
  e('Piano Type/Model/Variation (model)', nrpn(2, 33),
    none('the value encoding of a piano model is not documented (models are 32-bit name hashes)'), 'index'),
  e('Piano Type/Model/Variation (variation)', nrpn(2, 34), pno(`piano${LAYER}.variation`), 'index'),
  e('Piano Unison', nrpn(2, 40), pno(`piano${LAYER}.unison`), 'index'),
  e('Piano Timbre', nrpn(2, 41), pno(`piano${LAYER}.eq`), 'index'),
  e('Piano Dyn Comp', nrpn(2, 42), pno(`piano${LAYER}.dynComp`), 'index'),
  e('Piano KB Touch', nrpn(2, 43), pno(`piano${LAYER}.kbdTouch`), 'index'),
  e('Piano Acoustics', nrpn(2, 44), pno(`piano${LAYER}.acoustic`), 'index'),
  e('Synth A Level', cc(43), key('synth.layerLevelSynA'), 'identity'),
  e('Synth B Level', cc(37), key('synth.layerLevelSynB'), 'identity'),
  e('Synth C Level', cc(39), key('synth.layerLevelSynC'), 'identity'),
  e('Synth A Pan', cc(40), key('synth.layerPanSynA'), 'linear'),
  e('Synth B Pan', cc(41), key('synth.layerPanSynB'), 'linear'),
  e('Synth C Pan', cc(36), key('synth.layerPanSynC'), 'linear'),
  e('Synth Section Enable Scene I', cc(42), key('common.sectionEnableSyn_I'), 'switch'),
  e('Synth Section Enable Scene II', cc(5), key('common.sectionEnableSyn_II'), 'switch'),
  e('Synth Layers Enable Scene I', cc(61), key('synth.layerEnableSyn_I'), 'index'),
  e('Synth Layers Enable Scene II', cc(75), key('synth.layerEnableSyn_II'), 'index'),
  e('Synth Layers Focus Scene I', cc(115), key('synth.layerFocusSyn_I'), 'index'),
  e('Synth Layers Focus Scene II', cc(119), key('synth.layerFocusSyn_II'), 'index'),
  e('Synth Octave Shift', cc(44), syn(`synth${LAYER}.octaveShift`), 'linear'),
  e('Synth Glide Rate', cc(48), syn(`synth${LAYER}.glideRate`), 'identity'),
  e('Synth Voice Mode', nrpn(3, 16), syn(`synth${LAYER}.voiceMode`), 'index'),
  e('Synth Voice Priority', nrpn(3, 17), syn(`synth${LAYER}.voicePrio`), 'index'),
  e('Synth Vibrato Mode', nrpn(3, 19), syn(`synth${LAYER}.vibMode`), 'index'),
  e('Synth Vibrato Dly Time', nrpn(3, 20), syn(`synth${LAYER}.vibDly`), 'index'),
  e('Synth Vibrato Amount', cc(45), syn(`synth${LAYER}Sound.vibAmt`), 'linear'),
  e('Synth Vibrato Rate', cc(46), syn(`synth${LAYER}Sound.vibRate`), 'identity'),
  e('Synth Vibrato Pedal', cc(15), none(`${PERFORMANCE}: the vibrato pedal; PED vibrato follows the control pedal`),
    'identity'),
  e('Synth Osc Envelope Attack', cc(52), syn(`synth${LAYER}Sound.oscEnvAtk`), 'identity'),
  e('Synth Osc Envelope Decay', cc(53), syn(`synth${LAYER}Sound.oscEnvDcy`), 'identity'),
  e('Synth Osc Ctrl', cc(56), syn(`synth${LAYER}Sound.oscCtrl`), 'identity'),
  e('Synth Osc Pitch Course', cc(55), syn(`synth${LAYER}Sound.oscTuneCoarse`), 'linear'),
  e('Synth Osc Pitch Fine', cc(47), syn(`synth${LAYER}Sound.oscTuneFine`), 'linear'),
  e('Synth Osc Envelope Release', cc(57), syn(`synth${LAYER}Sound.oscEnvRls`), 'identity'),
  e('Synth Osc Envelope To Pitch', nrpn(3, 33), syn(`synth${LAYER}Sound.oscEnvDst`), 'index'),
  e('Synth Osc Envelope Velocity', nrpn(3, 32), syn(`synth${LAYER}Sound.oscEnvVel`), 'index'),
  e('Synth Filter Freq', cc(59), syn(`synth${LAYER}Sound.fltFreq`), 'identity'),
  e('Synth Filter Resonance', cc(60), syn(`synth${LAYER}Sound.fltRes`), 'identity'),
  e('Synth Filter Drive', nrpn(3, 49), syn(`synth${LAYER}Sound.fltDrive`), 'index'),
  e('Synth Filter KBD Track', nrpn(3, 50), syn(`synth${LAYER}Sound.fltKbdTrk`), 'index'),
  e('Synth Filter Type', nrpn(3, 51), syn(`synth${LAYER}Sound.fltType`), 'index'),
  e('Synth Filter Group', cc(25), key('synth.multiLayerFlt'), 'switch'),
  e('Synth Filter Envelope Attack', cc(49), syn(`synth${LAYER}Sound.fltEnvAtk`), 'identity'),
  e('Synth Filter Envelope Decay', cc(50), syn(`synth${LAYER}Sound.fltEnvDcy`), 'identity'),
  e('Synth Filter Envelope Release', cc(51), syn(`synth${LAYER}Sound.fltEnvRls`), 'identity'),
  e('Synth Filter Envelope Amount', cc(73), syn(`synth${LAYER}Sound.fltEnvAmt`), 'identity'),
  e('Synth Filter Envelope Velocity', nrpn(3, 64), syn(`synth${LAYER}Sound.fltEnvVel`), 'index'),
  e('Synth Amp Envelope Attack', cc(68), syn(`synth${LAYER}Sound.ampEnvAtk`), 'identity'),
  e('Synth Amp Envelope Decay', cc(69), syn(`synth${LAYER}Sound.ampEnvDcy`), 'identity'),
  e('Synth Amp Envelope Release', cc(71), syn(`synth${LAYER}Sound.ampEnvRls`), 'identity'),
  e('Synth Amp Envelope Velocity', nrpn(3, 56), syn(`synth${LAYER}Sound.ampEnvVel`), 'index'),
  e('Synth Arp/Gate Mode', nrpn(3, 72), syn(`synth${LAYER}.arpMode`), 'index'),
  e('Synth Arp/Gate Rate', cc(74), syn(`synth${LAYER}.arpRateClkDiv`), 'identity'),
  e('Synth Arp/Gate Range', cc(76), syn(`synth${LAYER}.arpRange`), 'identity'),
  e('Synth Arp/Gate Direction', nrpn(3, 74), syn(`synth${LAYER}.arpDir`), 'index'),
  e('Synth Arp/Gate ZigZag', nrpn(3, 75), syn(`synth${LAYER}.arpZigZag`), 'index'),
  e('Synth Arp/Gate Run', cc(77), syn(`synth${LAYER}.arpRun`), 'switch'),
  e('Synth Arp/Gate Pattern On', nrpn(3, 73), syn(`synth${LAYER}.arpPtnEnable`), 'index'),
  e('Synth LFO Rate', cc(79), syn(`synth${LAYER}Sound.lfoRateClkDiv`), 'identity'),
  e('Synth LFO Waveform', nrpn(3, 80), syn(`synth${LAYER}Sound.lfoWave`), 'index'),
  e('Synth LFO Destination', nrpn(3, 81), syn(`synth${LAYER}Sound.lfoDst`), 'index', 69),
  e('Synth LFO Amount', cc(54), syn(`synth${LAYER}Sound.lfoAmt`), 'identity', 69),
  e('Synth Unison', nrpn(3, 18), syn(`synth${LAYER}.oscUnison`), 'index', 69),
  e('Synth Sample Bright', nrpn(3, 8), syn(`synth${LAYER}Sound.smpTimbre`), 'index', 69),
  e('Synth Sample Cat/Sample', nrpn(3, 4),
    none('nord samples are not available, and the value encoding (3:4:x:x) is not documented'), 'index', 69),
  e('Synth Waveform', nrpn(3, 2),
    none('the value encoding of type, category and wave in one number is not documented'), 'index', 69),
  e('Mod 1 Enable', nrpn(2, 64), fx('fx1Enable'), 'index', 69),
  e('Mod 1 Type/Variation', nrpn(2, 65), fx('fx1Type'), 'index', 69),
  e('Mod 1 Amount', cc(85), fx('fx1Amt'), 'identity', 69),
  e('Mod 1 Rate', cc(86), fx('fx1RateClkDiv'), 'identity', 69),
  e('Mod 1 Pump Pedal', cc(87), none(`${PERFORMANCE}: the pump pedal; PED pump follows the control pedal`),
    'switch', 69),
  e('Mod 2 Enable', nrpn(2, 72), fx('fx2Enable'), 'index', 69),
  e('Mod 2 Type/Variation', nrpn(2, 73), fx('fx2Type'), 'index', 69),
  e('Mod 2 Amount', cc(89), fx('fx2Amt'), 'identity', 69),
  e('Mod 2 Rate', cc(90), fx('fx2Rate'), 'identity', 69),
  e('Delay Enable', nrpn(2, 88), fx('dlyEnable'), 'index', 69),
  e('Delay Dry Wet', cc(93), fx('dlyMix'), 'identity', 69),
  e('Delay Tempo', cc(94), fx('dlyRateClkDiv'), 'linear', 69),
  e('Delay Feedback', cc(95), fx('dlyFbkAmt'), 'identity', 69),
  e('Delay Analog', nrpn(2, 89), fx('dlyMode'), 'index', 69),
  e('Delay Ping-pong', nrpn(2, 91), fx('dlyFbkPingPong'), 'index', 69),
  e('Delay Filter Type', nrpn(2, 92), fx('dlyFbkFilt'), 'index', 69),
  e('Delay Global', cc(29), key('common.effectsDlyGlobal'), 'switch', 69),
  e('Amp/EQ Enable', nrpn(2, 80), fx('ampEnable'), 'index', 69),
  e('Amp/EQ Type/Variation', nrpn(2, 81), fx('ampTypeNew'), 'index', 69),
  e('Amp/EQ Drive', cc(101), fx('ampDrive'), 'identity', 69),
  e('Amp/EQ Bass', cc(102), fx('ampBass'), 'linear', 69),
  e('Amp/EQ Mid', cc(103), fx('ampMid'), 'linear', 69),
  e('Amp/EQ Treble', cc(104), fx('ampTreble'), 'linear', 69),
  e('Amp/EQ Mid Frequency', cc(107), fx('ampMidFreq'), 'identity', 69),
  e('Rotary Speed', cc(108), key('organ.effectsLeslieSpeed'), 'switch', 69),
  e('Rotary Drive', cc(110), key('organ.effectsLeslieDrv'), 'identity', 69),
  e('Reverb Enable', nrpn(2, 104), fx('rvbEnable'), 'index', 69),
  e('Reverb Bright', nrpn(2, 106), fx('rvbColor'), 'index', 69),
  e('Reverb Amount', cc(113), fx('rvbAmt'), 'identity', 69),
  e('Reverb Type/Variation', nrpn(2, 105), fx('rvbType'), 'index', 69),
  e('Reverb Global', cc(30), key('common.effectsRvbGlobal'), 'switch', 69),
  e('Compressor Enable', nrpn(2, 96), fx('cmpEnable'), 'index', 69),
  e('Compressor Amount', cc(117), fx('cmpAmt'), 'identity', 69),
  e('Compressor Fast', nrpn(2, 97), fx('cmpResponse'), 'index', 69),
  e('Compressor Global', cc(28), key('common.effectsCmpGlobal'), 'switch', 69),
];

/** The NRPN transport controllers (p.68). */
export const CC_NRPN_MSB = 99;
export const CC_NRPN_LSB = 98;
export const CC_DATA_MSB = 6;
export const CC_DATA_LSB = 38;
/** RPN select (CC101 MSB, CC100 LSB): ends the NRPN selection, so later data entry is not applied to it. */
export const CC_RPN_MSB = 101;
export const CC_RPN_LSB = 100;
/** Controllers the play bus owns (midi/parser.ts): mod wheel, control pedal, sustain, panic; never field edits. */
export const PLAY_BUS_CCS: readonly number[] = [1, 11, 64, 120, 123];

const BY_CC = new Map<number, CcEntry>();
const BY_NRPN = new Map<number, CcEntry>();
for (const entry of APPENDIX_II) {
  const a = entry.address;
  if (a.kind === 'cc') {
    if (BY_CC.has(a.cc)) throw new Error(`CC ${a.cc} twice`);
    BY_CC.set(a.cc, entry);
  } else {
    const id = a.msb * 128 + a.lsb;
    if (BY_NRPN.has(id)) throw new Error(`NRPN ${a.msb}:${a.lsb} twice`);
    BY_NRPN.set(id, entry);
  }
}

/** The entry of a plain controller number, or null. */
export function ccEntry(n: number): CcEntry | null {
  return BY_CC.get(n) ?? null;
}

/** The entry of an NRPN parameter (CC99 value, CC98 value), or null. */
export function nrpnEntry(msb: number, lsb: number): CcEntry | null {
  return BY_NRPN.get(msb * 128 + lsb) ?? null;
}

/** "CC 59" or "NRPN 3:51", as the manual writes them. */
export function addressText(a: CcAddress): string {
  return a.kind === 'cc' ? `CC ${a.cc}` : `NRPN ${a.msb}:${a.lsb}`;
}

/** Organ model values (table 114-2): 0 B3, 1 VOX, 2 FARF, 3 PIPE1, 4 PIPE2, 5 B3 BASS. */
const VIBRATO_TYPE_BY_MODEL: Readonly<Record<number, Ns4Key>> = {
  0: 'organ.vibratoTypeB3', 1: 'organ.vibratoTypeVox', 2: 'organ.vibratoTypeFarfisa', 5: 'organ.vibratoTypeB3',
};

/** Where a controller lands: for a layer target, the layer; for an effects target, the block. */
export interface Addressed {
  readonly layer?: string;
  readonly block?: FxBlock;
}

function patternKey(pattern: string, layer: string): Ns4Key | null {
  const k = pattern.split(LAYER).join(layer);
  return isNs4Key(k) ? k : null;
}

/**
 * The field an entry addresses now: its fixed key; for a layer target the focused layer of the
 * section in the active scene (or `at.layer`); for an effects target the FX focus block (or
 * `at.block`); null for 'none' targets and for the vibrato type of a pipe organ.
 */
export function resolveTarget(entry: CcEntry, values: ValueReader, at: Addressed = {}): Ns4Key | null {
  const t = entry.target;
  switch (t.kind) {
    case 'key':
      return t.key;
    case 'layer':
      return patternKey(t.pattern, at.layer ?? focusedLayer(values, t.section));
    case 'fx':
      return fxKey(at.block ?? fxFocusBlock(values), t.param);
    case 'organVibratoType': {
      const layer = at.layer ?? focusedLayer(values, 'organ');
      const model = patternKey(`organ${LAYER}.model`, layer);
      return model === null ? null : VIBRATO_TYPE_BY_MODEL[values.get(model)] ?? null;
    }
    case 'none':
      return null;
  }
}

function range(k: Ns4Key): { min: number; max: number } {
  const d = DESCRIPTORS.get(k);
  if (d === undefined) throw new Error(`${k} has no descriptor`);
  return { min: d.min, max: d.max };
}

/** A received value (7 bits; an NRPN value may carry CC6 × 128 on top) as the field's value, clamped. */
export function scaleIn(entry: CcEntry, k: Ns4Key, value: number): number {
  const { min, max } = range(k);
  const v = Math.max(0, Math.round(Number.isFinite(value) ? value : 0));
  switch (entry.scaling) {
    case 'identity':
    case 'index':
      return Math.min(max, Math.max(min, v));
    case 'switch':
      return v >= 64 ? Math.min(max, min + 1) : min;
    case 'linear':
      return Math.min(max, Math.max(min, min + Math.round((Math.min(v, 127) * (max - min)) / 127)));
  }
}

/** A field's value as the 7-bit value to send (0..127). */
export function scaleOut(entry: CcEntry, k: Ns4Key, value: number): number {
  const { min, max } = range(k);
  const v = Math.min(max, Math.max(min, Math.round(value)));
  switch (entry.scaling) {
    case 'identity':
    case 'index':
      return Math.min(127, Math.max(0, v));
    case 'switch':
      return v > min ? 127 : 0;
    case 'linear':
      return max === min ? 0 : Math.round(((v - min) * 127) / (max - min));
  }
}

/** The entry that carries a field, with the layer or block the field belongs to; null for fields without one. */
export function entryForKey(k: Ns4Key): { readonly entry: CcEntry; readonly at: Addressed } | null {
  return BY_KEY.get(k) ?? null;
}

const BY_KEY: ReadonlyMap<Ns4Key, { entry: CcEntry; at: Addressed }> = (() => {
  const out = new Map<Ns4Key, { entry: CcEntry; at: Addressed }>();
  const put = (k: Ns4Key | null, entry: CcEntry, at: Addressed): void => {
    if (k === null) return;
    if (out.has(k)) throw new Error(`${k} has two controllers`);
    out.set(k, { entry, at });
  };
  for (const entry of APPENDIX_II) {
    const t = entry.target;
    if (t.kind === 'key') put(t.key, entry, {});
    else if (t.kind === 'layer') for (const layer of SECTION_LAYERS[t.section]) put(patternKey(t.pattern, layer), entry, { layer });
    else if (t.kind === 'fx') for (const block of FX_BLOCKS) put(fxKey(block, t.param), entry, { block });
    else if (t.kind === 'organVibratoType') {
      for (const k of new Set(Object.values(VIBRATO_TYPE_BY_MODEL))) put(k, entry, {});
    }
  }
  return out;
})();

/** The block of an effects key (morph amounts included), for callers that hold a key. */
export function blockOfKey(k: Ns4Key): FxBlock | null {
  return parseFxKey(k)?.block ?? null;
}

/** One channel-voice controller message: [0xB0 | channel, controller, value]. Channel 0..15. */
export function ccMessage(channel: number, controller: number, value: number): number[] {
  return [0xb0 | (channel & 0x0f), controller & 0x7f, Math.min(127, Math.max(0, Math.round(value)))];
}

/** The four messages of a complete NRPN package (p.68): CC99 msb, CC98 lsb, CC6 0, CC38 value. */
export function nrpnMessages(channel: number, msb: number, lsb: number, value: number): number[][] {
  return [ccMessage(channel, CC_NRPN_MSB, msb), ccMessage(channel, CC_NRPN_LSB, lsb), ccMessage(channel, CC_DATA_MSB, 0),
    ccMessage(channel, CC_DATA_LSB, value)];
}

/** The messages that send one entry's value: one CC, or the four NRPN messages. */
export function messagesFor(entry: CcEntry, channel: number, value: number): number[][] {
  const a = entry.address;
  return a.kind === 'cc' ? [ccMessage(channel, a.cc, value)] : nrpnMessages(channel, a.msb, a.lsb, value);
}

/** A complete NRPN: parameter and value (CC6 × 128 + CC38). */
export interface NrpnValue {
  readonly channel: number;
  readonly msb: number;
  readonly lsb: number;
  readonly value: number;
}

/**
 * Assembles NRPNs from the controller stream, per channel: CC99 and CC98 select the parameter,
 * CC6 sets the data MSB (0 when absent), CC38 completes it. The selection stays for further CC38s
 * (running data entry); a new CC99 or CC98 clears the data MSB. An RPN select (CC101 or CC100,
 * e.g. a pitch-bend range from another device) ends the selection: its data entry belongs to the RPN.
 */
export class NrpnDecoder {
  readonly #state = new Map<number, { msb: number | null; lsb: number | null; data: number }>();

  /** Whether a controller belongs to the NRPN transport (the caller then does not treat it as a plain CC). */
  static isTransport(controller: number): boolean {
    return controller === CC_NRPN_MSB || controller === CC_NRPN_LSB || controller === CC_DATA_MSB || controller === CC_DATA_LSB;
  }

  /** Whether a controller selects an RPN: the caller feeds it too (CC101 also stays a plain CC, Amp/EQ Drive). */
  static isRpnSelect(controller: number): boolean {
    return controller === CC_RPN_MSB || controller === CC_RPN_LSB;
  }

  /** Feed one controller message; returns the NRPN it completes, or null. */
  feed(channel: number, controller: number, value: number): NrpnValue | null {
    let s = this.#state.get(channel);
    if (s === undefined) {
      s = { msb: null, lsb: null, data: 0 };
      this.#state.set(channel, s);
    }
    switch (controller) {
      case CC_NRPN_MSB:
        s.msb = value;
        s.data = 0;
        return null;
      case CC_NRPN_LSB:
        s.lsb = value;
        s.data = 0;
        return null;
      case CC_RPN_MSB:
      case CC_RPN_LSB:
        s.msb = null;
        s.lsb = null;
        s.data = 0;
        return null;
      case CC_DATA_MSB:
        s.data = value;
        return null;
      case CC_DATA_LSB:
        if (s.msb === null || s.lsb === null) return null;
        return { channel, msb: s.msb, lsb: s.lsb, value: s.data * 128 + value };
      default:
        return null;
    }
  }

  /** Forget every selection (panic, input disabled). */
  reset(): void {
    this.#state.clear();
  }
}
