/**
 * The own samples list in the files box (plan sections 15.3 and 15.9): the audio data, apart from
 * the sample-based parameters a synth layer edits in its oscillator group. `import audio` opens a
 * file picker (whatever the browser decodes: wav, aiff, mp3, ogg, flac); one line per sample on
 * this device with its length and size and a `delete` key that asks first in an inline line; a
 * total line with the storage use and the promise that nothing leaves this browser.
 */
import { SAMPLE_ACCEPT, type SampleMeta } from '../formats/samples-db.ts';
import { h, listen, uid } from './dom.ts';
import { InlineConfirm } from './files-model.ts';
import { type OwnSamples, sampleLine, usageLine } from './own-samples.ts';
import type { PrintoutApi } from './printout.ts';

export interface SamplesViewApi {
  readonly el: HTMLElement;
  /** Show or hide the list (the files box's `samples` key). */
  show(open: boolean): void;
  dispose(): void;
}

export function mountSamplesView(samples: OwnSamples, printout: Pick<PrintoutApi, 'print'>): SamplesViewApi {
  const id = uid('own-samples');
  const input = h('input', { type: 'file', accept: SAMPLE_ACCEPT, multiple: true, hidden: true, tabindex: -1 });
  const importKey = h('button', { class: 'layer-key file-key', type: 'button',
    'aria-label': 'import audio files as own samples, kept only in this browser' }, 'import audio');
  const lines = h('div', { class: 'readouts sample-lines' });
  const total = h('p', { class: 'region-note sample-total', 'aria-live': 'polite' });
  const confirmText = h('span');
  const confirmKey = h('button', { class: 'text-button', type: 'button' }, 'confirm');
  const cancelKey = h('button', { class: 'text-button', type: 'button' }, 'cancel');
  const confirmLine = h('p', { class: 'region-note file-confirm', hidden: true }, confirmText, ' ', confirmKey, ' / ', cancelKey);
  const el = h('div', { class: 'own-samples', id, hidden: true, role: 'group', 'aria-label': 'own samples' },
    h('div', { class: 'layer-keys' }, importKey), lines, confirmLine, total, input);
  const ask = new InlineConfirm<SampleMeta>((m) => m.name);
  let returnTo: HTMLElement | null = null;
  const offs: (() => void)[] = [];

  const render = (): void => {
    const state = samples.state;
    if (state.kind === 'unavailable') {
      lines.replaceChildren(h('p', { class: 'region-note' }, state.message));
      total.textContent = '';
      importKey.setAttribute('aria-disabled', 'true');
      return;
    }
    importKey.removeAttribute('aria-disabled');
    if (state.kind !== 'ready') {
      lines.replaceChildren(h('p', { class: 'region-note' }, 'opening the sample storage of this browser…'));
      return;
    }
    lines.replaceChildren(...(samples.list.length === 0
      ? [h('p', { class: 'region-note' }, 'no own samples in this browser yet')]
      : samples.list.map((m) => {
        const users = samples.usersOf(m.hash).map((l) => l.toLowerCase());
        const del = h('button', { class: 'text-button', type: 'button', 'aria-label': `delete ${m.name}` }, 'delete');
        del.addEventListener('click', () => {
          const p = ask.ask(m);
          returnTo = del;
          confirmText.textContent = users.length === 0 ? p.text : `${p.text} layer ${users.join(', ')} will be silent ·`;
          confirmLine.hidden = false;
          confirmKey.focus();
        });
        const line = sampleLine(m) + (users.length > 0 ? ` · layer ${users.join(', ')}` : '');
        // One line whatever the file name: cut with an ellipsis, the full line in the title.
        return h('div', { class: 'readout sample-line' }, h('span', { class: 'readout-label', title: line }, line), del);
      })));
    const u = samples.usage;
    total.textContent = usageLine(u ?? { count: samples.list.length, bytes: samples.list.reduce((n, m) => n + m.bytes, 0) });
  };

  offs.push(
    samples.onChange(render),
    listen(importKey, 'click', () => {
      if (importKey.getAttribute('aria-disabled') === 'true') return;
      input.click();
    }),
    listen(input, 'change', () => {
      const files = [...(input.files ?? [])];
      input.value = '';
      void (async () => {
        for (const f of files) {
          const r = await samples.import(f);
          printout.print([r.message], r.ok ? 'result' : 'error');
        }
      })();
    }),
    listen(confirmKey, 'click', () => {
      const m = ask.confirm();
      confirmLine.hidden = true;
      importKey.focus();
      if (m !== null) void samples.remove(m.hash).then((r) => printout.print([r.message], r.ok ? 'result' : 'error'));
    }),
    listen(cancelKey, 'click', () => {
      ask.cancel();
      confirmLine.hidden = true;
      (returnTo ?? importKey).focus();
    }),
  );
  render();

  return {
    el,
    show(open: boolean): void {
      el.hidden = !open;
      if (open) void samples.open();
      if (!open) {
        ask.cancel();
        confirmLine.hidden = true;
      }
    },
    dispose(): void {
      for (const off of offs) off();
      el.remove();
    },
  };
}
