/**
 * The keyboard region (docs/web-design.md, "Editor" → "Keyboard region"): a legend line and the
 * virtual keys, rendered into a container the caller owns. Pointer Events go to PointerNotes
 * (pure logic in input/pointer.ts); this file is only the DOM glue. Held keys are lit by the
 * caller through setHeld (for example from input/events.ts HeldNotes), so keys light up for
 * every note source. No inline styles: geometry goes through CSS custom properties (CSSOM).
 */
import './keyboard.css';
import { keyboardAriaLabel, legendText, usLabels, type KeyLabels } from '../input/computer-keys.ts';
import { velocityFromY, type PointerNotes } from '../input/pointer.ts';

export { bindReleaseOnHide } from '../input/hide.ts';

/** C3 (MIDI 48, scientific pitch): the default lowest key at octave 0. */
export const DEFAULT_LOW = 48;
export const DEFAULT_OCTAVES = 3;

const BLACK_IN_OCTAVE: ReadonlySet<number> = new Set([1, 3, 6, 8, 10]);

export interface KeyboardOptions {
  pointer: PointerNotes;
  /** Lowest key at octave 0; a C. Default 48 (C3). */
  low?: number;
  /** Octaves shown; the top C is added. Default 3 (C3–C6). */
  octaves?: number;
  /** Key labels for the legend; default US letters. Update later with setLabels. */
  labels?: KeyLabels;
  /** The computer keys' octave limits, for the accessible label. Default -3 to +3. */
  octaveRange?: { min: number; max: number };
  /** An element the caller owns (the region's legend line) to write the legend into; default: one above the keys. */
  legend?: HTMLElement;
}

export interface KeyboardView {
  /** Lights exactly these notes (notes outside the visible range are ignored). */
  setHeld(notes: Iterable<number>): void;
  /** Shifts the visible keys by whole octaves relative to `low`; follows the computer keys' octave. */
  setOctave(octave: number): void;
  /** Real key labels, for example from computer-keys.ts keyLabels(navigator). */
  setLabels(labels: KeyLabels): void;
  /** Lowest and highest visible note. */
  readonly range: { low: number; high: number };
  /** Releases the pointers, removes listeners and empties the container. */
  dispose(): void;
}

export function mountKeyboard(container: HTMLElement, options: KeyboardOptions): KeyboardView {
  const pointer = options.pointer;
  const baseLow = options.low ?? DEFAULT_LOW;
  const count = 12 * (options.octaves ?? DEFAULT_OCTAVES) + 1;
  const octaveRange = options.octaveRange ?? { min: -3, max: 3 };
  let labels = options.labels ?? usLabels();
  let octave = 0;
  let held: ReadonlySet<number> = new Set();

  const ownLegend = options.legend === undefined;
  const legend = options.legend ?? document.createElement('p');
  if (ownLegend) legend.className = 'legend kb-legend';

  const scroller = document.createElement('div');
  scroller.className = 'kb-scroll';

  const keysEl = document.createElement('div');
  keysEl.className = 'kb-keys';
  keysEl.tabIndex = 0;
  // An application region: screen readers pass letter keys through, so the computer keys play.
  keysEl.setAttribute('role', 'application');
  keysEl.setAttribute('aria-roledescription', 'keyboard');

  const keys: HTMLElement[] = [];
  let whites = 0;
  for (let i = 0; i < count; i++) {
    const key = document.createElement('div');
    const black = BLACK_IN_OCTAVE.has(i % 12);
    key.className = black ? 'kb-key kb-black' : 'kb-key kb-white';
    if (black) key.style.setProperty('--kb-at', String(whites));
    else whites++;
    keys.push(key);
  }
  // White keys first in the DOM, black keys after, so black keys paint on top without z-index games.
  keysEl.append(...keys.filter((k) => k.classList.contains('kb-white')), ...keys.filter((k) => k.classList.contains('kb-black')));
  keysEl.style.setProperty('--kb-whites', String(whites));
  scroller.append(keysEl);
  if (ownLegend) container.replaceChildren(legend, scroller);
  else container.replaceChildren(scroller);

  const low = (): number => baseLow + 12 * octave;

  function render(): void {
    const l = low();
    keys.forEach((key, i) => {
      key.dataset['note'] = String(l + i);
      key.classList.toggle('is-held', held.has(l + i));
    });
    legend.textContent = legendText(labels, l, l + count - 1);
    keysEl.setAttribute('aria-label', keyboardAriaLabel(labels, { current: octave, ...octaveRange }));
  }

  /** On narrow screens the keys scroll: keep the computer keys' octave (one above the lowest C) in view. */
  function revealPlayRange(): void {
    if (scroller.scrollWidth <= scroller.clientWidth) return;
    const c = keys[12];
    if (c !== undefined) scroller.scrollLeft = Math.max(0, c.offsetLeft - 8);
  }

  function keyAt(x: number, y: number): HTMLElement | null {
    const hit = document.elementFromPoint(x, y);
    const key = hit instanceof Element ? hit.closest<HTMLElement>('.kb-key') : null;
    return key !== null && keysEl.contains(key) ? key : null;
  }

  function noteOf(key: HTMLElement): number | null {
    const n = Number(key.dataset['note']);
    return Number.isInteger(n) ? n : null;
  }

  function velocityOn(key: HTMLElement, y: number): number {
    const r = key.getBoundingClientRect();
    return velocityFromY(y, r.top, r.height);
  }

  const onDown = (ev: PointerEvent): void => {
    if (ev.pointerType === 'mouse' && ev.button !== 0) return;
    const key = ev.target instanceof Element ? ev.target.closest<HTMLElement>('.kb-key') : null;
    if (key === null) return;
    const note = noteOf(key);
    if (note === null) return;
    ev.preventDefault(); // no text selection or touch gestures while playing
    try {
      keysEl.setPointerCapture(ev.pointerId);
    } catch {
      // Capture can fail for a pointer that is already gone; the up/cancel handlers still release.
    }
    pointer.down(ev.pointerId, note, velocityOn(key, ev.clientY));
  };
  const onMove = (ev: PointerEvent): void => {
    const key = keyAt(ev.clientX, ev.clientY);
    pointer.move(ev.pointerId, key === null ? null : noteOf(key), key === null ? 64 : velocityOn(key, ev.clientY));
  };
  const onUp = (ev: PointerEvent): void => pointer.up(ev.pointerId);
  const onCancel = (ev: PointerEvent): void => pointer.cancel(ev.pointerId);
  const onContextMenu = (ev: Event): void => ev.preventDefault(); // long press on touch

  keysEl.addEventListener('pointerdown', onDown);
  keysEl.addEventListener('pointermove', onMove);
  keysEl.addEventListener('pointerup', onUp);
  keysEl.addEventListener('pointercancel', onCancel);
  keysEl.addEventListener('lostpointercapture', onUp);
  keysEl.addEventListener('contextmenu', onContextMenu);

  render();
  revealPlayRange();

  return {
    setHeld(notes) {
      held = new Set(notes);
      const l = low();
      keys.forEach((key, i) => key.classList.toggle('is-held', held.has(l + i)));
    },
    setOctave(next) {
      if (!Number.isInteger(next) || next === octave) return;
      octave = next;
      render();
    },
    setLabels(next) {
      labels = next;
      render();
    },
    get range() {
      return { low: low(), high: low() + count - 1 };
    },
    dispose() {
      pointer.releaseAll();
      keysEl.removeEventListener('pointerdown', onDown);
      keysEl.removeEventListener('pointermove', onMove);
      keysEl.removeEventListener('pointerup', onUp);
      keysEl.removeEventListener('pointercancel', onCancel);
      keysEl.removeEventListener('lostpointercapture', onUp);
      keysEl.removeEventListener('contextmenu', onContextMenu);
      container.replaceChildren();
    },
  };
}
