/**
 * The shared sources of the organ: the B3's tonewheel generator and a looped white-noise source
 * for key click and pipe chiff (plan section 13.2).
 *
 * Tonewheel generator (M p.19): 91 sine OscillatorNodes in equal temperament, wheel n at
 * 440·2^((n − 46)/12) Hz (the real gear ratios differ by less than a cent). It is created at the
 * first B3 or B3 Bass note, shared by both layers and kept until the engine is disposed; voices
 * tap it through their own contact GainNodes. The organ's pitch stick reaches every wheel's
 * detune through one ConstantSourceNode. Crosstalk and leakage are not modelled.
 */
import { noise } from '../waveforms.ts';
import { WHEELS, wheelFrequency } from './params.ts';

/** Disconnect one edge, ignoring an edge that is already gone (real nodes throw then). */
export function unlink(from: AudioNode, to: AudioNode | AudioParam): void {
  try {
    if (to instanceof AudioParam) from.disconnect(to);
    else from.disconnect(to);
  } catch {
    // already disconnected
  }
}

export class TonewheelGenerator {
  readonly #wheels: OscillatorNode[];
  readonly #bend: AudioNode;

  constructor(ctx: BaseAudioContext, bend: AudioNode) {
    this.#bend = bend;
    this.#wheels = [];
    const t = ctx.currentTime;
    for (let n = 1; n <= WHEELS; n++) {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = wheelFrequency(n);
      bend.connect(osc.detune);
      osc.start(t);
      this.#wheels.push(osc);
    }
  }

  /** Wheel n, 1..91. */
  wheel(n: number): OscillatorNode {
    const w = this.#wheels[n - 1];
    if (w === undefined) throw new RangeError(`no tonewheel ${n}`);
    return w;
  }

  dispose(): void {
    for (const w of this.#wheels) {
      w.stop();
      unlink(this.#bend, w.detune);
      w.disconnect();
    }
  }
}

/** Two seconds of looped white noise, started once and shared by every voice that needs noise. */
export class NoiseSource {
  readonly node: AudioBufferSourceNode;

  constructor(ctx: BaseAudioContext) {
    const length = Math.round(2 * ctx.sampleRate);
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    buffer.getChannelData(0).set(noise('white', length, 11));
    this.node = ctx.createBufferSource();
    this.node.buffer = buffer;
    this.node.loop = true;
    this.node.start(ctx.currentTime);
  }

  dispose(): void {
    this.node.stop();
    this.node.disconnect();
  }
}
