/**
 * Own samples for samples mode, as the page manages them (plan section 15.3), without the DOM:
 * the samples on this device (formats/samples-db.ts, IndexedDB), which synth layer plays which
 * one (model/user-samples.ts SampleAssignments), and the decoded buffers the sound engine plays
 * (audio/samples SampleSources through `sink`). Importing decodes the file first, so a file the
 * browser cannot decode is never stored. Nothing is uploaded: the bytes stay in this browser and
 * leave it only inside an app preset the user downloads with "embed own samples" on.
 *
 * The audio data (import, list, delete, storage use) is managed apart from the sample-based
 * parameters of a layer (which sample, root, loop): the files box shows the first, the synth
 * oscillator group the second (plan 15.9).
 */
import { decodeBase64Strict } from '../formats/base64.ts';
import { collectEmbedded } from '../formats/preset.ts';
import {
  type EmbeddedSample, MAX_SAMPLE_BYTES, type SampleMeta, type SampleStore, SampleStoreError, type SampleUsage,
  formatBytes,
} from '../formats/samples-db.ts';
import { LAYERS, type SynthLayer } from '../model/keys.ts';
import {
  type LayerSamples, type SampleAssignments, type SampleHash, type SampleInfo, sampleRef, type UserSampleRef,
} from '../model/user-samples.ts';

/** What a picked file offers (a DOM File satisfies it). */
export interface AudioFileLike {
  readonly name: string;
  readonly size: number;
  readonly type?: string;
  arrayBuffer(): Promise<ArrayBuffer>;
}

/** Where decoded buffers go (audio/samples/provider.ts SampleSources). */
export interface SampleSink {
  setBuffer(hash: SampleHash, buffer: AudioBuffer | null, info: SampleInfo | null): void;
}

export interface OwnSamplesDeps {
  /** Opens the store on this device (openSampleStore with the browser's indexedDB); rejects when there is none. */
  readonly open: () => Promise<SampleStore>;
  /** Decodes a file (audio/samples/decode.ts decodeSample). */
  readonly decode: (bytes: ArrayBuffer) => Promise<{ readonly buffer: AudioBuffer; readonly info: SampleInfo }>;
  readonly assignments: SampleAssignments;
  readonly sink: SampleSink;
}

export type OwnSamplesState =
  | { readonly kind: 'closed' }
  | { readonly kind: 'opening' }
  | { readonly kind: 'ready' }
  | { readonly kind: 'unavailable'; readonly message: string };

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** '1.2 s', '0.4 s', '58 s'. */
export function secondsText(s: number): string {
  return s < 10 ? `${s.toFixed(1)} s` : `${Math.round(s)} s`;
}

/** One line of the samples list: 'pad.wav · 3.2 s · 812 KB'. */
export function sampleLine(m: Pick<SampleMeta, 'name' | 'seconds' | 'bytes'>): string {
  return `${m.name} · ${secondsText(m.seconds)} · ${formatBytes(m.bytes)}`;
}

/** The total line: 'n own samples · 3.4 MB · kept only in this browser, never uploaded'. */
export function usageLine(u: Pick<SampleUsage, 'count' | 'bytes'>): string {
  const n = u.count === 1 ? '1 own sample' : `${u.count} own samples`;
  return `${n} · ${formatBytes(u.bytes)} · kept only in this browser, never uploaded`;
}

/** The note for a layer whose own sample is not on this device (plan 15.3). */
export function missingNote(layer: SynthLayer, ref: Pick<UserSampleRef, 'name'>): string {
  return `layer ${layer.toLowerCase()}: own sample "${ref.name}" is not on this device: import the file again or load the `
    + 'preset that embeds it';
}

/** MIDI note names for the root select: 0 → 'C-1', 60 → 'C4', 127 → 'G9'. */
export function noteName(n: number): string {
  const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  return `${names[n % 12]!}${Math.floor(n / 12) - 1}`;
}

export class OwnSamples {
  readonly #deps: OwnSamplesDeps;
  #store: SampleStore | null = null;
  #state: OwnSamplesState = { kind: 'closed' };
  #list: SampleMeta[] = [];
  #usage: SampleUsage | null = null;
  /** Hashes with a decoded buffer in the sink. */
  readonly #loaded = new Set<SampleHash>();
  readonly #loading = new Map<SampleHash, Promise<boolean>>();
  /** Stored samples that could not be read or decoded, with the reason. */
  readonly #failed = new Map<SampleHash, string>();
  readonly #listeners = new Set<() => void>();
  #opening: Promise<void> | null = null;

  constructor(deps: OwnSamplesDeps) {
    this.#deps = deps;
  }

  get state(): OwnSamplesState {
    return this.#state;
  }

  /** The samples on this device, newest first. */
  get list(): readonly SampleMeta[] {
    return this.#list;
  }

  get usage(): SampleUsage | null {
    return this.#usage;
  }

  get assignments(): SampleAssignments {
    return this.#deps.assignments;
  }

  meta(hash: SampleHash): SampleMeta | null {
    return this.#list.find((m) => m.hash === hash) ?? null;
  }

  onChange(fn: () => void): () => void {
    this.#listeners.add(fn);
    return () => {
      this.#listeners.delete(fn);
    };
  }

  #notify(): void {
    for (const fn of [...this.#listeners]) fn();
  }

  /** Open the store (once) and list the samples; then load what the layers use. */
  open(): Promise<void> {
    if (this.#opening !== null) return this.#opening;
    this.#state = { kind: 'opening' };
    this.#notify();
    this.#opening = (async () => {
      try {
        this.#store = await this.#deps.open();
        this.#state = { kind: 'ready' };
        await this.#refresh();
        await this.loadAssigned();
      } catch (err) {
        this.#store = null;
        this.#state = { kind: 'unavailable', message: messageOf(err) };
        this.#notify();
      }
    })();
    return this.#opening;
  }

  async #refresh(): Promise<void> {
    if (this.#store === null) return;
    this.#list = await this.#store.list();
    try {
      this.#usage = await this.#store.usage();
    } catch {
      this.#usage = { count: this.#list.length, bytes: this.#list.reduce((n, m) => n + m.bytes, 0), originUsage: null, originQuota: null };
    }
    this.#notify();
  }

  /** Import a file: decode it, keep it on this device, and have its buffer ready. Resolves with the print-out line. */
  async import(file: AudioFileLike): Promise<{ readonly ok: boolean; readonly message: string; readonly meta?: SampleMeta }> {
    await this.open();
    if (this.#store === null) return { ok: false, message: `${file.name}: ${this.#unavailableText()}` };
    if (file.size > MAX_SAMPLE_BYTES) {
      return { ok: false, message: `${file.name}: ${new SampleStoreError('too-large').message}` };
    }
    try {
      const bytes = await file.arrayBuffer();
      // Decode a copy: decodeAudioData may detach the buffer it is given.
      const decoded = await this.#deps.decode(bytes.slice(0));
      const meta = await this.#store.put({ name: file.name, mime: file.type ?? '', bytes }, decoded.info);
      this.#deps.sink.setBuffer(meta.hash, decoded.buffer, decoded.info);
      this.#loaded.add(meta.hash);
      await this.#refresh();
      return { ok: true, message: `own sample stored on this device: ${sampleLine(meta)}`, meta };
    } catch (err) {
      return { ok: false, message: `${file.name}: ${messageOf(err)}` };
    }
  }

  /** Delete a sample from this device; layers that play it fall silent with a note. */
  async remove(hash: SampleHash): Promise<{ readonly ok: boolean; readonly message: string }> {
    const name = this.meta(hash)?.name ?? hash.slice(0, 15);
    if (this.#store === null) return { ok: false, message: `${name}: ${this.#unavailableText()}` };
    try {
      await this.#store.delete(hash);
      this.#deps.sink.setBuffer(hash, null, null);
      this.#loaded.delete(hash);
      await this.#refresh();
      const users = this.usersOf(hash);
      const tail = users.length === 0 ? '' : `; layer ${users.map((l) => l.toLowerCase()).join(', ')} now silent`;
      return { ok: true, message: `own sample deleted from this device: ${name}${tail}` };
    } catch (err) {
      return { ok: false, message: `${name}: ${messageOf(err)}` };
    }
  }

  /** The synth layers whose assignment names a hash. */
  usersOf(hash: SampleHash): SynthLayer[] {
    return LAYERS.filter((l) => this.#deps.assignments.get(l)?.hash === hash);
  }

  /** Assign a sample to a layer (defaults: root C4, one-shot), or with null clear it. */
  assign(layer: SynthLayer, hash: SampleHash | null): void {
    if (hash === null) {
      this.#deps.assignments.set(layer, null);
    } else {
      const meta = this.meta(hash);
      const current = this.#deps.assignments.get(layer);
      const ref = current !== null && current.hash === hash ? current : sampleRef(hash, meta?.name ?? hash.slice(0, 15));
      this.#deps.assignments.set(layer, ref);
      void this.#load(hash);
    }
    this.#notify();
  }

  /** Change a layer's root, loop mode or loop points. */
  update(layer: SynthLayer, patch: Partial<Pick<UserSampleRef, 'root' | 'loop' | 'loopStart' | 'loopEnd'>>): void {
    const ref = this.#deps.assignments.get(layer);
    if (ref === null) return;
    const next = { ...ref, ...patch };
    // loopEnd 0 is the end of the file; any other end stays after the start.
    if (next.loopEnd !== 0 && next.loopEnd <= next.loopStart) next.loopEnd = 0;
    this.#deps.assignments.set(layer, next);
    this.#notify();
  }

  /** Make every assigned sample's buffer ready (after open, a load or an import). */
  async loadAssigned(): Promise<void> {
    await Promise.all([...this.#deps.assignments.hashes()].map((h) => this.#load(h)));
    this.#notify();
  }

  #load(hash: SampleHash): Promise<boolean> {
    if (this.#loaded.has(hash)) return Promise.resolve(true);
    const pending = this.#loading.get(hash);
    if (pending !== undefined) return pending;
    const run = (async () => {
      if (this.#store === null) return false;
      try {
        const got = await this.#store.get(hash);
        if (got === null) return false;
        const decoded = await this.#deps.decode(got.bytes.slice(0));
        this.#deps.sink.setBuffer(hash, decoded.buffer, decoded.info);
        this.#loaded.add(hash);
        this.#failed.delete(hash);
        return true;
      } catch (err) {
        this.#failed.set(hash, messageOf(err));
        return false;
      } finally {
        this.#loading.delete(hash);
      }
    })();
    this.#loading.set(hash, run);
    return run;
  }

  /**
   * Why a layer's assigned sample does not play, when it is stored here but could not be read or
   * decoded; null otherwise (no assignment, loaded, still loading, or not on this device: missingNotes).
   */
  failedNote(layer: SynthLayer): string | null {
    const ref = this.#deps.assignments.get(layer);
    if (ref === null || this.#loaded.has(ref.hash) || this.#loading.has(ref.hash)) return null;
    if (!this.#list.some((m) => m.hash === ref.hash)) return null;
    const message = this.#failed.get(ref.hash);
    return message === undefined ? null : `own sample "${ref.name}" does not play here: ${message}`;
  }

  /** Notes for the layers whose sample is not on this device (none while the store is still opening). */
  missingNotes(samples: LayerSamples = this.#deps.assignments.all()): string[] {
    if (this.#state.kind === 'opening' || this.#state.kind === 'closed') return [];
    const have = new Set(this.#list.map((m) => m.hash));
    return LAYERS.flatMap((l) => {
      const ref = samples[l];
      return ref !== undefined && !have.has(ref.hash) ? [missingNote(l, ref)] : [];
    });
  }

  /**
   * The files of the assigned samples, for an app preset download with "embed own samples" on,
   * with a print-out note for each assigned sample that could not be embedded (not on this device,
   * the store unavailable or failing).
   */
  async embedded(): Promise<{ embedded: Map<SampleHash, EmbeddedSample>; notes: string[] }> {
    const samples = this.#deps.assignments.all();
    if (LAYERS.every((l) => samples[l] === undefined)) return { embedded: new Map(), notes: [] };
    await this.open();
    const store = this.#store;
    const unavailable = this.#unavailableText();
    return collectEmbedded(samples,
      (hash) => (store === null ? Promise.reject(new Error(unavailable)) : store.get(hash)));
  }

  /** Keep the files a preset embedded on this device; resolves with the print-out lines. */
  async storeEmbedded(embedded: ReadonlyMap<SampleHash, EmbeddedSample>): Promise<string[]> {
    if (embedded.size === 0) return [];
    await this.open();
    if (this.#store === null) return [`embedded own samples not stored: ${this.#unavailableText()}`];
    let stored = 0;
    const notes: string[] = [];
    for (const [hash, e] of embedded) {
      try {
        const bytes = decodeBase64Strict(e.bytesBase64);
        const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
        const decoded = await this.#deps.decode(buffer.slice(0));
        const meta = await this.#store.put({ name: e.name, mime: e.mime, bytes: buffer }, decoded.info);
        this.#deps.sink.setBuffer(meta.hash, decoded.buffer, decoded.info);
        this.#loaded.add(hash);
        stored += 1;
      } catch (err) {
        notes.push(`embedded sample "${e.name}": ${messageOf(err)}`);
      }
    }
    await this.#refresh();
    if (stored > 0) notes.unshift(`${stored} own ${stored === 1 ? 'sample' : 'samples'} stored on this device`);
    return notes;
  }

  #unavailableText(): string {
    return this.#state.kind === 'unavailable' ? this.#state.message : 'own samples are not available here';
  }
}
