/**
 * The AudioWorklet engine's pure DSP (plan section 15.7, audio/worklet/dsp.ts and render.ts): the
 * PolyBLEP correction (no larger step than the naive wave's, much less energy folded back from
 * above Nyquist), hard-sync resets, Shape, Shape Sine, Multi and Super outputs finite and bounded,
 * the renderers' unison, end and wave messages; the LP M ladder (unity DC gain at resonance 0,
 * self-oscillation near 1, stable over the whole range, 24 dB slope, cutoff modulation) and the
 * drive stage (gains 1, 2, 4, 8 from mapping.ts). Node only: no Web Audio.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { driveGain } from '../../src/editor/audio/mapping.ts';
import { basic, rng, shapeBase, shapeSineSample } from '../../src/editor/audio/waveforms.ts';
import {
  BlepLine, driveSample, type Edges, LADDER_FEEDBACK, makeCore, MAX_INC, type OscCore, passEdges, SHAPE_CODES, shapeAt,
  shapeBaseAt, ShapeCore, ShapeSineCore, softTanh, StackCore, superCount, SyncCore,
} from '../../src/editor/audio/worklet/dsp.ts';
import { WORKLET_OSC_KINDS } from '../../src/editor/audio/worklet/protocol.ts';
import { FilterRenderer, OscRenderer } from '../../src/editor/audio/worklet/render.ts';

const SR = 48000;
const BLOCK = 128;

/** `n` samples of a core at a fixed step and ctrl; with `blep` false the naive wave. */
function run(core: OscCore, dt: number, ctrl: number, n: number, blep = true): Float64Array {
  const line = new BlepLine();
  const ignored = new BlepLine();
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const v = core.next(dt, ctrl, blep ? line : ignored);
    out[i] = blep ? line.push(v) : v;
  }
  return out;
}

/** Share of a periodic signal's energy outside the harmonics of bin `k0` (aliases), by DFT. */
function aliasShare(x: Float64Array, k0: number): number {
  const n = x.length;
  let total = 0;
  let dc = 0;
  for (const v of x) {
    total += v * v;
    dc += v;
  }
  let harmonic = (dc * dc) / n;
  for (let k = k0; k < n / 2; k += k0) {
    let re = 0;
    let im = 0;
    for (let i = 0; i < n; i++) {
      const w = (2 * Math.PI * k * i) / n;
      re += x[i]! * Math.cos(w);
      im -= x[i]! * Math.sin(w);
    }
    harmonic += (2 * (re * re + im * im)) / n;
  }
  return (total - harmonic) / total;
}

/** Whether two renders are sample-for-sample equal (the shim's assert has no notDeepEqual). */
function same(a: ArrayLike<number>, b: ArrayLike<number>): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function maxStep(x: Float64Array): number {
  let m = 0;
  for (let i = 1; i < x.length; i++) m = Math.max(m, Math.abs(x[i]! - x[i - 1]!));
  return m;
}

test('the hot-loop shapes match waveforms.ts', () => {
  for (let i = 0; i < 1000; i++) {
    const x = i / 1000;
    SHAPE_CODES.forEach((shape, code) => assert.ok(Math.abs(shapeAt(code, x) - basic(shape, x)) < 1e-12, `${shape} ${x}`));
    for (let wave = 0; wave < 6; wave++) assert.ok(Math.abs(shapeBaseAt(wave, x) - shapeBase(wave, x)) < 1e-12, `${wave} ${x}`);
  }
});

test('passEdges finds a jump crossed forwards or backwards, once, at the right fraction', () => {
  const edges: Edges = [[0, -2], [0.5, 1]];
  const seen: Array<[number, number]> = [];
  const line = { step: (h: number, ago: number) => seen.push([h, ago]) } as unknown as BlepLine;
  passEdges(0.9, 0.2, edges, 1, line);
  assert.equal(seen.length, 1);
  assert.equal(seen[0]![0], -2);
  assert.ok(Math.abs(seen[0]![1] - 0.5) < 1e-12, 'the wrap at 1.0 is half a sample ago');
  seen.length = 0;
  passEdges(0.45, 0.1, edges, 3, line);
  assert.deepEqual(seen.map(([h]) => h), [3], 'the edge at 0.5, scaled');
  seen.length = 0;
  passEdges(0.5, 0.1, edges, 1, line);
  assert.equal(seen.length, 0, 'a phase on the edge has passed it');
  passEdges(0.2, -0.3, edges, 1, line);
  assert.equal(seen.length, 1);
  assert.equal(seen[0]![0], 2, 'backwards through the wrap: the jump reversed');
  assert.ok(Math.abs(seen[0]![1] - 1 / 3) < 1e-12);
});

test('PolyBLEP: no larger step than the naive saw and much less aliasing', () => {
  // 101 cycles in 4096 samples: the harmonics fall on exact bins, everything else is folded back.
  const n = 4096;
  const dt = 101 / n;
  for (const [name, make] of [
    ['saw', () => new StackCore('saw', [0], 0, [0])],
    ['square', () => new StackCore('square', [0], 0, [0])],
    ['pulse 10', () => new StackCore('pulse10', [0], 0, [0])],
    ['sync saw', () => new SyncCore(2)],
    ['shape saw', () => new ShapeCore(1)],
    ['shape square', () => new ShapeCore(2)],
  ] as const) {
    const naive = run(make(), dt, 0.3, 2 * n, false).slice(n);
    const smooth = run(make(), dt, 0.3, 2 * n).slice(n);
    assert.ok(maxStep(smooth) <= maxStep(naive) + 1e-9, `${name}: steps`);
    const ratio = aliasShare(smooth, 101) / aliasShare(naive, 101);
    assert.ok(ratio < 0.1, `${name}: alias energy reduced by more than 10 dB (${(10 * Math.log10(ratio)).toFixed(1)} dB)`);
  }
});

test('PolyBLEP: the saw meets its jump halfway and runs one sample late', () => {
  const smooth = run(new StackCore('saw', [0], 0, [0]), 0.25, 0, 12);
  const naive = run(new StackCore('saw', [0], 0, [0]), 0.25, 0, 12, false);
  // The phase reaches 1.0 exactly on a sample: that sample is the midpoint of -1 and +1.
  assert.deepEqual(Array.from(naive.slice(0, 5)), [-0.5, 0, 0.5, -1, -0.5]);
  assert.ok(Math.abs(smooth[4]!) < 1e-12, 'the wrap sample, one late, sits at 0');
  assert.deepEqual(Array.from(smooth.slice(5, 7)), [-0.5, 0]);
});

test('hard sync: ctrl 0 is the plain saw; the slave restarts on every master cycle', () => {
  const saw = run(new StackCore('saw', [0], 0, [0]), 1 / 64, 0, 512);
  const synced = run(new SyncCore(2), 1 / 64, 0, 512);
  for (let i = 0; i < 512; i++) assert.ok(Math.abs(saw[i]! - synced[i]!) < 1e-9, `sample ${i}`);
  // At 1 + 7 × 0.5 = 4.5 slave cycles per master cycle the wave still repeats with the master.
  const x = run(new SyncCore(2), 1 / 64, 0.5, 64 * 8);
  for (let i = 128; i < 64 * 7; i++) assert.ok(Math.abs(x[i]! - x[i + 64]!) < 1e-9, `period at ${i}`);
  const naive = run(new SyncCore(2), 1 / 64, 0.5, 64 * 3, false);
  assert.ok(Math.abs(naive[127]! - -1) < 1e-9, 'each master cycle starts the slave saw at -1');
  for (const wave of [0, 1, 3, 4, 5, 6, 7, 8]) {
    const y = run(new SyncCore(wave), 0.0123, 0.77, 4000);
    assert.ok(y.every((v) => Number.isFinite(v) && Math.abs(v) <= 1.5), `sync wave ${wave} bounded`);
  }
});

test('shape: osc ctrl moves the Shape Saw pulse from 50 % to 5 %', () => {
  const duty = (ctrl: number): number => {
    const y = run(new ShapeCore(1), 1 / 400, ctrl, 4000, false);
    return y.filter((v) => v < 0).length / y.length;
  };
  assert.ok(Math.abs(duty(0) - 0.5) < 0.01, String(duty(0)));
  assert.ok(Math.abs(duty(1) - 0.05) < 0.01, String(duty(1)));
  // A ctrl sweep at audio rate (the osc envelope, the LFO) stays bounded.
  const core = new ShapeCore(1);
  const line = new BlepLine();
  for (let i = 0; i < 20000; i++) {
    const v = line.push(core.next(0.01, 0.5 + 0.5 * Math.sin(i / 7), line));
    assert.ok(Number.isFinite(v) && Math.abs(v) <= 1.3, `sample ${i}`);
  }
});

test('shape sine: ctrl 0 is a sine for every wave; ctrl sweeps the waveforms.ts shapes per sample', () => {
  for (let wave = 0; wave < 7; wave++) {
    const core = new ShapeSineCore(wave);
    const line = new BlepLine();
    let p = 0;
    for (let i = 0; i < 300; i++) {
      p = (p + 0.013) % 1;
      const v = core.next(0.013, 0, line);
      assert.ok(Math.abs(v - Math.sin(2 * Math.PI * p)) < 1e-9, `wave ${wave} sample ${i}`);
    }
    const swept = new ShapeSineCore(wave);
    let q = 0;
    for (let i = 0; i < 300; i++) {
      q = (q + 0.007) % 1;
      const c = i / 299;
      const v = swept.next(0.007, c, line);
      assert.ok(Math.abs(v - shapeSineSample(wave, c, q)) < 1e-9, `wave ${wave} swept ${i}`);
    }
  }
});

test('stacks: Multi and Super detune by osc ctrl around their intervals', () => {
  const multi = new StackCore('saw', [0, 700], 25, [0, 0.5]);
  multi.next(0.01, 1, new BlepLine());
  const want = [2 ** (-25 / 1200), 2 ** ((700 + 25) / 1200)];
  multi.ratios.forEach((r, i) => assert.ok(Math.abs(r - want[i]!) < 1e-12, `multi ${i}`));
  const sup = new StackCore('saw', [0, 0, 0, 0, 0, 0, 0], 45, [0, 0, 0, 0, 0, 0, 0]);
  sup.next(0.01, 0.5, new BlepLine());
  sup.ratios.forEach((r, i) => {
    const cents = 0.5 * 45 * ((2 * i) / 6 - 1);
    assert.ok(Math.abs(r - 2 ** (cents / 1200)) < 1e-12, `super ${i}`);
  });
  assert.deepEqual([1, 2, 3, 4].map(superCount), [7, 7, 5, 4]);
  assert.equal((makeCore('super', 0, 1, 0, rng(1)) as StackCore).size, 7);
  assert.equal((makeCore('multi', 4, 1, 0, rng(1)) as StackCore).size, 3, 'Multi Saw 8ve 8ve+: three saws');
});

test('every worklet kind and wave: finite and bounded over pitch, ctrl sweeps and unison', () => {
  const pitch = new Float32Array(BLOCK);
  const ctrl = new Float32Array(BLOCK);
  const waves: Record<string, number> = { sync: 9, shape: 5, shapeSine: 7, multi: 6, super: 5 };
  for (const kind of WORKLET_OSC_KINDS) {
    for (let wave = 0; wave < waves[kind]!; wave++) {
      for (const copies of [1, 4]) {
        const r = new OscRenderer({ kind, wave, copies, spreadCents: 20, seed: 11 }, SR);
        const l = new Float32Array(BLOCK);
        const rr = new Float32Array(BLOCK);
        for (let b = 0; b < 60; b++) {
          for (let i = 0; i < BLOCK; i++) {
            const t = b * BLOCK + i;
            pitch[i] = -4800 + (9600 * t) / (60 * BLOCK); // C0-ish to far above Nyquist
            ctrl[i] = 0.5 + 0.7 * Math.sin(t / 50); // past both ends: clamped
          }
          assert.equal(r.render(l, rr, pitch, ctrl, 0), true);
          for (let i = 0; i < BLOCK; i++) {
            assert.ok(Number.isFinite(l[i]!) && Number.isFinite(rr[i]!), `${kind} ${wave} ${copies}`);
            assert.ok(Math.abs(l[i]!) <= 3 && Math.abs(rr[i]!) <= 3, `${kind} ${wave} ${copies}: ${l[i]}`);
          }
        }
      }
    }
  }
});

test('osc renderer: one copy plays both channels, unison spreads them; the seed repeats a render', () => {
  const render = (copies: number, seed: number): [Float32Array, Float32Array] => {
    const r = new OscRenderer({ kind: 'super', wave: 0, copies, spreadCents: 12, seed }, SR);
    const l = new Float32Array(BLOCK * 4);
    const rr = new Float32Array(BLOCK * 4);
    r.render(l, rr, Float32Array.of(-900), Float32Array.of(0.4), 0);
    return [l, rr];
  };
  const [l1, r1] = render(1, 5);
  assert.deepEqual(l1, r1);
  const [l2, r2] = render(2, 5);
  assert.ok(!same(l2, r2), 'two copies pan apart');
  assert.deepEqual(render(2, 5)[0], l2, 'same seed, same output');
  assert.ok(!same(render(2, 6)[0], l2), 'another seed, other start phases');
});

test('osc renderer: the end message silences from its frame on; the latest end wins', () => {
  const r = new OscRenderer({ kind: 'sync', wave: 2, copies: 1, spreadCents: 0, seed: 1 }, SR);
  const l = new Float32Array(BLOCK);
  const rr = new Float32Array(BLOCK);
  const pitch = Float32Array.of(0);
  const ctrl = Float32Array.of(0.3);
  r.message({ type: 'end', at: 1e7 });
  r.message({ type: 'end', at: 1 + 64 / SR });
  assert.equal(r.render(l, rr, pitch, ctrl, 0), true);
  assert.equal(r.render(l, rr, pitch, ctrl, 1), false, 'ends inside this block');
  assert.ok(l.slice(0, 64).some((v) => v !== 0));
  assert.ok(l.slice(64).every((v) => v === 0) && rr.slice(64).every((v) => v === 0));
  l.fill(1);
  assert.equal(r.render(l, rr, pitch, ctrl, 2), false);
  assert.ok(l.every((v) => v === 0), 'silent after the end');
  assert.equal(r.done, true);
});

test('osc renderer: a wave message switches the category while the voice sounds', () => {
  const r = new OscRenderer({ kind: 'sync', wave: 0, copies: 1, spreadCents: 0, seed: 1 }, SR);
  const l = new Float32Array(BLOCK);
  const rr = new Float32Array(BLOCK);
  r.message({ type: 'wave', kind: 'shape', wave: 2 });
  r.render(l, rr, Float32Array.of(-2400), Float32Array.of(0), 0);
  // Shape Square at ctrl 0 is a plain ±1 square (after the one-sample BLEP latency, away from edges).
  assert.ok(l.slice(2, 40).every((v) => Math.abs(Math.abs(v) - 1) < 1e-9), String(l.slice(0, 8)));
});

/** Run the filter renderer over `blocks` blocks of `input(t)`; returns the left output. */
function filter(mode: 'ladder' | 'drive', blocks: number, input: (t: number) => number, o: { hz?: number; cents?: number;
  res?: number; drive?: number } = {}): Float32Array {
  const f = new FilterRenderer(mode, SR);
  const out = new Float32Array(blocks * BLOCK);
  const l = new Float32Array(BLOCK);
  const r = new Float32Array(BLOCK);
  for (let b = 0; b < blocks; b++) {
    const x = Float32Array.from({ length: BLOCK }, (_, i) => input(b * BLOCK + i));
    f.render([x], l, r, Float32Array.of(o.hz ?? 1000), Float32Array.of(o.cents ?? 0), o.res ?? 0, o.drive ?? 1);
    out.set(l, b * BLOCK);
  }
  return out;
}

function rms(x: Float32Array): number {
  let s = 0;
  for (const v of x) s += v * v;
  return Math.sqrt(s / x.length);
}

test('ladder: unity DC gain at resonance 0, partial gain compensation above', () => {
  const dc = filter('ladder', 100, () => 0.01);
  assert.ok(Math.abs(dc.at(-1)! / 0.01 - 1) < 0.01, String(dc.at(-1)));
  const k = 0.5 * LADDER_FEEDBACK;
  const res = filter('ladder', 200, () => 0.01, { res: 0.5 });
  assert.ok(Math.abs(res.at(-1)! / 0.01 - (1 + 0.5 * k) / (1 + k)) < 0.01, 'linear DC gain (1 + k/2) / (1 + k)');
});

test('ladder: a 24 dB low pass; the detune parameter moves the cutoff in cents', () => {
  const tone = (hz: number) => (t: number): number => 0.1 * Math.sin((2 * Math.PI * hz * t) / SR);
  const pass = rms(filter('ladder', 60, tone(100), { hz: 2000 }).slice(BLOCK * 20));
  const stop = rms(filter('ladder', 60, tone(8000), { hz: 500 }).slice(BLOCK * 20));
  assert.ok(Math.abs(pass / (0.1 / Math.SQRT2) - 1) < 0.05, `passband ${pass}`);
  assert.ok(20 * Math.log10(stop / (0.1 / Math.SQRT2)) < -80, `4 octaves above: ${20 * Math.log10(stop / 0.0707)} dB`);
  const a = filter('ladder', 20, tone(3000), { hz: 2000 });
  const b = filter('ladder', 20, tone(3000), { hz: 1000, cents: 1200 });
  assert.deepEqual(a, b);
});

test('ladder: self-oscillation from resonance 0.9; below it a ping dies out', () => {
  const ping = (t: number): number => (t === 0 ? 1 : 0);
  const tail = (res: number): number => rms(filter('ladder', 375, ping, { res }).slice(-BLOCK * 40));
  assert.ok(tail(1) > 0.05, `res 1 rings on: ${tail(1)}`);
  assert.ok(tail(0.95) > 0.03, `res 0.95: ${tail(0.95)}`);
  assert.ok(tail(0.8) < 1e-6, `res 0.8 decays: ${tail(0.8)}`);
});

test('ladder and drive: finite and bounded over the whole range', () => {
  const noise = rng(7);
  for (const mode of ['ladder', 'drive'] as const) {
    for (const res of [0, 0.5, 0.9, 1]) {
      for (const hz of [10, 200, 5000, 21600, 24000]) {
        for (const drive of [1, 2, 8, 16]) {
          for (const amp of [0.01, 1, 4]) {
            const y = filter(mode, 20, () => (noise() * 2 - 1) * amp, { hz, res, drive, cents: hz > 20000 ? 4800 : 0 });
            for (const v of y) assert.ok(Number.isFinite(v) && Math.abs(v) < 4, `${mode} res ${res} ${hz} Hz drive ${drive}: ${v}`);
          }
        }
      }
    }
  }
});

test('drive: clean at 1; tanh(g·x)/tanh(g) for the gains of off, 1, 2, 3', () => {
  assert.deepEqual([0, 1, 2, 3].map(driveGain), [1, 2, 4, 8]);
  for (let x = -1; x <= 1; x += 0.125) assert.equal(driveSample(x, 1), x);
  for (const g of [2, 4, 8]) {
    assert.ok(Math.abs(driveSample(1, g) - 1) < 1e-12 && Math.abs(driveSample(-1, g) + 1) < 1e-12, `±1 stays at gain ${g}`);
    const small = driveSample(1e-4, g) / 1e-4;
    assert.ok(Math.abs(small / (g / Math.tanh(g)) - 1) < 0.03, `small-signal gain at ${g}: ${small}`);
    let last = -Infinity;
    for (let x = -2; x <= 2; x += 0.01) {
      const y = driveSample(x, g);
      assert.ok(y >= last && Math.abs(y) <= 1 / softTanh(g) + 1e-12, 'monotonic, saturating');
      last = y;
    }
  }
  for (let x = -5; x <= 5; x += 0.01) assert.ok(Math.abs(softTanh(x) - Math.tanh(x)) < 0.025, `softTanh ${x}`);
  // The drive mode alone keeps a quiet signal's level near g / tanh(g) and never exceeds ±1 for |x| ≤ 1.
  const y = filter('drive', 10, (t) => Math.sin(t / 20), { drive: 8 });
  assert.ok(y.every((v) => Math.abs(v) <= 1));
});

test('filter renderer: a mono input plays on both outputs; stereo channels stay apart', () => {
  const f = new FilterRenderer('ladder', SR);
  const l = new Float32Array(BLOCK);
  const r = new Float32Array(BLOCK);
  const a = Float32Array.from({ length: BLOCK }, (_, i) => Math.sin(i / 3));
  f.render([a], l, r, Float32Array.of(800), Float32Array.of(0), 0.3, 2);
  assert.deepEqual(l, r);
  f.render([a, a], l, r, Float32Array.of(800), Float32Array.of(0), 0.3, 2);
  assert.deepEqual(l, r, 'identical channels: one ladder, copied');
  const b = Float32Array.from({ length: BLOCK }, (_, i) => Math.cos(i / 5));
  f.render([a, b], l, r, Float32Array.of(800), Float32Array.of(0), 0.3, 2);
  assert.ok(!same(l, r));
});

test('filter renderer: without an input it rings out for a quarter second, then lets go', () => {
  const f = new FilterRenderer('ladder', SR);
  const l = new Float32Array(BLOCK);
  const r = new Float32Array(BLOCK);
  assert.equal(f.render([new Float32Array(BLOCK).fill(0.5)], l, r, Float32Array.of(500), Float32Array.of(0), 0.95, 1), true);
  let blocks = 0;
  while (f.render([], l, r, Float32Array.of(500), Float32Array.of(0), 0.95, 1)) blocks += 1;
  assert.equal(blocks, Math.ceil((0.25 * SR) / BLOCK) - 1);
});

test('the phase step is capped below Nyquist', () => {
  assert.ok(MAX_INC < 0.5);
  const r = new OscRenderer({ kind: 'multi', wave: 4, copies: 1, spreadCents: 0, seed: 1 }, SR);
  const l = new Float32Array(BLOCK);
  const rr = new Float32Array(BLOCK);
  // 22 kHz: the 8ve and 8ve+ saws are muted, nothing blows up.
  r.render(l, rr, Float32Array.of(1200 * Math.log2(22000 / 440)), Float32Array.of(0), 0);
  assert.ok(l.every((v) => Number.isFinite(v) && Math.abs(v) < 2));
});
