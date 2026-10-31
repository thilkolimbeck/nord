/**
 * Stage 3 and Stage 4 programs: validated bodies decoded into named fields (port of
 * nordconv/program.py).
 *
 * A body is a u32 big-endian format version followed by length-prefixed blocks of MSB-first
 * bit fields that end exactly at the end of the file. Both classes refuse a body whose chain
 * does not match their layout. Ns4Program is also the writer: a new file is made by patching a
 * donor program in place.
 */
import { readBits, writeBits } from './bits.ts';
import { buildCbin, FORMAT_NSM, parseCbin, type CbinHeader } from './cbin.ts';
import { NordFormatError } from './errors.ts';
import { ADDED_IN } from './generated/tables-ns3.ts';
import { fieldOf, NS3_LAYOUT, NS4_LAYOUT, type Field, type Layout } from './layout.ts';
import { fixed, reprPairs, reprStr } from './pyfmt.ts';

/**
 * A decoded field: the stored bits, what they mean, and whether that is valid. `stored` is
 * false for a field the body's format version does not hold yet; `value` is then its default.
 */
export interface FieldValue {
  readonly raw: number;
  readonly value: number;
  readonly inRange: boolean;
  readonly stored: boolean;
}

/** The format version and [offset, length] of each block; NordFormatError if the chain is broken. */
export function walkBlockChain(body: Uint8Array): [number, Array<[number, number]>] {
  if (body.length < 5) {
    throw new NordFormatError(`body is ${body.length} bytes, too short for a format version and a block`);
  }
  const version = new DataView(body.buffer, body.byteOffset, body.byteLength).getUint32(0, false);
  const blocks: Array<[number, number]> = [];
  let pos = 4;
  while (pos < body.length) {
    const length = body[pos]!;
    if (pos + 1 + length > body.length) {
      throw new NordFormatError(`block ${blocks.length + 1} at body byte ${pos} claims ${length} bytes, `
        + `only ${body.length - pos - 1} remain`);
    }
    blocks.push([pos, length]);
    pos += 1 + length;
  }
  return [version, blocks];
}

function checkChain(body: Uint8Array, layout: Layout): number {
  if (body.length !== layout.bodyBytes) {
    throw new NordFormatError(`${layout.model} body is ${body.length} bytes, expected ${layout.bodyBytes}`);
  }
  const [version, blocks] = walkBlockChain(body);
  const [lo, hi] = layout.versionRange;
  if (!(lo <= version && version <= hi)) {
    throw new NordFormatError(`format version ${fixed(version / 100, 2)} is outside the `
      + `${fixed(lo / 100, 2)}-${fixed(hi / 100, 2)} range of the ${layout.model} layout`);
  }
  const expected = layout.blocks.map((b) => [b.offset, b.length]);
  const same = blocks.length === expected.length
    && blocks.every(([o, l], i) => o === expected[i]![0] && l === expected[i]![1]);
  if (!same) {
    throw new NordFormatError(`block chain ${reprPairs(blocks)} does not match the ${layout.model} layout `
      + reprPairs(expected));
  }
  return version;
}

/** Shared read side: header, validated body, field access, serialisation. */
export abstract class Program {
  readonly layout: Layout;
  readonly tag: string;
  readonly formatVersion: number;
  readonly header: CbinHeader;
  protected readonly bodyBytes: Uint8Array;

  protected constructor(layout: Layout, tag: string, header: CbinHeader, body: Uint8Array) {
    this.layout = layout;
    this.tag = tag;
    this.formatVersion = checkChain(body, layout);
    this.header = header;
    this.bodyBytes = Uint8Array.from(body);
  }

  /** A copy of the body. */
  get body(): Uint8Array {
    return Uint8Array.from(this.bodyBytes);
  }

  field(key: string): Field {
    return fieldOf(this.layout, key);
  }

  /** Field keys in layout (bit) order. */
  keys(): IterableIterator<string> {
    return this.layout.fields.keys();
  }

  raw(key: string): number {
    const f = this.field(key);
    return readBits(this.bodyBytes, f.bodyBit, f.width);
  }

  get(key: string): FieldValue {
    const f = this.field(key);
    const raw = readBits(this.bodyBytes, f.bodyBit, f.width);
    const value = f.decode(raw);
    return { raw, value, inRange: f.inRange(value), stored: true };
  }

  value(key: string): number {
    return this.get(key).value;
  }

  /** Every layout field, by key. */
  decode(): Map<string, FieldValue> {
    return new Map(Array.from(this.layout.fields.keys(), (key) => [key, this.get(key)]));
  }

  /** The file, in the header's own format type, with a fresh checksum. */
  toBytes(): Uint8Array {
    if (this.header.tag !== this.tag) {
      throw new NordFormatError(`header tag ${reprStr(this.header.tag)} is not ${reprStr(this.tag)}`);
    }
    return buildCbin(this.header, this.bodyBytes);
  }
}

/** Stage 3 fields a body of `version` does not store (opennord ns3/decode.ts ADDED_IN). */
function absentBefore(version: number): ReadonlySet<string> {
  return new Set(ADDED_IN.filter((entry) => version < entry.before).flatMap((entry) => entry.keys));
}

/**
 * A Stage 3 program (.ns3f), formatType 0 or 1, format 3.00-3.04. Read only. The value
 * fix-ups the Stage 3 applies to old bodies on load are applied by source.ts.
 */
export class Ns3Program extends Program {
  static readonly TAG = 'ns3f';
  private readonly absent: ReadonlySet<string>;

  constructor(header: CbinHeader, body: Uint8Array) {
    super(NS3_LAYOUT, Ns3Program.TAG, header, body);
    this.absent = absentBefore(this.formatVersion);
  }

  /** Parse a whole file; NordFormatError when it is not a valid Stage 3 program. */
  static fromBytes(data: Uint8Array): Ns3Program {
    const parsed = parseCbin(data, Ns3Program.TAG);
    return new Ns3Program(parsed.header, parsed.body);
  }

  override get(key: string): FieldValue {
    const fv = super.get(key);
    if (this.absent.has(key)) {
      return { raw: fv.raw, value: this.field(key).default, inRange: true, stored: false };
    }
    return fv;
  }
}

/** A Stage 4 program (.ns4p), formatType 1, format 3.07-3.13, editable in place. */
export class Ns4Program extends Program {
  static readonly TAG = 'ns4p';

  constructor(header: CbinHeader, body: Uint8Array) {
    if (header.formatType !== FORMAT_NSM) {
      throw new NordFormatError(`Stage 4 programs use CBIN formatType ${FORMAT_NSM}, got ${header.formatType}`);
    }
    super(NS4_LAYOUT, Ns4Program.TAG, header, body);
  }

  /** Parse a whole file; NordFormatError when it is not a valid Stage 4 program. */
  static fromBytes(data: Uint8Array): Ns4Program {
    const parsed = parseCbin(data, Ns4Program.TAG);
    return new Ns4Program(parsed.header, parsed.body);
  }

  /** Re-encode one field; RangeError when `value` is outside its range. */
  set(key: string, value: number): void {
    const f = this.field(key);
    writeBits(this.bodyBytes, f.bodyBit, f.width, f.encode(value));
  }

  /** The file with a fresh CRC-32; refuses a header that disagrees with the body. */
  override toBytes(): Uint8Array {
    if (this.header.formatType !== FORMAT_NSM) {
      throw new NordFormatError(`Stage 4 programs use CBIN formatType ${FORMAT_NSM}`);
    }
    if (this.header.version !== this.formatVersion) {
      throw new NordFormatError(`header version ${this.header.version} differs from body version `
        + `${this.formatVersion}`);
    }
    return super.toBytes();
  }
}
