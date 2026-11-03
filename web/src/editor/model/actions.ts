/**
 * Edits that change more than one field, as one store batch. The follow-up fields carry the
 * origin 'derived'. File loads never run these: they keep the stored values as they are.
 */
import { clampValue, descriptorOf, optionsFor } from './descriptors.ts';
import { type Ns4Key, layerKey, type SynthLayer } from './keys.ts';
import type { ValueReader } from './labels.ts';
import type { Entry, ParamStore } from './store.ts';

/** The value of the layer enable mask bit of a layer (bit 0 = A, bit 1 = B, bit 2 = C). */
export const LAYER_BIT: Readonly<Record<SynthLayer, number>> = { A: 1, B: 2, C: 4 };
const LAYER_ENABLE: Ns4Key = 'synth.layerEnableSyn_I';

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

/** Switch one layer on or off in the scene I layer enable mask. */
export function setLayerEnabled(store: ParamStore, layer: SynthLayer, on: boolean): void {
  const mask = store.get(LAYER_ENABLE);
  store.set(LAYER_ENABLE, on ? mask | LAYER_BIT[layer] : mask & ~LAYER_BIT[layer], 'ui');
}
