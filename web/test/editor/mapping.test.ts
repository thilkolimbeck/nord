/**
 * AC 4 / plan section 4.3: field values → physical values. Finite over every field's range,
 * monotonic for cutoff, envelope times and level; the label-based ones match the Stage 4 labels;
 * the guessed curves keep their documented ends.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as M from '../../src/editor/audio/mapping.ts';
import { descriptorOf } from '../../src/editor/model/descriptors.ts';
import { initProgram } from '../../src/editor/model/init.ts';
import { layerKey, LAYERS, type Ns4Key, type SynthLayer } from '../../src/editor/model/keys.ts';
import { ParamStore } from '../../src/editor/model/store.ts';

const fresh = (): ParamStore => new ParamStore(initProgram());
const SR = 48000;

function sweep(store: ParamStore, key: Ns4Key, fn: () => number): number[] {
  const d = descriptorOf(key);
  const out: number[] = [];
  for (let v = d.min; v <= d.max; v++) {
    store.set(key, v);
    out.push(fn());
  }
  return out;
}

/** Non-decreasing (the Stage 4 labels are rounded, so neighbours can share a label); strict also needs first < last. */
function increasing(xs: number[], strict: boolean, what: string): void {
  if (strict) assert.ok(xs[0]! < xs.at(-1)!, `${what}: ${xs[0]} … ${xs.at(-1)}`);
  for (let i = 1; i < xs.length; i++) {
    assert.ok(xs[i]! >= xs[i - 1]!, `${what}: step ${i} ${xs[i - 1]} → ${xs[i]}`);
  }
}

test('cutoff: Hz from the label, increasing, capped below Nyquist', () => {
  const s = fresh();
  const hz = sweep(s, 'synthASound.fltFreq', () => M.filterFreqHz(s, 'A', 1e9));
  increasing(hz, true, 'fltFreq');
  assert.equal(hz[0], 14);
  assert.equal(hz.at(-1), 32000);
  for (const h of sweep(s, 'synthASound.fltFreq', () => M.filterFreqHz(s, 'A', SR))) assert.ok(h <= 0.45 * SR && h > 0);
});

test('envelope times: seconds from the labels, increasing, decay ends in hold', () => {
  for (const which of ['osc', 'flt', 'amp'] as const) {
    const p = { osc: 'oscEnv', flt: 'fltEnv', amp: 'ampEnv' }[which];
    const s = fresh();
    const atk = sweep(s, `synthASound.${p}Atk` as Ns4Key, () => M.envelope(s, 'A', which).attack);
    const dcy = sweep(s, `synthASound.${p}Dcy` as Ns4Key, () => M.envelope(s, 'A', which).decay);
    const rls = sweep(s, `synthASound.${p}Rls` as Ns4Key, () => M.envelope(s, 'A', which).release);
    for (const [name, xs] of [['attack', atk], ['release', rls], ['decay', dcy.slice(0, -1)]] as const) {
      increasing(xs, true, `${which} ${name}`);
      for (const x of xs) assert.ok(Number.isFinite(x) && x > 0, `${which} ${name} ${x}`);
    }
    assert.equal(dcy.at(-1), Infinity);
    assert.equal(atk[0], 0.0005);
    assert.equal(atk.at(-1), 45);
    assert.equal(rls.at(-1), 45);
  }
});

test('layer level: gain from dB, increasing, volume off is silence, top is unity', () => {
  for (const l of LAYERS) {
    const s = fresh();
    const g = sweep(s, layerKey(l, 'synth.layerLevelSyn{L}'), () => M.layerGain(s, l));
    increasing(g, true, `level ${l}`);
    assert.equal(g[0], 0);
    assert.equal(g.at(-1), 1);
  }
});

test('pitch: note, coarse, fine and octave shift in cents re A4', () => {
  const s = fresh();
  assert.equal(M.pitchCents(s, 'A', 69), 0);
  assert.equal(M.pitchCents(s, 'A', 60), -900);
  s.set('synthASound.oscTuneCoarse', 7);
  s.set('synthASound.oscTuneFine', -20);
  s.set('synthA.octaveShift', -1);
  assert.equal(M.pitchCents(s, 'A', 69), 700 - 20 - 1200);
  increasing(sweep(s, 'synthASound.oscTuneCoarse', () => M.pitchCents(s, 'A', 60)), true, 'coarse');
  increasing(sweep(s, 'synthASound.oscTuneFine', () => M.pitchCents(s, 'A', 60)), true, 'fine');
});

test('pitch stick: ranges from the labels, bend scales, off is no bend', () => {
  const s = fresh();
  const k = 'synthA.pitchStickRange';
  s.set(k, 1); // +/- 2
  assert.deepEqual(M.bendRange(s, 'A'), { up: 2, down: 2 });
  assert.equal(M.bendCents(s, 'A', 8191), 200);
  assert.equal(M.bendCents(s, 'A', -8192), -200);
  assert.equal(M.bendCents(s, 'A', 0), 0);
  s.set(k, 9); // +2 / -24
  assert.deepEqual(M.bendRange(s, 'A'), { up: 2, down: 24 });
  assert.equal(M.bendCents(s, 'A', -8192), -2400);
  for (let v = 0; v <= 9; v++) {
    s.set(k, v);
    const r = M.bendRange(s, 'A');
    assert.ok(r.up > 0 && r.down > 0, `range ${v}`);
  }
  s.set('synthA.pStickEnable', 0);
  assert.equal(M.bendCents(s, 'A', 8191), 0);
});

test('guessed curves: documented ends, finite and increasing', () => {
  assert.equal(M.resonanceQ(0), 0.5);
  assert.ok(Math.abs(M.resonanceQ(127) - 20) < 1e-9);
  assert.equal(M.lfoRateHz(0), 0.03);
  assert.ok(Math.abs(M.lfoRateHz(127) - 60) < 1e-9);
  assert.equal(M.lphpHighpassHz(0, SR), 20);
  const steps = Array.from({ length: 128 }, (_, i) => i);
  increasing(steps.map(M.resonanceQ), true, 'Q');
  increasing(steps.map(M.lfoRateHz), true, 'lfo rate');
  increasing(steps.map((x) => M.lphpHighpassHz(x, SR)), false, 'lp+hp');
  increasing(steps.map((x) => M.lfoDepth(x, 'pitch')), true, 'lfo depth');
  assert.equal(M.lfoDepth(127, 'pitch'), 1200);
  assert.equal(M.lfoDepth(127, 'filter'), 4800);
  assert.equal(M.lfoDepth(127, 'ctrl'), 1);
  assert.equal(M.lfoDepth(127, 'none'), 0);
  assert.deepEqual([0, 1, 2, 3].map(M.driveGain), [1, 2, 4, 8]);
});

test('glide, osc ctrl, envelope amounts, vibrato: label 0.0–10.0 mapped to their ranges', () => {
  const s = fresh();
  const glide = sweep(s, 'synthA.glideRate', () => M.glideSecondsPerSemitone(s, 'A'));
  assert.equal(glide[0], 0);
  assert.ok(Math.abs(glide.at(-1)! - 0.5) < 1e-9);
  increasing(glide, false, 'glide');
  const ctrl = sweep(s, 'synthASound.oscCtrl', () => M.oscCtrl(s, 'A'));
  assert.equal(ctrl[0], 0);
  assert.equal(ctrl.at(-1), 1);
  increasing(ctrl, false, 'osc ctrl');
  const flt = sweep(s, 'synthASound.fltEnvAmt', () => M.filterEnvCents(s, 'A', 127));
  assert.equal(flt[0], 0);
  assert.ok(Math.abs(flt.at(-1)! - 9600) < 1e-6);
  s.set('synthASound.oscEnvDst', 1);
  const oscPitch = sweep(s, 'synthASound.oscEnvAmt', () => M.oscEnvDepth(s, 'A', 127).pitchCents);
  assert.ok(Math.abs(oscPitch[0]! + 2400) < 1e-6 && Math.abs(oscPitch.at(-1)! - 2400) < 1e-6);
  s.set('synthASound.oscEnvDst', 0);
  s.set('synthASound.oscEnvAmt', 60);
  assert.deepEqual(M.oscEnvDepth(s, 'A', 127), { pitchCents: 0, ctrl: 1 });
  const vib = sweep(s, 'synthASound.vibAmt', () => M.vibSpec(s, 'A').cents);
  assert.equal(vib[0], 0);
  assert.equal(vib.at(-1), 50);
  const rate = sweep(s, 'synthASound.vibRate', () => M.vibSpec(s, 'A').rateHz);
  increasing(rate, false, 'vib rate');
  assert.equal(rate[0], 2);
  assert.equal(rate.at(-1), 8);
});

test('velocity: envelope depth and amp sensitivity', () => {
  assert.equal(M.velocityDepth(false, 1), 1);
  assert.ok(Math.abs(M.velocityDepth(true, 127) - 1) < 1e-9);
  assert.ok(Math.abs(M.velocityDepth(true, 0) - 0.3) < 1e-9);
  const s = fresh();
  assert.equal(M.ampPeak(s, 'A', 1), 1); // off: no sensitivity
  s.set('synthASound.ampEnvVel', 3);
  assert.ok(Math.abs(M.ampPeak(s, 'A', 127) - 1) < 1e-9);
  assert.ok(M.ampPeak(s, 'A', 1) < 0.01);
});

test('every mapping stays finite over every MVP field range', () => {
  const s = fresh();
  const check = (what: string, x: number): void => assert.ok(Number.isFinite(x), `${what}: ${x}`);
  const all = (l: SynthLayer): void => {
    check('pitch', M.pitchCents(s, l, 60));
    check('gain', M.layerGain(s, l));
    check('pan', M.layerPan(s, l));
    check('glide', M.glideSecondsPerSemitone(s, l));
    const f = M.filterSpec(s, l, SR);
    for (const x of [f.freq, f.q, f.hpFreq, f.drive, f.kbdTrack]) check('filter', x);
    const lfo = M.lfoSpec(s, l);
    check('lfo', lfo.rateHz + lfo.depth);
    const v = M.vibSpec(s, l);
    check('vib', v.rateHz + v.cents + v.delay);
    check('flt env', M.filterEnvCents(s, l, 100));
    const o = M.oscEnvDepth(s, l, 100);
    check('osc env', o.pitchCents + o.ctrl);
    check('amp', M.ampPeak(s, l, 100));
    const e = M.envelope(s, l, 'amp');
    check('env', e.attack + e.release);
  };
  for (const key of ['synthASound.fltRes', 'synthASound.fltType', 'synthASound.fltDrive', 'synthASound.lfoRateClkDiv',
    'synthASound.lfoAmt', 'synthASound.lfoDst', 'synthASound.lfoWave', 'synthA.vibMode', 'synthA.vibDly',
    'synthA.oscUnison', 'synth.layerPanSynA', 'synthA.octaveShift', 'synthASound.fltKbdTrk'] as Ns4Key[]) {
    sweep(s, key, () => {
      all('A');
      return 0;
    });
  }
});

test('layers: scene I mask and section switch; voicing from the voice fields', () => {
  const s = fresh();
  assert.deepEqual(M.enabledLayers(s), ['A']);
  s.set('synth.layerEnableSyn_I', 6);
  assert.deepEqual(M.enabledLayers(s), ['B', 'C']);
  s.set('common.sectionEnableSyn_I', 0);
  assert.deepEqual(M.enabledLayers(s), []);
  assert.deepEqual(M.voicing(s, 'A'), { layer: 'A', mode: 'poly', priority: 'none', sustain: true });
  s.set('synthA.voiceMode', 2);
  s.set('synthA.voicePrio', 1);
  s.set('synthA.sustainEnable', 0);
  assert.deepEqual(M.voicing(s, 'A'), { layer: 'A', mode: 'legato', priority: 'low', sustain: false });
});

test('oscillator spec: analog categories, FM banks, silent wave, samples and extern layers', () => {
  const s = fresh();
  assert.deepEqual(M.oscSpec(s, 'A'), { bank: 'analog', category: 'pure', wave: 2, ctrl: 0 });
  s.set('synthASound.oscCat', 2);
  assert.equal((M.oscSpec(s, 'A') as { category: string }).category, 'sync');
  s.set('synthASound.oscBank', 2);
  s.set('synthASound.oscCat', 0);
  s.set('synthASound.oscWave', 0);
  assert.deepEqual(M.oscSpec(s, 'A'), { bank: 'fm-i', algorithm: 0, wave: 0, semitones: -12, ctrl: 0 });
  s.set('synthASound.oscBank', 3);
  assert.ok('silent' in M.oscSpec(s, 'A'));
  assert.deepEqual(M.silentLayers(s).map((x) => x.layer), ['A']);
  s.set('synthASound.oscBank', 0);
  s.set('synthA.mode', 0);
  assert.ok(/samples/.test(M.silentReason(s, 'A')!));
  s.set('synthA.mode', 1);
  s.set('synthA.externEnable', 1);
  assert.ok(/extern/.test(M.silentReason(s, 'A')!));
  s.set('synthA.externEnable', 0);
  assert.deepEqual(M.silentLayers(s), []);
  // A silent layer that is not enabled is not reported.
  s.set('synthBSound.oscBank', 3);
  assert.deepEqual(M.silentLayers(s), []);
});

test('unison: off/1/2/3 → 1–4 copies', () => {
  const s = fresh();
  const u = sweep(s, 'synthA.oscUnison', () => M.unison(s, 'A').copies);
  assert.deepEqual(u, [1, 2, 3, 4]);
});

test('coarse markers: drive always; LP M; Sync and Shape Sine, osc ctrl when swept', () => {
  const s = fresh();
  assert.deepEqual([...M.coarsePatterns(s, 'A')], ['synth{L}Sound.fltDrive']);
  s.set('synthASound.fltType', 2);
  assert.ok(M.coarsePatterns(s, 'A').has('synth{L}Sound.fltType'));
  s.set('synthASound.oscCat', 4); // shape sine
  const c = M.coarsePatterns(s, 'A');
  assert.ok(c.has('synth{L}Sound.oscWave') && !c.has('synth{L}Sound.oscCtrl'));
  s.set('synthASound.oscEnvAmt', 30);
  assert.ok(M.coarsePatterns(s, 'A').has('synth{L}Sound.oscCtrl'));
  s.set('synthASound.oscEnvAmt', 0);
  s.set('synthASound.lfoDst', 1);
  assert.ok(M.coarsePatterns(s, 'A').has('synth{L}Sound.oscCtrl'));
  s.set('synthASound.oscCat', 0);
  assert.ok(!M.coarsePatterns(s, 'A').has('synth{L}Sound.oscWave'));
});
