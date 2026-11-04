/**
 * A deterministic corpus of valid Stage 4 programs for the .ns4p import and export tests: the
 * bundled donor as it is, the neutral template, and programs that set every field to a
 * pseudo-random value within its range (minimum, maximum and default included) over random
 * undecoded bits, so a test can tell the opened file's undecoded bits from the neutral
 * template's. Programs other than the donor have bank 0 and location 0, as an export writes.
 */
import { writeBits } from '../../src/ns4/bits.ts';
import { loadTemplate, Ns4Program, TEMPLATE_BYTES } from '../../src/ns4/index.ts';
import { NS4_LAYOUT } from '../../src/ns4/layout.ts';
import { CATEGORY_MAX } from '../../src/editor/formats/preset.ts';

/** mulberry32: a small seeded generator, so every run builds the same corpus. */
function generator(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
}

/** Body bit -> whether a layout field covers it. */
const COVERED: Uint8Array = (() => {
  const covered = new Uint8Array(NS4_LAYOUT.bodyBytes * 8);
  for (const f of NS4_LAYOUT.fields.values()) covered.fill(1, f.bodyBit, f.bodyBit + f.width);
  return covered;
})();

/** A valid Stage 4 program: random undecoded payload bits, every field random within its range. */
export function randomProgram(seed: number): Uint8Array {
  const next = generator(seed);
  const int = (lo: number, hi: number): number => lo + Math.floor(next() * (hi - lo + 1));
  const donor = Ns4Program.fromBytes(TEMPLATE_BYTES);
  const body = donor.body;
  // Only payload bits: the format version and the block length bytes hold the chain together.
  for (const block of NS4_LAYOUT.blocks) {
    for (let bit = (block.offset + 1) * 8; bit < (block.offset + 1 + block.length) * 8; bit++) {
      if (COVERED[bit] === 0) writeBits(body, bit, 1, int(0, 1));
    }
  }
  const program = new Ns4Program({ ...donor.header, bank: 0, location: 0, category: int(0, CATEGORY_MAX) }, body);
  for (const [key, f] of NS4_LAYOUT.fields) {
    const [lo, hi] = f.enc === 'raw' ? [0, 2 ** f.width - 1] : [f.min, f.max];
    const pick = next();
    program.set(key, pick < 0.15 ? lo : pick < 0.3 ? hi : pick < 0.45 ? f.default : int(lo, hi));
  }
  return program.toBytes();
}

/** [name, file bytes]: the bundled donor, the neutral template, then 64 random programs. */
export const CORPUS: ReadonlyArray<readonly [string, Uint8Array]> = [
  ['template', TEMPLATE_BYTES],
  ['neutral', loadTemplate().toBytes()],
  ...Array.from({ length: 64 }, (_, i) => [`random ${i + 1}`, randomProgram(i + 1)] as const),
];

/** The random programs only (bank 0, location 0, format 3.13). */
export const RANDOM: ReadonlyArray<readonly [string, Uint8Array]> = CORPUS.filter(([name]) => name.startsWith('random '));
