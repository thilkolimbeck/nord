/**
 * What a control shows, without the DOM: the value text and its markers, the range, the
 * description that aria-describedby points at, the morph indicator, the display lines, and which
 * key a control binds to when the focused layer changes. controls.ts and display.ts render these;
 * the tests check them in Node.
 */
import { type EnumOption, formatValue, optionsFor, type ParamDescriptor } from '../model/descriptors.ts';
import { layerKey, layerOf, type Ns4Key, patternOf, type SynthLayer } from '../model/keys.ts';
import type { ValueReader } from '../model/labels.ts';

/** How a descriptor is drawn: a fader, a select, a small key, three mask keys, or a read-only readout. */
export type ControlKind = 'fader' | 'select' | 'key' | 'mask' | 'readout';

/** Controls the browser engine only approximates (plan section 11, decision 2): the filter drive. */
export const COARSE_PATTERNS: ReadonlySet<string> = new Set(['synth{L}Sound.fltDrive']);

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
  /** The suffixes after the value, in order: 'nv', 'coarse'. */
  readonly suffixes: readonly string[];
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

/** Whether a switch's labels are the plain 'off'/'on' (then the key's pressed state says it all). */
export function isOffOn(d: ParamDescriptor): boolean {
  const o = d.options;
  return o === null || (o.length === 2 && o[0]!.label === 'off' && o[1]!.label === 'on');
}

export function valueView(d: ParamDescriptor, value: number, values: ValueReader, coarse = isCoarse(d)): ValueView {
  const f = formatValue(d, value, values);
  const nv = d.status === 'unverified' || f.marker !== null;
  const stored = d.status === 'stored';
  const suffixes: string[] = [];
  if (nv) suffixes.push('nv');
  if (coarse) suffixes.push('coarse');
  return { text: f.text, nv, coarse, stored, suffixes };
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

/** The key a control shows for the focused layer: the same field of that layer; layer-free keys stay. */
export function keyForLayer(key: Ns4Key, layer: SynthLayer): Ns4Key {
  return layerOf(key) === null ? key : layerKey(layer, patternOf(key));
}

/** Display line 2: 'a · freq · 1.2 kHz · 14 Hz–32 kHz' (value with ' nv' or ' coarse' when marked). */
export function displayParamLine(d: ParamDescriptor, value: number, values: ValueReader, coarse = isCoarse(d)): string {
  const v = valueView(d, value, values, coarse);
  const where = d.layer === null ? (d.region ?? 'program') : d.layer.toLowerCase();
  const text = [v.text, ...v.suffixes].join(' ');
  const range = rangeText(d, values);
  return [where, d.label, text, ...(range === '' ? [] : [range])].join(' · ');
}

/** Display line 3: the touched parameter's status, then the edit count: 'not verified · edited 3'. */
export function displayStateLine(d: ParamDescriptor | null, value: number, values: ValueReader, edited: number): string {
  let status: string | null = null;
  if (d !== null) {
    const v = valueView(d, value, values);
    status = v.stored ? STORED_LINE : v.nv ? 'not verified' : v.coarse ? 'coarse' : 'live';
  }
  return [status, `edited ${edited}`].filter((s) => s !== null).join(' · ');
}
