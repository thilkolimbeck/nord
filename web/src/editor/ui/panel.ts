/**
 * The instrument panel (docs/web-design.md, "Editor" and "Editor: program, organ and piano
 * regions"): legend row with the status strip mount, row 1 display and files box, row 2 program
 * (full width), row 3 organ and piano, row 4 synth, row 5 extern and layer effects, row 6
 * keyboard (with the octave keys in its head), then the print-out and the colophon line at the
 * foot. On narrow screens (< 760px) the regions stack in one column in another order (display and
 * files, synth, organ, piano, program, extern, layer effects, keyboard); the DOM is reordered, not
 * only the boxes, so the tab order follows what is on screen. The layout-only regions (extern,
 * layer effects) are drawn here as read-only readouts behind a "show values" button, marked "not
 * implemented". The live regions are mount points: mountRegions fills program, organ and piano;
 * other modules fill the display, synth, status, files, keyboard, print-out and colophon.
 */
import { descriptorOf } from '../model/descriptors.ts';
import { LAYER_TOKEN, LAYERS, type Ns4Key } from '../model/keys.ts';
import { type Group, keysOf, PANEL, type Region, type RegionId } from '../model/sections.ts';
import type { ParamStore } from '../model/store.ts';
import { type Bound, type OnTouch, readout } from './controls.ts';
import { h, listen, uid } from './dom.ts';
import { mountOrganPanel } from './organ-panel.ts';
import { mountPianoPanel } from './piano-panel.ts';
import { mountProgramPanel } from './program-panel.ts';

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
  /** The octave keys in the keyboard region's head (down, up). */
  readonly octaveDown: HTMLButtonElement;
  readonly octaveUp: HTMLButtonElement;
  /** The print-out at the foot of the panel. */
  readonly printout: HTMLElement;
  /** The colophon line under the print-out. */
  readonly colophon: HTMLElement;
  /**
   * Mount the live controls of the program, organ (with rotary) and piano regions (plan section
   * 13.6); main.ts calls it once, after the synth panel. A second call replaces the first.
   */
  mountRegions(onTouch: OnTouch): RegionsApi;
  dispose(): void;
}

/** The live controls mountRegions put on screen. */
export interface RegionsApi {
  readonly controls: readonly Bound[];
  dispose(): void;
}

const APPROXIMATION = 'st-4 editor · sound programming · audio is an approximation';
/** Below this width the regions stack in one column (the CSS uses the same breakpoint). */
const NARROW = '(max-width: 759px)';

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
  const program = h('section', { class: 'region region-live region-program', id: 'program', tabindex: -1,
    'aria-label': 'program' });
  const organ = h('section', { class: 'region region-live region-organ', id: 'organ', tabindex: -1,
    'aria-label': 'organ' });
  const piano = h('section', { class: 'region region-live region-piano', id: 'piano', tabindex: -1,
    'aria-label': 'piano' });
  const keyboardLegend = h('p', { class: 'region-legend', id: 'keyboard-legend' }, 'keyboard');
  const keyboard = h('div', { class: 'keyboard-slot' });
  const octaveKey = (label: string, name: string): HTMLButtonElement =>
    h('button', { class: 'bool-key octave-key', type: 'button', 'aria-label': name }, h('span', { 'aria-hidden': 'true' }, label));
  const octaveDown = octaveKey('oct −', 'octave down');
  const octaveUp = octaveKey('oct +', 'octave up');
  const printout = h('div', { class: 'printout-host' });
  const colophon = h('footer', { class: 'panel-foot' });

  const layouts = [
    layoutRegion('extern', [region('extern')], store),
    layoutRegion('layer effects', [region('effects')], store),
  ];
  const [extern, effects] = layouts.map((l) => l.el);

  const legendRow = h('div', { class: 'panel-legend' }, h('span', null, APPROXIMATION), status);
  const displayRow = h('div', { class: 'panel-row row-display' }, display,
    h('section', { class: 'region region-files', 'aria-labelledby': filesLegend },
      h('p', { class: 'region-legend', id: filesLegend }, 'files'), files));
  const halvesTop = h('div', { class: 'panel-row row-halves' });
  const halvesBottom = h('div', { class: 'panel-row row-halves' });
  const keyboardRegion = h('section', { class: 'region region-keyboard', id: 'keyboard', tabindex: -1,
    'aria-labelledby': keyboardLegend.id },
  h('div', { class: 'region-head kb-head' }, keyboardLegend, h('div', { class: 'octave-keys' }, octaveDown, octaveUp)),
  keyboard);
  const panel = h('section', { class: 'panel', 'aria-label': 'editor panel' });
  root.replaceChildren(panel);

  // Wide: the grid rows of the design. Narrow: one column, synth first, program after the piano.
  const arrange = (narrow: boolean): void => {
    const focused = document.activeElement;
    if (narrow) {
      panel.replaceChildren(legendRow, displayRow, synth, organ, piano, program, extern!, effects!, keyboardRegion,
        printout, colophon);
    } else {
      halvesTop.replaceChildren(organ, piano);
      halvesBottom.replaceChildren(extern!, effects!);
      panel.replaceChildren(legendRow, displayRow, program, halvesTop, synth, halvesBottom, keyboardRegion,
        printout, colophon);
    }
    // Moving a node can drop its focus: give it back without scrolling.
    if (focused instanceof HTMLElement && focused !== document.activeElement && panel.contains(focused)) {
      focused.focus({ preventScroll: true });
    }
  };
  const media = typeof window.matchMedia === 'function' ? window.matchMedia(NARROW) : null;
  const onMedia = (ev: MediaQueryListEvent): void => arrange(ev.matches);
  arrange(media?.matches ?? false);
  media?.addEventListener('change', onMedia);

  let regions: RegionsApi | null = null;
  const mountRegions = (onTouch: OnTouch): RegionsApi => {
    regions?.dispose();
    const parts = [
      mountProgramPanel(program, store, onTouch),
      mountOrganPanel(organ, store, onTouch),
      mountPianoPanel(piano, store, onTouch),
    ];
    const api: RegionsApi = {
      controls: parts.flatMap((p) => p.controls),
      dispose(): void {
        for (const p of parts) p.dispose();
        if (regions === api) regions = null;
      },
    };
    regions = api;
    return api;
  };

  return {
    status, display, files, synth, keyboardLegend, keyboard, octaveDown, octaveUp, printout, colophon, mountRegions,
    dispose(): void {
      media?.removeEventListener('change', onMedia);
      regions?.dispose();
      for (const l of layouts) l.dispose();
      root.replaceChildren();
    },
  };
}
