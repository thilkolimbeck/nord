/**
 * Harmonic spectra of the organ models that use one oscillator per voice or per footage (plan
 * section 13.2): Vox and Farf waves on the 16′ grid, the two pipe timbres, and the peak of a
 * spectrum for loudness. Coefficients are sine terms (imag) for `createPeriodicWave` with
 * normalisation off, so drawbar levels keep their loudness. Every timbre is invented: the manual
 * names the registers, not their sound. Pure: no Web Audio.
 */
import { drawbarLevel, FARF_REGISTERS, type FarfTimbre, farfRegisterOn, VOX_RATIOS } from './params.ts';

export interface Spectrum {
  readonly real: number[];
  readonly imag: number[];
}

/** Highest harmonic index a wave on the 16′ grid may hold. */
const MAX_INDEX = 256;
/** Components above this share of the sample rate are dropped. */
const BAND = 0.45;

function maxIndex(f16: number, sampleRate: number): number {
  return Math.max(1, Math.min(MAX_INDEX, Math.floor((BAND * sampleRate) / Math.max(f16, 1e-3))));
}

function empty(n: number): Spectrum {
  return { real: new Array<number>(n + 1).fill(0), imag: new Array<number>(n + 1).fill(0) };
}

/**
 * Vox (M p.20): partial drawbar k at ratio r_k adds a buzzy series, harmonic j of that footage at
 * level_k / j (j ≤ 16). `f16` is the frequency of the 16′ fundamental.
 */
export function voxSpectrum(positions: readonly number[], f16: number, sampleRate: number): Spectrum {
  const top = maxIndex(f16, sampleRate);
  const s = empty(top);
  VOX_RATIOS.forEach((ratio, k) => {
    const level = drawbarLevel(positions[k] ?? 0);
    if (level === 0) return;
    for (let j = 1; j <= 16 && ratio * j <= top; j++) s.imag[ratio * j]! += level / j;
  });
  return s;
}

/** Harmonic j's amplitude of a Farf register timbre; 0 beyond its range. */
export function farfHarmonic(timbre: FarfTimbre, j: number): number {
  switch (timbre) {
    case 'bass': return j % 2 === 1 && j <= 15 ? 1 / (j * j) : 0; // soft, odd harmonics
    case 'strings': return j > 16 ? 0 : j <= 2 ? 0.3 : 1 / j ** 0.7; // bright and thin
    case 'flute': return j === 1 ? 1 : j === 2 ? 0.15 : 0; // nearly sine
    case 'oboe': return j > 16 ? 0 : (j >= 2 && j <= 5 ? 1.5 : 1) / j; // reedy
    case 'trumpet': return j <= 12 ? 1 / j : 0; // brassy
    case 'bright': return j <= 16 ? 1 / j ** 0.8 : 0;
  }
}

/**
 * Farf (M p.20–21): the active registers (drawbar ≥ 5) at their footage, summed at equal level and
 * scaled by 1/√(active count).
 */
export function farfSpectrum(positions: readonly number[], f16: number, sampleRate: number): Spectrum {
  const top = maxIndex(f16, sampleRate);
  const s = empty(top);
  const active = FARF_REGISTERS.filter((_, k) => farfRegisterOn(positions[k] ?? 0));
  if (active.length === 0) return s;
  const scale = 1 / Math.sqrt(active.length);
  for (const r of active) {
    for (let j = 1; r.ratio * j <= top; j++) {
      const a = farfHarmonic(r.timbre, j);
      if (j > 16 && a === 0) break;
      s.imag[r.ratio * j]! += a * scale;
    }
  }
  return s;
}

/** Pipe 1, an all-purpose flue: sine plus 10 % 2nd harmonic. Pipe 2, a principal: 1/j^1.5 up to j = 8 (M p.21; guesses). */
export function pipeSpectrum(model: 'pipe1' | 'pipe2'): Spectrum {
  if (model === 'pipe1') return { real: [0, 0, 0], imag: [0, 1, 0.1] };
  const s = empty(8);
  for (let j = 1; j <= 8; j++) s.imag[j] = 1 / j ** 1.5;
  return s;
}

/** The peak of one period of a spectrum, sampled at `n` points. */
export function spectrumPeak(s: Spectrum, n = 512): number {
  let peak = 0;
  for (let i = 0; i < n; i++) {
    const p = (2 * Math.PI * i) / n;
    let y = 0;
    for (let h = 1; h < s.imag.length; h++) {
      const a = s.imag[h]!;
      const b = s.real[h]!;
      if (a !== 0) y += a * Math.sin(h * p);
      if (b !== 0) y += b * Math.cos(h * p);
    }
    peak = Math.max(peak, Math.abs(y));
  }
  return peak;
}

/** Peak of one note on the organ bus with a reference registration; a full registration stays ≤ 1.0. */
const TARGET = 0.5;
const REF_F16 = 65.41; // C2: every harmonic of the reference stays in band
const VOX_REF = spectrumPeak(voxSpectrum([8, 8, 8, 0, 0, 0, 0, 0, 0], REF_F16, 48000));
const FARF_REF = spectrumPeak(farfSpectrum([0, 0, 8, 8, 0, 8, 0, 0, 0], REF_F16, 48000));

/**
 * The output gain of a Vox or Farf voice: a reference registration (Vox: first three drawbars
 * full; Farf: Flute 8, Oboe 8 and Strings 8) peaks at about 0.5, and no registration above 1.0.
 */
export function waveGain(model: 'vox' | 'farf', s: Spectrum): number {
  const peak = spectrumPeak(s, 256);
  if (peak <= 0) return 0;
  return Math.min(TARGET / (model === 'vox' ? VOX_REF : FARF_REF), 1 / peak);
}
