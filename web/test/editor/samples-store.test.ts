/**
 * Plan section 15.3, the own-samples store on IndexedDB (formats/samples-db.ts openSampleStore), on
 * a fake IndexedDB written here as plain objects: put is idempotent by content hash and writes meta
 * and data in one transaction, list is newest first and never touches the data store, delete
 * removes both, usage sums the files and adds the browser's estimate, and every failure is a
 * SampleStoreError with its problem (quota, blocked, unavailable, too large, too long, corrupt).
 * Also the synchronous SHA-256 the preset reader uses, against SubtleCrypto.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  contentHash, contentHashSync, DATA_STORE, MAX_SAMPLE_BYTES, META_STORE, openSampleStore, SAMPLE_DB,
  SAMPLE_DB_VERSION, type SampleInfo, SampleStoreError, type SampleStoreProblem,
} from '../../src/editor/formats/samples-db.ts';

// ---------------------------------------------------------------------------------------------
// A fake IndexedDB: enough of the API for the store, asynchronous like the real one (callbacks on
// a later task), transactions that roll back on abort.

type Handler = (() => void) | null;

class FakeRequest<T = unknown> {
  result: T = undefined as T;
  error: unknown = null;
  onsuccess: Handler = null;
  onerror: Handler = null;
}

class FakeOpenRequest extends FakeRequest<FakeDb> {
  onupgradeneeded: Handler = null;
  onblocked: Handler = null;
}

class FakeObjectStore {
  readonly #tx: FakeTx;
  readonly #name: string;
  constructor(tx: FakeTx, name: string) {
    this.#tx = tx;
    this.#name = name;
  }
  get #rows(): Map<string, unknown> {
    return this.#tx.db.rows.get(this.#name)!;
  }
  get(key: string): FakeRequest {
    this.#tx.db.reads.push(this.#name);
    return this.#tx.request(() => structuredClone(this.#rows.get(key)));
  }
  getAll(): FakeRequest {
    this.#tx.db.reads.push(this.#name);
    return this.#tx.request(() => [...this.#rows.values()].map((v) => structuredClone(v)));
  }
  put(value: Record<string, unknown>): FakeRequest {
    if (this.#tx.mode !== 'readwrite') throw Object.assign(new Error('read only'), { name: 'ReadOnlyError' });
    return this.#tx.request(() => {
      const key = value['hash'] as string;
      const bytes = value['bytes'];
      if (bytes instanceof ArrayBuffer && this.#tx.db.used() + bytes.byteLength > this.#tx.db.quota) {
        throw Object.assign(new Error('quota'), { name: 'QuotaExceededError' });
      }
      this.#tx.undo.push([this.#name, key, this.#rows.get(key)]);
      this.#rows.set(key, structuredClone(value));
      return key;
    });
  }
  delete(key: string): FakeRequest {
    return this.#tx.request(() => {
      this.#tx.undo.push([this.#name, key, this.#rows.get(key)]);
      this.#rows.delete(key);
      return undefined;
    });
  }
}

class FakeTx {
  readonly db: FakeDb;
  readonly mode: IDBTransactionMode;
  readonly undo: Array<[string, string, unknown]> = [];
  error: unknown = null;
  oncomplete: Handler = null;
  onerror: Handler = null;
  onabort: Handler = null;
  #pending = 0;
  #finished = false;
  constructor(db: FakeDb, mode: IDBTransactionMode) {
    this.db = db;
    this.mode = mode;
    this.#settleLater();
  }
  objectStore(name: string): FakeObjectStore {
    if (!this.db.rows.has(name)) throw Object.assign(new Error(name), { name: 'NotFoundError' });
    return new FakeObjectStore(this, name);
  }
  request(fn: () => unknown): FakeRequest {
    const req = new FakeRequest();
    this.#pending++;
    setTimeout(() => {
      if (this.#finished) return;
      try {
        req.result = fn();
        req.onsuccess?.();
      } catch (err) {
        req.error = err;
        req.onerror?.();
        this.#abort(err);
      }
      this.#pending--;
      this.#settleLater();
    }, 0);
    return req;
  }
  #abort(err: unknown): void {
    if (this.#finished) return;
    this.#finished = true;
    this.error = err;
    for (const [store, key, before] of this.undo.reverse()) {
      if (before === undefined) this.db.rows.get(store)!.delete(key);
      else this.db.rows.get(store)!.set(key, before);
    }
    this.onabort?.();
  }
  #settleLater(): void {
    setTimeout(() => {
      if (this.#finished || this.#pending > 0) return;
      this.#finished = true;
      this.oncomplete?.();
    }, 0);
  }
}

class FakeDb {
  readonly rows = new Map<string, Map<string, unknown>>();
  readonly reads: string[] = [];
  version = 0;
  quota = Infinity;
  onversionchange: Handler = null;
  closed = false;
  readonly objectStoreNames = { contains: (name: string) => this.rows.has(name) };
  createObjectStore(name: string, options: { keyPath: string }): void {
    assert.equal(options.keyPath, 'hash');
    this.rows.set(name, new Map());
  }
  transaction(names: string[], mode: IDBTransactionMode = 'readonly'): FakeTx {
    for (const n of names) if (!this.rows.has(n)) throw Object.assign(new Error(n), { name: 'NotFoundError' });
    return new FakeTx(this, mode);
  }
  close(): void {
    this.closed = true;
  }
  used(): number {
    let n = 0;
    for (const v of this.rows.get(DATA_STORE)?.values() ?? []) n += ((v as { bytes: ArrayBuffer }).bytes).byteLength;
    return n;
  }
}

class FakeFactory {
  readonly dbs = new Map<string, FakeDb>();
  blocked = false;
  throws: string | null = null;
  fails: string | null = null;
  open(name: string, version: number): FakeOpenRequest {
    if (this.throws !== null) throw Object.assign(new Error(this.throws), { name: this.throws });
    const req = new FakeOpenRequest();
    setTimeout(() => {
      if (this.blocked) {
        req.onblocked?.();
        return;
      }
      if (this.fails !== null) {
        req.error = Object.assign(new Error(this.fails), { name: this.fails });
        req.onerror?.();
        return;
      }
      let db = this.dbs.get(name);
      if (db === undefined) {
        db = new FakeDb();
        this.dbs.set(name, db);
      }
      req.result = db;
      if (db.version < version) {
        db.version = version;
        req.onupgradeneeded?.();
      }
      req.onsuccess?.();
    }, 0);
    return req;
  }
}

const asIdb = (f: FakeFactory): IDBFactory => f as unknown as IDBFactory;

const INFO: SampleInfo = { sampleRate: 48000, channels: 2, frames: 48000, seconds: 1, attackEnd: 0.01 };

function file(name: string, fill: number, size = 100): { name: string; mime: string; bytes: ArrayBuffer } {
  return { name, mime: 'audio/wav', bytes: new Uint8Array(size).fill(fill).buffer };
}

async function problem(p: Promise<unknown>): Promise<SampleStoreProblem> {
  try {
    await p;
  } catch (err) {
    assert.ok(err instanceof SampleStoreError, `a SampleStoreError, not ${String(err)}`);
    return err.problem;
  }
  assert.fail('expected a rejection');
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------------------------

test('opening creates the database with the two stores of the schema', async () => {
  const f = new FakeFactory();
  await openSampleStore(asIdb(f));
  const db = f.dbs.get(SAMPLE_DB)!;
  assert.equal(db.version, SAMPLE_DB_VERSION);
  assert.deepEqual([...db.rows.keys()].sort(), [DATA_STORE, META_STORE].sort());
  db.onversionchange?.();
  assert.equal(db.closed, true, 'a newer tab may upgrade: this one closes its connection');
});

test('put keeps meta and file bytes under the content hash; a known file is not stored twice', async () => {
  const f = new FakeFactory();
  const store = await openSampleStore(asIdb(f));
  const a = file('pad.wav', 7);
  const meta = await store.put(a, INFO);
  assert.equal(meta.hash, await contentHash(a.bytes));
  assert.deepEqual({ ...meta, added: '' }, {
    hash: meta.hash, name: 'pad.wav', mime: 'audio/wav', bytes: 100, added: '', ...INFO,
  });
  assert.ok(!Number.isNaN(Date.parse(meta.added)), 'added is an ISO time');
  const got = await store.get(meta.hash);
  assert.deepEqual(new Uint8Array(got!.bytes), new Uint8Array(a.bytes));
  assert.deepEqual(got!.meta, meta);
  assert.equal(a.bytes.byteLength, 100, 'the caller keeps its bytes');

  const again = await store.put({ ...file('copy of pad.wav', 7), mime: 'audio/x-wav' }, INFO);
  assert.deepEqual(again, meta, 'the same content: the first import stays');
  assert.equal((await store.list()).length, 1);
  assert.equal(await store.get(`sha256-${'0'.repeat(64)}`), null, 'unknown hash');
});

test('list: newest first, from the meta store only', async () => {
  const f = new FakeFactory();
  const store = await openSampleStore(asIdb(f));
  await store.put(file('one.wav', 1), INFO);
  await pause(3);
  await store.put(file('two.wav', 2), INFO);
  await pause(3);
  await store.put(file('three.wav', 3), INFO);
  const db = f.dbs.get(SAMPLE_DB)!;
  db.reads.length = 0;
  assert.deepEqual((await store.list()).map((m) => m.name), ['three.wav', 'two.wav', 'one.wav']);
  assert.deepEqual(db.reads, [META_STORE], 'listing never loads audio');
});

test('delete removes meta and data; unknown hashes are no error', async () => {
  const f = new FakeFactory();
  const store = await openSampleStore(asIdb(f));
  const a = await store.put(file('a.wav', 1), INFO);
  const b = await store.put(file('b.wav', 2, 300), INFO);
  await store.delete(a.hash);
  const db = f.dbs.get(SAMPLE_DB)!;
  assert.deepEqual([...db.rows.get(META_STORE)!.keys()], [b.hash]);
  assert.deepEqual([...db.rows.get(DATA_STORE)!.keys()], [b.hash]);
  assert.equal(await store.get(a.hash), null);
  await store.delete(a.hash);
});

test('usage: count and bytes of the samples, plus the browser estimate where there is one', async () => {
  const f = new FakeFactory();
  const store = await openSampleStore(asIdb(f), { estimate: async () => ({ usage: 5000, quota: 1e9 }) });
  await store.put(file('a.wav', 1, 100), INFO);
  await store.put(file('b.wav', 2, 250), INFO);
  assert.deepEqual(await store.usage(), { count: 2, bytes: 350, originUsage: 5000, originQuota: 1e9 });

  const bare = await openSampleStore(asIdb(new FakeFactory()));
  assert.deepEqual(await bare.usage(), { count: 0, bytes: 0, originUsage: null, originQuota: null });
  const failing = await openSampleStore(asIdb(new FakeFactory()), { estimate: () => Promise.reject(new Error('no')) });
  assert.deepEqual(await failing.usage(), { count: 0, bytes: 0, originUsage: null, originQuota: null });
});

test('a full storage is the quota problem, and nothing half-written stays', async () => {
  const f = new FakeFactory();
  const store = await openSampleStore(asIdb(f));
  f.dbs.get(SAMPLE_DB)!.quota = 150;
  await store.put(file('fits.wav', 1, 100), INFO);
  assert.equal(await problem(store.put(file('big.wav', 2, 100), INFO)), 'quota');
  const db = f.dbs.get(SAMPLE_DB)!;
  assert.equal(db.rows.get(META_STORE)!.size, 1, 'the meta of the refused file was rolled back');
  assert.equal(db.rows.get(DATA_STORE)!.size, 1);
});

test('limits are checked before anything is written', async () => {
  const f = new FakeFactory();
  const store = await openSampleStore(asIdb(f));
  const huge = { name: 'huge.wav', mime: '', bytes: new ArrayBuffer(MAX_SAMPLE_BYTES + 1) };
  assert.equal(await problem(store.put(huge, INFO)), 'too-large');
  assert.equal(await problem(store.put(file('long.wav', 1), { ...INFO, seconds: 61 })), 'too-long');
  assert.equal((await store.list()).length, 0);
});

test('opening: blocked by another tab, refused storage, failed open', async () => {
  const blocked = new FakeFactory();
  blocked.blocked = true;
  assert.equal(await problem(openSampleStore(asIdb(blocked))), 'blocked');
  const refusing = new FakeFactory();
  refusing.throws = 'SecurityError';
  assert.equal(await problem(openSampleStore(asIdb(refusing))), 'unavailable');
  const failing = new FakeFactory();
  failing.fails = 'UnknownError';
  const err = await openSampleStore(asIdb(failing)).catch((e: unknown) => e);
  assert.ok(err instanceof SampleStoreError && err.problem === 'unavailable' && /UnknownError/.test(err.message));
});

test('a damaged entry reads as corrupt', async () => {
  const f = new FakeFactory();
  const store = await openSampleStore(asIdb(f));
  const a = await store.put(file('a.wav', 1), INFO);
  const db = f.dbs.get(SAMPLE_DB)!;
  db.rows.get(DATA_STORE)!.set(a.hash, { hash: a.hash, bytes: new ArrayBuffer(3) });
  assert.equal(await problem(store.get(a.hash)), 'corrupt', 'size differs from the meta');
  db.rows.get(DATA_STORE)!.delete(a.hash);
  assert.equal(await problem(store.get(a.hash)), 'corrupt', 'meta without data');
  db.rows.get(META_STORE)!.set('junk', { hash: 'junk' });
  assert.deepEqual((await store.list()).map((m) => m.name), ['a.wav'], 'a malformed meta record is skipped in lists');
});

test('the synchronous hash equals SubtleCrypto SHA-256 at every padding boundary', async () => {
  let seed = 12345;
  const rand = () => (seed = (seed * 1103515245 + 12345) >>> 0) & 255;
  for (const n of [0, 1, 3, 55, 56, 57, 63, 64, 65, 119, 120, 128, 1000, 4099]) {
    const bytes = Uint8Array.from({ length: n }, rand);
    assert.equal(contentHashSync(bytes), await contentHash(bytes), `${n} bytes`);
  }
  assert.equal(contentHashSync(new TextEncoder().encode('abc').buffer as ArrayBuffer),
    'sha256-ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('without SubtleCrypto (not a secure context) contentHash falls back to the synchronous hash', async () => {
  const bytes = new TextEncoder().encode('abc');
  assert.equal(await contentHash(bytes, null), 'sha256-ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});
