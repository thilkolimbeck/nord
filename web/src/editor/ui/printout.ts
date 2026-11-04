/**
 * The print-out (paper) at the foot of the panel: numbered lines of import notes, validation
 * errors and export results, shown verbatim. Idle: one line "nothing printed yet". Collapsed it
 * shows only its last line; with more than one line a toggle "print-out (n)" opens all of them.
 * A new error opens it by itself. Every print is announced politely in full.
 */
import { h, listen } from './dom.ts';

export type PrintKind = 'notes' | 'error' | 'result';

export interface PrintoutApi {
  /** Replace the lines; error lines start with 'error · '. */
  print(lines: readonly string[], kind: PrintKind): void;
  clear(): void;
}

const IDLE = 'nothing printed yet';

export function mountPrintout(root: HTMLElement): PrintoutApi {
  const legend = h('p', { class: 'legend printout-legend', id: 'printout-legend' }, 'print-out');
  const list = h('ol', { class: 'printout-lines', id: 'printout-lines' });
  const toggle = h('button', { class: 'text-button legend printout-toggle', type: 'button', 'aria-expanded': 'false',
    'aria-controls': list.id, hidden: true });
  const announce = h('p', { class: 'visually-hidden', 'aria-live': 'polite' });
  // Legend and toggle share one cell sized for the widest title, so the lines beside them never
  // shift when the toggle appears or its count grows (up to three digits).
  const sizer = h('span', { class: 'text-button legend', 'data-reserved': true, 'aria-hidden': 'true' },
    'print-out · error (000)');
  const head = h('div', { class: 'printout-head reserve-stack' }, legend, toggle, sizer);
  root.classList.add('printout');
  root.setAttribute('role', 'region');
  root.setAttribute('aria-label', 'print-out');
  root.replaceChildren(head, list, announce);

  let title = 'print-out';
  let count = 1;

  const setOpen = (open: boolean): void => {
    root.classList.toggle('is-open', open);
    toggle.setAttribute('aria-expanded', String(open));
  };

  const render = (lines: readonly string[]): void => {
    count = lines.length;
    list.replaceChildren(...lines.map((text, i) => h('li', null,
      h('span', { class: 'line-no', 'aria-hidden': 'true' }, String(i + 1).padStart(3, '0')),
      h('span', { class: 'line-text' }, text))));
    // One line needs no toggle: the plain legend stands in for it.
    const many = count > 1;
    legend.textContent = title;
    legend.hidden = many;
    toggle.hidden = !many;
    toggle.textContent = `${title} (${count})`;
    if (!many) setOpen(false);
  };
  render([IDLE]);

  // Lives as long as the print-out itself: nothing to remove.
  listen(toggle, 'click', () => setOpen(toggle.getAttribute('aria-expanded') !== 'true'));

  return {
    print(lines: readonly string[], kind: PrintKind): void {
      const shown = lines.length === 0 ? [IDLE] : kind === 'error' ? lines.map((l) => `error · ${l}`) : lines;
      title = kind === 'error' ? 'print-out · error' : 'print-out';
      render(shown);
      if (kind === 'error' && lines.length > 0) setOpen(true);
      announce.textContent = shown.join('\n');
    },
    clear(): void {
      title = 'print-out';
      render([IDLE]);
      announce.textContent = '';
    },
  };
}
