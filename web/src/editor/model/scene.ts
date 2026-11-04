/**
 * Layer scenes (manual p.15, 43): a program holds two configurations, scene I and scene II, of
 * which sections and layers are on and which layer each section focuses. "Any specific Layer uses
 * the same sound and settings for both Scenes" (p.43): only the switches exist twice in the layout,
 * as `…_I` and `…_II`, and `common.layerScene` says which scene is active.
 *
 * These helpers map a scene-free field name ('common.sectionEnableOrg', 'synth.layerEnableSyn') to
 * the layout key of a scene, and read the section and layer switches of the active scene, so the
 * router, the engines and the panels never name an `_I` or `_II` key themselves (plan section 13).
 * Layer enable masks: bit 0 = layer A, bit 1 = layer B, bit 2 = layer C, as the retired converter wrote
 * them (unverified on hardware). Pure: no DOM, no Web Audio.
 */
import { isNs4Key, type Ns4Key, type SynthLayer } from './keys.ts';
import type { ValueReader } from './labels.ts';

export type Scene = 'I' | 'II';
export const SCENES: readonly Scene[] = ['I', 'II'];

/** Which scene is active: 0 = I, 1 = II (table 085-3). */
export const SCENE_KEY: Ns4Key = 'common.layerScene';

/** The scene-free names of the fields that exist once per scene, section by section. */
export const SCENE_FIELDS = [
  'common.sectionEnableOrg', 'organ.layerEnableOrg', 'organ.layerFocusOrg',
  'common.sectionEnablePno', 'piano.layerEnablePno', 'piano.layerFocusPno',
  'common.sectionEnableSyn', 'synth.layerEnableSyn', 'synth.layerFocusSyn',
] as const;
export type SceneField = (typeof SCENE_FIELDS)[number];

/** The sections a note can sound in, in panel order. */
export type SectionId = 'organ' | 'piano' | 'synth';
export const SECTIONS: readonly SectionId[] = ['organ', 'piano', 'synth'];

export type OrganLayer = 'A' | 'B';
export type PianoLayer = 'A' | 'B';
export interface SectionLayerMap {
  readonly organ: OrganLayer;
  readonly piano: PianoLayer;
  readonly synth: SynthLayer;
}
/** The layer letters of a section: A and B for organ and piano, A, B and C for the synth. */
export type LayerOf<S extends SectionId> = SectionLayerMap[S];

export const SECTION_LAYERS: { readonly [S in SectionId]: readonly LayerOf<S>[] } = {
  organ: ['A', 'B'],
  piano: ['A', 'B'],
  synth: ['A', 'B', 'C'],
};

/** The scene fields of a section: section on, layer enable mask, layer focus. */
export interface SectionFields {
  readonly on: SceneField;
  readonly mask: SceneField;
  readonly focus: SceneField;
}

export const SECTION_FIELDS: Readonly<Record<SectionId, SectionFields>> = {
  organ: { on: 'common.sectionEnableOrg', mask: 'organ.layerEnableOrg', focus: 'organ.layerFocusOrg' },
  piano: { on: 'common.sectionEnablePno', mask: 'piano.layerEnablePno', focus: 'piano.layerFocusPno' },
  synth: { on: 'common.sectionEnableSyn', mask: 'synth.layerEnableSyn', focus: 'synth.layerFocusSyn' },
};

/** The bit of a layer in a layer enable mask (bit 0 = A, bit 1 = B, bit 2 = C). */
export const LAYER_BITS: Readonly<Record<SynthLayer, number>> = { A: 1, B: 2, C: 4 };

const FIELD_SET: ReadonlySet<string> = new Set<string>(SCENE_FIELDS);
const SUFFIX = /_(I|II)$/;

export function isSceneField(s: string): s is SceneField {
  return FIELD_SET.has(s);
}

/** The layout key of a scene field in one scene: ('common.sectionEnableOrg', 'II') → 'common.sectionEnableOrg_II'. */
export function sceneKey(field: SceneField, scene: Scene): Ns4Key {
  const key = `${field}_${scene}`;
  if (!isNs4Key(key)) throw new Error(`${key} is not a Stage 4 field`);
  return key;
}

/** Every scene key of the layout, scene I first, in SCENE_FIELDS order (18 keys). */
export const SCENE_KEYS: readonly Ns4Key[] = SCENES.flatMap((s) => SCENE_FIELDS.map((f) => sceneKey(f, s)));

/** The active scene: common.layerScene 1 is II, anything else I. */
export function activeScene(values: ValueReader): Scene {
  return values.get(SCENE_KEY) === 1 ? 'II' : 'I';
}

/** The layout key of a scene field in the active scene. */
export function activeKey(values: ValueReader, field: SceneField): Ns4Key {
  return sceneKey(field, activeScene(values));
}

/** The value of a scene field in `scene`, by default the active one. */
export function sceneValue(values: ValueReader, field: SceneField, scene: Scene = activeScene(values)): number {
  return values.get(sceneKey(field, scene));
}

/** Field and scene of a scene key ('synth.layerEnableSyn_II' → synth.layerEnableSyn, II); null for every other key. */
export function parseSceneKey(key: string): { readonly field: SceneField; readonly scene: Scene } | null {
  const m = SUFFIX.exec(key);
  if (m === null) return null;
  const field = key.slice(0, m.index);
  return isSceneField(field) ? { field, scene: m[1] as Scene } : null;
}

/** The same field in the other scene ('…_I' ↔ '…_II'); null for keys that are not scene keys. */
export function sceneTwin(key: Ns4Key): Ns4Key | null {
  const p = parseSceneKey(key);
  return p === null ? null : sceneKey(p.field, p.scene === 'I' ? 'II' : 'I');
}

/**
 * A key or layer pattern without its scene suffix: 'common.sectionEnableOrg_II' → 'common.sectionEnableOrg'.
 * Other strings come back unchanged. Two controls show the same field when their sceneFree patterns match.
 */
export function sceneFree(keyOrPattern: string): string {
  const p = parseSceneKey(keyOrPattern);
  return p === null ? keyOrPattern : p.field;
}

/** Whether a key is a switch of the scene that is not active now (its changes are heard only after a scene change). */
export function inactiveSceneKey(values: ValueReader, key: Ns4Key): boolean {
  const p = parseSceneKey(key);
  return p !== null && p.scene !== activeScene(values);
}

/** Whether a section is switched on in `scene` (default: the active one). */
export function sectionOn(values: ValueReader, section: SectionId, scene: Scene = activeScene(values)): boolean {
  return sceneValue(values, SECTION_FIELDS[section].on, scene) !== 0;
}

/** The layer enable mask of a section in `scene`, regardless of the section switch. */
export function layerMask(values: ValueReader, section: SectionId, scene: Scene = activeScene(values)): number {
  return sceneValue(values, SECTION_FIELDS[section].mask, scene);
}

/** Whether a layer's bit is set in `scene`, regardless of the section switch. */
export function layerOn<S extends SectionId>(values: ValueReader, section: S, layer: LayerOf<S>,
  scene: Scene = activeScene(values)): boolean {
  return (layerMask(values, section, scene) & LAYER_BITS[layer]) !== 0;
}

/** The layers that play in `scene`: none while the section is off, else those whose bit is set, in layer order. */
export function enabledLayers<S extends SectionId>(values: ValueReader, section: S,
  scene: Scene = activeScene(values)): LayerOf<S>[] {
  if (!sectionOn(values, section, scene)) return [];
  const mask = layerMask(values, section, scene);
  return SECTION_LAYERS[section].filter((l) => (mask & LAYER_BITS[l]) !== 0);
}

/** The layer a section's panel edits in `scene`: focus value 0 = A, 1 = B, 2 = C; out of range → A. */
export function focusedLayer<S extends SectionId>(values: ValueReader, section: S,
  scene: Scene = activeScene(values)): LayerOf<S> {
  const layers = SECTION_LAYERS[section];
  return layers[sceneValue(values, SECTION_FIELDS[section].focus, scene)] ?? layers[0]!;
}

/** The store entry that switches one layer on or off in `scene`, keeping the other bits. */
export function layerToggle<S extends SectionId>(values: ValueReader, section: S, layer: LayerOf<S>, on: boolean,
  scene: Scene = activeScene(values)): readonly [Ns4Key, number] {
  const mask = layerMask(values, section, scene);
  const next = on ? mask | LAYER_BITS[layer] : mask & ~LAYER_BITS[layer];
  return [sceneKey(SECTION_FIELDS[section].mask, scene), next];
}

/** The store entry that focuses a layer in `scene`. */
export function focusEntry<S extends SectionId>(section: S, layer: LayerOf<S>, scene: Scene): readonly [Ns4Key, number] {
  return [sceneKey(SECTION_FIELDS[section].focus, scene), SECTION_LAYERS[section].indexOf(layer)];
}

/** The store entry that switches a section on or off in `scene`. */
export function sectionEntry(section: SectionId, on: boolean, scene: Scene): readonly [Ns4Key, number] {
  return [sceneKey(SECTION_FIELDS[section].on, scene), on ? 1 : 0];
}
