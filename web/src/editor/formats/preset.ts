/**
 * The editor's app preset (plan section 5.1): the whole editor state as versioned JSON, lossless
 * through save, load, download and re-import. It holds all 955 field values in layout order, the
 * name, the category and, when a .ns4p file was opened, that file's bytes in base64 as the export
 * donor (plan section 11, decision 3). It is not a Stage 4 program: neither the instrument nor
 * Nord Sound Manager reads it.
 *
 * Version policy: `schema` changes on any breaking change of the document or the layout key set.
 * MIGRATIONS[n] turns a schema n document into schema n + 1 and never drops a value silently (a
 * layout that gains fields fills them with layout defaults and returns a note). A newer schema is
 * refused, never guessed. Unknown top-level keys are ignored; unknown value keys are refused.
 * No DOM.
 */
import { crc32 } from '../../ns4/cbin.ts';
import { NordFormatError } from '../../ns4/errors.ts';
import { Ns4Program } from '../../ns4/program.ts';
import { DESCRIPTORS } from '../model/descriptors.ts';
import { NS4_KEYS, type Ns4Key } from '../model/keys.ts';
import type { ProgramSnapshot, SourceProgram } from '../model/store.ts';
import { decodeBase64Strict, encodeBase64 } from './base64.ts';

export const PRESET_FORMAT = 'nord-stage4-editor-preset';
export const PRESET_SCHEMA = 1;
export const LAYOUT_MODEL = 'Nord Stage 4';
/** Larger input is refused before parsing. */
export const MAX_PRESET_BYTES = 1024 * 1024;
/** Program categories the Stage 4 header holds (0–46, 17 = None). */
export const CATEGORY_MAX = 46;

/** crc32 over the layout keys joined by '\n', as 8 lowercase hex digits: changes when the key set does. */
export const KEYS_CRC32: string = crc32(new TextEncoder().encode(NS4_KEYS.join('\n'))).toString(16).padStart(8, '0');

/**
 * A preset that cannot be read. `short` is for the display, `message` (the full text) for the
 * print-out.
 */
export class PresetError extends Error {
  override name = 'PresetError';
  readonly short: string;

  constructor(short: string, message: string = short) {
    super(message);
    this.short = short;
  }
}

/** One migration step: a schema n document (already JSON-parsed) to schema n + 1, plus notes. */
export type Migration = (doc: Record<string, unknown>) => { doc: Record<string, unknown>; notes: string[] };

/** MIGRATIONS[n] upgrades schema n to n + 1. Empty while schema 1 is the only one. */
export const MIGRATIONS: Readonly<Record<number, Migration>> = {};

export interface PresetDocument {
  readonly format: typeof PRESET_FORMAT;
  readonly schema: number;
  readonly app: string;
  readonly layout: { readonly model: string; readonly fields: number; readonly keysCrc32: string };
  readonly name: string;
  readonly category: number;
  readonly values: Readonly<Record<string, number>>;
  readonly source: null | {
    readonly kind: 'ns4p';
    readonly fileName: string;
    readonly formatVersion: number;
    readonly bytesBase64: string;
  };
}

/** The preset document for a snapshot; values in layout order, so the output is deterministic. */
export function toPresetDocument(s: ProgramSnapshot, appVersion: string): PresetDocument {
  const values: Record<string, number> = {};
  for (const key of NS4_KEYS) values[key] = s.values[key];
  return {
    format: PRESET_FORMAT,
    schema: PRESET_SCHEMA,
    app: `nord editor ${appVersion}`,
    layout: { model: LAYOUT_MODEL, fields: NS4_KEYS.length, keysCrc32: KEYS_CRC32 },
    name: s.name,
    category: s.category,
    values,
    source: s.source === null ? null : {
      kind: 'ns4p',
      fileName: s.source.fileName,
      formatVersion: s.source.formatVersion,
      bytesBase64: encodeBase64(s.source.bytes),
    },
  };
}

/** The preset as JSON text; `indent` 0 gives one line (browser storage), the default 2 (downloads). */
export function toPresetJson(s: ProgramSnapshot, appVersion: string, indent = 2): string {
  const text = JSON.stringify(toPresetDocument(s, appVersion), null, indent);
  return indent > 0 ? `${text}\n` : text;
}

/** A program name as a file name: characters file systems refuse become '-', no leading dots, 'untitled' when empty. */
export function safeFileBase(name: string): string {
  const clean = name.replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, '-').replace(/\s+/g, ' ').trim().replace(/^\.+/, '');
  return clean === '' ? 'untitled' : clean;
}

/** '<program> · app-preset.json': clearly an app preset, with characters file systems refuse replaced. */
export function presetFileName(name: string): string {
  return `${safeFileBase(name)} · app-preset.json`;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function show(v: unknown): string {
  if (v === undefined) return 'undefined';
  const text = JSON.stringify(v);
  return text.length > 40 ? `${text.slice(0, 37)}...` : text;
}

function readSource(raw: unknown): SourceProgram | null {
  if (raw === null || raw === undefined) return null;
  const fail = (reason: string): never => {
    throw new PresetError('source program unreadable', `source program unreadable: ${reason}`);
  };
  if (!isRecord(raw)) return fail('not an object');
  if (raw['kind'] !== 'ns4p') return fail(`kind ${show(raw['kind'])} is not "ns4p"`);
  const fileName = raw['fileName'];
  if (typeof fileName !== 'string') return fail('file name missing');
  const b64 = raw['bytesBase64'];
  if (typeof b64 !== 'string') return fail('bytes missing');
  let bytes: Uint8Array;
  try {
    bytes = decodeBase64Strict(b64);
  } catch {
    return fail('bytes are not base64');
  }
  let program: Ns4Program;
  try {
    program = Ns4Program.fromBytes(bytes);
  } catch (err) {
    return fail(err instanceof NordFormatError || err instanceof RangeError ? err.message : String(err));
  }
  if (raw['formatVersion'] !== program.formatVersion) {
    return fail(`format version ${show(raw['formatVersion'])} differs from the file's ${program.formatVersion}`);
  }
  return { kind: 'ns4p', fileName, formatVersion: program.formatVersion, bytes };
}

/**
 * Parse and validate a preset; upgrade older schemas. Returns the snapshot and the migration
 * notes; throws PresetError with the messages of plan section 5.1.
 */
export function readPreset(text: string): { snapshot: ProgramSnapshot; notes: string[] } {
  if (text.length > MAX_PRESET_BYTES) {
    throw new PresetError('not a preset file', `not a preset file: larger than ${MAX_PRESET_BYTES / 1024 / 1024} MB`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new PresetError('not a preset file', `not a preset file: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!isRecord(parsed)) throw new PresetError('not a preset file', 'not a preset file: not a JSON object');
  let doc = parsed;
  if (doc['format'] !== PRESET_FORMAT) throw new PresetError('not an editor preset');
  const schema = doc['schema'];
  if (typeof schema !== 'number' || !Number.isInteger(schema) || schema < 1) {
    throw new PresetError('preset schema missing');
  }
  if (schema > PRESET_SCHEMA) {
    throw new PresetError('made by a newer editor',
      `made by a newer editor (schema ${schema}); this editor reads schema ${PRESET_SCHEMA}`);
  }
  const notes: string[] = [];
  for (let n = schema; n < PRESET_SCHEMA; n++) {
    const step = MIGRATIONS[n];
    if (step === undefined) throw new PresetError('made for another Stage 4 layout');
    const out = step(doc);
    doc = out.doc;
    notes.push(...out.notes);
  }

  const layout = doc['layout'];
  if (!isRecord(layout) || layout['model'] !== LAYOUT_MODEL || layout['keysCrc32'] !== KEYS_CRC32) {
    throw new PresetError('made for another Stage 4 layout');
  }

  const raw = doc['values'];
  if (!isRecord(raw)) throw new PresetError('preset values invalid', 'values missing');
  const values = {} as Record<Ns4Key, number>;
  for (const key of NS4_KEYS) {
    if (!Object.hasOwn(raw, key)) throw new PresetError('preset values invalid', `${key}: missing`);
    const v = raw[key];
    if (typeof v !== 'number' || !Number.isInteger(v)) {
      throw new PresetError('preset values invalid', `${key}: ${show(v)} is not an integer`);
    }
    const d = DESCRIPTORS.get(key)!;
    if (v < d.min || v > d.max) throw new PresetError('preset values invalid', `${key}: ${v} is outside ${d.min}..${d.max}`);
    values[key] = v;
  }
  for (const key of Object.keys(raw)) {
    if (!DESCRIPTORS.has(key as Ns4Key)) throw new PresetError('preset values invalid', `${key}: unknown field`);
  }

  const name = doc['name'];
  if (typeof name !== 'string') throw new PresetError('name invalid');
  const category = doc['category'];
  if (typeof category !== 'number' || !Number.isInteger(category) || category < 0 || category > CATEGORY_MAX) {
    throw new PresetError('category invalid');
  }
  const source = readSource(doc['source']);
  return { snapshot: { name, category, values, source }, notes };
}

/** readPreset without the notes. */
export function parsePreset(text: string): ProgramSnapshot {
  return readPreset(text).snapshot;
}
