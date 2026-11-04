/**
 * Where every Stage 4 field sits in the editor: regions of the panel (feasibility doc section 4),
 * groups inside them, and HIDDEN for fields that are stored and exported but have no control
 * (reserved bits, scene II copies, morph amounts, opaque hashes and pattern masks). Every layout
 * key belongs to exactly one group or to HIDDEN (sections.test.ts). The program, organ, piano and
 * synth regions play (plan section 13.1; the rotary is a group of the organ region); extern and
 * the layer effects are layout only and show read-only values.
 */
import { expandPattern, isNs4Key, LAYER_TOKEN, layerKey, NS4_KEYS, type Ns4Key, type SynthLayer } from './keys.ts';

/** live: drives the MVP sound with known units; unverified: drives it, units or behaviour guessed;
 * stored: no sound in the MVP, still edited, stored and exported; layout: region not implemented. */
export type ParamStatus = 'live' | 'unverified' | 'stored' | 'layout';
/** 'rotary' is no longer a region of its own (its fields are the organ region's group 'rotary', plan
 * section 13.1); the id stays in the type so code that still names it compiles. */
export type RegionId = 'program' | 'organ' | 'piano' | 'synth' | 'extern' | 'effects' | 'rotary';
export type GroupId =
  | 'split' | 'transpose' | 'clock' | 'scene' | 'presets' | 'aux-kb' | 'output'
  | 'organ' | 'organ-a' | 'organ-b' | 'organ-vibrato' | 'rotary' | 'piano' | 'piano-a' | 'piano-b'
  | 'layers' | 'oscillator' | 'osc-env' | 'filter' | 'amp-env' | 'lfo-vibrato' | 'voice' | 'keyboard' | 'arp'
  | 'extern' | 'fx-global' | 'organ-fx' | 'piano-a-fx' | 'piano-b-fx' | 'synth-fx';

export interface Group {
  readonly id: GroupId;
  readonly title: string;
  /** Keys or layer patterns ('synth{L}Sound.fltFreq'), in panel order. */
  readonly keys: readonly string[];
  readonly status: ParamStatus;
}

export interface Region {
  readonly id: RegionId;
  readonly title: string;
  readonly status: 'live' | 'layout';
  readonly groups: readonly Group[];
}

const ORGAN_LAYER = (x: 'A' | 'B'): string[] => [
  `organ${x}.kbZone`, `organ${x}.octaveShift`, `organ${x}.sustainEnable`, `organ${x}.model`, `organ${x}.presetEnable`,
  ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => `organ${x}Drawbars.org_Preset_kDb${n}`),
  `organ${x}VibPerc.org_Preset_kVibratoEnable`, `organ${x}VibPerc.org_Preset_kB3PercEnable`,
  `organ${x}VibPerc.org_Preset_kB3PercHarmonic`, `organ${x}VibPerc.org_Preset_kB3PercSpeed`,
  `organ${x}VibPerc.org_Preset_kB3PercLevel`];
const PIANO_LAYER = (x: 'A' | 'B'): string[] => ['kbZone', 'octaveShift', 'pStickEnable', 'sustainEnable', 'bank',
  'entry', 'variation', 'nameHash', 'acoustic', 'pedalNoise', 'kbdTouch', 'unison', 'dynComp', 'eq']
  .map((p) => `piano${x}.${p}`);
/** The 32 fields of a layer effects block, without morphs. */
const FX = ['fx1Enable', 'fx1ClkEnable', 'fx1RateClkDiv', 'fx1Amt', 'fx1Type', 'fx2Enable', 'fx2Rate', 'fx2Amt',
  'fx2Type', 'ampEnable', 'ampTypeNew', 'ampDrive', 'ampTreble', 'ampMid', 'ampBass', 'ampMidFreq', 'cmpEnable',
  'cmpAmt', 'cmpResponse', 'dlyEnable', 'dlyClkEnable', 'dlyRateClkDiv', 'dlyMix', 'dlyMode', 'dlyFbkPingPong',
  'dlyFbkFilt', 'dlyFbkAmt', 'dlyFbFxType', 'rvbEnable', 'rvbAmt', 'rvbColor', 'rvbType'];
const EXTERN = ['externEnable', 'externVelCurve', 'externModWheelEnable', 'externAftertouchEnable',
  'externCtrlPedalEnable', 'externSwellPedalEnable', 'externVolPedalEnable', 'externCCNumber1', 'externCCValue1',
  'externCCNumber2', 'externCCValue2', 'externSendOnLoad', 'externBCValue_MSB', 'externBCValue_LSB', 'externPCValue'];

const L = LAYER_TOKEN;
const S = `synth${L}Sound.`;
const Y = `synth${L}.`;

/** The panel, top to bottom; inside the synth region the groups of plan section 3.2, the others per section 13. */
export const PANEL: readonly Region[] = [
  {
    id: 'program', title: 'program', status: 'live', groups: [
      { id: 'scene', title: 'layer scene', status: 'live', keys: ['common.layerScene', 'common.pdlLayerSceneEnable'] },
      {
        id: 'split', title: 'split', status: 'live', keys: ['common.splitEnabled', 'common.splitEnabledLow',
          'common.splitEnabledMid', 'common.splitEnabledHigh', 'common.splitPosLow', 'common.splitPosMid',
          'common.splitPosHigh', 'common.splitWidthLow', 'common.splitWidthMid', 'common.splitWidthHigh'],
      },
      { id: 'transpose', title: 'transpose', status: 'live', keys: ['common.transposeEnable', 'common.transposeValue'] },
      {
        id: 'clock', title: 'master clock', status: 'stored',
        keys: ['common.masterClockRate', 'common.masterClockKbdSync', 'common.pdlTapEnable'],
      },
      {
        id: 'presets', title: 'preset refs', status: 'layout', keys: ['common.orgPresetPos', 'common.pnoPresetPos',
          'common.pnoPresetLayerCntA', 'common.pnoPresetLayerCntB', 'common.synPresetPos',
          'common.synPresetLayerCntA', 'common.synPresetLayerCntB', 'common.synPresetLayerCntC'],
      },
      {
        id: 'aux-kb', title: 'aux kb', status: 'layout', keys: ['common.auxKbdEnable', 'common.auxKbdVelCurve',
          'organ.auxKbdControl', 'piano.auxKbdControl', 'synth.auxKbdControl'],
      },
      {
        id: 'output', title: 'output', status: 'layout', keys: ['common.audioRoutingBusOrg',
          'common.audioRoutingBusLeslie', 'common.audioRoutingBusPnoA', 'common.audioRoutingBusPnoB',
          'common.audioRoutingBusSynA', 'common.audioRoutingBusSynB', 'common.audioRoutingBusSynC'],
      },
    ],
  },
  {
    id: 'organ', title: 'organ', status: 'live', groups: [
      {
        id: 'organ', title: 'organ', status: 'live', keys: ['common.sectionEnableOrg_I', 'organ.layerEnableOrg_I',
          'organ.layerFocusOrg_I', 'organ.layerLevelOrgA', 'organ.layerLevelOrgB', 'organ.orgPStickEnable'],
      },
      { id: 'organ-a', title: 'organ a', status: 'live', keys: ORGAN_LAYER('A') },
      { id: 'organ-b', title: 'organ b', status: 'live', keys: ORGAN_LAYER('B') },
      {
        id: 'organ-vibrato', title: 'vibrato · percussion', status: 'live', keys: ['organ.vibratoTypeB3',
          'organ.vibratoTypeVox', 'organ.vibratoTypeFarfisa', 'organ.polyPercEnable'],
      },
      {
        id: 'rotary', title: 'rotary', status: 'live', keys: ['organ.effectsLeslieEnable', 'organ.effectsLeslieSpeed',
          'organ.effectsLeslieStopMode', 'organ.leslieStopPreset', 'organ.effectsLeslieDrv',
          'organ.leslieMicDistance', 'organ.leslieRotorAngle', 'organ.leslieHornAngle'],
      },
    ],
  },
  {
    id: 'piano', title: 'piano', status: 'live', groups: [
      {
        id: 'piano', title: 'piano', status: 'live', keys: ['common.sectionEnablePno_I', 'piano.layerEnablePno_I',
          'piano.layerFocusPno_I', 'piano.layerLevelPnoA', 'piano.layerLevelPnoB'],
      },
      { id: 'piano-a', title: 'piano a', status: 'live', keys: PIANO_LAYER('A') },
      { id: 'piano-b', title: 'piano b', status: 'live', keys: PIANO_LAYER('B') },
    ],
  },
  {
    id: 'synth', title: 'synth', status: 'live', groups: [
      {
        id: 'layers', title: 'layers', status: 'live', keys: ['common.sectionEnableSyn_I', 'synth.layerEnableSyn_I',
          'synth.layerFocusSyn_I', `synth.layerLevelSyn${L}`, `synth.layerPanSyn${L}`, 'synth.multiLayerFlt',
          'synth.multiLayerArp', 'synth.multiLayerLFO', 'synth.kbdHoldEnableCommon'],
      },
      {
        id: 'oscillator', title: 'oscillator', status: 'live', keys: [`${Y}mode`, `${S}oscBank`, `${S}oscCat`,
          `${S}oscWave`, `${S}oscCtrl`, `${S}oscTuneCoarse`, `${S}oscTuneFine`, `${S}smpDynamic`, `${S}smpTimbre`],
      },
      {
        id: 'filter', title: 'filter', status: 'live', keys: [`${S}fltEnable`, `${S}fltType`, `${S}fltFreq`,
          `${S}fltRes`, `${S}fltKbdTrk`, `${S}fltDrive`, `${S}fltEnvAmt`, `${S}fltEnvAtk`, `${S}fltEnvDcy`,
          `${S}fltEnvRls`, `${S}fltEnvVel`],
      },
      {
        id: 'amp-env', title: 'amp env', status: 'live',
        keys: [`${S}ampEnvAtk`, `${S}ampEnvDcy`, `${S}ampEnvRls`, `${S}ampEnvVel`],
      },
      {
        id: 'lfo-vibrato', title: 'lfo · vibrato', status: 'live', keys: [`${S}lfoWave`, `${S}lfoDst`,
          `${S}lfoRateClkDiv`, `${S}lfoAmt`, `${S}lfoClkEnable`, `${Y}vibMode`, `${S}vibRate`, `${S}vibAmt`,
          `${Y}vibDly`],
      },
      {
        id: 'voice', title: 'voice', status: 'live',
        keys: [`${Y}voiceMode`, `${Y}voicePrio`, `${Y}glideRate`, `${Y}oscUnison`],
      },
      {
        id: 'keyboard', title: 'keyboard', status: 'live', keys: [`${Y}octaveShift`, `${Y}pStickEnable`,
          `${Y}pitchStickRange`, `${Y}sustainEnable`, `${Y}kbZone`, `${Y}kbdHoldEnableLayer`],
      },
      {
        id: 'osc-env', title: 'osc env', status: 'live', keys: [`${S}oscEnvAtk`, `${S}oscEnvDcy`, `${S}oscEnvRls`,
          `${S}oscEnvDst`, `${S}oscEnvAmt`, `${S}oscEnvVel`],
      },
      {
        id: 'arp', title: 'arp', status: 'stored', keys: [`${Y}arpRun`, `${Y}arpMode`, `${Y}arpDir`, `${Y}arpZigZag`,
          `${Y}arpKbdSync`, `${Y}arpRange`, `${Y}arpRateClkDiv`, `${Y}arpClkEnable`, `${Y}arpPtnEnable`,
          `${Y}arpPtnLen`],
      },
    ],
  },
  {
    id: 'extern', title: 'extern', status: 'layout', groups: [
      { id: 'extern', title: 'extern', status: 'layout', keys: EXTERN.map((p) => `${Y}${p}`) },
    ],
  },
  {
    id: 'effects', title: 'layer effects', status: 'layout', groups: [
      {
        id: 'fx-global', title: 'effects', status: 'layout', keys: ['common.fxEnable', 'common.fxSectionFocus',
          'common.effectsDlyGlobal', 'common.effectsCmpGlobal', 'common.effectsRvbGlobal',
          'piano.effectsSectionModePno', 'piano.fxLayerFocusPno', 'synth.effectsSectionModeSyn',
          'synth.fxLayerFocusSyn'],
      },
      { id: 'organ-fx', title: 'organ fx', status: 'layout', keys: FX.map((p) => `organFx.${p}`) },
      { id: 'piano-a-fx', title: 'piano a fx', status: 'layout', keys: FX.map((p) => `pianoAFx.${p}`) },
      { id: 'piano-b-fx', title: 'piano b fx', status: 'layout', keys: FX.map((p) => `pianoBFx.${p}`) },
      { id: 'synth-fx', title: 'synth fx', status: 'layout', keys: FX.map((p) => `synth${L}Fx.${p}`) },
    ],
  },
];

const MORPH_RE = /\.morph(?:Wheel|AfterTouch|CtrlPedal)$/;
const HIDDEN_PATTERNS = [
  'synth.reserved_was_pan_a_morph', 'synth.reserved_was_pan_b_morph', 'synth.reserved_was_pan_c_morph',
  'common.orgPresetNameHash', 'common.pnoPresetNameHashA', 'common.pnoPresetNameHashB',
  'common.synPresetNameHashA', 'common.synPresetNameHashB', 'common.synPresetNameHashC',
  `${Y}libName`, `${Y}smpId`, `${Y}smpNameHash`, `${Y}arpPtnAcc`, `${Y}arpPtnDur`, `${Y}arpPtnPan`];

/** Stored and exported, no control: morph amounts, scene II copies, reserved bits, hashes and pattern masks. */
export const HIDDEN: readonly Ns4Key[] = (() => {
  const named = new Set<string>(HIDDEN_PATTERNS.flatMap(expandPattern));
  return NS4_KEYS.filter((k) => named.has(k) || MORPH_RE.test(k) || k.endsWith('_II'));
})();

const HIDDEN_SET: ReadonlySet<Ns4Key> = new Set(HIDDEN);

export function isHidden(key: Ns4Key): boolean {
  return HIDDEN_SET.has(key);
}

/** The keys of a group: for one layer, or with `layer` null every layer's (layer-free keys once). */
export function keysOf(group: Group, layer: SynthLayer | null): Ns4Key[] {
  return group.keys.flatMap((p) => p.includes(LAYER_TOKEN) && layer !== null ? [layerKey(layer, p)] : expandPattern(p));
}

export interface Placement {
  readonly region: Region;
  readonly group: Group;
}

/** Region and group of every key that has a control or a readout (every key not in HIDDEN). */
export const PLACEMENT: ReadonlyMap<Ns4Key, Placement> = (() => {
  const out = new Map<Ns4Key, Placement>();
  for (const region of PANEL) {
    for (const group of region.groups) {
      for (const key of keysOf(group, null)) {
        if (out.has(key)) throw new Error(`${key} is in two groups`);
        out.set(key, { region, group });
      }
    }
  }
  return out;
})();

/** A morph amount's parent field: 'synthASound.fltFreq.morphWheel' -> 'synthASound.fltFreq'. */
export function morphParent(key: Ns4Key): Ns4Key | null {
  if (!MORPH_RE.test(key)) return null;
  const parent = key.replace(MORPH_RE, '');
  return isNs4Key(parent) ? parent : null;
}

