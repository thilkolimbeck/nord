/**
 * Virtual keyboard input through Pointer Events (mouse, touch and pen in one path; plan section 6,
 * AC 5). The logic is pure: the view (ui/keyboard-view.ts) translates pointer events into
 * down/move/up/cancel calls with the note under the pointer and a velocity from its vertical
 * position. Several pointers play at once; a note held by two pointers sounds until both let go.
 */
import type { PlayBus } from './events.ts';

/** 1..127 from the position on the key: top soft, bottom loud. A zero-height key gives the middle. */
export function velocityFromY(y: number, top: number, height: number): number {
  if (!(height > 0) || !Number.isFinite(y) || !Number.isFinite(top)) return 64;
  const ratio = (y - top) / height;
  const v = Math.round(1 + 126 * ratio);
  return Math.min(127, Math.max(1, v));
}

export class PointerNotes {
  readonly #bus: PlayBus;
  /** pointerId → the note it holds. */
  readonly #pointers = new Map<number, number>();
  /** note → how many pointers hold it. */
  readonly #counts = new Map<number, number>();
  /** Pointers that went down and have not gone up, including ones dragged off the keys. */
  readonly #tracked = new Set<number>();

  constructor(bus: PlayBus) {
    this.#bus = bus;
  }

  /** A pointer goes down on a key. A pointer that is already down glides instead. */
  down(pointerId: number, note: number, velocity: number): void {
    if (this.#tracked.has(pointerId)) {
      this.move(pointerId, note, velocity);
      return;
    }
    this.#tracked.add(pointerId);
    this.#press(pointerId, note, velocity);
  }

  /**
   * A pressed pointer moves: onto another key it releases the old note and starts the new one;
   * off the keys (`note` null) it releases. Moves of pointers that are not down are ignored.
   * Moving within the same key changes nothing (no retrigger).
   */
  move(pointerId: number, note: number | null, velocity: number): void {
    if (!this.#tracked.has(pointerId)) return;
    const current = this.#pointers.get(pointerId);
    if (current === note) return;
    if (current !== undefined) this.#release(pointerId, current);
    if (note !== null) this.#press(pointerId, note, velocity);
  }

  up(pointerId: number): void {
    const note = this.#pointers.get(pointerId);
    this.#tracked.delete(pointerId);
    if (note !== undefined) this.#release(pointerId, note);
  }

  cancel(pointerId: number): void {
    this.up(pointerId);
  }

  releaseAll(): void {
    for (const id of [...this.#tracked]) this.up(id);
  }

  /** Notes held by pointers right now. */
  get notes(): ReadonlySet<number> {
    return new Set(this.#counts.keys());
  }

  /** Pointers that are down, whether over a key or not. */
  get activePointers(): number {
    return this.#tracked.size;
  }

  #press(pointerId: number, note: number, velocity: number): void {
    if (!Number.isInteger(note) || note < 0 || note > 127) return;
    this.#pointers.set(pointerId, note);
    const count = this.#counts.get(note) ?? 0;
    this.#counts.set(note, count + 1);
    if (count === 0) {
      const v = Math.min(127, Math.max(1, Math.round(velocity)));
      this.#bus.emit({ type: 'noteOn', note, velocity: v, source: 'pointer' });
    }
  }

  #release(pointerId: number, note: number): void {
    this.#pointers.delete(pointerId);
    const count = (this.#counts.get(note) ?? 1) - 1;
    if (count > 0) {
      this.#counts.set(note, count);
      return;
    }
    this.#counts.delete(note);
    this.#bus.emit({ type: 'noteOff', note, source: 'pointer' });
  }
}
