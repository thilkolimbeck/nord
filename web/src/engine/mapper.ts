/**
 * The bookkeeping every mapping rule goes through (port of nordconv/mapper.py).
 *
 * Every lossy or unmappable Stage 3 parameter that is not at its default must be reported.
 * Routing every read through `v` records which Stage 3 fields a rule looked at, so the
 * converter can sweep up any field no rule handled. Routing every write through `set`
 * validates the value against the Stage 4 layout at once.
 */
import { fieldOf, NS3_LAYOUT, NS4_LAYOUT } from './layout.ts';
import { hexUpper } from './pyfmt.ts';

/** Appended to a note, so a line about a switched-off section stays traceable. */
export const OFF_SUFFIX = ' (switched off in the Stage 3 program)';

/** Name-hash values that mean "no sound/preset selected" (the Stage 3 writes 0x7FFFFFFF for an empty slot). */
export const NONE_HASHES: ReadonlySet<number> = new Set([0, 0x7fffffff]);

/** The parameter part of a field key ("synthA.fltFreq" -> "fltFreq"), for messages. */
export function short(key: string): string {
  const dot = key.indexOf('.');
  return dot >= 0 ? key.slice(dot + 1) : key;
}

/** Python min(max(value, lo), hi). */
export function clamp(value: number, lo: number, hi: number): number {
  return Math.min(Math.max(value, lo), hi);
}

/**
 * Collects Stage 4 edits and warnings for one Stage 3 program. While a rule runs inside
 * `section(false, ...)` its reports go to `notes`, not `warnings`.
 */
export class Mapper {
  readonly values: Map<string, number>;
  readonly edits = new Map<string, number>();
  readonly warnings: string[] = [];
  readonly notes: string[] = [];
  readonly read = new Set<string>();
  active = true;

  constructor(values: Map<string, number>) {
    this.values = values;
  }

  /** Run rules for a section that plays (reports are warnings) or not (reports are notes). */
  section<T>(active: boolean, body: () => T): T {
    const outer = this.active;
    this.active = outer && active;
    try {
      return body();
    } finally {
      this.active = outer;
    }
  }

  // ---- reading the source

  /** A Stage 3 value; marks the field as handled. */
  v(key: string): number {
    this.read.add(key);
    return this.raw(key);
  }

  /** A Stage 3 value without marking it (Python: self.values[key]). */
  raw(key: string): number {
    const value = this.values.get(key);
    if (value === undefined) throw new Error(`no Stage 3 value '${key}'`);
    return value;
  }

  /** A Stage 3 value clamped to its documented range, for rules that compute with it. */
  bounded(key: string, where: string): number {
    const f = fieldOf(NS3_LAYOUT, key);
    const value = this.v(key);
    if (f.min <= value && value <= f.max) return value;
    const clamped = clamp(value, f.min, f.max);
    this.warn(where, `${short(key)} ${value} is outside the Stage 3 range ${f.min}..${f.max}, read as ${clamped}`);
    return clamped;
  }

  /** Whether a Stage 3 field holds its default (an empty name hash counts as default). */
  isDefault(key: string): boolean {
    const f = fieldOf(NS3_LAYOUT, key);
    const value = this.v(key);
    if (f.enc === 'raw') return NONE_HASHES.has(value);
    return value === f.default;
  }

  /** Mark fields as deliberately not converted (state snapshots, not settings). */
  skip(keys: Iterable<string>): void {
    for (const key of keys) this.read.add(key);
  }

  // ---- writing the target

  /** Record a Stage 4 edit; RangeError for an out-of-range value, Error for a clash. */
  set(key: string, value: number): void {
    fieldOf(NS4_LAYOUT, key).encode(value);
    const previous = this.edits.get(key);
    if (previous !== undefined && previous !== value) {
      throw new Error(`mapping writes ${key} twice: ${previous} then ${value}`);
    }
    this.edits.set(key, value);
  }

  warn(where: string, text: string): void {
    if (this.active) this.warnings.push(`${where}: ${text}`);
    else this.notes.push(`${where}: ${text}${OFF_SUFFIX}`);
  }

  /** Value copy for parameters with the same meaning and scale; clamps and warns if out of range. */
  copy(src: string, dst: string, where: string): void {
    let value = this.v(src);
    const target = fieldOf(NS4_LAYOUT, dst);
    if (!target.inRange(value)) {
      const clamped = clamp(value, target.min, target.max);
      this.warn(where, `${short(src)} ${value} is outside the Stage 4 range `
        + `${target.min}..${target.max}, set to ${clamped}`);
      value = clamped;
    }
    this.set(dst, value);
  }

  /**
   * Copy a parameter whose Stage 4 scale is unverified. A source at its default maps to the
   * Stage 4 default; any other value is copied and reported.
   */
  guess(src: string, dst: string, where: string): void {
    if (this.isDefault(src)) {
      this.set(dst, fieldOf(NS4_LAYOUT, dst).default);
      return;
    }
    this.copy(src, dst, where);
    this.warn(where, `${short(src)} ${this.raw(src)} copied as is; `
      + 'the Stage 4 scale of this parameter is unverified');
  }

  /** Report fields with no Stage 4 counterpart: one warning naming every non-default one. */
  drop(where: string, keys: Iterable<string>, reason: string): void {
    const changed: string[] = [];
    for (const k of keys) if (!this.isDefault(k)) changed.push(`${short(k)}=${this.show(k)}`);
    if (changed.length) this.warn(where, `${changed.join(', ')} not converted: ${reason}`);
  }

  private show(key: string): string {
    const f = fieldOf(NS3_LAYOUT, key);
    const value = this.raw(key);
    return f.enc === 'raw' ? `0x${hexUpper(value, 8)}` : String(value);
  }
}
