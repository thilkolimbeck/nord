/**
 * The controller strip of the keyboard region (plan sections 15.2 and 15.9): the modulation
 * wheel, a pressure strip (aftertouch) and the control pedal as vertical native range inputs, 0
 * at the bottom, each labelled with its value and keyboard operable. They drive the morphs and the
 * vibrato modes WHL, A.T. and PED as MIDI CC1, channel pressure and CC11 do; the pressure strip
 * springs back to 0 when it is let go (pointer up, key up, blur). A pitch wheel is not added: bend
 * stays MIDI only. On narrow screens the region's `ctrl` key shows the strip in place of the keys.
 */
import { CONTROLLER_KINDS, type ControllerKind, type ScreenControllers } from '../input/controllers.ts';
import { h, listen, uid } from './dom.ts';

/** The strip's captions, in the manual's words (p.38: WHEEL, A.T., CTRLPED). */
export const CONTROLLER_LABELS: Readonly<Record<ControllerKind, string>> = {
  wheel: 'wheel', pressure: 'a.t.', pedal: 'ctrl ped',
};
const CONTROLLER_NAMES: Readonly<Record<ControllerKind, string>> = {
  wheel: 'modulation wheel', pressure: 'aftertouch pressure, springs back when let go', pedal: 'control pedal',
};

export interface ControllerStripApi {
  readonly el: HTMLElement;
  dispose(): void;
}

export function mountControllerStrip(controllers: ScreenControllers): ControllerStripApi {
  const offs: (() => void)[] = [];
  const cells = CONTROLLER_KINDS.map((kind) => {
    const id = uid(`controller-${kind}`);
    const input = h('input', { class: 'fader controller-input', type: 'range', id, min: 0, max: 127, step: 1,
      'aria-label': CONTROLLER_NAMES[kind] });
    const value = h('span', { class: 'drawbar-value', 'aria-hidden': 'true' });
    const el = h('div', { class: 'drawbar controller' }, value, input,
      h('label', { class: 'drawbar-caption', for: id }, h('span', { 'aria-hidden': 'true' }, CONTROLLER_LABELS[kind])));
    const show = (v: number): void => {
      input.value = String(v);
      value.textContent = String(v);
      input.setAttribute('aria-valuetext', String(v));
      input.style.setProperty('--fill', `${(v / 127) * 100}%`);
    };
    offs.push(listen(input, 'input', () => controllers.set(kind, Number(input.value))));
    if (kind === 'pressure') {
      const release = (): void => controllers.release(kind);
      offs.push(listen(input, 'pointerup', release), listen(input, 'pointercancel', release),
        listen(input, 'keyup', release), listen(input, 'blur', release));
    }
    show(controllers.value(kind));
    return { kind, show, el };
  });
  offs.push(controllers.onChange((kind, v) => cells.find((c) => c.kind === kind)?.show(v)));
  const el = h('div', { class: 'controller-strip', role: 'group', 'aria-label': 'performance controllers' },
    ...cells.map((c) => c.el));
  return {
    el,
    dispose(): void {
      for (const off of offs) off();
      el.remove();
    },
  };
}
