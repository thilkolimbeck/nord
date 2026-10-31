/**
 * MSB-first bit fields, the encoding of every Nord program body (port of nordconv/bits.py).
 *
 * A body is one big-endian bit string: bit 0 is the top bit of byte 0. Fields cross byte
 * boundaries freely. Fields are at most 32 bits wide, so values are built bit by bit with
 * plain arithmetic (no 32-bit bitwise operators, which would turn bit 31 into a sign).
 */

function span(start: number, width: number, size: number): void {
  if (width <= 0 || start < 0) {
    throw new RangeError(`bad bit range: start ${start}, width ${width}`);
  }
  const last = (start + width - 1) >> 3;
  if (last >= size) {
    throw new RangeError(`bits ${start}..${start + width - 1} run past the ${size}-byte buffer`);
  }
}

/** The unsigned value of `width` bits starting at bit `start`. */
export function readBits(buf: Uint8Array, start: number, width: number): number {
  span(start, width, buf.length);
  let value = 0;
  for (let bit = start; bit < start + width; bit++) {
    value = value * 2 + ((buf[bit >> 3]! >> (7 - (bit & 7))) & 1);
  }
  return value;
}

/** Store an unsigned `value` in `width` bits at bit `start`, keeping all other bits. */
export function writeBits(buf: Uint8Array, start: number, width: number, value: number): void {
  if (!(Number.isInteger(value) && value >= 0 && value < 2 ** width)) {
    throw new RangeError(`${value} does not fit in ${width} unsigned bits`);
  }
  span(start, width, buf.length);
  let rest = value;
  for (let bit = start + width - 1; bit >= start; bit--) {
    const index = bit >> 3;
    const mask = 0x80 >> (bit & 7);
    buf[index] = rest % 2 ? buf[index]! | mask : buf[index]! & ~mask & 0xff;
    rest = Math.floor(rest / 2);
  }
}
