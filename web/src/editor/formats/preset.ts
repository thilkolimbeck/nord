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
import { LAYERS, NS4_KEYS, type Ns4Key } from '../model/keys.ts';
import type { ProgramSnapshot, SourceProgram } from '../model/store.ts';
import {
  HASH_RE, layerSamplesJson, type LayerSamples, parseLayerSamples, type SampleHash, type UserSampleRef,
} from '../model/user-samples.ts';
import { decodeBase64Strict, encodeBase64 } from './base64.ts';
import { contentHashSync, type EmbeddedSample, MAX_PRESET_WITH_SAMPLES_BYTES, MAX_SAMPLE_BYTES } from './samples-db.ts';

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
  const limit = presetSizeLimit(text);
  if (text.length > limit) {
    throw new PresetError('not a preset file', `not a preset file: larger than ${limit / 1024 / 1024} MB`);
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

// ---------------------------------------------------------------------------------------------
// Own samples in app presets (plan section 15.3): optional top-level members `userSamples` (the
// layers' sample references) and `embeddedSamples` (file bytes, only in a download the user asked
// to embed). Schema 1 stays: readers before section 15 ignore unknown top-level members.

/** What an app preset carries besides the program. */
export interface PresetExtras {
  readonly samples: LayerSamples;
  /** Files to embed, by hash; empty for browser slots and plain downloads. */
  readonly embedded: ReadonlyMap<SampleHash, EmbeddedSample>;
}

export const NO_EXTRAS: PresetExtras = { samples: {}, embedded: new Map() };

/** The size limit for a preset text: 1 MB, or 48 MB when it embeds own samples (plan 15.3). */
export function presetSizeLimit(text: string): number {
  return text.includes('"embeddedSamples"') ? MAX_PRESET_WITH_SAMPLES_BYTES : MAX_PRESET_BYTES;
}

/**
 * The preset JSON with its extras: `userSamples` whenever a layer has an own sample (browser slots
 * and the working copy too), `embeddedSamples` only for the files given, and only those an
 * assignment uses (no unrelated sample leaves the device by accident). Keys sorted: deterministic.
 */
export function toPresetJsonWith(s: ProgramSnapshot, appVersion: string, extras: PresetExtras, indent = 2): string {
  const doc: Record<string, unknown> = { ...toPresetDocument(s, appVersion) };
  const samples = layerSamplesJson(extras.samples);
  if (samples !== null) doc['userSamples'] = samples;
  const used = new Set(Object.values(samples ?? {}).map((r) => r.hash));
  const embedded: Record<string, EmbeddedSample> = {};
  for (const hash of [...extras.embedded.keys()].sort()) {
    const e = extras.embedded.get(hash)!;
    if (used.has(hash)) embedded[hash] = { name: e.name, mime: e.mime, bytesBase64: e.bytesBase64 };
  }
  if (Object.keys(embedded).length > 0) doc['embeddedSamples'] = embedded;
  const text = JSON.stringify(doc, null, indent);
  return indent > 0 ? `${text}\n` : text;
}

/** One embedded file for a download: its bytes as base64. */
export function embeddedSample(name: string, mime: string, bytes: ArrayBuffer | Uint8Array): EmbeddedSample {
  return { name, mime, bytesBase64: encodeBase64(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)) };
}

/** The file bytes of an embedded sample (readPresetExtras has checked them against their hash). */
export function embeddedBytes(e: EmbeddedSample): Uint8Array {
  return decodeBase64Strict(e.bytesBase64);
}

function parseEmbedded(v: unknown): { embedded: Map<SampleHash, EmbeddedSample>; notes: string[] } {
  const embedded = new Map<SampleHash, EmbeddedSample>();
  const notes: string[] = [];
  if (v === undefined || v === null) return { embedded, notes };
  if (!isRecord(v)) return { embedded, notes: ['embedded samples: not an object, ignored'] };
  for (const [hash, raw] of Object.entries(v)) {
    const label = isRecord(raw) && typeof raw['name'] === 'string' ? `"${raw['name']}"` : hash.slice(0, 15);
    const drop = (why: string): void => {
      notes.push(`embedded sample ${label}: ${why}, ignored`);
    };
    if (!HASH_RE.test(hash)) {
      drop('hash invalid');
      continue;
    }
    if (!isRecord(raw)) {
      drop('not an object');
      continue;
    }
    const { name, mime, bytesBase64 } = raw;
    if (typeof name !== 'string' || typeof mime !== 'string' || typeof bytesBase64 !== 'string') {
      drop('name, type or bytes missing');
      continue;
    }
    // Base64 is 4 characters per 3 bytes: refuse an oversized file before decoding it.
    if (bytesBase64.length > Math.ceil(MAX_SAMPLE_BYTES / 3) * 4) {
      drop(`larger than ${MAX_SAMPLE_BYTES / 1024 / 1024} MB`);
      continue;
    }
    let bytes: Uint8Array;
    try {
      bytes = decodeBase64Strict(bytesBase64);
    } catch {
      drop('bytes are not base64');
      continue;
    }
    if (contentHashSync(bytes) !== hash) {
      drop('the bytes do not match their hash');
      continue;
    }
    embedded.set(hash, { name, mime, bytesBase64 });
  }
  return { embedded, notes };
}

/**
 * The extras of a preset text (call after readPreset accepted it), with notes for bad entries:
 * a bad reference or embedded file is dropped, the program still loads. Every embedded file is
 * checked against its hash.
 */
export function readPresetExtras(text: string): PresetExtras & { readonly notes: readonly string[] } {
  let parsed: unknown;
  try {
    parsed = text.length > presetSizeLimit(text) ? null : JSON.parse(text);
  } catch {
    parsed = null;
  }
  if (!isRecord(parsed)) return { ...NO_EXTRAS, notes: [] };
  const { samples, notes } = parseLayerSamples(parsed['userSamples']);
  const embedded = parseEmbedded(parsed['embeddedSamples']);
  return { samples, embedded: embedded.embedded, notes: [...notes, ...embedded.notes] };
}

/** The note for a layer whose own sample is not on this device (plan 15.3). */
export function missingSampleNote(layer: string, ref: Pick<UserSampleRef, 'name'>): string {
  return `layer ${layer.toLowerCase()}: own sample "${ref.name}" is not on this device: import the file again `
    + 'or load the preset that embeds it';
}

/** The notes for every assigned layer whose sample `have` does not know, in layer order. */
export function missingSampleNotes(samples: LayerSamples, have: (hash: SampleHash) => boolean): string[] {
  const notes: string[] = [];
  for (const layer of LAYERS) {
    const ref = samples[layer];
    if (ref !== undefined && !have(ref.hash)) notes.push(missingSampleNote(layer, ref));
  }
  return notes;
}

/** The print-out line after a load stored embedded files: "2 own samples stored on this device". */
export function storedSamplesNote(count: number): string {
  return `${count} own sample${count === 1 ? '' : 's'} stored on this device`;
}

/**
 * The files to embed in a download: every assigned sample the store has, plus notes for those it
 * has not (the download then carries the reference only). `get` is SampleStore.get.
 */
export async function collectEmbedded(samples: LayerSamples,
  get: (hash: SampleHash) => Promise<{ readonly meta: { readonly name: string; readonly mime: string };
    readonly bytes: ArrayBuffer } | null>): Promise<{ embedded: Map<SampleHash, EmbeddedSample>; notes: string[] }> {
  const embedded = new Map<SampleHash, EmbeddedSample>();
  const notes: string[] = [];
  for (const layer of LAYERS) {
    const ref = samples[layer];
    if (ref === undefined || embedded.has(ref.hash)) continue;
    let found: Awaited<ReturnType<typeof get>>;
    try {
      found = await get(ref.hash);
    } catch (err) {
      notes.push(`layer ${layer.toLowerCase()}: own sample "${ref.name}" not embedded: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    if (found === null) notes.push(missingSampleNote(layer, ref));
    else embedded.set(ref.hash, embeddedSample(found.meta.name, found.meta.mime, found.bytes));
  }
  return { embedded, notes };
}
