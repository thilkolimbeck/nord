/**
 * Holds notes back until audio runs (plan section 2): the first key or pointer press is the
 * gesture that starts the AudioContext, so its note waits until the context runs and is dropped
 * if released first. MIDI notes are not gestures; until audio runs they are ignored. The latest
 * sustain, bend and controller values are kept meanwhile (a pedal held before the start still
 * holds afterwards) and replayed before the notes. Notes arrive merged over all sources
 * (input/events.ts NoteMerge), so a note number names one note. Pure.
 */
import type { PlayEvent } from '../input/events.ts';

type NoteOn = Extract<PlayEvent, { type: 'noteOn' }>;
type Sustain = Extract<PlayEvent, { type: 'sustain' }>;
type Bend = Extract<PlayEvent, { type: 'bend' }>;
type Controller = Extract<PlayEvent, { type: 'controller' }>;

export class NoteGate {
  readonly #pending = new Map<number, NoteOn>();
  #sustain: Sustain | null = null;
  #bend: Bend | null = null;
  readonly #controllers = new Map<Controller['kind'], Controller>();

  /** The events to play now: everything while running; nothing before, except what is kept for later. */
  handle(e: PlayEvent, running: boolean): PlayEvent[] {
    if (running) return [e];
    switch (e.type) {
      case 'noteOn':
        if (e.source !== 'midi') this.#pending.set(e.note, e);
        break;
      case 'noteOff':
        this.#pending.delete(e.note);
        break;
      case 'sustain':
        this.#sustain = e;
        break;
      case 'bend':
        this.#bend = e;
        break;
      case 'controller':
        this.#controllers.set(e.kind, e);
        break;
      case 'panic':
        this.#pending.clear();
        this.#sustain = null;
        this.#bend = null;
        this.#controllers.clear();
        break;
    }
    return [];
  }

  /**
   * Audio runs: the latest sustain, bend and controller values, then the notes still held in press
   * order; the gate is empty afterwards.
   */
  flush(): PlayEvent[] {
    const out: PlayEvent[] = [];
    if (this.#sustain !== null) out.push(this.#sustain);
    if (this.#bend !== null) out.push(this.#bend);
    out.push(...this.#controllers.values(), ...this.#pending.values());
    this.#pending.clear();
    this.#sustain = null;
    this.#bend = null;
    this.#controllers.clear();
    return out;
  }

  /** Notes waiting. */
  get size(): number {
    return this.#pending.size;
  }
}
