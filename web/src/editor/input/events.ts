/**
 * Play events: what every note source (computer keys, virtual keyboard, MIDI) sends, and the bus
 * that carries them to the audio engine (plan section 2). No DOM, no Web Audio.
 */

export type NoteSource = 'pointer' | 'computer' | 'midi';

export type PlayEvent =
  | { type: 'noteOn'; note: number; velocity: number; source: NoteSource }
  | { type: 'noteOff'; note: number; source: NoteSource }
  | { type: 'sustain'; on: boolean }
  | { type: 'bend'; value: number } // -8192..8191
  | { type: 'controller'; kind: 'wheel' | 'pressure' | 'pedal'; value: number } // 0..127
  | { type: 'panic' };

export type PlayListener = (e: PlayEvent) => void;

/** A synchronous fan-out: listeners run in subscription order; a throwing listener does not stop the others. */
export class PlayBus {
  readonly #listeners = new Set<PlayListener>();

  emit(e: PlayEvent): void {
    let failure: unknown = null;
    for (const fn of [...this.#listeners]) {
      try {
        fn(e);
      } catch (err) {
        failure ??= err;
      }
    }
    if (failure !== null) throw failure;
  }

  on(fn: PlayListener): () => void {
    this.#listeners.add(fn);
    return () => {
      this.#listeners.delete(fn);
    };
  }
}

/**
 * Merges the note sources into one stream for the engine, which knows notes only by number: a
 * note sounds from its first press over all sources until the last holder lets go. noteOn passes
 * only for the first holder (with that press's velocity), noteOff only when the last holder
 * releases; a press or release by a further holder is absorbed (no restrike, no early release).
 * Holders count per source and note, so two computer keys or two pointers on one note release
 * one at a time; MIDI holds a note at most once, as a MIDI key repeated without a note off
 * is the same key and ends with one note off. Panic forgets every holder. Other events pass. Pure.
 */
export class NoteMerge {
  /** note → holder count per source. */
  readonly #holders = new Map<number, Map<NoteSource, number>>();

  /** The events to forward for one incoming event: none, or the event itself. */
  handle(e: PlayEvent): PlayEvent[] {
    switch (e.type) {
      case 'noteOn': {
        let bySource = this.#holders.get(e.note);
        const first = bySource === undefined;
        if (bySource === undefined) {
          bySource = new Map();
          this.#holders.set(e.note, bySource);
        }
        const n = bySource.get(e.source) ?? 0;
        bySource.set(e.source, e.source === 'midi' ? 1 : n + 1);
        return first ? [e] : [];
      }
      case 'noteOff': {
        const bySource = this.#holders.get(e.note);
        const n = bySource?.get(e.source) ?? 0;
        if (bySource === undefined || n === 0) return []; // not held by this source (e.g. after panic)
        if (n > 1) bySource.set(e.source, n - 1);
        else bySource.delete(e.source);
        if (bySource.size > 0) return [];
        this.#holders.delete(e.note);
        return [e];
      }
      case 'panic':
        this.#holders.clear();
        return [e];
      default:
        return [e];
    }
  }

  /** Notes with at least one holder. */
  get notes(): ReadonlySet<number> {
    return new Set(this.#holders.keys());
  }
}

/**
 * The notes currently held down, over all sources (a note held by two sources counts until both
 * release it). Sustained notes are not held. For the keyboard view's lit keys.
 */
export class HeldNotes {
  readonly #counts = new Map<string, number>();
  readonly #listeners = new Set<(notes: ReadonlySet<number>) => void>();

  /** Feeds noteOn, noteOff and panic; returns true when the held set changed. */
  handle(e: PlayEvent): boolean {
    if (e.type === 'panic') {
      if (this.#counts.size === 0) return false;
      this.#counts.clear();
      this.#notify();
      return true;
    }
    if (e.type !== 'noteOn' && e.type !== 'noteOff') return false;
    const before = this.notes.has(e.note);
    const id = `${e.source}:${e.note}`;
    if (e.type === 'noteOn') this.#counts.set(id, (this.#counts.get(id) ?? 0) + 1);
    else {
      const n = (this.#counts.get(id) ?? 0) - 1;
      if (n > 0) this.#counts.set(id, n);
      else this.#counts.delete(id);
    }
    if (before === this.notes.has(e.note)) return false;
    this.#notify();
    return true;
  }

  get notes(): ReadonlySet<number> {
    const out = new Set<number>();
    for (const id of this.#counts.keys()) out.add(Number(id.slice(id.indexOf(':') + 1)));
    return out;
  }

  onChange(fn: (notes: ReadonlySet<number>) => void): () => void {
    this.#listeners.add(fn);
    return () => {
      this.#listeners.delete(fn);
    };
  }

  /** Subscribes to a bus; returns the unsubscribe. */
  attach(bus: PlayBus): () => void {
    return bus.on((e) => {
      this.handle(e);
    });
  }

  #notify(): void {
    const notes = this.notes;
    for (const fn of [...this.#listeners]) fn(notes);
  }
}
