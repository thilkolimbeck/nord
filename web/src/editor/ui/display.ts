/**
 * The display (docs/web-design.md, editor row 1): line 1 the program name, editable in a plain
 * text input; line 2 the last touched parameter 'layer · label · value unit · min–max'; line 3 its
 * status and the number of edited fields since the last load, or an import note.
 */
import { descriptorOf } from '../model/descriptors.ts';
import { NS4_KEYS, type Ns4Key } from '../model/keys.ts';
import type { ParamStore } from '../model/store.ts';
import { displayParamLine, displayStateLine } from './control-model.ts';
import { h, listen } from './dom.ts';

export interface DisplayApi {
  /** Show a parameter on line 2 (call it when a control is touched). */
  show(key: Ns4Key): void;
  /** Put a note on line 3 (import info); null returns to the status line. Cleared by the next touch. */
  setInfo(text: string | null): void;
  dispose(): void;
}

export function mountDisplay(root: HTMLElement, store: ParamStore): DisplayApi {
  const name = h('input', {
    class: 'display-name', type: 'text', id: 'program-name', 'aria-label': 'program name', autocomplete: 'off',
    spellcheck: 'false', maxlength: 64,
  });
  const param = h('p', { class: 'display-line display-param' }, '—');
  const state = h('p', { class: 'display-line display-state', 'aria-live': 'polite' });
  root.replaceChildren(h('div', { class: 'display', role: 'group', 'aria-label': 'display' }, name, param, state));

  let touched: Ns4Key | null = null;
  let info: string | null = null;
  let baseline = store.snapshot().values;
  const edited = new Set<Ns4Key>();

  const render = (): void => {
    const d = touched === null ? null : descriptorOf(touched);
    param.textContent = d === null ? '—' : displayParamLine(d, store.get(d.key), store);
    state.textContent = info ?? displayStateLine(d, d === null ? 0 : store.get(d.key), store, edited.size);
    // Each line stays one line (cut with an ellipsis); the title keeps the whole text.
    param.title = param.textContent;
    state.title = state.textContent;
  };

  const offs = [
    listen(name, 'input', () => store.setName(name.value)),
    store.onChange((batch) => {
      if (batch.some((c) => c.origin === 'load' || c.origin === 'init')) {
        baseline = store.snapshot().values;
        edited.clear();
        name.value = store.meta.name;
      } else {
        for (const c of batch) {
          if (c.value === baseline[c.key]) edited.delete(c.key);
          else edited.add(c.key);
        }
      }
      render();
    }),
  ];
  name.value = store.meta.name;
  for (const key of NS4_KEYS) if (store.get(key) !== baseline[key]) edited.add(key);
  render();

  return {
    show(key: Ns4Key): void {
      touched = key;
      info = null;
      render();
    },
    setInfo(text: string | null): void {
      info = text;
      render();
    },
    dispose(): void {
      for (const off of offs) off();
    },
  };
}
