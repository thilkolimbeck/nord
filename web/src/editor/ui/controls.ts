/**
 * Control primitives bound to the store (docs/web-design.md, "Controls"): fader, enum select,
 * switch key, layer mask and read-only readout, plus the organ drawbar (a vertical fader) and the
 * piano model select. Each has a visible label, the value with its unit, the range and status
 * notes in the description (aria-describedby), the status markers ('nv', 'coarse', '≈', the
 * stored line such as 'stored setting, no sound') and, for a field with morph amounts, a small
 * `m` disclosure key whose LED lights while an amount is set; open, it shows the three amounts
 * (wheel, a.t., ctrl ped) as signed faders with the value each source reaches (plan 15.9).
 * rebind(key) moves a control to the same field of another layer, scene or effects block;
 * dispose() removes listeners and subscriptions.
 */
import { setPianoModel } from '../model/actions.ts';
import { clampValue, descriptorOf, type EnumOption, optionsFor, type ParamDescriptor } from '../model/descriptors.ts';
import { type Ns4Key, patternOf } from '../model/keys.ts';
import type { ParamStore } from '../model/store.ts';
import { MORPH_NOTE } from '../model/curated.ts';
import {
  APPROX_PIANO, controlKind, controlPattern, descriptionText, isCoarse, isOffOn, morphAmountChars, morphKeyLabel, morphRows,
  optionText, sectionLayerOf, shownDeps, shownValue, spokenValue, storedLine as storedText, valueReserve, valueView,
  writeControl,
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
  const label = kind === 'fader' || kind === 'select'
    ? h('label', { class: 'ctl-label', id: ids.label, for: ids.input }, labelText)
    : h('span', { class: 'ctl-label', id: ids.label }, labelText);
  const morph = d.morphs === null || kind === 'readout' ? null : morphEditor(() => d, store, onTouch);
  const head = h('span', { class: 'ctl-head' }, label, morph?.key ?? null);
  const valueText = h('span', { class: 'ctl-text' });
  const suffix = h('span', { class: 'ctl-suffix' });
  const valueCell = h('span', { class: 'ctl-value', id: ids.value }, valueText, suffix);
  const desc = h('span', { class: 'visually-hidden', id: ids.desc });
  const storedLine = h('span', { class: 'ctl-stored', id: ids.stored, hidden: true }, storedText(d));
  const row = h('div', { class: `ctl ctl-${kind}`, 'data-key': d.key });
  // The value cell keeps the width of the longest value and markers the field can show, so the
  // row and the fader beside it never move while the value changes (rebind keeps the pattern).
  reserveValue(row, valueReserve(d));

  const offs: (() => void)[] = [];
  let subs: (() => void)[] = [];
  const describedBy = (): string => (d.status === 'stored' ? `${ids.desc} ${ids.stored}` : ids.desc);

  // Kind-specific parts: the element that takes input and how it shows the value.
  let middle: HTMLElement;
  let show: (value: number) => void;

  if (kind === 'fader') {
    const input = h('input', { class: 'fader', type: 'range', id: ids.input, step: 1 });
    offs.push(listen(input, 'input', () => {
      writeControl(store, d, Number(input.value));
      onTouch(d.key);
    }));
    middle = input;
    show = (value) => {
      input.min = String(d.min);
      input.max = String(d.max);
      input.value = String(value);
      input.setAttribute('aria-valuetext', spokenValue(d, value, store, coarse));
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

  row.append(head, middle, valueCell, desc, storedLine);
  if (morph !== null) row.append(morph.panel);

  function refresh(): void {
    const value = shownValue(d, store);
    const v = valueView(d, value, store, coarse);
    show(value);
    valueText.textContent = v.text;
    suffix.textContent = v.suffixes.join(' ');
    row.toggleAttribute('data-nv', v.nv);
    row.dataset['status'] = d.status;
    storedLine.hidden = !v.stored;
    storedLine.textContent = storedText(d);
    desc.textContent = descriptionText(d, value, store, coarse);
    morph?.refresh();
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
      morph?.dispose();
      row.remove();
    },
  };
}

/** The morph disclosure of a control: the `m` key (after the label) and the panel it opens. */
export interface MorphEditor {
  readonly key: HTMLButtonElement;
  readonly panel: HTMLElement;
  /** Re-read the amounts and end values (the control calls it on every refresh). */
  refresh(): void;
  dispose(): void;
}

/**
 * The morph editor of the field `current()` names (plan 15.9): three rows wheel, a.t., ctrl ped,
 * each a signed fader for the amount (0 in the middle) and the value that source reaches at full
 * travel ('→ 4.8 kHz'), all not verified. A move writes the amount (a synth or effects group
 * writes every layer) and touches it, so the display shows start → end.
 */
export function morphEditor(current: () => ParamDescriptor, store: ParamStore, onTouch: OnTouch): MorphEditor {
  const base = uid(`morph-${controlPattern(current().key)}`);
  const noteId = `${base}-note`;
  const led = h('span', { class: 'led', 'aria-hidden': 'true' });
  const key = h('button', { class: 'bool-key morph-key', type: 'button', 'aria-expanded': 'false', 'aria-controls': base },
    led, h('span', { 'aria-hidden': 'true' }, 'm'));
  const note = h('span', { class: 'visually-hidden', id: noteId }, `not verified: ${MORPH_NOTE}`);
  const offs: (() => void)[] = [];
  const rows = morphRows(current(), store).map((r) => {
    const inputId = `${base}-${r.source}`;
    const input = h('input', { class: 'fader fader-signed', type: 'range', id: inputId, step: 1,
      'aria-describedby': noteId });
    const amount = h('span', { class: 'ctl-text' });
    const end = h('span', { class: 'morph-end' });
    const el = h('div', { class: 'ctl ctl-fader morph-row', 'data-nv': true },
      h('span', { class: 'ctl-head' }, h('label', { class: 'ctl-label', for: inputId },
        h('span', { class: 'ctl-label-text' }, r.label))),
      input, h('span', { class: 'ctl-value', 'aria-hidden': 'true' }, amount, h('span', { class: 'ctl-suffix' }, 'nv')), end);
    offs.push(listen(input, 'input', () => {
      const row = morphRows(current(), store).find((x) => x.source === r.source)!;
      writeControl(store, descriptorOf(row.key), Number(input.value));
      onTouch(row.key);
    }));
    return { source: r.source, input, amount, end, el };
  });
  const panel = h('div', { class: 'morph-panel', id: base, role: 'group', hidden: true },
    note, ...rows.map((r) => r.el));
  offs.push(listen(key, 'click', () => {
    const open = key.getAttribute('aria-expanded') !== 'true';
    key.setAttribute('aria-expanded', String(open));
    panel.hidden = !open;
  }));

  const refresh = (): void => {
    const d = current();
    const name = morphKeyLabel(d, store);
    key.setAttribute('aria-label', `${d.label} ${name}`);
    panel.setAttribute('aria-label', `${d.label} morph amounts`);
    const view = morphRows(d, store);
    key.classList.toggle('lit', view.some((r) => r.amount !== 0));
    for (const r of rows) {
      const v = view.find((x) => x.source === r.source)!;
      r.input.min = String(v.min);
      r.input.max = String(v.max);
      r.input.value = String(v.amount);
      r.input.setAttribute('aria-valuetext', `${v.amountText}, to ${v.endSpoken}, not verified`);
      reserveValue(r.el, { text: morphAmountChars(v.min, v.max), marks: 'nv'.length });
      const span = v.max - v.min;
      const at = span === 0 ? 50 : ((v.amount - v.min) / span) * 100;
      const zero = span === 0 ? 50 : ((0 - v.min) / span) * 100;
      r.input.style.setProperty('--lo', `${Math.min(at, zero)}%`);
      r.input.style.setProperty('--hi', `${Math.max(at, zero)}%`);
      r.amount.textContent = v.amountText;
      r.end.textContent = v.endText;
      r.end.title = v.endText;
    }
  };
  refresh();
  return {
    key, panel, refresh,
    dispose(): void {
      for (const off of offs) off();
      offs.length = 0;
    },
  };
}

/**
 * Reserve a row's value cell (editor.css .ctl-value): --value-ch for the value text and --marks-ch
 * for the markers, in characters of the 11px mono face with its tracking.
 */
export function reserveValue(row: HTMLElement, reserve: { readonly text: number; readonly marks: number }): void {
  row.style.setProperty('--value-ch', String(reserve.text));
  row.style.setProperty('--marks-ch', String(reserve.marks));
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
  /** The drawbar's morph editor panel; the organ region places it under the drawbars (a column is too narrow). */
  readonly morphPanel: HTMLElement;
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
  const value = h('span', { class: 'drawbar-value', 'aria-hidden': 'true' }, valueText, suffix);
  const morph = morphEditor(() => d, store, onTouch);
  const input = h('input', { class: 'fader drawbar-input', type: 'range', id: ids.input, step: 1,
    'aria-labelledby': ids.caption, 'aria-describedby': ids.desc });
  const captionShort = h('span', { 'aria-hidden': 'true' });
  const captionName = h('span', { class: 'visually-hidden' });
  const caption = h('label', { class: 'drawbar-caption', id: ids.caption, for: ids.input }, captionShort, captionName);
  const desc = h('span', { class: 'visually-hidden', id: ids.desc });
  const el = h('div', { class: 'drawbar', 'data-key': d.key }, value, input, caption, morph.key, desc);
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
    input.setAttribute('aria-valuetext', spokenValue(d, v, store, false));
    input.style.setProperty('--fill', `${d.max === d.min ? 0 : ((v - d.min) / (d.max - d.min)) * 100}%`);
    valueText.textContent = view.text;
    suffix.textContent = view.suffixes.join(' ');
    el.toggleAttribute('data-nv', view.nv);
    desc.textContent = descriptionText(d, v, store, false);
    morph.refresh();
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
    morphPanel: morph.panel,
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
      morph.dispose();
      el.remove();
      morph.panel.remove();
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
  const label = h('label', { class: 'ctl-label', id: ids.label, for: ids.input },
    h('span', { class: 'ctl-label-text' }, d.label));
  const select = h('select', { class: 'enum', id: ids.input, 'aria-describedby': ids.desc });
  const unknown = h('option', { value: '' });
  select.append(unknown, ...MODEL_GROUPS.map((g) => h('optgroup', { label: g.label },
    ...g.options.map((o) => h('option', { value: o.value }, o.text)))));
  const suffix = h('span', { class: 'ctl-suffix' });
  const valueCell = h('span', { class: 'ctl-value', 'aria-hidden': 'true' }, suffix);
  const desc = h('span', { class: 'visually-hidden', id: ids.desc });
  const row = h('div', { class: 'ctl ctl-select ctl-model', 'data-key': d.key },
    h('span', { class: 'ctl-head' }, label), h('span', { class: 'enum-wrap' }, select), valueCell, desc);
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
    reserveValue(row, { text: 0, marks: suffix.textContent.length });
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
