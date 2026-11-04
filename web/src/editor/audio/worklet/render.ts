/**
 * Block renderers of the two worklet processors (plan section 15.7, protocol.ts), pure so Node can
 * test them: the processor (processor.ts) only unpacks the AudioWorklet's arrays and messages and
 * calls these. One renderer per AudioWorkletNode, one block (usually 128 frames) per call.
 *
 * - OscRenderer ('nord-osc'): a voice's unison copies of one worklet oscillator (dsp.ts cores),
 *   detuned and panned like the native graph (oscillators.ts: 1/√copies, equal-power pans), pitch
 *   and osc ctrl per sample; silence from the 'end' time on, then done.
 * - FilterRenderer ('nord-filter'): the drive stage alone ('drive') or the drive into the LP M
 *   ladder ('ladder'), 2× oversampled (linear interpolation up, two-point average down: about
 *   −1.5 dB at 10 kHz), cutoff per sample: the frequency parameter × 2^(detune / 1200).
 */
import {
  BlepLine, driveSample, Ladder, LADDER_COMPENSATION, LADDER_FEEDBACK, ladderCoefficient, makeCore, MAX_INC, type OscCore,
} from './dsp.ts';
import type { FilterMode, OscOptions, ToProcessor, WorkletOscKind } from './protocol.ts';
import { rng, spreadOffsets } from '../waveforms.ts';

const A4 = 440;

/** A parameter's value at frame i: AudioWorklet arrays hold one value when constant over the block. */
function at(values: Float32Array, i: number): number {
  return values.length > 1 ? values[i]! : values[0]!;
}

interface Copy {
  core: OscCore;
  readonly line: BlepLine;
  readonly ratio: number;
  readonly left: number;
  readonly right: number;
}

export class OscRenderer {
  readonly #sampleRate: number;
  readonly #random: () => number;
  readonly #copies: Copy[];
  #endAt = Infinity;
  #done = false;
  #cents = Number.NaN;
  #dt = 0;

  constructor(options: OscOptions, sampleRate: number) {
    this.#sampleRate = sampleRate;
    this.#random = rng(options.seed);
    const n = options.copies;
    const detunes = spreadOffsets(n, options.spreadCents);
    const pans = spreadOffsets(n, 0.6);
    const norm = 1 / Math.sqrt(n);
    this.#copies = detunes.map((cents, i) => {
      // One copy plays both channels in full (a mono node upmixed); copies pan equal-power (StereoPannerNode).
      const angle = ((pans[i]! + 1) * Math.PI) / 4;
      return {
        core: this.#core(options.kind, options.wave, n, i),
        line: new BlepLine(),
        ratio: 2 ** (cents / 1200),
        left: n === 1 ? 1 : Math.cos(angle) * norm,
        right: n === 1 ? 1 : Math.sin(angle) * norm,
      };
    });
  }

  /** Whether the voice has ended (every later block is silence). */
  get done(): boolean {
    return this.#done;
  }

  /** The audio time from which the output is silent (Infinity until the voice posts 'end'). */
  get endAt(): number {
    return this.#endAt;
  }

  #core(kind: WorkletOscKind, wave: number, copies: number, index: number): OscCore {
    // The first copy starts at phase 0 like a native oscillator; the others at seeded random phases.
    return makeCore(kind, wave, copies, index === 0 ? 0 : this.#random(), this.#random);
  }

  /** A port message: another wave of a worklet kind, or the end of the voice (the latest end wins). */
  message(m: ToProcessor): void {
    if (m.type === 'end') {
      this.#endAt = m.at;
      return;
    }
    const n = this.#copies.length;
    this.#copies.forEach((c, i) => {
      c.core = this.#core(m.kind, m.wave, n, i);
    });
  }

  /**
   * Render one block: `pitch` in cents re A4 and `ctrl` (0..1, clamped) per frame or constant,
   * `time` the audio time of the first frame. Returns false once the voice has ended.
   */
  render(left: Float32Array, right: Float32Array, pitch: Float32Array, ctrl: Float32Array, time: number): boolean {
    const n = left.length;
    let stop = this.#done ? 0 : n;
    if (!this.#done && Number.isFinite(this.#endAt)) {
      // The first frame at or after the end time (a hair of tolerance for float error in the times).
      stop = Math.max(0, Math.min(n, Math.ceil((this.#endAt - time) * this.#sampleRate - 1e-6)));
    }
    const sr = this.#sampleRate;
    for (let i = 0; i < stop; i++) {
      const cents = at(pitch, i);
      if (cents !== this.#cents) {
        this.#cents = cents;
        const dt = (A4 * 2 ** (cents / 1200)) / sr;
        this.#dt = Number.isFinite(dt) ? Math.min(Math.max(dt, 0), MAX_INC) : 0;
      }
      const c = at(ctrl, i);
      const ctl = c < 0 ? 0 : c > 1 ? 1 : c;
      let l = 0;
      let r = 0;
      for (const copy of this.#copies) {
        const v = copy.line.push(copy.core.next(Math.min(this.#dt * copy.ratio, MAX_INC), ctl, copy.line));
        l += copy.left * v;
        r += copy.right * v;
      }
      left[i] = l;
      right[i] = r;
    }
    left.fill(0, stop);
    right.fill(0, stop);
    if (stop < n) this.#done = true;
    return !this.#done;
  }
}

/** How long the filter keeps rendering after its input went away (its resonance rings out). */
const FILTER_TAIL_SECONDS = 0.25;

export class FilterRenderer {
  readonly #mode: FilterMode;
  readonly #sampleRate: number;
  readonly #ladders = [new Ladder(), new Ladder()];
  readonly #prev = [0, 0];
  #coef = new Float64Array(128);
  #hz = Number.NaN;
  #cents = Number.NaN;
  #f = 0;
  #tail: number;
  /** Whether both input channels carried the same signal so far (one copy: the second channel is a copy). */
  #linked = true;

  constructor(mode: FilterMode, sampleRate: number) {
    this.#mode = mode;
    this.#sampleRate = sampleRate;
    this.#tail = Math.ceil(FILTER_TAIL_SECONDS * sampleRate);
  }

  /**
   * Render one block. `inputs` are the input's channels (none once the voice let go: the tail
   * rings out, then the renderer reports false); a mono input plays on both outputs.
   */
  render(inputs: readonly Float32Array[], left: Float32Array, right: Float32Array, frequency: Float32Array,
    detune: Float32Array, resonance: number, drive: number): boolean {
    const n = left.length;
    const ladder = this.#mode === 'ladder';
    const k = (resonance > 0 ? Math.min(resonance, 1) : 0) * LADDER_FEEDBACK;
    const comp = 1 + LADDER_COMPENSATION * k;
    const gain = drive > 16 ? 16 : drive;
    if (ladder) {
      if (this.#coef.length < n) this.#coef = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        const hz = at(frequency, i);
        const cents = at(detune, i);
        if (hz !== this.#hz || cents !== this.#cents) {
          this.#hz = hz;
          this.#cents = cents;
          const f = ladderCoefficient(hz * 2 ** (cents / 1200), this.#sampleRate);
          this.#f = Number.isFinite(f) ? f : this.#f;
        }
        this.#coef[i] = this.#f;
      }
    }
    let channels = inputs.length >= 2 ? 2 : 1;
    if (channels === 2 && this.#linked) {
      const a = inputs[0]!;
      const b = inputs[1]!;
      let same = true;
      for (let i = 0; i < n && same; i++) same = a[i] === b[i];
      if (same) channels = 1;
      else this.#linked = false;
    }
    for (let ch = 0; ch < channels; ch++) {
      const input = inputs[ch];
      const out = ch === 0 ? left : right;
      const lad = this.#ladders[ch]!;
      let prev = this.#prev[ch]!;
      for (let i = 0; i < n; i++) {
        const x = input === undefined ? 0 : input[i]!;
        const a = driveSample(0.5 * (prev + x), gain);
        const b = driveSample(x, gain);
        prev = x;
        if (ladder) {
          const f = this.#coef[i]!;
          out[i] = 0.5 * (lad.step(a * comp, f, k) + lad.step(b * comp, f, k));
        } else {
          out[i] = 0.5 * (a + b);
        }
      }
      this.#prev[ch] = Math.abs(prev) < 1e-15 ? 0 : prev;
      lad.flush();
    }
    if (channels === 1) {
      right.set(left.subarray(0, n));
      if (this.#linked) {
        this.#ladders[1]!.copyFrom(this.#ladders[0]!);
        this.#prev[1] = this.#prev[0]!;
      }
    }
    if (inputs.length > 0) {
      this.#tail = Math.ceil(FILTER_TAIL_SECONDS * this.#sampleRate);
      return true;
    }
    this.#tail -= n;
    return this.#tail > 0;
  }
}
