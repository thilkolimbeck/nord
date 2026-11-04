/**
 * Own samples for the synth's samples mode (manual p.28, plan section 15.3): which imported audio
 * file each synth layer plays, at which root note, looped or once. Only a reference lives here and
 * in app presets: the audio itself stays on this device (formats/samples-db.ts, IndexedDB) under its
 * content hash, and is never part of a .ns4p (the Stage 4 cannot use it) or of the browser slots.
 *
 * Nord's samples are not available: the stored Nord sample fields (synth{L}.libName, smpId,
 * smpNameHash) stay as they are, untouched by an assignment here. Pure: no DOM, no Web Audio.
 */
import { LAYERS, type SynthLayer } from './keys.ts';

/** A SHA-256 content hash as 'sha256-' plus 64 lowercase hex digits. */
export type SampleHash = string;
export const HASH_RE = /^sha256-[0-9a-f]{64}$/;

export type LoopMode = 'one-shot' | 'loop';
export const LOOP_MODES: readonly LoopMode[] = ['one-shot', 'loop'];

/** One layer's own sample. */
export interface UserSampleRef {
  readonly hash: SampleHash;
  /** The file name at import, for notes and lists (not unique; the hash is). */
  readonly name: string;
  /** The MIDI note (0..127) that plays the file at its own pitch; default 60 (C4). */
  readonly root: number;
  /** 'one-shot': plays once to its end (the amp envelope still applies); 'loop': repeats loopStart..loopEnd. */
  readonly loop: LoopMode;
  /** Loop start in seconds from the start of the file, ≥ 0. */
  readonly loopStart: number;
  /** Loop end in seconds; 0 means the end of the file. Otherwise > loopStart. */
  readonly loopEnd: number;
}

export const DEFAULT_ROOT = 60;

/** What decoding a file tells (audio/samples computes it; formats/samples-db.ts stores it with the file's meta). */
export interface SampleInfo {
  readonly sampleRate: number;
  readonly channels: number;
  readonly frames: number;
  readonly seconds: number;
  /**
   * Seconds from the start to where the attack has passed (the level first reaches −6 dB of the
   * peak): where FAST ATK starts the sample (M p.28, plan 15.3).
   */
  readonly attackEnd: number;
}

/** The assignments of one program: at most one sample per synth layer. */
export type LayerSamples = Readonly<Partial<Record<SynthLayer, UserSampleRef>>>;

/** A new reference with the defaults: root C4, one-shot, the whole file. */
export function sampleRef(hash: SampleHash, name: string): UserSampleRef {
  return { hash, name, root: DEFAULT_ROOT, loop: 'one-shot', loopStart: 0, loopEnd: 0 };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** One reference from preset JSON, or the reason it is refused. */
export function parseSampleRef(v: unknown): UserSampleRef | string {
  if (!isRecord(v)) return 'not an object';
  const { hash, name, root, loop, loopStart, loopEnd } = v;
  if (typeof hash !== 'string' || !HASH_RE.test(hash)) return 'hash invalid';
  if (typeof name !== 'string') return 'name invalid';
  if (typeof root !== 'number' || !Number.isInteger(root) || root < 0 || root > 127) return 'root invalid';
  if (loop !== 'one-shot' && loop !== 'loop') return 'loop invalid';
  if (typeof loopStart !== 'number' || !Number.isFinite(loopStart) || loopStart < 0) return 'loopStart invalid';
  if (typeof loopEnd !== 'number' || !Number.isFinite(loopEnd) || loopEnd < 0 || (loopEnd !== 0 && loopEnd <= loopStart)) {
    return 'loopEnd invalid';
  }
  return { hash, name, root, loop, loopStart, loopEnd };
}

/**
 * The `userSamples` member of an app preset (plan 15.3): { "A": ref, "C": ref }. Absent or null is
 * no assignment. A bad entry is dropped with a note; the program itself still loads.
 */
export function parseLayerSamples(v: unknown): { readonly samples: LayerSamples; readonly notes: readonly string[] } {
  if (v === undefined || v === null) return { samples: {}, notes: [] };
  if (!isRecord(v)) return { samples: {}, notes: ['own samples: not an object, ignored'] };
  const samples: Partial<Record<SynthLayer, UserSampleRef>> = {};
  const notes: string[] = [];
  for (const [layer, raw] of Object.entries(v)) {
    if (!(LAYERS as readonly string[]).includes(layer)) {
      notes.push(`own samples: unknown layer ${layer}, ignored`);
      continue;
    }
    const ref = parseSampleRef(raw);
    if (typeof ref === 'string') notes.push(`own samples: layer ${layer.toLowerCase()}: ${ref}, ignored`);
    else samples[layer as SynthLayer] = ref;
  }
  return { samples, notes };
}

/** The `userSamples` member to write: layers in order, only assigned ones; null when none. */
export function layerSamplesJson(s: LayerSamples): Record<string, UserSampleRef> | null {
  const out: Record<string, UserSampleRef> = {};
  for (const layer of LAYERS) {
    const ref = s[layer];
    if (ref !== undefined) out[layer] = { ...ref };
  }
  return Object.keys(out).length === 0 ? null : out;
}

/** The assignments the editor plays now, with change listeners (main wires presets and the samples engine to it). */
export class SampleAssignments {
  #samples: LayerSamples = {};
  readonly #listeners = new Set<(s: LayerSamples) => void>();

  get(layer: SynthLayer): UserSampleRef | null {
    return this.#samples[layer] ?? null;
  }

  all(): LayerSamples {
    return this.#samples;
  }

  /** Assign (or with null clear) one layer's sample. */
  set(layer: SynthLayer, ref: UserSampleRef | null): void {
    const next: Partial<Record<SynthLayer, UserSampleRef>> = { ...this.#samples };
    if (ref === null) delete next[layer];
    else next[layer] = ref;
    this.#samples = next;
    this.#notify();
  }

  /** Replace every assignment (a program load). */
  load(samples: LayerSamples): void {
    this.#samples = { ...samples };
    this.#notify();
  }

  /** The hashes in use. */
  hashes(): Set<SampleHash> {
    return new Set(Object.values(this.#samples).map((r) => r.hash));
  }

  onChange(fn: (s: LayerSamples) => void): () => void {
    this.#listeners.add(fn);
    return () => {
      this.#listeners.delete(fn);
    };
  }

  #notify(): void {
    for (const fn of [...this.#listeners]) fn(this.#samples);
  }
}
