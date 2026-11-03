/** The central store: clamping, per-key and batch notifications, snapshots; the init program; multi-field edits. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadTemplate } from '../../src/engine/template.ts';
import { setLayerEnabled, setOscBank } from '../../src/editor/model/actions.ts';
import { initProgram } from '../../src/editor/model/init.ts';
import { NS4_KEYS } from '../../src/editor/model/keys.ts';
import { type Change, ParamStore, type ProgramSnapshot } from '../../src/editor/model/store.ts';

const SOURCE = { kind: 'ns4p', fileName: 'Pad.ns4p', formatVersion: 313, bytes: Uint8Array.from([1, 2, 3]) } as const;

test('the init program is the neutral template with synth layer A on', () => {
  const init = initProgram();
  const neutral = loadTemplate();
  for (const key of NS4_KEYS) {
    const want = key === 'common.sectionEnableSyn_I' || key === 'synth.layerEnableSyn_I' ? 1 : neutral.value(key);
    assert.equal(init.values[key], want, key);
  }
  assert.deepEqual([init.category, init.source, Object.keys(init.values).length], [17, null, 955]);
});

test('set clamps, returns the stored value and notifies once', () => {
  const store = new ParamStore(initProgram());
  const seen: Change[] = [];
  const batches: (readonly Change[])[] = [];
  store.subscribe('synthASound.fltFreq', (_v, c) => seen.push(c));
  store.onChange((b) => batches.push(b));
  assert.equal(store.set('synthASound.fltFreq', 300), 127);
  assert.equal(seen.length, 0, 'already 127: no change, no notification');
  assert.equal(store.set('synthASound.fltFreq', 12.4), 12);
  assert.deepEqual(seen, [{ key: 'synthASound.fltFreq', value: 12, previous: 127, origin: 'ui' }]);
  assert.equal(store.set('synthASound.fltFreq', -5, 'midi'), 0);
  assert.equal(seen[1]!.origin, 'midi');
  assert.equal(batches.length, 2);
  assert.equal(store.get('synthASound.fltFreq'), 0);
  assert.ok(store.dirty);
  assert.throws(() => store.set('synthASound.fltFreq', Number.NaN), TypeError);
  assert.throws(() => store.get('nope' as never), /no Stage 4 field/);
});

test('subscriptions are per key and can be removed', () => {
  const store = new ParamStore(initProgram());
  let a = 0;
  let b = 0;
  const offA = store.subscribe('synthASound.fltRes', () => { a += 1; });
  store.subscribe('synthBSound.fltRes', () => { b += 1; });
  store.set('synthASound.fltRes', 10);
  offA();
  store.set('synthASound.fltRes', 11);
  store.set('synthBSound.fltRes', 11);
  assert.deepEqual([a, b], [1, 1]);
});

test('setMany is one batch, with per-entry origins', () => {
  const store = new ParamStore(initProgram());
  const batches: (readonly Change[])[] = [];
  store.onChange((b) => batches.push(b));
  store.setMany([['synthASound.fltRes', 5], ['synthASound.fltFreq', 10, 'derived'], ['synthASound.fltType', 99]], 'ui');
  assert.equal(batches.length, 1);
  assert.deepEqual(batches[0]!.map((c) => [c.key, c.value, c.origin]),
    [['synthASound.fltRes', 5, 'ui'], ['synthASound.fltFreq', 10, 'derived'], ['synthASound.fltType', 5, 'ui']]);
});

test('a failing listener does not stop the others, and its error surfaces', () => {
  const store = new ParamStore(initProgram());
  let reached = 0;
  store.subscribe('synthASound.fltRes', () => { throw new Error('boom'); });
  store.subscribe('synthASound.fltRes', () => { reached += 1; });
  store.onChange(() => { reached += 1; });
  assert.throws(() => store.set('synthASound.fltRes', 3), /boom/);
  assert.equal(reached, 2);
  assert.equal(store.get('synthASound.fltRes'), 3);
});

test('snapshot is a deep copy and load restores it in one batch', () => {
  const store = new ParamStore({ ...initProgram(), name: 'Pad', source: SOURCE });
  store.set('synthBSound.fltFreq', 40);
  const snap = store.snapshot();
  (snap.source!.bytes as Uint8Array)[0] = 9;
  assert.equal(store.meta.source!.bytes[0], 1, 'source bytes copied');
  store.set('synthBSound.fltFreq', 41);
  store.setName('Other');
  const batches: (readonly Change[])[] = [];
  store.onChange((b) => batches.push(b));
  store.load(store.snapshot(), 'load');
  store.load({ ...snap, source: SOURCE }, 'load');
  assert.equal(batches.length, 2);
  assert.equal(batches[1]!.length, 955);
  assert.ok(batches[1]!.every((c) => c.origin === 'load'));
  assert.equal(store.get('synthBSound.fltFreq'), 40);
  assert.deepEqual(store.snapshot(), { ...snap, source: SOURCE });
  assert.equal(store.meta.name, 'Pad');
  assert.equal(store.dirty, false);
  store.setName('Renamed');
  assert.ok(store.dirty);
});

test('load clamps out-of-range values and refuses missing or unknown fields', () => {
  const store = new ParamStore(initProgram());
  const base = initProgram();
  store.load({ ...base, values: { ...base.values, 'synthASound.fltFreq': 500 } }, 'load');
  assert.equal(store.get('synthASound.fltFreq'), 127);
  const missing = { ...base.values } as Record<string, number>;
  delete missing['synthASound.fltFreq'];
  assert.throws(() => store.load({ ...base, values: missing } as ProgramSnapshot, 'load'), /no value for 'synthASound.fltFreq'/);
  assert.throws(() => store.load({ ...base, values: { ...base.values, 'x.y': 1 } } as ProgramSnapshot, 'load'),
    /unknown field 'x.y'/);
  assert.equal(store.get('synthASound.fltFreq'), 127, 'a refused load changes nothing');
});

test('setOscBank resets category and wave only when the new bank has no label for them', () => {
  const store = new ParamStore(initProgram());
  store.setMany([['synthASound.oscBank', 0], ['synthASound.oscCat', 6], ['synthASound.oscWave', 0]], 'ui');
  const batches: (readonly Change[])[] = [];
  store.onChange((b) => batches.push(b));
  setOscBank(store, 'A', 1); // FM-H: categories A–H, so category 6 stays
  assert.equal(store.get('synthASound.oscCat'), 6);
  assert.equal(batches.length, 1);
  store.set('synthASound.oscWave', 127);
  setOscBank(store, 'A', 0);
  assert.equal(store.get('synthASound.oscBank'), 0);
  assert.equal(store.get('synthASound.oscCat'), 6, 'analog has a seventh category');
  assert.equal(store.get('synthASound.oscWave'), 0, 'wave 127 has no label there: first row');
  assert.deepEqual(batches.at(-1)!.map((c) => [c.key, c.value, c.origin]),
    [['synthASound.oscBank', 0, 'ui'], ['synthASound.oscWave', 0, 'derived']]);
  setOscBank(store, 'A', 99);
  assert.equal(store.get('synthASound.oscBank'), 3, 'clamped');
});

test('setLayerEnabled sets one bit of the scene I mask', () => {
  const store = new ParamStore(initProgram());
  assert.equal(store.get('synth.layerEnableSyn_I'), 1);
  setLayerEnabled(store, 'C', true);
  assert.equal(store.get('synth.layerEnableSyn_I'), 5);
  setLayerEnabled(store, 'A', false);
  assert.equal(store.get('synth.layerEnableSyn_I'), 4);
  setLayerEnabled(store, 'A', false);
  assert.equal(store.get('synth.layerEnableSyn_I'), 4);
});

test('setName notifies name listeners only on a change, without a value batch', () => {
  const store = new ParamStore({ ...initProgram(), name: 'Pad' });
  const names: string[] = [];
  const batches: (readonly Change[])[] = [];
  const off = store.onNameChange((n) => names.push(n));
  store.onChange((b) => batches.push(b));
  store.setName('Pad');
  store.setName('Lead');
  assert.deepEqual(names, ['Lead']);
  assert.equal(batches.length, 0);
  assert.ok(store.dirty);
  off();
  store.setName('Bass');
  assert.deepEqual(names, ['Lead']);
});
