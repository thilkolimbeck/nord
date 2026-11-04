/**
 * The layer effects region (plan section 15.9; manual p.48–53): legend `layer effects ·
 * approximation`; a first line with `fx on` (Layer Effects ON), the FX focus keys organ, piano a,
 * piano b, synth a, synth b, synth c (layer-key style, the block in focus with the accent border)
 * and the `group` switch of the focused section (the organ has one block for both layers, so its
 * key is unavailable). Below, the six unit groups mod 1, mod 2, delay, amp · eq, comp and reverb
 * edit the block in FX focus and rebind when the focus moves; delay, comp and reverb carry their
 * Global switch, and with it on the group says that one instance plays on every section. Every
 * sound control carries '≈' (a Web Audio model, no Nord effect), unverified ones 'nv'.
 */
import { setFxFocus } from '../model/actions.ts';
import { descriptorOf } from '../model/descriptors.ts';
import { FX_ENABLE_KEY, FX_FOCUS_KEYS, FX_GLOBAL_KEYS, fxFocusBlock, fxKey } from '../model/fx.ts';
import type { Ns4Key } from '../model/keys.ts';
import type { ParamStore } from '../model/store.ts';
import { keyForBlock } from './control-model.ts';
import { type Bound, control, type OnTouch } from './controls.ts';
import { h, listen, reservedNote, uid } from './dom.ts';
import type { RegionPanelApi } from './organ-panel.ts';
import {
  FX_GLOBAL_LINE, FX_ORGAN_GROUP_NOTE, FX_REGION_GROUPS, FX_REGION_LEGEND, fxFocusKeys, fxGlobalShown, fxGroupKey,
} from './region-model.ts';
import { group } from './section-panel.ts';

export function mountFxPanel(root: HTMLElement, store: ParamStore, onTouch: OnTouch): RegionPanelApi {
  const controls: Bound[] = [];
  const blockControls: Bound[] = [];
  const offs: (() => void)[] = [];
  const make = (key: Ns4Key): Bound => {
    const c = control(descriptorOf(key), store, onTouch);
    controls.push(c);
    return c;
  };

  const fxOn = make(FX_ENABLE_KEY);

  // FX focus keys: the block the region edits (M p.48).
  const focusKeys = fxFocusKeys(store).map((f) => {
    const key = h('button', { class: 'layer-key fx-focus-key', type: 'button' },
      h('span', { 'aria-hidden': 'true' }, f.label), h('span', { class: 'visually-hidden' }, `${f.label} effects`));
    offs.push(listen(key, 'click', () => {
      setFxFocus(store, f.block);
      onTouch(FX_FOCUS_KEYS.section);
    }));
    return { block: f.block, key };
  });

  // Group: one switch per section; the organ's is an unavailable key with its reason.
  const groupPiano = make('piano.effectsSectionModePno');
  const groupSynth = make('synth.effectsSectionModeSyn');
  const organNoteId = uid('fx-organ-group');
  const organGroup = h('div', { class: 'ctl ctl-key fx-organ-group' },
    h('span', { class: 'ctl-head' }, h('span', { class: 'ctl-label' }, h('span', { class: 'ctl-label-text' }, 'group'))),
    h('button', { class: 'bool-key', type: 'button', 'aria-disabled': 'true', 'aria-label': 'group',
      'aria-describedby': organNoteId }, h('span', { class: 'led', 'aria-hidden': 'true' })),
    h('span', { class: 'ctl-value', 'aria-hidden': 'true' }),
    h('span', { class: 'ctl-stored', id: organNoteId }, FX_ORGAN_GROUP_NOTE));

  const focusLegendId = uid('fx-focus');
  const head = h('div', { class: 'layer-strip fx-strip', role: 'group', 'aria-labelledby': focusLegendId },
    h('p', { class: 'region-legend', id: focusLegendId }, FX_REGION_LEGEND),
    h('div', { class: 'strip-switches' }, fxOn.el),
    h('div', { class: 'layer-keys', role: 'group', 'aria-label': 'fx focus' }, ...focusKeys.map((f) => f.key)),
    // The three group switches share one cell (only the focused section's shows), so the strip keeps
    // the height of the organ's, with its note, whichever block is in focus.
    h('div', { class: 'strip-switches reserve-stack' }, groupPiano.el, groupSynth.el, organGroup));

  // The six unit groups, bound to the block in focus.
  const focus = fxFocusBlock(store);
  const globals: Array<{ unit: (typeof FX_REGION_GROUPS)[number]['unit']; line: ReturnType<typeof reservedNote> }> = [];
  const groups = FX_REGION_GROUPS.map((g) => {
    const parts = g.params.map((p) => {
      const c = make(fxKey(focus, p));
      blockControls.push(c);
      return c.el;
    });
    if (g.global !== null) {
      // The note keeps its space while the global is off, so switching it moves nothing.
      const line = reservedNote({ class: 'region-note fx-global-line' }, FX_GLOBAL_LINE);
      globals.push({ unit: g.unit, line });
      parts.push(make(g.global).el, line.el);
    }
    return group(`fx-${g.unit}`, g.title, ...parts);
  });

  const show = (): void => {
    const block = fxFocusBlock(store);
    for (const c of blockControls) c.rebind(keyForBlock(c.key, block));
    for (const f of focusKeys) f.key.setAttribute('aria-pressed', String(f.block === block));
    const g = fxGroupKey(store);
    groupPiano.el.toggleAttribute('data-reserved', g.section !== 'piano');
    groupSynth.el.toggleAttribute('data-reserved', g.section !== 'synth');
    organGroup.toggleAttribute('data-reserved', g.section !== 'organ');
    for (const x of globals) x.line.set(fxGlobalShown(store, x.unit) ? FX_GLOBAL_LINE : '');
  };
  const watched: Ns4Key[] = [FX_FOCUS_KEYS.section, FX_FOCUS_KEYS.piano, FX_FOCUS_KEYS.synth, ...Object.values(FX_GLOBAL_KEYS)];
  for (const k of watched) offs.push(store.subscribe(k, show));
  show();

  root.replaceChildren(head, h('div', { class: 'synth-groups fx-groups' }, ...groups));

  return {
    controls,
    dispose(): void {
      for (const off of offs) off();
      offs.length = 0;
      for (const c of controls) c.dispose();
      controls.length = 0;
      root.replaceChildren();
    },
  };
}
