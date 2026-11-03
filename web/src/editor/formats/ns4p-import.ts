/**
 * Opening a Stage 4 program (.ns4p) in the editor (plan section 5.2): the engine's reader checks
 * the file (CBIN, tag, CRC, format 3.07–3.13, block chain) and every one of the 955 fields fills
 * the snapshot, not only the synth ones, so export and report keep the organ, piano, effects and
 * common settings. The file's bytes are kept as the export donor (plan section 11, decision 3).
 * The notes tell what the editor does not play or show of the file. No DOM.
 */
import { NordFormatError } from '../../engine/errors.ts';
import { Ns4Program } from '../../engine/program.ts';
import { CATEGORY_NONE, TARGET_VERSION } from '../../engine/template.ts';
import { clampValue, DESCRIPTORS } from '../model/descriptors.ts';
import { LAYERS, NS4_KEYS, type Ns4Key } from '../model/keys.ts';
import type { ProgramSnapshot } from '../model/store.ts';
import { CATEGORY_MAX } from './preset.ts';

/** Files larger than this are refused before reading (a Stage 4 program is about 1.2 KB). */
export const MAX_NS4P_BYTES = 1024 * 1024;

/** A file the editor cannot open; the message is the engine's own where the engine refused it. */
export class ImportError extends Error {
  override name = 'ImportError';
}

export interface Imported {
  readonly snapshot: ProgramSnapshot;
  readonly notes: string[];
}

const MORPH = /\.morph(?:Wheel|AfterTouch|CtrlPedal)$/;

/** "Warm Pad.ns4p" -> "Warm Pad": the Stage 4 stores no name, the file name is the program name. */
export function programName(fileName: string): string {
  const base = fileName.replace(/\.ns4p$/i, '').trim();
  return base === '' ? 'untitled' : base;
}

function version(v: number): string {
  return (v / 100).toFixed(2);
}

/** What the editor leaves out of the file: scene II, sections and layer modes it does not play, arp, morphs, split. */
function describe(values: Readonly<Record<Ns4Key, number>>): string[] {
  const notes: string[] = [];
  if (values['common.layerScene'] === 1) {
    notes.push('scene II is the active scene in this file; the editor shows and plays scene I only');
  }
  if (values['common.sectionEnableOrg_I'] === 1) notes.push('organ is on in scene I: not implemented, it does not sound');
  if (values['common.sectionEnablePno_I'] === 1) notes.push('piano is on in scene I: not implemented, it does not sound');
  if (values['common.sectionEnableSyn_I'] === 1) {
    const mask = values['synth.layerEnableSyn_I'];
    LAYERS.forEach((layer, i) => {
      if ((mask & (1 << i)) === 0) return;
      const l = layer.toLowerCase();
      if (values[`synth${layer}.mode`] === 0) notes.push(`synth layer ${l} uses samples mode: not implemented, the layer is silent`);
      else if (values[`synth${layer}Sound.oscBank`] === 3) {
        notes.push(`synth layer ${l} uses the wave oscillator type: not implemented, the layer is silent`);
      }
      if (values[`synth${layer}.externEnable`] === 1) notes.push(`synth layer ${l} has extern on: not implemented`);
      if (values[`synth${layer}.arpRun`] === 1) notes.push(`synth layer ${l} has the arpeggiator on: stored, no sound in the editor`);
    });
  } else {
    notes.push('the synth section is off in scene I: switch a layer on to hear it');
  }
  const morphs = NS4_KEYS.filter((k) => MORPH.test(k) && values[k] !== 0).length;
  if (morphs > 0) {
    notes.push(`${morphs} morph ${morphs === 1 ? 'amount is' : 'amounts are'} set: kept and shown, not played`);
  }
  if (values['common.splitEnabled'] === 1) notes.push('split is on: the editor plays every layer across the whole keyboard');
  return notes;
}

/**
 * The snapshot for a .ns4p file and the notes for the print-out. ImportError with the engine's
 * message when the file is not a valid Stage 4 program.
 */
export function importNs4p(fileName: string, bytes: Uint8Array): Imported {
  if (bytes.length > MAX_NS4P_BYTES) {
    throw new ImportError(`file is ${bytes.length} bytes, too large for a Stage 4 program`);
  }
  let program: Ns4Program;
  try {
    program = Ns4Program.fromBytes(bytes);
  } catch (err) {
    if (err instanceof NordFormatError) throw new ImportError(err.message);
    throw new ImportError(`could not read the file: ${err instanceof Error ? err.message : String(err)}`);
  }

  const notes: string[] = [`stage 4 program, format ${version(program.formatVersion)}`];
  const values = {} as Record<Ns4Key, number>;
  const outside: string[] = [];
  for (const key of NS4_KEYS) {
    const fv = program.get(key);
    const d = DESCRIPTORS.get(key)!;
    const value = clampValue(d, fv.value);
    if (!fv.inRange || value !== fv.value) outside.push(`${key}: ${fv.value} is outside ${d.min}..${d.max}, set to ${value}`);
    values[key] = value;
  }

  let category = program.header.category;
  if (!Number.isInteger(category) || category < 0 || category > CATEGORY_MAX) {
    notes.push(`category ${category} is unknown; set to none`);
    category = CATEGORY_NONE;
  }
  if (program.formatVersion !== TARGET_VERSION) {
    notes.push(`format ${version(program.formatVersion)} is older than ${version(TARGET_VERSION)}: `
      + 'the experimental stage 4 export starts from the neutral template, not from this file');
  }
  notes.push(...describe(values));
  if (outside.length > 0) {
    notes.push(`${outside.length} ${outside.length === 1 ? 'value was' : 'values were'} out of range:`, ...outside);
  }

  return {
    snapshot: {
      name: programName(fileName),
      category,
      values,
      source: { kind: 'ns4p', fileName, formatVersion: program.formatVersion, bytes: Uint8Array.from(bytes) },
    },
    notes,
  };
}
