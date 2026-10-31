/**
 * The CBIN container shared by Nord program files (port of nordconv/cbin.py).
 *
 *     0x00 "CBIN"  0x04 u32 LE formatType  0x08 4-char tag  0x0C u16 LE bank
 *     0x0E u16 LE location  0x10 u32 LE category  0x14 u32 LE version x100
 *
 * formatType 1 (NSM era) then has the CRC-32 (zlib) of bytes [0x2C:] at 0x18, 16 zero bytes,
 * and the body from 0x2C to the end. formatType 0 (legacy) has the body from 0x18 and closes
 * with a 2-byte LE CRC-16/CCITT-FALSE over everything before it. The program name is not
 * stored: it is the filename. The parser is strict on purpose.
 */
import { NordFormatError } from './errors.ts';
import { hex, reprBytes, reprStr } from './pyfmt.ts';

export const MAGIC = new Uint8Array([0x43, 0x42, 0x49, 0x4e]); // "CBIN"
export const FORMAT_LEGACY = 0;
export const FORMAT_NSM = 1;
export const HEADER_BYTES = 0x2c;
export const LEGACY_BODY_OFFSET = 0x18;
export const LEGACY_TRAILER_BYTES = 2;
export const CRC_OFFSET = 0x18;

/** The header fields that carry meaning (CRC and reserved words are derived). */
export interface CbinHeader {
  readonly formatType: number;
  readonly tag: string;
  readonly bank: number;
  readonly location: number;
  readonly category: number;
  readonly version: number;
}

/** A parsed container: header plus the instrument's record (the body). */
export interface CbinFile {
  readonly header: CbinHeader;
  readonly body: Uint8Array;
}

/** Python repr() of the header dataclass, for messages. */
export function reprHeader(h: CbinHeader): string {
  return `CbinHeader(format_type=${h.formatType}, tag=${reprStr(h.tag)}, bank=${h.bank}, `
    + `location=${h.location}, category=${h.category}, version=${h.version})`;
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** zlib.crc32: CRC-32 (IEEE, reflected), unsigned. */
export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = CRC32_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** CRC-16/CCITT-FALSE (poly 0x1021, init 0xFFFF): the legacy trailer checksum. */
export function crc16CcittFalse(data: Uint8Array): number {
  let crc = 0xffff;
  for (const byte of data) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}

function latin1(bytes: Uint8Array): string {
  return String.fromCharCode(...bytes);
}

/** Parse and verify a CBIN file; NordFormatError on any inconsistency. */
export function parseCbin(data: Uint8Array, expectedTag: string): CbinFile {
  if (data.length < LEGACY_BODY_OFFSET) {
    throw new NordFormatError(`file is ${data.length} bytes, too short for a CBIN header`);
  }
  const magic = data.subarray(0, 4);
  if (!magic.every((b, i) => b === MAGIC[i])) {
    throw new NordFormatError(`bad magic ${reprBytes(magic)}, expected ${reprBytes(MAGIC)}`);
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const formatType = view.getUint32(0x04, true);
  let tagEnd = 0x0c;
  while (tagEnd > 0x08 && (data[tagEnd - 1] === 0x00 || data[tagEnd - 1] === 0x20)) tagEnd--;
  const tag = latin1(data.subarray(0x08, tagEnd));
  if (tag !== expectedTag) {
    throw new NordFormatError(`file type tag is ${reprStr(tag)}, expected ${reprStr(expectedTag)}`);
  }
  const header: CbinHeader = {
    formatType,
    tag,
    bank: view.getUint16(0x0c, true),
    location: view.getUint16(0x0e, true),
    category: view.getUint32(0x10, true),
    version: view.getUint32(0x14, true),
  };
  if (formatType === FORMAT_NSM) {
    if (data.length < HEADER_BYTES) {
      throw new NordFormatError(`file is ${data.length} bytes, too short for the 44-byte NSM-era header`);
    }
    const stored = view.getUint32(CRC_OFFSET, true);
    const computed = crc32(data.subarray(HEADER_BYTES));
    if (stored !== computed) {
      throw new NordFormatError(`CRC-32 mismatch: stored 0x${hex(stored, 8)}, computed 0x${hex(computed, 8)}`);
    }
    return { header, body: data.slice(HEADER_BYTES) };
  }
  if (formatType === FORMAT_LEGACY) {
    if (data.length < LEGACY_BODY_OFFSET + LEGACY_TRAILER_BYTES) {
      throw new NordFormatError(`file is ${data.length} bytes, too short for a legacy CBIN file`);
    }
    const stored = view.getUint16(data.length - LEGACY_TRAILER_BYTES, true);
    const computed = crc16CcittFalse(data.subarray(0, data.length - LEGACY_TRAILER_BYTES));
    if (stored !== computed) {
      throw new NordFormatError(`CRC-16 trailer mismatch: stored 0x${hex(stored, 4)}, computed 0x${hex(computed, 4)}`);
    }
    return { header, body: data.slice(LEGACY_BODY_OFFSET, data.length - LEGACY_TRAILER_BYTES) };
  }
  throw new NordFormatError(`unsupported CBIN formatType ${formatType} (Nord Sound Manager reads 0 and 1)`);
}

/** Serialise a container in the header's own format type, checksum last. */
export function buildCbin(header: CbinHeader, body: Uint8Array): Uint8Array {
  const tag = Array.from(header.tag, (ch) => ch.charCodeAt(0));
  if (tag.some((c) => c > 0xff)) {
    throw new RangeError(`tag ${reprStr(header.tag)} cannot be encoded as latin-1`);
  }
  if (tag.length > 4) {
    throw new RangeError(`tag ${reprStr(header.tag)} is longer than 4 characters`);
  }
  const fixedPart = new Uint8Array(0x18);
  const view = new DataView(fixedPart.buffer);
  fixedPart.set(MAGIC, 0);
  view.setUint32(0x04, header.formatType, true);
  fixedPart.set(tag, 0x08);
  view.setUint16(0x0c, header.bank, true);
  view.setUint16(0x0e, header.location, true);
  view.setUint32(0x10, header.category, true);
  view.setUint32(0x14, header.version, true);
  if (header.formatType === FORMAT_NSM) {
    const out = new Uint8Array(HEADER_BYTES + body.length);
    out.set(fixedPart, 0);
    new DataView(out.buffer).setUint32(CRC_OFFSET, crc32(body), true);
    out.set(body, HEADER_BYTES);
    return out;
  }
  if (header.formatType === FORMAT_LEGACY) {
    const out = new Uint8Array(0x18 + body.length + LEGACY_TRAILER_BYTES);
    out.set(fixedPart, 0);
    out.set(body, 0x18);
    const crc = crc16CcittFalse(out.subarray(0, 0x18 + body.length));
    new DataView(out.buffer).setUint16(0x18 + body.length, crc, true);
    return out;
  }
  throw new RangeError(`cannot write CBIN formatType ${header.formatType}`);
}
