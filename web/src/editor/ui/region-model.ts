/**
 * What the program, organ and piano regions show, without the DOM (docs/web-design.md, "Editor:
 * program, organ and piano regions"; plan section 13): drawbar labels per organ model, the vibrato
 * type field a model uses, the piano model list grouped by type, the scene and section keys of the
 * program region and the readouts that stay behind "show values". The panels render these; the
 * tests check them in Node.
 */
import { FX_UNIT_TITLES } from '../model/curated.ts';
import {
  FX_BLOCKS, FX_GLOBAL_KEYS, FX_GROUP_KEYS, type FxBlock, fxFocusBlock, fxGlobalOn, fxGroupOn, type FxParam, fxSectionOf,
  type FxUnit,
} from '../model/fx.ts';
import type { Ns4Key } from '../model/keys.ts';
import type { ValueReader } from '../model/labels.ts';
import { PIANO_MODELS, type PianoModel, pianoModel, PIANO_TYPES, type PianoType, pianoType } from '../model/pianos.ts';
import { activeScene, type Scene, SCENES, type SectionId, SECTIONS, sectionOn } from '../model/scene.ts';
import { APPROX_SUFFIX, fxBlockName } from './control-model.ts';

/** Organ models in the order of `organ{X}.model` (table 114-2). */
export type OrganModel = 'B3' | 'VOX' | 'FARF' | 'PIPE1' | 'PIPE2' | 'B3 BASS';
export const ORGAN_MODELS: readonly OrganModel[] = ['B3', 'VOX', 'FARF', 'PIPE1', 'PIPE2', 'B3 BASS'];

/** One drawbar's caption under the fader and its accessible name; `used` false when the model ignores it. */
export interface DrawbarLabel {
  readonly short: string;
  readonly name: string;
  readonly used: boolean;
}

const FOOTAGES = ["16'", "5⅓'", "8'", "4'", "2⅔'", "2'", "1⅗'", "1⅓'", "1'"];
/** A drawbar the model ignores; its number keeps the accessible names apart ('drawbar 3, not used by this model'). */
const unused = (n: number): DrawbarLabel => ({ short: '–', name: `drawbar ${n}, not used by this model`, used: false });
const footage = (f: string): DrawbarLabel => ({ short: f, name: `${f} drawbar`, used: true });
/** Farfisa registers of manual p.21, left to right; a drawbar pulled past half way switches one on. */
const FARF = ['bass 16', 'strings 16', 'flute 8', 'oboe 8', 'trumpet 8', 'strings 8', 'flute 4', 'strings 4', "2⅔'"];

/** The model of an `organ{X}.model` value; out of range → B3. */
export function organModel(value: number): OrganModel {
  return ORGAN_MODELS[value] ?? 'B3';
}

/**
 * The nine drawbar captions of a model (manual p.19–21; plan section 13.2): B3 and both Pipes the
 * B3 footages; B3 Bass 16' and 8' on drawbars 1 and 2 (assumed); Vox seven partials and a
 * soft–bright mix on drawbar 9; Farf the register names.
 */
export function drawbarLabels(model: OrganModel): readonly DrawbarLabel[] {
  switch (model) {
    case 'B3':
    case 'PIPE1':
    case 'PIPE2':
      return FOOTAGES.map(footage);
    case 'B3 BASS':
      return [footage("16'"), footage("8'"), ...[3, 4, 5, 6, 7, 8, 9].map(unused)];
    case 'VOX':
      return [
        ...[1, 2, 3, 4, 5, 6, 7].map((n) => ({ short: `p${n}`, name: `partial ${n} drawbar`, used: true })),
        unused(8), { short: 'mix', name: 'soft to bright mix drawbar', used: true },
      ];
    case 'FARF':
      return FARF.map((f) => ({ short: f.replace(/^(\w)\w* /, '$1 '), name: `${f} register (on from 5)`, used: true }));
  }
}

/** The organ-wide vibrato type field a model uses (manual p.19–21); Pipe models have none. */
export function vibratoTypeKey(model: OrganModel): Ns4Key | null {
  switch (model) {
    case 'B3':
    case 'B3 BASS':
      return 'organ.vibratoTypeB3';
    case 'VOX':
      return 'organ.vibratoTypeVox';
    case 'FARF':
      return 'organ.vibratoTypeFarfisa';
    default:
      return null;
  }
}

export const VIBRATO_TYPE_KEYS: readonly Ns4Key[] = ['organ.vibratoTypeB3', 'organ.vibratoTypeVox', 'organ.vibratoTypeFarfisa'];

/** One option of the piano model select. */
export interface ModelOption {
  readonly value: number;
  readonly text: string;
}

export interface ModelGroup {
  readonly type: PianoType;
  readonly label: string;
  readonly options: readonly ModelOption[];
}

/** 'Royal Grand 3D XL · approximation'; models that share a label carry their position: 'EP1 (2) · approximation'. */
export function modelText(m: PianoModel): string {
  return `${m.label}${m.count > 1 ? ` (${m.ordinal})` : ''} · approximation`;
}

/** Every known piano model, grouped by type in PIANO_TYPES order (295 options). */
export const MODEL_GROUPS: readonly ModelGroup[] = PIANO_TYPES.map((type) => ({
  type,
  label: type,
  options: PIANO_MODELS.filter((m) => m.type === type).map((m) => ({ value: m.hash, text: modelText(m) })),
}));

/** The option for a stored hash the catalogue does not know (0 in a fresh program): it plays the type's default. */
export function unknownModelText(hash: number, type: PianoType): string {
  const id = hash === 0 ? 'no model' : `unknown model 0x${(hash >>> 0).toString(16).padStart(8, '0')}`;
  return `${id} · plays the ${type} default ${APPROX_SUFFIX}`;
}

/** Whether a hash is in the catalogue. */
export function knownModel(hash: number): boolean {
  return pianoModel(hash) !== null;
}

/**
 * What the model select shows for a stored hash and bank. The model itself only when it plays:
 * known and of the bank's type (model/pianos.ts pianoFamily). Otherwise the extra first option
 * names what plays, the bank type's default: for an unknown hash, and for a known model of
 * another type (an electric model cannot sound on a grand bank).
 */
export function modelChoice(hash: number, bank: number): { readonly playsModel: boolean; readonly text: string } {
  const type = pianoType(bank);
  const model = pianoModel(hash);
  if (model === null) return { playsModel: false, text: unknownModelText(hash, type) };
  if (model.type === type) return { playsModel: true, text: modelText(model) };
  return { playsModel: false, text: `${model.label} (${model.type} model) · plays the ${type} default ${APPROX_SUFFIX}` };
}

/**
 * Whether a piano layer's `variation` sounds: only the Clav type uses it, as the pickup (M p.24;
 * audio/piano/recipes.ts clavPickup). The panel hides it for the other types.
 */
export function variationUsed(bank: number): boolean {
  return pianoType(bank) === 'clav';
}

/** 'n set, …' for the program region's morph readout, counting every non-zero morph field. */
export function morphCountText(count: number): string {
  return count === 0 ? 'none set' : `${count} set: each control's m key shows and edits them; they play (scaling nv)`;
}

/** The program region's scene keys: label, the scene, whether it is active. */
export function sceneKeys(values: ValueReader): ReadonlyArray<{ readonly scene: Scene; readonly label: string; readonly active: boolean }> {
  const active = activeScene(values);
  return SCENES.map((scene) => ({ scene, label: scene, active: scene === active }));
}

/** The program region's section keys: section, label, whether it is on in the active scene. */
export function sectionKeys(values: ValueReader): ReadonlyArray<{ readonly section: SectionId; readonly label: string; readonly on: boolean }> {
  return SECTIONS.map((section) => ({ section, label: section, on: sectionOn(values, section) }));
}

// ---------------------------------------------------------------------------------------------
// The layer effects region (plan section 15.9): the FX focus keys, the group key and the six
// unit groups of the block in focus.

/** The effects region's unit groups, in chain order, with the fields each shows and its Global switch. */
export const FX_REGION_GROUPS: ReadonlyArray<{
  readonly unit: FxUnit;
  readonly title: string;
  readonly params: readonly FxParam[];
  readonly global: Ns4Key | null;
}> = [
  { unit: 'mod1', title: FX_UNIT_TITLES.mod1, params: ['fx1Enable', 'fx1Type', 'fx1RateClkDiv', 'fx1ClkEnable', 'fx1Amt'], global: null },
  { unit: 'mod2', title: FX_UNIT_TITLES.mod2, params: ['fx2Enable', 'fx2Type', 'fx2Rate', 'fx2Amt'], global: null },
  {
    unit: 'delay', title: FX_UNIT_TITLES.delay, global: FX_GLOBAL_KEYS.delay,
    params: ['dlyEnable', 'dlyRateClkDiv', 'dlyClkEnable', 'dlyMix', 'dlyFbkAmt', 'dlyMode', 'dlyFbkPingPong', 'dlyFbkFilt',
      'dlyFbFxType'],
  },
  {
    unit: 'amp', title: FX_UNIT_TITLES.amp, global: null,
    params: ['ampEnable', 'ampTypeNew', 'ampDrive', 'ampBass', 'ampMid', 'ampMidFreq', 'ampTreble'],
  },
  { unit: 'comp', title: FX_UNIT_TITLES.comp, params: ['cmpEnable', 'cmpAmt', 'cmpResponse'], global: FX_GLOBAL_KEYS.comp },
  { unit: 'reverb', title: FX_UNIT_TITLES.reverb, params: ['rvbEnable', 'rvbType', 'rvbAmt', 'rvbColor'], global: FX_GLOBAL_KEYS.reverb },
];

export const FX_REGION_LEGEND = 'layer effects · approximation';
export const FX_GLOBAL_LINE = 'global: one instance on every section, with these settings';
export const FX_ORGAN_GROUP_NOTE = 'the organ has one effects block for both layers';

/** The focus keys: one per block ('organ', 'piano a', …), the one in FX focus pressed. */
export function fxFocusKeys(values: ValueReader): ReadonlyArray<{ readonly block: FxBlock; readonly label: string; readonly active: boolean }> {
  const focus = fxFocusBlock(values);
  return FX_BLOCKS.map((block) => ({ block, label: fxBlockName(block).replace(/ fx$/, ''), active: block === focus }));
}

/** The group key for the section in FX focus: the organ has none (one block for both layers). */
export function fxGroupKey(values: ValueReader): { readonly section: SectionId; readonly key: Ns4Key | null; readonly on: boolean } {
  const section = fxSectionOf(fxFocusBlock(values));
  if (section === 'organ') return { section, key: null, on: false };
  return { section, key: FX_GROUP_KEYS[section], on: fxGroupOn(values, section) };
}

/** Whether a unit group shows the Global line (its Global switch is on). */
export function fxGlobalShown(values: ValueReader, unit: FxUnit): boolean {
  return fxGlobalOn(values, unit);
}
