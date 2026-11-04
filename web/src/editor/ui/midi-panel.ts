/**
 * The extern · midi region (plan sections 15.4–15.6, 15.9): two groups.
 *
 * - `midi`: the output port picker (or why there is none), the Stage 4's global channel, the
 *   switches `control in` (with its channel), `send to stage 4`, `send notes`, `extern out` and
 *   `echo midi in`, the `send all` key (available only with send to stage 4 on and a port picked)
 *   and the extern channels a, b, c. Nothing is sent until the user switches a sender on; the
 *   senders are off at every page load and never stored; SysEx is never requested or sent.
 * - `extern · layer x`: the 15 extern fields of the focused synth layer (M p.46–47, 63), which
 *   follow the synth focus and the layer scene like the synth region.
 *
 * Port and channels and control in are kept on this device (main persists them through `persist`).
 */
import type { MidiStatus } from '../midi/access.ts';
import type { ControlInSettings } from '../midi/cc-in.ts';
import type { MidiOutApi } from '../midi/output.ts';
import { LAYERS, type Ns4Key, type SynthLayer } from '../model/keys.ts';
import { keysOf, PANEL } from '../model/sections.ts';
import { focusedLayer } from '../model/scene.ts';
import type { ParamStore } from '../model/store.ts';
import type { OnTouch } from './controls.ts';
import { h, listen, uid } from './dom.ts';
import {
  CHANNELS, type Choice, CONTROL_IN_CHANNELS, MIDI_PANEL_LEGEND, MIDI_SWITCHES, NEVER_SENT, portView, sendAllAvailable,
  sendAllText, STAGE4_MIDI_LINE,
} from './midi-model.ts';
import type { RegionPanelApi } from './organ-panel.ts';
import type { PrintoutApi } from './printout.ts';
import { group, sectionKit } from './section-panel.ts';

export interface MidiPanelDeps {
  readonly store: ParamStore;
  readonly onTouch: OnTouch;
  readonly out: MidiOutApi;
  readonly controlIn: { readonly settings: ControlInSettings; update(patch: Partial<ControlInSettings>): void };
  readonly input: { readonly status: MidiStatus; onStatus(fn: (s: MidiStatus) => void): () => void };
  readonly printout: Pick<PrintoutApi, 'print'>;
  /** Keep port, channels and control in on this device (called after each change of them). */
  readonly persist: () => void;
}

/** A labelled native select in the control row style. */
function selectRow(label: string, choices: readonly Choice[], describedBy?: string): { el: HTMLElement; select: HTMLSelectElement } {
  const id = uid(`midi-${label}`);
  const select = h('select', { class: 'enum', id, 'aria-describedby': describedBy });
  select.replaceChildren(...choices.map((c) => h('option', { value: c.value }, c.label)));
  const el = h('div', { class: 'ctl ctl-select' },
    h('span', { class: 'ctl-head' }, h('label', { class: 'ctl-label', for: id }, h('span', { class: 'ctl-label-text' }, label))),
    h('span', { class: 'enum-wrap' }, select), h('span', { class: 'ctl-value', 'aria-hidden': 'true' }));
  return { el, select };
}

/** A labelled switch key with an LED and a description. */
function switchRow(label: string, note: string): { el: HTMLElement; key: HTMLButtonElement } {
  const noteId = uid(`midi-${label}-note`);
  const key = h('button', { class: 'bool-key', type: 'button', 'aria-label': label, 'aria-describedby': noteId,
    'aria-pressed': 'false' }, h('span', { class: 'led', 'aria-hidden': 'true' }));
  const el = h('div', { class: 'ctl ctl-key' },
    h('span', { class: 'ctl-head' }, h('span', { class: 'ctl-label', 'aria-hidden': 'true' },
      h('span', { class: 'ctl-label-text' }, label))),
    key, h('span', { class: 'ctl-value', 'aria-hidden': 'true' }), h('span', { class: 'visually-hidden', id: noteId }, note));
  return { el, key };
}

function fill(select: HTMLSelectElement, choices: readonly Choice[]): void {
  const sig = choices.map((c) => `${c.value}\u0000${c.label}`).join('\u0001');
  if (select.dataset['options'] === sig) return;
  select.replaceChildren(...choices.map((c) => h('option', { value: c.value }, c.label)));
  select.dataset['options'] = sig;
}

export function mountMidiPanel(root: HTMLElement, deps: MidiPanelDeps): RegionPanelApi {
  const { store, out, controlIn, input, printout, persist } = deps;
  const offs: (() => void)[] = [];

  const portNoteId = uid('midi-port-note');
  const port = selectRow('output', [], portNoteId);
  // One line, kept while empty, so a status change moves nothing; a long port name is cut (title whole).
  const portNote = h('p', { class: 'region-note note-line', id: portNoteId, 'aria-live': 'polite' });
  const channel = selectRow('channel', CHANNELS);
  const controlInKey = switchRow('control in',
    'incoming cc and nrpn of manual appendix ii move the editor\'s controls (scaling assumed, nv); kept on this device');
  const controlInChannel = selectRow('control ch', CONTROL_IN_CHANNELS);
  const senders = MIDI_SWITCHES.map((s) => ({ ...s, ...switchRow(s.label, s.note) }));
  const sendAllNoteId = uid('midi-send-all');
  const sendAll = h('button', { class: 'layer-key send-all-key', type: 'button', 'aria-describedby': sendAllNoteId },
    h('span', null, 'send all'));
  const sendAllNote = h('span', { class: 'visually-hidden', id: sendAllNoteId },
    'sends every documented controller of the current program to the stage 4; needs send to stage 4 on and an output');
  const externChannels = LAYERS.map((l) => ({ layer: l, ...selectRow(`extern ${l.toLowerCase()} ch`, CHANNELS) }));
  let sending = false;

  const show = (): void => {
    const s = out.settings;
    const view = portView(out.status, s, input.status);
    fill(port.select, view.options);
    port.select.value = view.value;
    port.select.disabled = view.disabled;
    portNote.textContent = view.note ?? '';
    portNote.title = view.note ?? '';
    channel.select.value = String(s.channel);
    controlInKey.key.setAttribute('aria-pressed', String(controlIn.settings.enabled));
    controlInKey.el.classList.toggle('lit', controlIn.settings.enabled);
    controlInKey.key.classList.toggle('lit', controlIn.settings.enabled);
    controlInChannel.select.value = String(controlIn.settings.channel);
    for (const x of senders) {
      x.key.setAttribute('aria-pressed', String(s[x.field]));
      x.key.classList.toggle('lit', s[x.field]);
    }
    const available = sendAllAvailable(s, out.status) && !sending;
    sendAll.setAttribute('aria-disabled', String(!available));
    for (const e of externChannels) e.select.value = String(s.externChannels[e.layer]);
  };

  offs.push(
    listen(port.select, 'change', () => {
      out.update({ portId: port.select.value === '' ? null : port.select.value });
      persist();
    }),
    listen(channel.select, 'change', () => {
      out.update({ channel: Number(channel.select.value) });
      persist();
    }),
    listen(controlInKey.key, 'click', () => {
      controlIn.update({ enabled: !controlIn.settings.enabled });
      persist();
      show();
    }),
    listen(controlInChannel.select, 'change', () => {
      const v = controlInChannel.select.value;
      controlIn.update({ channel: v === 'all' ? 'all' : Number(v) });
      persist();
    }),
    ...senders.map((x) => listen(x.key, 'click', () => out.update({ [x.field]: !out.settings[x.field] }))),
    ...externChannels.map((e) => listen(e.select, 'change', () => {
      out.update({ externChannels: { ...out.settings.externChannels, [e.layer]: Number(e.select.value) } });
      persist();
    })),
    listen(sendAll, 'click', () => {
      if (sendAll.getAttribute('aria-disabled') === 'true') return;
      sending = true;
      show();
      out.sendAll().then((n) => printout.print([sendAllText(n)], 'result'),
        (err: unknown) => printout.print([`send all stopped: ${err instanceof Error ? err.message : String(err)}`], 'error'))
        .finally(() => {
          sending = false;
          show();
        });
    }),
    out.onStatus(show),
    out.onSettings(show),
    input.onStatus(show),
  );

  const midiGroup = group('midi', 'midi',
    port.el, portNote, channel.el, controlInKey.el, controlInChannel.el, ...senders.map((x) => x.el),
    h('div', { class: 'key-row' }, sendAll, sendAllNote), ...externChannels.map((e) => e.el),
    h('p', { class: 'region-note' }, STAGE4_MIDI_LINE), h('p', { class: 'region-note' }, NEVER_SENT));

  // Extern fields of the focused synth layer.
  const kit = sectionKit('synth', store, deps.onTouch);
  const externRegion = PANEL.find((r) => r.id === 'extern')!;
  const layer = focusedLayer(store, 'synth');
  const externKeys: Ns4Key[] = keysOf(externRegion.groups[0]!, layer);
  const externLegendId = uid('extern-legend');
  const externLegend = h('p', { class: 'group-legend', id: externLegendId });
  const externGroup = h('div', { class: 'synth-group', role: 'group', 'aria-labelledby': externLegendId, 'data-group': 'extern' },
    externLegend, ...externKeys.map((k) => kit.make(k).el));
  kit.onRebind(() => {
    const l: SynthLayer = focusedLayer(store, 'synth');
    externLegend.textContent = `extern · synth ${l.toLowerCase()}`;
  });

  const legendId = uid('midi-legend');
  root.replaceChildren(
    h('p', { class: 'region-head' }, h('span', { class: 'region-legend', id: legendId }, MIDI_PANEL_LEGEND)),
    h('div', { class: 'region-groups midi-groups' }, midiGroup, externGroup));
  root.setAttribute('aria-labelledby', legendId);
  root.removeAttribute('aria-label');
  show();

  return {
    controls: kit.controls,
    dispose(): void {
      for (const off of offs) off();
      offs.length = 0;
      kit.dispose();
      root.replaceChildren();
    },
  };
}
