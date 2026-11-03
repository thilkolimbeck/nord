/**
 * Envelope math of the Stage 4 synth envelopes (attack, decay, release; a decay at its maximum
 * 'inf' holds), plan section 4.1. Pure: the voice turns the steps into AudioParam automation and
 * computes the level at any time itself, because cancelAndHoldAtTime is missing in some
 * browsers and AudioParam values are never read back.
 *
 * Shape: a linear attack from `from` to `peak`, then an exponential decay towards 0 whose table
 * time is the time to fall 40 dB (time constant decay / 4.6), and on release an exponential fall
 * from the level reached, with the release time likewise taken as the time to -40 dB.
 */

/** ln(100): a table time is taken as the time to fall 40 dB, so the time constant is time / 4.6. */
export const TAU_DIVISOR = Math.log(100);
/** A voice counts as silent below -80 dB of full scale. */
export const SILENCE = 1e-4;

export interface EnvSchedule {
  /** When the attack starts (seconds, context time). */
  readonly start: number;
  /** Seconds; 0 jumps to the peak. */
  readonly attack: number;
  /** Seconds to -40 dB; Infinity holds the peak. */
  readonly decay: number;
  /** Key-up time, or null while held. */
  readonly releaseAt: number | null;
  /** Seconds to -40 dB after key-up. */
  readonly release: number;
  readonly peak: number;
  /** The level the attack starts from (a retrigger starts where the envelope was). Default 0. */
  readonly from?: number;
}

export type EnvStep =
  | { readonly kind: 'set'; readonly time: number; readonly value: number }
  | { readonly kind: 'linear'; readonly time: number; readonly value: number }
  | { readonly kind: 'target'; readonly time: number; readonly target: number; readonly tau: number };

function tau(seconds: number): number {
  return seconds / TAU_DIVISOR;
}

/** The level before any release: attack, then decay or hold. */
function heldValueAt(s: EnvSchedule, t: number): number {
  const from = s.from ?? 0;
  if (t < s.start) return from;
  const dt = t - s.start;
  if (s.attack > 0 && dt < s.attack) return from + (s.peak - from) * (dt / s.attack);
  if (s.decay === Infinity) return s.peak;
  const intoDecay = dt - Math.max(0, s.attack);
  if (s.decay <= 0) return intoDecay <= 0 ? s.peak : 0;
  return s.peak * Math.exp(-intoDecay / tau(s.decay));
}

/** The envelope level at time t (seconds, context time), release included. */
export function envValueAt(s: EnvSchedule, t: number): number {
  if (s.releaseAt === null || t < s.releaseAt) return heldValueAt(s, t);
  const v0 = heldValueAt(s, s.releaseAt);
  if (s.release <= 0) return 0;
  return v0 * Math.exp(-(t - s.releaseAt) / tau(s.release));
}

/** When the level falls below `floor` for good; Infinity while a holding envelope is held. */
export function envEndTime(s: EnvSchedule, floor: number = SILENCE): number {
  if (s.releaseAt !== null) {
    const v0 = heldValueAt(s, s.releaseAt);
    if (v0 <= floor || s.release <= 0) return s.releaseAt;
    return s.releaseAt + tau(s.release) * Math.log(v0 / floor);
  }
  if (s.decay === Infinity) return Infinity;
  const decayStart = s.start + Math.max(0, s.attack);
  if (s.peak <= floor || s.decay <= 0) return decayStart;
  return decayStart + tau(s.decay) * Math.log(s.peak / floor);
}

/** Automation for a note start: set the start level, ramp to the peak, decay (unless it holds). */
export function attackSteps(s: EnvSchedule): EnvStep[] {
  const from = s.from ?? 0;
  const steps: EnvStep[] = [{ kind: 'set', time: s.start, value: from }];
  const peakAt = s.start + Math.max(0, s.attack);
  if (s.attack > 0) steps.push({ kind: 'linear', time: peakAt, value: s.peak });
  else steps.push({ kind: 'set', time: peakAt, value: s.peak });
  if (s.decay !== Infinity) {
    if (s.decay <= 0) steps.push({ kind: 'set', time: peakAt, value: 0 });
    else steps.push({ kind: 'target', time: peakAt, target: 0, tau: tau(s.decay) });
  }
  return steps;
}

/**
 * Automation for key-up at `releaseAt` (the caller cancels the events from that time first):
 * set the level the envelope has reached, then fall towards 0.
 */
export function releaseSteps(s: EnvSchedule & { readonly releaseAt: number }): EnvStep[] {
  const v0 = heldValueAt(s, s.releaseAt);
  if (s.release <= 0) return [{ kind: 'set', time: s.releaseAt, value: 0 }];
  return [{ kind: 'set', time: s.releaseAt, value: v0 }, { kind: 'target', time: s.releaseAt, target: 0, tau: tau(s.release) }];
}
