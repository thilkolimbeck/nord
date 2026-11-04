/**
 * The check every written Stage 4 file passes before it leaves the app: "never return a broken
 * file". The output is parsed again with the strict reader and compared field by field with
 * what was asked for, and every bit no layout field covers with the donor's.
 */
import { HEADER_BYTES, reprHeader } from './cbin.ts';
import { ConversionError, NordFormatError } from './errors.ts';
import { NS4_LAYOUT } from './layout.ts';
import { Ns4Program } from './program.ts';
import { TARGET_VERSION } from './template.ts';

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

/**
 * Re-read a written file and check it against the plan: `template` is the donor it was patched
 * into, `edits` the fields written over it, `category` the header category. ConversionError on
 * any difference.
 */
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
