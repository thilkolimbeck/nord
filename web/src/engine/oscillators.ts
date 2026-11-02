/**
 * Stage 3 oscillator (bank, wave, configuration) -> Stage 4 analog oscillator (port of
 * nordconv/oscillators.py).
 *
 * The hand-made table covers the waves' names plus two configurations: Saw + "8 MixSqr" with
 * osc 2 one octave down -> Sub Square Saw (a sample program pair, kept private) and Saw +
 * "4 Detune" -> Pure Saw (as three Nord Sound Manager conversions, kept private, do it).
 * Anything else falls back to the PURE version of the base wave and is reported.
 */
import { OSC_CLASSIC_WAVE, OSC_CONFIG, OSC_SUPER_WAVE, SYNTH_OSC } from './generated/tables-ns3.ts';

// Stage 4 analog categories (oscCat under oscBank 0, ns4decode table 561-8).
export const PURE = 0;
export const SUB_OSC = 1;
export const SYNC = 2;
export const SHAPE = 3;
export const MULTI = 5;
export const SUPER = 6;
/** dualOscDetune value meaning "second oscillator one octave down" (Sub). */
export const DETUNE_SUB = 0;
export const DETUNE_UNISON = 12;

// Classic waves 0-5 (Sine .. Pulse 10) have PURE and SYNC waves of the same name and order.
const NAMED_WAVES = 6;
const SHAPE_WAVE: ReadonlyMap<string, number> = new Map([['Triangle', 0], ['Saw', 1], ['Square', 2]]);
const E_WAVE_BASE: ReadonlyMap<string, string> = new Map([['ESaw', 'Saw'], ['ESquare', 'Square']]);
const SUPER_EXACT: ReadonlyMap<string, number> = new Map([
  ['Super Wave Saw', 0], ['Super Wave Square', 1], ['Super Wave Organ', 2]]);
const SUPER_CLOSE: ReadonlyMap<string, number> = new Map([
  ['Super Wave Saw 2', 0], ['Super Wave Square 2', 1], ['Super Wave Bright', 3], ['Super Wave Bright 2', 3],
  ['Super Wave Strings', 0]]);

/** A Stage 4 analog oscillator, and why it is only an approximation (null when exact). */
export interface OscChoice {
  readonly category: number;
  readonly wave: number;
  readonly lossy: string | null;
  readonly usesDetune: boolean;
}

function choice(category: number, wave: number, lossy: string | null = null, usesDetune = false): OscChoice {
  return { category, wave, lossy, usesDetune };
}

function label(table: readonly string[], index: number): string {
  return index >= 0 && index < table.length ? table[index]! : `#${index}`;
}

/** The Stage 4 oscillator for a Stage 3 one, or null when no analog wave comes close. */
export function mapOscillator(bank: number, wave: number, conf: number, detune: number): OscChoice | null {
  const kind = label(SYNTH_OSC, bank);
  if (kind === 'Classic') {
    return classic(label(OSC_CLASSIC_WAVE, wave), wave, label(OSC_CONFIG, conf), detune);
  }
  if (kind === 'Super') {
    const name = label(OSC_SUPER_WAVE, wave);
    const exact = SUPER_EXACT.get(name);
    if (exact !== undefined) return choice(SUPER, exact);
    const close = SUPER_CLOSE.get(name);
    if (close !== undefined) {
      return choice(SUPER, close, `${name} approximated by the closest Stage 4 super wave`);
    }
  }
  return null;
}

function classic(name: string, index: number, conf: string, detune: number): OscChoice {
  const base = E_WAVE_BASE.get(name) ?? name;
  if (conf === '8 MixSqr' && name === 'Saw' && detune === DETUNE_SUB) return choice(SUB_OSC, 0, null, true);
  if (conf === '4 Detune' && name === 'Saw') {
    return choice(PURE, index, 'configuration 4 Detune became Pure Saw, as Nord Sound Manager converts it; '
      + 'the detuned second oscillator is lost');
  }
  if (conf === '3 Sync' && index < NAMED_WAVES) return choice(SYNC, index);
  const shape = SHAPE_WAVE.get(name);
  if (conf === '2 Shape' && shape !== undefined) return choice(SHAPE, shape);
  const named = OSC_CLASSIC_WAVE.slice(0, NAMED_WAVES);
  const known = named.includes(base);
  const pure = known ? OSC_CLASSIC_WAVE.indexOf(base) : 2;
  if (conf === 'None' && known && name === base) return choice(PURE, pure);
  const reasons: string[] = [];
  if (name !== base || !known) reasons.push(`wave ${name} has no Stage 4 counterpart`);
  if (conf !== 'None') reasons.push(`configuration ${conf} has no known Stage 4 counterpart`);
  return choice(PURE, pure, `${reasons.join('; ')}, so it became Pure ${OSC_CLASSIC_WAVE[pure]}`);
}
