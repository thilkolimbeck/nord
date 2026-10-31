/**
 * Mapping rules for one Stage 3 panel's organ, piano and synth (port of
 * nordconv/map_engines.py).
 *
 * Panel A becomes layer A and Panel B layer B of each Stage 4 section in scene I. Values copy
 * where both models share a table, enums are remapped by their labels, and every approximation
 * is reported.
 */
import { PIANO_TYPE, SYNTH_OSC } from './generated/tables-ns3.ts';
import { PIANO_NAME_HASHES } from './generated/tables-ns4.ts';
import { mapOctave, mapZone } from './keyboard.ts';
import { fieldOf, NS4_LAYOUT } from './layout.ts';
import type { Mapper } from './mapper.ts';
import { DETUNE_UNISON, mapOscillator } from './oscillators.ts';
import { fixed, pyRound, signed } from './pyfmt.ts';

const PIANO_NAMES: ReadonlySet<number> = new Set(PIANO_NAME_HASHES);
const DRAWBARS: readonly string[] = Array.from({ length: 9 }, (_, i) => `db${i + 1}`);
const VIB_PERC: ReadonlyArray<readonly [string, string]> = [
  ['vibratoEnable', 'org_Preset_kVibratoEnable'], ['b3PercEnable', 'org_Preset_kB3PercEnable'],
  ['b3PercHarmonic', 'org_Preset_kB3PercHarmonic'], ['b3PercSpeed', 'org_Preset_kB3PercSpeed'],
  ['b3PercLevel', 'org_Preset_kB3PercLevel']];

// Stage 3 Poly/Legato/Mono -> Stage 4 voiceMode, whose bit 0 is mono and bit 1 legato.
const VOICE_MODE: ReadonlyMap<number, number> = new Map([[0, 0], [1, 2], [2, 1]]);
// Stage 3 vibrato Off/Delay 1-3/Wheel/After Touch -> Stage 4 none/DLY/WHL/A.T.
const VIBRATO_OFF = 0;
const VIBRATO_DELAY = 2;
const VIBRATO_WHEEL = 3;
const VIBRATO_AT = 4;
const VIBRATO_MODE: ReadonlyMap<number, number> = new Map([
  [0, VIBRATO_OFF], [1, VIBRATO_DELAY], [2, VIBRATO_DELAY], [3, VIBRATO_DELAY], [4, VIBRATO_WHEEL],
  [5, VIBRATO_AT]]);
const LFO_OSC_CTRL = 1;
const LFO_FILTER = 3;
const MOD_RANGE = 60;
const SEVEN_BIT = 127;
const ENV_STAGES: ReadonlyArray<readonly [string, string]> = [
  ['modEnvAtc', 'EnvAtk'], ['modEnvDcy', 'EnvDcy'], ['modEnvRls', 'EnvRls'], ['modEnvVel', 'EnvVel']];

/** Panel organ -> organ layer: level, zone, model and the active drawbar preset. */
export function mapOrgan(m: Mapper, p: string): void {
  const w = `Panel ${p} organ`;
  m.copy(`organ${p}.level`, `organ.layerLevelOrg${p}`, w);
  mapZone(m, `organ${p}.kbZone`, `organ${p}.kbZone`, w);
  mapOctave(m, `organ${p}.octaveShift`, `organ${p}.octaveShift`, w);
  m.copy(`organ${p}.sustainEnable`, `organ${p}.sustainEnable`, w);
  m.copy(`organ${p}.model`, `organ${p}.model`, w);
  const focus = m.v(`organ${p}.presetFocus`);
  const [active, idle] = focus & 1 ? ['II', 'I'] : ['I', 'II'];
  if (focus > 1) m.warn(w, `preset focus ${focus} has an unknown meaning; preset ${active} was converted`);
  const src = `organPreset${active}${p}`;
  DRAWBARS.forEach((db, i) => m.copy(`${src}.${db}`, `organ${p}Drawbars.org_Preset_kDb${i + 1}`, w));
  for (const [ns3, ns4] of VIB_PERC) m.copy(`${src}.${ns3}`, `organ${p}VibPerc.${ns4}`, w);
  const idleKeys = [...DRAWBARS, ...VIB_PERC.map(([a]) => a)].map((k) => `organPreset${idle}${p}.${k}`);
  m.drop(w, idleKeys, `a Stage 4 organ layer holds one drawbar preset, and preset ${active} is the active one`);
}

/** Panel piano -> piano layer; the sound itself only when the Stage 4 knows its id. */
export function mapPiano(m: Mapper, p: string): void {
  const w = `Panel ${p} piano`;
  m.copy(`piano${p}.level`, `piano.layerLevelPno${p}`, w);
  mapZone(m, `piano${p}.kbZone`, `piano${p}.kbZone`, w);
  mapOctave(m, `piano${p}.octaveShift`, `piano${p}.octaveShift`, w);
  m.copy(`piano${p}.pitchStickEnable`, `piano${p}.pStickEnable`, w);
  m.copy(`piano${p}.sustainEnable`, `piano${p}.sustainEnable`, w);
  m.copy(`piano${p}.bank`, `piano${p}.bank`, w);
  const sound = [`piano${p}.nameHash`, `piano${p}.entry`, `piano${p}.variation`];
  if (PIANO_NAMES.has(m.v(sound[0]!))) {
    for (const key of sound) m.copy(key, key, w);
  } else {
    const bank = m.v(`piano${p}.bank`);
    const kind = bank < PIANO_TYPE.length ? PIANO_TYPE[bank]! : 'matching';
    m.drop(w, sound, `the Stage 4 has no piano with this id; pick a ${kind} piano on the Stage 4`);
  }
  // Same bits on both models (soft release, string resonance; pedal noise), but the Stage 4
  // defaults are on: a guess() would switch them on for an all-default Stage 3 piano.
  m.copy(`piano${p}.acoustic`, `piano${p}.acoustic`, w);
  m.copy(`piano${p}.pedalNoise`, `piano${p}.pedalNoise`, w);
  m.guess(`piano${p}.kbdTouch`, `piano${p}.kbdTouch`, w);
  m.copy(`piano${p}.eq`, `piano${p}.eq`, w);
}

/** Panel synth -> synth layer: voice, arp, oscillator, filter, envelopes and LFO. */
export function mapSynth(m: Mapper, p: string): void {
  const w = `Panel ${p} synth`;
  const c = `synthCommon${p}`;
  const s = `synth${p}`;
  const layer = `synth${p}`;
  const snd = `synth${p}Sound`;
  m.copy(`${c}.level`, `synth.layerLevelSyn${p}`, w);
  mapZone(m, `${c}.kbZone`, `${layer}.kbZone`, w);
  mapOctave(m, `${c}.octaveShift`, `${layer}.octaveShift`, w);
  m.copy(`${c}.pitchStickEnable`, `${layer}.pStickEnable`, w);
  m.copy(`${c}.sustainEnable`, `${layer}.sustainEnable`, w);
  m.drop(w, [`${c}.presetPos`, `${c}.presetNameHash`, ...Array.from({ length: 8 }, (_, i) => `${c}.name${i + 1}`)],
    'Stage 3 synth presets are not part of the Stage 4 library; the sound is converted parameter by parameter');
  voice(m, s, layer, w);
  arp(m, s, layer, w);
  oscillator(m, s, snd, w);
  for (const key of ['fltType', 'fltFreq', 'fltRes', 'fltKbdTrk', 'fltDrive']) m.copy(`${s}.${key}`, `${snd}.${key}`, w);
  for (const [ns3, ns4] of [['ampEnvAtc', 'ampEnvAtk'], ['ampEnvDcy', 'ampEnvDcy'], ['ampEnvRls', 'ampEnvRls'],
    ['ampEnvVel', 'ampEnvVel']] as const) {
    m.copy(`${s}.${ns3}`, `${snd}.${ns4}`, w);
  }
  modulation(m, s, snd, w);
  m.drop(w, [`${s}.smpNameHash`, `${s}.smpFastAtk`],
    'Stage 3 samples have no known Stage 4 sample id; pick a sample on the Stage 4');
}

function voice(m: Mapper, s: string, layer: string, w: string): void {
  const mode = m.v(`${s}.voiceMode`);
  const ns4Mode = VOICE_MODE.get(mode);
  if (ns4Mode !== undefined) m.set(`${layer}.voiceMode`, ns4Mode);
  else m.warn(w, `voice mode ${mode} is unknown, left at Poly`);
  m.copy(`${s}.glideRate`, `${layer}.glideRate`, w);
  m.copy(`${s}.unison`, `${layer}.oscUnison`, w);
  const vibrato = m.v(`${s}.vibratoMode`);
  m.set(`${layer}.vibMode`, VIBRATO_MODE.get(vibrato) ?? VIBRATO_OFF);
  if (VIBRATO_MODE.get(vibrato) === VIBRATO_DELAY) {
    m.warn(w, `vibrato Delay ${vibrato} became DLY; its delay time is left at the Stage 4 default`);
  } else if (!VIBRATO_MODE.has(vibrato)) {
    m.warn(w, `vibrato mode ${vibrato} is unknown, set to off`);
  }
}

function arp(m: Mapper, s: string, layer: string, w: string): void {
  for (const key of ['arpRun', 'arpKbdSync', 'arpClkEnable', 'arpRateClkDiv']) m.copy(`${s}.${key}`, `${layer}.${key}`, w);
  m.copy(`${s}.arpPattern`, `${layer}.arpDir`, w);
  m.drop(w, [`${s}.arpRange`], 'the Stage 4 arpeggiator range uses an unknown scale');
}

function oscillator(m: Mapper, s: string, snd: string, w: string): void {
  const bank = m.v(`${s}.oscBank`);
  const wave = m.v(`${s}.oscWave`);
  const conf = m.v(`${s}.oscConf`);
  const detune = m.v(`${s}.dualOscDetune`);
  const chosen = mapOscillator(bank, wave, conf, detune);
  m.set(`${snd}.oscBank`, 0);
  if (chosen === null) {
    const kind = bank < SYNTH_OSC.length ? SYNTH_OSC[bank]! : `#${bank}`;
    m.warn(w, `${kind} oscillator wave ${wave} has no Stage 4 analog counterpart; `
      + 'the Stage 4 default wave was kept, pick a sound on the Stage 4');
  } else {
    m.set(`${snd}.oscCat`, chosen.category);
    m.set(`${snd}.oscWave`, chosen.wave);
    if (chosen.lossy) m.warn(w, `oscillator not matched exactly: ${chosen.lossy}`);
  }
  if (conf && !(chosen && chosen.usesDetune) && detune !== DETUNE_UNISON) {
    m.warn(w, `osc 2 pitch ${signed(detune - DETUNE_UNISON)} semitones not converted: `
      + 'the Stage 4 analog oscillators have no second-oscillator pitch');
  }
  const ctrl = `${s}.oscCtrl`;
  m.copy(ctrl, `${snd}.oscCtrl`, w);
  if (!m.isDefault(ctrl)) {
    m.warn(w, `osc ctrl ${m.v(ctrl)} copied as is; what it controls depends on the oscillator and `
      + 'differs on the Stage 4');
  }
}

/**
 * Mod env -> filter env (plus osc env when osc mod is on); filter LFO and negative osc mod ->
 * the LFO. The Stage 3 filter Mod knob is Vel Amount left of centre and Mod Env Amount right of
 * it; only the osc Mod knob has the LFO on its left.
 */
function modulation(m: Mapper, s: string, snd: string, w: string): void {
  for (const [ns3, ns4] of ENV_STAGES) m.copy(`${s}.${ns3}`, `${snd}.flt${ns4}`, w);
  const fltMod = m.bounded(`${s}.fltMod`, w);
  const oscMod = m.bounded(`${s}.oscMod`, w);
  if (fltMod > 0) {
    m.set(`${snd}.fltEnvAmt`, pyRound((fltMod * SEVEN_BIT) / MOD_RANGE));
  } else if (fltMod < 0) {
    m.warn(w, `filter velocity amount ${fixed((-fltMod * 10) / MOD_RANGE, 1)} (fltMod ${fltMod}) not converted: `
      + 'the Stage 4 filter has no velocity amount, only a velocity switch for its envelope');
  }
  if (oscMod > 0) {
    // Both models scale the osc env amount -60..+60 (Stage 4 table 571-5: 60 = 10.0).
    m.set(`${snd}.oscEnvAmt`, oscMod);
    for (const [ns3, ns4] of ENV_STAGES) m.copy(`${s}.${ns3}`, `${snd}.osc${ns4}`, w);
  }
  m.copy(`${s}.lfoWave`, `${snd}.lfoWave`, w);
  m.copy(`${s}.lfoClkEnable`, `${snd}.lfoClkEnable`, w);
  // Both models share the LFO rate tables to within one rounding step (opennord deps 576-6).
  m.copy(`${s}.lfoRateClkDiv`, `${snd}.lfoRateClkDiv`, w);
  const wanted: Array<[number, number, string]> = [];
  const lfoAmount = m.v(`${s}.fltLFOAmt`);
  if (lfoAmount) wanted.push([LFO_FILTER, lfoAmount, `filter LFO amount ${lfoAmount}`]);
  if (oscMod < 0) wanted.push([LFO_OSC_CTRL, pyRound((-oscMod * SEVEN_BIT) / MOD_RANGE), `osc mod ${oscMod} (LFO)`]);
  const first = wanted[0];
  if (first === undefined) return;
  const [target, amount, what] = first;
  m.set(`${snd}.lfoDst`, target);
  m.set(`${snd}.lfoAmt`, Math.min(amount, fieldOf(NS4_LAYOUT, `${snd}.lfoAmt`).max));
  m.warn(w, `${what} became Stage 4 LFO amount ${amount}; the depth scale is unverified`);
  for (const [, , dropped] of wanted.slice(1)) {
    m.warn(w, `${dropped} not converted: a Stage 4 synth layer has one LFO destination, used for ${what}`);
  }
}
