/**
 * The instrument panel (docs/web-design.md, "Editor"): legend row with the status strip mount,
 * row 1 display and files box, row 2 program, organ, piano, row 3 synth, row 4 extern and
 * layer effects · rotary, row 5 keyboard; the print-out attached below. The layout-only regions
 * are drawn here as read-only readouts behind a "show values" button, marked "not implemented".
 * The other regions are empty mount points other modules fill (display, synth, status, files,
 * keyboard, print-out).
 */
import { descriptorOf } from '../model/descriptors.ts';
import { LAYER_TOKEN, LAYERS, type Ns4Key } from '../model/keys.ts';
import { type Group, keysOf, PANEL, type Region, type RegionId } from '../model/sections.ts';
import type { ParamStore } from '../model/store.ts';
import { readout } from './controls.ts';
import { h, listen, uid } from './dom.ts';

export interface PanelApi {
  /** Right side of the legend row: audio and MIDI status, panic (T4, T5). */
  readonly status: HTMLElement;
  /** The display (row 1, left). */
  readonly display: HTMLElement;
  /** The files box body under its legend (T6, T7 add the keys). */
  readonly files: HTMLElement;
  /** The synth region. */
  readonly synth: HTMLElement;
  /** The keyboard region's legend line, for the key map (T3). */
  readonly keyboardLegend: HTMLElement;
  /** Where the virtual keyboard goes (T3). */
  readonly keyboard: HTMLElement;
  /** The print-out under the panel. */
  readonly printout: HTMLElement;
  dispose(): void;
}

const APPROXIMATION = 'st-4 editor · sound programming · audio is an approximation';

function region(id: RegionId): Region {
  return PANEL.find((r) => r.id === id)!;
}

/** A group's readout sections: one per layer for layer patterns (extern, synth fx), else one. */
function sections(group: Group): ReadonlyArray<{ title: string; keys: Ns4Key[] }> {
  if (!group.keys.some((k) => k.includes(LAYER_TOKEN))) return [{ title: group.title, keys: keysOf(group, null) }];
  return LAYERS.map((l) => ({ title: `${group.title} · ${l.toLowerCase()}`, keys: keysOf(group, l) }));
}

/** A layout-only region box: legend, "not implemented" badge, first value, the rest behind "show values". */
function layoutRegion(title: string, regions: readonly Region[], store: ParamStore): { el: HTMLElement; dispose(): void } {
  const groups = regions.flatMap((r) => r.groups.flatMap(sections));
  const keys = groups.flatMap((g) => g.keys);
  const watched = new Set<Ns4Key>(keys.flatMap((k) => [k, ...descriptorOf(k).deps]));
  const legendId = uid(`region-${title}`);
  const bodyId = uid(`region-${title}-values`);

  const first = readout(keys[0]!, store);
  const body = h('div', { class: 'readouts', id: bodyId, hidden: true });
  const toggle = h('button', { class: 'text-button show-values', type: 'button', 'aria-expanded': 'false',
    'aria-controls': bodyId }, 'show values');
  let rendered: { refresh(): void }[] = [];

  const expand = (open: boolean): void => {
    toggle.setAttribute('aria-expanded', String(open));
    toggle.textContent = open ? 'hide values' : 'show values';
    body.hidden = !open;
    if (open && rendered.length === 0) {
      for (const g of groups) {
        const lines = g.keys.map((k) => readout(k, store));
        rendered.push(...lines);
        body.append(h('div', { class: 'readout-group' }, h('p', { class: 'readout-group-legend' }, g.title),
          ...lines.map((l) => l.el)));
      }
    }
  };

  const el = h('section', { class: 'region region-layout', 'aria-labelledby': legendId },
    h('p', { class: 'region-head' },
      h('span', { class: 'region-legend', id: legendId }, title), h('span', { class: 'badge' }, 'not implemented')),
    h('div', { class: 'region-first' }, first.el), toggle, body);

  const offs = [
    listen(toggle, 'click', () => expand(toggle.getAttribute('aria-expanded') !== 'true')),
    store.onChange((batch) => {
      if (!batch.some((c) => watched.has(c.key))) return;
      first.refresh();
      for (const r of rendered) r.refresh();
    }),
  ];
  return {
    el,
    dispose(): void {
      for (const off of offs) off();
      rendered = [];
    },
  };
}

export function mountPanel(root: HTMLElement, store: ParamStore): PanelApi {
  const status = h('div', { class: 'status-strip', id: 'status-strip' });
  const display = h('div', { class: 'display-host' });
  const files = h('div', { class: 'files-body' }, h('p', { class: 'region-note' }, 'files: coming soon'));
  const filesLegend = uid('files-legend');
  const synth = h('section', { class: 'region region-synth', id: 'synth', tabindex: -1, 'aria-label': 'synth' });
  const keyboardLegend = h('p', { class: 'region-legend', id: 'keyboard-legend' }, 'keyboard');
  const keyboard = h('div', { class: 'keyboard-slot' });
  const printout = h('div', { class: 'printout-host' });

  const layouts = [
    layoutRegion('program', [region('program')], store),
    layoutRegion('organ', [region('organ')], store),
    layoutRegion('piano', [region('piano')], store),
    layoutRegion('extern', [region('extern')], store),
    layoutRegion('layer effects · rotary', [region('effects'), region('rotary')], store),
  ];
  const [program, organ, piano, extern, effects] = layouts.map((l) => l.el);

  const panel = h('section', { class: 'panel', 'aria-label': 'editor panel' },
    h('div', { class: 'panel-legend' }, h('span', null, APPROXIMATION), status),
    h('div', { class: 'panel-row row-display' }, display,
      h('section', { class: 'region region-files', 'aria-labelledby': filesLegend },
        h('p', { class: 'region-legend', id: filesLegend }, 'files'), files)),
    h('div', { class: 'panel-row row-thirds' }, program, organ, piano),
    synth,
    h('div', { class: 'panel-row row-halves' }, extern, effects),
    h('section', { class: 'region region-keyboard', id: 'keyboard', tabindex: -1, 'aria-labelledby': keyboardLegend.id },
      keyboardLegend, keyboard),
  );
  root.replaceChildren(panel, printout);

  return {
    status, display, files, synth, keyboardLegend, keyboard, printout,
    dispose(): void {
      for (const l of layouts) l.dispose();
      root.replaceChildren();
    },
  };
}
