/**
 * The typed view of the generated Stage 4 layout, and the raw <-> value rules of a field
 * (encoding rules follow opennord block-chain.ts).
 */
import * as ns4 from './generated/layout-ns4.ts';

export type Encoding = 'u' | 'offset' | 'twos' | 'raw';
const ENCODINGS: readonly string[] = ['u', 'offset', 'twos', 'raw'];

/** A length-prefixed block; `offset` is the body byte of its length prefix. */
export interface Block {
  readonly key: string;
  readonly offset: number;
  readonly length: number;
}

/** One bit field. `bodyBit` is its first bit counted from body byte 0. */
export class Field {
  readonly key: string;
  readonly block: number;
  readonly bit: number;
  readonly width: number;
  readonly min: number;
  readonly max: number;
  readonly default: number;
  readonly enc: Encoding;
  readonly bodyBit: number;

  constructor(key: string, block: number, bit: number, width: number, min: number, max: number,
    defaultValue: number, enc: Encoding, bodyBit: number) {
    this.key = key;
    this.block = block;
    this.bit = bit;
    this.width = width;
    this.min = min;
    this.max = max;
    this.default = defaultValue;
    this.enc = enc;
    this.bodyBit = bodyBit;
  }

  /** The value a raw bit pattern stands for. */
  decode(raw: number): number {
    if (this.enc === 'offset') return raw + this.min;
    if (this.enc === 'twos' && raw >= 2 ** (this.width - 1)) return raw - 2 ** this.width;
    return raw;
  }

  /** Whether the instrument accepts `value`. Name hashes (`raw`) are opaque, so any pattern is valid. */
  inRange(value: number): boolean {
    if (this.enc === 'raw') return value >= 0 && value < 2 ** this.width;
    return this.min <= value && value <= this.max;
  }

  /** The raw bits for `value`; RangeError when the value is out of range. */
  encode(value: number): number {
    if (!Number.isInteger(value)) {
      throw new TypeError(`${this.key}: value must be an int, got ${String(value)}`);
    }
    if (!this.inRange(value)) {
      throw new RangeError(`${this.key}: ${value} is outside ${this.min}..${this.max}`);
    }
    let raw: number;
    if (this.enc === 'offset') raw = value - this.min;
    else if (this.enc === 'twos' && value < 0) raw = value + 2 ** this.width;
    else raw = value;
    if (!(raw >= 0 && raw < 2 ** this.width)) {
      throw new RangeError(`${this.key}: ${value} does not fit the ${this.width}-bit field`);
    }
    return raw;
  }
}

/** A model's program body: expected versions, blocks and fields by key (in layout order). */
export interface Layout {
  readonly model: string;
  readonly versionRange: readonly [number, number];
  readonly bodyBytes: number;
  readonly blocks: readonly Block[];
  readonly fields: ReadonlyMap<string, Field>;
}

interface LayoutModule {
  readonly MODEL: string;
  readonly VERSION_RANGE: readonly [number, number];
  readonly BODY_BYTES: number;
  readonly BLOCKS: ReadonlyArray<readonly [string, number, number]>;
  readonly FIELDS: ReadonlyArray<readonly [string, number, number, number, number, number, number, string]>;
}

function load(module: LayoutModule): Layout {
  const blocks = module.BLOCKS.map(([key, offset, length]) => ({ key, offset, length }));
  const fields = new Map<string, Field>();
  for (const [key, block, bit, width, lo, hi, def, enc] of module.FIELDS) {
    if (!ENCODINGS.includes(enc)) throw new Error(`${key}: unknown encoding ${enc}`);
    const bodyBit = (blocks[block]!.offset + 1) * 8 + bit;
    fields.set(key, new Field(key, block, bit, width, lo, hi, def, enc as Encoding, bodyBit));
  }
  return { model: module.MODEL, versionRange: module.VERSION_RANGE, bodyBytes: module.BODY_BYTES, blocks, fields };
}

export const NS4_LAYOUT = load(ns4);

/** A field of a layout by key; throws for an unknown key. */
export function fieldOf(layout: Layout, key: string): Field {
  const f = layout.fields.get(key);
  if (f === undefined) throw new Error(`${layout.model} has no field '${key}'`);
  return f;
}
