/**
 * Waveform math for the native oscillators (plan section 4.1), pure so Node can test it: one-cycle
 * shapes, their Fourier coefficients for PeriodicWave, the synced and shaped-sine cycles that the
 * engine renders as static waves per osc ctrl value (marked coarse), detune spreads for stacks,
 * and seeded noise. The shapes of Sync Chop, Shape Sine and the stack intervals follow the wave
 * names in the Stage 4 tables and manual p.29–30; their exact curves are guesses.
 */

export const CYCLE = 2048;
export const HARMONICS = 128;

export type BasicShape = 'sine' | 'triangle' | 'saw' | 'square' | 'pulse33' | 'pulse10';

/** One basic shape at phase p in [0, 1), amplitude ±1. */
export function basic(shape: BasicShape, p: number): number {
  const x = p - Math.floor(p);
  switch (shape) {
    case 'sine': return Math.sin(2 * Math.PI * x);
    case 'triangle': return x < 0.25 ? 4 * x : x < 0.75 ? 2 - 4 * x : 4 * x - 4;
    case 'saw': return 2 * x - 1;
    case 'square': return x < 0.5 ? 1 : -1;
    case 'pulse33': return x < 1 / 3 ? 1 : -1;
    case 'pulse10': return x < 0.1 ? 1 : -1;
  }
}

export interface Coefficients {
  readonly real: Float32Array;
  readonly imag: Float32Array;
}

/** Fourier coefficients of one sampled cycle: x(t) = Σ real[k]·cos(2πkt) + imag[k]·sin(2πkt); DC dropped. */
export function toCoefficients(samples: ArrayLike<number>, harmonics: number = HARMONICS): Coefficients {
  const n = samples.length;
  const real = new Float32Array(harmonics + 1);
  const imag = new Float32Array(harmonics + 1);
  for (let k = 1; k <= harmonics; k++) {
    let re = 0;
    let im = 0;
    const w = (2 * Math.PI * k) / n;
    for (let i = 0; i < n; i++) {
      re += samples[i]! * Math.cos(w * i);
      im += samples[i]! * Math.sin(w * i);
    }
    real[k] = (2 / n) * re;
    imag[k] = (2 / n) * im;
  }
  return { real, imag };
}

/** One cycle of `fn(phase)`. */
export function cycle(fn: (p: number) => number, n: number = CYCLE): Float32Array {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = fn(i / n);
  return out;
}

/** Sync waves in table order: Sine, Triangle, Saw, Square, Pulse 33, Pulse 10, Chop Saw 1, Chop Saw 2, Chop Square. */
const SYNC_SHAPES: readonly BasicShape[] = ['sine', 'triangle', 'saw', 'square', 'pulse33', 'pulse10', 'saw', 'saw', 'square'];

/** The synced slave frequency for osc ctrl 0..1: 1× to 8× the master (a guess). */
export function syncRatio(ctrl: number): number {
  return 1 + 7 * Math.min(1, Math.max(0, ctrl));
}

/**
 * One master cycle of a hard-synced slave. Chop variants scale the slave by a falling ramp
 * (Chop Saw 1), a half-cycle gate (Chop Saw 2) or a falling ramp on a square (Chop Square).
 */
export function syncSample(wave: number, ctrl: number, p: number): number {
  const shape = SYNC_SHAPES[wave] ?? 'saw';
  const slave = basic(shape, p * syncRatio(ctrl));
  if (wave === 6 || wave === 8) return slave * (1 - p);
  if (wave === 7) return p < 0.5 ? slave : 0;
  return slave;
}

/**
 * Shape Sine waves in table order: Saw, Square, Pulse, Squeeze, Fold, ESaw, ESquare. Osc ctrl
 * 0 is a plain sine for all of them; 1 is the strongest shaping (a guess at each curve).
 */
export function shapeSineSample(wave: number, ctrl: number, p: number): number {
  const c = Math.min(1, Math.max(0, ctrl));
  const x = p - Math.floor(p);
  const sine = Math.sin(2 * Math.PI * x);
  switch (wave) {
    case 0: { // phase distortion towards a saw
      const knee = 0.5 - 0.48 * c;
      const q = x < knee ? (0.5 * x) / knee : 0.5 + (0.5 * (x - knee)) / (1 - knee);
      return Math.sin(2 * Math.PI * q);
    }
    case 1: { // soft clip towards a square
      const g = 20 * c;
      return g < 1e-6 ? sine : Math.tanh(g * sine) / Math.tanh(g);
    }
    case 2: { // the sine squeezed into a narrower part of the cycle
      const w = 1 - 0.9 * c;
      return x < w ? Math.sin((2 * Math.PI * x) / w) : 0;
    }
    case 3: { // squeeze: sharpened peaks
      return Math.sign(sine) * Math.abs(sine) ** (1 + 7 * c);
    }
    case 4: { // wave folder: the sine amplified and reflected back at ±1
      const t = ((((1 + 6 * c) * sine + 1) % 4) + 4) % 4;
      return t < 2 ? t - 1 : 3 - t;
    }
    case 5: // crossfade sine → saw
      return (1 - c) * sine + c * basic('saw', x + 0.5);
    case 6: // crossfade sine → square
      return (1 - c) * sine + c * basic('square', x);
    default:
      return sine;
  }
}

/** Shape waves in table order: Triangle, Saw, Square, Half Sine, Parabolic. */
export function shapeBase(wave: number, p: number): number {
  const x = p - Math.floor(p);
  switch (wave) {
    case 0: return basic('triangle', x);
    case 1: return basic('saw', x);
    case 2: return basic('square', x);
    case 3: return 2 * Math.abs(Math.sin(Math.PI * x)) - 1;
    case 4: return 1 - 8 * (x - 0.5) ** 2; // parabola, -1 at the ends, +1 in the middle
    default: return basic('saw', x);
  }
}

/** Symmetric offsets for an n-voice stack: -1 … +1 times `spread` (0 for a single voice). */
export function spreadOffsets(n: number, spread: number): number[] {
  if (n <= 1) return [0];
  return Array.from({ length: n }, (_, i) => spread * ((2 * i) / (n - 1) - 1));
}

/**
 * Multi waves in table order: Saw, Saw 8ve, Saw 5th, Saw 5th+, Saw 8ve 8ve+, Saw 8ve 5th+. The
 * intervals (cents) of the saws in the stack; osc ctrl detunes them against each other.
 */
export function multiIntervals(wave: number): number[] {
  switch (wave) {
    case 0: return [0, 0];
    case 1: return [0, 1200];
    case 2: return [0, 700];
    case 3: return [0, 700, 1200];
    case 4: return [0, 1200, 2400];
    case 5: return [0, 1200, 1900];
    default: return [0, 0];
  }
}

/** A small seeded generator (mulberry32), so noise buffers are reproducible. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type NoiseColour = 'white' | 'pink' | 'red';

/** `length` samples of noise, peak-normalised to ±0.9. Pink: Paul Kellet's filter; red: a leaky integrator. */
export function noise(colour: NoiseColour, length: number, seed = 1): Float32Array {
  const next = rng(seed);
  const out = new Float32Array(length);
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0, red = 0;
  for (let i = 0; i < length; i++) {
    const w = next() * 2 - 1;
    if (colour === 'white') out[i] = w;
    else if (colour === 'pink') {
      b0 = 0.99886 * b0 + w * 0.0555179;
      b1 = 0.99332 * b1 + w * 0.0750759;
      b2 = 0.969 * b2 + w * 0.153852;
      b3 = 0.8665 * b3 + w * 0.3104856;
      b4 = 0.55 * b4 + w * 0.5329522;
      b5 = -0.7616 * b5 - w * 0.016898;
      out[i] = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362;
      b6 = w * 0.115926;
    } else {
      red = 0.98 * red + 0.02 * w;
      out[i] = red;
    }
  }
  let peak = 0;
  for (let i = 0; i < length; i++) peak = Math.max(peak, Math.abs(out[i]!));
  if (peak > 0) for (let i = 0; i < length; i++) out[i] = (out[i]! / peak) * 0.9;
  return out;
}

/** A soft-clip transfer curve tanh(g·x)/tanh(g) over x in -1..1, for WaveShaperNode. */
export function tanhCurve(gain: number, n = 1024): Float32Array<ArrayBuffer> {
  const out = new Float32Array(new ArrayBuffer(n * 4));
  const norm = Math.tanh(gain);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    out[i] = Math.tanh(gain * x) / norm;
  }
  return out;
}
