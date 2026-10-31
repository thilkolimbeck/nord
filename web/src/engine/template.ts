/**
 * The donor program every output is patched into, made neutral first (port of
 * nordconv/template.py), and the bundled donor's bytes.
 *
 * About a fifth of a Stage 4 body is not in any known layout, so a converter patches a real
 * program and keeps the bytes nobody has decoded. The donor (templates/regressionTest.ns4p,
 * MIT, from ns4decode) is a working sound with its own settings, so every known field is reset
 * to its Stage 4 layout default and every section and layer is switched off. Only the undecoded
 * bits stay as the donor has them.
 */
import { decodeBase64 } from './base64.ts';
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
/** Switches that the layout defaults leave on, but a neutral program has off. */
export const SWITCHES_OFF: readonly string[] = Array.from(NS4_LAYOUT.fields.keys()).filter((k) =>
  ['common.sectionEnable', 'organ.layerEnable', 'piano.layerEnable', 'synth.layerEnable'].some((p) =>
    k.startsWith(p)));

/** A copy of `donor` with every known field at its default, all sections and layers off. */
export function neutralise(donor: Ns4Program): Ns4Program {
  if (donor.formatVersion !== TARGET_VERSION) {
    throw new NordFormatError(`template is format ${fixed(donor.formatVersion / 100, 2)}, expected `
      + fixed(TARGET_VERSION / 100, 2));
  }
  const header = { ...donor.header, bank: 0, location: 0, category: CATEGORY_NONE };
  const neutral = new Ns4Program(header, donor.body);
  for (const [key, f] of NS4_LAYOUT.fields) neutral.set(key, f.default);
  for (const key of SWITCHES_OFF) neutral.set(key, 0);
  return neutral;
}

/** Read and neutralise a donor program (by default the bundled one). */
export function loadTemplate(data: Uint8Array = TEMPLATE_BYTES): Ns4Program {
  return neutralise(Ns4Program.fromBytes(data));
}
