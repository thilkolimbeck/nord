/**
 * Computer keys as a two-row piano (plan section 6, AC 6). Keys are matched by KeyboardEvent.code,
 * the physical position, so the piano shape holds on QWERTZ and AZERTY too; the legend shows the
 * real labels where the browser reports them (navigator.keyboard.getLayoutMap, Chromium only)
 * and US letters otherwise. Velocity is fixed. No DOM access except in `bindComputerKeys`.
 */
import type { PlayBus } from './events.ts';

/** Home row → white keys C D E F G A B C D. */
export const WHITE_CODES: readonly string[] = ['KeyA', 'KeyS', 'KeyD', 'KeyF', 'KeyG', 'KeyH', 'KeyJ', 'KeyK', 'KeyL'];
const WHITE_SEMITONES: readonly number[] = [0, 2, 4, 5, 7, 9, 11, 12, 14];
/** Upper row → black keys, as semitones above the C of KeyA. */
export const BLACK_CODES: Readonly<Record<string, number>> = {
  KeyW: 1, KeyE: 3, KeyT: 6, KeyY: 8, KeyU: 10, KeyO: 13, KeyP: 15,
};
export const OCTAVE_DOWN = 'KeyZ';
export const OCTAVE_UP = 'KeyX';

/** MIDI note of KeyA at octave 0: C4 (middle C, scientific pitch: MIDI 60 = C4). */
export const DEFAULT_BASE = 60;
export const DEFAULT_VELOCITY = 100;
export const DEFAULT_MIN_OCTAVE = -3;
export const DEFAULT_MAX_OCTAVE = 3;

const SEMITONES: ReadonlyMap<string, number> = new Map<string, number>([
  ...WHITE_CODES.map((code, i) => [code, WHITE_SEMITONES[i]!] as const),
  ...Object.entries(BLACK_CODES),
]);

/** Every code that plays a note, white keys first, then black keys, in row order. */
export const NOTE_CODES: readonly string[] = [...SEMITONES.keys()];

export function semitoneFor(code: string): number | null {
  return SEMITONES.get(code) ?? null;
}

/** The parts of a KeyboardEvent the mapping reads. */
export interface KeyLike {
  code: string;
  repeat: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
}

/** The parts of the event target (the focused element) the mapping reads. */
export interface TargetLike {
  tagName?: string;
  type?: string;
  isContentEditable?: boolean;
}

/** Input types that take no typed text: letters typed there do not edit anything, so they may play. */
const NON_TEXT_INPUTS: ReadonlySet<string> = new Set([
  'range', 'checkbox', 'radio', 'button', 'submit', 'reset', 'image', 'color', 'file',
]);

/** True when focus is in a field that takes typed text or a choice by letter (select). */
export function isTextTarget(target: TargetLike | null): boolean {
  if (target === null) return false;
  if (target.isContentEditable === true) return true;
  const tag = (target.tagName ?? '').toUpperCase();
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') return !NON_TEXT_INPUTS.has((target.type ?? 'text').toLowerCase());
  return false;
}

/** Key events the piano never handles: auto-repeat, Cmd/Ctrl/Alt chords, typing in text fields and selects. */
export function shouldIgnore(ev: KeyLike, target: TargetLike | null): boolean {
  return ev.repeat || ev.metaKey || ev.ctrlKey || ev.altKey || isTextTarget(target);
}

export interface ComputerKeysOptions {
  base?: number;
  velocity?: number;
  minOctave?: number;
  maxOctave?: number;
}

export class ComputerKeys {
  readonly #bus: PlayBus;
  readonly #base: number;
  readonly #velocity: number;
  readonly #min: number;
  readonly #max: number;
  #octave = 0;
  /** code → the note that code started; keyup releases exactly that note. */
  readonly #held = new Map<string, number>();
  readonly #octaveListeners = new Set<(octave: number) => void>();

  constructor(bus: PlayBus, opts: ComputerKeysOptions = {}) {
    this.#bus = bus;
    this.#base = opts.base ?? DEFAULT_BASE;
    this.#velocity = opts.velocity ?? DEFAULT_VELOCITY;
    this.#min = opts.minOctave ?? DEFAULT_MIN_OCTAVE;
    this.#max = opts.maxOctave ?? DEFAULT_MAX_OCTAVE;
    if (this.#min > 0 || this.#max < 0) throw new RangeError('the octave range must include 0');
  }

  /** Returns true when the key belongs to the piano (the caller then calls preventDefault). */
  keyDown(ev: KeyLike, target: TargetLike | null): boolean {
    if (ev.metaKey || ev.ctrlKey || ev.altKey || isTextTarget(target)) return false;
    const semitone = semitoneFor(ev.code);
    const octaveStep = ev.code === OCTAVE_DOWN ? -1 : ev.code === OCTAVE_UP ? 1 : 0;
    if (semitone === null && octaveStep === 0) return false;
    // A repeat of a piano key is swallowed without a new note or octave step.
    if (ev.repeat) return true;
    if (octaveStep !== 0) {
      this.setOctave(this.#octave + octaveStep);
      return true;
    }
    if (this.#held.has(ev.code)) return true; // a second keydown without keyup in between
    const note = this.#base + 12 * this.#octave + semitone!;
    if (note < 0 || note > 127) return true;
    this.#held.set(ev.code, note);
    this.#bus.emit({ type: 'noteOn', note, velocity: this.#velocity, source: 'computer' });
    return true;
  }

  /** Releases the note this code started, even after an octave change; true when a note was released. */
  keyUp(ev: Pick<KeyLike, 'code'>): boolean {
    const note = this.#held.get(ev.code);
    if (note === undefined) return false;
    this.#held.delete(ev.code);
    this.#bus.emit({ type: 'noteOff', note, source: 'computer' });
    return true;
  }

  releaseAll(): void {
    const notes = [...this.#held.values()];
    this.#held.clear();
    for (const note of notes) this.#bus.emit({ type: 'noteOff', note, source: 'computer' });
  }

  get octave(): number {
    return this.#octave;
  }

  get minOctave(): number {
    return this.#min;
  }

  get maxOctave(): number {
    return this.#max;
  }

  /** The note KeyA plays at the current octave. */
  get baseNote(): number {
    return this.#base + 12 * this.#octave;
  }

  /** Sets the octave within the limits; held notes keep sounding. Returns the octave in effect. */
  setOctave(octave: number): number {
    const next = Math.min(this.#max, Math.max(this.#min, Math.round(octave)));
    if (next !== this.#octave) {
      this.#octave = next;
      for (const fn of [...this.#octaveListeners]) fn(next);
    }
    return this.#octave;
  }

  onOctave(fn: (octave: number) => void): () => void {
    this.#octaveListeners.add(fn);
    return () => {
      this.#octaveListeners.delete(fn);
    };
  }
}

/** Key label per code (lowercase), for the legend and the keyboard's accessible label. */
export type KeyLabels = Readonly<Record<string, string>>;

const LEGEND_CODES: readonly string[] = [...NOTE_CODES, OCTAVE_DOWN, OCTAVE_UP];

/** US letters: 'KeyA' → 'a'. */
export function usLabels(): KeyLabels {
  return Object.fromEntries(LEGEND_CODES.map((code) => [code, code.slice(3).toLowerCase()]));
}

interface LayoutMapLike {
  get(code: string): string | undefined;
}
export interface NavigatorKeyboardLike {
  keyboard?: { getLayoutMap?: () => Promise<LayoutMapLike> };
}

/** Real key labels from the Keyboard Map API where it exists, US letters for every code it does not report. */
export async function keyLabels(nav: NavigatorKeyboardLike | null | undefined): Promise<KeyLabels> {
  const us = usLabels();
  const getLayoutMap = nav?.keyboard?.getLayoutMap;
  if (typeof getLayoutMap !== 'function') return us;
  try {
    const map = await getLayoutMap.call(nav!.keyboard);
    const out: Record<string, string> = {};
    for (const code of LEGEND_CODES) {
      const label = map.get(code);
      out[code] = typeof label === 'string' && label.trim() !== '' ? label.toLowerCase() : us[code]!;
    }
    return out;
  } catch {
    return us;
  }
}

const NOTE_NAMES = ['c', 'c#', 'd', 'd#', 'e', 'f', 'f#', 'g', 'g#', 'a', 'a#', 'b'];

/** Lowercase scientific pitch name: 60 → 'c4', 61 → 'c#4'. */
export function noteName(note: number): string {
  return `${NOTE_NAMES[((note % 12) + 12) % 12]}${Math.floor(note / 12) - 1}`;
}

/** The parts of the legend: white key labels, black key labels, octave keys. */
export function legendParts(labels: KeyLabels): { white: string; black: string; octave: string } {
  return {
    white: WHITE_CODES.map((c) => labels[c]).join(' '),
    black: Object.keys(BLACK_CODES).map((c) => labels[c]).join(' '),
    octave: `${labels[OCTAVE_DOWN]}/${labels[OCTAVE_UP]}`,
  };
}

/** 'keyboard · c3–c6 · keys a s d f g h j k l · w e t y u o p · z/x octave' (web-design.md, keyboard region). */
export function legendText(labels: KeyLabels, low: number, high: number): string {
  const p = legendParts(labels);
  return `keyboard · ${noteName(low)}–${noteName(high)} · keys ${p.white} · ${p.black} · ${p.octave} octave`;
}

/** The accessible label of the keyboard's focusable element. */
export function keyboardAriaLabel(labels: KeyLabels, octave: { current: number; min: number; max: number }): string {
  const p = legendParts(labels);
  const signed = (n: number): string => (n > 0 ? `+${n}` : String(n));
  return `Keyboard. Play with your computer keys: ${p.white} for white keys, ${p.black} for black keys, `
    + `${p.octave} for octave down and up (octave ${signed(octave.current)}, range ${signed(octave.min)} to ${signed(octave.max)}). `
    + 'Works anywhere on the page outside text fields and menus.';
}

interface KeyEventTargetLike {
  addEventListener(type: 'keydown' | 'keyup', fn: (ev: KeyboardEvent) => void): void;
  removeEventListener(type: 'keydown' | 'keyup', fn: (ev: KeyboardEvent) => void): void;
}

/**
 * DOM glue: listens on the document (or window) and routes keydown/keyup to `keys`; handled keys
 * get preventDefault. Returns the unbind.
 */
export function bindComputerKeys(target: KeyEventTargetLike, keys: ComputerKeys): () => void {
  const down = (ev: KeyboardEvent): void => {
    if (ev.defaultPrevented) return;
    const focused = ev.target as unknown as TargetLike | null;
    if (keys.keyDown(ev, focused)) ev.preventDefault();
  };
  const up = (ev: KeyboardEvent): void => {
    // Always release, even with modifiers held or focus moved into a field since the keydown.
    keys.keyUp(ev);
  };
  target.addEventListener('keydown', down);
  target.addEventListener('keyup', up);
  return () => {
    target.removeEventListener('keydown', down);
    target.removeEventListener('keyup', up);
  };
}
