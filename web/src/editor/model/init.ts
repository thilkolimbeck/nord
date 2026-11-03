/**
 * The program a fresh editor starts from: every field at the converter's neutral template value
 * (the Stage 4 layout default, scene I sections and layers off), then the synth section and its
 * layer A switched on, category None, no source file.
 */
import { NS4_LAYOUT } from '../../engine/layout.ts';
import { CATEGORY_NONE, SWITCHES_OFF } from '../../engine/template.ts';
import { NS4_KEYS, type Ns4Key } from './keys.ts';
import type { ProgramSnapshot } from './store.ts';

export const INIT_NAME = 'init';

export function initProgram(): ProgramSnapshot {
  const off = new Set(SWITCHES_OFF);
  const values = {} as Record<Ns4Key, number>;
  for (const key of NS4_KEYS) values[key] = off.has(key) ? 0 : NS4_LAYOUT.fields.get(key)!.default;
  values['common.sectionEnableSyn_I'] = 1;
  values['synth.layerEnableSyn_I'] = 1;
  return { name: INIT_NAME, category: CATEGORY_NONE, values, source: null };
}
