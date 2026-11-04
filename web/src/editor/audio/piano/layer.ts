/**
 * One piano layer's shared nodes (plan section 13.3):
 *
 *   voices ─► input GainNode ─► 4 timbre BiquadFilterNodes ─► level GainNode ─► out (shared master)
 *   eligible voices ─► resonance send GainNode ─► 12 feedback combs ─► low-pass 4 kHz ─► wet (−18 dB) ─► input
 *   bend ConstantSourceNode (cents) ─► every voice's OscillatorNode.detune
 *
 * The comb bank (string resonance, p.25) is built at the first voice that feeds it. Its send is
 * open (−24 dB) only while the sustain pedal holds the layer and String Res is on, and closes over
 * 0.3 s at pedal-up.
 */
import { TAU_DIVISOR } from '../envelope.ts';
import type { PianoLayer } from '../../model/scene.ts';
import type { ValueReader } from '../../model/labels.ts';
import { bendCents, layerGain, layerSettings, TIMBRE_BANDS, timbreBands } from './mapping.ts';
import { noteHz } from './recipes.ts';

const SMOOTH = 0.01;
const SEND_LEVEL = 10 ** (-24 / 20);
const WET_LEVEL = 10 ** (-18 / 20);
const COMB_FEEDBACK = 0.97;
const SEND_CLOSE_SECONDS = 0.3;

interface Resonance {
  readonly send: GainNode;
  readonly delays: DelayNode[];
  readonly feedback: GainNode[];
  readonly lowpass: BiquadFilterNode;
  readonly wet: GainNode;
}

export class PianoLayerNodes {
  readonly layer: PianoLayer;
  /** Where voices connect. */
  readonly input: GainNode;
  /** The pitch stick in cents; voices connect it to their oscillators' detune. */
  readonly bend: ConstantSourceNode;
  readonly #ctx: BaseAudioContext;
  readonly #bands: BiquadFilterNode[];
  readonly #level: GainNode;
  #res: Resonance | null = null;
  #sendOpen = false;

  constructor(ctx: BaseAudioContext, layer: PianoLayer, out: AudioNode) {
    this.#ctx = ctx;
    this.layer = layer;
    this.input = ctx.createGain();
    this.#bands = Array.from({ length: TIMBRE_BANDS }, () => {
      const f = ctx.createBiquadFilter();
      f.type = 'peaking';
      f.gain.value = 0;
      return f;
    });
    this.#level = ctx.createGain();
    let node: AudioNode = this.input;
    for (const f of this.#bands) node = node.connect(f);
    node.connect(this.#level).connect(out);
    this.bend = ctx.createConstantSource();
    this.bend.offset.value = 0;
    this.bend.start();
  }

  /** Whether the comb bank exists (for tests and the dev handle). */
  get hasResonance(): boolean {
    return this.#res !== null;
  }

  /** Whether the resonance send is open (pedal down, String Res on, sustain switch on). */
  get sendOpen(): boolean {
    return this.#sendOpen;
  }

  updateLevel(values: ValueReader, t: number): void {
    this.#level.gain.setTargetAtTime(layerGain(values, this.layer), t, SMOOTH);
  }

  /** The timbre set follows the layer's type (piano{X}.bank) and value (piano{X}.eq); unused bands go flat. */
  updateTimbre(values: ValueReader, t: number): void {
    const s = layerSettings(values, this.layer);
    const bands = timbreBands(s.type, s.eq);
    this.#bands.forEach((f, i) => {
      const band = bands[i];
      if (band === undefined) {
        f.type = 'peaking';
        f.gain.setTargetAtTime(0, t, SMOOTH);
        return;
      }
      f.type = band.type;
      f.frequency.setTargetAtTime(band.freq, t, SMOOTH);
      f.gain.setTargetAtTime(band.gain, t, SMOOTH);
      f.Q.setTargetAtTime(band.Q, t, SMOOTH);
    });
  }

  updateBend(values: ValueReader, bend: number, t: number): void {
    this.bend.offset.setTargetAtTime(bendCents(values, this.layer, bend), t, 0.005);
  }

  /** Open or close the resonance send for the pedal state and the layer's String Res and sustain switches. */
  updateSend(values: ValueReader, pedal: boolean, t: number): void {
    const s = layerSettings(values, this.layer);
    const open = pedal && s.sustain && s.stringRes;
    this.#sendOpen = open;
    if (this.#res === null) return;
    if (open) this.#res.send.gain.setTargetAtTime(SEND_LEVEL, t, SMOOTH);
    else this.#res.send.gain.setTargetAtTime(0, t, SEND_CLOSE_SECONDS / TAU_DIVISOR);
  }

  /** The resonance send a voice feeds; builds the comb bank at the first call. */
  resonanceSend(): AudioNode {
    if (this.#res === null) {
      const ctx = this.#ctx;
      const send = ctx.createGain();
      send.gain.value = this.#sendOpen ? SEND_LEVEL : 0;
      const lowpass = ctx.createBiquadFilter();
      lowpass.type = 'lowpass';
      lowpass.frequency.value = 4000;
      const wet = ctx.createGain();
      wet.gain.value = WET_LEVEL;
      const delays: DelayNode[] = [];
      const feedback: GainNode[] = [];
      for (let pc = 0; pc < 12; pc++) {
        const d = ctx.createDelay(0.05);
        d.delayTime.value = 1 / noteHz(48 + pc); // the 12 pitch classes in octave 3
        const g = ctx.createGain();
        g.gain.value = COMB_FEEDBACK;
        send.connect(d);
        d.connect(g).connect(d);
        d.connect(lowpass);
        delays.push(d);
        feedback.push(g);
      }
      lowpass.connect(wet).connect(this.input);
      this.#res = { send, delays, feedback, lowpass, wet };
    }
    return this.#res.send;
  }

  dispose(): void {
    this.bend.stop();
    for (const n of [this.input, ...this.#bands, this.#level, this.bend]) n.disconnect();
    const r = this.#res;
    if (r !== null) for (const n of [r.send, ...r.delays, ...r.feedback, r.lowpass, r.wet]) n.disconnect();
    this.#res = null;
  }
}
