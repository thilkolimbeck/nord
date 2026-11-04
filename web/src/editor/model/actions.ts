/**
 * Edits that change more than one field, as one store batch. The follow-up fields carry the
 * origin 'derived'. File loads never run these: they keep the stored values as they are.
 * Section and layer switches act on the active layer scene (model/scene.ts, plan section 13.4).
 */
import { clampValue, descriptorOf, optionsFor } from './descriptors.ts';
import {
  FX_BLOCKS, FX_GLOBAL_KEYS, FX_GROUP_KEYS, FX_GROUP_ON, FX_PARAMS, FX_UNIT_PARAMS, type FxBlock, fxBlockOf, fxBlocksOf,
  fxFocusBlock, fxFocusEntries, fxGroupOn, fxSectionOf, type GlobalUnit, parseFxKey,
} from './fx.ts';
import { LAYERS, type Ns4Key, layerKey, layerOf, patternOf, type SynthLayer } from './keys.ts';
import type { ValueReader } from './labels.ts';
import { modelsOfType, pianoModel, PIANO_TYPES, pianoType } from './pianos.ts';
import {
  activeScene, focusedLayer, focusEntry, LAYER_BITS, layerMask, layerToggle, type LayerOf, type PianoLayer, type Scene,
  sectionEntry, type SectionId,
} from './scene.ts';
import type { Entry, ParamStore, StoreOrigin } from './store.ts';

/** The value of the layer enable mask bit of a layer (bit 0 = A, bit 1 = B, bit 2 = C). */
export const LAYER_BIT: Readonly<Record<SynthLayer, number>> = LAYER_BITS;

/**
 * Switch a layer's osc bank. When the current category has no label in the new bank, category and
 * wave go to the first row (0); when only the wave has none, the wave does. What the Stage 4 itself
 * does on a bank change is unknown.
 */
export function setOscBank(store: ParamStore, layer: SynthLayer, value: number): void {
  const bankKey = layerKey(layer, 'synth{L}Sound.oscBank');
  const bank = clampValue(descriptorOf(bankKey), value);
  const catKey = layerKey(layer, 'synth{L}Sound.oscCat');
  const waveKey = layerKey(layer, 'synth{L}Sound.oscWave');
  const next = new Map<Ns4Key, number>([[bankKey, bank]]);
  const reader: ValueReader = { get: (key) => next.get(key) ?? store.get(key) };
  const has = (key: Ns4Key): boolean =>
    optionsFor(descriptorOf(key), reader).some((o) => o.value === reader.get(key));
  const entries: Entry[] = [[bankKey, bank]];
  if (!has(catKey)) {
    next.set(catKey, 0);
    entries.push([catKey, 0, 'derived']);
  }
  if (!has(waveKey)) entries.push([waveKey, 0, 'derived']);
  store.setMany(entries, 'ui');
}

/** Switch one synth layer on or off in the active scene's layer enable mask. */
export function setLayerEnabled(store: ParamStore, layer: SynthLayer, on: boolean): void;
/** Switch one layer of a section on or off in the active scene's layer enable mask. */
export function setLayerEnabled<S extends SectionId>(store: ParamStore, section: S, layer: LayerOf<S>, on: boolean): void;
export function setLayerEnabled(store: ParamStore, a: string, b: string | boolean, c?: boolean): void {
  const [section, layer, on] = typeof b === 'boolean'
    ? ['synth' as SectionId, a as SynthLayer, b]
    : [a as SectionId, b as SynthLayer, c === true];
  const [key, value] = layerToggle(store, section, layer as never, on);
  store.set(key, value, 'ui');
}

/**
 * Switch a section on or off in `scene` (default: the active one). Switching it on while its
 * layer enable mask is empty also switches on its focused layer (derived), so a section that is
 * on is never silent; switching off the last layer stays allowed (plan section 13.4).
 */
export function setSectionEnabled(store: ParamStore, section: SectionId, on: boolean,
  scene: Scene = activeScene(store)): void {
  const entries: Entry[] = [sectionEntry(section, on, scene)];
  if (on && layerMask(store, section, scene) === 0) {
    const [key, value] = layerToggle(store, section, focusedLayer(store, section, scene) as never, true, scene);
    entries.push([key, value, 'derived']);
  }
  store.setMany(entries, 'ui');
}

export type SplitPoint = 'Low' | 'Mid' | 'High';
export const SPLIT_POINTS: readonly SplitPoint[] = ['Low', 'Mid', 'High'];

const splitPointKey = (p: SplitPoint): Ns4Key => `common.splitEnabled${p}` as Ns4Key;

/**
 * Whether a split point plays: its own switch and `common.splitEnabled` are both on (M p.39: the
 * SPLIT ON button turns the whole split on or off, the points keep their own switches).
 */
export function splitPointOn(values: ValueReader, point: SplitPoint): boolean {
  return values.get('common.splitEnabled') !== 0 && values.get(splitPointKey(point)) !== 0;
}

/**
 * Switch a split point on or off; `common.splitEnabled` follows as "any point on" (derived). The
 * editor design has keys for the points only (plan section 13.4 proposal, open for the orchestrator).
 * While split is off no point plays, so the keys show every point off (splitPointOn); switching
 * one on then also switches the other points off (derived), so only the point the user chose
 * plays, as after the manual's single press of SPLIT ON with one point set (p.14, 39).
 */
export function setSplitPoint(store: ParamStore, point: SplitPoint, on: boolean): void {
  const master = store.get('common.splitEnabled') !== 0;
  const entries: Entry[] = [[splitPointKey(point), on ? 1 : 0]];
  if (on && !master) {
    for (const p of SPLIT_POINTS) if (p !== point && store.get(splitPointKey(p)) !== 0) entries.push([splitPointKey(p), 0, 'derived']);
  }
  const any = on || (master && SPLIT_POINTS.some((p) => p !== point && store.get(splitPointKey(p)) !== 0));
  entries.push(['common.splitEnabled', any ? 1 : 0, 'derived']);
  store.setMany(entries, 'ui');
}

/** The keys of a piano layer's type, model and slot. */
function pianoKeys(layer: PianoLayer): { bank: Ns4Key; hash: Ns4Key; entry: Ns4Key } {
  return {
    bank: `piano${layer}.bank` as Ns4Key, hash: `piano${layer}.nameHash` as Ns4Key, entry: `piano${layer}.entry` as Ns4Key,
  };
}

/**
 * Pick a piano model by name hash: writes the hash, then the model's type as the bank and slot 0
 * (derived), as Nord Sound Manager writes a substituted piano (plan section 13.3). An unknown hash
 * is written alone.
 */
export function setPianoModel(store: ParamStore, layer: PianoLayer, hash: number): void {
  const k = pianoKeys(layer);
  const model = pianoModel(hash);
  const entries: Entry[] = [[k.hash, hash]];
  if (model !== null) entries.push([k.bank, PIANO_TYPES.indexOf(model.type), 'derived'], [k.entry, 0, 'derived']);
  store.setMany(entries, 'ui');
}

/**
 * Switch a piano layer's type. When the stored model belongs to another type, the model becomes
 * the first model of the new type in catalogue order and the slot 0 (derived).
 */
export function setPianoType(store: ParamStore, layer: PianoLayer, bank: number): void {
  const k = pianoKeys(layer);
  const value = clampValue(descriptorOf(k.bank), bank);
  const type = pianoType(value);
  const entries: Entry[] = [[k.bank, value]];
  const model = pianoModel(store.get(k.hash));
  if (model?.type !== type) {
    const first = modelsOfType(type)[0];
    if (first !== undefined) entries.push([k.hash, first.hash, 'derived'], [k.entry, 0, 'derived']);
  }
  store.setMany(entries, 'ui');
}

/** A synth Group (M p.32, 34, 35): the switch and the layer fields it shares. */
export type SynthGroup = 'filter' | 'lfo' | 'arp';

const MORPHS = (p: string): string[] => ['morphWheel', 'morphAfterTouch', 'morphCtrlPedal'].map((m) => `${p}.${m}`);
const S = 'synth{L}Sound.';
const Y = 'synth{L}.';

/**
 * The layer fields each Group shares, as layer patterns, morph amounts included ("applies the
 * current Filter settings to all Synth Layers", M p.32; LFO p.34; "allows all Layers to share the
 * same settings", arpeggiator p.35). The arpeggiator's pattern fields go with it, decoded or not.
 */
export const SYNTH_GROUPS: Readonly<Record<SynthGroup, { readonly key: Ns4Key; readonly patterns: readonly string[] }>> = {
  filter: {
    key: 'synth.multiLayerFlt',
    patterns: ['fltEnable', 'fltType', 'fltFreq', 'fltRes', 'fltKbdTrk', 'fltDrive', 'fltEnvAmt', 'fltEnvAtk', 'fltEnvDcy',
      'fltEnvRls', 'fltEnvVel'].map((p) => `${S}${p}`)
      .concat(MORPHS(`${S}fltFreq`), MORPHS(`${S}fltRes`), MORPHS(`${S}fltEnvAmt`)),
  },
  lfo: {
    key: 'synth.multiLayerLFO',
    patterns: ['lfoWave', 'lfoDst', 'lfoRateClkDiv', 'lfoAmt', 'lfoClkEnable'].map((p) => `${S}${p}`)
      .concat(MORPHS(`${S}lfoRateClkDiv`), MORPHS(`${S}lfoAmt`)),
  },
  arp: {
    key: 'synth.multiLayerArp',
    patterns: ['arpRun', 'arpMode', 'arpDir', 'arpZigZag', 'arpKbdSync', 'arpRange', 'arpRateClkDiv', 'arpClkEnable',
      'arpPtnEnable', 'arpPtnLen', 'arpPtnAcc', 'arpPtnDur', 'arpPtnPan'].map((p) => `${Y}${p}`)
      .concat(MORPHS(`${Y}arpRange`), MORPHS(`${Y}arpRateClkDiv`)),
  },
};

const GROUP_OF_PATTERN: ReadonlyMap<string, SynthGroup> = new Map(
  (Object.keys(SYNTH_GROUPS) as SynthGroup[]).flatMap((g) => SYNTH_GROUPS[g].patterns.map((p) => [p, g] as const)));

/** The Group whose switch a key is, or null. */
export function groupOfSwitch(key: Ns4Key): SynthGroup | null {
  return (Object.keys(SYNTH_GROUPS) as SynthGroup[]).find((g) => SYNTH_GROUPS[g].key === key) ?? null;
}

/** The Group a synth layer field belongs to while that Group is on, else null. */
export function activeGroupOf(values: ValueReader, key: Ns4Key): SynthGroup | null {
  const group = GROUP_OF_PATTERN.get(patternOf(key));
  return group !== undefined && values.get(SYNTH_GROUPS[group].key) !== 0 ? group : null;
}

/**
 * Switch a synth Group on or off. On copies the focused layer's (active scene) shared fields to
 * the other two layers (derived), as the manual's "applies the current settings to all Synth
 * Layers"; off leaves every layer as it is ("the same settings until these are adjusted manually",
 * p.14–15, said of the effects Group).
 */
export function setSynthGroup(store: ParamStore, group: SynthGroup, on: boolean): void {
  const g = SYNTH_GROUPS[group];
  const entries: Entry[] = [[g.key, on ? 1 : 0]];
  if (on) {
    const source = focusedLayer(store, 'synth');
    for (const p of g.patterns) {
      const value = store.get(layerKey(source, p));
      for (const l of LAYERS) if (l !== source) entries.push([layerKey(l, p), value, 'derived']);
    }
  }
  store.setMany(entries, 'ui');
}

/**
 * Write a field the way a control does: a synth layer field while its Group is on writes every
 * layer (the other two derived), "keeps further edits in sync between them" (M p.32); a field of
 * a piano or synth effects block while the section's effects are in group mode writes every block
 * of the section (derived, M p.48; morph amounts included). Other fields are a plain write.
 * `origin`: 'ui' for the panel, 'midi' for MIDI control in (midi/cc-in.ts).
 */
export function setSynthParam(store: ParamStore, key: Ns4Key, value: number, origin: StoreOrigin = 'ui'): void {
  const fx = parseFxKey(key);
  if (fx !== null) {
    setFxParam(store, key, value, origin);
    return;
  }
  const group = activeGroupOf(store, key);
  const layer = layerOf(key);
  if (group === null || layer === null) {
    store.set(key, value, origin);
    return;
  }
  const v = clampValue(descriptorOf(key), value);
  const p = patternOf(key);
  store.setMany([[key, v], ...LAYERS.filter((l) => l !== layer).map((l): Entry => [layerKey(l, p), v, 'derived'])], origin);
}

// ---------------------------------------------------------------------------------------------
// Layer effects (M p.48; plan section 15.1): group mode, Global mode and the FX focus.

/** The same field in another block: ('pianoAFx.dlyMix', 'pianoBFx') → 'pianoBFx.dlyMix' (morph amounts too). */
export function fxKeyIn(key: Ns4Key, block: FxBlock): Ns4Key {
  const p = parseFxKey(key);
  if (p === null) throw new Error(`${key} is not an effects field`);
  return `${block}${key.slice(p.block.length)}` as Ns4Key;
}

/** Every key of a block: its 32 fields and their morph amounts. */
export function fxBlockKeys(block: FxBlock): Ns4Key[] {
  return FX_PARAMS.flatMap((param) => {
    const key = `${block}.${param}` as Ns4Key;
    const m = descriptorOf(key).morphs;
    return m === null ? [key] : [key, m.wheel, m.afterTouch, m.ctrlPedal];
  });
}

/** A field of an effects block; in group mode every block of the section gets the value (derived). */
export function setFxParam(store: ParamStore, key: Ns4Key, value: number, origin: StoreOrigin = 'ui'): void {
  const p = parseFxKey(key);
  const section = p === null ? null : fxSectionOf(p.block);
  if (p === null || section === null || !fxGroupOn(store, section)) {
    store.set(key, value, origin);
    return;
  }
  const v = clampValue(descriptorOf(key), value);
  const others = fxBlocksOf(section).filter((b) => b !== p.block);
  store.setMany([[key, v], ...others.map((b): Entry => [fxKeyIn(key, b), v, 'derived'])], origin);
}

/**
 * Switch a section's effects group mode (M p.48). On copies the block of the section's focused
 * effects layer to the section's other blocks (derived); off keeps every block as it is. The organ
 * has one block for both layers and no switch.
 */
export function setFxGroup(store: ParamStore, section: 'piano' | 'synth', on: boolean): void {
  const entries: Entry[] = [[FX_GROUP_KEYS[section], on ? FX_GROUP_ON : 1 - FX_GROUP_ON]];
  if (on) {
    const focus = fxFocusBlock(store);
    const source = fxSectionOf(focus) === section ? focus : fxBlocksOf(section)[0]!;
    for (const key of fxBlockKeys(source)) {
      const value = store.get(key);
      for (const b of fxBlocksOf(section)) if (b !== source) entries.push([fxKeyIn(key, b), value, 'derived']);
    }
  }
  store.setMany(entries, 'ui');
}

/** The keys of one unit in a block, morph amounts included. */
function unitKeys(block: FxBlock, unit: GlobalUnit): Ns4Key[] {
  return (FX_UNIT_PARAMS[unit] as readonly string[]).flatMap((param) => {
    const key = `${block}.${param}` as Ns4Key;
    const m = descriptorOf(key).morphs;
    return m === null ? [key] : [key, m.wheel, m.afterTouch, m.ctrlPedal];
  });
}

/**
 * Switch a unit's Global mode (M p.48, 52). Switching it off copies the FX focus block's settings
 * of that unit to the other five blocks (derived): "When turning Global mode off all Layers will
 * share the same settings" (p.48).
 */
export function setFxGlobal(store: ParamStore, unit: GlobalUnit, on: boolean): void {
  const entries: Entry[] = [[FX_GLOBAL_KEYS[unit], on ? 1 : 0]];
  if (!on) {
    const focus = fxFocusBlock(store);
    for (const key of unitKeys(focus, unit)) {
      const value = store.get(key);
      for (const b of FX_BLOCKS) if (b !== focus) entries.push([fxKeyIn(key, b), value, 'derived']);
    }
  }
  store.setMany(entries, 'ui');
}

/** Put the FX focus on a block (the effects region's focus keys). */
export function setFxFocus(store: ParamStore, block: FxBlock): void {
  store.setMany(fxFocusEntries(block).map(([k, v]) => [k, v] as const), 'ui');
}

/**
 * Focus a layer of a section in the active scene (the layer keys); the FX focus follows to that
 * layer's block (derived): it "automatically follows the focus of Layer buttons" (M p.48).
 */
export function setLayerFocus<S extends SectionId>(store: ParamStore, section: S, layer: LayerOf<S>): void {
  store.setMany(layerFocusEntries(store, section, layer), 'ui');
}

/**
 * The entries of a layer focus in `scene` (default the active one): the focus field, and when
 * `scene` is the active scene the FX focus on that layer's block (derived), as setLayerFocus
 * writes them. MIDI control in uses it for the focus controllers (CC 82/83, 109/112, 115/119).
 */
export function layerFocusEntries<S extends SectionId>(values: ValueReader, section: S, layer: LayerOf<S>,
  scene: Scene = activeScene(values)): Entry[] {
  const [key, value] = focusEntry(section, layer, scene);
  if (scene !== activeScene(values)) return [[key, value]];
  const fx = fxFocusEntries(fxBlockOf(section, layer)).map(([k, v]): Entry => [k, v, 'derived']);
  return [[key, value], ...fx];
}
