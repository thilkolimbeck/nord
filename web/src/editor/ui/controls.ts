/**
 * Control primitives bound to the store (docs/web-design.md, "Controls"): fader, enum select,
 * switch key, layer mask and read-only readout, plus the organ drawbar (a vertical fader) and the
 * piano model select. Each has a visible label, the value with its unit, the range and status
 * notes in the description (aria-describedby), the status markers ('nv', 'coarse', '≈',
 * 'no sound in MVP') and a read-only morph dot. rebind(key) moves a control to the same field of
 * another layer or scene; dispose() removes listeners and subscriptions.
 */
import { setPianoModel } from '../model/actions.ts';
import { clampValue, descriptorOf, type EnumOption, optionsFor, type ParamDescriptor } from '../model/descriptors.ts';
import { type Ns4Key, patternOf } from '../model/keys.ts';
import type { ParamStore } from '../model/store.ts';
import {
  APPROX_PIANO, controlKind, controlPattern, descriptionText, isCoarse, isOffOn, morphAmounts, morphLabel, optionText, sectionLayerOf,
  shownDeps, shownValue, STORED_LINE, valueView, writeControl,
} from './control-model.ts';
import { h, listen, uid } from './dom.ts';
import { MODEL_GROUPS, modelChoice } from './region-model.ts';

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
      writeControl(store, d, Number(select.value));
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
      const now = shownValue(d, store);
      writeControl(store, d, now === d.max ? d.min : d.max);
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
    const value = shownValue(d, store);
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
    const keys: Ns4Key[] = [...watched(d), ...shownDeps(d)];
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
      if (controlPattern(next.key) !== controlPattern(d.key)) throw new Error(`${key} is not a ${controlPattern(d.key)} field`);
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

/** The keys a control listens to: its own, its label dependencies and its morph amounts. */
function watched(d: ParamDescriptor): Ns4Key[] {
  return [d.key, ...d.deps, ...(d.morphs === null ? [] : [d.morphs.wheel, d.morphs.afterTouch, d.morphs.ctrlPedal])];
}

export interface DrawbarBound extends Bound {
  /** Change the caption under the drawbar and its accessible name (the organ model decides them). */
  setCaption(short: string, name: string, used: boolean): void;
}

/**
 * An organ drawbar (docs/web-design.md, organ): the value 0–8 above, a native range input drawn
 * vertically with 0 at the top and 8 at the bottom as on a real drawbar, the caption under it.
 */
export function drawbar(initial: ParamDescriptor, store: ParamStore, onTouch: OnTouch): DrawbarBound {
  let d = initial;
  const base = uid(`bar-${controlPattern(d.key)}`);
  const ids = { input: `${base}-input`, caption: `${base}-caption`, desc: `${base}-desc` };
  const valueText = h('span', { class: 'drawbar-text' });
  const suffix = h('span', { class: 'ctl-suffix' });
  const dot = h('span', { class: 'morph-dot', role: 'img', hidden: true });
  const value = h('span', { class: 'drawbar-value', 'aria-hidden': 'true' }, valueText, suffix, dot);
  const input = h('input', { class: 'fader drawbar-input', type: 'range', id: ids.input, step: 1,
    'aria-labelledby': ids.caption, 'aria-describedby': ids.desc });
  const captionShort = h('span', { 'aria-hidden': 'true' });
  const captionName = h('span', { class: 'visually-hidden' });
  const caption = h('label', { class: 'drawbar-caption', id: ids.caption, for: ids.input }, captionShort, captionName);
  const desc = h('span', { class: 'visually-hidden', id: ids.desc });
  const el = h('div', { class: 'drawbar', 'data-key': d.key }, value, input, caption, desc);
  let subs: (() => void)[] = [];
  const off = listen(input, 'input', () => {
    store.set(d.key, Number(input.value), 'ui');
    onTouch(d.key);
  });

  function refresh(): void {
    const v = store.get(d.key);
    const view = valueView(d, v, store, false);
    input.min = String(d.min);
    input.max = String(d.max);
    input.value = String(v);
    input.setAttribute('aria-valuetext', [view.text, ...view.suffixes].join(' '));
    input.style.setProperty('--fill', `${d.max === d.min ? 0 : ((v - d.min) / (d.max - d.min)) * 100}%`);
    valueText.textContent = view.text;
    suffix.textContent = view.suffixes.join(' ');
    el.toggleAttribute('data-nv', view.nv);
    desc.textContent = descriptionText(d, v, store, false);
    const name = morphLabel(morphAmounts(d, store, descriptorOf));
    dot.hidden = name === null;
    if (name === null) dot.removeAttribute('aria-label');
    else dot.setAttribute('aria-label', name);
  }

  function bind(): void {
    for (const u of subs) u();
    subs = watched(d).map((k) => store.subscribe(k, refresh));
    el.dataset['key'] = d.key;
    refresh();
  }
  bind();

  return {
    el,
    get key() { return d.key; },
    rebind(key: Ns4Key): void {
      if (key === d.key) return;
      const next = descriptorOf(key);
      if (controlPattern(next.key) !== controlPattern(d.key)) throw new Error(`${key} is not a ${controlPattern(d.key)} field`);
      d = next;
      bind();
    },
    setCoarse(): void {},
    setCaption(short: string, name: string, used: boolean): void {
      captionShort.textContent = short;
      captionName.textContent = name;
      el.classList.toggle('drawbar-unused', !used);
    },
    dispose(): void {
      off();
      for (const u of subs) u();
      subs = [];
      el.remove();
    },
  };
}

/**
 * The piano model select (docs/web-design.md, piano): the 295 known models grouped by type, each
 * with the suffix ' · approximation'; a stored hash the catalogue does not know gets its own first
 * option. A choice writes the hash, the type and the slot (setPianoModel).
 */
export function pianoModelSelect(initial: ParamDescriptor, store: ParamStore, onTouch: OnTouch): Bound {
  let d = initial;
  const base = uid(`ctl-${controlPattern(d.key)}`);
  const ids = { label: `${base}-label`, input: `${base}-input`, desc: `${base}-desc` };
  const dot = h('span', { class: 'morph-dot', role: 'img', hidden: true });
  const label = h('label', { class: 'ctl-label', id: ids.label, for: ids.input },
    h('span', { class: 'ctl-label-text' }, d.label), dot);
  const select = h('select', { class: 'enum', id: ids.input, 'aria-describedby': ids.desc });
  const unknown = h('option', { value: '' });
  select.append(unknown, ...MODEL_GROUPS.map((g) => h('optgroup', { label: g.label },
    ...g.options.map((o) => h('option', { value: o.value }, o.text)))));
  const suffix = h('span', { class: 'ctl-suffix' });
  const valueCell = h('span', { class: 'ctl-value', 'aria-hidden': 'true' }, suffix);
  const desc = h('span', { class: 'visually-hidden', id: ids.desc });
  const row = h('div', { class: 'ctl ctl-select ctl-model', 'data-key': d.key },
    label, h('span', { class: 'enum-wrap' }, select), valueCell, desc);
  let subs: (() => void)[] = [];
  const off = listen(select, 'change', () => {
    if (select.value === '') return;
    const own = sectionLayerOf(d.key);
    if (own !== null) setPianoModel(store, own.layer, Number(select.value));
    onTouch(d.key);
  });

  const bankKey = (): Ns4Key => d.key.replace('.nameHash', '.bank') as Ns4Key;
  const MODEL_COUNT = MODEL_GROUPS.reduce((n, g) => n + g.options.length, 0);

  function refresh(): void {
    const hash = store.get(d.key);
    const choice = modelChoice(hash, store.get(bankKey()));
    unknown.hidden = choice.playsModel;
    unknown.disabled = choice.playsModel;
    unknown.textContent = choice.playsModel ? '' : choice.text;
    select.value = choice.playsModel ? String(hash) : '';
    const view = valueView(d, hash, store, false);
    suffix.textContent = view.suffixes.filter((x) => x !== 'nv').join(' ');
    desc.textContent = `${MODEL_COUNT} piano models, grouped by type. ${APPROX_PIANO}`;
  }

  function bind(): void {
    for (const u of subs) u();
    subs = [d.key, bankKey()].map((k) => store.subscribe(k, refresh));
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
      if (controlPattern(next.key) !== controlPattern(d.key)) throw new Error(`${key} is not a ${controlPattern(d.key)} field`);
      d = next;
      bind();
    },
    setCoarse(): void {},
    dispose(): void {
      off();
      for (const u of subs) u();
      subs = [];
      row.remove();
    },
  };
}
