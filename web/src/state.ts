/**
 * The page's state machine, without the DOM: what a file pick, convert, clear and the notes
 * toggle do, and what the instrument strip and the print-out show for a state. main.ts only
 * wires it to the elements; test/state.test.ts drives it directly.
 *
 * Copyright (C) 2026 Thilko Limbeck. AGPL-3.0-or-later.
 */
import { ConversionError, convertBytes, loadTemplate, NordFormatError, Ns3Program, Ns4Program, OUTPUT_SUFFIX } from './engine/index.ts';

export const SEGMENTS = 6;
export const TARGET = 'ns4p 3.13';
export const MULTIPLE_FILES = 'one file at a time';
export const READ_FAILED = 'could not read the file';

export type State =
  | { kind: 'idle' }
  | { kind: 'ready'; name: string; bytes: Uint8Array; version: string; panels: string[] }
  | {
      kind: 'converted';
      name: string;
      version: string;
      panels: string[];
      output: Uint8Array;
      warnings: string[];
      notes: string[];
    }
  | { kind: 'error'; name: string; version: string; message: string };

/** What the page needs from a picked or dropped file (a DOM File satisfies it). */
export interface FileLike {
  readonly name: string;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface Model {
  readonly state: State;
  readonly showNotes: boolean;
}

export const initialModel: Model = { state: { kind: 'idle' }, showNotes: false };

/** "My Program.ns3f" -> "My Program". */
export function baseName(fileName: string): string {
  return fileName.replace(/\.[^.]*$/, '') || fileName;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Which panels are active in the source: 'a', 'b' or both (common.slotEnable bits 1 and 2). */
function activePanels(program: Ns3Program): string[] {
  const slots = program.value('common.slotEnable');
  const panels: string[] = [];
  if (slots & 1) panels.push('a');
  if (slots & 2) panels.push('b');
  return panels;
}

function panelLine(panels: string[]): string {
  if (panels.length === 0) return 'ok';
  const list = panels.join('+');
  return panels.length === 1 ? `panel ${list} → layer ${list} · ok` : `panel ${list} → layers ${list} · ok`;
}

function errorMessage(exc: unknown): string {
  if (exc instanceof NordFormatError || exc instanceof ConversionError) return exc.message;
  return exc instanceof Error ? exc.message : String(exc);
}

/** The state after reading one file's bytes: ready, or an error with the engine's message. */
export function readProgram(fileName: string, bytes: Uint8Array): State {
  const name = baseName(fileName);
  try {
    const program = Ns3Program.fromBytes(bytes);
    const version = (program.formatVersion / 100).toFixed(2);
    return { kind: 'ready', name, bytes, version, panels: activePanels(program) };
  } catch (exc) {
    return { kind: 'error', name, version: '', message: errorMessage(exc) };
  }
}

let neutral: Ns4Program | undefined;

/**
 * The bundled template, neutralised once. A failure is reported the way convert() reports it
 * ("template unusable: ...") and is not cached.
 */
function neutralTemplate(): Ns4Program {
  if (neutral === undefined) {
    try {
      neutral = loadTemplate();
    } catch (exc) {
      if (exc instanceof NordFormatError) throw new ConversionError(`template unusable: ${exc.message}`);
      throw exc;
    }
  }
  return neutral;
}

/** Convert a ready program; any other state is returned unchanged. */
export function convertModel(model: Model): Model {
  const { state } = model;
  if (state.kind !== 'ready') return model;
  const { name, bytes, version, panels } = state;
  try {
    const result = convertBytes(bytes, neutralTemplate());
    return {
      state: { kind: 'converted', name, version, panels, output: result.data, warnings: [...result.warnings], notes: [...result.notes] },
      showNotes: model.showNotes,
    };
  } catch (exc) {
    return { state: { kind: 'error', name, version, message: errorMessage(exc) }, showNotes: model.showNotes };
  }
}

export function toggleNotes(model: Model): Model {
  if (model.state.kind !== 'converted') return model;
  return { state: model.state, showNotes: !model.showNotes };
}

/** The download name for a converted program, or null when there is nothing to save. */
export function saveFileName(state: State): string | null {
  return state.kind === 'converted' ? `${state.name}${OUTPUT_SUFFIX}` : null;
}

/**
 * Holds the model and orders file loads: every load and every clear starts a new generation,
 * and a load whose file read finishes after a newer load or a clear is dropped.
 */
export class Session {
  #model: Model = initialModel;
  #generation = 0;

  get model(): Model {
    return this.#model;
  }

  /**
   * Take a picked or dropped file list. Resolves to true when the model changed, false when
   * the list was empty or a newer load or a clear superseded this one.
   */
  async load(files: ArrayLike<FileLike>): Promise<boolean> {
    if (files.length === 0) return false;
    const generation = ++this.#generation;
    if (files.length > 1) {
      this.#model = { state: { kind: 'error', name: '', version: '', message: MULTIPLE_FILES }, showNotes: false };
      return true;
    }
    const file = files[0]!;
    let state: State;
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      state = readProgram(file.name, bytes);
    } catch {
      state = { kind: 'error', name: baseName(file.name), version: '', message: READ_FAILED };
    }
    if (generation !== this.#generation) return false;
    this.#model = { state, showNotes: false };
    return true;
  }

  convert(): void {
    this.#model = convertModel(this.#model);
  }

  toggleNotes(): void {
    this.#model = toggleNotes(this.#model);
  }

  clear(): void {
    this.#generation++;
    this.#model = initialModel;
  }
}

export interface KeyView {
  disabled: boolean;
  lit: boolean;
}

/** Everything the strip and the print-out show, derived from the model. */
export interface View {
  kind: State['kind'];
  name: string;
  versionLine: string;
  stateLine: string;
  meters: { warn: number; notes: number; error: number };
  counts: { warn: string; notes: string; error: string };
  keys: { convert: KeyView; save: KeyView; clear: { disabled: boolean }; notes: KeyView };
  notesShown: boolean;
  printout: { warnings: string; notes: string; notesDisabled: boolean; lines: string[] };
}

export function view(model: Model): View {
  const { state } = model;
  const warnings = state.kind === 'converted' ? state.warnings : [];
  const notes = state.kind === 'converted' ? state.notes : [];
  const isError = state.kind === 'error';
  const name = state.kind === 'idle' ? '' : state.name;
  const version = state.kind === 'idle' ? '' : state.version;
  const notesShown = model.showNotes && state.kind === 'converted';

  let stateLine: string;
  let lines: string[];
  switch (state.kind) {
    case 'idle':
      stateLine = 'insert program';
      lines = ['nothing printed yet'];
      break;
    case 'ready':
      stateLine = 'ready · press convert';
      lines = [];
      break;
    case 'converted':
      stateLine = panelLine(state.panels);
      lines = notesShown ? [...warnings, ...notes] : [...warnings];
      break;
    case 'error':
      stateLine = `error · ${state.message}`;
      lines = [state.message];
      break;
  }

  return {
    kind: state.kind,
    name,
    versionLine: version ? `ns3f ${version} → ${TARGET}` : `ns3f → ${TARGET}`,
    stateLine,
    meters: {
      warn: Math.min(warnings.length, SEGMENTS),
      notes: Math.min(notes.length, SEGMENTS),
      error: isError ? SEGMENTS : 0,
    },
    counts: { warn: String(warnings.length), notes: String(notes.length), error: isError ? '1' : '0' },
    keys: {
      convert: { disabled: state.kind !== 'ready', lit: state.kind === 'ready' },
      save: { disabled: state.kind !== 'converted', lit: state.kind === 'converted' },
      clear: { disabled: state.kind === 'idle' },
      notes: { disabled: state.kind !== 'converted', lit: notesShown },
    },
    notesShown,
    printout: {
      warnings: plural(warnings.length, 'warning', 'warnings'),
      notes: `${plural(notes.length, 'note', 'notes')} on switched-off parts`,
      notesDisabled: state.kind !== 'converted',
      lines,
    },
  };
}
