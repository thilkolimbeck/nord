/**
 * Units of Stage 4 display labels: parse a label into a number and a unit, and format a value
 * in a unit. The labels come from the Stage 4's own tables ('0.5 ms', '1.2 kHz', '-0.3 dB',
 * '+ 0 semi', 'inf', 'volume off'); names such as 'LP24' or '2/3' are not numbers.
 */

export type Unit = 's' | 'Hz' | 'dB' | 'semi' | 'cent' | '';

export interface Parsed {
  readonly value: number;
  readonly unit: Unit;
}

// [suffix, unit, factor to the unit]
const SUFFIXES: ReadonlyArray<readonly [string, Unit, number]> = [
  ['ms', 's', 1e-3], ['s', 's', 1], ['sec', 's', 1], ['Hz', 'Hz', 1], ['kHz', 'Hz', 1e3], ['dB', 'dB', 1],
  ['semi', 'semi', 1], ['semitones', 'semi', 1], ['cent', 'cent', 1], ['', '', 1]];
const NUMBER_RE = /^([+-])?\s*(\d+(?:\.\d+)?)\s*([A-Za-z]*)$/;

/**
 * The number and unit a display label stands for, in base units (seconds, hertz); null for names.
 * 'inf' (a decay that holds) is Infinity seconds; 'volume off' is -Infinity dB.
 */
export function parseDisplay(label: string): Parsed | null {
  const text = label.trim();
  if (text === 'inf') return { value: Infinity, unit: 's' };
  if (text === 'volume off') return { value: -Infinity, unit: 'dB' };
  const m = NUMBER_RE.exec(text);
  if (m === null) return null;
  const suffix = SUFFIXES.find(([s]) => s === m[3]);
  if (suffix === undefined) return null;
  const magnitude = Number(m[2]) * suffix[2];
  return { value: m[1] === '-' && magnitude !== 0 ? -magnitude : magnitude, unit: suffix[1] };
}

function trim(n: number, digits: number): string {
  return String(Number(n.toFixed(digits)));
}

/** A value in base units as short text: 0.0005 s -> '0.5 ms', 1200 Hz -> '1.2 kHz', 3 semi -> '+3 semi'. */
export function formatSi(value: number, unit: Unit): string {
  if (Number.isNaN(value)) return '–';
  if (unit === 's') {
    if (value === Infinity) return 'inf';
    return Math.abs(value) < 1 ? `${trim(value * 1e3, 1)} ms` : `${trim(value, 2)} s`;
  }
  if (unit === 'Hz') return Math.abs(value) < 1e3 ? `${trim(value, 1)} Hz` : `${trim(value / 1e3, 2)} kHz`;
  if (unit === 'dB') return value === -Infinity ? 'volume off' : `${value > 0 ? '+' : ''}${trim(value, 1)} dB`;
  if (unit === 'semi' || unit === 'cent') return `${value > 0 ? '+' : ''}${trim(value, 2)} ${unit}`;
  return trim(value, 2);
}
