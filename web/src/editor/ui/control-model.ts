/**
 * What a control shows, without the DOM: the value text and its markers, the range, the
 * description that aria-describedby points at, the morph indicator, the display lines, and which
 * key a control binds to when the focused layer or the layer scene changes. controls.ts and
 * display.ts render these; the tests check them in Node.
 */
import {
  groupOfSwitch, setFxGlobal, setFxGroup, setOscBank, setPianoType, setSectionEnabled, setSplitPoint, setSynthGroup,
  setSynthParam, type SplitPoint, splitPointOn,
} from '../model/actions.ts';
import { FX_UNIT_TITLES, fxUnitOf, STORED_LINE } from '../model/curated.ts';
import {
  descriptorOf, type EnumOption, type Formatted, formatValue, optionsFor, type ParamDescriptor,
} from '../model/descriptors.ts';
import {
  FX_GLOBAL_KEYS, FX_GROUP_KEYS, FX_PARAMS, type FxBlock, fxFocusBlock, type GlobalUnit, parseFxKey,
} from '../model/fx.ts';
import {
  MORPH_SOURCE_LABELS, MORPH_SOURCES, morphEnd, morphKey, morphRange, type MorphSource, morphTarget,
} from '../model/morph.ts';
import { isNs4Key, LAYER_TOKEN, layerKey, layerOf, type Ns4Key, patternOf, type SynthLayer } from '../model/keys.ts';
import type { ValueReader } from '../model/labels.ts';
import type { ParamStore } from '../model/store.ts';
import {
  activeScene, focusedLayer, type LayerOf, parseSceneKey, type Scene, SECTION_FIELDS, SECTIONS, sceneFree, sceneKey,
  type SectionId,
} from '../model/scene.ts';

/** How a descriptor is drawn: a fader, a select, a small key, three mask keys, or a read-only readout. */
export type ControlKind = 'fader' | 'select' | 'key' | 'mask' | 'readout';

/** The stand-in for the effects block in a control pattern: '{FX}.dlyMix' (plan 15.9). */
export const FX_TOKEN = '{FX}';

/** Controls the browser engine only approximates (plan section 11, decision 2): the filter drive. */
export const COARSE_PATTERNS: ReadonlySet<string> = new Set(['synth{L}Sound.fltDrive']);

/**
 * Every pattern the audio engine can mark coarse at run time (audio/mapping.ts coarsePatterns:
 * the filter drive always, the filter type in its third mode, the analog sync and shape-sine
 * oscillator fields). Their value cells reserve room for the 'coarse' marker from the start, so
 * the marker never widens a row when it appears.
 */
export const MAY_BE_COARSE: ReadonlySet<string> = new Set([
  ...COARSE_PATTERNS, 'synth{L}Sound.fltType', 'synth{L}Sound.oscWave', 'synth{L}Sound.oscCat', 'synth{L}Sound.oscCtrl']);

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
  // Every field of a layer effects block sounds through a Web Audio model (plan 15.9).
  ...FX_PARAMS.map((p) => `${FX_TOKEN}.${p}`),
]);
export const APPROX_SUFFIX = '≈';
const APPROX_ORGAN = 'approximation: an additive model in the browser, not the Stage 4 organ';
export const APPROX_PIANO = 'approximation: synthesized in the browser, no Nord samples';
export const APPROX_FX = 'approximation: an effect modelled in the browser, no Nord effect or impulse response';

export { STORED_LINE };
const NO_LABEL = 'no Stage 4 label for this value';

export interface ValueView {
  /** The Stage 4 label (it carries the unit) or the stored number. */
  readonly text: string;
  /** Not verified: an unverified field, or a value without a Stage 4 label. Shown as the suffix 'nv'. */
  readonly nv: boolean;
  /** Approximated by the browser engine. Shown as the suffix 'coarse'. */
  readonly coarse: boolean;
  /** Stored and exported, but silent. Shown as the field's stored line ('stored setting, no sound'). */
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
  const fx = parseFxKey(key);
  if (fx !== null) return `${FX_TOKEN}${key.slice(fx.block.length)}`;
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

/** The same field of the FX focus block (the effects region's controls, plan 15.9); other keys stay. */
export function fxBoundKey(key: Ns4Key, values: ValueReader): Ns4Key {
  return keyForBlock(key, fxFocusBlock(values));
}

/** The same field of another effects block: ('organFx.dlyMix', 'synthBFx') → 'synthBFx.dlyMix'; other keys stay. */
export function keyForBlock(key: Ns4Key, block: FxBlock): Ns4Key {
  const p = parseFxKey(key);
  return p === null ? key : `${block}${key.slice(p.block.length)}` as Ns4Key;
}

const FX_GROUP_SECTION: ReadonlyMap<Ns4Key, 'piano' | 'synth'> = new Map(
  (Object.entries(FX_GROUP_KEYS) as Array<['piano' | 'synth', Ns4Key]>).map(([s, k]) => [k, s]));
const FX_GLOBAL_UNIT: ReadonlyMap<Ns4Key, GlobalUnit> = new Map(
  (Object.entries(FX_GLOBAL_KEYS) as Array<[GlobalUnit, Ns4Key]>).map(([u, k]) => [k, u]));

const SPLIT_KEY = /^common\.splitEnabled(Low|Mid|High)$/;

/**
 * Write a control's new value. Writes that change more than one field go through the model's
 * actions: a section switch of either scene (setSectionEnabled with the key's own scene), a split
 * point (setSplitPoint, which keeps `common.splitEnabled` in step), a piano type (setPianoType),
 * a synth osc bank (setOscBank), a synth Group switch (setSynthGroup), a field of a synth Group
 * that is on (setSynthParam writes every layer), an effects group or Global switch (setFxGroup,
 * setFxGlobal) and a field of an effects block (setSynthParam: every block of the section while
 * its effects are in group mode). Every other field is a plain store write.
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
  else if (groupOfSwitch(d.key) !== null) setSynthGroup(store, groupOfSwitch(d.key)!, value !== 0);
  else if (FX_GROUP_SECTION.has(d.key)) setFxGroup(store, FX_GROUP_SECTION.get(d.key)!, value !== 0);
  else if (FX_GLOBAL_UNIT.has(d.key)) setFxGlobal(store, FX_GLOBAL_UNIT.get(d.key)!, value !== 0);
  else if (d.layer !== null || parseFxKey(d.key) !== null) setSynthParam(store, d.key, value);
  else store.set(d.key, value, 'ui');
}

/** The line under a stored control. */
export function storedLine(d: ParamDescriptor): string {
  return d.storedLine ?? STORED_LINE;
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

/**
 * The short form of a Stage 4 label that the panel shows (value cells, display line, morph end
 * values): 'volume off' → 'off', '-6 semitones' → '-6 semi' (as the oscillator's own '-24 semi').
 * The tables, the print-out and the accessible texts (aria-valuetext, the range in the
 * description) keep the Stage 4 wording.
 */
export function shortLabel(text: string): string {
  if (text === 'volume off') return 'off';
  const semi = /^(-?\d+) semitones$/.exec(text);
  return semi === null ? text : `${semi[1]!} semi`;
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
  return { text: shortLabel(f.text), nv, coarse, stored, approx, suffixes };
}

/** A control's aria-valuetext: the full Stage 4 label and the markers ('volume off', '-6 semitones nv'). */
export function spokenValue(d: ParamDescriptor, value: number, values: ValueReader, coarse = isCoarse(d)): string {
  return [formatValue(d, value, values).text, ...valueView(d, value, values, coarse).suffixes].join(' ');
}

/** The widest value cell a control can show, in characters: its value text and its markers. */
export interface ValueReserve {
  /** The longest value text over every value (0 where the cell hides it: selects, masks). */
  readonly text: number;
  /** The longest marker string ('nv coarse ≈'), 'coarse' included where the engine can set it. */
  readonly marks: number;
}

/** Beyond this many steps a field is not walked value by value (only the 32-bit hashes are). */
const RESERVE_MAX_STEPS = 1 << 15;
/** At most this many combinations of dependency values; beyond, each dependency varies alone. */
const RESERVE_MAX_COMBOS = 256;
const reserves = new Map<string, ValueReserve>();

function chars(text: string): number {
  return [...text].length;
}

function integers(lo: number, hi: number): number[] {
  return Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
}

/** The values of a field's dependencies to try: every combination, or one dependency at a time when there are too many. */
function depCombos(d: ParamDescriptor): ReadonlyMap<Ns4Key, number>[] {
  const deps = d.deps.map((k) => descriptorOf(k));
  const total = deps.reduce((n, x) => n * (x.max - x.min + 1), 1);
  if (total <= RESERVE_MAX_COMBOS) {
    return deps.reduce<Map<Ns4Key, number>[]>((acc, x) => acc.flatMap((m) =>
      integers(x.min, x.max).map((v) => new Map(m).set(x.key, v))), [new Map()]);
  }
  return [new Map(), ...deps.flatMap((x) => integers(x.min, Math.min(x.max, x.min + RESERVE_MAX_COMBOS - 1))
    .map((v) => new Map([[x.key, v]])))];
}

/**
 * formatValue for one set of dependency values. Manual labels (options or option sets) are read
 * from one map instead of a search of the option list per value: the delay rate has 16384 steps.
 */
function labelsOf(d: ParamDescriptor, values: ValueReader): (value: number) => Formatted {
  if (d.kind === 'opaque' || d.kind === 'mask' || d.labelSource !== 'manual' || (d.options === null && d.optionSets === null)) {
    return (v) => formatValue(d, v, values);
  }
  const labels = new Map(optionsFor(d, values).map((o) => [o.value, o.label]));
  return (v) => {
    const label = labels.get(v);
    return label === undefined ? { text: String(v), marker: 'raw' } : { text: label, marker: null };
  };
}

/**
 * The value cell a control reserves (docs/web-design.md, "Controls"): the longest text and the
 * longest markers over every value d.min..d.max and every combination of the values its labels
 * depend on, so the cell, and the fader beside it, never change size with the value. Selects and
 * masks show their value in the control and keep only the markers; 32-bit hashes reserve ten
 * digits. Cached per control pattern: every key a control can be rebound to shares it.
 */
export function valueReserve(d: ParamDescriptor): ValueReserve {
  const pattern = controlPattern(d.key);
  const cached = reserves.get(pattern);
  if (cached !== undefined) return cached;
  const kind = controlKind(d);
  const showsText = kind !== 'select' && kind !== 'mask';
  const coarse = isCoarse(d) || MAY_BE_COARSE.has(pattern);
  const walk = d.kind !== 'opaque' && d.max - d.min <= RESERVE_MAX_STEPS;
  const steps = walk ? integers(d.min, d.max) : [d.min, d.default, d.max];
  let text = walk ? 0 : 10;
  let marks = 0;
  for (const combo of depCombos(d)) {
    const reader: ValueReader = { get: (k) => combo.get(k) ?? descriptorOf(k).default };
    // The markers vary with the value only through its label marker (nv): valueView is asked once
    // for a value with and once for a value without one, the text of every value is measured.
    const samples = new Map<boolean, number>();
    const format = labelsOf(d, reader);
    for (const v of steps) {
      const f = format(v);
      if (showsText) text = Math.max(text, chars(shortLabel(f.text)));
      if (!samples.has(f.marker !== null)) samples.set(f.marker !== null, v);
    }
    for (const v of samples.values()) marks = Math.max(marks, chars(valueView(d, v, reader, coarse).suffixes.join(' ')));
  }
  const out = { text: showsText ? text : 0, marks };
  reserves.set(pattern, out);
  return out;
}

/** An option's text in a select: the Stage 4 label plus ' · not implemented' or ' · nv'. */
export function optionText(o: EnumOption): string {
  if (o.status === 'layout') return `${o.label} · not implemented`;
  if (o.status === 'unverified') return `${o.label} · nv`;
  return o.label;
}

/**
 * 'min–max' in the field's own labels: '14 Hz–32 kHz', 'LP12–HP', 'off–on'. Empty for opaque
 * fields. Short labels (shortLabel) unless `short` is false, as in the description.
 */
export function rangeText(d: ParamDescriptor, values: ValueReader, short = true): string {
  if (d.kind === 'opaque') return '';
  const span = (lo: string, hi: string): string => (short ? `${shortLabel(lo)}–${shortLabel(hi)}` : `${lo}–${hi}`);
  if (d.kind === 'mask') {
    const all = (d.options ?? []).reduce((m, o) => m | o.value, 0);
    return span(formatValue(d, 0, values).text, formatValue(d, all, values).text);
  }
  if (d.kind === 'enum' || (d.kind === 'bool' && d.options !== null)) {
    const options = optionsFor(d, values);
    if (options.length > 0) return span(options[0]!.label, options.at(-1)!.label);
  }
  return span(formatValue(d, d.min, values).text, formatValue(d, d.max, values).text);
}

/**
 * The description a control points at with aria-describedby: the range, then the status notes.
 * 'range 14 Hz–32 kHz. not verified: the Q curve is a guess. stored setting, no sound: …'
 */
export function descriptionText(d: ParamDescriptor, value: number, values: ValueReader, coarse = isCoarse(d)): string {
  const parts: string[] = [];
  const range = rangeText(d, values, false);
  if (range !== '') parts.push(`range ${range}`);
  const f = formatValue(d, value, values);
  if (d.status === 'unverified') parts.push(`not verified: ${d.note ?? NO_LABEL}`);
  else if (f.marker === 'not decoded') parts.push('not verified: the Stage 4 table says not decoded for this value');
  else if (f.marker === 'raw' && d.status !== 'stored') parts.push(`not verified: ${d.note ?? NO_LABEL}`);
  if (d.status === 'stored') parts.push(`${storedLine(d)}: ${d.note ?? 'stored and exported'}`);
  if (d.status === 'layout') parts.push('not implemented: shown for reference, stored and exported');
  if (coarse) parts.push('coarse: the browser engine only approximates this');
  if (isApprox(d)) parts.push(parseFxKey(d.key) !== null ? APPROX_FX : d.key.startsWith('piano') ? APPROX_PIANO : APPROX_ORGAN);
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
  const text = [v.text, ...v.suffixes].join(' ');
  const target = morphTarget(d.key);
  if (target !== null) {
    // A morph amount: where its field sits, the amount, and the field's start → end (M p.38).
    const parent = descriptorOf(target.parent);
    return [whereOf(parent), d.label, text, morphEndText(parent, target.source, values)].join(' · ');
  }
  const range = rangeText(d, values);
  return [whereOf(d), d.label, text, ...(range === '' ? [] : [range])].join(' · ');
}

/** Display line 2's first part: the layer, section layer, section, effects block or region of a field. */
function whereOf(d: ParamDescriptor): string {
  const fx = parseFxKey(d.key);
  const unit = fxUnitOf(d.key);
  if (fx !== null) return unit === null ? fxBlockName(fx.block) : `${fxBlockName(fx.block)} · ${FX_UNIT_TITLES[unit]}`;
  const own = sectionLayerOf(d.key);
  const scene = parseSceneKey(d.key);
  return d.layer !== null ? d.layer.toLowerCase()
    : own !== null ? `${own.section} ${own.layer.toLowerCase()}`
      : scene !== null ? SECTIONS.find((s) => Object.values(SECTION_FIELDS[s]).includes(scene.field))!
        : (d.region ?? 'program');
}

/** 'organ fx', 'piano a fx', 'synth c fx'. */
export function fxBlockName(block: FxBlock): string {
  if (block === 'organFx') return 'organ fx';
  return `${block.slice(0, -3)} ${block.charAt(block.length - 3).toLowerCase()} fx`;
}

// ---------------------------------------------------------------------------------------------
// Morph editing (plan sections 15.2 and 15.9): three signed amounts per field, each with the
// value its source reaches at full travel. Amounts are signed deltas in stored steps (assumed, nv).

/** One row of a control's morph editor. */
export interface MorphRow {
  readonly source: MorphSource;
  /** 'wheel', 'a.t.', 'ctrl ped'. */
  readonly label: string;
  readonly key: Ns4Key;
  readonly amount: number;
  readonly min: number;
  readonly max: number;
  /** The amount as the row shows it: '+40', '0', '-3'. */
  readonly amountText: string;
  /** '→ 4.8 kHz': the field's value at this source's full travel (short label). */
  readonly endText: string;
  /** The same end value in the Stage 4 wording, for the fader's aria-valuetext. */
  readonly endSpoken: string;
}

function signed(n: number): string {
  return n > 0 ? `+${n}` : String(n);
}

/** The widest amount a morph row shows, in characters: '+127', '-16383'. */
export function morphAmountChars(min: number, max: number): number {
  return Math.max(chars(signed(min)), chars(signed(max)));
}

/** '1.2 kHz → 4.8 kHz': the stored value and where one source takes it. */
export function morphEndText(parent: ParamDescriptor, source: MorphSource, values: ValueReader): string {
  const from = shortLabel(formatValue(parent, values.get(parent.key), values).text);
  const to = shortLabel(formatValue(parent, morphEnd(values, parent.key, source), values).text);
  return `${from} → ${to}`;
}

/** The three rows of a field's morph editor (wheel, a.t., ctrl ped). */
export function morphRows(parent: ParamDescriptor, values: ValueReader): MorphRow[] {
  const range = morphRange(parent.key);
  return MORPH_SOURCES.map((source) => {
    const key = morphKey(parent.key, source);
    const amount = values.get(key);
    const end = formatValue(parent, morphEnd(values, parent.key, source), values).text;
    return {
      source, label: MORPH_SOURCE_LABELS[source], key, amount, min: range.min, max: range.max,
      amountText: signed(amount), endText: `→ ${shortLabel(end)}`, endSpoken: end,
    };
  });
}

/** The morph key's accessible name: 'morph: wheel +40, a.t. -3' or 'morph: none set'. */
export function morphKeyLabel(parent: ParamDescriptor, values: ValueReader): string {
  const active = morphRows(parent, values).filter((r) => r.amount !== 0);
  return active.length === 0 ? 'morph: none set' : `morph: ${active.map((r) => `${r.label} ${r.amountText}`).join(', ')}`;
}

/** Display line 3: the touched parameter's status, then the edit count: 'not verified · edited 3'. */
export function displayStateLine(d: ParamDescriptor | null, value: number, values: ValueReader, edited: number): string {
  let status: string | null = null;
  if (d !== null) {
    const v = valueView(d, value, values);
    status = v.stored ? storedLine(d) : v.nv ? 'not verified' : v.coarse ? 'coarse' : v.approx ? 'approximation' : 'live';
  }
  return [status, `edited ${edited}`].filter((s) => s !== null).join(' · ');
}
