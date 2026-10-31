/**
 * The page: one .ns3f in, one .ns4p out, all in the browser. The engine (./engine) does the
 * work; this file only keeps the instrument strip and the print-out in step with it.
 *
 * Copyright (C) 2026 Thilko Limbeck. AGPL-3.0-or-later.
 */
import { saveFileName, Session, view, type Model } from './state.ts';

function $<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (el === null) throw new Error(`#${id} is missing`);
  return el as T;
}

const strip = $('strip');
const fileInput = $<HTMLInputElement>('file');
const slot = $<HTMLLabelElement>('slot');
const displayName = $('display-name');
const displayVersion = $('display-version');
const displayState = $('display-state');
const countWarn = $('count-warn');
const countNotes = $('count-notes');
const countError = $('count-error');
const keyConvert = $<HTMLButtonElement>('key-convert');
const keySave = $<HTMLButtonElement>('key-save');
const keyClear = $<HTMLButtonElement>('key-clear');
const keyNotes = $<HTMLButtonElement>('key-notes');
const printoutWarnings = $('printout-warnings');
const printoutNotes = $<HTMLButtonElement>('printout-notes');
const printoutLines = $<HTMLOListElement>('printout-lines');

$('engine-legend').textContent = `engine ${__ENGINE_VERSION__} · stage 3 3.00–3.04 → stage 4 3.13`;

const session = new Session();

function setSegments(kind: string, lit: number): void {
  const segments = strip.querySelectorAll<HTMLElement>(`.meter[data-kind="${kind}"] .segments i`);
  segments.forEach((seg, i) => seg.classList.toggle('on', i < lit));
}

function setLed(key: HTMLButtonElement, on: boolean): void {
  key.classList.toggle('lit', on);
}

function printLines(lines: string[]): void {
  printoutLines.replaceChildren(
    ...lines.map((text, i) => {
      const li = document.createElement('li');
      const no = document.createElement('span');
      no.className = 'line-no';
      no.setAttribute('aria-hidden', 'true');
      no.textContent = String(i + 1).padStart(3, '0');
      const body = document.createElement('span');
      body.className = 'line-text';
      body.textContent = text;
      li.append(no, body);
      return li;
    }),
  );
}

function render(model: Model = session.model): void {
  const v = view(model);
  strip.dataset.state = v.kind;

  // Display
  displayName.textContent = v.name || '—';
  displayName.title = v.name;
  displayVersion.textContent = v.versionLine;
  displayState.textContent = v.stateLine;
  displayState.title = v.stateLine;

  // Result meters
  setSegments('warn', v.meters.warn);
  setSegments('notes', v.meters.notes);
  setSegments('error', v.meters.error);
  countWarn.textContent = v.counts.warn;
  countNotes.textContent = v.counts.notes;
  countError.textContent = v.counts.error;

  // Keys
  keyConvert.disabled = v.keys.convert.disabled;
  setLed(keyConvert, v.keys.convert.lit);
  keySave.disabled = v.keys.save.disabled;
  setLed(keySave, v.keys.save.lit);
  keyClear.disabled = v.keys.clear.disabled;
  keyNotes.disabled = v.keys.notes.disabled;
  setLed(keyNotes, v.keys.notes.lit);
  keyNotes.setAttribute('aria-pressed', String(v.notesShown));

  // Print-out
  printoutWarnings.textContent = v.printout.warnings;
  printoutNotes.textContent = v.printout.notes;
  printoutNotes.disabled = v.printout.notesDisabled;
  printoutNotes.setAttribute('aria-pressed', String(v.notesShown));
  printLines(v.printout.lines);
}

function load(files: FileList): void {
  void session.load(files).then((changed) => {
    if (changed) render();
  });
}

function runConvert(): void {
  session.convert();
  render();
}

function save(): void {
  const { state } = session.model;
  const fileName = saveFileName(state);
  if (state.kind !== 'converted' || fileName === null) return;
  const blob = new Blob([state.output as Uint8Array<ArrayBuffer>], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function clear(): void {
  session.clear();
  fileInput.value = '';
  render();
}

function toggleNotes(): void {
  session.toggleNotes();
  render();
}

fileInput.addEventListener('change', () => {
  if (fileInput.files) load(fileInput.files);
  fileInput.value = '';
});

// Drag and drop on the slot. Drops anywhere else are swallowed so the browser does not
// navigate away to the dropped file.
let dragDepth = 0;
slot.addEventListener('dragenter', (event) => {
  event.preventDefault();
  dragDepth++;
  slot.classList.add('drag-over');
});
slot.addEventListener('dragover', (event) => {
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
});
slot.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) slot.classList.remove('drag-over');
});
slot.addEventListener('drop', (event) => {
  event.preventDefault();
  event.stopPropagation();
  dragDepth = 0;
  slot.classList.remove('drag-over');
  const files = event.dataTransfer?.files;
  if (files) load(files);
});
window.addEventListener('dragover', (event) => event.preventDefault());
window.addEventListener('drop', (event) => event.preventDefault());

keyConvert.addEventListener('click', runConvert);
keySave.addEventListener('click', save);
keyClear.addEventListener('click', clear);
keyNotes.addEventListener('click', toggleNotes);
printoutNotes.addEventListener('click', toggleNotes);

render();
