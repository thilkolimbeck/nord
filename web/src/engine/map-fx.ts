/**
 * Mapping rules for one Stage 3 panel's effects section (port of nordconv/map_fx.py).
 *
 * Effect 1, Effect 2, Delay, Amp/EQ and the rotary each act on one source engine; compressor
 * and reverb act on the whole panel. The Stage 4 has an effects block per layer plus a single
 * block for the organ section, so each source-bound effect goes to the block of its source's
 * layer, and compressor and reverb go to every block of the panel. "1" type variants become the
 * Stage 4 base type and "2" variants its variation. Three Nord Sound Manager conversions (kept
 * private) confirm the delay tempo copy and the reverb amount scale.
 */
import type { Mapper } from './mapper.ts';

export const SRC_ORGAN = 0;
export const SRC_PIANO = 1;
export const SRC_SYNTH = 2;
type Table = ReadonlyMap<number, number>;
// Panning, Tremolo, Ring Mod, Wah-Wah, Auto-Wah 1, Auto-Wah 2 -> A-PAN, TREM, RM, WAH, A-WAH, A-WAH variation
const FX1_TYPE: Table = new Map([[0, 0], [1, 2], [2, 4], [3, 8], [4, 6], [5, 7]]);
// Phaser 1, Phaser 2, Flanger, Vibe, Chorus 1, Chorus 2 -> PHAS, PHAS var., FLANG, VIBE, CHOR, CHOR var.
const FX2_TYPE: Table = new Map([[0, 0], [1, 1], [2, 2], [3, 6], [4, 4], [5, 5]]);
// Clean, Twin, JC, Small, LP24, HP24 -> off (EQ only), TWIN, JC, SMALL, LP FILTER, HP FILTER
const AMP_TYPE: Table = new Map([[0, 0], [1, 1], [2, 3], [3, 5], [4, 8], [5, 9]]);
const AMP_CLEAN = 0;
const AMP_FILTERS: ReadonlySet<number> = new Set([4, 5]);
// Room 1, Room 2, Stage 1, Stage 2, Hall 1, Hall 2 -> ROOM, ROOM var., STAGE, STAGE var., HALL, HALL var.
const REVERB_TYPE: Table = new Map([[0, 4], [1, 5], [2, 6], [3, 7], [4, 8], [5, 9]]);
const REVERB_BRIGHT = 2;
// Nord Sound Manager writes floor(amount * 7 / 8) for the reverb amount (22 -> 19, 27 -> 23, 46 -> 40, 64 -> 56).
const REVERB_SCALE: readonly [number, number] = [7, 8];
// common.leslieSpeed packs the speed (bit 1: fast) and the inverted stop mode (bit 0: 1 = stop mode off).
const ROTARY_FAST_BIT = 2;
const ROTARY_STOP_OFF_BIT = 1;

const FX1_KEYS = ['fx1Enable', 'fx1Type', 'fx1ClkEnable', 'fx1RateClkDiv', 'fx1Amt'];
const FX2_KEYS = ['fx2Enable', 'fx2Type', 'fx2Rate', 'fx2Amt'];
const DELAY_KEYS = ['dlyEnable', 'dlyClkEnable', 'dlyRateClkDiv', 'dlyMix', 'dlyPingPong', 'dlyFltType',
  'dlyFeedback', 'dlyMode'];
const AMP_KEYS = ['ampEnable', 'ampType', 'ampTreble', 'ampMid', 'ampBass', 'ampMidFreq', 'ampDrive'];

export type Panel = 'A' | 'B';

/** The panel whose effects feed the Stage 4 organ block: Panel A, unless only Panel B's organ plays. */
export function organFxOwner(organPlays: Readonly<Record<Panel, boolean>>): Panel {
  return organPlays.B && !organPlays.A ? 'B' : 'A';
}

/** Program-wide rotary speed and drive -> the Stage 4 organ section's rotary. */
export function mapRotary(m: Mapper): void {
  const w = 'Common';
  const speed = m.v('common.leslieSpeed');
  m.set('organ.effectsLeslieStopMode', Number(!(speed & ROTARY_STOP_OFF_BIT)));
  m.set('organ.effectsLeslieSpeed', Number(Boolean(speed & ROTARY_FAST_BIT)));
  m.copy('common.leslieDrv', 'organ.effectsLeslieDrv', w);
}

/**
 * One panel's effects -> the Stage 4 blocks of that panel's layers. `plays` says, per source
 * (SRC_ORGAN, SRC_PIANO, SRC_SYNTH), whether that engine of this panel plays.
 */
export function mapEffects(m: Mapper, p: Panel, owner: Panel, bothOrgansPlay: boolean,
  plays: ReadonlyMap<number, boolean>): void {
  const e = `effects${p}`;
  const w = `Panel ${p} effects`;

  /** Whether a unit is heard: switched on, and its source engine (or any engine) plays. */
  const on = (enableKey: string, srcKey: string | null = null): boolean => {
    const sourcePlays = srcKey !== null ? (plays.get(m.v(`${e}.${srcKey}`)) ?? false)
      : Array.from(plays.values()).some(Boolean);
    return Boolean(m.v(`${e}.${enableKey}`)) && sourcePlays;
  };

  const blocks = new Map<number, string | null>([
    [SRC_ORGAN, owner === p ? 'organFx' : null], [SRC_PIANO, `piano${p}Fx`], [SRC_SYNTH, `synth${p}Fx`]]);
  const lost = `the Stage 4 organ has one effects block, which Panel ${owner} uses`;

  const route = (srcKey: string, keys: readonly string[]): string | null => {
    const src = m.v(`${e}.${srcKey}`);
    const block = blocks.get(src) ?? null;
    if (block === null) {
      m.drop(w, keys.map((k) => `${e}.${k}`), src === SRC_ORGAN ? lost : `${srcKey} ${src} is unknown`);
    }
    return block;
  };

  m.section(on('leslieEnable', 'leslieSrc'), () => rotary(m, e, w, owner === p, lost));
  m.section(on('fx1Enable', 'fx1Src'), () => {
    const block = route('fx1Src', FX1_KEYS);
    if (block) typed(m, e, block, w, FX1_KEYS, FX1_TYPE);
  });
  m.section(on('fx2Enable', 'fx2Src'), () => {
    const block = route('fx2Src', FX2_KEYS);
    if (block) typed(m, e, block, w, FX2_KEYS, FX2_TYPE);
  });
  m.section(on('dlyEnable', 'dlySrc'), () => {
    const block = route('dlySrc', DELAY_KEYS);
    if (block) delay(m, e, block, w);
  });
  m.section(on('ampEnable', 'ampSrc'), () => {
    const block = route('ampSrc', AMP_KEYS);
    if (block) amp(m, e, block, w);
  });
  const reverbType = m.section(on('rvbEnable'), () => lookup(m, `${e}.rvbType`, REVERB_TYPE, w));
  const reverbColor = m.v(`${e}.rvbBright`) ? REVERB_BRIGHT : 0;
  const panelBlocks = Array.from(blocks.values()).filter((b): b is string => Boolean(b));
  for (const block of panelBlocks) {
    m.section(on('cmpEnable'), () => {
      for (const key of ['cmpEnable', 'cmpAmt', 'cmpResponse']) m.copy(`${e}.${key}`, `${block}.${key}`, w);
    });
    m.section(on('rvbEnable'), () => {
      m.copy(`${e}.rvbEnable`, `${block}.rvbEnable`, w);
      m.set(`${block}.rvbAmt`, Math.floor((m.v(`${e}.rvbAmt`) * REVERB_SCALE[0]) / REVERB_SCALE[1]));
    });
    m.set(`${block}.rvbType`, reverbType);
    m.set(`${block}.rvbColor`, reverbColor);
  }
  if (owner !== p && bothOrgansPlay) {
    m.drop(w, [`${e}.cmpEnable`, `${e}.rvbEnable`], `not applied to the organ: ${lost}`);
  }
}

function lookup(m: Mapper, key: string, table: Table, w: string): number {
  const value = m.v(key);
  const mapped = table.get(value);
  if (mapped === undefined) {
    m.warn(w, `${key.slice(key.indexOf('.') + 1)} ${value} is unknown, set to the first Stage 4 type`);
    return 0;
  }
  return mapped;
}

/** Effect 1 or 2: on/off, rate and amount copy; the type goes through its label table. */
function typed(m: Mapper, e: string, block: string, w: string, keys: readonly string[], types: Table): void {
  const typeKey = keys[1]!;
  m.set(`${block}.${typeKey}`, lookup(m, `${e}.${typeKey}`, types, w));
  for (const key of keys) if (key !== typeKey) m.copy(`${e}.${key}`, `${block}.${key}`, w);
}

function delay(m: Mapper, e: string, block: string, w: string): void {
  for (const [ns3, ns4] of [['dlyEnable', 'dlyEnable'], ['dlyClkEnable', 'dlyClkEnable'], ['dlyMix', 'dlyMix'],
    ['dlyPingPong', 'dlyFbkPingPong'], ['dlyFltType', 'dlyFbkFilt'], ['dlyFeedback', 'dlyFbkAmt'],
    ['dlyMode', 'dlyMode']] as const) {
    m.copy(`${e}.${ns3}`, `${block}.${ns4}`, w);
  }
  // One tempo scale on both models, despite different defaults (8192 vs 11008): Nord Sound Manager
  // copies the raw value (12971 stays 12971).
  m.copy(`${e}.dlyRateClkDiv`, `${block}.dlyRateClkDiv`, w);
}

function amp(m: Mapper, e: string, block: string, w: string): void {
  const ampType = m.v(`${e}.ampType`);
  m.set(`${block}.ampTypeNew`, lookup(m, `${e}.ampType`, AMP_TYPE, w));
  if (ampType === AMP_CLEAN && m.v(`${e}.ampEnable`)) {
    m.warn(w, 'amp type Clean has no Stage 4 model; the EQ is kept with the amp model off');
  }
  for (const key of ['ampEnable', 'ampTreble', 'ampMid', 'ampMidFreq', 'ampDrive']) {
    m.copy(`${e}.${key}`, `${block}.${key}`, w);
  }
  if (AMP_FILTERS.has(ampType)) {
    m.drop(w, [`${e}.ampBass`], 'in filter mode it is the dry/wet mix, which has no confirmed Stage 4 field');
  } else {
    m.copy(`${e}.ampBass`, `${block}.ampBass`, w);
  }
}

/** The Stage 4 rotary belongs to the organ section, so only an organ-sourced rotary converts. */
function rotary(m: Mapper, e: string, w: string, ownsOrgan: boolean, lost: string): void {
  const keys = [`${e}.leslieEnable`];
  if (m.v(`${e}.leslieSrc`) !== SRC_ORGAN) {
    m.drop(w, keys, 'a rotary on piano or synth has no Stage 4 counterpart (only the organ has one)');
    if (ownsOrgan) m.set('organ.effectsLeslieEnable', 0);
  } else if (ownsOrgan) {
    m.copy(keys[0]!, 'organ.effectsLeslieEnable', w);
  } else {
    m.drop(w, keys, lost);
  }
}
