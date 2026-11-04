/**
 * Own samples on this device (plan section 15.3): the contract of the sample store and of the
 * sample data an app preset may embed. The user picks audio files; the editor decodes them
 * (audio/samples, decodeAudioData) and keeps the original file bytes in IndexedDB under their
 * SHA-256 content hash. Nothing is uploaded: the page makes no network requests, and the bytes
 * leave the device only inside an app preset the user downloads with "embed own samples" on.
 *
 * IndexedDB schema (database SAMPLE_DB, version 1):
 *   object store 'meta' (keyPath 'hash'): SampleMeta, one per file, small; listed for the manager
 *   object store 'data' (keyPath 'hash'): { hash, bytes: ArrayBuffer }, the file as picked
 * Two stores so listing never loads audio. put() writes both in one transaction; delete() removes
 * both. The same file imported twice is one entry (same hash).
 *
 * The contract and the hash are shared (plan 15.0); the IndexedDB implementation below is B3's.
 */
import { HASH_RE, type SampleHash, type SampleInfo } from '../model/user-samples.ts';

export type { LayerSamples, LoopMode, SampleHash, SampleInfo, UserSampleRef } from '../model/user-samples.ts';

export const SAMPLE_DB = 'ns4-editor-samples';
export const SAMPLE_DB_VERSION = 1;
export const META_STORE = 'meta';
export const DATA_STORE = 'data';

/** The largest file the editor imports, and the longest decoded audio (memory: 60 s stereo at 48 kHz ≈ 23 MB as floats). */
export const MAX_SAMPLE_BYTES = 32 * 1024 * 1024;
export const MAX_SAMPLE_SECONDS = 60;
/** The file picker's accept list: whatever the browser decodes; these are the usual ones (wav, aiff, mp3, ogg, flac). */
export const SAMPLE_ACCEPT = 'audio/*,.wav,.wave,.aif,.aiff,.mp3,.ogg,.oga,.flac';

/** What the store keeps about one file (no audio): the decoding facts (SampleInfo) plus these. */
export interface SampleMeta extends SampleInfo {
  readonly hash: SampleHash;
  /** The file name as picked. */
  readonly name: string;
  /** The file's MIME type as the browser reported it ('' when unknown). */
  readonly mime: string;
  /** Size of the stored file in bytes. */
  readonly bytes: number;
  /** ISO 8601 time of the first import. */
  readonly added: string;
}

/** What decoding tells the store (audio/samples computes it; the store adds hash, name, mime, size, date). */
export type DecodedInfo = SampleInfo;

/** Storage use for the samples manager. */
export interface SampleUsage {
  readonly count: number;
  /** Sum of the stored files' sizes. */
  readonly bytes: number;
  /** The browser's estimate for the whole origin (navigator.storage.estimate), null where it has none. */
  readonly originUsage: number | null;
  readonly originQuota: number | null;
}

export type SampleStoreProblem = 'unavailable' | 'blocked' | 'quota' | 'too-large' | 'too-long' | 'not-audio' | 'corrupt';

/** A short message for the print-out per problem; the store's errors carry one of them. */
export const SAMPLE_PROBLEM_TEXT: Readonly<Record<SampleStoreProblem, string>> = {
  unavailable: 'this browser keeps no sample storage here (private mode or blocked): own samples are not available',
  blocked: 'sample storage is blocked by another tab of the editor; close it and try again',
  quota: 'browser storage is full: delete own samples you no longer use',
  'too-large': `the file is larger than ${MAX_SAMPLE_BYTES / 1024 / 1024} MB`,
  'too-long': `the audio is longer than ${MAX_SAMPLE_SECONDS} s`,
  'not-audio': 'this browser cannot decode the file as audio',
  corrupt: 'a stored sample is damaged; delete it and import the file again',
};

export class SampleStoreError extends Error {
  readonly problem: SampleStoreProblem;
  constructor(problem: SampleStoreProblem, detail?: string) {
    super(detail === undefined ? SAMPLE_PROBLEM_TEXT[problem] : `${SAMPLE_PROBLEM_TEXT[problem]} (${detail})`);
    this.name = 'SampleStoreError';
    this.problem = problem;
  }
}

/** The samples on this device. Every method rejects with SampleStoreError. */
export interface SampleStore {
  /** Keep a file (idempotent by content hash); returns its meta, the existing one for a known hash. */
  put(file: { readonly name: string; readonly mime: string; readonly bytes: ArrayBuffer }, decoded: DecodedInfo): Promise<SampleMeta>;
  /** The meta and the file bytes, or null for an unknown hash. */
  get(hash: SampleHash): Promise<{ readonly meta: SampleMeta; readonly bytes: ArrayBuffer } | null>;
  /** Every sample's meta, newest first. */
  list(): Promise<SampleMeta[]>;
  /** Remove a sample (unknown hashes are no error). Layers that play it fall silent with a note. */
  delete(hash: SampleHash): Promise<void>;
  usage(): Promise<SampleUsage>;
}

/**
 * Opens the store (creating the database on first use). `idb` is the browser's indexedDB (main
 * passes it; tests pass a fake), `estimate` navigator.storage.estimate where it exists.
 */
export type OpenSampleStore = (
  idb: IDBFactory,
  options?: { readonly estimate?: () => Promise<{ readonly usage?: number; readonly quota?: number }> },
) => Promise<SampleStore>;

/** A sample embedded in an app preset ("embeddedSamples": { "<hash>": EmbeddedSample }). */
export interface EmbeddedSample {
  readonly name: string;
  readonly mime: string;
  readonly bytesBase64: string;
}

/** The largest preset text with embedded samples (base64 grows the bytes by a third); without them the 1 MB limit stays. */
export const MAX_PRESET_WITH_SAMPLES_BYTES = 48 * 1024 * 1024;

/** The error of a failed IndexedDB request or transaction as a store problem. */
function problemOf(err: unknown, fallback: SampleStoreProblem = 'unavailable'): SampleStoreError {
  if (err instanceof SampleStoreError) return err;
  const name = typeof err === 'object' && err !== null && 'name' in err ? String((err as { name: unknown }).name) : '';
  if (name === 'QuotaExceededError') return new SampleStoreError('quota');
  return new SampleStoreError(fallback, name === '' ? undefined : name);
}

/** A request's result as a promise (rejects with a store problem). */
function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(problemOf(req.error));
  });
}

/** Resolves when a transaction commits; rejects when it fails or aborts. */
function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(problemOf(tx.error));
    tx.onabort = () => reject(problemOf(tx.error));
  });
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** A stored meta record, or null when it is not one (skipped in lists, 'corrupt' in get). */
function readMeta(v: unknown): SampleMeta | null {
  if (!isRecord(v)) return null;
  const { hash, name, mime, bytes, added, sampleRate, channels, frames, seconds, attackEnd } = v;
  if (typeof hash !== 'string' || !HASH_RE.test(hash) || typeof name !== 'string' || typeof mime !== 'string'
    || typeof added !== 'string') return null;
  for (const n of [bytes, sampleRate, channels, frames, seconds, attackEnd]) {
    if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return null;
  }
  return {
    hash, name, mime, added, bytes: bytes as number, sampleRate: sampleRate as number, channels: channels as number,
    frames: frames as number, seconds: seconds as number, attackEnd: attackEnd as number,
  };
}

/** Newest first; the same date by name, then hash, so the order is stable. */
function newestFirst(a: SampleMeta, b: SampleMeta): number {
  if (a.added !== b.added) return a.added < b.added ? 1 : -1;
  if (a.name !== b.name) return a.name < b.name ? -1 : 1;
  return a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0;
}

type Estimate = () => Promise<{ readonly usage?: number; readonly quota?: number }>;

class IdbSampleStore implements SampleStore {
  readonly #db: IDBDatabase;
  readonly #estimate: Estimate | undefined;

  constructor(db: IDBDatabase, estimate: Estimate | undefined) {
    this.#db = db;
    this.#estimate = estimate;
  }

  #tx(stores: string[], mode: IDBTransactionMode): IDBTransaction {
    try {
      return this.#db.transaction(stores, mode);
    } catch (err) {
      throw problemOf(err);
    }
  }

  async put(file: { readonly name: string; readonly mime: string; readonly bytes: ArrayBuffer },
    decoded: DecodedInfo): Promise<SampleMeta> {
    if (file.bytes.byteLength > MAX_SAMPLE_BYTES) throw new SampleStoreError('too-large', file.name);
    if (!(decoded.seconds <= MAX_SAMPLE_SECONDS + 0.01)) throw new SampleStoreError('too-long', file.name);
    const hash = await contentHash(file.bytes);
    const meta: SampleMeta = {
      hash, name: file.name, mime: file.mime, bytes: file.bytes.byteLength, added: new Date().toISOString(),
      sampleRate: decoded.sampleRate, channels: decoded.channels, frames: decoded.frames, seconds: decoded.seconds,
      attackEnd: decoded.attackEnd,
    };
    const tx = this.#tx([META_STORE, DATA_STORE], 'readwrite');
    const committed = done(tx);
    let result = meta;
    const known = tx.objectStore(META_STORE).get(hash);
    known.onsuccess = () => {
      const existing = readMeta(known.result);
      if (existing !== null) {
        result = existing;
        return;
      }
      // Both stores in this one transaction: never a meta without its data.
      tx.objectStore(META_STORE).put(meta);
      tx.objectStore(DATA_STORE).put({ hash, bytes: file.bytes });
    };
    await committed;
    return result;
  }

  async get(hash: SampleHash): Promise<{ readonly meta: SampleMeta; readonly bytes: ArrayBuffer } | null> {
    const tx = this.#tx([META_STORE, DATA_STORE], 'readonly');
    const [rawMeta, rawData] = await Promise.all([
      request(tx.objectStore(META_STORE).get(hash)), request(tx.objectStore(DATA_STORE).get(hash)),
    ]);
    if (rawMeta === undefined && rawData === undefined) return null;
    const meta = readMeta(rawMeta);
    const bytes = isRecord(rawData) ? rawData['bytes'] : undefined;
    if (meta === null || !(bytes instanceof ArrayBuffer) || bytes.byteLength !== meta.bytes) {
      throw new SampleStoreError('corrupt', hash.slice(0, 15));
    }
    return { meta, bytes };
  }

  async list(): Promise<SampleMeta[]> {
    const tx = this.#tx([META_STORE], 'readonly');
    const all = await request(tx.objectStore(META_STORE).getAll() as IDBRequest<unknown[]>);
    return all.map(readMeta).filter((m): m is SampleMeta => m !== null).sort(newestFirst);
  }

  async delete(hash: SampleHash): Promise<void> {
    const tx = this.#tx([META_STORE, DATA_STORE], 'readwrite');
    const committed = done(tx);
    tx.objectStore(META_STORE).delete(hash);
    tx.objectStore(DATA_STORE).delete(hash);
    await committed;
  }

  async usage(): Promise<SampleUsage> {
    const list = await this.list();
    let originUsage: number | null = null;
    let originQuota: number | null = null;
    if (this.#estimate !== undefined) {
      try {
        const e = await this.#estimate();
        originUsage = typeof e.usage === 'number' ? e.usage : null;
        originQuota = typeof e.quota === 'number' ? e.quota : null;
      } catch {
        // No estimate: the manager shows the samples' own sum only.
      }
    }
    return { count: list.length, bytes: list.reduce((s, m) => s + m.bytes, 0), originUsage, originQuota };
  }
}

/**
 * Opens the store on this device, creating the database on first use. Rejects with
 * SampleStoreError: 'unavailable' when IndexedDB refuses (private modes, blocked storage),
 * 'blocked' when another tab holds an older version open.
 */
export const openSampleStore: OpenSampleStore = (idb, options) => new Promise((resolve, reject) => {
  let req: IDBOpenDBRequest;
  try {
    req = idb.open(SAMPLE_DB, SAMPLE_DB_VERSION);
  } catch (err) {
    reject(problemOf(err));
    return;
  }
  req.onupgradeneeded = () => {
    const db = req.result;
    if (!db.objectStoreNames.contains(META_STORE)) db.createObjectStore(META_STORE, { keyPath: 'hash' });
    if (!db.objectStoreNames.contains(DATA_STORE)) db.createObjectStore(DATA_STORE, { keyPath: 'hash' });
  };
  req.onblocked = () => reject(new SampleStoreError('blocked'));
  req.onerror = () => reject(problemOf(req.error));
  req.onsuccess = () => {
    const db = req.result;
    // A newer editor in another tab upgrades: let it, this tab reopens on its next load.
    db.onversionchange = () => db.close();
    resolve(new IdbSampleStore(db, options?.estimate));
  };
});

const HEX = '0123456789abcdef';

/**
 * The content hash of a file: 'sha256-' and 64 hex digits. SubtleCrypto exists only in secure
 * contexts (https, localhost) and Node 22; elsewhere (a dev server over the LAN) contentHashSync.
 */
export async function contentHash(bytes: ArrayBuffer | Uint8Array,
  subtle: Pick<SubtleCrypto, 'digest'> | null = globalThis.crypto?.subtle ?? null): Promise<SampleHash> {
  if (subtle === null) return contentHashSync(bytes);
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const digest = new Uint8Array(await subtle.digest('SHA-256', data as Uint8Array<ArrayBuffer>));
  let out = 'sha256-';
  for (const b of digest) out += HEX[b >> 4]! + HEX[b & 15]!;
  return out;
}

const K256 = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/**
 * contentHash without SubtleCrypto, synchronously (FIPS 180-4 SHA-256): readPresetExtras checks
 * every embedded file against its hash while it parses, which cannot wait for a promise. Same
 * output as contentHash (samples-db tests compare them).
 */
export function contentHashSync(bytes: ArrayBuffer | Uint8Array): SampleHash {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const w = new Uint32Array(64);
  const block = (src: Uint8Array, at: number): void => {
    for (let i = 0; i < 16; i++) {
      const j = at + i * 4;
      w[i] = (src[j]! << 24) | (src[j + 1]! << 16) | (src[j + 2]! << 8) | src[j + 3]!;
    }
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15]!;
      const b = w[i - 2]!;
      const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
      const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) | 0;
    }
    let a = h[0]!, b = h[1]!, c = h[2]!, d = h[3]!, e = h[4]!, f = h[5]!, g = h[6]!, k = h[7]!;
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const t1 = (k + S1 + ((e & f) ^ (~e & g)) + K256[i]! + w[i]!) | 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const t2 = (S0 + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      k = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }
    h[0] = h[0]! + a; h[1] = h[1]! + b; h[2] = h[2]! + c; h[3] = h[3]! + d;
    h[4] = h[4]! + e; h[5] = h[5]! + f; h[6] = h[6]! + g; h[7] = h[7]! + k;
  };
  const full = data.length - (data.length % 64);
  for (let at = 0; at < full; at += 64) block(data, at);
  // The tail: the rest, 0x80, zeros, and the length in bits as a 64-bit big-endian number.
  const rest = data.length - full;
  const tail = new Uint8Array(rest < 56 ? 64 : 128);
  tail.set(data.subarray(full));
  tail[rest] = 0x80;
  const bits = data.length * 8;
  const hi = Math.floor(bits / 2 ** 32);
  const lo = bits >>> 0;
  const end = tail.length;
  tail[end - 8] = hi >>> 24; tail[end - 7] = hi >>> 16; tail[end - 6] = hi >>> 8; tail[end - 5] = hi;
  tail[end - 4] = lo >>> 24; tail[end - 3] = lo >>> 16; tail[end - 2] = lo >>> 8; tail[end - 1] = lo;
  for (let at = 0; at < end; at += 64) block(tail, at);
  let out = 'sha256-';
  for (const word of h) out += word.toString(16).padStart(8, '0');
  return out;
}

/** Bytes for the samples manager: '812 KB', '3.4 MB'. */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '–';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
