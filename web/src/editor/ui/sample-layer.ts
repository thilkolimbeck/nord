/**
 * A synth layer's own sample in samples mode (plan sections 15.3 and 15.9), inside the synth
 * oscillator group while the focused layer is in samples mode: which own sample it plays (`sample`,
 * or none), `root` (the note that plays the file at its own pitch, C-1 … G9), `loop` (one-shot or
 * loop) with loop start and end in milliseconds (0 = the end of the file), and a readout of the
 * Nord sample the program names, which the editor cannot play. These are the sample-based
 * parameters of the layer; the audio data itself is managed in the files box (`samples`). The
 * assignment is not a Stage 4 field: it lives in app presets, never in a .ns4p.
 */
import { SAMPLE_NAMES } from '../../ns4/generated/tables-ns4.ts';
import { type Ns4Key, layerKey, type SynthLayer } from '../model/keys.ts';
import { focusedLayer, SECTION_FIELDS } from '../model/scene.ts';
import type { ParamStore } from '../model/store.ts';
import { LOOP_MODES, type LoopMode } from '../model/user-samples.ts';
import { reserveValue } from './controls.ts';
import { h, listen, reservedNote, uid } from './dom.ts';
import { type OwnSamples, noteName } from './own-samples.ts';

export const SAMPLE_LAYER_NOTE = 'own sample: kept only in this browser; app presets carry the reference, a .ns4p never does';

/** The readout for the Nord sample a layer's program names (smpNameHash). */
export function nordSampleText(hash: number): string {
  const name = Object.hasOwn(SAMPLE_NAMES, hash) ? SAMPLE_NAMES[hash] : undefined;
  return name === undefined ? 'nord sample: not decoded' : `nord sample: ${name} (not available)`;
}

/** The longest Nord sample readout, which the note reserves so a layer or program change moves nothing. */
export const LONGEST_NORD_TEXT = longest([nordSampleText(Number.NaN),
  ...Object.keys(SAMPLE_NAMES).map((k) => nordSampleText(Number(k)))]);

/** The status note's longest fixed text, which it reserves (an error message or a missing file's name may exceed it). */
const NO_SAMPLE_NOTE = 'no own sample: the layer is silent; import audio under files › samples';

function longest(texts: readonly string[]): string {
  return texts.reduce((a, b) => (b.length > a.length ? b : a), '');
}

/** Whether a layer is in samples mode (synth{L}.mode = 0, M p.28). */
export function samplesMode(values: { get(key: Ns4Key): number }, layer: SynthLayer): boolean {
  return values.get(layerKey(layer, 'synth{L}.mode')) === 0;
}

function selectRow(label: string): { el: HTMLElement; select: HTMLSelectElement } {
  const id = uid(`sample-${label}`);
  const select = h('select', { class: 'enum', id });
  return {
    select,
    el: h('div', { class: 'ctl ctl-select' },
      h('span', { class: 'ctl-head' }, h('label', { class: 'ctl-label', for: id }, h('span', { class: 'ctl-label-text' }, label))),
      h('span', { class: 'enum-wrap' }, select), h('span', { class: 'ctl-value', 'aria-hidden': 'true' })),
  };
}

/** The value cell of a loop row reserves its widest text: 'end' or the sample's length in ms. */
export function loopValueChars(ms: number): number {
  return Math.max('end'.length, `${ms} ms`.length);
}

function msRow(label: string): { el: HTMLElement; input: HTMLInputElement; value: HTMLElement } {
  const id = uid(`sample-${label}`);
  const input = h('input', { class: 'fader', type: 'range', id, step: 1, min: 0, max: 0 });
  const value = h('span', { class: 'ctl-text' });
  return {
    input, value,
    el: h('div', { class: 'ctl ctl-fader' },
      h('span', { class: 'ctl-head' }, h('label', { class: 'ctl-label', for: id }, h('span', { class: 'ctl-label-text' }, label))),
      input, h('span', { class: 'ctl-value', 'aria-hidden': 'true' }, value)),
  };
}

export interface SampleLayerApi {
  readonly el: HTMLElement;
  dispose(): void;
}

export function mountSampleLayer(store: ParamStore, samples: OwnSamples): SampleLayerApi {
  const sample = selectRow('sample');
  const root = selectRow('root');
  root.select.replaceChildren(...Array.from({ length: 128 }, (_, n) => h('option', { value: n }, noteName(n))));
  const loop = selectRow('loop');
  loop.select.replaceChildren(...LOOP_MODES.map((m) => h('option', { value: m }, m)));
  const start = msRow('loop start');
  const end = msRow('loop end');
  // The notes keep the space of their longest text, so a layer or assignment change moves nothing.
  const nord = reservedNote({ class: 'region-note sample-nord' }, LONGEST_NORD_TEXT);
  const status = reservedNote({ class: 'region-note sample-status' }, longest([NO_SAMPLE_NOTE, SAMPLE_LAYER_NOTE]));
  const el = h('div', { class: 'sample-layer', role: 'group', 'aria-label': 'own sample of the focused layer', hidden: true },
    sample.el, root.el, loop.el, start.el, end.el, nord.el, status.el);
  const layer = (): SynthLayer => focusedLayer(store, 'synth');
  const offs: (() => void)[] = [];

  const render = (): void => {
    const l = layer();
    el.hidden = !samplesMode(store, l);
    if (el.hidden) return;
    const ref = samples.assignments.get(l);
    const options = [h('option', { value: '' }, 'none'), ...samples.list.map((m) => h('option', { value: m.hash }, m.name))];
    if (ref !== null && samples.meta(ref.hash) === null) options.push(h('option', { value: ref.hash }, `${ref.name} (missing)`));
    sample.select.replaceChildren(...options);
    sample.select.value = ref?.hash ?? '';
    // A long file name is cut by the select; the title keeps it whole.
    sample.select.title = sample.select.selectedOptions[0]?.textContent ?? '';
    sample.select.disabled = samples.state.kind === 'unavailable' && ref === null;
    for (const r of [root, loop]) r.select.disabled = ref === null;
    root.select.value = String(ref?.root ?? 60);
    loop.select.value = ref?.loop ?? 'one-shot';
    const seconds = ref === null ? 0 : samples.meta(ref.hash)?.seconds ?? 0;
    const ms = Math.round(seconds * 1000);
    const looped = ref !== null && ref.loop === 'loop';
    // Without a loop the loop rows keep their place empty, so choosing loop moves nothing.
    start.el.toggleAttribute('data-reserved', !looped);
    end.el.toggleAttribute('data-reserved', !looped);
    for (const [row, v] of [[start, ref?.loopStart ?? 0], [end, ref?.loopEnd ?? 0]] as const) {
      row.input.max = String(ms);
      row.input.value = String(Math.round(v * 1000));
      row.input.disabled = ms === 0;
      const text = row === end && v === 0 ? 'end' : `${Math.round(v * 1000)} ms`;
      row.value.textContent = text;
      row.input.setAttribute('aria-valuetext', text);
      row.input.style.setProperty('--fill', `${ms === 0 ? 0 : (Math.round(v * 1000) / ms) * 100}%`);
      reserveValue(row.el, { text: loopValueChars(ms), marks: 0 });
    }
    nord.set(nordSampleText(store.get(layerKey(l, 'synth{L}.smpNameHash'))));
    const missing = ref === null ? null : samples.missingNotes({ [l]: ref })[0] ?? null;
    status.set(ref === null
      ? samples.state.kind === 'unavailable' ? samples.state.message : NO_SAMPLE_NOTE
      : missing ?? SAMPLE_LAYER_NOTE);
  };

  const watched: Ns4Key[] = [...(['A', 'B', 'C'] as const).flatMap((l) => [
    layerKey(l, 'synth{L}.mode'), layerKey(l, 'synth{L}.smpNameHash')])];
  offs.push(
    store.onChange((batch) => {
      if (batch.some((c) => watched.includes(c.key) || c.key.startsWith(SECTION_FIELDS.synth.focus)
        || c.key === 'common.layerScene' || c.origin === 'load')) render();
    }),
    samples.onChange(render),
    samples.assignments.onChange(render),
    listen(sample.select, 'change', () => samples.assign(layer(), sample.select.value === '' ? null : sample.select.value)),
    listen(root.select, 'change', () => samples.update(layer(), { root: Number(root.select.value) })),
    listen(loop.select, 'change', () => samples.update(layer(), { loop: loop.select.value as LoopMode })),
    listen(start.input, 'input', () => samples.update(layer(), { loopStart: Number(start.input.value) / 1000 })),
    listen(end.input, 'input', () => samples.update(layer(), { loopEnd: Number(end.input.value) / 1000 })),
  );
  render();
  if (samples.state.kind === 'closed') void samples.open();

  return {
    el,
    dispose(): void {
      for (const off of offs) off();
      el.remove();
    },
  };
}
