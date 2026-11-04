/**
 * The arpeggiator and gate of one synth layer (manual p.17, 35–37), pure: it turns the notes held
 * for the layer into timed note and gate events on a step grid. The synth engine calls schedule()
 * every 25 ms with a 100 ms horizon (look-ahead scheduling on the AudioContext clock) and plays
 * the events at their times. No Web Audio, no timers.
 *
 * - Arp: held notes play one after the other, outlining the chord (p.35). Poly: the chord plays
 *   together on every step; with a range, its inversions play in order (p.35). Gate: no notes of its
 *   own, the layer's sound is opened and closed on every step (p.35).
 * - Direction up, down, up/down, random (p.17, 35); zig zag jumps two steps forward and one back
 *   (p.17, 35); neither applies to the gate (p.35).
 * - Range (p.17, 35): the held notes plus their octave copies up to `rangeSemitones` above the
 *   highest held note; 0 plays the held notes only. Poly steps through windows of as many notes as
 *   are held over that list (the inversions).
 * - A step lasts one grid period: the free rate's eighth note or a master clock division (p.36).
 *   An arpeggiated note lasts `noteLength` of a step (assumed; the pattern's step durations are not
 *   decoded).
 * - KB sync (p.37): the engine calls restart() at the first key after all keys were lifted; the
 *   arpeggio then starts on that key with the first step. Without it a new chord waits for the
 *   running grid.
 * - Pattern (p.35–36): with a step count the events carry the pattern step, counted from the grid
 *   anchor. The pattern's content (accent, duration, pan bit fields) is not decoded: every step plays
 *   (a flat pattern).
 *
 * How the Stage 4 orders notes at the ends of a zig zag, how it maps the range knob to octaves and
 * whether a new chord restarts the note order without KB sync are assumptions (unverified).
 */
import { gridAfter, gridCeil, gridIndex, type StepGrid } from './clock.ts';

export type ArpMode = 'arp' | 'poly' | 'gate';
export type ArpDirection = 'up' | 'down' | 'updown' | 'random';
export const ARP_MODES: readonly ArpMode[] = ['arp', 'poly', 'gate'];
export const ARP_DIRECTIONS: readonly ArpDirection[] = ['up', 'down', 'updown', 'random'];

export interface ArpSettings {
  readonly mode: ArpMode;
  readonly direction: ArpDirection;
  readonly zigzag: boolean;
  /** How far the octave copies reach above the highest held note, in semitones (0 = held notes only). */
  readonly rangeSemitones: number;
  /** The pattern's step count with Pattern on, else null. */
  readonly patternSteps: number | null;
  /** Length of an arpeggiated note as a fraction of the step (0 < x ≤ 1). */
  readonly noteLength: number;
}

/** What the engine needs to start a voice for a held note. */
export interface ArpHeld {
  readonly velocity: number;
  /** The split crossfade gain of the key (router). */
  readonly gain: number;
}

export type ArpEvent =
  | { readonly type: 'on'; readonly time: number; readonly note: number; readonly velocity: number; readonly gain: number;
    readonly step: number | null }
  | { readonly type: 'off'; readonly time: number; readonly note: number }
  | { readonly type: 'gate'; readonly time: number; readonly period: number; readonly step: number | null };

/** A step may start this much before `now` and still play (a late tick); older steps are skipped. */
const LATE = 0.005;
/**
 * Poly mode: a note that joins the held set up to this long after a step was handed out still
 * plays in that step's chord (the keys of a chord never land at the same instant).
 */
export const CHORD_JOIN = 0.03;

/** The held notes and their octave copies up to `rangeSemitones` above the highest, ascending, unique, at most 127. */
export function arpNotes(held: readonly number[], rangeSemitones: number): number[] {
  if (held.length === 0) return [];
  const base = [...new Set(held)].sort((a, b) => a - b);
  const top = base.at(-1)! + Math.max(0, rangeSemitones);
  const out = new Set(base);
  for (let k = 1; base[0]! + 12 * k <= top; k++) {
    for (const n of base) {
      const m = n + 12 * k;
      if (m <= top && m <= 127) out.add(m);
    }
  }
  return [...out].sort((a, b) => a - b);
}

/** Zig zag over n items, upwards: 0 2 1 3 2 4 3 …, ending with the last item's last appearance. */
function zigzagUp(n: number): number[] {
  if (n <= 2) return Array.from({ length: n }, (_, i) => i);
  const seq: number[] = [];
  for (let j = 0; j < n; j++) seq.push(j, j + 2);
  const valid = seq.filter((i) => i < n);
  return valid.slice(0, valid.lastIndexOf(n - 1) + 1);
}

/**
 * The repeating order of item indices for a direction (random excluded). Up/down turns at the ends
 * without repeating them: 0 1 2 1 for three items.
 */
export function arpOrder(n: number, direction: Exclude<ArpDirection, 'random'>, zigzag: boolean): number[] {
  if (n <= 0) return [];
  const up = zigzag ? zigzagUp(n) : Array.from({ length: n }, (_, i) => i);
  const down = up.map((i) => n - 1 - i);
  if (direction === 'up') return up;
  if (direction === 'down') return down;
  if (n === 1) return [0];
  const out = [...up];
  for (const i of down) if (out.at(-1) !== i) out.push(i);
  while (out.length > 1 && out.at(-1) === out[0]) out.pop();
  return out;
}

export class ArpScheduler {
  readonly #random: () => number;
  readonly #held = new Map<number, ArpHeld>();
  /** The next step time, or null while not running. */
  #next: number | null = null;
  /** When the held set became non-empty: the first step falls on the grid at or after it. */
  #startAt: number | null = null;
  /** Steps played since the start: the position in the note order. */
  #pos = 0;
  #lastRandom = -1;
  /** Note offs not yet handed out, by time, with the time of their note's start. */
  #offs: Array<{ time: number; note: number; on: number }> = [];
  /** The grid the pending step `#next` lies on, or null right after a restart (the step is the key). */
  #grid: StepGrid | null = null;
  /** The time of the last step handed out, or null. */
  #last: number | null = null;
  /** The last Poly step handed out: a note that joins soon after still plays in it. */
  #lastPoly: { time: number; off: number; step: number | null } | null = null;

  constructor(random: () => number = Math.random) {
    this.#random = random;
  }

  /** Notes held for the layer (keys down and notes kept by KB hold). */
  get size(): number {
    return this.#held.size;
  }

  /** Whether the scheduler is running a step grid now. */
  get running(): boolean {
    return this.#next !== null;
  }

  heldNotes(): number[] {
    return [...this.#held.keys()].sort((a, b) => a - b);
  }

  /**
   * A note joins the held set; the first one starts the arpeggio from its first step. In Poly mode a
   * note that comes within CHORD_JOIN of the last step plays in that step's chord: the events to play.
   */
  noteOn(note: number, held: ArpHeld, t: number): ArpEvent[] {
    if (this.#held.size === 0) {
      this.#pos = 0;
      this.#lastRandom = -1;
      if (this.#next === null) this.#startAt = t;
    }
    const joins = !this.#held.has(note) && this.#lastPoly !== null && t - this.#lastPoly.time < CHORD_JOIN
      && t < this.#lastPoly.off;
    this.#held.set(note, held);
    if (!joins) return [];
    const p = this.#lastPoly!;
    const on = Math.max(t, p.time);
    this.#offs.push({ time: p.off, note, on });
    return [{ type: 'on', time: on, note, velocity: held.velocity, gain: held.gain, step: p.step }];
  }

  noteOff(note: number): void {
    this.#held.delete(note);
  }

  /**
   * KB sync: the next step falls at `t` and the note order starts again. Steps already handed out
   * for after `t` belong to the old grid: their pending note offs are dropped here, and the engine
   * cancels their notes (cancelAfter), so the old grid plays nothing after the key.
   */
  restart(t: number): void {
    this.#next = t;
    this.#grid = null;
    this.#last = null;
    this.#startAt = null;
    this.#pos = 0;
    this.#lastRandom = -1;
    this.#offs = this.#offs.filter((o) => o.on <= t);
    if (this.#lastPoly !== null && this.#lastPoly.time > t) this.#lastPoly = null;
  }

  /**
   * The events of every step that starts before `until`, and every pending note off before
   * `until`, sorted by time. `now` is the current audio time: steps older than now are skipped.
   */
  schedule(now: number, until: number, s: ArpSettings, grid: StepGrid): ArpEvent[] {
    const out: ArpEvent[] = [];
    const gate = s.mode === 'gate';
    if (!gate && this.#held.size === 0) {
      this.#next = null;
      this.#grid = null;
      this.#startAt = null;
    } else if (grid.period > 0 && Number.isFinite(grid.period)) {
      if (this.#next === null) this.#next = gridCeil(grid, Math.max(now, this.#startAt ?? now));
      else if (this.#grid !== null && (this.#grid.period !== grid.period || this.#grid.anchor !== grid.anchor)) {
        // The grid moved (a tempo or rate change, a group alignment): the pending step lies on the
        // old grid. Move it onto the new one, at least half a new step after the last step, so the
        // change neither doubles a step nor leaves a gap of an old, longer step.
        this.#next = gridCeil(grid, Math.max(now, this.#last === null ? now : this.#last + grid.period / 2));
      }
      this.#grid = grid;
      this.#startAt = null;
      if (this.#next < now - LATE) this.#next = gridCeil(grid, now);
      while (this.#next < until) {
        this.#step(this.#next, s, grid, out);
        this.#last = this.#next;
        this.#next = gridAfter(grid, this.#next);
      }
    }
    this.#offs.sort((a, b) => a.time - b.time);
    while (this.#offs.length > 0 && this.#offs[0]!.time < until) {
      const o = this.#offs.shift()!;
      out.push({ type: 'off', time: o.time, note: o.note });
    }
    return out.sort((a, b) => a.time - b.time || rank(a) - rank(b));
  }

  /** Every pending note off, at their time or `t` if later (the arpeggio stops). */
  flush(t: number): ArpEvent[] {
    const out = this.#offs.map((o): ArpEvent => ({ type: 'off', time: Math.max(t, o.time), note: o.note }));
    this.#offs = [];
    this.#next = null;
    this.#grid = null;
    this.#last = null;
    this.#startAt = null;
    this.#lastPoly = null;
    return out.sort((a, b) => a.time - b.time);
  }

  /** Panic: forget held notes, pending offs and the grid position; no events. */
  reset(): void {
    this.#held.clear();
    this.#lastPoly = null;
    this.#offs = [];
    this.#next = null;
    this.#grid = null;
    this.#last = null;
    this.#startAt = null;
    this.#pos = 0;
    this.#lastRandom = -1;
  }

  #step(time: number, s: ArpSettings, grid: StepGrid, out: ArpEvent[]): void {
    const steps = s.patternSteps;
    const index = gridIndex(grid, time);
    const step = steps === null ? null : ((index % steps) + steps) % steps;
    if (s.mode === 'gate') {
      out.push({ type: 'gate', time, period: grid.period, step });
      return;
    }
    const held = this.heldNotes();
    const notes = arpNotes(held, s.rangeSemitones);
    if (notes.length === 0) return;
    const items: number[][] = s.mode === 'poly'
      ? Array.from({ length: notes.length - held.length + 1 }, (_, i) => notes.slice(i, i + held.length))
      : notes.map((n) => [n]);
    const pick = this.#pick(items.length, s);
    this.#pos++;
    const off = time + grid.period * Math.min(1, Math.max(0.05, s.noteLength));
    this.#lastPoly = s.mode === 'poly' ? { time, off, step } : null;
    for (const note of items[pick]!) {
      const source = this.#sourceOf(note, held);
      out.push({ type: 'on', time, note, velocity: source.velocity, gain: source.gain, step });
      this.#offs.push({ time: off, note, on: time });
    }
  }

  #pick(n: number, s: ArpSettings): number {
    if (s.direction === 'random') {
      if (n === 1) return 0;
      let i = Math.min(n - 1, Math.floor(this.#random() * n));
      if (i === this.#lastRandom) i = (i + 1) % n;
      this.#lastRandom = i;
      return i;
    }
    const order = arpOrder(n, s.direction, s.zigzag);
    return order[this.#pos % order.length]!;
  }

  /** The held note an arpeggiated note comes from (its octave copy's original), for velocity and gain. */
  #sourceOf(note: number, held: readonly number[]): ArpHeld {
    const direct = this.#held.get(note);
    if (direct !== undefined) return direct;
    const origin = held.find((h) => (note - h) % 12 === 0 && note > h) ?? held[0]!;
    return this.#held.get(origin)!;
  }
}

/** Offs before ons at the same time, so a repeated note ends before it starts again. */
function rank(e: ArpEvent): number {
  return e.type === 'off' ? 0 : e.type === 'gate' ? 1 : 2;
}
