/** The browser synth on a fake audio context: voices start and end, panic, the 46-voice cap, live filter changes. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SynthEngine } from '../../src/editor/audio/engine.ts';
import { filterSpec } from '../../src/editor/audio/mapping.ts';
import { MAX_VOICES, VoiceAllocator } from '../../src/editor/audio/voice-alloc.ts';
import type { PlayEvent } from '../../src/editor/input/events.ts';
import { initProgram } from '../../src/editor/model/init.ts';
import { ParamStore } from '../../src/editor/model/store.ts';

// A minimal stand-in for the Web Audio nodes the engine, voice and oscillator code create. Automation
// jumps straight to its target value; sources record their stop time and fire onended when the test
// advances the clock past it.

class FakeParam {
  value: number;
  constructor(value = 0) {
    this.value = value;
  }
  setValueAtTime(v: number): this { this.value = v; return this; }
  linearRampToValueAtTime(v: number): this { this.value = v; return this; }
  setTargetAtTime(v: number): this { this.value = v; return this; }
  cancelScheduledValues(): this { return this; }
}

class FakeNode {
  readonly ctx: FakeContext;
  constructor(ctx: FakeContext) {
    this.ctx = ctx;
  }
  connect<T>(dest: T): T { return dest; }
  disconnect(): void {}
}

class FakeSource extends FakeNode {
  onended: (() => void) | null = null;
  started = false;
  ended = false;
  stopAt = Infinity;
  constructor(ctx: FakeContext) {
    super(ctx);
    ctx.sources.push(this);
  }
  start(): void { this.started = true; }
  stop(t = this.ctx.currentTime): void { this.stopAt = t; }
}

class FakeOscillator extends FakeSource {
  type = 'sine';
  readonly frequency = new FakeParam(440);
  readonly detune = new FakeParam();
  setPeriodicWave(): void {}
}

class FakeBufferSource extends FakeSource {
  buffer: unknown = null;
  loop = false;
  readonly playbackRate = new FakeParam(1);
}

class FakePeriodicWave {}

class FakeContext {
  currentTime = 0;
  readonly sampleRate = 48000;
  readonly sources: FakeSource[] = [];
  readonly destination = new FakeNode(this);

  /** Move the clock to `t` and fire onended on every started source whose stop time has passed. */
  advance(t: number): number {
    this.currentTime = t;
    let fired = 0;
    for (const s of [...this.sources]) {
      if (!s.started || s.ended || s.stopAt > t) continue;
      s.ended = true;
      fired += 1;
      s.onended?.();
    }
    return fired;
  }

  createGain() { return Object.assign(new FakeNode(this), { gain: new FakeParam(1) }); }
  createStereoPanner() { return Object.assign(new FakeNode(this), { pan: new FakeParam() }); }
  createDelay() { return Object.assign(new FakeNode(this), { delayTime: new FakeParam() }); }
  createWaveShaper() { return Object.assign(new FakeNode(this), { curve: null as unknown, oversample: 'none' }); }
  createBiquadFilter() {
    return Object.assign(new FakeNode(this),
      { type: 'lowpass', frequency: new FakeParam(350), Q: new FakeParam(1), detune: new FakeParam() });
  }
  createDynamicsCompressor() {
    return Object.assign(new FakeNode(this), {
      threshold: new FakeParam(), knee: new FakeParam(), ratio: new FakeParam(), attack: new FakeParam(),
      release: new FakeParam(),
    });
  }
  createConstantSource() { return Object.assign(new FakeSource(this), { offset: new FakeParam(1) }); }
  createOscillator() { return new FakeOscillator(this); }
  createBufferSource() { return new FakeBufferSource(this); }
  createBuffer(_channels: number, length: number) {
    const data = new Float32Array(length);
    return { getChannelData: () => data };
  }
  createPeriodicWave() { return new FakePeriodicWave(); }
}

// The audio code checks node kinds with instanceof against these globals, which Node does not have.
Object.assign(globalThis, {
  AudioParam: FakeParam, OscillatorNode: FakeOscillator, AudioBufferSourceNode: FakeBufferSource,
  PeriodicWave: FakePeriodicWave,
});

function setup() {
  const ctx = new FakeContext();
  const store = new ParamStore(initProgram());
  const alloc = new VoiceAllocator();
  const engine = new SynthEngine(ctx as unknown as BaseAudioContext, store, alloc);
  store.onChange((batch) => engine.applyChanges(batch));
  const play = (e: PlayEvent): void => engine.handle(e);
  const on = (note: number): void => play({ type: 'noteOn', note, velocity: 100, source: 'midi' });
  const off = (note: number): void => play({ type: 'noteOff', note, source: 'midi' });
  return { ctx, store, alloc, engine, play, on, off };
}

test('noteOn starts one voice', () => {
  const { engine, on } = setup();
  on(60);
  assert.equal(engine.activeCount, 1);
  assert.deepEqual(engine.voices().map((v) => [v.layer, v.note]), [['A', 60]]);
});

test('noteOff frees the voice once its sources have ended', () => {
  const { ctx, engine, on, off } = setup();
  on(60);
  off(60);
  assert.equal(engine.activeCount, 1, 'still releasing until the sources end');
  assert.ok(ctx.advance(1) > 0, 'sources ended');
  assert.equal(engine.activeCount, 0);
  assert.deepEqual(engine.voices(), []);
});

test('panic frees held, sustained and releasing voices at once; late onended changes nothing', () => {
  const { ctx, alloc, engine, play, on, off } = setup();
  on(64);
  off(64); // releasing
  play({ type: 'sustain', on: true });
  on(62);
  off(62); // sustained
  on(60); // held
  assert.deepEqual(alloc.voices().map((v) => [v.note, v.state]).sort(),
    [[60, 'held'], [62, 'sustained'], [64, 'releasing']]);
  assert.equal(engine.voices().length, 3);
  play({ type: 'panic' });
  assert.equal(engine.activeCount, 0);
  assert.deepEqual(engine.voices(), []);
  assert.ok(ctx.advance(1) > 0, 'the killed voices end later');
  assert.equal(engine.activeCount, 0);
  assert.deepEqual(engine.voices(), []);
  on(67);
  assert.equal(engine.activeCount, 1);
  assert.deepEqual(engine.voices().map((v) => v.note), [67]);
});

test('47 notes stay within the 46-voice cap', () => {
  const { engine, on } = setup();
  for (let i = 0; i < 47; i++) on(36 + i);
  assert.equal(MAX_VOICES, 46);
  assert.equal(engine.activeCount, 46);
  assert.equal(engine.voices().length, 46);
  assert.ok(!engine.voices().some((v) => v.note === 36), 'the oldest voice was stolen');
});

test('a filter frequency change in the store reaches the sounding voices', () => {
  const { ctx, store, engine, on } = setup();
  on(60);
  on(64);
  const before = engine.voices().flatMap((v) => v.filterHz);
  assert.ok(before.length > 0, 'the init program has the filter on');
  store.set('synthASound.fltFreq', 40);
  const want = filterSpec(store, 'A', ctx.sampleRate).freq;
  const after = engine.voices().flatMap((v) => v.filterHz);
  assert.ok(after.every((hz, i) => hz !== before[i]), 'every filter moved');
  assert.equal(after.length, before.length);
  for (const hz of after) assert.equal(hz, want);
});
