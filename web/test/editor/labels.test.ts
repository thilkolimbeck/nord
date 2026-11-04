/**
 * The editor's port of tools/ns4data/labels.py ns4_label against Python's own output
 * (labels-golden.json, written by tools/gen_editor_tables.py).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { NS4_LAYOUT } from '../../src/ns4/layout.ts';
import { initProgram } from '../../src/editor/model/init.ts';
import { isNs4Key, NS4_KEYS, type Ns4Key } from '../../src/editor/model/keys.ts';
import { labelDeps, ns4Label, rawOf, type ValueReader } from '../../src/editor/model/labels.ts';

type Labels = ReadonlyArray<string | null>;
type Entry = { min: number; labels: Labels } | { deps: string[]; rows: Record<string, Labels> };
const GOLDEN = JSON.parse(readFileSync(new URL('./labels-golden.json', import.meta.url), 'utf8')) as
  { fields: Record<string, Entry> };
const INIT = initProgram().values;

function reader(overrides: ReadonlyMap<string, number>): ValueReader {
  return { get: (key) => overrides.get(key) ?? INIT[key] };
}

test('every label equals Python ns4_label, for every value of every tabled field', () => {
  let checked = 0;
  for (const [key, entry] of Object.entries(GOLDEN.fields)) {
    assert.ok(isNs4Key(key), key);
    const f = NS4_LAYOUT.fields.get(key)!;
    if ('rows' in entry) {
      assert.deepEqual([...labelDeps(key)], entry.deps, key);
      for (const [row, labels] of Object.entries(entry.rows)) {
        const deps = new Map(entry.deps.map((d, i) => [d, Number(row.split(':')[i])]));
        labels.forEach((want, i) => {
          assert.equal(ns4Label(key, f.min + i, reader(deps)), want, `${key} = ${f.min + i} at ${row}`);
          checked += 1;
        });
      }
    } else {
      assert.equal(entry.min, f.min, key);
      entry.labels.forEach((want, i) => {
        assert.equal(ns4Label(key, entry.min + i, reader(new Map())), want, `${key} = ${entry.min + i}`);
        checked += 1;
      });
    }
  }
  assert.ok(checked > 30000, `only ${checked} labels checked`);
});

test('fields without a table have no label', () => {
  const tabled = new Set(Object.keys(GOLDEN.fields));
  const rest = NS4_KEYS.filter((k) => !tabled.has(k));
  assert.equal(rest.length + tabled.size, 955);
  for (const key of rest) assert.equal(ns4Label(key, INIT[key], reader(new Map())), null, key);
});

test('values a field cannot hold have no label and no raw bits', () => {
  const key: Ns4Key = 'synthASound.fltFreq';
  assert.equal(rawOf(key, 128), null);
  assert.equal(rawOf(key, -1), null);
  assert.equal(rawOf(key, 1.5), null);
  assert.equal(ns4Label(key, 128, reader(new Map())), null);
  assert.equal(rawOf('synthA.octaveShift', -1), 15);
  // A dependency outside its range gives no row.
  assert.equal(ns4Label('synthASound.oscCat', 0, reader(new Map([['synthASound.oscBank', 9]]))), null);
  assert.equal(ns4Label('synthASound.oscCat', 0, reader(new Map([['synthASound.oscBank', 0]]))), '1 (PURE)');
});
