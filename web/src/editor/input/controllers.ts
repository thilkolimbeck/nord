/**
 * The on-screen performance controllers (plan section 15.2): a modulation wheel, a pressure strip
 * (aftertouch, springs back on release) and a control pedal. They emit the same play events as
 * MIDI CC1, channel pressure and CC11 (midi/parser.ts), so vibrato modes and morphs (M p.38–39)
 * follow either. No DOM: the keyboard region's strip calls set and release.
 *
 * Values are 7-bit (0..127). `set` emits { type: 'controller', kind, value } on the bus only when
 * the value changes. `attach` listens to a bus so MIDI moves show on the strip (no event is
 * emitted back) and panic returns every control to 0 (main rests the morph sources itself,
 * model/morph.ts MorphedValues.rest, p.56).
 */
import type { PlayBus } from './events.ts';

export type ControllerKind = 'wheel' | 'pressure' | 'pedal';
export const CONTROLLER_KINDS: readonly ControllerKind[] = ['wheel', 'pressure', 'pedal'];

/** A value as the controllers hold it: an integer 0..127 (non-finite values count as 0). */
export function controllerValue(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(127, Math.max(0, Math.round(value)));
}

export class ScreenControllers {
  readonly #bus: PlayBus;
  readonly #values: Record<ControllerKind, number> = { wheel: 0, pressure: 0, pedal: 0 };
  readonly #listeners = new Set<(kind: ControllerKind, value: number) => void>();

  constructor(bus: PlayBus) {
    this.#bus = bus;
  }

  /** The current value 0..127 (the strip shows it; MIDI moves update it too). */
  value(kind: ControllerKind): number {
    return this.#values[kind];
  }

  /** The user moved a control: emit { type: 'controller', kind, value } when the value changed. */
  set(kind: ControllerKind, value: number): void {
    const v = controllerValue(value);
    if (this.#values[kind] === v) return;
    let failure: unknown = null;
    try {
      this.#store(kind, v);
    } catch (err) {
      failure = err;
    }
    this.#bus.emit({ type: 'controller', kind, value: v });
    if (failure !== null) throw failure;
  }

  /** Pointer or key released: the pressure strip returns to 0; the wheel and the pedal stay. */
  release(kind: ControllerKind): void {
    if (kind === 'pressure') this.set('pressure', 0);
  }

  /** Listen to the bus so MIDI moves show on the strip; panic returns every control to 0. */
  attach(bus: PlayBus): () => void {
    return bus.on((e) => {
      if (e.type === 'controller') this.#store(e.kind, controllerValue(e.value));
      else if (e.type === 'panic') for (const kind of CONTROLLER_KINDS) this.#store(kind, 0);
    });
  }

  onChange(fn: (kind: ControllerKind, value: number) => void): () => void {
    this.#listeners.add(fn);
    return () => {
      this.#listeners.delete(fn);
    };
  }

  /** Keep a value and tell the listeners; false when it did not change. */
  #store(kind: ControllerKind, value: number): boolean {
    if (this.#values[kind] === value) return false;
    this.#values[kind] = value;
    const errors: unknown[] = [];
    for (const fn of [...this.#listeners]) {
      try {
        fn(kind, value);
      } catch (err) {
        errors.push(err);
      }
    }
    if (errors.length > 0) throw errors[0];
    return true;
  }
}
