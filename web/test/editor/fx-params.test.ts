/**
 * Plan section 15.1: the layer effects settings (audio/fx/params.ts) and the generated impulse
 * responses (audio/fx/impulse.ts). Pure, no Web Audio.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  generateImpulse, impulseLength, impulseSpec, seededRandom,
} from '../../src/editor/audio/fx/impulse.ts';
import { pumpDuck } from '../../src/editor/audio/fx/mod1.ts';
import { drivePre, driveActive, modelCurve } from '../../src/editor/audio/fx/amp.ts';
import {
  ampSettings, compSettings, delaySettings, equalPower, knob, mod1Settings, mod2Settings, reverbSettings, tempoOf,
  toRotary, unitOn,
} from '../../src/editor/audio/fx/params.ts';
import { DELAY_DIVISIONS, delayFreeSeconds, fxDivisionSeconds, fxKey, mod1FreeHz, mod2RateHz, ringModHz } from '../../src/editor/model/fx.ts';
import { initProgram } from '../../src/editor/model/init.ts';
import { ParamStore } from '../../src/editor/model/store.ts';

const fresh = (): ParamStore => new ParamStore(initProgram());
const close = (a: number, b: number, eps = 1e-6): boolean => Math.abs(a - b) <= eps * Math.max(1, Math.abs(b));

test('knobs: the 0.0–10.0 labels as 0..1, finite over the whole range', () => {
  const s = fresh();
  for (const v of [0, 1, 64, 126, 127]) {
    s.set('synthAFx.fx1Amt', v);
    const k = knob(s, 'synthAFx', 'fx1Amt');
    assert.ok(k >= 0 && k <= 1 && Number.isFinite(k), `${v} → ${k}`);
  }
  s.set('synthAFx.fx1Amt', 0);
  assert.equal(knob(s, 'synthAFx', 'fx1Amt'), 0);
  s.set('synthAFx.fx1Amt', 127);
  assert.equal(knob(s, 'synthAFx', 'fx1Amt'), 1);
});

test('Mod 1: types, variations, free and synced rates, RM pitch (p.49)', () => {
  const s = fresh();
  const b = 'organFx';
  const families = [];
  for (let t = 0; t < 12; t++) {
    s.set(fxKey(b, 'fx1Type'), t);
    const m = mod1Settings(s, b, null);
    families.push(m.family);
    assert.equal(m.variation, t % 2 === 1, `type ${t}`);
  }
  assert.deepEqual(families, ['pan', 'pan', 'trem', 'trem', 'rm', 'rm', 'awah', 'awah', 'wah', 'wah', 'pump', 'pump']);
  s.setMany([[fxKey(b, 'fx1Type'), 2], [fxKey(b, 'fx1RateClkDiv'), 64], [fxKey(b, 'fx1ClkEnable'), 0]], 'ui');
  assert.ok(close(mod1Settings(s, b, null).rateHz, mod1FreeHz(64)));
  // Mst Clk: a division of the tempo; the ClockReader wins over the stored tempo.
  s.set(fxKey(b, 'fx1ClkEnable'), 1);
  const synced = mod1Settings(s, b, { bpm: () => 120, anchor: () => 0 });
  assert.equal(synced.synced, true);
  assert.ok(synced.rateHz > 0 && Number.isFinite(synced.rateHz));
  const faster = mod1Settings(s, b, { bpm: () => 240, anchor: () => 0 });
  assert.ok(close(faster.rateHz, 2 * synced.rateHz), 'double tempo, double rate');
  // RM ignores Mst Clk: its rate is the sine's pitch (p.49).
  s.set(fxKey(b, 'fx1Type'), 4);
  const rm = mod1Settings(s, b, { bpm: () => 120, anchor: () => 0 });
  assert.equal(rm.synced, false);
  assert.ok(close(rm.rateHz, ringModHz(64)));
});

test('Mod 2: table order PHAS FLANG CHOR VIBE ENS SPIN, rate curve', () => {
  const s = fresh();
  const fam = [];
  for (let t = 0; t < 12; t += 2) {
    s.set('pianoAFx.fx2Type', t);
    fam.push(mod2Settings(s, 'pianoAFx').family);
  }
  assert.deepEqual(fam, ['phaser', 'flanger', 'chorus', 'vibe', 'ensemble', 'spin']);
  s.set('pianoAFx.fx2Rate', 100);
  assert.ok(close(mod2Settings(s, 'pianoAFx').rateHz, mod2RateHz(100)));
});

test('Delay: free time, synced divisions, swing taps, feedback ceiling, loop effects (p.50–51)', () => {
  const s = fresh();
  const b = 'synthBFx';
  s.setMany([[fxKey(b, 'dlyClkEnable'), 0], [fxKey(b, 'dlyRateClkDiv'), 5000]], 'ui');
  let d = delaySettings(s, b, null);
  assert.ok(close(d.left, delayFreeSeconds(5000)));
  assert.equal(d.left, d.right);
  s.set(fxKey(b, 'dlyClkEnable'), 1);
  s.set('common.masterClockRate', 120);
  for (let i = 0; i < DELAY_DIVISIONS.length; i++) {
    const div = DELAY_DIVISIONS[i]!;
    s.set(fxKey(b, 'dlyRateClkDiv'), Math.floor(((i + 0.5) * 16384) / DELAY_DIVISIONS.length));
    d = delaySettings(s, b, null);
    const step = fxDivisionSeconds(120, div);
    if (div.swing) {
      assert.ok(close(d.left + d.right, 2 * step), `${div.label}: two taps span two steps`);
      assert.ok(close(d.left, 2 * d.right), `${div.label}: 2/3 then 1/3`);
    }
    else assert.ok(close(d.left, step) && close(d.right, step), div.label);
  }
  s.set(fxKey(b, 'dlyFbkAmt'), 127);
  assert.ok(close(delaySettings(s, b, null).feedback, 0.95));
  const loops = [];
  for (let t = 0; t < 12; t++) {
    s.set(fxKey(b, 'dlyFbFxType'), t);
    const x = delaySettings(s, b, null);
    loops.push(`${x.loopFx}${x.loopVariation ? '+' : ''}`);
  }
  assert.deepEqual(loops, ['none', 'none', 'ensemble', 'ensemble+', 'vibe', 'vibe+', 'chorus', 'chorus+', 'flam',
    'flam+', 'space', 'space+']);
  const { dry, wet } = equalPower(0.5);
  assert.ok(close(dry * dry + wet * wet, 1), 'equal power');
});

test('Amp: types, variations, filters, EQ in dB, drive pre-gain (p.51–52)', () => {
  const s = fresh();
  const b = 'pianoBFx';
  const models = [];
  for (let t = 0; t <= 9; t++) {
    s.set(fxKey(b, 'ampTypeNew'), t);
    const a = ampSettings(s, b);
    models.push(`${a.model}${a.variation ? '+' : ''}`);
  }
  assert.deepEqual(models, ['off', 'twin', 'twin+', 'jc', 'jc+', 'small', 'small+', 'rotary', 'lp', 'hp']);
  s.setMany([[fxKey(b, 'ampBass'), 60], [fxKey(b, 'ampTreble'), -60], [fxKey(b, 'ampMid'), -60]], 'ui');
  let a = ampSettings(s, b);
  assert.ok(close(a.bassDb, 15) && close(a.trebleDb, -15) && close(a.midDb, -15));
  assert.ok(close(a.q, 0.7));
  s.set(fxKey(b, 'ampMid'), 60);
  assert.ok(close(ampSettings(s, b).q, 12));
  s.set(fxKey(b, 'ampMidFreq'), 0);
  a = ampSettings(s, b);
  assert.ok(a.midHz >= 190 && a.midHz <= 210, `${a.midHz}`);
  assert.equal(drivePre(0, 'off'), 1);
  assert.equal(drivePre(10, 'off'), 21);
  assert.equal(drivePre(0, 'twin'), 1.5);
  assert.equal(driveActive({ ...a, model: 'off', drive: 0 }), false);
  assert.equal(driveActive({ ...a, model: 'jc', drive: 0 }), true);
  assert.equal(modelCurve('off', false).peakDb, 0);
  assert.equal(modelCurve('twin', false).hp, 70);
});

test('To Rotary only with Amp on and Layer Effects on', () => {
  const s = fresh();
  const b = 'synthAFx';
  s.setMany([[fxKey(b, 'ampTypeNew'), 7], [fxKey(b, 'ampEnable'), 0]], 'ui');
  assert.equal(toRotary(s, b), false);
  s.set(fxKey(b, 'ampEnable'), 1);
  assert.equal(toRotary(s, b), true);
  s.set('common.fxEnable', 0);
  assert.equal(toRotary(s, b), false);
});

test('unit switches: Enable, Layer Effects ON, Global mode', () => {
  const s = fresh();
  s.setMany([['synthAFx.rvbEnable', 1], ['common.fxEnable', 1], ['common.effectsRvbGlobal', 0]], 'ui');
  assert.equal(unitOn(s, 'synthAFx', 'reverb'), true);
  s.set('common.effectsRvbGlobal', 1);
  assert.equal(unitOn(s, 'synthAFx', 'reverb'), false, 'the global instance plays it');
  s.setMany([['common.effectsRvbGlobal', 0], ['common.fxEnable', 0]], 'ui');
  assert.equal(unitOn(s, 'synthAFx', 'reverb'), false);
  s.set('common.fxEnable', 1);
  s.set('synthAFx.rvbEnable', 0);
  assert.equal(unitOn(s, 'synthAFx', 'reverb'), false);
});

test('Compressor and reverb curves; tempo source', () => {
  const s = fresh();
  s.setMany([['organFx.cmpAmt', 127], ['organFx.cmpResponse', 1]], 'ui');
  const c = compSettings(s, 'organFx');
  assert.ok(close(c.thresholdDb, -40) && close(c.ratio, 8) && close(c.makeUpDb, 6));
  assert.equal(c.release, 0.06);
  s.setMany([['organFx.rvbType', 9], ['organFx.rvbAmt', 127], ['organFx.rvbColor', 1]], 'ui');
  const r = reverbSettings(s, 'organFx');
  assert.deepEqual([r.type, r.variation, r.chorale, r.color, r.mix], ['hall', true, true, 'dark', 1]);
  s.set('organFx.rvbType', 3);
  assert.equal(reverbSettings(s, 'organFx').chorale, false, 'Booth variation is a pre-delay');
  s.set('common.masterClockRate', 90);
  assert.equal(tempoOf(s, null), 90);
  assert.equal(tempoOf(s, { bpm: () => 400, anchor: () => 0 }), 240);
});

test('Pump duck: deepest at the wrap, recovered by 80 % of the cycle', () => {
  assert.equal(pumpDuck(0), 1);
  assert.equal(pumpDuck(0.8), 0);
  assert.equal(pumpDuck(1), 0);
  assert.ok(pumpDuck(0.4) > 0 && pumpDuck(0.4) < 1);
});

// ── impulse responses ─────────────────────────────────────────────────────────────────────────

const SR = 8000;

function rms(x: Float32Array, from: number, to: number): number {
  let s = 0;
  for (let i = from; i < to; i++) s += x[i]! ** 2;
  return Math.sqrt(s / Math.max(1, to - from));
}

test('impulse responses: finite, peak 1, length = pre-delay + decay, ordered by size', () => {
  let previous = 0;
  for (const index of [2, 4, 6, 8, 10]) {
    const spec = impulseSpec(index);
    const [l, r] = generateImpulse(spec, SR, index + 1);
    assert.equal(l.length, impulseLength(spec, SR));
    assert.ok(Math.abs(l.length / SR - (spec.preDelay + spec.decay)) < 2 / SR);
    let peak = 0;
    for (const ch of [l, r]) for (const x of ch) {
      assert.ok(Number.isFinite(x));
      peak = Math.max(peak, Math.abs(x));
    }
    assert.ok(close(peak, 1, 1e-6), `${spec.type} peak ${peak}`);
    assert.ok(spec.decay > previous, `${spec.type} longer than the one before`);
    previous = spec.decay;
  }
  assert.deepEqual([0, 2, 4, 6, 8, 10].map((i) => impulseSpec(i).type),
    ['spring', 'booth', 'room', 'stage', 'hall', 'cathedral']);
  assert.equal(impulseSpec(1).decay, 3.0, 'spring variation: the longer spring');
  assert.equal(impulseSpec(3).preDelay, 0.025);
  assert.equal(impulseSpec(5).preDelay, 0.035);
  assert.equal(impulseSpec(99).type, 'cathedral', 'clamped');
});

test('impulse responses decay: the last tenth is at least 40 dB under the start', () => {
  for (const index of [0, 2, 4, 6, 8]) {
    const spec = impulseSpec(index);
    const [l] = generateImpulse(spec, SR, 1);
    const pre = Math.round(spec.preDelay * SR);
    const n = l.length;
    const tenth = Math.floor((n - pre) / 10);
    const head = rms(l, pre, pre + tenth);
    const tail = rms(l, n - tenth, n);
    assert.ok(20 * Math.log10(tail / head) < -40, `${spec.type}: ${20 * Math.log10(tail / head)} dB`);
    // Pre-delay is silent.
    for (let i = 0; i < pre; i++) assert.equal(l[i], 0);
  }
});

test('impulse responses: deterministic by seed, left and right decorrelated', () => {
  const spec = impulseSpec(8);
  const a = generateImpulse(spec, SR, 7);
  const b = generateImpulse(spec, SR, 7);
  const c = generateImpulse(spec, SR, 8);
  assert.deepEqual(a[0], b[0]);
  assert.deepEqual(a[1], b[1]);
  assert.ok(a[0].some((x, i) => x !== c[0][i]), 'another seed, other samples');
  const [l, r] = a;
  let lr = 0;
  let ll = 0;
  let rr = 0;
  for (let i = 0; i < l.length; i++) {
    lr += l[i]! * r[i]!;
    ll += l[i]! ** 2;
    rr += r[i]! ** 2;
  }
  const corr = lr / Math.sqrt(ll * rr);
  assert.ok(Math.abs(corr) < 0.2, `correlation ${corr}`);
  const rand = seededRandom(3);
  const xs = Array.from({ length: 1000 }, rand);
  assert.ok(xs.every((x) => x >= 0 && x < 1));
});
