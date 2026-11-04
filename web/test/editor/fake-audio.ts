/**
 * A stand-in for the Web Audio nodes the editor's engines create, for DOM-free and Web-Audio-free
 * tests (plan section 13.7). Shared by the organ, piano, router and synth tests: extend it in a test
 * file by subclassing, do not edit it per engine.
 *
 * - Automation jumps straight to its target value and is recorded in `events`.
 * - connect() records the edge; disconnect() removes it (all edges, or the one named).
 * - Sources record start and stop times; advance(t) moves the clock and fires onended on every
 *   started source whose stop time has passed.
 * - `created` counts nodes by factory name, `live()` lists the sources that have started and not ended.
 *
 * installAudioGlobals() puts the fake classes on globalThis under the Web Audio names, because
 * engine code may test node kinds with instanceof (AudioParam, OscillatorNode, …), which Node lacks.
 */

export type AutomationEvent =
  | { readonly kind: 'set'; readonly value: number; readonly time: number }
  | { readonly kind: 'linear' | 'exponential'; readonly value: number; readonly time: number }
  | { readonly kind: 'target'; readonly value: number; readonly time: number; readonly tau: number }
  | { readonly kind: 'curve'; readonly values: readonly number[]; readonly time: number; readonly duration: number }
  | { readonly kind: 'cancel' | 'hold'; readonly time: number };

export class FakeParam {
  value: number;
  readonly defaultValue: number;
  readonly events: AutomationEvent[] = [];
  /** Nodes connected into this parameter (modulation). */
  readonly inputs = new Set<FakeNode>();
  constructor(value = 0) {
    this.value = value;
    this.defaultValue = value;
  }
  setValueAtTime(value: number, time: number): this {
    this.value = value;
    this.events.push({ kind: 'set', value, time });
    return this;
  }
  linearRampToValueAtTime(value: number, time: number): this {
    this.value = value;
    this.events.push({ kind: 'linear', value, time });
    return this;
  }
  exponentialRampToValueAtTime(value: number, time: number): this {
    if (value === 0) throw new RangeError('exponentialRampToValueAtTime needs a non-zero value');
    this.value = value;
    this.events.push({ kind: 'exponential', value, time });
    return this;
  }
  setTargetAtTime(value: number, time: number, tau: number): this {
    this.value = value;
    this.events.push({ kind: 'target', value, time, tau });
    return this;
  }
  setValueCurveAtTime(values: ArrayLike<number>, time: number, duration: number): this {
    const list = Array.from(values);
    this.value = list.at(-1) ?? this.value;
    this.events.push({ kind: 'curve', values: list, time, duration });
    return this;
  }
  cancelScheduledValues(time: number): this {
    this.events.push({ kind: 'cancel', time });
    return this;
  }
  cancelAndHoldAtTime(time: number): this {
    this.events.push({ kind: 'hold', time });
    return this;
  }
}

export class FakeNode {
  readonly ctx: FakeContext;
  readonly kind: string;
  /** Where this node's output goes: nodes and parameters. */
  readonly outputs = new Set<FakeNode | FakeParam>();
  channelCount = 2;
  constructor(ctx: FakeContext, kind: string) {
    this.ctx = ctx;
    this.kind = kind;
    ctx.created.set(kind, (ctx.created.get(kind) ?? 0) + 1);
  }
  connect<T extends FakeNode | FakeParam>(dest: T): T {
    this.outputs.add(dest);
    if (dest instanceof FakeParam) dest.inputs.add(this);
    return dest;
  }
  disconnect(dest?: FakeNode | FakeParam): void {
    if (dest === undefined) {
      for (const d of this.outputs) if (d instanceof FakeParam) d.inputs.delete(this);
      this.outputs.clear();
      return;
    }
    this.outputs.delete(dest);
    if (dest instanceof FakeParam) dest.inputs.delete(this);
  }
}

export class FakeSource extends FakeNode {
  onended: (() => void) | null = null;
  started = false;
  startAt = 0;
  ended = false;
  stopAt = Infinity;
  constructor(ctx: FakeContext, kind: string) {
    super(ctx, kind);
    ctx.sources.push(this);
  }
  start(when = this.ctx.currentTime): void {
    if (this.started) throw new Error(`${this.kind} started twice`);
    this.started = true;
    this.startAt = when;
  }
  stop(when = this.ctx.currentTime): void {
    this.stopAt = when;
  }
}

export class FakePeriodicWave {
  readonly real: readonly number[];
  readonly imag: readonly number[];
  constructor(real: ArrayLike<number>, imag: ArrayLike<number>) {
    this.real = Array.from(real);
    this.imag = Array.from(imag);
  }
}

export class FakeOscillator extends FakeSource {
  type: OscillatorType = 'sine';
  readonly frequency = new FakeParam(440);
  readonly detune = new FakeParam();
  wave: FakePeriodicWave | null = null;
  constructor(ctx: FakeContext) {
    super(ctx, 'oscillator');
  }
  setPeriodicWave(wave: FakePeriodicWave): void {
    this.type = 'custom';
    this.wave = wave;
  }
}

export class FakeAudioBuffer {
  readonly numberOfChannels: number;
  readonly length: number;
  readonly sampleRate: number;
  readonly #data: Float32Array[];
  constructor(channels: number, length: number, sampleRate: number) {
    this.numberOfChannels = channels;
    this.length = length;
    this.sampleRate = sampleRate;
    this.#data = Array.from({ length: channels }, () => new Float32Array(length));
  }
  get duration(): number {
    return this.length / this.sampleRate;
  }
  getChannelData(channel: number): Float32Array {
    const data = this.#data[channel];
    if (data === undefined) throw new RangeError(`no channel ${channel}`);
    return data;
  }
}

export class FakeBufferSource extends FakeSource {
  buffer: FakeAudioBuffer | null = null;
  loop = false;
  loopStart = 0;
  loopEnd = 0;
  readonly playbackRate = new FakeParam(1);
  readonly detune = new FakeParam();
  constructor(ctx: FakeContext) {
    super(ctx, 'bufferSource');
  }
}

export class FakeConstantSource extends FakeSource {
  readonly offset = new FakeParam(1);
  constructor(ctx: FakeContext) {
    super(ctx, 'constantSource');
  }
}

export class FakeGain extends FakeNode {
  readonly gain = new FakeParam(1);
  constructor(ctx: FakeContext) {
    super(ctx, 'gain');
  }
}

export class FakeStereoPanner extends FakeNode {
  readonly pan = new FakeParam();
  constructor(ctx: FakeContext) {
    super(ctx, 'stereoPanner');
  }
}

export class FakeDelay extends FakeNode {
  readonly delayTime = new FakeParam();
  readonly maxDelayTime: number;
  constructor(ctx: FakeContext, maxDelayTime = 1) {
    super(ctx, 'delay');
    this.maxDelayTime = maxDelayTime;
  }
}

export class FakeWaveShaper extends FakeNode {
  curve: Float32Array | null = null;
  oversample: OverSampleType = 'none';
  constructor(ctx: FakeContext) {
    super(ctx, 'waveShaper');
  }
}

export class FakeBiquad extends FakeNode {
  type: BiquadFilterType = 'lowpass';
  readonly frequency = new FakeParam(350);
  readonly Q = new FakeParam(1);
  readonly gain = new FakeParam();
  readonly detune = new FakeParam();
  constructor(ctx: FakeContext) {
    super(ctx, 'biquadFilter');
  }
  getFrequencyResponse(): void {}
}

export class FakeCompressor extends FakeNode {
  readonly threshold = new FakeParam(-24);
  readonly knee = new FakeParam(30);
  readonly ratio = new FakeParam(12);
  readonly attack = new FakeParam(0.003);
  readonly release = new FakeParam(0.25);
  readonly reduction = 0;
  constructor(ctx: FakeContext) {
    super(ctx, 'dynamicsCompressor');
  }
}

export class FakeConvolver extends FakeNode {
  buffer: FakeAudioBuffer | null = null;
  normalize = true;
  constructor(ctx: FakeContext) {
    super(ctx, 'convolver');
  }
}

export class FakeContext {
  currentTime = 0;
  readonly sampleRate: number;
  readonly state = 'running';
  readonly sources: FakeSource[] = [];
  /** Nodes created so far, by factory name ('oscillator', 'gain', …). */
  readonly created = new Map<string, number>();
  readonly destination: FakeNode;

  constructor(sampleRate = 48000) {
    this.sampleRate = sampleRate;
    this.destination = new FakeNode(this, 'destination');
  }

  /** Move the clock to `t`; fire onended on every started source whose stop time has passed. Returns how many ended. */
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

  /** Sources that have started and not ended. */
  live(): FakeSource[] {
    return this.sources.filter((s) => s.started && !s.ended);
  }

  count(kind: string): number {
    return this.created.get(kind) ?? 0;
  }

  createGain(): FakeGain { return new FakeGain(this); }
  createStereoPanner(): FakeStereoPanner { return new FakeStereoPanner(this); }
  createDelay(maxDelayTime?: number): FakeDelay { return new FakeDelay(this, maxDelayTime); }
  createWaveShaper(): FakeWaveShaper { return new FakeWaveShaper(this); }
  createBiquadFilter(): FakeBiquad { return new FakeBiquad(this); }
  createDynamicsCompressor(): FakeCompressor { return new FakeCompressor(this); }
  createConvolver(): FakeConvolver { return new FakeConvolver(this); }
  createConstantSource(): FakeConstantSource { return new FakeConstantSource(this); }
  createOscillator(): FakeOscillator { return new FakeOscillator(this); }
  createBufferSource(): FakeBufferSource { return new FakeBufferSource(this); }
  createChannelSplitter(outputs = 6): FakeNode {
    return Object.assign(new FakeNode(this, 'channelSplitter'), { numberOfOutputs: outputs });
  }
  createChannelMerger(inputs = 6): FakeNode {
    return Object.assign(new FakeNode(this, 'channelMerger'), { numberOfInputs: inputs });
  }
  createBuffer(channels: number, length: number, sampleRate: number): FakeAudioBuffer {
    return new FakeAudioBuffer(channels, length, sampleRate);
  }
  createPeriodicWave(real: ArrayLike<number>, imag: ArrayLike<number>): FakePeriodicWave {
    if (real.length !== imag.length || real.length < 2) throw new RangeError('real and imag need the same length, at least 2');
    return new FakePeriodicWave(real, imag);
  }
}

/** The fake as the type the engines take. */
export function asContext(ctx: FakeContext): BaseAudioContext {
  return ctx as unknown as BaseAudioContext;
}

/** A node to hand an engine as SectionContext.out. */
export function asNode(node: FakeNode): AudioNode {
  return node as unknown as AudioNode;
}

/** Register the fake classes under the Web Audio global names (Node has none). Call once per test file. */
export function installAudioGlobals(): void {
  Object.assign(globalThis, {
    AudioParam: FakeParam, AudioNode: FakeNode, AudioScheduledSourceNode: FakeSource,
    OscillatorNode: FakeOscillator, AudioBufferSourceNode: FakeBufferSource, ConstantSourceNode: FakeConstantSource,
    GainNode: FakeGain, StereoPannerNode: FakeStereoPanner, DelayNode: FakeDelay, WaveShaperNode: FakeWaveShaper,
    BiquadFilterNode: FakeBiquad, DynamicsCompressorNode: FakeCompressor, ConvolverNode: FakeConvolver,
    AudioBuffer: FakeAudioBuffer, PeriodicWave: FakePeriodicWave,
  });
}
