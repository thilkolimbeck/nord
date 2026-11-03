/**
 * The status strip in the panel's legend row (docs/web-design.md, "Editor" → legend row): audio
 * with its LED, the word blocked/error/not supported when it applies, and a start audio key while
 * audio does not run; a separate slot for the MIDI status (filled by plan task T5 through
 * setMidiStatus); and the panic key (also Esc). Status changes are announced politely.
 */
import './status-bar.css';
import { type AudioStatus, audioLed, audioStatusText, audioStatusWord, canStart } from '../audio/status.ts';
import { h, listen, uid } from './dom.ts';

export type LedState = 'on' | 'off' | 'alert';

/** What the MIDI slot shows: LED, short status, and optionally a key (e.g. 'enable midi'). */
export interface MidiStatusView {
  readonly led: LedState;
  readonly text: string;
  /** Longer text for screen readers; defaults to `midi <text>`. */
  readonly description?: string;
  readonly action?: { readonly label: string; run(): void } | null;
}

export interface StatusBarApi {
  setAudio(s: AudioStatus): void;
  setMidi(view: MidiStatusView | null): void;
  dispose(): void;
}

export interface StatusBarDeps {
  /** Called from the start audio key's click: a user gesture. */
  startAudio(): void;
  panic(): void;
  audio: AudioStatus;
}

function setLed(led: HTMLElement, state: LedState): void {
  led.parentElement?.classList.toggle('lit', state === 'on');
  led.classList.toggle('led-alert', state === 'alert');
}

export function mountStatusBar(root: HTMLElement, deps: StatusBarDeps): StatusBarApi {
  const announce = h('p', { class: 'visually-hidden', 'aria-live': 'polite' });

  // Audio
  const audioLedEl = h('span', { class: 'led', 'aria-hidden': 'true' });
  const audioWord = h('span', { class: 'status-word' });
  const audioDescId = uid('audio-status');
  const audioDesc = h('span', { class: 'visually-hidden', id: audioDescId });
  const start = h('button', { class: 'bool-key status-key', type: 'button', 'aria-describedby': audioDescId }, 'start audio');
  const audio = h('span', { class: 'status-item status-audio' },
    h('span', { class: 'status-light' }, audioLedEl, h('span', null, 'audio')), audioWord, audioDesc, start);

  // MIDI: an empty slot until T5 fills it.
  const midiLed = h('span', { class: 'led', 'aria-hidden': 'true' });
  const midiText = h('span', { class: 'status-word' });
  const midiDescId = uid('midi-status');
  const midiDesc = h('span', { class: 'visually-hidden', id: midiDescId });
  const midiKey = h('button', { class: 'bool-key status-key', type: 'button', hidden: true, 'aria-describedby': midiDescId });
  const midi = h('span', { class: 'status-item status-midi', 'data-slot': 'midi', hidden: true },
    h('span', { class: 'status-light' }, midiLed, h('span', null, 'midi')), midiText, midiDesc, midiKey);
  let midiAction: (() => void) | null = null;

  // Panic
  const panicDescId = uid('panic-desc');
  const panic = h('button', { class: 'bool-key status-key', type: 'button', 'aria-keyshortcuts': 'Escape',
    'aria-describedby': panicDescId }, 'panic');
  const panicDesc = h('span', { class: 'visually-hidden', id: panicDescId }, 'all notes off at once; shortcut Esc');

  root.replaceChildren(audio, midi, h('span', { class: 'status-item status-panic' }, panic, panicDesc), announce);

  let lastAudio = '';
  const setAudio = (s: AudioStatus): void => {
    setLed(audioLedEl, audioLed(s));
    audioWord.textContent = audioStatusWord(s);
    const text = audioStatusText(s);
    audioDesc.textContent = text;
    start.hidden = !canStart(s);
    if (text !== lastAudio && lastAudio !== '') announce.textContent = text;
    lastAudio = text;
  };

  const offs = [
    listen(start, 'click', () => deps.startAudio()),
    listen(panic, 'click', () => deps.panic()),
    listen(midiKey, 'click', () => midiAction?.()),
  ];
  setAudio(deps.audio);

  return {
    setAudio,
    setMidi(view: MidiStatusView | null): void {
      midi.hidden = view === null;
      if (view === null) {
        midiAction = null;
        midiKey.hidden = true;
        return;
      }
      setLed(midiLed, view.led);
      midiText.textContent = view.text;
      const description = view.description ?? `midi ${view.text}`;
      if (midiDesc.textContent !== description && midiDesc.textContent !== '') announce.textContent = description;
      midiDesc.textContent = description;
      midiAction = view.action?.run ?? null;
      midiKey.hidden = view.action == null;
      midiKey.textContent = view.action?.label ?? '';
    },
    dispose(): void {
      for (const off of offs) off();
      root.replaceChildren();
    },
  };
}

/** Fill the MIDI slot of the status strip (plan task T5); null empties and hides it. */
export function setMidiStatus(bar: StatusBarApi, view: MidiStatusView | null): void {
  bar.setMidi(view);
}
