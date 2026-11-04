/**
 * The master clock's numbers (manual p.17, 34, 36, 39–40), pure: the tempo range, the clock
 * divisions the arpeggiator and the synth LFO choose from when synced to the master clock, the
 * free-running arpeggiator rate, and tap tempo. Shared by the field labels (curated.ts), the synth
 * engine's arpeggiator and LFO (audio/) and the program panel's tap key (ui/). No DOM, no Web Audio.
 *
 * What the manual settles: the tempo is set in BPM (p.39–40; the layout holds 30–240), a division
 * is a note value of that tempo ("1/4 equals quarter notes", p.34, 36; "T" marks triplets, p.17,
 * 36), the LFO has divisions longer than 1/1 for sweeps over a bar (p.17), the free arpeggiator
 * rate is shown as quarter-note BPM and plays 1/8 notes (p.36), and tap tempo needs at least four
 * taps (p.17, 40). Not decoded: which divisions the Stage 4 lists and how the stored 0–127 maps
 * onto them, and the free arpeggiator's BPM range. The lists and curves here are assumptions,
 * shown as "nv" in the editor.
 */

/** The master clock tempo range (layout of common.masterClockRate: the stored value is the BPM). */
export const BPM_MIN = 30;
export const BPM_MAX = 240;

export interface ClockDivision {
  /** The manual's notation: '1/8', '1/8T', '2/1'. */
  readonly label: string;
  /** Length of one step in quarter notes. */
  readonly beats: number;
}

const division = (label: string): ClockDivision => {
  const m = /^(\d+)\/(\d+)(T?)$/.exec(label)!;
  const whole = Number(m[1]) / Number(m[2]);
  return { label, beats: whole * 4 * (m[3] === 'T' ? 2 / 3 : 1) };
};

/** Arpeggiator divisions, slow to fast as the knob turns clockwise (M p.17, 36: 1/2, 1/4, 1/8, 1/16, T = triplet). Assumed list. */
export const ARP_DIVISIONS: readonly ClockDivision[] =
  ['1/2', '1/4', '1/4T', '1/8', '1/8T', '1/16', '1/16T', '1/32'].map(division);

/** LFO divisions, slow to fast (M p.17, 34: ½, ¼, 1/8 … and settings longer than 1/1). Assumed list. */
export const LFO_DIVISIONS: readonly ClockDivision[] =
  ['8/1', '4/1', '2/1', '1/1', '1/2', '1/2T', '1/4', '1/4T', '1/8', '1/8T', '1/16', '1/16T', '1/32'].map(division);

/** The stored rate steps of arpRateClkDiv and lfoRateClkDiv. */
export const RATE_STEPS = 128;

/** The division a stored rate step 0–127 selects: the range split evenly over the list (assumed). */
export function divisionOf(step: number, list: readonly ClockDivision[]): ClockDivision {
  const i = Math.floor((Math.min(RATE_STEPS - 1, Math.max(0, Math.round(step))) * list.length) / RATE_STEPS);
  return list[Math.min(list.length - 1, i)]!;
}

/** Seconds of one quarter note at a tempo. */
export function beatSeconds(bpm: number): number {
  return 60 / Math.min(BPM_MAX, Math.max(BPM_MIN, bpm));
}

/** Seconds of one step of a division at a tempo. */
export function divisionSeconds(bpm: number, d: ClockDivision): number {
  return beatSeconds(bpm) * d.beats;
}

/**
 * The free-running arpeggiator rate in quarter-note BPM, unverified: the stored step 0–127 spread
 * linearly over the master clock's 30–240 BPM (the default step 54 gives 119 BPM). M p.36: the
 * display shows BPM, the arpeggiator plays 1/8 notes.
 */
export function arpFreeBpm(step: number): number {
  const s = Math.min(RATE_STEPS - 1, Math.max(0, step));
  return BPM_MIN + (s * (BPM_MAX - BPM_MIN)) / (RATE_STEPS - 1);
}

/** Seconds of one free-running arpeggiator step: an eighth note at arpFreeBpm (M p.36). */
export function arpFreeStepSeconds(step: number): number {
  return beatSeconds(arpFreeBpm(step)) / 2;
}

/** Field labels: one option per stored step. */
export interface RateOption {
  readonly value: number;
  readonly label: string;
}

/** The free arpeggiator rate of every step as 'N bpm'. */
export const ARP_FREE_OPTIONS: readonly RateOption[] = Array.from({ length: RATE_STEPS },
  (_, v) => ({ value: v, label: `${Math.round(arpFreeBpm(v))} bpm` }));

/** The division of every step, for a rate synced to the master clock. */
export function divisionOptions(list: readonly ClockDivision[]): RateOption[] {
  return Array.from({ length: RATE_STEPS }, (_, v) => ({ value: v, label: divisionOf(v, list).label }));
}

/** The stored step itself, for a rate without labels (the free LFO rate). */
export const RAW_RATE_OPTIONS: readonly RateOption[] = Array.from({ length: RATE_STEPS },
  (_, v) => ({ value: v, label: String(v) }));

/**
 * Tap tempo (M p.17, 40: tap at least four times, keep tapping to refine). The tempo is 60 over the
 * mean interval of the last taps (up to eight), rounded to a whole BPM and kept in 30–240. A gap
 * longer than 2.5 s (the slowest beat plus a quarter) starts a new series.
 */
export class TapTempo {
  static readonly MIN_TAPS = 4;
  static readonly MAX_TAPS = 8;
  /** A quarter longer than the slowest beat, so tapping 30 BPM with a little jitter still counts. */
  static readonly MAX_GAP = (60 / BPM_MIN) * 1.25;
  /** Taps closer than half the fastest tempo's beat are one tap (a bounce, a key's auto-repeat). */
  static readonly MIN_GAP = 30 / BPM_MAX;
  #taps: number[] = [];

  /**
   * Record a tap at `seconds` (any monotonic clock); returns the tempo once there are enough taps,
   * else null. A tap too close to the previous one is ignored.
   */
  tap(seconds: number): number | null {
    const last = this.#taps.at(-1);
    if (last !== undefined && seconds - last >= 0 && seconds - last < TapTempo.MIN_GAP) return null;
    if (last !== undefined && (seconds - last > TapTempo.MAX_GAP || seconds < last)) this.#taps = [];
    this.#taps.push(seconds);
    if (this.#taps.length > TapTempo.MAX_TAPS) this.#taps.shift();
    if (this.#taps.length < TapTempo.MIN_TAPS) return null;
    const span = this.#taps.at(-1)! - this.#taps[0]!;
    const bpm = (60 * (this.#taps.length - 1)) / span;
    return Math.min(BPM_MAX, Math.max(BPM_MIN, Math.round(bpm)));
  }

  /** Taps in the current series. */
  get count(): number {
    return this.#taps.length;
  }

  reset(): void {
    this.#taps = [];
  }
}
