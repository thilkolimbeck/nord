/**
 * Which part of the organ each organ and rotary field drives, and when a change is heard (plan
 * sections 13.1 and 13.2):
 *
 * - live: the layer or the sounding voices follow at once (10 ms smoothing; Vox and Farf waves
 *   are rebuilt once per store batch);
 * - next-note: read when the next note starts (a sounding voice keeps its model and pitch);
 * - none: the field changes no sound (the panel's layer focus).
 *
 * Router-owned fields (section and layer switches, keyboard zones) only matter at the next
 * note-on, which the router decides; their effect here does nothing. Stored fields (Drawbar Live,
 * the rotary stop preset and angles) have no binding. Every live and unverified field of the organ
 * region, rotary group included, has a binding (organ-bindings.test.ts); engine.ts has a handler
 * for every effect, which the type checker enforces through a Record over OrganEffect.
 */
import { DESCRIPTORS } from '../../model/descriptors.ts';
import { isNs4Key, type Ns4Key } from '../../model/keys.ts';
import { parseSceneKey, sceneTwin } from '../../model/scene.ts';
import type { OrganLayer } from '../section.ts';

export type OrganEffect =
  | 'router' | 'focus' | 'level' | 'bend' | 'voicing' | 'model' | 'drawbars' | 'vibrato' | 'vibratoType'
  | 'percussion' | 'rotary' | 'rotarySpeed' | 'rotaryDrive' | 'rotaryMic';

export type OrganApply = 'live' | 'next-note' | 'none';

export interface OrganBinding {
  readonly effect: OrganEffect;
  readonly apply: OrganApply;
  /** What sounds: the organ section, one layer's shared nodes, or each voice of the layer. */
  readonly scope: 'section' | 'layer' | 'voice';
  /** The audio parameter(s) it ends up on, for the reader. */
  readonly target: string;
}

/** The stand-in for the organ layer letter in a pattern: 'organ{X}.model'. */
export const ORGAN_LAYER_TOKEN = '{X}';
const X = ORGAN_LAYER_TOKEN;

const b = (effect: OrganEffect, apply: OrganApply, scope: OrganBinding['scope'], target: string): OrganBinding =>
  ({ effect, apply, scope, target });
const ROUTER = b('router', 'next-note', 'section', 'none here: the router picks layers and zones at the next note-on');
const DRAWBAR = b('drawbars', 'live', 'layer',
  'drawbar bus GainNode.gain (B3, B3 Bass, Pipe); Vox and Farf PeriodicWave of each voice; Vox soft/bright mix');

export const ORGAN_BINDINGS: Readonly<Record<string, OrganBinding>> = {
  // Section and layers (router-owned, plan 13.1)
  'common.sectionEnableOrg_I': ROUTER,
  'organ.layerEnableOrg_I': ROUTER,
  [`organ${X}.kbZone`]: ROUTER,
  'organ.layerFocusOrg_I': b('focus', 'none', 'section', 'none: selects the layer the panel edits'),
  [`organ.layerLevelOrg${X}`]: b('level', 'live', 'layer', 'layer level GainNode.gain'),
  'organ.orgPStickEnable': b('bend', 'live', 'section', 'bend ConstantSourceNode.offset → every organ detune'),

  // Layer keyboard and model
  [`organ${X}.octaveShift`]: b('voicing', 'next-note', 'voice', 'pitch of the next note'),
  [`organ${X}.sustainEnable`]: b('voicing', 'next-note', 'voice', 'whether the next note follows the sustain pedal'),
  [`organ${X}.model`]: b('model', 'next-note', 'voice',
    'generator of the next note; the layer scanner and the 1′ percussion mute follow at once'),

  // Drawbars
  ...Object.fromEntries([1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => [`organ${X}Drawbars.org_Preset_kDb${n}`, DRAWBAR])),

  // Vibrato / chorus and percussion
  [`organ${X}VibPerc.org_Preset_kVibratoEnable`]: b('vibrato', 'live', 'layer',
    'scanner DelayNode depth and dry/wet GainNodes (Pipe: detune of the next note)'),
  'organ.vibratoTypeB3': b('vibratoType', 'live', 'section', 'scanner rate, depth and dry/wet of B3 and B3 Bass layers'),
  'organ.vibratoTypeVox': b('vibratoType', 'live', 'section', 'scanner rate and depth of Vox layers'),
  'organ.vibratoTypeFarfisa': b('vibratoType', 'live', 'section', 'scanner rate, depth and dry/wet of Farf layers'),
  [`organ${X}VibPerc.org_Preset_kB3PercEnable`]: b('percussion', 'next-note', 'voice',
    'percussion contact of the next note; the 1′ drawbar bus mute follows at once'),
  [`organ${X}VibPerc.org_Preset_kB3PercHarmonic`]: b('percussion', 'next-note', 'voice', 'percussion wheel of the next note'),
  [`organ${X}VibPerc.org_Preset_kB3PercSpeed`]: b('percussion', 'next-note', 'voice', 'percussion decay of the next note'),
  [`organ${X}VibPerc.org_Preset_kB3PercLevel`]: b('percussion', 'next-note', 'voice', 'percussion peak of the next note'),
  'organ.polyPercEnable': b('percussion', 'next-note', 'section', 'single or poly triggering of the next note'),

  // Rotary speaker (M p.53)
  'organ.effectsLeslieEnable': b('rotary', 'live', 'section', 'rotary send and direct GainNode.gain'),
  'organ.effectsLeslieSpeed': b('rotarySpeed', 'live', 'section', 'rotor OscillatorNode.frequency ramps'),
  'organ.effectsLeslieStopMode': b('rotarySpeed', 'live', 'section', 'rotor OscillatorNode.frequency ramps'),
  'organ.effectsLeslieDrv': b('rotaryDrive', 'live', 'section', 'drive pre/post GainNode.gain and WaveShaperNode curve'),
  'organ.leslieMicDistance': b('rotaryMic', 'live', 'section', 'rotor delay deviation and AM depth GainNodes'),
};

// Organ layer keys: organA., organADrawbars., organAVibPerc. and organ.layerLevelOrgA (morphs excluded).
const LAYER_RE = /^organ([AB])((?:Drawbars|VibPerc)?\.)|^(organ\.layerLevelOrg)([AB])$/;

/** The organ layer of a key, or null for section-wide and foreign keys. */
export function organLayerOf(key: string): OrganLayer | null {
  const m = LAYER_RE.exec(key);
  return m === null ? null : (m[1] ?? m[4]) as OrganLayer;
}

/** The layer-free pattern of a key: 'organBDrawbars.org_Preset_kDb3' → 'organ{X}Drawbars.org_Preset_kDb3'. */
export function organPatternOf(key: string): string {
  const m = LAYER_RE.exec(key);
  if (m === null) return key;
  return m[1] !== undefined ? `organ${X}${m[2]!}${key.slice(m[0].length)}` : `${m[3]!}${X}`;
}

/** The keys a pattern names: one per organ layer with the token, else the pattern itself. */
export function expandOrganPattern(pattern: string): Ns4Key[] {
  const keys = pattern.includes(X) ? (['A', 'B'] as const).map((l) => pattern.split(X).join(l)) : [pattern];
  return keys.map((k) => {
    if (!isNs4Key(k)) throw new Error(`${k} is not a Stage 4 field`);
    return k;
  });
}

/** The binding of a field, or null for fields the organ does not play. Scene II keys resolve to their scene I twin. */
export function organBindingOf(key: Ns4Key): OrganBinding | null {
  const scene = parseSceneKey(key);
  const k = scene !== null && scene.scene === 'II' ? sceneTwin(key) ?? key : key;
  const pattern = organPatternOf(k);
  return Object.hasOwn(ORGAN_BINDINGS, pattern) ? ORGAN_BINDINGS[pattern]! : null;
}

/** The organ fields that sound: status live or unverified, in the organ region (rotary group included) or a rotary region. */
export function organSoundingKeys(): Ns4Key[] {
  return [...DESCRIPTORS.values()]
    .filter((d) => (d.region === 'organ' || d.region === 'rotary') && (d.status === 'live' || d.status === 'unverified'))
    .map((d) => d.key);
}
