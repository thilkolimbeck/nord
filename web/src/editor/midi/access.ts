/**
 * Web MIDI input (plan section 1, AC 7): asks for access only when the user presses `enable midi`,
 * never with SysEx, listens to every connected input (omni) and follows connects and disconnects.
 * This module opens no output and sends nothing: MIDI output (plan section 15.5) reads the access
 * object through onAccess and sends only while the user has switched it on (midi/output.ts).
 * onMessage hands every parsed channel message to MIDI control in (midi/cc-in.ts). The status is a
 * pure state machine (midiStatusReducer) with short texts for the status strip (docs/web-design.md).
 */
import type { PlayBus } from '../input/events.ts';
import type { MidiOutputLike } from './output.ts';
import { type MidiEvent, parseMidiMessage, toPlayEvents } from './parser.ts';

export type MidiStatus =
  | { kind: 'off' }
  | { kind: 'requesting' }
  | { kind: 'unsupported' }
  | { kind: 'denied' }
  | { kind: 'no-inputs' }
  | { kind: 'connected'; inputs: readonly string[] }
  | { kind: 'error'; message: string };

export type MidiStatusEvent =
  /** The user pressed `enable midi`. */
  | { type: 'request' }
  /** The browser has no navigator.requestMIDIAccess. */
  | { type: 'unsupported' }
  /** requestMIDIAccess rejected. */
  | { type: 'failed'; error: unknown }
  /** The names of the connected inputs, after access or a statechange. */
  | { type: 'inputs'; names: readonly string[] }
  | { type: 'disable' };

export const MIDI_OFF: MidiStatus = { kind: 'off' };

function errorName(err: unknown): string {
  if (typeof err === 'object' && err !== null && 'name' in err && typeof err.name === 'string') return err.name;
  return '';
}

function errorMessage(err: unknown): string {
  if (typeof err === 'object' && err !== null && 'message' in err && typeof err.message === 'string' && err.message !== '') {
    return err.message;
  }
  return String(err);
}

/** NotAllowedError and SecurityError → denied; NotSupportedError → unsupported; anything else → error. */
export function midiStatusFromError(err: unknown): MidiStatus {
  const name = errorName(err);
  if (name === 'NotAllowedError' || name === 'SecurityError') return { kind: 'denied' };
  if (name === 'NotSupportedError') return { kind: 'unsupported' };
  return { kind: 'error', message: errorMessage(err) };
}

export function midiStatusReducer(s: MidiStatus, e: MidiStatusEvent): MidiStatus {
  if (s.kind === 'unsupported') return s;
  switch (e.type) {
    case 'request':
      return { kind: 'requesting' };
    case 'unsupported':
      return { kind: 'unsupported' };
    case 'failed':
      return midiStatusFromError(e.error);
    case 'inputs':
      // A statechange after disable or before access is not a status.
      if (s.kind === 'off' || s.kind === 'denied' || s.kind === 'error') return s;
      if (e.names.length === 0) return s.kind === 'no-inputs' ? s : { kind: 'no-inputs' };
      if (s.kind === 'connected' && s.inputs.length === e.names.length && s.inputs.every((n, i) => n === e.names[i])) return s;
      return { kind: 'connected', inputs: [...e.names] };
    case 'disable':
      return MIDI_OFF;
  }
}

/** The short text of the status strip; '' while off (the strip then shows the `enable midi` key). */
export function midiStatusText(s: MidiStatus): string {
  switch (s.kind) {
    case 'off':
      return '';
    case 'requesting':
      return 'waiting for permission';
    case 'unsupported':
      return 'not supported in this browser';
    case 'denied':
      return 'permission denied';
    case 'no-inputs':
      return 'no inputs';
    case 'connected':
      return `connected: ${s.inputs.join(', ')}`;
    case 'error':
      return 'error';
  }
}

/** The longer text for screen readers. */
export function midiStatusDescription(s: MidiStatus): string {
  switch (s.kind) {
    case 'off':
      return 'midi off; enable midi asks the browser for access to MIDI inputs';
    case 'error':
      return `midi error: ${s.message}`;
    default:
      return `midi ${midiStatusText(s)}`;
  }
}

/** LED: on while an input is connected, alert for denied, unsupported and error, off otherwise. */
export function midiLed(s: MidiStatus): 'on' | 'off' | 'alert' {
  if (s.kind === 'connected') return 'on';
  if (s.kind === 'denied' || s.kind === 'unsupported' || s.kind === 'error') return 'alert';
  return 'off';
}

/** Whether the `enable midi` key is offered: while off, and as a retry after an error. */
export function canEnableMidi(s: MidiStatus): boolean {
  return s.kind === 'off' || s.kind === 'error';
}

// The slices of the Web MIDI API this module uses; structural so tests can fake them.
export interface MidiMessageLike {
  readonly data: Uint8Array | null;
}
export interface MidiInputLike {
  readonly id: string;
  readonly name: string | null;
  readonly state: string;
  onmidimessage: ((ev: MidiMessageLike) => void) | null;
}
export interface MidiAccessLike {
  readonly inputs: { forEach(fn: (input: MidiInputLike) => void): void };
  /** The output ports (plan section 15.5); optional so fakes without outputs still work. */
  readonly outputs?: { forEach(fn: (output: MidiOutputLike) => void): void };
  onstatechange: ((ev: unknown) => void) | null;
}
export interface MidiNavigator {
  requestMIDIAccess?: (options: { sysex: boolean }) => Promise<MidiAccessLike>;
}

export class MidiInput {
  readonly #bus: PlayBus;
  readonly #nav: MidiNavigator;
  readonly #listeners = new Set<(s: MidiStatus) => void>();
  readonly #messageListeners = new Set<(e: MidiEvent, inputId: string) => void>();
  readonly #accessListeners = new Set<(access: MidiAccessLike | null) => void>();
  #status: MidiStatus = MIDI_OFF;
  #access: MidiAccessLike | null = null;
  /** Inputs we listen to, with the notes and sustain they hold (released when they disconnect). */
  readonly #ports = new Map<string, { port: MidiInputLike; notes: Set<number>; sustain: boolean }>();
  #generation = 0;

  constructor(bus: PlayBus, nav: MidiNavigator) {
    this.#bus = bus;
    this.#nav = nav;
  }

  get status(): MidiStatus {
    return this.#status;
  }

  /** The browser's MIDI access after `enable midi`; null before, after disable and when refused. */
  get access(): MidiAccessLike | null {
    return this.#access;
  }

  /**
   * Every parsed channel message of every input, before it becomes play events (controllers the
   * play bus ignores included). For MIDI control in; a throwing listener does not stop the others.
   */
  onMessage(fn: (e: MidiEvent, inputId: string) => void): () => void {
    this.#messageListeners.add(fn);
    return () => {
      this.#messageListeners.delete(fn);
    };
  }

  /** Called with the access when it is granted and after every port change, and with null on disable. */
  onAccess(fn: (access: MidiAccessLike | null) => void): () => void {
    this.#accessListeners.add(fn);
    return () => {
      this.#accessListeners.delete(fn);
    };
  }

  /** From the `enable midi` click. Inputs only, never SysEx, never outputs. */
  async enable(): Promise<void> {
    if (this.#status.kind === 'requesting' || this.#access !== null) return;
    const request = this.#nav.requestMIDIAccess;
    if (typeof request !== 'function') {
      this.#dispatch({ type: 'unsupported' });
      return;
    }
    this.#dispatch({ type: 'request' });
    const generation = ++this.#generation;
    let access: MidiAccessLike;
    try {
      access = await request.call(this.#nav, { sysex: false });
    } catch (err) {
      if (generation === this.#generation) this.#dispatch({ type: 'failed', error: err });
      return;
    }
    if (generation !== this.#generation) return; // disabled meanwhile
    this.#access = access;
    access.onstatechange = () => this.#sync();
    this.#sync();
  }

  /** Stops listening and releases what MIDI still holds. */
  disable(): void {
    this.#generation++;
    const had = this.#access !== null;
    if (this.#access !== null) this.#access.onstatechange = null;
    this.#access = null;
    for (const id of [...this.#ports.keys()]) this.#drop(id);
    this.#dispatch({ type: 'disable' });
    if (had) this.#announce();
  }

  /**
   * After a panic: forget the notes and sustain every input holds, without emitting anything (the
   * panic already ended them), so a later disconnect or disable sends no stale note off.
   */
  forgetHeld(): void {
    for (const entry of this.#ports.values()) {
      entry.notes.clear();
      entry.sustain = false;
    }
  }

  onStatus(fn: (s: MidiStatus) => void): () => void {
    this.#listeners.add(fn);
    return () => {
      this.#listeners.delete(fn);
    };
  }

  /** Listen to every connected input, drop the ones that left, report the names. */
  #sync(): void {
    const access = this.#access;
    if (access === null) return;
    const seen = new Set<string>();
    const names: string[] = [];
    access.inputs.forEach((port) => {
      if (port.state !== 'connected') return;
      seen.add(port.id);
      names.push(port.name !== null && port.name !== '' ? port.name : 'unnamed input');
      if (this.#ports.has(port.id)) return;
      const entry = { port, notes: new Set<number>(), sustain: false };
      this.#ports.set(port.id, entry);
      // Assigning onmidimessage opens the input port implicitly; outputs are never touched here.
      port.onmidimessage = (ev) => this.#receive(port.id, entry, ev);
    });
    for (const id of [...this.#ports.keys()]) if (!seen.has(id)) this.#drop(id);
    this.#dispatch({ type: 'inputs', names });
    this.#announce();
  }

  #announce(): void {
    for (const fn of [...this.#accessListeners]) {
      try {
        fn(this.#access);
      } catch (err) {
        console.error(err);
      }
    }
  }

  #receive(inputId: string, entry: { notes: Set<number>; sustain: boolean }, ev: MidiMessageLike): void {
    if (ev.data === null) return;
    const parsed = parseMidiMessage(ev.data);
    if (parsed === null) return;
    for (const fn of [...this.#messageListeners]) {
      try {
        fn(parsed, inputId);
      } catch (err) {
        console.error(err);
      }
    }
    for (const e of toPlayEvents(parsed)) {
      if (e.type === 'noteOn') entry.notes.add(e.note);
      else if (e.type === 'noteOff') entry.notes.delete(e.note);
      else if (e.type === 'sustain') entry.sustain = e.on;
      else if (e.type === 'panic') {
        entry.notes.clear();
        entry.sustain = false;
      }
      this.#bus.emit(e);
    }
  }

  /** An input left (or MIDI was disabled): stop listening, release its notes and sustain. */
  #drop(id: string): void {
    const entry = this.#ports.get(id);
    if (entry === undefined) return;
    this.#ports.delete(id);
    entry.port.onmidimessage = null;
    for (const note of entry.notes) this.#bus.emit({ type: 'noteOff', note, source: 'midi' });
    if (entry.sustain) this.#bus.emit({ type: 'sustain', on: false });
  }

  #dispatch(e: MidiStatusEvent): void {
    const next = midiStatusReducer(this.#status, e);
    if (next === this.#status) return;
    this.#status = next;
    for (const fn of [...this.#listeners]) fn(next);
  }
}
