/**
 * What the synth, organ and piano panels share (docs/web-design.md, "Regions" and "Editor:
 * program, organ and piano regions"): controls that follow the section's focused layer and the
 * active layer scene, and the layer strip (layer keys with their enable LED and focus border, a
 * separate on/off toggle per layer, faders and switches of the focused layer). Scene switches are
 * read and written through model/scene.ts, never through `_I` literals (plan section 13.6).
 */
import { setLayerEnabled } from '../model/actions.ts';
import { descriptorOf } from '../model/descriptors.ts';
import type { Ns4Key } from '../model/keys.ts';
import {
  activeKey, activeScene, focusedLayer, focusEntry, type LayerOf, layerOn, SCENE_KEY, SCENES, SECTION_FIELDS,
  SECTION_LAYERS, sceneKey, type SectionId,
} from '../model/scene.ts';
import type { ParamStore } from '../model/store.ts';
import { boundKey } from './control-model.ts';
import { type Bound, control, type OnTouch } from './controls.ts';
import { h, listen, uid } from './dom.ts';

export interface SectionKit {
  /** Every control of the panel, rebound on focus and scene changes. */
  readonly controls: Bound[];
  /** A store-bound control for a field of the focused layer in the active scene. */
  make(key: Ns4Key): Bound;
  /** Track a control built elsewhere (drawbars, the piano model select). */
  add<B extends Bound>(c: B): B;
  /** The layer strip: legend, layer keys, then the given parts. */
  strip(legend: string, ...parts: HTMLElement[]): HTMLElement;
  /** Run `fn` after every rebind (focus or scene change) and once now. */
  onRebind(fn: () => void): void;
  /** Store subscriptions and listeners to drop on dispose. */
  track(off: () => void): void;
  dispose(): void;
}

/** The scene fields of a section in both scenes, plus the active scene: what a rebind or a strip refresh listens to. */
function sceneWatch(section: SectionId): Ns4Key[] {
  const f = SECTION_FIELDS[section];
  return [SCENE_KEY, ...SCENES.flatMap((s) => [sceneKey(f.focus, s), sceneKey(f.mask, s)])];
}

export function sectionKit<S extends SectionId>(section: S, store: ParamStore, onTouch: OnTouch): SectionKit {
  const controls: Bound[] = [];
  const offs: (() => void)[] = [];
  const hooks: (() => void)[] = [];
  const refreshers: (() => void)[] = [];

  const add = <B extends Bound>(c: B): B => {
    controls.push(c);
    return c;
  };
  const make = (key: Ns4Key): Bound => add(control(descriptorOf(boundKey(section, key, store)), store, onTouch));

  const strip = (legend: string, ...parts: HTMLElement[]): HTMLElement => {
    const cells = SECTION_LAYERS[section].map((l) => {
      const layer = l as LayerOf<S>;
      const name = String(layer).toLowerCase();
      const stateId = uid(`${section}-layer-${name}-state`);
      const state = h('span', { class: 'visually-hidden', id: stateId });
      const key = h('button', { class: 'layer-key', type: 'button', 'aria-describedby': stateId },
        h('span', { class: 'led', 'aria-hidden': 'true' }),
        h('span', { class: 'layer-key-label', 'aria-hidden': 'true' }, name),
        h('span', { class: 'visually-hidden' }, `${section} layer ${name}`));
      const toggle = h('button', { class: 'bool-key layer-toggle', type: 'button',
        'aria-label': `${section} layer ${name} on/off` },
      h('span', { class: 'led', 'aria-hidden': 'true' }), h('span', { 'aria-hidden': 'true' }, 'on/off'));
      offs.push(
        listen(key, 'click', () => {
          const [k, v] = focusEntry(section, layer, activeScene(store));
          store.set(k, v, 'ui');
          onTouch(k);
        }),
        listen(toggle, 'click', () => {
          setLayerEnabled(store, section, layer, !layerOn(store, section, layer));
          onTouch(activeKey(store, SECTION_FIELDS[section].mask));
        }),
      );
      return { layer, key, toggle, state, el: h('div', { class: 'layer-cell' }, key, toggle, state) };
    });
    const show = (): void => {
      const focus = focusedLayer(store, section);
      for (const c of cells) {
        const on = layerOn(store, section, c.layer);
        const name = String(c.layer).toLowerCase();
        c.key.setAttribute('aria-pressed', String(c.layer === focus));
        c.key.classList.toggle('lit', on);
        c.toggle.setAttribute('aria-pressed', String(on));
        c.toggle.classList.toggle('lit', on);
        c.state.textContent = `layer ${name} ${on ? 'on' : 'off'}${c.layer === focus ? ', edited by the panel' : ''}`
          + ` (scene ${activeScene(store).toLowerCase()})`;
      }
    };
    refreshers.push(show);
    show();
    const legendId = uid(`${section}-legend`);
    return h('div', { class: 'layer-strip', role: 'group', 'aria-labelledby': legendId },
      h('p', { class: 'region-legend', id: legendId }, legend),
      h('div', { class: 'layer-keys' }, ...cells.map((c) => c.el)), ...parts);
  };

  const rebindAll = (): void => {
    for (const c of controls) c.rebind(boundKey(section, c.key, store));
    for (const fn of refreshers) fn();
    for (const fn of hooks) fn();
  };
  for (const key of sceneWatch(section)) offs.push(store.subscribe(key, rebindAll));

  return {
    controls,
    make,
    add,
    strip,
    onRebind(fn: () => void): void {
      hooks.push(fn);
      fn();
    },
    track(off: () => void): void {
      offs.push(off);
    },
    dispose(): void {
      for (const off of offs) off();
      offs.length = 0;
      for (const c of controls) c.dispose();
      controls.length = 0;
    },
  };
}

/** A titled group of controls inside a region ('perc · vibrato', 'rotary'). */
export function group(id: string, title: string, ...children: HTMLElement[]): HTMLElement {
  const legendId = uid(`group-${id}`);
  return h('div', { class: 'synth-group', role: 'group', 'aria-labelledby': legendId, 'data-group': id },
    h('p', { class: 'group-legend', id: legendId }, title), ...children);
}
