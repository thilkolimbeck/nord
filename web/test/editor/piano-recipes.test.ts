/** Plan section 13.3: the browser piano's pure maths: touch, dyn comp, timbre, recipes, release and resonance rules. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  dynLevel, LEVEL_SCALE, layerSettings, REF_PEAK, timbreBands, touchX, unisonSpec,
} from '../../src/editor/audio/piano/mapping.ts';
import {
  clavPickup, envEnd, envLevel, FAMILY_CLASS, MAX_SOURCES, NYQUIST_FRACTION, recipe, type RecipeInput, releaseSeconds,
  resonates, STAGE1_SECONDS, waveSpec,
} from '../../src/editor/audio/piano/recipes.ts';
import type { Ns4Key } from '../../src/editor/model/keys.ts';
import type { ValueReader } from '../../src/editor/model/labels.ts';
import { initProgram } from '../../src/editor/model/init.ts';
import { DEFAULT_FAMILY, modelsOfType, type PianoFamily, PIANO_TYPES } from '../../src/editor/model/pianos.ts';

const FAMILIES = Object.keys(FAMILY_CLASS) as PianoFamily[];

function input(family: PianoFamily, note: number, x = 0.7, extra: Partial<RecipeInput> = {}): RecipeInput {
  return { family, name: null, note, x, variation: 0, sampleRate: 48000, halfPartials: false, ...extra };
}

test('touch curves rise with velocity, heavy below med below light at mid velocity', () => {
  for (const touch of [0, 1, 2]) {
    let prev = -1;
    for (let v = 0; v <= 127; v++) {
      const x = touchX(v, touch);
      assert.ok(x >= prev && x >= 0 && x <= 1, `touch ${touch} velocity ${v}`);
      prev = x;
    }
    assert.equal(touchX(127, touch), 1);
  }
  assert.ok(touchX(64, 0) < touchX(64, 1) && touchX(64, 1) < touchX(64, 2));
});

test('dyn comp raises the minimum level and leaves full velocity alone', () => {
  const soft = touchX(10, 1);
  for (let c = 1; c <= 3; c++) assert.ok(dynLevel(soft, c) > dynLevel(soft, c - 1), `dyn comp ${c}`);
  for (let c = 0; c <= 3; c++) assert.equal(dynLevel(1, c), 1);
  assert.ok(Math.abs(dynLevel(0, 0) - 0.01) < 1e-12, '40 dB range at dyn comp off');
  assert.ok(Math.abs(dynLevel(touchX(100, 1), 0) * LEVEL_SCALE - REF_PEAK) < 1e-12, 'velocity 100 peaks at REF_PEAK');
});

test('timbre sets follow the type; values without a label are flat', () => {
  assert.deepEqual(timbreBands('grand', 0), []);
  assert.deepEqual(timbreBands('grand', 3), [{ type: 'highshelf', freq: 3000, gain: 6, Q: 0.707 }]);
  assert.equal(timbreBands('upright', 2).length, 3);
  assert.deepEqual(timbreBands('grand', 4), []);
  assert.deepEqual(timbreBands('digital', 7), []);
  assert.equal(timbreBands('electric', 4).length, 2); // Dyno 1
  assert.equal(timbreBands('electric', 5).length, 4); // Dyno 2
  assert.deepEqual(timbreBands('electric', 6), []);
  // Clav: a mask of Soft 1, Treble 2, Brilliant 4.
  assert.deepEqual(timbreBands('clav', 1).map((b) => [b.type, b.gain]), [['highshelf', -6]]);
  assert.deepEqual(timbreBands('clav', 6).map((b) => [b.type, b.gain]), [['highshelf', 5], ['peaking', 6]]);
  assert.equal(timbreBands('clav', 7).length, 3);
  for (const type of PIANO_TYPES) for (let eq = 0; eq < 8; eq++) assert.ok(timbreBands(type, eq).length <= 4);
});

test('every recipe is finite and within budget for MIDI 21–108', () => {
  for (const family of FAMILIES) {
    for (const sampleRate of [44100, 48000]) {
      for (let note = 21; note <= 108; note++) {
        for (const x of [0, 0.5, 1]) {
          for (const halfPartials of [false, true]) {
            const r = recipe(input(family, note, x, { sampleRate, halfPartials, variation: note % 4 }));
            const at = `${family} ${note} x=${x} sr=${sampleRate}`;
            assert.ok(r.components.length > 0, `${at} has no partial`);
            assert.ok(Number.isFinite(r.f0) && r.f0 > 0, at);
            assert.ok(Number.isFinite(r.norm) && r.norm > 0, at);
            const sources = r.components.length + (r.attackNoise !== null ? 1 : 0) + (r.fm !== null ? 1 : 0);
            assert.ok(sources <= MAX_SOURCES, `${at}: ${sources} sources`);
            for (const c of r.components) {
              assert.ok(Number.isFinite(c.ratio) && c.ratio > 0, at);
              assert.ok(r.f0 * c.ratio < NYQUIST_FRACTION * sampleRate, `${at}: partial above the limit`);
              assert.ok(Number.isFinite(c.env.amp) && c.env.amp > 0, at);
              assert.ok(Number.isFinite(c.env.tau) && c.env.tau > 0, at);
              assert.ok(Number.isFinite(envEnd(c.env, 1e-4)), at);
            }
            for (const f of r.filters) assert.ok(Number.isFinite(f.freq) && f.freq > 0, at);
            if (r.sweep !== null) assert.ok(r.sweep.from > 0 && r.sweep.to > 0, at);
            if (r.fm !== null) assert.ok(r.fm.index0 > 0 && r.fm.indexEnd < r.fm.index0, at);
            assert.ok(r.releaseTime > 0, at);
          }
        }
      }
    }
  }
});

test('grand partials: inharmonic, doubled from MIDI 40, darker when soft, halved on demand', () => {
  const low = recipe(input('grand', 36));
  assert.equal(low.components.length, 10);
  assert.ok(low.components[9]!.ratio > 10, 'stretched partials');
  const mid = recipe(input('grand', 60));
  assert.deepEqual(mid.components.slice(0, 4).map((c) => [c.partial, c.detune]), [[1, -0.7], [1, 0.7], [2, -0.7], [2, 0.7]]);
  assert.equal(mid.components.length, MAX_SOURCES - 1, 'the hammer takes one source');
  assert.ok(mid.attackNoise !== null && mid.releaseNoise !== null);
  const soft = recipe(input('grand', 60, 0.1));
  const hard = recipe(input('grand', 60, 1));
  const ratio = (r: typeof soft): number => r.components.at(-1)!.env.amp / r.components[0]!.env.amp;
  assert.ok(ratio(soft) < ratio(hard), 'harder touch is brighter');
  const half = recipe(input('grand', 36, 0.7, { halfPartials: true }));
  assert.equal(half.components.length, 5);
  const honky = recipe(input('upright', 60, 0.7, { name: 'HonkyTonkUpright Lrg' }));
  assert.equal(honky.components[0]!.detune, -8);
  assert.equal(recipe(input('upright', 60)).components[0]!.detune, -1.5);
  const felt = recipe(input('upright', 60, 0.7, { name: 'Felt Upright Med' }));
  assert.ok(felt.attackNoise!.level < recipe(input('upright', 60)).attackNoise!.level);
  const digital = recipe(input('digital-acoustic', 60));
  assert.ok(digital.components.length <= 6 && digital.attackNoise === null);
  assert.ok(digital.components.every((c, i) => c.ratio === i + 1), 'no inharmonicity');
});

test('the two-stage envelope falls 6 dB in its first 0.3 s and ends where it says', () => {
  const env = { amp: 1, attack: 0.002, twoStage: true, tau: 1 };
  assert.ok(Math.abs(envLevel(env, 0.002 + STAGE1_SECONDS) - 0.5) < 1e-9);
  assert.ok(envLevel(env, 0.001) < envLevel(env, 0.002));
  for (const floor of [1e-4, 0.3, 0.55]) {
    const end = envEnd(env, floor);
    assert.ok(Math.abs(envLevel(env, end) - floor) < 1e-6, `floor ${floor}`);
  }
  const plain = { amp: 0.5, attack: 0.002, twoStage: false, tau: 0.2 };
  assert.ok(Math.abs(envLevel(plain, envEnd(plain, 1e-3)) - 1e-3) < 1e-9);
  assert.equal(envEnd(plain, 0.6), 0);
});

test('release rules: no dampers from F6 on acoustic pianos, soft release per class, mallets', () => {
  assert.equal(releaseSeconds('grand', 0.55, 88, false), 0.55);
  assert.equal(releaseSeconds('grand', 0.55, 89, false), Infinity);
  assert.equal(releaseSeconds('upright', 0.55, 100, true), Infinity);
  assert.ok(Math.abs(releaseSeconds('grand', 0.55, 60, true) - 0.55 * 3.5) < 1e-12);
  assert.equal(releaseSeconds('tine', 0.25, 60, true), 0.125);
  assert.equal(releaseSeconds('tine', 0.25, 100, false), 0.25, 'electric pianos damp every key');
  assert.equal(releaseSeconds('clavinet', 0.08, 60, true), 0.08);
  assert.equal(releaseSeconds('harpsichord', 0.35, 60, true), 0.35);
  assert.equal(recipe(input('marimba', 60)).releaseTime, Infinity);
  assert.equal(releaseSeconds('marimba', Infinity, 60, true), Infinity);
});

test('unison plays two copies detuned ±4, ±8, ±16 cents', () => {
  assert.deepEqual(unisonSpec(0), { copies: 1, cents: 0, pan: 0 });
  assert.deepEqual([1, 2, 3].map((u) => unisonSpec(u).cents), [4, 8, 16]);
  for (const u of [1, 2, 3]) assert.equal(unisonSpec(u).copies, 2);
});

test('string resonance: Med in the middle range, Lrg and XL everywhere, not Sml or electric', () => {
  assert.equal(resonates('grand', 'Med', 47), false);
  assert.equal(resonates('grand', 'Med', 60), true);
  assert.equal(resonates('grand', 'Med', 85), false);
  assert.equal(resonates('upright', 'Lrg', 30), true);
  assert.equal(resonates('grand', 'XL', 100), true);
  assert.equal(resonates('grand', 'Sml', 60), false);
  assert.equal(resonates('electric-grand', 'Med', 60), false);
  assert.equal(resonates('tine', 'Lrg', 60), false);
  assert.equal(resonates('grand', null, 60), true, 'no size counts as Med');
});

test('clav pickups by variation and families with their own sounds', () => {
  assert.equal(clavPickup(0, 200)[0]!.type, 'lowpass');
  assert.equal(clavPickup(1, 200)[0]!.type, 'highpass');
  assert.deepEqual(clavPickup(2, 200), []);
  assert.ok(Math.abs(clavPickup(3, 200)[0]!.freq - 440) < 1e-9);
  const clav = recipe(input('clavinet', 48, 1));
  assert.ok(clav.wave !== null && clav.sweep !== null && clav.sweep.from > clav.sweep.to);
  assert.ok(recipe(input('tine', 60)).shaper !== null);
  assert.equal(recipe(input('fm', 60)).shaper, null);
  assert.ok(recipe(input('reed', 60)).wave!.id.startsWith('reed'));
  assert.equal(recipe(input('harpsichord', 60)).components.length, 2);
  assert.equal(waveSpec('pulse10', 100).real.length, 25, 'at most 24 harmonics');
});

/** A value reader over the init program with some fields changed. */
function reader(changes: Partial<Record<Ns4Key, number>>): ValueReader {
  const base = initProgram().values;
  return { get: (key) => changes[key] ?? base[key] };
}

test('the stored name hash picks the family when it belongs to the stored type, else the type default', () => {
  const clavinet = modelsOfType('clav').find((m) => m.family === 'clavinet')!;
  const harpsi = modelsOfType('clav').find((m) => m.family === 'harpsichord')!;
  const wurli = modelsOfType('electric').find((m) => m.family === 'reed')!;
  assert.equal(layerSettings(reader({ 'pianoA.bank': 3, 'pianoA.nameHash': clavinet.hash }), 'A').family, 'clavinet');
  assert.equal(layerSettings(reader({ 'pianoA.bank': 3, 'pianoA.nameHash': harpsi.hash }), 'A').family, 'harpsichord');
  assert.equal(layerSettings(reader({ 'pianoB.bank': 2, 'pianoB.nameHash': wurli.hash }), 'B').family, 'reed');
  const mismatch = layerSettings(reader({ 'pianoA.bank': 0, 'pianoA.nameHash': clavinet.hash }), 'A');
  assert.equal(mismatch.family, 'grand');
  assert.equal(mismatch.model, null);
  for (let bank = 0; bank < 6; bank++) {
    const s = layerSettings(reader({ 'pianoA.bank': bank, 'pianoA.nameHash': 0 }), 'A');
    assert.equal(s.family, DEFAULT_FAMILY[PIANO_TYPES[bank]!]);
  }
  const s = layerSettings(reader({ 'pianoA.acoustic': 2, 'pianoA.octaveShift': -1, 'pianoA.unison': 3 }), 'A');
  assert.deepEqual([s.stringRes, s.softRelease, s.shift, s.unison], [false, true, -12, 3]);
});
