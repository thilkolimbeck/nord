/**
 * The synth region (docs/web-design.md, "Regions"): a layer strip (layer keys a b c with their
 * enable LED and focus, a separate on/off toggle per layer, level and pan of the focused layer,
 * then the synth-wide switches), and below it the groups oscillator, filter, amp env,
 * lfo · vibrato, voice, keyboard, osc env and arp. The controls edit the focused layer
 * (synth.layerFocusSyn_I) and are rebound when the focus changes.
 */
import { LAYER_BIT, setLayerEnabled } from '../model/actions.ts';
import { descriptorOf } from '../model/descriptors.ts';
import { LAYERS, layerKey, type Ns4Key, type SynthLayer } from '../model/keys.ts';
import { keysOf, PANEL } from '../model/sections.ts';
import type { ParamStore } from '../model/store.ts';
import { keyForLayer } from './control-model.ts';
import { type Bound, control, type OnTouch } from './controls.ts';
import { h, listen, uid } from './dom.ts';

const FOCUS: Ns4Key = 'synth.layerFocusSyn_I';
const ENABLE: Ns4Key = 'synth.layerEnableSyn_I';
/** Shown in the layer strip as faders of the focused layer. */
const STRIP_FADERS = ['synth.layerLevelSyn{L}', 'synth.layerPanSyn{L}'];
/** Drawn by the layer keys instead of a control of their own. */
const STRIP_OWN: ReadonlySet<string> = new Set([FOCUS, ENABLE]);

export interface SynthPanelApi {
  /** The controls on screen, for the audio engine's coarse markers (T4). */
  readonly controls: readonly Bound[];
  dispose(): void;
}

function focusedLayer(store: ParamStore): SynthLayer {
  return LAYERS[store.get(FOCUS)] ?? 'A';
}

export function mountSynthPanel(root: HTMLElement, store: ParamStore, onTouch: OnTouch): SynthPanelApi {
  const region = PANEL.find((r) => r.id === 'synth')!;
  const [layersGroup, ...groups] = region.groups;
  const layer = focusedLayer(store);
  const controls: Bound[] = [];
  const offs: (() => void)[] = [];
  const make = (key: Ns4Key): HTMLElement => {
    const c = control(descriptorOf(key), store, onTouch);
    controls.push(c);
    return c.el;
  };

  // Layer keys: click focuses, the LED shows the enable bit; the small toggle beside sets it.
  const layerCells = LAYERS.map((l) => {
    const name = l.toLowerCase();
    const stateId = uid(`layer-${name}-state`);
    const state = h('span', { class: 'visually-hidden', id: stateId });
    const key = h('button', { class: 'layer-key', type: 'button', 'aria-describedby': stateId },
      h('span', { class: 'led', 'aria-hidden': 'true' }), h('span', { class: 'layer-key-label', 'aria-hidden': 'true' }, name),
      h('span', { class: 'visually-hidden' }, `layer ${name}`));
    const toggle = h('button', { class: 'bool-key layer-toggle', type: 'button', 'aria-label': `layer ${name} on/off` },
      h('span', { class: 'led', 'aria-hidden': 'true' }), h('span', { 'aria-hidden': 'true' }, 'on/off'));
    offs.push(
      listen(key, 'click', () => {
        store.set(FOCUS, LAYERS.indexOf(l), 'ui');
        onTouch(FOCUS);
      }),
      listen(toggle, 'click', () => {
        setLayerEnabled(store, l, (store.get(ENABLE) & LAYER_BIT[l]) === 0);
        onTouch(ENABLE);
      }),
    );
    return { layer: l, key, toggle, state, el: h('div', { class: 'layer-cell' }, key, toggle, state) };
  });

  const showLayers = (): void => {
    const focus = focusedLayer(store);
    const mask = store.get(ENABLE);
    for (const c of layerCells) {
      const on = (mask & LAYER_BIT[c.layer]) !== 0;
      c.key.setAttribute('aria-pressed', String(c.layer === focus));
      c.key.classList.toggle('lit', on);
      c.toggle.setAttribute('aria-pressed', String(on));
      c.toggle.classList.toggle('lit', on);
      c.state.textContent = `layer ${c.layer.toLowerCase()} ${on ? 'on' : 'off'}${c.layer === focus ? ', edited by the panel' : ''}`;
    }
  };

  const faderKeys = STRIP_FADERS.map((p) => layerKey(layer, p));
  const switchKeys = keysOf(layersGroup!, layer).filter((k) => !STRIP_OWN.has(k) && !faderKeys.includes(k));
  const stripLegendId = uid('synth-legend');
  const strip = h('div', { class: 'layer-strip', role: 'group', 'aria-labelledby': stripLegendId },
    h('p', { class: 'region-legend', id: stripLegendId }, 'synth'),
    h('div', { class: 'layer-keys' }, ...layerCells.map((c) => c.el)),
    h('div', { class: 'strip-faders' }, ...faderKeys.map(make)),
    h('div', { class: 'strip-switches' }, ...switchKeys.map(make)),
  );

  const grid = h('div', { class: 'synth-groups' }, ...groups.map((g) => {
    const legendId = uid(`group-${g.id}`);
    return h('div', { class: 'synth-group', role: 'group', 'aria-labelledby': legendId, 'data-group': g.id },
      h('p', { class: 'group-legend', id: legendId }, g.title), ...keysOf(g, layer).map(make));
  }));

  root.replaceChildren(strip, grid);

  const rebindAll = (): void => {
    const focus = focusedLayer(store);
    for (const c of controls) c.rebind(keyForLayer(c.key, focus));
    showLayers();
  };
  offs.push(store.subscribe(FOCUS, rebindAll), store.subscribe(ENABLE, showLayers));
  showLayers();

  return {
    controls,
    dispose(): void {
      for (const off of offs) off();
      for (const c of controls) c.dispose();
      controls.length = 0;
      root.replaceChildren();
    },
  };
}
