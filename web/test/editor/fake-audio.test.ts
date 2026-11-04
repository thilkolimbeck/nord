/** The shared fake audio context (test/editor/fake-audio.ts) behaves as the engine tests rely on. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FakeContext, FakeParam, installAudioGlobals } from './fake-audio.ts';

test('connections, automation and source lifetimes are recorded', () => {
  installAudioGlobals();
  const ctx = new FakeContext();
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  const lfo = ctx.createConstantSource();
  osc.connect(gain).connect(ctx.destination);
  lfo.connect(osc.detune);
  assert.ok(osc.outputs.has(gain) && gain.outputs.has(ctx.destination));
  assert.ok(osc.detune.inputs.has(lfo));
  gain.gain.setTargetAtTime(0.5, 0, 0.01);
  assert.equal(gain.gain.value, 0.5);
  assert.deepEqual(gain.gain.events, [{ kind: 'target', value: 0.5, time: 0, tau: 0.01 }]);
  assert.ok(globalThis.AudioParam === (FakeParam as unknown));
  assert.ok(osc.detune instanceof AudioParam);

  let ended = 0;
  osc.onended = () => { ended += 1; };
  osc.start(0);
  lfo.start(0);
  osc.stop(0.5);
  assert.equal(ctx.live().length, 2);
  assert.equal(ctx.advance(0.4), 0);
  assert.equal(ctx.advance(0.6), 1);
  assert.equal(ended, 1);
  assert.equal(ctx.live().length, 1);
  assert.equal(ctx.count('oscillator'), 1);
  assert.equal(ctx.count('gain'), 1);

  lfo.disconnect();
  assert.equal(osc.detune.inputs.size, 0);
  assert.throws(() => osc.start(1), /started twice/);
  const buf = ctx.createBuffer(2, 480, ctx.sampleRate);
  assert.equal(buf.getChannelData(1).length, 480);
  assert.equal(buf.duration, 0.01);
  const wave = ctx.createPeriodicWave(new Float32Array(4), new Float32Array(4));
  osc.setPeriodicWave(wave);
  assert.equal(osc.type, 'custom');
});
