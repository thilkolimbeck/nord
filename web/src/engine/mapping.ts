/**
 * Stage 3 program -> Stage 4 field edits: the approved Phase 1 mapping (port of
 * nordconv/mapping.py).
 *
 * Both panels convert (Panel A -> layer A, Panel B -> layer B in scene I); the result is a set
 * of edits for a neutral donor; every section converts, playing or not, but reports about an
 * engine, panel or effect unit that is off in the source are notes, not warnings. Any Stage 3
 * field no rule reads is swept up at the end and reported if it is not at its default.
 */
import { SPLIT_NOTE } from './generated/tables-ns3.ts';
import { FIELD_VALUE_TABLE, PIANO_NAMES, VALUE_TABLES } from './generated/tables-ns4.ts';
import { fieldOf, NS3_LAYOUT, NS4_LAYOUT } from './layout.ts';
import { mapOrgan, mapPiano, mapSynth } from './map-engines.ts';
import { mapEffects, mapRotary, organFxOwner, SRC_ORGAN, SRC_PIANO, SRC_SYNTH, type Panel } from './map-fx.ts';
import { Mapper, short } from './mapper.ts';
import type { Ns3Program } from './program.ts';
import { signed } from './pyfmt.ts';
import { effectiveValues } from './source.ts';

const PANELS: readonly Panel[] = ['A', 'B'];
const SPLIT_POINTS = ['Low', 'Mid', 'High'];
// NS3 slotEnable: 1 = A, 2 = B, 3 = A & B.
const PANEL_BITS: Readonly<Record<Panel, number>> = { A: 1, B: 2 };
// NS4 layer enable masks: bit 0 = layer A, bit 1 = layer B.
const LAYER_BITS: Readonly<Record<Panel, number>> = { A: 1, B: 2 };
// [Stage 3 engine enable key, Stage 4 layer mask, Stage 4 scene I section enable]
const SECTIONS: ReadonlyArray<readonly [string, string, string]> = [
  ['organ{p}.enable', 'organ.layerEnableOrg_I', 'common.sectionEnableOrg_I'],
  ['piano{p}.enable', 'piano.layerEnablePno_I', 'common.sectionEnablePno_I'],
  ['synthCommon{p}.enable', 'synth.layerEnableSyn_I', 'common.sectionEnableSyn_I'],
];
const FOCUS_KEYS = ['organ.layerFocusOrg_I', 'piano.layerFocusPno_I', 'synth.layerFocusSyn_I'];
// Per-layer effects (0) rather than one block for the section (1, the default): the two Stage 3
// panels have their own effects, and Nord Sound Manager writes 0 whether the section plays or not.
const PER_LAYER_FX = ['piano.effectsSectionModePno', 'synth.effectsSectionModeSyn'];
// Scene II keeps the Stage 4 defaults, as Nord Sound Manager does: piano section on with layer A.
const SCENE_II_PIANO = 'common.sectionEnablePno_II';
const SCENE_II_PIANO_LAYERS = 'piano.layerEnablePno_II';
const SNAPSHOTS: ReadonlyArray<readonly [string, string]> = [
  ['common.leslieRotorAngle', 'organ.leslieRotorAngle'], ['common.leslieHornAngle', 'organ.leslieHornAngle']];
// Stage 3 extern -> the same panel's Stage 4 synth layer, same name and range (Nord Sound Manager copies
// bank, program and control pedal; the others are the same fields, unproven).
const EXTERN_COPY: ReadonlyArray<readonly [string, string]> = [
  ['velCurve', 'externVelCurve'], ['modWheelEnable', 'externModWheelEnable'],
  ['aftertouchEnable', 'externAftertouchEnable'], ['ctrlPedalEnable', 'externCtrlPedalEnable'],
  ['swellPedalEnable', 'externSwellPedalEnable'], ['volPedalEnable', 'externVolPedalEnable'],
  ['bcValue_LSB', 'externBCValue_LSB'], ['bcValue_MSB', 'externBCValue_MSB'], ['pcValue', 'externPCValue'],
  ['ccValue', 'externCCValue1']];
// The Stage 4 has one send-on-load switch: Nord Sound Manager takes the one of the selected parameter.
const EXTERN_SEND_ON_LOAD = ['sendOnLoadCC', 'sendOnLoadPC', 'sendOnLoadVol']; // paramSelect 0 CC, 1 PC, 2 Vol
const EXTERN_LOST = ['kbZone', 'octaveShift', 'pitchStickEnable', 'sustainEnable', 'volValue'];
const VOX = 1;
const FARFISA = 2;
// The Stage 4 keeps one vibrato setting per organ model: Vox V1/V2/V3 = 0/1/2, Farfisa V1/V2/C2/C3 = 0/1/2/3.
const VOX_VIBRATO: ReadonlyMap<number, number> = new Map([[0, 0], [1, 1], [2, 1], [3, 2], [4, 2]]);
const FARFISA_VIBRATO: ReadonlyMap<number, number> = new Map([[0, 0], [1, 1], [2, 1], [3, 2], [4, 3], [5, 3]]);

/** The Stage 4 edits for one program, the warnings, fields no rule handled, and notes. */
export interface MappingResult {
  readonly edits: ReadonlyMap<string, number>;
  readonly warnings: readonly string[];
  readonly unhandled: readonly string[];
  readonly notes: readonly string[];
}

const engineKey = (engine: string, p: Panel): string => engine.replace('{p}', p);
type Plays = ReadonlyMap<string, boolean>; // key: `${engine}|${panel}`
const playsKey = (engine: string, p: string): string => `${engine}|${p}`;
const playsOf = (plays: Plays, engine: string, p: string): boolean => plays.get(playsKey(engine, p)) ?? false;

/** Map every Stage 3 field to Stage 4 edits and warnings. */
export function mapProgram(program: Ns3Program): MappingResult {
  const [values, sourceNotes] = effectiveValues(program);
  const m = new Mapper(values);
  m.warnings.push(...sourceNotes);
  const slots = m.v('common.slotEnable');
  const active: Record<Panel, boolean> = { A: Boolean(slots & PANEL_BITS.A), B: Boolean(slots & PANEL_BITS.B) };
  const plays = new Map<string, boolean>();
  for (const [engine] of SECTIONS) {
    for (const p of PANELS) plays.set(playsKey(engine, p), Boolean(m.v(engineKey(engine, p))) && active[p]);
  }
  const [organ, piano, synth] = SECTIONS.map(([engine]) => engine) as [string, string, string];
  mapCommon(m);
  m.section(PANELS.some((p) => playsOf(plays, piano, p)), () => mapLayerDetune(m));
  mapSections(m, plays);
  const organPlays: Record<Panel, boolean> = { A: playsOf(plays, organ, 'A'), B: playsOf(plays, organ, 'B') };
  const owner = organFxOwner(organPlays);
  m.section(organPlays.A || organPlays.B, () => {
    mapOrganVibrato(m, organPlays);
    mapRotary(m);
  });
  for (const p of PANELS) {
    m.section(playsOf(plays, organ, p), () => mapOrgan(m, p));
    m.section(playsOf(plays, piano, p), () => mapPiano(m, p));
    m.section(playsOf(plays, synth, p), () => mapSynth(m, p));
    const sources = new Map<number, boolean>([
      [SRC_ORGAN, playsOf(plays, organ, p)], [SRC_PIANO, playsOf(plays, piano, p)],
      [SRC_SYNTH, playsOf(plays, synth, p)]]);
    m.section(active[p], () => mapEffects(m, p, owner, organPlays.A && organPlays.B, sources));
    mapExternAndMixer(m, p, active[p]);
  }
  mapKbdHold(m);
  mapSceneTwo(m, plays);
  const heard = activity(m.values, plays, active);
  dropMorphs(m, heard);
  const unhandled = Array.from(NS3_LAYOUT.fields.keys()).filter((k) => !m.read.has(k));
  for (const key of unhandled) {
    m.section(heard(key), () => m.drop(where(key), [key], 'no conversion rule covers it'));
  }
  return { edits: new Map(m.edits), warnings: [...m.warnings], unhandled, notes: [...m.notes] };
}

/** Whether the section a Stage 3 field belongs to is heard, for reports outside a rule's own section. */
function activity(values: ReadonlyMap<string, number>, plays: Plays,
  active: Readonly<Record<Panel, boolean>>): (key: string) => boolean {
  const [organ, piano, synth] = SECTIONS.map(([engine]) => engine) as [string, string, string];
  const engines: ReadonlyMap<string, string> = new Map([
    ['organ', organ], ['organPresetI', organ], ['organPresetII', organ],
    ['piano', piano], ['synth', synth], ['synthCommon', synth]]);
  const bySource: ReadonlyMap<number, string> = new Map([[SRC_ORGAN, organ], [SRC_PIANO, piano], [SRC_SYNTH, synth]]);
  const units: ReadonlyArray<readonly [string, string | null]> = [
    ['fx1', 'fx1Src'], ['fx2', 'fx2Src'], ['dly', 'dlySrc'], ['amp', 'ampSrc'], ['leslie', 'leslieSrc'],
    ['cmp', null], ['rvb', null]];
  const value = (key: string): number => {
    const v = values.get(key);
    if (v === undefined) throw new Error(`no Stage 3 value '${key}'`);
    return v;
  };

  return (key: string): boolean => {
    const [block = '', name = ''] = key.split('.');
    if (block === 'common') return true;
    const panel = block.slice(-1);
    const base = block.slice(0, -1);
    if (!(panel === 'A' || panel === 'B') || !active[panel]) return false;
    const engine = engines.get(base);
    if (engine !== undefined) return playsOf(plays, engine, panel);
    if (base === 'extern') return Boolean(value(`extern${panel}.enable`));
    if (base === 'effects') {
      for (const [unit, src] of units) {
        if (name.startsWith(unit)) {
          const enable = values.get(`${block}.${unit}Enable`);
          const on = Boolean(enable === undefined ? 1 : enable);
          if (src === null) return on && Array.from(bySource.values()).some((e) => playsOf(plays, e, panel));
          const sourceEngine = bySource.get(value(`${block}.${src}`));
          return on && sourceEngine !== undefined && playsOf(plays, sourceEngine, panel);
        }
      }
    }
    return true;
  };
}

/** Stage 4 split position with the same note (Stage 4 adds C2 below the Stage 3's lowest F2). */
function ns4SplitPosition(ns3Pos: number): number {
  const tableId = FIELD_VALUE_TABLE['common.splitPosLow']![0];
  const byLabel = new Map<string, number>();
  for (const [raw, label] of VALUE_TABLES[tableId]!) byLabel.set(label, raw); // later raws win, as in a dict
  const raw = byLabel.get(SPLIT_NOTE[ns3Pos]!);
  if (raw === undefined) throw new Error(`no Stage 4 split position for '${SPLIT_NOTE[ns3Pos]}'`);
  return raw;
}

function mapCommon(m: Mapper): void {
  const w = 'Common';
  m.copy('common.splitEnable', 'common.splitEnabled', w);
  for (const point of SPLIT_POINTS) {
    m.copy(`common.split${point}Enable`, `common.splitEnabled${point}`, w);
    m.copy(`common.split${point}Width`, `common.splitWidth${point}`, w);
    const pos = m.v(`common.split${point}Pos`);
    if (pos >= 0 && pos < SPLIT_NOTE.length) {
      m.set(`common.splitPos${point}`, ns4SplitPosition(pos));
    } else {
      m.warn(w, `split${point}Pos ${pos} is not a known split note, left at the Stage 4 default`);
    }
  }
  m.copy('common.transposeEnable', 'common.transposeEnable', w);
  m.copy('common.transposeValue', 'common.transposeValue', w);
  m.copy('common.masterClockRate', 'common.masterClockRate', w);
  for (const p of PANELS) m.copy('common.pitchStickRange', `synth${p}.pitchStickRange`, w);
  m.copy('common.orgPStickEnable', 'organ.orgPStickEnable', w);
  if (m.v('common.dualKbdEnable')) {
    m.drop(w, ['common.dualKbdEnable', 'common.dualKbdStyle'],
      'the Stage 4 handles a second keyboard differently; set it up on the instrument');
  } else {
    m.skip(['common.dualKbdStyle']); // only matters while Dual KB is on
  }
  // Rotor positions at save time; Nord Sound Manager copies them.
  for (const [src, dst] of SNAPSHOTS) m.copy(src, dst, w);
  if (m.v('common.slotFocus')) {
    for (const key of FOCUS_KEYS) m.set(key, 1);
  }
}

/** Scene I layer and section switches, and per-layer effects for piano and synth. */
function mapSections(m: Mapper, plays: Plays): void {
  for (const [engine, maskKey, sectionKey] of SECTIONS) {
    let mask = 0;
    for (const p of PANELS) if (playsOf(plays, engine, p)) mask += LAYER_BITS[p];
    m.set(maskKey, mask);
    m.set(sectionKey, Number(mask > 0));
  }
  for (const key of PER_LAYER_FX) m.set(key, 0);
}

/**
 * Scene II stays at the Stage 4 defaults, but its piano only plays a piano the converter wrote.
 * Nord Sound Manager always leaves the scene II piano on; a layer without a converted piano would
 * play whatever its default id stands for, so that section is switched off instead.
 * A scene II layer whose Stage 3 piano is off gets a warning, as its own reports are notes.
 */
function mapSceneTwo(m: Mapper, plays: Plays): void {
  const layers = fieldOf(NS4_LAYOUT, SCENE_II_PIANO_LAYERS).default;
  if (PANELS.some((p) => layers & LAYER_BITS[p] && !m.edits.get(`piano${p}.nameHash`))) {
    m.set(SCENE_II_PIANO, 0);
    return;
  }
  for (const p of PANELS) {
    if (layers & LAYER_BITS[p] && !playsOf(plays, SECTIONS[1]![0], p)) {
      const name = PIANO_NAMES[m.edits.get(`piano${p}.nameHash`)!];
      m.warn('Scene II', `piano layer ${p} (${name}) plays, as Nord Sound Manager leaves scene II; `
        + `it holds the piano of Stage 3 Panel ${p}, which is off`);
    }
  }
}

/** Stage 3 piano Layer Detune (Off/1/2/3, one setting for both panels) -> each Stage 4 piano layer's Unison. */
function mapLayerDetune(m: Mapper): void {
  const key = 'common.layerDetune';
  for (const p of PANELS) m.copy(key, `piano${p}.unison`, 'Common');
  if (!m.isDefault(key)) {
    m.warn('Common', `piano layer detune ${m.v(key)} became piano Unison ${m.v(key)} on both piano layers: `
      + 'approximated, the Stage 3 detunes the layers against each other and the Stage 4 '
      + 'detunes within each layer');
  }
}

/** The program-wide vibrato/chorus selector -> the Stage 4 B3, Vox and Farfisa selectors. */
function mapOrganVibrato(m: Mapper, organPlays: Readonly<Record<Panel, boolean>>): void {
  const key = 'common.orgVibratoType';
  m.copy(key, 'organ.vibratoTypeB3', 'Common'); // same V1 C1 V2 C2 V3 C3 order
  const value = m.v(key);
  const models: ReadonlyArray<readonly [number, ReadonlyMap<number, number>, string]> = [
    [VOX, VOX_VIBRATO, 'organ.vibratoTypeVox'], [FARFISA, FARFISA_VIBRATO, 'organ.vibratoTypeFarfisa']];
  for (const [model, table, dst] of models) {
    const mapped = table.get(value);
    if (mapped !== undefined) {
      m.set(dst, mapped);
    } else if (PANELS.some((p) => organPlays[p] && m.v(`organ${p}.model`) === model)) {
      m.warn('Common', `orgVibratoType ${value} has no ${['Vox', 'Farfisa'][model - 1]} setting; `
        + 'the Stage 4 default was kept');
    }
  }
}

/** Stage 3 hold per panel -> Stage 4 hold for the section plus a per-layer include switch. */
function mapKbdHold(m: Mapper): void {
  const holds: Record<Panel, number> = { A: m.v('synthA.kbdHold'), B: m.v('synthB.kbdHold') };
  // Always, as Nord Sound Manager does; layer C keeps the Stage 4 default.
  for (const p of PANELS) m.set(`synth${p}.kbdHoldEnableLayer`, holds[p]);
  if (holds.A || holds.B) m.set('synth.kbdHoldEnableCommon', 1);
}

/** Extern values -> synth layer p with extern left off (as Nord Sound Manager does); mixer reported. */
function mapExternAndMixer(m: Mapper, p: Panel, active: boolean): void {
  const keys = Array.from(NS3_LAYOUT.fields.keys());
  const x = `extern${p}`;
  const w = `Panel ${p} extern`;
  m.section(active && Boolean(m.v(`${x}.enable`)), () => {
    for (const [ns3, ns4] of EXTERN_COPY) m.copy(`${x}.${ns3}`, `synth${p}.${ns4}`, w);
    const select = m.v(`${x}.paramSelect`);
    const sends = EXTERN_SEND_ON_LOAD.map((k) => `${x}.${k}`);
    if (select >= 0 && select < sends.length) m.copy(sends[select]!, `synth${p}.externSendOnLoad`, w);
    m.drop(w, [`${x}.enable`, `${x}.midiCh`],
      `the values were carried over to synth layer ${p}, but extern must be switched on on the layer, `
      + 'and the MIDI channel is set on the Stage 4');
    m.drop(w, EXTERN_LOST.map((k) => `${x}.${k}`), 'the Stage 4 extern has no such setting');
    m.drop(w, [`${x}.ccNumber`], 'the Stage 4 CC number has another range (0-120, default 3), scale unverified');
    m.drop(w, sends.filter((_, i) => i !== select),
      'the Stage 4 has one send-on-load switch, taken from the selected parameter');
  });
  const mixer = keys.filter((k) => k.startsWith(`mixer${p}.`));
  m.section(active, () => m.drop(`Panel ${p} mixer`, mixer, 'the Stage 4 audio routing works differently'));
}

/** Morph assignments no rule converted (only the filter cutoff and resonance morphs are mapped). */
function dropMorphs(m: Mapper, heard: (key: string) => boolean): void {
  const groups = new Map<string, { where: string; on: boolean; keys: string[] }>();
  const handled = new Set(m.read);
  for (const key of NS3_LAYOUT.fields.keys()) {
    if (!key.includes('.morph') || handled.has(key)) continue;
    const at = where(key);
    const on = heard(key);
    const id = `${at}|${on}`;
    let group = groups.get(id);
    if (group === undefined) {
      group = { where: at, on, keys: [] };
      groups.set(id, group);
    }
    group.keys.push(key);
  }
  for (const { where: at, on, keys } of groups.values()) {
    const changed: string[] = [];
    for (const k of keys) if (!m.isDefault(k)) changed.push(`${short(k)}=${signed(m.v(k))}`);
    if (changed.length) {
      m.section(on, () => m.warn(at, `morphs ${changed.join(', ')} not converted: the Stage 4 morph encoding `
        + 'is not mapped yet'));
    }
  }
}

/** A readable section name for a Stage 3 field key. */
function where(key: string): string {
  const block = key.split('.', 1)[0]!;
  if (block === 'common') return 'Common';
  const panel = block.slice(-1);
  const base = block.slice(0, -1);
  const names: Readonly<Record<string, string>> = { synthCommon: 'synth', organPresetI: 'organ', organPresetII: 'organ' };
  return `Panel ${panel} ${names[base] ?? base}`;
}
