/**
 * What the file keys do (plan sections 2 "Load" and 5.1–5.5): save the state as a named app preset
 * in browser storage, load one back, download it as JSON, import a downloaded one, open a Stage 4
 * program (.ns4p), export the experimental Stage 4 program, download the parameter report, and keep
 * an autosaved working copy apart from the named presets (plan section 11, decision 7). Results and errors go to the print-out, a short line to the display. Browser
 * storage problems never touch the editor's state, and downloads work without storage.
 *
 * File reads use a generation counter: a read that finishes after a
 * newer file action is dropped. The only DOM use is the download helper.
 */
import type { ParamStore, ProgramSnapshot } from '../model/store.ts';
import { ExportError, exportExperimentalNs4p, type Exported } from '../formats/ns4p-export.ts';
import { ImportError, importNs4p, MAX_NS4P_BYTES } from '../formats/ns4p-import.ts';
import {
  MAX_PRESET_BYTES, NO_EXTRAS, PresetError, type PresetExtras, presetFileName, readPreset, readPresetExtras, toPresetJsonWith,
} from '../formats/preset.ts';
import { MAX_PRESET_WITH_SAMPLES_BYTES } from '../formats/samples-db.ts';
import { parameterReport, reportFileName } from '../formats/report.ts';
import {
  PresetSlots, type SlotInfo, StorageError, type StorageLike, type StorageProblem, type StoredPreset,
} from '../formats/storage.ts';
import { initProgram } from '../model/init.ts';
import type { LayerSamples } from '../model/user-samples.ts';
import type { DisplayApi } from './display.ts';
import type { PrintoutApi } from './printout.ts';

/** What a picked file has to offer (a DOM File satisfies it). */
export interface FileLike {
  readonly name: string;
  readonly size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export type Download = (fileName: string, data: string | Uint8Array, type: string) => void;

export interface FileDeps {
  readonly store: ParamStore;
  readonly printout: Pick<PrintoutApi, 'print'>;
  readonly display?: Pick<DisplayApi, 'setInfo'>;
  /** Browser storage; null when it is unavailable. Default: window.localStorage, if the browser allows it. */
  readonly storage?: StorageLike | null;
  /** The editor version written into presets. Default: the build's package version. */
  readonly appVersion?: string;
  /** Default: a Blob and an <a download> click. */
  readonly download?: Download;
  /** Delay between the last change and the autosave, in ms. */
  readonly autosaveDelay?: number;
  /**
   * Called after a user load replaced the state: a saved preset loaded, an app preset imported or
   * a .ns4p file opened (not after restoring the working copy on mount). The page stops notes here.
   */
  readonly onLoad?: () => void;
  /** The clock for the report's date. Default: the current time. */
  readonly now?: () => Date;
  /** Own samples (plan 15.3): what app presets carry besides the program; default none. */
  readonly samples?: PresetSamples;
}

/**
 * Own samples as app presets carry them (plan 15.3): the layers' assignments, the files to embed
 * in a download ("embed own samples" on), and what to do with a loaded preset's extras.
 */
export interface PresetSamples {
  /** The assignments and, when the user asked to embed, the files (notes: assigned files not embedded). */
  extras(embed: boolean): Promise<PresetExtras & { readonly notes?: readonly string[] }>;
  /** A preset loaded: take its assignments, store its embedded files; resolves with notes for the print-out. */
  apply(extras: PresetExtras): Promise<readonly string[]>;
  /** A program without assignments replaced the state (a .ns4p file). */
  clear(): void;
  /** The assignments now, for browser slots and the working copy (no files); default none. */
  current?(): LayerSamples;
  /** Called on every assignment change, so the working copy is autosaved; returns the unsubscribe function. */
  onChange?(fn: () => void): () => void;
}

export const READ_FAILED = 'could not read the file';
const AUTOSAVE_DELAY = 400;

/** window.localStorage, or null when the browser refuses access (it can throw, e.g. with site data blocked). */
export function browserStorage(): StorageLike | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function appVersion(): string {
  return typeof __ENGINE_VERSION__ === 'string' ? __ENGINE_VERSION__ : 'dev';
}

/** Save `data` as a file: a Blob behind an <a download>, removed again (works under a strict CSP). */
export function downloadFile(fileName: string, data: string | Uint8Array, type: string): void {
  const part: BlobPart = typeof data === 'string' ? data : (data as Uint8Array<ArrayBuffer>);
  const url = URL.createObjectURL(new Blob([part], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** The UTF-8 length of a text (the size of the file it is written to). */
function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** A date in the viewer's local time: '2026-11-03'. */
export function localDate(d: Date): string {
  const two = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
}

/** A saved-at time in the viewer's local time: '2026-11-03 21:48'. */
export function slotDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const two = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
}

export class FileActions {
  readonly #store: ParamStore;
  readonly #printout: Pick<PrintoutApi, 'print'>;
  readonly #display: Pick<DisplayApi, 'setInfo'> | null;
  readonly #slots: PresetSlots;
  readonly #appVersion: string;
  readonly #download: Download;
  readonly #delay: number;
  readonly #onLoad: (() => void) | null;
  readonly #now: () => Date;
  readonly #samples: PresetSamples | null;
  #generation = 0;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #autosaveWarned = false;

  constructor(deps: FileDeps) {
    this.#store = deps.store;
    this.#printout = deps.printout;
    this.#display = deps.display ?? null;
    this.#appVersion = deps.appVersion ?? appVersion();
    this.#slots = new PresetSlots(deps.storage === undefined ? browserStorage() : deps.storage, this.#appVersion);
    this.#download = deps.download ?? downloadFile;
    this.#delay = deps.autosaveDelay ?? AUTOSAVE_DELAY;
    this.#onLoad = deps.onLoad ?? null;
    this.#now = deps.now ?? (() => new Date());
    this.#samples = deps.samples ?? null;
  }

  #name(): string {
    return this.#store.meta.name.trim() === '' ? 'untitled' : this.#store.meta.name.trim();
  }

  #info(text: string | null): void {
    this.#display?.setInfo(text);
  }

  #fail(lines: readonly string[], short: string): void {
    this.#printout.print(lines, 'error');
    this.#info(short);
  }

  /** Replace the state with a loaded snapshot; one batch with origin 'load'. */
  #apply(snapshot: ProgramSnapshot): void {
    this.#store.load(snapshot, 'load');
  }

  /** The layers' own sample references to keep with a browser slot or the working copy. */
  #currentSamples(): LayerSamples {
    return this.#samples?.current?.() ?? {};
  }

  /**
   * A browser slot or the working copy loaded: hand its own sample references to the page (no
   * embedded files there) and print what that reports, unless a newer file action has started.
   */
  #applyStoredSamples(stored: StoredPreset, generation: number): void {
    const notes = stored.notes;
    if (this.#samples === null) {
      if (notes.length > 0) this.#printout.print(notes, 'notes');
      return;
    }
    void this.#samples.apply({ samples: stored.samples, embedded: new Map() }).then((sampleNotes) => {
      if (generation !== this.#generation) return;
      const lines = [...notes, ...sampleNotes];
      if (lines.length > 0) this.#printout.print(lines, 'notes');
    }, (err: unknown) => {
      this.#printout.print([...notes, `own samples not loaded: ${messageOf(err)}`], 'notes');
    });
  }

  /** A user load replaced the state: tell the page (it stops the notes). */
  #loaded(): void {
    this.#onLoad?.();
  }

  /** `save`: store the state as an app preset in this browser, under the program name. */
  save(): SlotInfo | null {
    const name = this.#name();
    try {
      const info = this.#slots.save(name, this.#store.snapshot(), this.#currentSamples());
      this.#printout.print([`app preset "${name}" saved in this browser (${slotDate(info.savedAt)})`,
        'it stays in this browser only: use app-preset ↓ to keep a copy as a file'], 'result');
      this.#info(`saved "${name}"`);
      return info;
    } catch (err) {
      this.#fail([`app preset not saved: ${messageOf(err)}`], 'not saved');
      return null;
    }
  }

  /** The saved presets for the `load` list, newest first, or the reason there are none to show. */
  slots(): { slots: SlotInfo[] } | { error: string } {
    try {
      return { slots: this.#slots.list() };
    } catch (err) {
      return { error: messageOf(err) };
    }
  }

  /** `load`: replace the state with a saved preset. */
  loadSlot(slot: SlotInfo): boolean {
    const generation = ++this.#generation;
    let stored: StoredPreset;
    try {
      stored = this.#slots.loadPreset(slot.id);
      this.#apply(stored.snapshot);
    } catch (err) {
      const reason = err instanceof PresetError || err instanceof StorageError ? err.message : messageOf(err);
      this.#fail([`app preset "${slot.name}" not loaded: ${reason}`], 'not loaded');
      return false;
    }
    this.#loaded();
    this.#printout.print([`app preset "${slot.name}" loaded from this browser (saved ${slotDate(slot.savedAt)})`], 'result');
    this.#info(`loaded "${slot.name}"`);
    // The slot's own sample references replace the current ones (none in a slot saved without any).
    this.#applyStoredSamples(stored, generation);
    return true;
  }

  /** `delete` in the load list, after its confirmation: remove a saved preset from this browser. */
  removeSlot(slot: SlotInfo): boolean {
    try {
      this.#slots.remove(slot.id);
    } catch (err) {
      this.#fail([`app preset "${slot.name}" not deleted: ${messageOf(err)}`], 'not deleted');
      return false;
    }
    this.#printout.print([`app preset "${slot.name}" deleted from this browser`], 'result');
    this.#info(`deleted "${slot.name}"`);
    return true;
  }

  /**
   * `app-preset ↓`: download the state as an app preset JSON file, with the layers' own sample
   * references and, with `embed` on, the sample files themselves (plan 15.3).
   */
  async downloadPreset(embed = false): Promise<string> {
    const fileName = presetFileName(this.#name());
    const snapshot = this.#store.snapshot();
    // Without the files the references stay: the layers keep their own samples on this device.
    const references: PresetExtras = { samples: this.#currentSamples(), embedded: new Map() };
    let extras: PresetExtras = this.#samples === null ? NO_EXTRAS : references;
    const notes: string[] = [];
    try {
      if (this.#samples !== null) {
        const got = await this.#samples.extras(embed);
        extras = got;
        notes.push(...(got.notes ?? []));
      }
    } catch (err) {
      notes.push(`own samples not embedded: ${messageOf(err)}`);
    }
    let text = toPresetJsonWith(snapshot, this.#appVersion, extras);
    // A file the import would refuse whole (48 MB) is never written: then the references only.
    if (extras.embedded.size > 0 && utf8Length(text) > MAX_PRESET_WITH_SAMPLES_BYTES) {
      notes.push(`own samples not embedded: the preset would be larger than ${MAX_PRESET_WITH_SAMPLES_BYTES / 1024 / 1024} MB, `
        + 'more than an import accepts');
      extras = { samples: extras.samples, embedded: new Map() };
      text = toPresetJsonWith(snapshot, this.#appVersion, extras);
    }
    this.#download(fileName, text, 'application/json');
    const embedded = extras.embedded.size;
    // One print: a print replaces the lines before it, so the notes go with the result.
    this.#printout.print([`app preset downloaded: ${fileName}`,
      ...(embedded > 0 ? [`it embeds ${embedded} own ${embedded === 1 ? 'sample' : 'samples'}: share it only as you would the audio files`] : []),
      ...notes,
      'an app preset is for this editor only; the stage 4 and nord sound manager cannot open it'], 'result');
    return fileName;
  }

  /** `import`: read an app preset JSON file and replace the state with it. */
  async importPreset(file: FileLike): Promise<boolean> {
    const generation = ++this.#generation;
    // Up to 48 MB only for a preset that embeds own samples: readPreset checks the text (plan 15.3).
    if (file.size > MAX_PRESET_WITH_SAMPLES_BYTES) {
      this.#fail([`${file.name}: not a preset file: larger than ${MAX_PRESET_WITH_SAMPLES_BYTES / 1024 / 1024} MB`],
        'not a preset file');
      return false;
    }
    let text: string;
    try {
      text = new TextDecoder().decode(await file.arrayBuffer());
    } catch {
      if (generation === this.#generation) this.#fail([`${file.name}: ${READ_FAILED}`], READ_FAILED);
      return false;
    }
    if (generation !== this.#generation) return false;
    try {
      if (file.size > MAX_PRESET_BYTES && !text.includes('"embeddedSamples"')) {
        throw new PresetError('not a preset file', 'not a preset file: larger than 1 MB');
      }
      const { snapshot, notes } = readPreset(text);
      const extras = readPresetExtras(text);
      this.#apply(snapshot);
      this.#loaded();
      const sampleNotes = this.#samples === null ? [] : await this.#samples.apply(extras);
      if (generation !== this.#generation) return true;
      this.#printout.print([`app preset imported: ${file.name}`, ...notes, ...extras.notes, ...sampleNotes], 'result');
      this.#info(`imported "${snapshot.name}"`);
      return true;
    } catch (err) {
      const short = err instanceof PresetError ? err.short : 'not imported';
      this.#fail([`${file.name}: ${messageOf(err)}`], short);
      return false;
    }
  }

  /** `open .ns4p`: read a Stage 4 program and replace the state with all its values. */
  async openNs4p(file: FileLike): Promise<boolean> {
    const generation = ++this.#generation;
    if (file.size > MAX_NS4P_BYTES) {
      this.#fail([`${file.name}: file is ${file.size} bytes, too large for a Stage 4 program`], 'not a stage 4 program');
      return false;
    }
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await file.arrayBuffer());
    } catch {
      if (generation === this.#generation) this.#fail([`${file.name}: ${READ_FAILED}`], READ_FAILED);
      return false;
    }
    if (generation !== this.#generation) return false;
    try {
      const { snapshot, notes } = importNs4p(file.name, bytes);
      this.#apply(snapshot);
      this.#samples?.clear();
      this.#loaded();
      this.#printout.print([`opened ${file.name}`, ...notes], 'notes');
      this.#info(`opened ${file.name} · ${notes[0] ?? ''}`.replace(/ · $/, ''));
      return true;
    } catch (err) {
      const reason = err instanceof ImportError ? err.message : messageOf(err);
      this.#fail([`${file.name}: ${reason}`], 'not a stage 4 program');
      return false;
    }
  }

  /**
   * `stage-4-programm (experimentell) ↓`, after the confirmation: write the state as a .ns4p file,
   * verified by the engine; download it only when the check passed. Returns the file name or null.
   */
  exportNs4p(): string | null {
    let exported: Exported;
    try {
      exported = exportExperimentalNs4p(this.#store.snapshot());
    } catch (err) {
      const reason = err instanceof ExportError ? err.message : messageOf(err);
      this.#fail([`stage 4 program not exported: ${reason}`, 'nothing was downloaded'], 'not exported');
      return null;
    }
    this.#download(exported.fileName, exported.bytes, 'application/octet-stream');
    this.#printout.print([`stage 4 program downloaded (experimental): ${exported.fileName}`, ...exported.notes], 'result');
    this.#info(`exported ${exported.fileName} · experimental`);
    return exported.fileName;
  }

  /** `report ↓`: download the parameter report, every value that differs from the init program. */
  downloadReport(): string {
    const snapshot = this.#store.snapshot();
    const fileName = reportFileName(this.#name());
    const text = parameterReport(snapshot, initProgram(), { appVersion: this.#appVersion, date: localDate(this.#now()) });
    this.#download(fileName, text, 'text/plain;charset=utf-8');
    this.#printout.print([`parameter report downloaded: ${fileName}`,
      'a parameter report is for reading only; the stage 4, nord sound manager and this editor cannot import it'],
    'result');
    this.#info('report downloaded');
    return fileName;
  }

  /** Load the autosaved working copy, if there is a readable one; true when it was restored. */
  restoreWorkingCopy(): boolean {
    const stored = this.#slots.loadWorkingPreset();
    if (stored === null) return false;
    this.#apply(stored.snapshot);
    this.#printout.print(['restored the working copy from this browser'], 'notes');
    this.#applyStoredSamples(stored, this.#generation);
    return true;
  }

  /** Write the working copy now (also on page hide). */
  autosaveNow(): StorageProblem | null {
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    const problem = this.#slots.available
      ? this.#slots.saveWorkingCopy(this.#store.snapshot(), this.#currentSamples()) : 'unavailable';
    if (problem !== null && !this.#autosaveWarned) {
      this.#autosaveWarned = true;
      this.#printout.print([`working copy not autosaved: ${new StorageError(problem).message}`], 'notes');
    }
    return problem;
  }

  /**
   * Schedule the autosave on every value batch, every name edit and every own sample assignment
   * change; returns the unsubscribe function.
   */
  watchStore(): () => void {
    const offs = [
      this.#store.onChange(() => this.scheduleAutosave()),
      this.#store.onNameChange(() => this.scheduleAutosave()),
      ...(this.#samples?.onChange === undefined ? [] : [this.#samples.onChange(() => this.scheduleAutosave())]),
    ];
    return () => { for (const off of offs) off(); };
  }

  /** Autosave after the changes settle. */
  scheduleAutosave(): void {
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.autosaveNow();
    }, this.#delay);
  }

  dispose(): void {
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
    this.#generation += 1;
  }
}
