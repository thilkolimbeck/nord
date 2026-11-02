/**
 * The donor program every output is patched into, made neutral first (port of
 * nordconv/template.py), and the bundled donor's bytes.
 *
 * About a fifth of a Stage 4 body is not in any known layout, so a converter patches a real
 * program and keeps the bytes nobody has decoded. The donor (templates/regressionTest.ns4p,
 * MIT, from ns4decode) is a working sound with its own settings, so every known field is reset
 * to its Stage 4 layout default and every scene I section and layer is switched off. Scene II
 * keeps the layout defaults, as Nord Sound Manager leaves it. The undecoded bits stay as the
 * donor has them, except three fields where three Nord Sound Manager conversions (kept private)
 * write a constant the donor lacks.
 */
import { decodeBase64 } from './base64.ts';
import { writeBits } from './bits.ts';
import { NordFormatError } from './errors.ts';
import { TEMPLATE_BASE64 } from './generated/template-bytes.ts';
import { NS4_LAYOUT } from './layout.ts';
import { Ns4Program } from './program.ts';
import { fixed } from './pyfmt.ts';

/** templates/regressionTest.ns4p, bundled so the browser needs no fetch (written by `npm run gen`). */
export const TEMPLATE_BYTES: Uint8Array = decodeBase64(TEMPLATE_BASE64);

export const TARGET_VERSION = 313;
/** Program category "None" (opennord clavia/categories.ts). */
export const CATEGORY_NONE = 17;
/** Scene I switches that the layout defaults leave on, but a neutral program has off. */
export const SWITCHES_OFF: readonly string[] = Array.from(NS4_LAYOUT.fields.keys()).filter((k) =>
  ['common.sectionEnable', 'organ.layerEnable', 'piano.layerEnable', 'synth.layerEnable'].some((p) =>
    k.startsWith(p)) && k.endsWith('_I'));
/**
 * Undecoded fields Nord Sound Manager always writes, as [block, first bit in the block, width, value]:
 * 2 bits between vibMode and voiceMode of each synth layer, 3 bits between orgPStickEnable and
 * effectsLeslieEnable of the organ, 2 bits between oscTuneCoarse and oscEnvAtk of each synth sound.
 */
export const UNDECODED_VALUES: ReadonlyArray<readonly [string, number, number, number]> = [
  ...['A', 'B', 'C'].map((x) => [`synth${x}`, 67, 2, 1] as const), ['organ', 69, 3, 5],
  ...['A', 'B', 'C'].map((x) => [`synth${x}Sound`, 61, 2, 0] as const)];

/** A copy of `donor` with every known field at its default, scene I off, Nord Sound Manager's undecoded values. */
export function neutralise(donor: Ns4Program): Ns4Program {
  if (donor.formatVersion !== TARGET_VERSION) {
    throw new NordFormatError(`template is format ${fixed(donor.formatVersion / 100, 2)}, expected `
      + fixed(TARGET_VERSION / 100, 2));
  }
  const header = { ...donor.header, bank: 0, location: 0, category: CATEGORY_NONE };
  const body = donor.body;
  const blocks = new Map(NS4_LAYOUT.blocks.map((b) => [b.key, b]));
  for (const [block, bit, width, value] of UNDECODED_VALUES) {
    writeBits(body, (blocks.get(block)!.offset + 1) * 8 + bit, width, value);
  }
  const neutral = new Ns4Program(header, body);
  for (const [key, f] of NS4_LAYOUT.fields) neutral.set(key, f.default);
  for (const key of SWITCHES_OFF) neutral.set(key, 0);
  return neutral;
}

/** Read and neutralise a donor program (by default the bundled one). */
export function loadTemplate(data: Uint8Array = TEMPLATE_BYTES): Ns4Program {
  return neutralise(Ns4Program.fromBytes(data));
}
