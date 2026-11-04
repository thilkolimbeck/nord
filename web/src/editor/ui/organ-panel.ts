/**
 * The organ region (docs/web-design.md, "Editor: program, organ and piano regions"; plan section
 * 13.2): a layer strip (layer keys a b, model, level, organ on, pitch stick), nine vertical
 * drawbars with captions per model, the groups perc · vibrato (with the vibrato type of the
 * focused layer's model), rotary and keyboard. Every control edits the focused organ layer of the
 * active layer scene. The sound is an additive approximation; the controls carry '≈'.
 */
import { descriptorOf } from '../model/descriptors.ts';
import type { Ns4Key } from '../model/keys.ts';
import type { ParamStore } from '../model/store.ts';
import { boundKey } from './control-model.ts';
import { type Bound, drawbar, type DrawbarBound, type OnTouch } from './controls.ts';
import { h } from './dom.ts';
import { drawbarLabels, organModel, VIBRATO_TYPE_KEYS, vibratoTypeKey } from './region-model.ts';
import { group, sectionKit } from './section-panel.ts';

export const ORGAN_LEGEND = 'organ · approximation';
const VP = 'organAVibPerc.org_Preset_k';

export interface RegionPanelApi {
  readonly controls: readonly Bound[];
  dispose(): void;
}

export function mountOrganPanel(root: HTMLElement, store: ParamStore, onTouch: OnTouch): RegionPanelApi {
  const kit = sectionKit('organ', store, onTouch);
  const el = (key: Ns4Key): HTMLElement => kit.make(key).el;

  const strip = kit.strip(ORGAN_LEGEND,
    h('div', { class: 'strip-faders' }, el('organA.model'), el('organ.layerLevelOrgA')),
    h('div', { class: 'strip-switches' }, el('common.sectionEnableOrg_I'), el('organ.orgPStickEnable')));

  const bars: DrawbarBound[] = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => kit.add(drawbar(
    descriptorOf(boundKey('organ', `organADrawbars.org_Preset_kDb${n}` as Ns4Key, store)), store, onTouch)));
  const drawbars = group('drawbars', 'drawbars', h('div', { class: 'drawbars' }, ...bars.map((b) => b.el)));

  const vibTypes = VIBRATO_TYPE_KEYS.map((k) => kit.make(k));
  const perc = group('organ-vibrato', 'perc · vibrato',
    el(`${VP}VibratoEnable` as Ns4Key), ...vibTypes.map((c) => c.el),
    el(`${VP}B3PercEnable` as Ns4Key), el(`${VP}B3PercHarmonic` as Ns4Key), el(`${VP}B3PercSpeed` as Ns4Key),
    el(`${VP}B3PercLevel` as Ns4Key), el('organ.polyPercEnable'));

  const rotary = group('rotary', 'rotary', el('organ.effectsLeslieEnable'), el('organ.effectsLeslieSpeed'),
    el('organ.effectsLeslieStopMode'), el('organ.effectsLeslieDrv'), el('organ.leslieMicDistance'),
    el('organ.leslieStopPreset'), el('organ.leslieRotorAngle'), el('organ.leslieHornAngle'));

  const keyboard = group('organ-keyboard', 'keyboard', el('organA.kbZone'), el('organA.octaveShift'),
    el('organA.sustainEnable'), el('organA.presetEnable'));

  root.replaceChildren(strip, h('div', { class: 'organ-body' }, drawbars,
    h('div', { class: 'region-groups' }, perc, rotary, keyboard)));

  // Drawbar captions and the vibrato type follow the focused layer's model.
  let modelKey: Ns4Key = boundKey('organ', 'organA.model', store);
  let modelOff: (() => void) | null = null;
  const showModel = (): void => {
    const model = organModel(store.get(modelKey));
    drawbarLabels(model).forEach((l, i) => bars[i]!.setCaption(l.short, l.name, l.used));
    const vib = vibratoTypeKey(model);
    for (const c of vibTypes) c.el.hidden = c.key !== vib;
  };
  kit.onRebind(() => {
    modelKey = boundKey('organ', modelKey, store);
    modelOff?.();
    modelOff = store.subscribe(modelKey, showModel);
    showModel();
  });
  kit.track(() => modelOff?.());

  return {
    controls: kit.controls,
    dispose(): void {
      kit.dispose();
      root.replaceChildren();
    },
  };
}
