/** Waveform math of the native oscillators: Fourier coefficients, synced and shaped cycles, stacks, noise. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  basic, cycle, multiIntervals, noise, shapeBase, shapeSineSample, spreadOffsets, syncRatio, syncSample, tanhCurve,
  toCoefficients,
} from '../../src/editor/audio/waveforms.ts';

const near = (a: number, b: number, eps: number): void => assert.ok(Math.abs(a - b) <= eps, `${a} ≉ ${b}`);

test('coefficients of a sine and a saw', () => {
  const sine = toCoefficients(cycle((p) => basic('sine', p)), 8);
  near(sine.imag[1]!, 1, 1e-6);
  near(sine.real[1]!, 0, 1e-6);
  near(sine.imag[2]!, 0, 1e-6);
  const saw = toCoefficients(cycle((p) => basic('saw', p)), 8);
  // 2x - 1 has sine coefficients -2/(πk)
  for (let k = 1; k <= 8; k++) near(saw.imag[k]!, -2 / (Math.PI * k), 2e-3);
  assert.equal(saw.real[0], 0);
});

test('every cycle the engine renders is finite and within ±1.0001', () => {
  const fns: Array<(p: number) => number> = [];
  for (let w = 0; w < 9; w++) for (const c of [0, 0.5, 1]) fns.push((p) => syncSample(w, c, p));
  for (let w = 0; w < 7; w++) for (const c of [0, 0.5, 1]) fns.push((p) => shapeSineSample(w, c, p));
  for (let w = 0; w < 5; w++) fns.push((p) => shapeBase(w, p));
  for (const fn of fns) {
    for (const x of cycle(fn, 512)) assert.ok(Number.isFinite(x) && Math.abs(x) <= 1.0001, String(x));
  }
});

test('osc ctrl 0 is the plain wave: no sync, a sine for shape sine', () => {
  assert.equal(syncRatio(0), 1);
  assert.equal(syncRatio(1), 8);
  for (let i = 0; i < 64; i++) {
    const p = i / 64;
    near(syncSample(2, 0, p), basic('saw', p), 1e-12);
    for (let w = 0; w < 7; w++) near(shapeSineSample(w, 0, p), Math.sin(2 * Math.PI * p), 1e-9);
  }
});

test('stack offsets are symmetric; intervals per multi wave', () => {
  assert.deepEqual(spreadOffsets(1, 50), [0]);
  assert.deepEqual(spreadOffsets(3, 10), [-10, 0, 10]);
  assert.deepEqual(multiIntervals(1), [0, 1200]);
  assert.deepEqual(multiIntervals(3), [0, 700, 1200]);
});

test('noise is reproducible, bounded and coloured', () => {
  for (const c of ['white', 'pink', 'red'] as const) {
    const a = noise(c, 4096, 5);
    assert.deepEqual(a, noise(c, 4096, 5));
    let peak = 0;
    for (const x of a) peak = Math.max(peak, Math.abs(x));
    near(peak, 0.9, 1e-6);
  }
  // Red noise changes less from sample to sample than white noise.
  const diff = (x: Float32Array): number => x.reduce((s, v, i) => (i === 0 ? 0 : s + Math.abs(v - x[i - 1]!)), 0);
  assert.ok(diff(noise('red', 4096)) < diff(noise('white', 4096)) / 4);
});

test('the soft-clip curve is odd, monotonic and ends at ±1', () => {
  const c = tanhCurve(4, 101);
  near(c[0]!, -1, 1e-6);
  near(c[100]!, 1, 1e-6);
  near(c[50]!, 0, 1e-6);
  for (let i = 1; i < c.length; i++) assert.ok(c[i]! > c[i - 1]!);
});
