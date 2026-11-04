/**
 * The shared master of the editor's sound (plan section 13.5, item 6): every section engine feeds
 * its stereo output into `input`; a -12 dB headroom gain and a DynamicsCompressor as a safety
 * limiter follow, then the context's destination. One per AudioContext, shared by the organ,
 * piano and synth engines.
 *
 *   organ ┐
 *   piano ├─► input: GainNode (-12 dB) ─► DynamicsCompressor (limiter) ─► destination
 *   synth ┘
 */

const HEADROOM = 0.25; // -12 dB

export class MasterBus {
  readonly #gain: GainNode;
  readonly #limiter: DynamicsCompressorNode;

  constructor(ctx: BaseAudioContext) {
    this.#gain = ctx.createGain();
    this.#gain.gain.value = HEADROOM;
    this.#limiter = ctx.createDynamicsCompressor();
    this.#limiter.threshold.value = -6;
    this.#limiter.knee.value = 0;
    this.#limiter.ratio.value = 20;
    this.#limiter.attack.value = 0.002;
    this.#limiter.release.value = 0.1;
    this.#gain.connect(this.#limiter).connect(ctx.destination);
  }

  /** Where the section engines connect. */
  get input(): AudioNode {
    return this.#gain;
  }

  dispose(): void {
    this.#gain.disconnect();
    this.#limiter.disconnect();
  }
}
