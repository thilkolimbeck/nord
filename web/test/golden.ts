/**
 * Loads web/test/golden/golden.json (written by tools/make_golden.py) and rebuilds expected outputs.
 * golden-local.json, the same shape for the private sample program, is gitignored and optional.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { ConversionError, convert, NordFormatError, TEMPLATE_BYTES } from '../src/engine/index.ts';

export interface GoldenError {
  type: string;
  message: string;
}

export interface GoldenEntry {
  sha256?: string;
  input?: string;
  patch?: Array<[number, string]>;
  warnings?: number[];
  notes?: number[];
  error?: GoldenError;
}

export interface Golden {
  reference: string;
  messages: string[];
  fixtures: Record<string, GoldenEntry>;
  cases: Record<string, GoldenEntry>;
}

export const FIXTURES = new URL('./fixtures/', import.meta.url);
/** Fixture paths under this folder belong to the private sample: golden-local.json covers them, not golden.json. */
export const LOCAL_FIXTURE_DIR = 'presets/';
export const golden = readGolden('./golden/golden.json') ?? assert.fail('web/test/golden/golden.json is missing');
/** The private sample's manifest, or null in a public checkout (see LOCAL_FIXTURE_DIR). */
export const goldenLocal = readGolden('./golden/golden-local.json');

function readGolden(path: string): Golden | null {
  const url = new URL(path, import.meta.url);
  return existsSync(url) ? JSON.parse(readFileSync(url, 'utf8')) as Golden : null;
}

export function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  return Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
}

/** The expected output of an entry: its manifest's reference with the entry's patch runs written over it. */
export function expectedOutput(entry: GoldenEntry, from: Golden = golden): Uint8Array {
  const out = fromBase64(from.reference);
  for (const [offset, hex] of entry.patch ?? []) {
    for (let i = 0; i < hex.length; i += 2) out[offset + i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return out;
}

export function messages(indices: number[] | undefined, from: Golden = golden): string[] {
  return (indices ?? []).map((i) => {
    const text = from.messages[i];
    if (text === undefined) throw new Error(`golden message index ${i} is out of range`);
    return text;
  });
}

/** The first offset where two byte arrays differ, or -1. */
export function firstDifference(a: Uint8Array, b: Uint8Array): number {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return -1;
}

/** Compare one conversion with its golden entry; returns a description of the first mismatch, or null. */
export function compare(input: Uint8Array, entry: GoldenEntry, from: Golden = golden): string | null {
  let result: ReturnType<typeof convert>;
  try {
    result = convert(input, TEMPLATE_BYTES);
  } catch (exc) {
    if (!entry.error) return `threw ${String(exc)}, expected an output`;
    const message = exc instanceof Error ? exc.message : String(exc);
    if (message !== entry.error.message) return `error message ${JSON.stringify(message)}, expected ${JSON.stringify(entry.error.message)}`;
    if (entry.error.type === 'NordFileError' && !(exc instanceof NordFormatError)) return `threw ${String(exc)}, expected a NordFormatError`;
    if (entry.error.type === 'ConversionError' && !(exc instanceof ConversionError)) return `threw ${String(exc)}, expected a ConversionError`;
    return null;
  }
  if (entry.error) return `converted, expected ${entry.error.type}: ${entry.error.message}`;
  const want = expectedOutput(entry, from);
  const at = firstDifference(result.output, want);
  if (at >= 0) return `output differs at byte ${at} (0x${at.toString(16)}): ${result.output[at]} vs ${want[at]}`;
  try {
    assert.deepEqual(result.warnings, messages(entry.warnings, from));
    assert.deepEqual(result.notes, messages(entry.notes, from));
  } catch (exc) {
    return exc instanceof Error ? exc.message : String(exc);
  }
  return null;
}
