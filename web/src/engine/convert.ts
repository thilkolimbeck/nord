/**
 * One Stage 3 file in, one verified Stage 4 file out (port of nordconv/convert.py, without the
 * file system part).
 *
 * The rule is "never return a broken file": the output is built in memory, parsed again with
 * the strict reader, and compared field by field with what the mapping asked for and with the
 * neutral template before it is returned.
 */
import { HEADER_BYTES, reprHeader } from './cbin.ts';
import { ConversionError, NordFormatError } from './errors.ts';
import { NS4_LAYOUT } from './layout.ts';
import { mapProgram } from './mapping.ts';
import { Ns3Program, Ns4Program } from './program.ts';
import { CATEGORY_NONE, loadTemplate, TARGET_VERSION } from './template.ts';

export const OUTPUT_SUFFIX = '.ns4p';
/** Stage 3 "no category" sentinel; real ids share the Stage 4 table (opennord clavia/categories.ts). */
export const CATEGORY_UNSET = 0xffffffff;
export const CATEGORY_MAX = 46;

/** A finished conversion: the file's bytes, the field edits, the warnings and the notes. */
export interface Converted {
  readonly data: Uint8Array;
  readonly edits: ReadonlyMap<string, number>;
  readonly warnings: readonly string[];
  readonly notes: readonly string[];
}

/** What convert() returns: the .ns4p bytes, the warnings, and the notes about switched-off sections. */
export interface ConvertResult {
  output: Uint8Array;
  warnings: string[];
  notes: string[];
}

/** The Stage 4 header category, and a warning when the Stage 3 id had to be replaced. */
export function ns4Category(ns3Category: number): [number, string] {
  if (ns3Category === CATEGORY_UNSET) return [CATEGORY_NONE, ''];
  if (ns3Category >= 0 && ns3Category <= CATEGORY_MAX) return [ns3Category, ''];
  return [CATEGORY_NONE, `Header: category ${ns3Category} is not a known id, set to None`];
}

/**
 * Convert a whole .ns3f file against a neutralised template (see loadTemplate);
 * NordFormatError for a bad input, ConversionError for a bad output.
 */
export function convertBytes(ns3Data: Uint8Array, template: Ns4Program): Converted {
  const source = Ns3Program.fromBytes(ns3Data);
  const result = mapProgram(source);
  const [category, categoryWarning] = ns4Category(source.header.category);
  const out = new Ns4Program({ ...template.header, category }, template.body);
  for (const [key, value] of result.edits) out.set(key, value);
  const data = out.toBytes();
  verify(data, template, result.edits, category);
  const warnings = categoryWarning ? [...result.warnings, categoryWarning] : [...result.warnings];
  return { data, edits: result.edits, warnings, notes: result.notes };
}

let uncovered: Uint8Array | undefined;

/** A body-sized mask with a 1 bit for every bit no layout field covers. */
function uncoveredMask(): Uint8Array {
  if (uncovered === undefined) {
    const covered = new Uint8Array(NS4_LAYOUT.bodyBytes);
    for (const f of NS4_LAYOUT.fields.values()) {
      for (let bit = f.bodyBit; bit < f.bodyBit + f.width; bit++) covered[bit >> 3] = covered[bit >> 3]! | (0x80 >> (bit & 7));
    }
    uncovered = covered.map((b) => ~b & 0xff);
  }
  return uncovered;
}

/** Re-read an output and check it against the plan; ConversionError on any difference. */
export function verify(data: Uint8Array, template: Ns4Program, edits: ReadonlyMap<string, number>,
  category: number): void {
  const expectedSize = HEADER_BYTES + NS4_LAYOUT.bodyBytes;
  if (data.length !== expectedSize) {
    throw new ConversionError(`output is ${data.length} bytes, expected ${expectedSize}`);
  }
  let back: Ns4Program;
  try {
    back = Ns4Program.fromBytes(data); // magic, tag, formatType, CRC, block chain, body size
  } catch (exc) {
    if (exc instanceof NordFormatError) throw new ConversionError(`output does not parse: ${exc.message}`);
    throw exc;
  }
  const header = back.header;
  if (header.version !== TARGET_VERSION || back.formatVersion !== TARGET_VERSION) {
    throw new ConversionError(`output versions ${header.version}/${back.formatVersion}, expected ${TARGET_VERSION}`);
  }
  if (header.bank !== 0 || header.location !== 0 || header.category !== category) {
    throw new ConversionError(`output header ${reprHeader(header)} differs from bank 0, location 0, `
      + `category ${category}`);
  }
  for (const key of NS4_LAYOUT.fields.keys()) {
    const want = edits.get(key) ?? template.value(key);
    if (back.value(key) !== want) {
      throw new ConversionError(`${key} reads back ${back.value(key)}, expected ${want}`);
    }
  }
  const mask = uncoveredMask();
  const a = back.body;
  const b = template.body;
  for (let i = 0; i < mask.length; i++) {
    if ((a[i]! ^ b[i]!) & mask[i]!) throw new ConversionError('undecoded template bits changed');
  }
}

/**
 * Convert one .ns3f file. `template` is a donor .ns4p (normally TEMPLATE_BYTES); it is
 * neutralised before use. Throws NordFormatError (message identical to the Python converter)
 * when the input is not a valid Stage 3 program, and ConversionError when the template is
 * unusable or the output fails its verification. `name`, when given, is attached to the thrown
 * error as `fileName`; it never changes a message, an output byte or a warning.
 */
export function convert(input: Uint8Array, template: Uint8Array, name?: string): ConvertResult {
  try {
    let donor: Ns4Program;
    try {
      donor = loadTemplate(template);
    } catch (exc) {
      if (exc instanceof NordFormatError) throw new ConversionError(`template unusable: ${exc.message}`);
      throw exc;
    }
    const converted = convertBytes(input, donor);
    return { output: converted.data, warnings: [...converted.warnings], notes: [...converted.notes] };
  } catch (exc) {
    if (name !== undefined && (exc instanceof NordFormatError || exc instanceof ConversionError)) exc.fileName = name;
    throw exc;
  }
}
