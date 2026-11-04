/**
 * One descriptor per Stage 4 field: kind, range, default, unit, labels, status and where it sits.
 * Derived from the layout (range, default, encoding), the display tables (labels and units) and
 * curated.ts (short labels, MVP status, notes, manual labels), as plan section 3.1 describes.
 * Fields of a live region take their status from curated.ts (or a stored or layout group's);
 * scene II copies take kind, options, status and note from their scene I twin (plan section 13.1).
 */
import { NS4_LAYOUT, type Encoding } from '../../ns4/layout.ts';
import { FIELD_DEP, FIELD_VALUE_TABLE, PORT_NAMES } from '../generated/display-ns4.ts';
import { CURATED, type Curated } from './curated.ts';
import { isNs4Key } from './keys.ts';
import { pianoModel } from './pianos.ts';
import { parseSceneKey, sceneKey } from './scene.ts';
import { layerOf, NS4_KEYS, type Ns4Key, patternOf, type SynthLayer } from './keys.ts';
import { labelDeps, ns4Label, staticLabel, type ValueReader } from './labels.ts';
import { type GroupId, morphParent, type ParamStatus, PLACEMENT, type RegionId } from './sections.ts';
import { parseDisplay, type Unit } from './units.ts';

export type { ParamStatus } from './sections.ts';
export type ParamKind = 'continuous' | 'enum' | 'bool' | 'mask' | 'opaque';
/** Where the labels come from: value table, enum table, dependency table, the manual, or none. */
export type LabelSource = 'table' | 'enum' | 'dep' | 'manual' | 'raw';

export interface EnumOption {
  readonly value: number;
  readonly label: string;
  readonly status?: ParamStatus;
  readonly note?: string;
}

/** Manual labels chosen by another field's value (piano timbre and variation by piano type). */
export interface OptionSets {
  readonly dep: Ns4Key;
  readonly sets: Readonly<Record<number, readonly EnumOption[]>>;
  readonly fallback: readonly EnumOption[];
}

export interface Morphs {
  readonly wheel: Ns4Key;
  readonly afterTouch: Ns4Key;
  readonly ctrlPedal: Ns4Key;
}

export interface ParamDescriptor {
  readonly key: Ns4Key;
  readonly kind: ParamKind;
  /** The values the store accepts (the layout range; 0..2^32-1 for opaque 32-bit hashes). */
  readonly min: number;
  readonly max: number;
  readonly default: number;
  readonly width: number;
  readonly enc: Encoding;
  /** null for HIDDEN fields (stored, no control). */
  readonly region: RegionId | null;
  readonly group: GroupId | null;
  readonly layer: SynthLayer | null;
  readonly label: string;
  /** The unit of a continuous field with table labels; null otherwise. */
  readonly unit: Unit | null;
  readonly labelSource: LabelSource;
  readonly status: ParamStatus;
  /** Static options of enum, bool and mask fields; null for dependency tables (see optionsFor) and the rest. */
  readonly options: readonly EnumOption[] | null;
  /** Fields a dependency-table or option-set label depends on (osc bank and category, split enables, piano type). */
  readonly deps: readonly Ns4Key[];
  /** Manual labels that follow another field (deps[0]); null for every other field. */
  readonly optionSets: OptionSets | null;
  readonly morphs: Morphs | null;
  /** Why the field is unverified or silent, or what its labels are based on. */
  readonly note: string | null;
}

export interface Formatted {
  readonly text: string;
  /** raw: no Stage 4 label, the number is the stored step; not decoded: the table says so. */
  readonly marker: null | 'raw' | 'not decoded';
}

const NOT_DECODED = 'not decoded';
const PIANO_HASH = /^piano[AB]\.nameHash$/;
const NO_LABEL_NOTE = 'no Stage 4 label for this value';
const MORPH_SOURCES: ReadonlyArray<readonly [keyof Morphs, string, string]> = [
  ['wheel', 'morphWheel', 'wheel'], ['afterTouch', 'morphAfterTouch', 'aftertouch'],
  ['ctrlPedal', 'morphCtrlPedal', 'ctrl pedal']];

function own<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

function humanise(key: string): string {
  const part = key.slice(key.indexOf('.') + 1);
  return part.replace(/_/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/\s+/g, ' ').toLowerCase().trim();
}

function defaultLabel(key: Ns4Key): string {
  const port = own(FIELD_VALUE_TABLE, key)?.[0] ?? own(FIELD_DEP, key)?.[0];
  const name = port === undefined ? undefined : own(PORT_NAMES, port);
  return (name ?? humanise(key)).toLowerCase();
}

/** Synth blocks whose hidden fields are stored synth data (morphs, scene II, sample refs); FX and extern are not. */
function inSynthSound(key: Ns4Key): boolean {
  return /^synth(?:[ABC](?:Sound)?)?\./.test(key) || key === 'common.sectionEnableSyn_II';
}

interface Labels {
  readonly kind: ParamKind;
  readonly labelSource: LabelSource;
  readonly unit: Unit | null;
  readonly options: readonly EnumOption[] | null;
}

/** Kind, unit and options from the value and enum tables (plan section 3.1 steps 3–6). */
function fromTables(key: Ns4Key, min: number, max: number, width: number, cur: Curated | undefined): Labels {
  const labelled: EnumOption[] = [];
  const all: EnumOption[] = [];
  let fromValueTable = false;
  for (let v = min; v <= max; v++) {
    const found = staticLabel(key, v);
    if (found !== null && found.label !== NOT_DECODED) {
      labelled.push({ value: v, label: found.label });
      all.push({ value: v, label: found.label });
      fromValueTable ||= found.source === 'table';
    } else {
      all.push({ value: v, label: String(v), status: 'unverified',
        note: found?.label === NOT_DECODED ? NOT_DECODED : NO_LABEL_NOTE });
    }
  }
  if (labelled.length > 0) {
    const labelSource: LabelSource = fromValueTable ? 'table' : 'enum';
    const withStatus = (options: readonly EnumOption[]): EnumOption[] => options.map((o) => {
      const extra = cur?.optionStatus?.[o.value];
      return extra === undefined ? o : { ...o, status: extra.status, note: extra.note };
    });
    const offOn = labelled.length === 2 && labelled[0]!.label === 'off' && labelled[1]!.label === 'on';
    if (width === 1 || offOn) return { kind: 'bool', labelSource, unit: null, options: withStatus(labelled) };
    const parsed = labelled.map((o) => parseDisplay(o.label));
    const units = new Set(parsed.map((p) => p?.unit));
    if (parsed.every((p) => p !== null) && units.size === 1) {
      return { kind: 'continuous', labelSource, unit: parsed[0]!.unit, options: null };
    }
    return { kind: 'enum', labelSource, unit: null, options: withStatus(all) };
  }
  if (own(FIELD_DEP, key) !== undefined) return { kind: 'enum', labelSource: 'dep', unit: null, options: null };
  if (width === 1) return { kind: 'bool', labelSource: 'raw', unit: null, options: null };
  return { kind: 'continuous', labelSource: 'raw', unit: null, options: null };
}

/** A scene II copy: its scene I twin's facts, its own range and default, no placement (plan section 13.1). */
function sceneTwinOf(key: Ns4Key, twin: ParamDescriptor): ParamDescriptor {
  const f = NS4_LAYOUT.fields.get(key)!;
  if (f.width !== twin.width || f.enc !== twin.enc) throw new Error(`${key} is not laid out like ${twin.key}`);
  return {
    ...twin, key, default: f.default, min: f.enc === 'raw' ? 0 : f.min, max: f.enc === 'raw' ? 2 ** f.width - 1 : f.max,
    region: null, group: null, label: `${twin.label} · scene ii`, morphs: null,
  };
}

function build(key: Ns4Key): ParamDescriptor {
  const scene = parseSceneKey(key);
  if (scene !== null && scene.scene === 'II') return sceneTwinOf(key, build(sceneKey(scene.field, 'I')));
  const f = NS4_LAYOUT.fields.get(key)!;
  const pattern = patternOf(key);
  const cur = own(CURATED, pattern);
  const placement = PLACEMENT.get(key);
  const parent = morphParent(key);
  const opaque = cur?.kind === 'opaque' || f.enc === 'raw' || f.width >= 24;
  const min = f.enc === 'raw' ? 0 : f.min;
  const max = f.enc === 'raw' ? 2 ** f.width - 1 : f.max;

  let status: ParamStatus;
  if (placement === undefined) status = inSynthSound(key) ? 'stored' : 'layout';
  else if (placement.region.status !== 'live') status = 'layout';
  else if (cur?.status !== undefined) status = cur.status;
  else if (placement.group.status === 'stored' || placement.group.status === 'layout') status = placement.group.status;
  else throw new Error(`${key}: a control of the live region ${placement.region.id} needs a curated status`);

  let labels: Labels;
  let optionSets: OptionSets | null = null;
  if (parent !== null) labels = { kind: 'continuous', labelSource: 'raw', unit: null, options: null };
  else if (opaque) labels = { kind: 'opaque', labelSource: 'raw', unit: null, options: null };
  else if (cur?.optionsBy !== undefined) {
    const dep = cur.optionsBy.dep;
    if (!isNs4Key(dep)) throw new Error(`${key}: option dependency ${dep} is not a Stage 4 field`);
    optionSets = { dep, sets: cur.optionsBy.sets, fallback: cur.optionsBy.fallback };
    labels = { kind: 'enum', labelSource: 'manual', unit: null, options: null };
  } else if (cur?.options !== undefined) {
    const kind = cur.kind ?? 'enum';
    // A continuous field with manual labels (drawbars 0–8, the clock in BPM) has no table unit.
    labels = { kind, labelSource: 'manual', unit: kind === 'continuous' ? '' : null, options: cur.options };
  } else labels = fromTables(key, min, max, f.width, cur);

  let label = cur?.label ?? defaultLabel(key);
  if (parent !== null) {
    const source = MORPH_SOURCES.find(([, suffix]) => key.endsWith(`.${suffix}`))![2];
    label = `${own(CURATED, patternOf(parent))?.label ?? defaultLabel(parent)} · ${source} morph`;
  }
  const morphKeys = MORPH_SOURCES.map(([, suffix]) => `${key}.${suffix}`);
  const morphs = morphKeys.every((k) => NS4_LAYOUT.fields.has(k))
    ? { wheel: morphKeys[0] as Ns4Key, afterTouch: morphKeys[1] as Ns4Key, ctrlPedal: morphKeys[2] as Ns4Key }
    : null;
  const note = cur?.note ?? (labels.labelSource === 'raw' && labels.kind !== 'opaque' && parent === null
    ? 'no Stage 4 display table: the number is the stored step' : null);

  return {
    key, kind: labels.kind, min, max, default: f.default, width: f.width, enc: f.enc,
    region: placement?.region.id ?? null, group: placement?.group.id ?? null, layer: layerOf(key),
    label, unit: labels.unit, labelSource: labels.labelSource, status, options: labels.options,
    deps: optionSets !== null ? [optionSets.dep] : labels.labelSource === 'dep' ? labelDeps(key) : [],
    optionSets, morphs, note,
  };
}

/** Every field's descriptor, in layout order. */
export const DESCRIPTORS: ReadonlyMap<Ns4Key, ParamDescriptor> = new Map(NS4_KEYS.map((k) => [k, build(k)]));

export function descriptorOf(key: Ns4Key): ParamDescriptor {
  return DESCRIPTORS.get(key)!;
}

/** The options to offer now: static ones, or for a dependency table the labelled rows for the current deps. */
export function optionsFor(d: ParamDescriptor, values: ValueReader): readonly EnumOption[] {
  if (d.options !== null) return d.options;
  if (d.optionSets !== null) return d.optionSets.sets[values.get(d.optionSets.dep)] ?? d.optionSets.fallback;
  if (d.deps.length === 0) return [];
  const out: EnumOption[] = [];
  for (let v = d.min; v <= d.max; v++) {
    const label = ns4Label(d.key, v, values);
    if (label !== null && label !== NOT_DECODED) out.push({ value: v, label });
  }
  return out;
}

/** Round and clamp a value to what the field holds; every store write goes through this. */
export function clampValue(d: ParamDescriptor, value: number): number {
  if (Number.isNaN(value)) throw new TypeError(`${d.key}: value is not a number`);
  return Math.min(d.max, Math.max(d.min, Math.round(value)));
}

/** The text a value shows: the Stage 4's own label where one exists, else the number and a marker. */
export function formatValue(d: ParamDescriptor, value: number, values: ValueReader): Formatted {
  if (d.kind === 'opaque') {
    // A piano model hash the catalogue knows shows its name (model/pianos.ts).
    const model = PIANO_HASH.test(d.key) ? pianoModel(value) : null;
    if (model !== null) return { text: model.count > 1 ? `${model.label} (${model.ordinal})` : model.label, marker: null };
    const text = d.enc === 'raw' ? `0x${(value >>> 0).toString(16).padStart(8, '0')}` : String(value);
    return { text, marker: 'raw' };
  }
  if (d.labelSource === 'raw') {
    return { text: d.min < 0 && value > 0 ? `+${value}` : String(value), marker: 'raw' };
  }
  if (d.kind === 'mask' && d.options !== null) {
    const on = d.options.filter((o) => (value & o.value) !== 0).map((o) => o.label);
    return { text: on.length === 0 ? 'none' : on.join('+'), marker: null };
  }
  if (d.labelSource === 'manual' && (d.options !== null || d.optionSets !== null)) {
    const option = optionsFor(d, values).find((o) => o.value === value);
    return option === undefined ? { text: String(value), marker: 'raw' } : { text: option.label, marker: null };
  }
  const label = ns4Label(d.key, value, values);
  if (label === NOT_DECODED) return { text: String(value), marker: 'not decoded' };
  if (label === null) return { text: String(value), marker: 'raw' };
  return { text: label, marker: null };
}

/** The value in base units (seconds, hertz, dB, semitones, cents) when its label is a number, else null. */
export function toSi(d: ParamDescriptor, value: number, values: ValueReader): number | null {
  const label = ns4Label(d.key, value, values);
  const parsed = label === null ? null : parseDisplay(label);
  return parsed === null ? null : parsed.value;
}

/** Whether a field drives the sound with known units: live and labelled by the Stage 4 or the manual. */
export function verified(d: ParamDescriptor): boolean {
  return d.status === 'live' && d.labelSource !== 'raw';
}
