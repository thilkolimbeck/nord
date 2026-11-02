/**
 * Keyboard zones and octave shifts, which both models encode differently (port of
 * nordconv/keyboard.py).
 *
 * A Stage 3 zone value names the zones it plays ("11oo") whatever split points are on. A
 * Stage 4 zone value means different zones depending on which split points are on, so the
 * converter looks for the Stage 4 value that plays the same zones under the split points it
 * writes. Like Nord Sound Manager, it prefers the value that also shows those zones with all
 * three split points on. The Stage 4 octave shift only goes to +/-2.
 */
import { KB_ZONES } from './generated/tables-ns3.ts';
import { DEP_TABLES, FIELD_DEP } from './generated/tables-ns4.ts';
import { fieldOf, NS4_LAYOUT } from './layout.ts';
import { short, type Mapper } from './mapper.ts';
import { signed } from './pyfmt.ts';

export const WHOLE_KEYBOARD = '1111';
/** The Stage 4 zone value that plays the whole keyboard under any split points (and its default). */
export const WHOLE_KEYBOARD_VALUE = 5;
export const OCTAVE_LIMIT = 2;

/**
 * The Stage 4 value that shows `label` under `enables`, or undefined. Among several, the one that
 * shows it with all split points on too (as Nord Sound Manager picks, so the zones survive
 * switching split points on), else the lowest.
 */
function zoneValue(tableId: string, enables: string, maxValue: number, label: string): number | undefined {
  const table = DEP_TABLES[tableId];
  if (table === undefined) throw new Error(`no dependency table '${tableId}'`);
  const every = enables.split(':').map(() => '1').join(':');
  const matches: number[] = [];
  for (let value = 0; value <= maxValue; value++) if (table[`${enables}:${value}`] === label) matches.push(value);
  return matches.find((v) => table[`${every}:${v}`] === label) ?? matches[0];
}

/**
 * Write the Stage 4 zone value that plays the zones the Stage 3 value plays. The split point
 * enables must already be among the edits: the answer depends on them.
 */
export function mapZone(m: Mapper, src: string, dst: string, where: string): void {
  const value = m.v(src);
  const dep = FIELD_DEP[dst];
  if (dep === undefined) throw new Error(`no dependency entry for '${dst}'`);
  const [tableId, , deps] = dep;
  const label = value >= 0 && value < KB_ZONES.length ? KB_ZONES[value]! : null;
  if (label === null || label === WHOLE_KEYBOARD) {
    if (label === null) m.warn(where, `${short(src)} ${value} is not a known zone, set to the whole keyboard`);
    m.set(dst, WHOLE_KEYBOARD_VALUE);
    return;
  }
  const enables = deps.map((d) => {
    const edit = m.edits.get(d);
    if (edit === undefined) throw new Error(`split point '${d}' is not among the edits yet`);
    return String(edit);
  }).join(':');
  let target = zoneValue(tableId, enables, fieldOf(NS4_LAYOUT, dst).max, label);
  if (target === undefined) {
    if (m.v('common.splitEnable')) {
      m.warn(where, `zones ${label} cannot be played with the active split points, `
        + 'set to the whole keyboard');
    }
    target = WHOLE_KEYBOARD_VALUE;
  }
  m.set(dst, target);
}

/** Copy an octave shift, clamped to the Stage 4's +/-2. */
export function mapOctave(m: Mapper, src: string, dst: string, where: string): void {
  const value = m.v(src);
  const clamped = Math.max(-OCTAVE_LIMIT, Math.min(OCTAVE_LIMIT, value));
  if (clamped !== value) {
    m.warn(where, `octave shift ${signed(value)} is beyond the Stage 4 range of +/-2, set to ${signed(clamped)}`);
  }
  m.set(dst, clamped);
}
