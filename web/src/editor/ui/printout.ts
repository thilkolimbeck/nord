/**
 * The print-out (paper) under the panel: numbered lines of import notes, validation errors and
 * export results, shown verbatim. Idle: one line "nothing printed yet".
 */
import { h } from './dom.ts';

export type PrintKind = 'notes' | 'error' | 'result';

export interface PrintoutApi {
  /** Replace the lines; error lines start with 'error · '. */
  print(lines: readonly string[], kind: PrintKind): void;
  clear(): void;
}

const IDLE = 'nothing printed yet';

export function mountPrintout(root: HTMLElement): PrintoutApi {
  const legend = h('p', { class: 'legend printout-legend', id: 'printout-legend' }, 'print-out');
  const list = h('ol', { class: 'printout-lines', 'aria-live': 'polite' });
  root.classList.add('printout');
  root.setAttribute('aria-labelledby', legend.id);
  root.replaceChildren(legend, list);

  const render = (lines: readonly string[]): void => {
    list.replaceChildren(...lines.map((text, i) => h('li', null,
      h('span', { class: 'line-no', 'aria-hidden': 'true' }, String(i + 1).padStart(3, '0')),
      h('span', { class: 'line-text' }, text))));
  };
  render([IDLE]);

  return {
    print(lines: readonly string[], kind: PrintKind): void {
      const shown = lines.length === 0 ? [IDLE] : kind === 'error' ? lines.map((l) => `error · ${l}`) : lines;
      legend.textContent = kind === 'error' ? 'print-out · error' : 'print-out';
      render(shown);
    },
    clear(): void {
      legend.textContent = 'print-out';
      render([IDLE]);
    },
  };
}
