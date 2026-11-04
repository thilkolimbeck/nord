/**
 * The file keys in the panel's files box (docs/web-design.md, "Editor", row 1): save, load,
 * app-preset ↓, import, open .ns4p, stage-4-programm (experimentell) ↓, report ↓. `load` opens the
 * list of presets saved in this browser; the two file keys open hidden file inputs. The Stage 4
 * export asks first: its key opens an inline confirmation line that names the file experimental
 * and untested on hardware, and only `confirm ↓` there writes the file (plan section 11, decision
 * 7). On mount the autosaved working copy is restored; every change, name edits included, is
 * autosaved after it settles, and once more when the page is hidden.
 *
 * Plan section 15: each saved preset in the load list has a `delete` key that asks first in an
 * inline line (`delete "<name>"? confirm / cancel`); `embed own samples` next to `app-preset ↓`
 * puts the layers' own sample files into the download; `samples` opens the own samples list
 * (import audio, delete, storage use). The working copy is never offered for deletion.
 */
import type { ParamStore } from '../model/store.ts';
import type { DisplayApi } from './display.ts';
import type { SlotInfo } from '../formats/storage.ts';
import { h, listen, uid } from './dom.ts';
import { InlineConfirm } from './files-model.ts';
import { type FileDeps, FileActions, slotDate } from './files.ts';
import type { OwnSamples } from './own-samples.ts';
import type { PrintoutApi } from './printout.ts';
import { mountSamplesView, type SamplesViewApi } from './samples-view.ts';

export interface FileBarDeps extends Omit<FileDeps, 'store' | 'printout' | 'display'> {
  readonly store: ParamStore;
  readonly printout: Pick<PrintoutApi, 'print'>;
  readonly display?: Pick<DisplayApi, 'setInfo'>;
  /** Restore the autosaved working copy on mount (default true). */
  readonly restore?: boolean;
  /** The own samples on this device (the `samples` key and `embed own samples`); none: both keys are left out. */
  readonly ownSamples?: OwnSamples;
}

export interface FileBarApi {
  readonly actions: FileActions;
  dispose(): void;
}

function key(text: string, label: string, extra: Record<string, string> = {}): HTMLButtonElement {
  return h('button', { class: 'layer-key file-key', type: 'button', 'aria-label': label, ...extra }, text);
}

export function mountFileBar(container: HTMLElement, deps: FileBarDeps): FileBarApi {
  const actions = new FileActions(deps);
  const listId = uid('file-slots');
  const confirmId = uid('file-export-confirm');
  const warningId = uid('file-export-warning');

  const save = key('save', 'save app preset in this browser');
  const load = key('load', 'load an app preset saved in this browser',
    { 'aria-expanded': 'false', 'aria-controls': listId });
  const download = key('app-preset ↓', 'download app-preset (.json)');
  const embedNoteId = uid('file-embed-note');
  const embed = h('button', { class: 'bool-key embed-key', type: 'button', 'aria-pressed': 'false',
    'aria-describedby': embedNoteId }, h('span', { class: 'led', 'aria-hidden': 'true' }), h('span', null, 'embed own samples'));
  const embedNote = h('span', { class: 'visually-hidden', id: embedNoteId },
    'app-preset ↓ then contains the audio files of the layers\' own samples; off at every page load');
  const samplesId = uid('file-samples');
  const samplesKey = key('samples', 'own samples kept in this browser: import, list, delete',
    { 'aria-expanded': 'false', 'aria-controls': samplesId });
  const view: SamplesViewApi | null = deps.ownSamples === undefined ? null : mountSamplesView(deps.ownSamples, deps.printout);
  if (view !== null) view.el.id = samplesId;
  const slotAsk = new InlineConfirm<SlotInfo>((s) => s.name);
  const slotConfirmText = h('span');
  const slotConfirm = h('button', { class: 'text-button', type: 'button' }, 'confirm');
  const slotCancel = h('button', { class: 'text-button', type: 'button' }, 'cancel');
  const slotConfirmLine = h('p', { class: 'region-note file-confirm', hidden: true }, slotConfirmText, ' ', slotConfirm, ' / ',
    slotCancel);
  const importKey = key(`import`, 'import app preset (.json)');
  const open = key('open .ns4p', 'open .ns4p stage 4 program');
  const exportKey = key('stage-4-programm (experimentell) ↓',
    'download stage-4-programm (experimentell) as .ns4p, untested on stage 4 hardware; asks for confirmation',
    { 'aria-expanded': 'false', 'aria-controls': confirmId });
  const report = key('report ↓', 'download parameter report (.txt): for reading only, not a program file');
  const confirm = h('button', { class: 'text-button', type: 'button', 'aria-describedby': warningId,
    'aria-label': 'confirm: download the experimental stage-4-programm' }, 'confirm ↓');
  const cancel = h('button', { class: 'text-button', type: 'button', 'aria-label': 'cancel the stage-4-programm export' },
    'cancel');
  const confirmLine = h('p', { class: 'region-note file-confirm', id: confirmId, hidden: true },
    h('span', { id: warningId }, 'experimental: untested on stage 4 hardware · load into a free slot'),
    ' · ', confirm, ' / ', cancel);
  const presetInput = h('input', { type: 'file', accept: '.json,application/json', hidden: true, tabindex: -1 });
  const ns4pInput = h('input', { type: 'file', accept: '.ns4p', hidden: true, tabindex: -1 });
  const list = h('div', { class: 'readouts file-slots', id: listId, hidden: true });

  const closeSlotConfirm = (): void => {
    slotAsk.cancel();
    slotConfirmLine.hidden = true;
  };

  const showList = (open: boolean): void => {
    load.setAttribute('aria-expanded', String(open));
    list.hidden = !open;
    // A delete confirmation belongs to the list: it closes with it.
    if (!open) {
      closeSlotConfirm();
      return;
    }
    const result = actions.slots();
    if ('error' in result) {
      list.replaceChildren(h('p', { class: 'region-note' }, result.error));
      return;
    }
    if (result.slots.length === 0) {
      list.replaceChildren(h('p', { class: 'region-note' }, 'no app presets saved in this browser yet'));
      return;
    }
    list.replaceChildren(...result.slots.map((slot) => {
      const date = slotDate(slot.savedAt);
      // One line whatever the preset name: cut with an ellipsis, the full name in the title.
      const button = h('button', { class: 'text-button slot-name', type: 'button', 'aria-label': `load ${slot.name}, saved ${date}`,
        title: `${slot.name} · ${date}` }, h('span', null, `${slot.name} · ${date}`));
      button.addEventListener('click', () => {
        actions.loadSlot(slot);
        showList(false);
        load.focus();
      });
      const del = h('button', { class: 'text-button', type: 'button', 'aria-label': `delete ${slot.name}, saved ${date}` },
        'delete');
      del.addEventListener('click', () => {
        const p = slotAsk.ask(slot);
        slotConfirmText.textContent = p.text;
        slotConfirm.setAttribute('aria-label', `confirm: ${p.text}`);
        slotConfirmLine.hidden = false;
        slotConfirm.focus();
      });
      return h('div', { class: 'slot-line' }, button, del);
    }));
  };

  const pick = (input: HTMLInputElement, run: (file: File) => Promise<boolean>) => (): void => {
    const file = input.files?.[0];
    input.value = '';
    if (file !== undefined) void run(file);
  };

  const showConfirm = (open: boolean): void => {
    exportKey.setAttribute('aria-expanded', String(open));
    confirmLine.hidden = !open;
  };

  const onHide = (): void => {
    if (document.visibilityState === 'hidden') actions.autosaveNow();
  };
  const onPageHide = (): void => { actions.autosaveNow(); };

  container.replaceChildren(
    h('div', { class: 'layer-keys file-keys' }, save, load, download, ...(view === null ? [] : [embed, embedNote]), importKey,
      open, exportKey, report, ...(view === null ? [] : [samplesKey])),
    list, slotConfirmLine, confirmLine, ...(view === null ? [] : [view.el]), presetInput, ns4pInput);

  if (deps.restore ?? true) actions.restoreWorkingCopy();

  const offs = [
    listen(save, 'click', () => {
      actions.save();
      if (load.getAttribute('aria-expanded') === 'true') showList(true);
    }),
    listen(load, 'click', () => {
      closeSlotConfirm();
      showList(load.getAttribute('aria-expanded') !== 'true');
    }),
    listen(slotConfirm, 'click', () => {
      const slot = slotAsk.confirm();
      slotConfirmLine.hidden = true;
      if (slot !== null) actions.removeSlot(slot);
      showList(true);
      load.focus();
    }),
    listen(slotCancel, 'click', () => {
      closeSlotConfirm();
      load.focus();
    }),
    listen(download, 'click', () => { void actions.downloadPreset(embed.getAttribute('aria-pressed') === 'true'); }),
    listen(embed, 'click', () => {
      const on = embed.getAttribute('aria-pressed') !== 'true';
      embed.setAttribute('aria-pressed', String(on));
      embed.classList.toggle('lit', on);
    }),
    listen(samplesKey, 'click', () => {
      const open = samplesKey.getAttribute('aria-expanded') !== 'true';
      samplesKey.setAttribute('aria-expanded', String(open));
      view?.show(open);
    }),
    listen(importKey, 'click', () => presetInput.click()),
    listen(open, 'click', () => ns4pInput.click()),
    listen(exportKey, 'click', () => {
      const opening = exportKey.getAttribute('aria-expanded') !== 'true';
      showConfirm(opening);
      if (opening) confirm.focus();
    }),
    listen(confirm, 'click', () => {
      showConfirm(false);
      actions.exportNs4p();
      exportKey.focus();
    }),
    listen(cancel, 'click', () => {
      showConfirm(false);
      exportKey.focus();
    }),
    listen(report, 'click', () => { actions.downloadReport(); }),
    listen(presetInput, 'change', pick(presetInput, (f) => actions.importPreset(f))),
    listen(ns4pInput, 'change', pick(ns4pInput, (f) => actions.openNs4p(f))),
    actions.watchStore(),
  ];
  document.addEventListener('visibilitychange', onHide);
  window.addEventListener('pagehide', onPageHide);

  return {
    actions,
    dispose(): void {
      for (const off of offs) off();
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', onPageHide);
      actions.dispose();
      view?.dispose();
      container.replaceChildren();
    },
  };
}
