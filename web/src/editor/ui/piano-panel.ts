/**
 * The piano region (docs/web-design.md, "Editor: program, organ and piano regions"; plan section
 * 13.3): a layer strip (layer keys a b, level, piano on), the groups model (type, the 295 models
 * by type, variation for a Clav layer, timbre), touch (kb touch, dyn comp, unison, string res and soft release,
 * pedal noise) and keyboard. Every control edits the focused piano layer of the active layer
 * scene. The sound is synthesized, no Nord samples; the controls carry '≈'.
 */
import { descriptorOf } from '../model/descriptors.ts';
import type { Ns4Key } from '../model/keys.ts';
import type { ParamStore } from '../model/store.ts';
import { boundKey } from './control-model.ts';
import { type OnTouch, pianoModelSelect } from './controls.ts';
import { h } from './dom.ts';
import type { RegionPanelApi } from './organ-panel.ts';
import { variationUsed } from './region-model.ts';
import { group, sectionKit } from './section-panel.ts';

export const PIANO_LEGEND = 'piano · approximation (no nord samples)';

export function mountPianoPanel(root: HTMLElement, store: ParamStore, onTouch: OnTouch): RegionPanelApi {
  const kit = sectionKit('piano', store, onTouch);
  const el = (key: Ns4Key): HTMLElement => kit.make(key).el;

  const strip = kit.strip(PIANO_LEGEND,
    h('div', { class: 'strip-faders' }, el('piano.layerLevelPnoA')),
    h('div', { class: 'strip-switches' }, el('common.sectionEnablePno_I')));

  const model = kit.add(pianoModelSelect(descriptorOf(boundKey('piano', 'pianoA.nameHash', store)), store, onTouch));
  const variation = kit.make('pianoA.variation');
  const groups = h('div', { class: 'region-groups' },
    group('piano-model', 'model', el('pianoA.bank'), model.el, variation.el, el('pianoA.eq')),
    group('piano-touch', 'touch', el('pianoA.kbdTouch'), el('pianoA.dynComp'), el('pianoA.unison'),
      el('pianoA.acoustic'), el('pianoA.pedalNoise')),
    group('piano-keyboard', 'keyboard', el('pianoA.kbZone'), el('pianoA.octaveShift'), el('pianoA.pStickEnable'),
      el('pianoA.sustainEnable'), el('pianoA.entry')));

  root.replaceChildren(strip, groups);

  // The variation (clav pickup) sounds only on a Clav layer, so it shows only there, as the organ
  // panel shows only the vibrato type its model uses.
  let bankKey: Ns4Key = boundKey('piano', 'pianoA.bank', store);
  let bankOff: (() => void) | null = null;
  const showVariation = (): void => {
    variation.el.hidden = !variationUsed(store.get(bankKey));
  };
  kit.onRebind(() => {
    bankKey = boundKey('piano', bankKey, store);
    bankOff?.();
    bankOff = store.subscribe(bankKey, showVariation);
    showVariation();
  });
  kit.track(() => bankOff?.());

  return {
    controls: kit.controls,
    dispose(): void {
      kit.dispose();
      root.replaceChildren();
    },
  };
}
