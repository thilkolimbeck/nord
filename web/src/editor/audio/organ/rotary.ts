/**
 * An approximated rotary speaker for the organ (M p.53, 58; plan section 13.2):
 *
 *   input ─► attenuator ─► drive WaveShaper ─► post gain ─┬─► high-pass 800 Hz (horn) ─┐
 *                                                         └─► low-pass 800 Hz (drum) ──┤
 *   per rotor and microphone: band ─► DelayNode (2 ms ± dev) ─► AM GainNode ─► mic bus ┘
 *   left mic bus ─► StereoPanner −1 ─► out;  right mic bus ─► StereoPanner +1 ─► out
 *
 * Each rotor turns two OscillatorNodes (sine and cosine) with the same frequency automation, so
 * the two microphones see the rotation 90° apart; the rotation sweeps each microphone's delay
 * (Doppler) and gain (AM). Speeds ramp with setTargetAtTime; with Stop mode and slow the rotors
 * ramp to 0 Hz and stay where they stop ("Free"). The stop preset and stored angles are not
 * applied. Horn/drum balance 50/50 (the Sound menu default, M p.58). All numbers are guesses.
 */
import type { Ns4Key } from '../../model/keys.ts';
import type { ValueReader } from '../../model/labels.ts';
import {
  driveLabel, drivePreGain, type MicSpec, micSpec, type Rotor, ROTOR_SPEEDS, rotorTargets, rotorTau,
} from './params.ts';

const SMOOTH = 0.01;
const CENTRE = 0.002;
const CROSSOVER = 800;
/** The drive curve covers inputs up to ±DOMAIN; the attenuator before it scales by 1/DOMAIN. */
const DOMAIN = 4;
const CURVE_POINTS = 1024;

/** The drive transfer curve over u in −1..1 (input u × DOMAIN): linear at label 0, else tanh(pre·x)/√pre. */
export function driveCurve(label: number, n = CURVE_POINTS): Float32Array<ArrayBuffer> {
  const pre = drivePreGain(label);
  const post = 1 / Math.sqrt(pre);
  const out = new Float32Array(new ArrayBuffer(n * 4));
  for (let i = 0; i < n; i++) {
    const x = ((i / (n - 1)) * 2 - 1) * DOMAIN;
    out[i] = label <= 0 ? x : Math.tanh(pre * x) * post;
  }
  return out;
}

/** A reader that also gives a field's effective value unrounded (model/morph.ts MorphedValues). */
interface FractionReader extends ValueReader {
  fraction(key: Ns4Key): number;
}

function hasFraction(values: ValueReader): values is FractionReader {
  return typeof (values as Partial<FractionReader>).fraction === 'function';
}

/**
 * The rotor speeds with the speed switch's morph (plan section 15.2): the Stage 4's morph on
 * Rotary Speed reaches "speeds other than just fast, slow or stopped" (M p.53, p.39). The switch's
 * effective value unrounded (0 slow … 1 fast) interpolates linearly between the slow target (0 Hz
 * with Stop mode, as rotorTargets) and the fast speed; the curve is a guess (unverified). A reader
 * without `fraction` (the plain store) and the resting positions 0 and 1 give rotorTargets exactly.
 */
export function morphedRotorTargets(values: ValueReader): Readonly<Record<Rotor, number>> {
  if (!hasFraction(values)) return rotorTargets(values);
  const raw = values.fraction('organ.effectsLeslieSpeed');
  const f = Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : 0;
  if (f === 0 || f === 1) return rotorTargets(values);
  const stop = values.get('organ.effectsLeslieStopMode') !== 0;
  const at = (rotor: Rotor): number => {
    const slow = stop ? 0 : ROTOR_SPEEDS[rotor].slow;
    return slow + (ROTOR_SPEEDS[rotor].fast - slow) * f;
  };
  return { horn: at('horn'), drum: at('drum') };
}

interface Mic {
  readonly delay: DelayNode;
  readonly dev: GainNode;
  readonly am: GainNode;
  readonly amDepth: GainNode;
}

class RotorNodes {
  readonly sin: OscillatorNode;
  readonly cos: OscillatorNode;
  readonly band: BiquadFilterNode;
  readonly mics: readonly [Mic, Mic];
  target: number;

  constructor(ctx: BaseAudioContext, type: BiquadFilterType, speed: number, left: AudioNode, right: AudioNode) {
    this.target = speed;
    this.band = ctx.createBiquadFilter();
    this.band.type = type;
    this.band.frequency.value = CROSSOVER;
    this.band.Q.value = Math.SQRT1_2;
    this.sin = ctx.createOscillator();
    this.sin.type = 'sine';
    this.cos = ctx.createOscillator();
    this.cos.setPeriodicWave(ctx.createPeriodicWave([0, 1], [0, 0]));
    const mic = (rotation: OscillatorNode, bus: AudioNode): Mic => {
      const delay = ctx.createDelay(0.01);
      delay.delayTime.value = CENTRE;
      const dev = ctx.createGain();
      const am = ctx.createGain();
      const amDepth = ctx.createGain();
      rotation.connect(dev).connect(delay.delayTime);
      rotation.connect(amDepth).connect(am.gain);
      this.band.connect(delay).connect(am).connect(bus);
      return { delay, dev, am, amDepth };
    };
    this.mics = [mic(this.sin, left), mic(this.cos, right)];
    const t = ctx.currentTime;
    for (const o of [this.sin, this.cos]) {
      o.frequency.value = speed;
      o.start(t);
    }
  }

  setDepth(dev: number, depth: number, t: number): void {
    for (const m of this.mics) {
      m.dev.gain.setTargetAtTime(dev, t, SMOOTH);
      m.am.gain.setTargetAtTime(1 - depth / 2, t, SMOOTH);
      m.amDepth.gain.setTargetAtTime(depth / 2, t, SMOOTH);
    }
  }

  setSpeed(hz: number, tau: number | null, t: number): void {
    for (const o of [this.sin, this.cos]) {
      if (tau === null) {
        o.frequency.cancelScheduledValues(t);
        o.frequency.setValueAtTime(hz, t);
      } else o.frequency.setTargetAtTime(hz, t, tau);
    }
    this.target = hz;
  }

  dispose(): void {
    this.sin.stop();
    this.cos.stop();
    for (const n of [this.sin, this.cos, this.band, ...this.mics.flatMap((m) => [m.delay, m.dev, m.am, m.amDepth])]) {
      n.disconnect();
    }
  }
}

export class Rotary {
  readonly input: GainNode;
  readonly #ctx: BaseAudioContext;
  readonly #shaper: WaveShaperNode;
  readonly #post: GainNode;
  readonly #left: GainNode;
  readonly #right: GainNode;
  readonly #panL: StereoPannerNode;
  readonly #panR: StereoPannerNode;
  readonly #rotors: Readonly<Record<Rotor, RotorNodes>>;
  #drive = -1;

  constructor(ctx: BaseAudioContext, out: AudioNode, values: ValueReader) {
    this.#ctx = ctx;
    this.input = ctx.createGain();
    this.input.gain.value = 1 / DOMAIN;
    this.#shaper = ctx.createWaveShaper();
    this.#post = ctx.createGain();
    this.#left = ctx.createGain();
    this.#right = ctx.createGain();
    this.#panL = ctx.createStereoPanner();
    this.#panL.pan.value = -1;
    this.#panR = ctx.createStereoPanner();
    this.#panR.pan.value = 1;
    this.input.connect(this.#shaper).connect(this.#post);
    this.#left.connect(this.#panL).connect(out);
    this.#right.connect(this.#panR).connect(out);
    const speeds = rotorTargets(values);
    this.#rotors = {
      horn: new RotorNodes(ctx, 'highpass', speeds.horn, this.#left, this.#right),
      drum: new RotorNodes(ctx, 'lowpass', speeds.drum, this.#left, this.#right),
    };
    for (const r of Object.values(this.#rotors)) this.#post.connect(r.band);
    this.refresh(values, true);
  }

  /** The speed each rotor is heading for, in Hz. */
  get targets(): Readonly<Record<Rotor, number>> {
    return { horn: this.#rotors.horn.target, drum: this.#rotors.drum.target };
  }

  /**
   * Follow the speed and stop switches: ramp each rotor from its current target to the new one.
   * With a morph on the speed switch the reader's fraction sets a speed between slow and fast
   * (morphedRotorTargets; M p.53; plan section 15.2).
   */
  updateSpeed(values: ValueReader, t: number, immediate = false): void {
    const next = morphedRotorTargets(values);
    for (const rotor of ['horn', 'drum'] as const) {
      const r = this.#rotors[rotor];
      if (!immediate && r.target === next[rotor]) continue;
      r.setSpeed(next[rotor], immediate ? null : rotorTau(rotor, r.target, next[rotor]), t);
    }
  }

  updateMic(values: ValueReader, t: number): void {
    const m: MicSpec = micSpec(values);
    this.#rotors.horn.setDepth(m.hornDev, m.hornDepth, t);
    this.#rotors.drum.setDepth(m.drumDev, m.drumDepth, t);
  }

  /** Drive (M p.53): a new curve when the label changes. The attenuator and curve keep unity gain at label 0. */
  updateDrive(values: ValueReader): void {
    const label = driveLabel(values);
    if (label === this.#drive) return;
    this.#drive = label;
    this.#shaper.curve = driveCurve(label);
  }

  /** Every parameter from the values; `immediate` jumps the rotors to their speeds (a program load). */
  refresh(values: ValueReader, immediate: boolean): void {
    const t = this.#ctx.currentTime;
    this.updateSpeed(values, t, immediate);
    this.updateMic(values, t);
    this.updateDrive(values);
  }

  dispose(): void {
    for (const r of Object.values(this.#rotors)) r.dispose();
    for (const n of [this.input, this.#shaper, this.#post, this.#left, this.#right, this.#panL, this.#panR]) n.disconnect();
  }
}
