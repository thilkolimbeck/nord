/**
 * Stage 3 values as the instrument loads them, after its format fix-ups (port of
 * nordconv/source.py; opennord src/lib/ns3/convert.ts).
 *
 * - below 3.02, Dual-KB style 0 becomes 1;
 * - below 3.03/3.04, fields the body does not store yet load as their defaults (Ns3Program.get);
 * - in 3.00, the delay rate was a 0-127 value. Synced to the master clock it becomes
 *   N(x) = 16383 for 127, else 128 x, and each morph delta becomes N(rate + delta) - N(rate).
 *   Free-running, the value stays on the 3.00 scale and is reported (its morph deltas are only
 *   re-zeroed). A rate above 127, or a morph target in 128-16383, makes the Stage 3 refuse the
 *   program, so the converter refuses it too.
 */
import { NordFormatError } from './errors.ts';
import type { Ns3Program } from './program.ts';

const DELAY_MAX = 16383;
const MORPHS = ['morphWheel', 'morphAfterTouch', 'morphCtrlPedal'];
/** What a 3.00 morph delta of 0 decodes to in the 15-bit delta field (raw 127 - 16383). */
const OS300_DELTA_ZERO = 127 - DELAY_MAX;

/** The 3.04 delay rate the firmware derives from a clock-synced 3.00 rate or morph target. */
function os300Rate(x: number): number {
  return x === 127 ? DELAY_MAX : 128 * x;
}

function get(values: Map<string, number>, key: string): number {
  const value = values.get(key);
  if (value === undefined) throw new Error(`no Stage 3 value '${key}'`);
  return value;
}

/** Every field's loaded value, plus notes about values that could not be brought up to date. */
export function effectiveValues(program: Ns3Program): [Map<string, number>, string[]] {
  const values = new Map<string, number>();
  for (const key of program.keys()) values.set(key, program.value(key));
  const notes: string[] = [];
  const version = program.formatVersion;
  if (version < 302 && get(values, 'common.dualKbdStyle') === 0) values.set('common.dualKbdStyle', 1);
  if (version === 300) {
    for (const panel of ['A', 'B']) fixOs300Delay(values, panel, notes);
  }
  return [values, notes];
}

function fixOs300Delay(values: Map<string, number>, panel: string, notes: string[]): void {
  const key = `effects${panel}.dlyRateClkDiv`;
  const rate = get(values, key);
  if (rate > 127) {
    throw new NordFormatError(`Panel ${panel} delay rate ${rate} is invalid for format 3.00; `
      + 'the Stage 3 itself refuses this program');
  }
  const deltas = MORPHS.map((m) => [m, get(values, `${key}.${m}`) - OS300_DELTA_ZERO] as const);
  if (deltas.some(([, delta]) => rate + delta >= 128 && rate + delta <= DELAY_MAX)) {
    throw new NordFormatError(`Panel ${panel} delay rate morph is invalid for format 3.00; `
      + 'the Stage 3 itself refuses this program');
  }
  if (get(values, `effects${panel}.dlyClkEnable`) !== 1) {
    for (const [morph, delta] of deltas) values.set(`${key}.${morph}`, delta); // re-zeroed as convert.ts does
    notes.push(`Panel ${panel} effects: delay rate ${rate} is on the format 3.00 scale (0-127), `
      + 'which has no known conversion; it is passed on unconverted');
    return;
  }
  values.set(key, os300Rate(rate));
  for (const [morph, delta] of deltas) {
    const moved = delta ? os300Rate(rate + delta) - get(values, key) : 0;
    values.set(`${key}.${morph}`, Math.max(-DELAY_MAX, Math.min(DELAY_MAX, moved)));
  }
}
