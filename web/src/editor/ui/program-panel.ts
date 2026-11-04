/**
 * The program region (docs/web-design.md, "Editor: program, organ and piano regions"; plan section
 * 13.4), one line of controls: layer scene keys I II, section keys organ piano synth with their
 * LEDs (on or off in the active scene), the three split points (key, position, xfade), transpose
 * and the master clock (stored, no sound). Morph assignments and the preset references, aux
 * keyboard and output routing stay read-only behind "show values".
 */
import { setSectionEnabled } from '../model/actions.ts';
import { descriptorOf } from '../model/descriptors.ts';
import { NS4_KEYS, type Ns4Key } from '../model/keys.ts';
import { keysOf, morphParent, PANEL } from '../model/sections.ts';
import {
  activeKey, activeScene, SCENE_KEY, SCENE_KEYS, SCENES, SECTION_FIELDS, SECTIONS,
} from '../model/scene.ts';
import type { ParamStore } from '../model/store.ts';
import { type Bound, control, type OnTouch, readout } from './controls.ts';
import { h, listen, uid } from './dom.ts';
import type { RegionPanelApi } from './organ-panel.ts';
import { morphCountText, sceneKeys, sectionKeys } from './region-model.ts';
import { group } from './section-panel.ts';

const POINTS = ['Low', 'Mid', 'High'] as const;
/** Groups of the program region shown read-only behind "show values". */
const READ_ONLY_GROUPS = ['presets', 'aux-kb', 'output'];

export function mountProgramPanel(root: HTMLElement, store: ParamStore, onTouch: OnTouch): RegionPanelApi {
  const region = PANEL.find((r) => r.id === 'program')!;
  const controls: Bound[] = [];
  const offs: (() => void)[] = [];
  const make = (key: Ns4Key): HTMLElement => {
    const c = control(descriptorOf(key), store, onTouch);
    controls.push(c);
    return c.el;
  };

  // Layer scene keys: the active one has the accent border; a click switches the scene.
  const scenes = SCENES.map((scene, i) => {
    const key = h('button', { class: 'layer-key scene-key', type: 'button' },
      h('span', { 'aria-hidden': 'true' }, scene), h('span', { class: 'visually-hidden' }, `layer scene ${scene}`));
    offs.push(listen(key, 'click', () => {
      store.set(SCENE_KEY, i, 'ui');
      onTouch(SCENE_KEY);
    }));
    return { scene, key };
  });

  // Section keys: LED = on in the active scene; a click switches it (and a focused layer when none is on).
  const sections = SECTIONS.map((section) => {
    const key = h('button', { class: 'bool-key section-key', type: 'button' },
      h('span', { class: 'led', 'aria-hidden': 'true' }), h('span', null, section));
    offs.push(listen(key, 'click', () => {
      const k = activeKey(store, SECTION_FIELDS[section].on);
      setSectionEnabled(store, section, store.get(k) === 0);
      onTouch(k);
    }));
    return { section, key };
  });

  const showKeys = (): void => {
    for (const s of sceneKeys(store)) {
      const k = scenes.find((x) => x.scene === s.scene)!.key;
      k.setAttribute('aria-pressed', String(s.active));
    }
    const scene = activeScene(store).toLowerCase();
    for (const s of sectionKeys(store)) {
      const k = sections.find((x) => x.section === s.section)!.key;
      k.setAttribute('aria-pressed', String(s.on));
      k.classList.toggle('lit', s.on);
      k.setAttribute('aria-label', `${s.section} section in scene ${scene}`);
    }
  };
  for (const k of [SCENE_KEY, ...SCENE_KEYS]) offs.push(store.subscribe(k, showKeys));
  showKeys();

  const sceneGroup = group('scene', 'layer scene',
    h('div', { class: 'key-row', role: 'group', 'aria-label': 'layer scene' }, ...scenes.map((s) => s.key)),
    make('common.pdlLayerSceneEnable'));
  const sectionGroup = group('sections', 'sections',
    h('div', { class: 'key-row', role: 'group', 'aria-label': 'sections in the active scene' },
      ...sections.map((s) => s.key)));
  const splitGroup = group('split', 'split', ...POINTS.map((p) => h('div', { class: 'split-point' },
    make(`common.splitEnabled${p}` as Ns4Key), make(`common.splitPos${p}` as Ns4Key),
    make(`common.splitWidth${p}` as Ns4Key))));
  const transposeGroup = group('transpose', 'transpose', make('common.transposeEnable'), make('common.transposeValue'));
  const clockGroup = group('clock', 'master clock', make('common.masterClockRate'), make('common.masterClockKbdSync'),
    make('common.pdlTapEnable'));

  // Read-only values: split on, morph assignments, preset references, aux kb, output.
  const bodyId = uid('program-values');
  const body = h('div', { class: 'readouts', id: bodyId, hidden: true });
  const toggle = h('button', { class: 'text-button show-values', type: 'button', 'aria-expanded': 'false',
    'aria-controls': bodyId }, 'show values');
  const readOnly = region.groups.filter((g) => READ_ONLY_GROUPS.includes(g.id));
  const lines: { refresh(): void }[] = [];
  const morphKeys = NS4_KEYS.filter((k) => morphParent(k) !== null);
  const morphValue = h('span', { class: 'readout-value' });
  const showMorphs = (): void => {
    morphValue.textContent = morphCountText(morphKeys.filter((k) => store.get(k) !== 0).length);
  };
  const split = readout('common.splitEnabled', store);
  lines.push(split);
  body.append(
    h('div', { class: 'readout-group' }, h('p', { class: 'readout-group-legend' }, 'split · morph'), split.el,
      h('div', { class: 'readout' }, h('span', { class: 'readout-label' }, 'morph amounts'), morphValue)),
    ...readOnly.map((g) => {
      const rows = keysOf(g, null).map((k) => readout(k, store));
      lines.push(...rows);
      return h('div', { class: 'readout-group' }, h('p', { class: 'readout-group-legend' }, g.title),
        ...rows.map((r) => r.el));
    }),
  );
  const watchedReadouts = new Set<Ns4Key>(['common.splitEnabled', ...readOnly.flatMap((g) => keysOf(g, null))]);
  const morphSet = new Set<Ns4Key>(morphKeys);
  offs.push(
    listen(toggle, 'click', () => {
      const open = toggle.getAttribute('aria-expanded') !== 'true';
      toggle.setAttribute('aria-expanded', String(open));
      toggle.textContent = open ? 'hide values' : 'show values';
      body.hidden = !open;
    }),
    store.onChange((batch) => {
      if (batch.some((c) => watchedReadouts.has(c.key))) for (const l of lines) l.refresh();
      if (batch.some((c) => morphSet.has(c.key))) showMorphs();
    }),
  );
  showMorphs();

  const legendId = uid('program-legend');
  root.replaceChildren(
    h('div', { class: 'program-line', role: 'group', 'aria-labelledby': legendId },
      h('p', { class: 'region-legend', id: legendId }, 'program'),
      sceneGroup, sectionGroup, splitGroup, transposeGroup, clockGroup),
    toggle, body);

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
