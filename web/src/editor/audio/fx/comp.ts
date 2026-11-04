/**
 * Compressor (manual p.52, plan section 15.1): a DynamicsCompressorNode with make-up gain. The
 * amount curve is invented: threshold −4a dB, ratio 1.5 + 0.65a, make-up +0.6a dB for the label a
 * (0.0–10.0); release 250 ms, Fast 60 ms.
 */
import type { CompSettings } from './params.ts';
import { gainNode, glide, release, type Stage } from './nodes.ts';

export class Compressor implements Stage<CompSettings> {
  readonly input: DynamicsCompressorNode;
  readonly output: GainNode;
  constructor(ctx: BaseAudioContext) {
    this.input = ctx.createDynamicsCompressor();
    this.output = gainNode(ctx);
    this.input.connect(this.output);
  }

  update(s: CompSettings, t: number): void {
    glide(this.input.threshold, s.thresholdDb, t);
    glide(this.input.ratio, s.ratio, t);
    glide(this.input.knee, s.knee, t);
    glide(this.input.attack, s.attack, t);
    glide(this.input.release, s.release, t);
    glide(this.output.gain, 10 ** (s.makeUpDb / 20), t);
  }

  dispose(): void {
    release([this.input, this.output]);
  }
}
