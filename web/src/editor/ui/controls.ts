/**
 * Control primitives bound to the store (docs/web-design.md, "Controls"): fader, enum select,
 * switch key, layer mask and read-only readout. Each has a visible label, the value with its unit,
 * the range and status notes in the description (aria-describedby), the status markers
 * ('nv', 'coarse', 'no sound in MVP') and a read-only morph dot. rebind(key) moves a control to the
 * same field of another layer; dispose() removes listeners and subscriptions.
 */
import { setOscBank } from '../model/actions.ts';
import { clampValue, descriptorOf, type EnumOption, optionsFor, type ParamDescriptor } from '../model/descriptors.ts';
import { type Ns4Key, patternOf } from '../model/keys.ts';
import type { ParamStore } from '../model/store.ts';
import {
  controlKind, descriptionText, isCoarse, isOffOn, morphAmounts, morphLabel, optionText, STORED_LINE, valueView,
} from './control-model.ts';
import { h, listen, uid } from './dom.ts';

export interface Bound {
  readonly el: HTMLElement;
  readonly key: Ns4Key;
  /** Show the same control for another field of the same pattern (the focused layer's). */
  rebind(key: Ns4Key): void;
  /** Mark or unmark the value as coarsely approximated (the audio engine knows when). */
  setCoarse(on: boolean): void;
  dispose(): void;
}

export type OnTouch = (key: Ns4Key) => void;

/** Writes that change more than one field go through the model's actions. */
function write(store: ParamStore, d: ParamDescriptor, value: number): void {
  if (patternOf(d.key) === 'synth{L}Sound.oscBank' && d.layer !== null) setOscBank(store, d.layer, value);
  else store.set(d.key, value, 'ui');
}

/** The control for a field, drawn by its kind (controlKind). */
export function control(initial: ParamDescriptor, store: ParamStore, onTouch: OnTouch): Bound {
  let d = initial;
  let coarse = isCoarse(d);
  const kind = controlKind(d);
  const base = uid(`ctl-${patternOf(d.key)}`);
  const ids = { label: `${base}-label`, input: `${base}-input`, desc: `${base}-desc`, value: `${base}-value`, stored: `${base}-stored` };

  const labelText = h('span', { class: 'ctl-label-text' }, d.label);
  const dot = h('span', { class: 'morph-dot', role: 'img', hidden: true });
  const label = kind === 'fader' || kind === 'select'
    ? h('label', { class: 'ctl-label', id: ids.label, for: ids.input }, labelText, dot)
    : h('span', { class: 'ctl-label', id: ids.label }, labelText, dot);
  const valueText = h('span', { class: 'ctl-text' });
  const suffix = h('span', { class: 'ctl-suffix' });
  const valueCell = h('span', { class: 'ctl-value', id: ids.value }, valueText, suffix);
  const desc = h('span', { class: 'visually-hidden', id: ids.desc });
  const storedLine = h('span', { class: 'ctl-stored', id: ids.stored, hidden: true }, STORED_LINE);
  const row = h('div', { class: `ctl ctl-${kind}`, 'data-key': d.key });

  const offs: (() => void)[] = [];
  let subs: (() => void)[] = [];
  const describedBy = (): string => (d.status === 'stored' ? `${ids.desc} ${ids.stored}` : ids.desc);

  // Kind-specific parts: the element that takes input and how it shows the value.
  let middle: HTMLElement;
  let show: (value: number) => void;

  if (kind === 'fader') {
    const input = h('input', { class: 'fader', type: 'range', id: ids.input, step: 1 });
    offs.push(listen(input, 'input', () => {
      store.set(d.key, Number(input.value), 'ui');
      onTouch(d.key);
    }));
    middle = input;
    show = (value) => {
      input.min = String(d.min);
      input.max = String(d.max);
      input.value = String(value);
      const v = valueView(d, value, store, coarse);
      input.setAttribute('aria-valuetext', [v.text, ...v.suffixes].join(' '));
      input.setAttribute('aria-describedby', describedBy());
      const span = d.max - d.min;
      input.style.setProperty('--fill', `${span === 0 ? 0 : ((value - d.min) / span) * 100}%`);
    };
    valueCell.setAttribute('aria-hidden', 'true');
  } else if (kind === 'select') {
    const select = h('select', { class: 'enum', id: ids.input });
    offs.push(listen(select, 'change', () => {
      write(store, d, Number(select.value));
      onTouch(d.key);
    }));
    middle = h('span', { class: 'enum-wrap' }, select);
    show = (value) => {
      const options: EnumOption[] = [...optionsFor(d, store)];
      if (!options.some((o) => o.value === value)) {
        options.push({ value, label: valueView(d, value, store).text, status: 'unverified' });
        options.sort((a, b) => a.value - b.value);
      }
      const texts = options.map((o) => `${o.value}\u0000${optionText(o)}`).join('\u0001');
      if (select.dataset['options'] !== texts) {
        select.replaceChildren(...options.map((o) => h('option', { value: o.value }, optionText(o))));
        select.dataset['options'] = texts;
      }
      select.value = String(value);
      select.setAttribute('aria-describedby', describedBy());
    };
    // The select shows the value; the value cell carries only the markers.
    valueText.hidden = true;
    valueCell.setAttribute('aria-hidden', 'true');
  } else if (kind === 'key') {
    const led = h('span', { class: 'led', 'aria-hidden': 'true' });
    const key = h('button', { class: 'bool-key', type: 'button', id: ids.input }, led);
    offs.push(listen(key, 'click', () => {
      const now = store.get(d.key);
      store.set(d.key, now === d.max ? d.min : d.max, 'ui');
      onTouch(d.key);
    }));
    middle = key;
    show = (value) => {
      const on = value !== d.min;
      key.setAttribute('aria-pressed', String(on));
      key.classList.toggle('lit', on);
      // With labels other than off/on (include/exclude) the value is part of the name.
      key.setAttribute('aria-labelledby', isOffOn(d) ? ids.label : `${ids.label} ${ids.value}`);
      key.setAttribute('aria-describedby', describedBy());
    };
  } else if (kind === 'mask') {
    const group = h('span', { class: 'mask', role: 'group', 'aria-labelledby': ids.label });
    const keys = (d.options ?? []).map((o) => {
      const led = h('span', { class: 'led', 'aria-hidden': 'true' });
      const key = h('button', { class: 'bool-key', type: 'button' }, led, h('span', null, o.label.toLowerCase()));
      offs.push(listen(key, 'click', () => {
        store.set(d.key, store.get(d.key) ^ o.value, 'ui');
        onTouch(d.key);
      }));
      group.append(key);
      return [o.value, key] as const;
    });
    middle = group;
    show = (value) => {
      for (const [bit, key] of keys) {
        key.setAttribute('aria-pressed', String((value & bit) !== 0));
        key.classList.toggle('lit', (value & bit) !== 0);
        key.setAttribute('aria-describedby', describedBy());
      }
    };
    valueCell.setAttribute('aria-hidden', 'true');
  } else {
    middle = h('span', { class: 'readout-fill' });
    show = () => undefined;
  }

  row.append(label, middle, valueCell, desc, storedLine);

  function refresh(): void {
    const value = store.get(d.key);
    const v = valueView(d, value, store, coarse);
    show(value);
    valueText.textContent = v.text;
    suffix.textContent = v.suffixes.join(' ');
    row.toggleAttribute('data-nv', v.nv);
    row.dataset['status'] = d.status;
    storedLine.hidden = !v.stored;
    desc.textContent = descriptionText(d, value, store, coarse);
    const name = morphLabel(morphAmounts(d, store, descriptorOf));
    dot.hidden = name === null;
    if (name === null) dot.removeAttribute('aria-label');
    else dot.setAttribute('aria-label', name);
  }

  function bind(): void {
    for (const off of subs) off();
    const keys: Ns4Key[] = [d.key, ...d.deps, ...(d.morphs === null ? [] : [d.morphs.wheel, d.morphs.afterTouch, d.morphs.ctrlPedal])];
    subs = keys.map((k) => store.subscribe(k, refresh));
    row.dataset['key'] = d.key;
    refresh();
  }

  bind();

  return {
    el: row,
    get key() { return d.key; },
    rebind(key: Ns4Key): void {
      if (key === d.key) return;
      const next = descriptorOf(key);
      if (patternOf(next.key) !== patternOf(d.key)) throw new Error(`${key} is not a ${patternOf(d.key)} field`);
      d = next;
      bind();
    },
    setCoarse(on: boolean): void {
      if (on === coarse) return;
      coarse = on;
      refresh();
    },
    dispose(): void {
      for (const off of [...offs, ...subs]) off();
      offs.length = 0;
      subs = [];
      row.remove();
    },
  };
}

/** A read-only readout line (layout-only regions): label and formatted value, not focusable. */
export function readout(key: Ns4Key, store: ParamStore): { el: HTMLElement; refresh(): void } {
  const d = descriptorOf(key);
  const text = h('span', { class: 'readout-value' });
  const el = h('div', { class: 'readout', 'data-key': key }, h('span', { class: 'readout-label' }, d.label), text);
  const refresh = (): void => {
    const v = valueView(d, clampValue(d, store.get(key)), store, false);
    text.textContent = v.nv ? `${v.text} nv` : v.text;
  };
  refresh();
  return { el, refresh };
}
