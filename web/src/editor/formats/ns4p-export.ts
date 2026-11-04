/**
 * The experimental Stage 4 export (plan section 5.4, AC 12): the editor state written as a .ns4p
 * file by patching a donor program, then checked with the verify step of src/ns4/verify.ts before any
 * byte leaves this module. Donor (plan section 11, decision 3): the opened program's bytes when it
 * is format 3.13, the neutral template otherwise. Only the fields whose value differs from the
 * donor are written; every bit no field covers stays as the donor has it.
 *
 * The check proves structure and field values (the file parses again, every field reads back as
 * the snapshot holds it, undecoded bits equal the donor's), not that a Stage 4 accepts the file:
 * the export is untested on hardware, and the UI says so before and after. No DOM.
 */
import { verify } from '../../ns4/verify.ts';
import { ConversionError, NordFormatError } from '../../ns4/errors.ts';
import { Ns4Program } from '../../ns4/program.ts';
import { CATEGORY_NONE, loadTemplate, TARGET_VERSION } from '../../ns4/template.ts';
import { NS4_KEYS } from '../model/keys.ts';
import type { ProgramSnapshot } from '../model/store.ts';
import { CATEGORY_MAX, safeFileBase } from './preset.ts';

/** The export did not produce a verified file; nothing may be downloaded. */
export class ExportError extends Error {
  override name = 'ExportError';
}

export type DonorKind = 'source' | 'neutral';

export interface Exported {
  readonly bytes: Uint8Array;
  readonly fileName: string;
  readonly donor: DonorKind;
  /** Fields written over the donor. */
  readonly edits: number;
  /** For the print-out: donor, edit count, what the check proves, where to load the file. */
  readonly notes: string[];
}

let neutral: Ns4Program | undefined;

/** The neutral template, read once. */
function neutralDonor(): Ns4Program {
  neutral ??= loadTemplate();
  return neutral;
}

function version(v: number): string {
  return (v / 100).toFixed(2);
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** '<program>.ns4p': the Stage 4 shows the file name as the program name, so nothing else goes into it. */
export function ns4pFileName(name: string): string {
  return `${safeFileBase(name)}.ns4p`;
}

/** The donor program and a line for the print-out; bank and location 0, as verify expects. */
function donorFor(s: ProgramSnapshot): { program: Ns4Program; kind: DonorKind; note: string } {
  const src = s.source;
  if (src !== null && src.formatVersion === TARGET_VERSION) {
    let program: Ns4Program;
    try {
      program = Ns4Program.fromBytes(src.bytes);
    } catch (err) {
      throw new ExportError(`the opened program ${src.fileName} is unreadable: ${messageOf(err)}`);
    }
    return {
      program: new Ns4Program({ ...program.header, bank: 0, location: 0 }, program.body),
      kind: 'source',
      note: `donor: ${src.fileName} (the opened program, format ${version(TARGET_VERSION)}); its undecoded bits are kept`,
    };
  }
  const why = src === null
    ? 'no stage 4 program was opened'
    : `${src.fileName} is format ${version(src.formatVersion)}, only ${version(TARGET_VERSION)} files serve as donor`;
  return { program: neutralDonor(), kind: 'neutral', note: `donor: the neutral template (${why})` };
}

/**
 * The snapshot as a Stage 4 program file. Throws ExportError, and returns no bytes, when a value
 * is missing or outside its field, or when the written file fails the engine's verify step.
 */
export function exportExperimentalNs4p(s: ProgramSnapshot): Exported {
  const donor = donorFor(s);
  const notes: string[] = [];

  let category = s.category;
  if (!Number.isInteger(category) || category < 0 || category > CATEGORY_MAX) {
    notes.push(`category ${String(category)} is unknown; written as none`);
    category = CATEGORY_NONE;
  }

  const edits = new Map<string, number>();
  for (const key of NS4_KEYS) {
    const value = s.values[key];
    if (typeof value !== 'number' || !Number.isInteger(value)) {
      throw new ExportError(`export refused: ${key} is ${String(value)}, not an integer`);
    }
    if (value !== donor.program.value(key)) edits.set(key, value);
  }

  let data: Uint8Array;
  try {
    const out = new Ns4Program({ ...donor.program.header, category }, donor.program.body);
    for (const [key, value] of edits) out.set(key, value);
    data = out.toBytes();
    verify(data, donor.program, edits, category);
  } catch (err) {
    if (err instanceof ConversionError) throw new ExportError(`export failed verification: ${err.message}`);
    if (err instanceof RangeError || err instanceof TypeError || err instanceof NordFormatError) {
      throw new ExportError(`export refused: ${err.message}`);
    }
    throw new ExportError(`export failed: ${messageOf(err)}`);
  }

  notes.unshift(donor.note,
    `${edits.size} ${edits.size === 1 ? 'field differs' : 'fields differ'} from the donor and ${edits.size === 1 ? 'was' : 'were'} written`);
  notes.push(
    'verified: the file parses again, every field reads back as set, undecoded bits equal the donor\'s',
    'the check proves structure, not that a stage 4 accepts the file: untested on stage 4 hardware',
    'load it into a free slot (nord sound manager); bank and location are 0',
  );
  return { bytes: data, fileName: ns4pFileName(s.name), donor: donor.kind, edits: edits.size, notes };
}
