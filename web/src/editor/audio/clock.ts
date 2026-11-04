/**
 * The master clock at run time (manual p.39–40), pure: a tempo and an anchor time on the audio
 * clock from which every synced step counts. The synth engine owns one; its arpeggiators and LFOs
 * read their step grid from it (model/clock.ts has the divisions). No Web Audio.
 *
 * - A tempo change keeps the beat position at the moment of the change, so synced patterns carry
 *   on from where they are instead of jumping.
 * - Keyboard sync (`common.masterClockKbdSync`, p.40): off never resets the clock from the keys;
 *   on resets it at the first key after all keys were lifted; soft does so only when more than one
 *   quarter note passed since then. Which layers' keys may reset it: see shouldResetClock.
 */
import type { Ns4Key } from '../model/keys.ts';
import { beatSeconds, BPM_MAX, BPM_MIN } from '../model/clock.ts';

/** The program-region fields the synth engine follows directly (they have no synth-region binding). */
export const CLOCK_KEYS: readonly Ns4Key[] = ['common.masterClockRate', 'common.masterClockKbdSync'];

export function isClockKey(key: Ns4Key): boolean {
  return CLOCK_KEYS.includes(key);
}

/** A step grid: steps fall on anchor + k × period for whole k. */
export interface StepGrid {
  readonly period: number;
  readonly anchor: number;
}

const EPS = 1e-6;

/** The first grid time at or after `t`. */
export function gridCeil(grid: StepGrid, t: number): number {
  return grid.anchor + Math.ceil((t - grid.anchor) / grid.period - EPS) * grid.period;
}

/** The first grid time strictly after `t`. */
export function gridAfter(grid: StepGrid, t: number): number {
  return grid.anchor + (Math.floor((t - grid.anchor) / grid.period + EPS) + 1) * grid.period;
}

/** The step number of a grid time `t` (0 at the anchor). */
export function gridIndex(grid: StepGrid, t: number): number {
  return Math.round((t - grid.anchor) / grid.period);
}

export class MasterClock {
  #bpm: number;
  #anchor: number;

  constructor(bpm: number, anchor = 0) {
    this.#bpm = clampBpm(bpm);
    this.#anchor = anchor;
  }

  get bpm(): number {
    return this.#bpm;
  }

  /** The audio time from which the beats count. */
  get anchor(): number {
    return this.#anchor;
  }

  /** Seconds of one quarter note. */
  get beat(): number {
    return beatSeconds(this.#bpm);
  }

  /** Change the tempo at `now`, keeping the beat position reached at `now`. */
  setBpm(bpm: number, now: number): void {
    const next = clampBpm(bpm);
    if (next === this.#bpm) return;
    const beats = (now - this.#anchor) / this.beat;
    this.#bpm = next;
    this.#anchor = now - beats * this.beat;
  }

  /** Keyboard sync: beat 0 is now. */
  reset(now: number): void {
    this.#anchor = now;
  }

  /** The grid of a division `beats` quarter notes long. */
  grid(beats: number): StepGrid {
    return { period: this.beat * beats, anchor: this.#anchor };
  }

  /** The beat position at `t` (quarter notes since the anchor). */
  beatsAt(t: number): number {
    return (t - this.#anchor) / this.beat;
  }
}

function clampBpm(bpm: number): number {
  return Math.min(BPM_MAX, Math.max(BPM_MIN, Number.isFinite(bpm) ? bpm : 120));
}

/** `common.masterClockKbdSync` values (M p.40 labels; value order assumed). */
export type ClockKbdSync = 'off' | 'on' | 'soft';
export const CLOCK_KBD_SYNC: readonly ClockKbdSync[] = ['off', 'on', 'soft'];

export interface ClockResetQuery {
  /** The master clock's keyboard sync setting. */
  readonly mode: ClockKbdSync;
  /** Seconds since every key was lifted (Infinity when none was ever pressed). */
  readonly idle: number;
  /** Seconds of one quarter note at the current tempo. */
  readonly beat: number;
  /** Whether this key reaches a synth layer whose own KB Sync (arpKbdSync) is on. */
  readonly reachesSyncLayer: boolean;
  /** Whether any enabled synth layer has its KB Sync on. */
  readonly anySyncLayer: boolean;
}

/**
 * Whether the first key after all keys were lifted resets the master clock. The master setting
 * decides when (p.40: off never, on always, soft after more than a quarter note of silence). The
 * layers' KB Sync decides which keys may do it (p.37: "you can choose which layer or layers should
 * reset the Master Clock when played"): a key that reaches a layer with KB Sync on, or any key when
 * no enabled layer has KB Sync on, so a program without arpeggiator still resets its synced LFOs.
 * The combination of the two settings is an assumption (unverified).
 */
export function shouldResetClock(q: ClockResetQuery): boolean {
  if (q.mode === 'off') return false;
  if (q.mode === 'soft' && !(q.idle > q.beat)) return false;
  return q.reachesSyncLayer || !q.anySyncLayer;
}
