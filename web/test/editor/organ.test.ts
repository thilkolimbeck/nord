/** Organ sound parameters (plan section 13.2): drawbars, tonewheels, models, scanner, percussion, rotary. Pure. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { preampCurve } from '../../src/editor/audio/organ/layer.ts';
import {
  B3_OFFSETS, contactsFor, drawbarKey, drawbarLevel, driveLabel, farfRegisterOn, foldWheel, gateTimes,
  layerLevelGain, micSpec, octaveSemitones, organBendCents, percussionFires, percussionSpec, pipeDetuneCents,
  pipeSumGain, rotorTargets, rotorTau, scannerSpec, tonewheelBusLevels, voxBrightness, wheelFrequency, wheelIndex,
  WHEELS,
} from '../../src/editor/audio/organ/params.ts';
import { driveCurve } from '../../src/editor/audio/organ/rotary.ts';
import { percussionWheel } from '../../src/editor/audio/organ/voice.ts';
import { farfSpectrum, pipeSpectrum, spectrumPeak, voxSpectrum, waveGain } from '../../src/editor/audio/organ/waves.ts';
import { initProgram } from '../../src/editor/model/init.ts';
import type { Ns4Key } from '../../src/editor/model/keys.ts';
import { ParamStore } from '../../src/editor/model/store.ts';

function store(entries: ReadonlyArray<readonly [Ns4Key, number]> = []): ParamStore {
  const s = new ParamStore(initProgram());
  s.setMany(entries, 'ui');
  return s;
}

const near = (a: number, b: number, eps = 1e-6): void => assert.ok(Math.abs(a - b) <= eps, `${a} ≉ ${b}`);

test('drawbar level: 0 silent, 8 full, 3 dB per step', () => {
  assert.equal(drawbarLevel(0), 0);
  assert.equal(drawbarLevel(8), 1);
  near(drawbarLevel(7), 10 ** (-3 / 20));
  near(drawbarLevel(1), 10 ** (-21 / 20));
  for (let v = 1; v <= 8; v++) assert.ok(drawbarLevel(v) > drawbarLevel(v - 1));
  near(20 * Math.log10(drawbarLevel(6) / drawbarLevel(5)), 3);
});

test('tonewheels: equal temperament from C1, the 8′ of MIDI 36 is wheel 13', () => {
  near(wheelFrequency(1), 32.7032, 1e-3);
  near(wheelFrequency(46), 440);
  near(wheelFrequency(91), 5919.91, 0.01);
  assert.equal(wheelIndex(36, 0), 13);
  near(wheelFrequency(wheelIndex(69, 0)), 440);
  assert.deepEqual(B3_OFFSETS, [-12, 7, 0, 12, 19, 24, 28, 31, 36]);
});

test('tonewheel foldback keeps every key and footage on wheels 1..91, by octaves', () => {
  assert.equal(foldWheel(0), 12);
  assert.equal(foldWheel(-5), 7);
  assert.equal(foldWheel(92), 80);
  assert.equal(foldWheel(103), 91);
  assert.equal(wheelIndex(108, 36), 85);
  assert.equal(wheelIndex(24, -12), 1, '24 − 23 − 12 = −11 folds up to 1');
  for (let m = 0; m <= 127; m++) {
    for (const o of B3_OFFSETS) {
      const w = wheelIndex(m, o);
      assert.ok(w >= 1 && w <= WHEELS, `${m} ${o} → ${w}`);
      assert.equal(((w - (m - 23 + o)) % 12 + 12) % 12, 0, 'folded by whole octaves');
    }
  }
});

test('per-model contacts: B3 nine drawbars, B3 Bass 16′ and 8′ on db1 and db2, others none', () => {
  assert.equal(contactsFor('b3', 60).length, 9);
  assert.deepEqual(contactsFor('b3bass', 48), [{ drawbar: 0, wheel: 13 }, { drawbar: 1, wheel: 25 }]);
  for (const m of ['vox', 'farf', 'pipe1', 'pipe2'] as const) assert.deepEqual(contactsFor(m, 60), []);
});

test('Farf registers switch on from position 5', () => {
  assert.equal(farfRegisterOn(4), false);
  assert.equal(farfRegisterOn(5), true);
  assert.equal(farfRegisterOn(8), true);
  const off = farfSpectrum([4, 4, 4, 4, 4, 4, 4, 4, 4], 65.41, 48000);
  assert.ok(off.imag.every((a) => a === 0), 'nothing above half way: silent');
  const flute8 = farfSpectrum([0, 0, 5, 0, 0, 0, 0, 0, 0], 65.41, 48000);
  assert.equal(flute8.imag[2], 1);
  near(flute8.imag[4]!, 0.15);
  assert.equal(flute8.imag[1], 0);
  const two = farfSpectrum([0, 0, 8, 0, 0, 0, 8, 0, 0], 65.41, 48000);
  near(two.imag[2]!, 1 / Math.SQRT2, 1e-9);
});

test('Vox: seven partial drawbars, db8 does nothing, db9 is the soft/bright mix', () => {
  const a = voxSpectrum([8, 0, 0, 0, 0, 0, 0, 0, 0], 65.41, 48000);
  assert.equal(a.imag[1], 1);
  near(a.imag[3]!, 1 / 3);
  const b = voxSpectrum([8, 0, 0, 0, 0, 0, 0, 8, 0], 65.41, 48000);
  assert.deepEqual(b.imag, a.imag);
  const high = voxSpectrum([8, 8, 8, 8, 8, 8, 8, 0, 0], 2000, 48000);
  assert.ok(high.imag.length - 1 <= Math.floor((0.45 * 48000) / 2000), 'components above 0.45 × sample rate dropped');
  assert.equal(voxBrightness(store([[drawbarKey('A', 9), 0]]), 'A'), 0);
  assert.equal(voxBrightness(store([[drawbarKey('A', 9), 4]]), 'A'), 0.5);
  assert.equal(voxBrightness(store([[drawbarKey('A', 9), 8]]), 'A'), 1);
});

test('Vox and Farf loudness: a reference registration peaks near 0.5, a full one at 1.0 at most', () => {
  const ref = voxSpectrum([8, 8, 8, 0, 0, 0, 0, 0, 0], 130.8, 48000);
  near(spectrumPeak(ref) * waveGain('vox', ref), 0.5, 0.05);
  const full = voxSpectrum([8, 8, 8, 8, 8, 8, 8, 8, 8], 65.41, 48000);
  assert.ok(spectrumPeak(full) * waveGain('vox', full) <= 1.02);
  const farfFull = farfSpectrum([8, 8, 8, 8, 8, 8, 8, 8, 8], 65.41, 48000);
  assert.ok(spectrumPeak(farfFull) * waveGain('farf', farfFull) <= 1.02);
  assert.equal(waveGain('farf', farfSpectrum([0, 0, 0, 0, 0, 0, 0, 0, 0], 65.41, 48000)), 0);
});

test('pipes: sum gain keeps three full drawbars at 0.5 and a full registration ≤ 1; detune within ±6 cents', () => {
  near(pipeSumGain([1, 1, 1, 0, 0, 0, 0, 0, 0]) * 3, 0.5);
  assert.ok(pipeSumGain(new Array(9).fill(1)) * 9 <= 1 + 1e-9);
  for (let m = 0; m < 128; m++) for (let n = 0; n < 9; n++) assert.ok(Math.abs(pipeDetuneCents(m, n)) <= 6);
  assert.notEqual(pipeDetuneCents(60, 0), pipeDetuneCents(60, 1));
  assert.deepEqual(pipeSpectrum('pipe1').imag, [0, 1, 0.1]);
  assert.equal(pipeSpectrum('pipe2').imag.length, 9);
});

test('scanner depth and mix per type, model and switch', () => {
  const on: Array<readonly [Ns4Key, number]> = [['organAVibPerc.org_Preset_kVibratoEnable', 1]];
  const b3 = (type: number) => scannerSpec(store([...on, ['organ.vibratoTypeB3', type]]), 'A', 'b3');
  assert.deepEqual([0, 1, 2, 3, 4, 5].map((v) => b3(v).type), ['V1', 'C1', 'V2', 'C2', 'V3', 'C3']);
  assert.deepEqual([0, 1, 2, 3, 4, 5].map((v) => b3(v).depth * 1000), [0.12, 0.12, 0.25, 0.25, 0.45, 0.45]);
  assert.deepEqual([b3(0).dry, b3(0).wet], [0, 1], 'vibrato is wet only');
  assert.deepEqual([b3(1).dry, b3(1).wet], [0.5, 0.5], 'chorus mixes 1:1');
  assert.equal(b3(4).rateHz, 6.9);
  assert.equal(scannerSpec(store([...on, ['organ.vibratoTypeB3', 2]]), 'A', 'b3bass').type, 'V2');
  const vox = (type: number) => scannerSpec(store([...on, ['organ.vibratoTypeVox', type]]), 'A', 'vox');
  assert.deepEqual([0, 1, 2].map((v) => [vox(v).type, vox(v).depth * 1000, vox(v).wet]), [['V1', 0.08, 1], ['V2', 0.16, 1], ['V3', 0.3, 1]]);
  const farf = (type: number) => scannerSpec(store([...on, ['organ.vibratoTypeFarfisa', type]]), 'A', 'farf');
  assert.deepEqual([0, 1, 2, 3].map((v) => [farf(v).type, Math.round(farf(v).depth * 1e5) / 100, farf(v).dry]),
    [['V1', 0.1, 0], ['V2', 0.25, 0], ['C2', 0.2, 0.5], ['C3', 0.35, 0.5]]);
  const pipe = scannerSpec(store(on), 'A', 'pipe1');
  assert.deepEqual([pipe.depth, pipe.dry, pipe.wet], [0, 1, 0], 'pipes detune instead of modulating');
  const off = scannerSpec(store(), 'A', 'b3');
  assert.deepEqual([off.depth, off.dry, off.wet, off.type], [0, 1, 0, 'off']);
  assert.equal(scannerSpec(store(on), 'B', 'b3').type, 'off', 'the switch is per layer');
});

test('percussion: B3 only, harmonic, level, speed, single trigger and poly', () => {
  const s = store([['organAVibPerc.org_Preset_kB3PercEnable', 1]]);
  const p = percussionSpec(s, 'A');
  assert.deepEqual([p.on, p.harmonic, p.offset, p.peak, p.decay, p.poly], [true, 2, 12, 1, 1.2, false]);
  assert.equal(percussionWheel(60, p), wheelIndex(60, 12));
  s.setMany([['organAVibPerc.org_Preset_kB3PercHarmonic', 1], ['organAVibPerc.org_Preset_kB3PercLevel', 1],
    ['organAVibPerc.org_Preset_kB3PercSpeed', 1]], 'ui');
  const q = percussionSpec(s, 'A');
  assert.deepEqual([q.harmonic, q.offset, q.peak, q.decay], [3, 19, 0.5, 0.4]);
  assert.equal(percussionWheel(60, q), wheelIndex(60, 19));
  assert.equal(percussionFires(q, 0), true, 'first key');
  assert.equal(percussionFires(q, 1), false, 'single-triggered: another key is held');
  s.set('organ.polyPercEnable', 1);
  assert.equal(percussionFires(percussionSpec(s, 'A'), 3), true, 'poly: every stroke');
  s.set('organA.model', 1);
  assert.equal(percussionSpec(s, 'A').on, false, 'Vox has no percussion');
  assert.equal(percussionSpec(s, 'B').on, false, 'layer B has its own switch');
});

test('percussion on mutes the B3 1′ drawbar (db9)', () => {
  const s = store([[drawbarKey('A', 9), 8]]);
  assert.equal(tonewheelBusLevels(s, 'A')[8], 1);
  s.set('organAVibPerc.org_Preset_kB3PercEnable', 1);
  assert.equal(tonewheelBusLevels(s, 'A')[8], 0);
  assert.equal(tonewheelBusLevels(s, 'A')[0], 1, 'other drawbars stay');
  s.set('organA.model', 3);
  assert.equal(tonewheelBusLevels(s, 'A')[8], 1, 'no percussion on a Pipe, no mute');
});

test('rotary speeds: slow, fast, stop, and the ramp time constants', () => {
  assert.deepEqual(rotorTargets(store()), { horn: 0.83, drum: 0.67 });
  assert.deepEqual(rotorTargets(store([['organ.effectsLeslieSpeed', 1]])), { horn: 6.7, drum: 5.7 });
  assert.deepEqual(rotorTargets(store([['organ.effectsLeslieStopMode', 1]])), { horn: 0, drum: 0 });
  assert.deepEqual(rotorTargets(store([['organ.effectsLeslieStopMode', 1], ['organ.effectsLeslieSpeed', 1]])),
    { horn: 6.7, drum: 5.7 }, 'stop mode only stops on slow');
  assert.equal(rotorTau('horn', 0.83, 6.7), 0.3);
  assert.equal(rotorTau('horn', 6.7, 0.83), 0.4);
  assert.equal(rotorTau('drum', 0.67, 5.7), 1.5);
  assert.equal(rotorTau('drum', 5.7, 0), 2.0);
});

test('rotary microphones, drive label and curve', () => {
  const normal = micSpec(store());
  const close = micSpec(store([['organ.leslieMicDistance', 1]]));
  assert.ok(close.hornDepth > normal.hornDepth && close.hornDev > normal.hornDev && close.drumDepth > normal.drumDepth);
  assert.equal(driveLabel(store()), 0);
  near(driveLabel(store([['organ.effectsLeslieDrv', 127]])), 10, 0.05);
  const linear = driveCurve(0, 9);
  assert.deepEqual(Array.from(linear), [-4, -3, -2, -1, 0, 1, 2, 3, 4], 'label 0 leaves the signal linear');
  const hot = driveCurve(10);
  assert.ok(hot.every((y) => Math.abs(y) <= 1), 'drive is bounded');
  assert.ok(hot[600]! > 0 && hot[400]! < 0);
});

test('layer level, octave shift, pitch stick and gate times', () => {
  assert.equal(layerLevelGain(store(), 'A'), 1);
  assert.equal(layerLevelGain(store([['organ.layerLevelOrgA', 0]]), 'A'), 0);
  assert.ok(layerLevelGain(store([['organ.layerLevelOrgA', 64]]), 'A') < 0.5);
  assert.equal(octaveSemitones(store([['organB.octaveShift', -2]]), 'B'), -24);
  assert.equal(octaveSemitones(store([['organB.octaveShift', 5]]), 'B'), 60, 'undecoded steps still play');
  assert.equal(organBendCents(store(), 8191), 0, 'pitch stick off');
  assert.equal(organBendCents(store([['organ.orgPStickEnable', 1]]), 8191), 200);
  assert.equal(organBendCents(store([['organ.orgPStickEnable', 1]]), -8192), -200);
  assert.ok(gateTimes('pipe2').attack > gateTimes('pipe1').attack && gateTimes('pipe1').attack > gateTimes('b3').attack);
  assert.equal(gateTimes('b3bass').attack, 0.005);
});

test('preamp curve: one key of 888 at ≈ 0.5, never above 1', () => {
  const curve = preampCurve(4097);
  const at = (x: number): number => curve[Math.round(((x / 4 + 1) / 2) * 4096)]!;
  near(at(3 * 0.122), 0.5, 0.01);
  assert.ok(at(9 * 0.122) <= 1);
  assert.ok(curve.every((y) => Math.abs(y) <= 1));
});
