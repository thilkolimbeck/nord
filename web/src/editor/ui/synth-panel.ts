/**
 * The synth region (docs/web-design.md, "Regions"): a layer strip (layer keys a b c with their
 * enable LED and focus, a separate on/off toggle per layer, level and pan of the focused layer,
 * then the synth-wide switches), and below it the groups oscillator, filter, amp env,
 * lfo · vibrato, voice, keyboard, osc env and arp. The controls edit the focused layer of the
 * active layer scene and are rebound when the focus or the scene changes (model/scene.ts).
 */
import { layerKey } from '../model/keys.ts';
import { keysOf, PANEL } from '../model/sections.ts';
import { focusedLayer, SECTION_FIELDS } from '../model/scene.ts';
import type { ParamStore } from '../model/store.ts';
import { controlPattern } from './control-model.ts';
import type { Bound, OnTouch } from './controls.ts';
import { h } from './dom.ts';
import { group, sectionKit } from './section-panel.ts';

/** Shown in the layer strip as faders of the focused layer. */
const STRIP_FADERS = ['synth.layerLevelSyn{L}', 'synth.layerPanSyn{L}'];
/** Drawn by the layer keys instead of a control of their own (scene-free names). */
const STRIP_OWN: ReadonlySet<string> = new Set([SECTION_FIELDS.synth.focus, SECTION_FIELDS.synth.mask]);

export interface SynthPanelApi {
  /** The controls on screen, for the audio engine's coarse markers (T4). */
  readonly controls: readonly Bound[];
  dispose(): void;
}

export function mountSynthPanel(root: HTMLElement, store: ParamStore, onTouch: OnTouch): SynthPanelApi {
  const region = PANEL.find((r) => r.id === 'synth')!;
  const [layersGroup, ...groups] = region.groups;
  const kit = sectionKit('synth', store, onTouch);
  const layer = focusedLayer(store, 'synth');
  const el = (b: Bound): HTMLElement => b.el;

  const faderKeys = STRIP_FADERS.map((p) => layerKey(layer, p));
  const switchKeys = keysOf(layersGroup!, layer)
    .filter((k) => !STRIP_OWN.has(controlPattern(k)) && !faderKeys.includes(k));
  const strip = kit.strip('synth',
    h('div', { class: 'strip-faders' }, ...faderKeys.map((k) => el(kit.make(k)))),
    h('div', { class: 'strip-switches' }, ...switchKeys.map((k) => el(kit.make(k)))));

  const grid = h('div', { class: 'synth-groups' },
    ...groups.map((g) => group(g.id, g.title, ...keysOf(g, layer).map((k) => el(kit.make(k))))));

  root.replaceChildren(strip, grid);

  return {
    controls: kit.controls,
    dispose(): void {
      kit.dispose();
      root.replaceChildren();
    },
  };
}
