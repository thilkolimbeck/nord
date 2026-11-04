/**
 * The parameter report (plan section 5.5, AC 13): plain text for reading, listing every field
 * whose value differs from a baseline (the editor's init program), with section, layer, label,
 * value and unit, and markers for values that are not verified or not played by the editor. It is
 * not a program file and says so in its first lines; nothing can import it.
 *
 * Order: the panel (sections.ts), region by region; inside a region the layer-free groups first,
 * then every group of layer a, b and c. Fields without a control (morph amounts, scene II copies,
 * reserved and opaque fields) follow in layout order. No DOM.
 */
import { CATEGORY_NONE } from '../../ns4/template.ts';
import { type ParamDescriptor, DESCRIPTORS, formatValue } from '../model/descriptors.ts';
import { LAYERS, NS4_KEYS, type Ns4Key, type SynthLayer, layerOf } from '../model/keys.ts';
import type { ValueReader } from '../model/labels.ts';
import { HIDDEN, keysOf, PANEL } from '../model/sections.ts';
import type { ProgramSnapshot } from '../model/store.ts';
import { safeFileBase } from './preset.ts';

export const NOT_A_PROGRAM =
  'This is not a program file. The Stage 4, Nord Sound Manager and this editor cannot import it.';
const NOT_VERIFIED = '[not verified]';
const NOT_IMPLEMENTED = '[not implemented]';
const LABEL_WIDTH = 30;
const VALUE_WIDTH = 34;

export interface ReportOptions {
  /** The editor version, as in app presets. */
  readonly appVersion: string;
  /** The date printed in the header, 'YYYY-MM-DD'. */
  readonly date: string;
  /** What the baseline is, for the header. Default: the editor's init program. */
  readonly baselineName?: string;
}

/** '<program> · parameter-report.txt'. */
export function reportFileName(name: string): string {
  return `${safeFileBase(name)} · parameter-report.txt`;
}

function reader(values: Readonly<Record<Ns4Key, number>>): ValueReader {
  return { get: (key: Ns4Key) => values[key] };
}

/** The value with its unit (the Stage 4 label carries it) and the markers that apply. */
function shown(d: ParamDescriptor, value: number, values: ValueReader): { text: string; markers: string[] } {
  const f = formatValue(d, value, values);
  const markers: string[] = [];
  if (d.status === 'unverified' || f.marker !== null) markers.push(NOT_VERIFIED);
  const option = d.options?.find((o) => o.value === value);
  if (d.status === 'stored' || d.status === 'layout' || option?.status === 'layout') markers.push(NOT_IMPLEMENTED);
  return { text: f.text, markers };
}

function line(d: ParamDescriptor, s: ProgramSnapshot, base: ProgramSnapshot): string {
  const now = shown(d, s.values[d.key], reader(s.values));
  const was = formatValue(d, base.values[d.key], reader(base.values)).text;
  const value = [now.text, ...now.markers].join(' ');
  const label = d.label.length >= LABEL_WIDTH - 1 ? `${d.label}  ` : d.label.padEnd(LABEL_WIDTH);
  const shownValue = value.length >= VALUE_WIDTH - 1 ? `${value}  ` : value.padEnd(VALUE_WIDTH);
  return `  ${label}${shownValue}init ${was}`;
}

interface Block {
  readonly heading: string;
  readonly keys: readonly Ns4Key[];
}

function layerName(layer: SynthLayer | null): string[] {
  return layer === null ? [] : [`layer ${layer.toLowerCase()}`];
}

/** Every key in report order, grouped under its heading. */
function blocks(): Block[] {
  const out: Block[] = [];
  for (const region of PANEL) {
    for (const layer of [null, ...LAYERS]) {
      for (const group of region.groups) {
        const keys = keysOf(group, null).filter((k) => layerOf(k) === layer);
        if (keys.length === 0) continue;
        const parts = [region.title, ...layerName(layer)];
        if (group.title !== region.title) parts.push(group.title);
        out.push({ heading: parts.join(' · '), keys });
      }
    }
  }
  const hidden = new Set(HIDDEN);
  for (const layer of [null, ...LAYERS]) {
    const keys = NS4_KEYS.filter((k) => hidden.has(k) && layerOf(k) === layer);
    if (keys.length > 0) out.push({ heading: ['no control', ...layerName(layer)].join(' · '), keys });
  }
  return out;
}

let ORDER: Block[] | undefined;

/**
 * The report text for `s` against `baseline`: header, then one block per heading with changed
 * values, then the count. Deterministic for the same inputs.
 */
export function parameterReport(s: ProgramSnapshot, baseline: ProgramSnapshot, opts: ReportOptions): string {
  ORDER ??= blocks();
  const name = s.name.trim() === '' ? 'untitled' : s.name.trim();
  const out: string[] = [
    'nord stage 4 parameter report, for reading only',
    NOT_A_PROGRAM,
    `program: ${name} · nord editor ${opts.appVersion} · ${opts.date}`,
    `category: ${s.category === CATEGORY_NONE ? `${s.category} (none)` : String(s.category)}`,
  ];
  if (s.source !== null) {
    out.push(`opened from: ${s.source.fileName} (format ${(s.source.formatVersion / 100).toFixed(2)})`);
  }
  out.push(
    `baseline: ${opts.baselineName ?? "the editor's init program (Stage 4 layout defaults, synth on, layer A on)"}`,
    `${NOT_VERIFIED} = no Stage 4 display label or an unverified meaning; the number is the stored step.`,
    `${NOT_IMPLEMENTED} = the editor does not play this; the value is stored and exported as set.`,
    '',
  );
  let changed = 0;
  for (const block of ORDER) {
    const lines = block.keys
      .filter((k) => s.values[k] !== baseline.values[k])
      .map((k) => line(DESCRIPTORS.get(k)!, s, baseline));
    if (lines.length === 0) continue;
    changed += lines.length;
    out.push(block.heading, ...lines);
  }
  if (changed === 0) out.push('no value differs from the baseline');
  else out.push('', `${changed} changed ${changed === 1 ? 'value' : 'values'}`);
  return `${out.join('\n')}\n`;
}
