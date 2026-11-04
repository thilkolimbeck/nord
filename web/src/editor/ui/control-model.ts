/**
 * What a control shows, without the DOM: the value text and its markers, the range, the
 * description that aria-describedby points at, the morph indicator, the display lines, and which
 * key a control binds to when the focused layer or the layer scene changes. controls.ts and
 * display.ts render these; the tests check them in Node.
 */
import {
  setOscBank, setPianoType, setSectionEnabled, setSplitPoint, type SplitPoint, splitPointOn,
} from '../model/actions.ts';
import { type EnumOption, formatValue, optionsFor, type ParamDescriptor } from '../model/descriptors.ts';
import { isNs4Key, LAYER_TOKEN, layerKey, layerOf, type Ns4Key, patternOf, type SynthLayer } from '../model/keys.ts';
import type { ValueReader } from '../model/labels.ts';
import type { ParamStore } from '../model/store.ts';
import {
  activeScene, focusedLayer, type LayerOf, parseSceneKey, type Scene, SECTION_FIELDS, SECTIONS, sceneFree, sceneKey,
  type SectionId,
} from '../model/scene.ts';

/** How a descriptor is drawn: a fader, a select, a small key, three mask keys, or a read-only readout. */
export type ControlKind = 'fader' | 'select' | 'key' | 'mask' | 'readout';

/** Controls the browser engine only approximates (plan section 11, decision 2): the filter drive. */
export const COARSE_PATTERNS: ReadonlySet<string> = new Set(['synth{L}Sound.fltDrive']);

/**
 * Organ and piano controls whose sound the browser invents (plan section 13.6): they carry the
 * approximation marker '≈'. Levels, switches, zones, octave and pitch stick are exact and do not.
 * Patterns as controlPattern() writes them ('{L}' for the organ or piano layer).
 */
export const APPROX_PATTERNS: ReadonlySet<string> = new Set([
  'organ{L}.model', ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => `organ{L}Drawbars.org_Preset_kDb${n}`),
  'organ{L}VibPerc.org_Preset_kVibratoEnable', 'organ{L}VibPerc.org_Preset_kB3PercEnable',
  'organ{L}VibPerc.org_Preset_kB3PercHarmonic', 'organ{L}VibPerc.org_Preset_kB3PercSpeed',
  'organ{L}VibPerc.org_Preset_kB3PercLevel', 'organ.vibratoTypeB3', 'organ.vibratoTypeVox',
  'organ.vibratoTypeFarfisa', 'organ.polyPercEnable', 'organ.effectsLeslieEnable', 'organ.effectsLeslieSpeed',
  'organ.effectsLeslieStopMode', 'organ.effectsLeslieDrv', 'organ.leslieMicDistance',
  ...['bank', 'nameHash', 'variation', 'acoustic', 'pedalNoise', 'kbdTouch', 'dynComp', 'unison', 'eq']
    .map((p) => `piano{L}.${p}`),
]);
export const APPROX_SUFFIX = '≈';
const APPROX_ORGAN = 'approximation: an additive model in the browser, not the Stage 4 organ';
export const APPROX_PIANO = 'approximation: synthesized in the browser, no Nord samples';

export const STORED_LINE = 'no sound in MVP';
const NO_LABEL = 'no Stage 4 label for this value';

export interface ValueView {
  /** The Stage 4 label (it carries the unit) or the stored number. */
  readonly text: string;
  /** Not verified: an unverified field, or a value without a Stage 4 label. Shown as the suffix 'nv'. */
  readonly nv: boolean;
  /** Approximated by the browser engine. Shown as the suffix 'coarse'. */
  readonly coarse: boolean;
  /** Stored and exported, but not in the MVP sound. Shown as the line 'no sound in MVP'. */
  readonly stored: boolean;
  /** An organ or piano sound the browser invents. Shown as the suffix '≈'. */
  readonly approx: boolean;
  /** The suffixes after the value, in order: 'nv', 'coarse', '≈'. */
  readonly suffixes: readonly string[];
}

// Organ and piano layer keys: blocks organA, organADrawbars, organAVibPerc, pianoA and the per-layer
// level fields of the sections (organ.layerLevelOrgA, piano.layerLevelPnoB and their morphs).
const SECTION_LAYER_RE = /^(organ|piano)([AB])((?:Drawbars|VibPerc)?\.)|^(organ\.layerLevelOrg|piano\.layerLevelPno)([AB])(?=\.|$)/;

/** Section and layer of an organ or piano layer key; null for every other key (effects blocks included). */
export function sectionLayerOf(key: string): { readonly section: 'organ' | 'piano'; readonly layer: 'A' | 'B' } | null {
  const m = SECTION_LAYER_RE.exec(key);
  if (m === null) return null;
  const section = (m[1] ?? m[4]!.slice(0, 5)) as 'organ' | 'piano';
  return { section, layer: (m[2] ?? m[5]) as 'A' | 'B' };
}

/** The same field of another organ or piano layer: ('organA.model', 'B') → 'organB.model'; other keys stay. */
export function keyForSectionLayer(key: Ns4Key, layer: 'A' | 'B'): Ns4Key {
  const m = SECTION_LAYER_RE.exec(key);
  if (m === null) return key;
  const next = m[1] !== undefined
    ? `${m[1]}${layer}${m[3]!}${key.slice(m[0].length)}`
    : `${m[4]!}${layer}${key.slice(m[0].length)}`;
  if (!isNs4Key(next)) throw new Error(`${key} has no field for layer ${layer}`);
  return next;
}

/**
 * The field a control shows, free of layer and scene: 'synthBSound.fltFreq' → 'synth{L}Sound.fltFreq',
 * 'organB.model' → 'organ{L}.model', 'common.sectionEnableOrg_II' → 'common.sectionEnableOrg'.
 * A control can be rebound to any key with the same pattern.
 */
export function controlPattern(key: Ns4Key): string {
  const synth = patternOf(key);
  if (synth !== key) return synth;
  const m = SECTION_LAYER_RE.exec(key);
  if (m === null) return sceneFree(key);
  return m[1] !== undefined
    ? `${m[1]}${LAYER_TOKEN}${m[3]!}${key.slice(m[0].length)}`
    : `${m[4]!}${LAYER_TOKEN}${key.slice(m[0].length)}`;
}

/** A scene key in another scene ('…_I' → '…_II'); other keys stay. */
export function keyForScene(key: Ns4Key, scene: Scene): Ns4Key {
  const p = parseSceneKey(key);
  return p === null ? key : sceneKey(p.field, scene);
}

/**
 * The key a control of `section`'s panel shows now: the field of the section's focused layer in
 * the active scene, and the active scene's copy of a scene switch (plan section 13.1, rule 3).
 */
export function boundKey(section: SectionId, key: Ns4Key, values: ValueReader): Ns4Key {
  const scene = activeScene(values);
  const layer = focusedLayer(values, section, scene);
  const k = section === 'synth' ? keyForLayer(key, layer as LayerOf<'synth'>) : keyForSectionLayer(key, layer as 'A' | 'B');
  return keyForScene(k, scene);
}

const SPLIT_KEY = /^common\.splitEnabled(Low|Mid|High)$/;

/**
 * Write a control's new value. Writes that change more than one field go through the model's
 * actions: a section switch of either scene (setSectionEnabled with the key's own scene), a split
 * point (setSplitPoint, which keeps `common.splitEnabled` in step), a piano type (setPianoType)
 * and a synth osc bank (setOscBank). Every other field is a plain store write.
 */
export function writeControl(store: ParamStore, d: ParamDescriptor, value: number): void {
  const pattern = controlPattern(d.key);
  const scene = parseSceneKey(d.key);
  const section = scene === null ? undefined : SECTIONS.find((s) => SECTION_FIELDS[s].on === scene.field);
  const split = SPLIT_KEY.exec(d.key);
  const own = sectionLayerOf(d.key);
  if (pattern === 'synth{L}Sound.oscBank' && d.layer !== null) setOscBank(store, d.layer, value);
  else if (section !== undefined) setSectionEnabled(store, section, value !== 0, scene!.scene);
  else if (split !== null) setSplitPoint(store, split[1] as SplitPoint, value !== 0);
  else if (pattern === 'piano{L}.bank' && own !== null) setPianoType(store, own.layer, value);
  else store.set(d.key, value, 'ui');
}

/**
 * The value a control shows: the stored one, except that a split point key shows off while split
 * is off, because no point plays then (splitPointOn; M p.39).
 */
export function shownValue(d: ParamDescriptor, values: ValueReader): number {
  const split = SPLIT_KEY.exec(d.key);
  if (split === null) return values.get(d.key);
  return splitPointOn(values, split[1] as SplitPoint) ? d.max : d.min;
}

/** Keys besides its own, its label dependencies and morphs that change what a control shows. */
export function shownDeps(d: ParamDescriptor): readonly Ns4Key[] {
  return SPLIT_KEY.test(d.key) ? ['common.splitEnabled'] : [];
}

export function controlKind(d: ParamDescriptor): ControlKind {
  if (d.status === 'layout' || d.kind === 'opaque') return 'readout';
  if (d.kind === 'continuous') return 'fader';
  if (d.kind === 'mask') return 'mask';
  // A switch whose values carry their own status (synth mode: samples is not implemented) needs the
  // option markers of a select; plain switches are keys.
  if (d.kind === 'bool') return d.options?.some((o) => o.status !== undefined) ? 'select' : 'key';
  return 'select';
}

export function isCoarse(d: ParamDescriptor): boolean {
  return COARSE_PATTERNS.has(patternOf(d.key));
}

/** Whether a control carries the approximation marker (an organ or piano sound the browser invents). */
export function isApprox(d: ParamDescriptor): boolean {
  return (d.status === 'live' || d.status === 'unverified') && APPROX_PATTERNS.has(controlPattern(d.key));
}

/** Whether a switch's labels are the plain 'off'/'on' (then the key's pressed state says it all). */
export function isOffOn(d: ParamDescriptor): boolean {
  const o = d.options;
  return o === null || (o.length === 2 && o[0]!.label === 'off' && o[1]!.label === 'on');
}

export function valueView(d: ParamDescriptor, value: number, values: ValueReader, coarse = isCoarse(d)): ValueView {
  const f = formatValue(d, value, values);
  const nv = d.status === 'unverified' || f.marker !== null;
  const stored = d.status === 'stored';
  const approx = isApprox(d);
  const suffixes: string[] = [];
  if (nv) suffixes.push('nv');
  if (coarse) suffixes.push('coarse');
  if (approx) suffixes.push(APPROX_SUFFIX);
  return { text: f.text, nv, coarse, stored, approx, suffixes };
}

/** An option's text in a select: the Stage 4 label plus ' · not implemented' or ' · nv'. */
export function optionText(o: EnumOption): string {
  if (o.status === 'layout') return `${o.label} · not implemented`;
  if (o.status === 'unverified') return `${o.label} · nv`;
  return o.label;
}

/** 'min–max' in the field's own labels: '14 Hz–32 kHz', 'LP12–HP', 'off–on'. Empty for opaque fields. */
export function rangeText(d: ParamDescriptor, values: ValueReader): string {
  if (d.kind === 'opaque') return '';
  if (d.kind === 'mask') {
    const all = (d.options ?? []).reduce((m, o) => m | o.value, 0);
    return `${formatValue(d, 0, values).text}–${formatValue(d, all, values).text}`;
  }
  if (d.kind === 'enum' || (d.kind === 'bool' && d.options !== null)) {
    const options = optionsFor(d, values);
    if (options.length > 0) return `${options[0]!.label}–${options.at(-1)!.label}`;
  }
  return `${formatValue(d, d.min, values).text}–${formatValue(d, d.max, values).text}`;
}

/**
 * The description a control points at with aria-describedby: the range, then the status notes.
 * 'range 14 Hz–32 kHz. not verified: the Q curve is a guess. no sound in MVP: …'
 */
export function descriptionText(d: ParamDescriptor, value: number, values: ValueReader, coarse = isCoarse(d)): string {
  const parts: string[] = [];
  const range = rangeText(d, values);
  if (range !== '') parts.push(`range ${range}`);
  const f = formatValue(d, value, values);
  if (d.status === 'unverified') parts.push(`not verified: ${d.note ?? NO_LABEL}`);
  else if (f.marker === 'not decoded') parts.push('not verified: the Stage 4 table says not decoded for this value');
  else if (f.marker === 'raw' && d.status !== 'stored') parts.push(`not verified: ${d.note ?? NO_LABEL}`);
  if (d.status === 'stored') parts.push(`${STORED_LINE}: ${d.note ?? 'stored and exported'}`);
  if (d.status === 'layout') parts.push('not implemented: shown for reference, stored and exported');
  if (coarse) parts.push('coarse: the browser engine only approximates this');
  if (isApprox(d)) parts.push(d.key.startsWith('piano') ? APPROX_PIANO : APPROX_ORGAN);
  return parts.join('. ');
}

const MORPH_NAMES: ReadonlyArray<readonly ['wheel' | 'afterTouch' | 'ctrlPedal', string]> = [
  ['wheel', 'wheel'], ['afterTouch', 'aftertouch'], ['ctrlPedal', 'ctrl pedal']];

/** The non-zero morph amounts of a control, in Stage 4 order: [['wheel', '+40'], …]. */
export function morphAmounts(d: ParamDescriptor, values: ValueReader, describe: (key: Ns4Key) => ParamDescriptor):
  ReadonlyArray<readonly [string, string]> {
  if (d.morphs === null) return [];
  const out: [string, string][] = [];
  for (const [source, name] of MORPH_NAMES) {
    const key = d.morphs[source];
    const value = values.get(key);
    if (value !== 0) out.push([name, formatValue(describe(key), value, values).text]);
  }
  return out;
}

/** The morph indicator's accessible name, 'morph: wheel +40, aftertouch -3'; null when every amount is zero. */
export function morphLabel(amounts: ReadonlyArray<readonly [string, string]>): string | null {
  return amounts.length === 0 ? null : `morph: ${amounts.map(([name, text]) => `${name} ${text}`).join(', ')}`;
}

/** The key a control shows for the focused synth layer: the same field of that layer; other keys stay. */
export function keyForLayer(key: Ns4Key, layer: SynthLayer): Ns4Key {
  return layerOf(key) === null ? key : layerKey(layer, patternOf(key));
}

/** Display line 2: 'a · freq · 1.2 kHz · 14 Hz–32 kHz' (value with ' nv' or ' coarse' when marked). */
export function displayParamLine(d: ParamDescriptor, value: number, values: ValueReader, coarse = isCoarse(d)): string {
  const v = valueView(d, value, values, coarse);
  const own = sectionLayerOf(d.key);
  const scene = parseSceneKey(d.key);
  const where = d.layer !== null ? d.layer.toLowerCase()
    : own !== null ? `${own.section} ${own.layer.toLowerCase()}`
      : scene !== null ? SECTIONS.find((s) => Object.values(SECTION_FIELDS[s]).includes(scene.field))!
        : (d.region ?? 'program');
  const text = [v.text, ...v.suffixes].join(' ');
  const range = rangeText(d, values);
  return [where, d.label, text, ...(range === '' ? [] : [range])].join(' · ');
}

/** Display line 3: the touched parameter's status, then the edit count: 'not verified · edited 3'. */
export function displayStateLine(d: ParamDescriptor | null, value: number, values: ValueReader, edited: number): string {
  let status: string | null = null;
  if (d !== null) {
    const v = valueView(d, value, values);
    status = v.stored ? STORED_LINE : v.nv ? 'not verified' : v.coarse ? 'coarse' : v.approx ? 'approximation' : 'live';
  }
  return [status, `edited ${edited}`].filter((s) => s !== null).join(' · ');
}
