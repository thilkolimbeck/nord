/**
 * Stage 4 display labels of field values: a port of tools/ns4data/labels.py ns4_label.
 *
 * The tables are keyed by the field's raw bits as ns4decode reads them, which for the synth osc
 * knobs is only the field's low bits; a raw beyond the port width has no label. Lookup order
 * follows opennord ns4/coverage.ts: exact value table, enum table, then the dependency tables,
 * whose label depends on other fields (keyboard zones on the split points, osc category and
 * wave on the osc bank). The editor stores decoded values, so each lookup encodes the value
 * first, as the layout does when a program is written.
 */
import { NS4_LAYOUT } from '../../ns4/layout.ts';
import { DEP_TABLES, ENUM_TABLES, FIELD_DEP, FIELD_ENUM, FIELD_VALUE_TABLE, VALUE_TABLES } from '../generated/display-ns4.ts';
import type { Ns4Key } from './keys.ts';

/** Read access to current values, by key: the store, a snapshot or a test double. */
export interface ValueReader {
  get(key: Ns4Key): number;
}

/** The raw bits the layout writes for `value`, or null when the field cannot hold it. */
export function rawOf(key: Ns4Key, value: number): number | null {
  const f = NS4_LAYOUT.fields.get(key);
  if (f === undefined || !Number.isInteger(value) || !f.inRange(value)) return null;
  return f.encode(value);
}

const maps = new Map<string, ReadonlyMap<number, string>>();

function lookup(tables: Readonly<Record<string, ReadonlyArray<readonly [number, string]>>>, prefix: string,
  id: string): ReadonlyMap<number, string> {
  let map = maps.get(prefix + id);
  if (map === undefined) {
    map = new Map(Object.hasOwn(tables, id) ? tables[id] : []);
    maps.set(prefix + id, map);
  }
  return map;
}

function own<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

/** The label from the value or enum table alone (no dependency tables), and which table gave it. */
export function staticLabel(key: Ns4Key, value: number): { label: string; source: 'table' | 'enum' } | null {
  const raw = rawOf(key, value);
  if (raw === null) return null;
  const vt = own(FIELD_VALUE_TABLE, key);
  if (vt !== undefined && raw < 2 ** vt[1]) {
    const label = lookup(VALUE_TABLES, 'v:', vt[0]).get(raw);
    if (label !== undefined) return { label, source: 'table' };
  }
  const en = own(FIELD_ENUM, key);
  if (en !== undefined && raw < 2 ** en[1]) {
    const label = lookup(ENUM_TABLES, 'e:', en[0]).get(raw);
    if (label !== undefined) return { label, source: 'enum' };
  }
  return null;
}

/** The label from the value or enum table alone (no dependency tables), or null. */
export function tableLabel(key: Ns4Key, value: number): string | null {
  return staticLabel(key, value)?.label ?? null;
}

/** The fields whose dependency-table label depends on, in row order; empty without a dependency table. */
export function labelDeps(key: Ns4Key): readonly Ns4Key[] {
  const dep = own(FIELD_DEP, key);
  return dep === undefined ? [] : dep[2] as readonly Ns4Key[];
}

/** The Stage 4 display string of `value` for field `key`, or null when no table covers it. */
export function ns4Label(key: Ns4Key, value: number, values: ValueReader): string | null {
  const label = tableLabel(key, value);
  if (label !== null) return label;
  const dep = own(FIELD_DEP, key);
  if (dep === undefined) return null;
  const [id, width, deps] = dep;
  const raw = rawOf(key, value);
  if (raw === null || raw >= 2 ** width) return null;
  const parts: number[] = [];
  for (const d of deps as readonly Ns4Key[]) {
    const r = rawOf(d, values.get(d));
    if (r === null) return null;
    parts.push(r);
  }
  const table = own(DEP_TABLES, id);
  return table === undefined ? null : own(table, `${parts.join(':')}:${raw}`) ?? null;
}
