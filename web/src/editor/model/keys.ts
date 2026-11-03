/**
 * Parameter ids of the editor: the Stage 4 layout keys, typed. The generated NS4_KEYS list is
 * the layout of web/src/engine/generated/layout-ns4.ts in the same order (keys.test.ts checks it).
 */
import { NS4_KEYS } from '../generated/display-ns4.ts';

export { NS4_KEYS };

/** One of the 955 Stage 4 layout keys. */
export type Ns4Key = (typeof NS4_KEYS)[number];
export type SynthLayer = 'A' | 'B' | 'C';
export const LAYERS: readonly SynthLayer[] = ['A', 'B', 'C'];
/** The stand-in for the layer letter in a layer-free pattern: 'synth{L}Sound.fltFreq'. */
export const LAYER_TOKEN = '{L}';

const KEY_SET: ReadonlySet<string> = new Set<string>(NS4_KEYS);

export function isNs4Key(s: string): s is Ns4Key {
  return KEY_SET.has(s);
}

/** The key a pattern names for one layer; throws when the result is not a layout key. */
export function layerKey(layer: SynthLayer, pattern: string): Ns4Key {
  const key = pattern.split(LAYER_TOKEN).join(layer);
  if (!isNs4Key(key)) throw new Error(`${pattern} names no Stage 4 field for layer ${layer}`);
  return key;
}

/** The keys a pattern names: one per layer with the token, else the pattern itself. */
export function expandPattern(pattern: string): Ns4Key[] {
  if (!pattern.includes(LAYER_TOKEN)) {
    if (!isNs4Key(pattern)) throw new Error(`${pattern} is not a Stage 4 field`);
    return [pattern];
  }
  return LAYERS.map((layer) => layerKey(layer, pattern));
}

// Synth layer keys: blocks synthA, synthASound, synthAFx and the per-layer fields of the
// synth section (synth.layerLevelSynA, synth.layerPanSynA and their morphs).
const LAYER_RE = /^(synth)([ABC])((?:Sound|Fx)?\.)|^(synth\.layer(?:Level|Pan)Syn)([ABC])(?=\.|$)/;

/** The synth layer a key belongs to, or null for keys outside the three synth layers. */
export function layerOf(key: Ns4Key): SynthLayer | null {
  const m = LAYER_RE.exec(key);
  if (m === null) return null;
  return (m[2] ?? m[5]) as SynthLayer;
}

/** The layer-free pattern of a key: 'synthBSound.fltFreq' -> 'synth{L}Sound.fltFreq'; other keys as they are. */
export function patternOf(key: Ns4Key): string {
  const m = LAYER_RE.exec(key);
  if (m === null) return key;
  const rest = key.slice(m[0].length);
  return m[1] !== undefined ? `${m[1]}${LAYER_TOKEN}${m[3]!}${rest}` : `${m[4]!}${LAYER_TOKEN}${rest}`;
}
