/**
 * One organ layer's shared nodes (plan section 13.2):
 *
 *   tonewheel contacts ─► 9 drawbar buses ─┐
 *   key click, percussion ─────────────────┴► sum ─► low-shelf +3 dB @ 100 Hz ─► preamp tanh ─┐
 *   Vox voices ─► low-pass 1.2 kHz × (1 − bright) ┬────────────────────────────────────────────┤
 *              └► direct × bright ───────────────┘                                            │
 *   Pipe oscillators ─► 9 pipe drawbar buses ─► pipe sum ─────────────────────────────────────┤
 *   Farf voices, pipe chiff ──────────────────────────────────────────────────────────────────┴► pre
 *   pre ─► dry ─────────────────────────────┬─► layer level ─► organ bus
 *   pre ─► DelayNode (scanner) ─► wet ──────┘    LFO ─► depth ─► DelayNode.delayTime
 *
 * A drawbar move is one param change per bus. The scanner follows the layer's current model, so
 * after a model change the voices still sounding with the old model hear the new model's scanner.
 */
import type { ValueReader } from '../../model/labels.ts';
import type { OrganLayer } from '../section.ts';
import {
  drawbarLevel, drawbars, layerLevelGain, modelOf, pipeSumGain, SCANNER_CENTRE, scannerSpec, tonewheelBusLevels,
  voxBrightness,
} from './params.ts';

const SMOOTH = 0.01;
/**
 * Tonewheel loudness: one key with three full drawbars peaks at about 0.5 after the preamp and a
 * full registration below 1.0. The preamp curve covers ±PREAMP_DOMAIN, so chords saturate softly.
 */
const TONEWHEEL_SCALE = 0.122;
const PREAMP_DOMAIN = 4;
/** The preamp's tanh slope (M p.19 "body"; coarse). */
const PREAMP_DRIVE = 1.5;

/** The preamp curve over u in −1..1 standing for inputs u × PREAMP_DOMAIN: y = tanh(1.5·x). */
export function preampCurve(n = 1024): Float32Array<ArrayBuffer> {
  const out = new Float32Array(new ArrayBuffer(n * 4));
  for (let i = 0; i < n; i++) {
    const x = ((i / (n - 1)) * 2 - 1) * PREAMP_DOMAIN;
    out[i] = Math.tanh(PREAMP_DRIVE * x);
  }
  return out;
}

/** Where a voice of the layer connects. */
export interface LayerTaps {
  /** Drawbar buses 1..9 of the tonewheel path (index 0..8). */
  readonly drawbarBuses: readonly GainNode[];
  /** Into the tonewheel path after the drawbars: key click and percussion. */
  readonly tonewheelIn: AudioNode;
  readonly voxIn: AudioNode;
  /** Pipe drawbar buses 1..9 (index 0..8). */
  readonly pipeBuses: readonly GainNode[];
  /** Straight to the scanner: Farf voices and pipe chiff. */
  readonly directIn: AudioNode;
}

export class OrganLayerNodes {
  readonly taps: LayerTaps;
  readonly #layer: OrganLayer;
  readonly #nodes: AudioNode[] = [];
  readonly #drawbarBuses: GainNode[];
  readonly #pipeBuses: GainNode[];
  readonly #pipeSum: GainNode;
  readonly #soft: GainNode;
  readonly #bright: GainNode;
  readonly #dry: GainNode;
  readonly #wet: GainNode;
  readonly #delay: DelayNode;
  readonly #lfo: OscillatorNode;
  readonly #depth: GainNode;
  readonly #level: GainNode;

  constructor(ctx: BaseAudioContext, layer: OrganLayer, out: AudioNode) {
    this.#layer = layer;
    const gain = (value = 1): GainNode => {
      const g = ctx.createGain();
      g.gain.value = value;
      this.#nodes.push(g);
      return g;
    };
    const pre = gain();
    this.#level = gain(0);
    this.#dry = gain(1);
    this.#wet = gain(0);
    this.#delay = ctx.createDelay(0.01);
    this.#delay.delayTime.value = SCANNER_CENTRE;
    this.#depth = gain(0);
    this.#lfo = ctx.createOscillator();
    this.#lfo.type = 'sine';
    this.#lfo.connect(this.#depth).connect(this.#delay.delayTime);
    pre.connect(this.#dry).connect(this.#level);
    pre.connect(this.#delay).connect(this.#wet).connect(this.#level);
    this.#level.connect(out);

    const sum = gain(TONEWHEEL_SCALE / PREAMP_DOMAIN);
    const shelf = ctx.createBiquadFilter();
    shelf.type = 'lowshelf';
    shelf.frequency.value = 100;
    shelf.gain.value = 3;
    const preamp = ctx.createWaveShaper();
    preamp.curve = preampCurve();
    sum.connect(shelf).connect(preamp).connect(pre);
    this.#drawbarBuses = Array.from({ length: 9 }, () => {
      const g = gain(0);
      g.connect(sum);
      return g;
    });

    const voxIn = gain();
    const lowpass = ctx.createBiquadFilter();
    lowpass.type = 'lowpass';
    lowpass.frequency.value = 1200;
    lowpass.Q.value = Math.SQRT1_2;
    this.#soft = gain(0);
    this.#bright = gain(0);
    voxIn.connect(lowpass).connect(this.#soft).connect(pre);
    voxIn.connect(this.#bright).connect(pre);

    this.#pipeSum = gain(1 / 6);
    this.#pipeSum.connect(pre);
    this.#pipeBuses = Array.from({ length: 9 }, () => {
      const g = gain(0);
      g.connect(this.#pipeSum);
      return g;
    });

    this.#nodes.push(this.#delay, this.#lfo, shelf, preamp, lowpass);
    this.#lfo.start(ctx.currentTime);
    this.taps = {
      drawbarBuses: this.#drawbarBuses, tonewheelIn: sum, voxIn, pipeBuses: this.#pipeBuses, directIn: pre,
    };
  }

  get layer(): OrganLayer {
    return this.#layer;
  }

  /** Drawbar bus gains, the pipe sum and the Vox soft/bright mix. Vox and Farf voices rebuild their own waves. */
  updateDrawbars(values: ValueReader, t: number): void {
    const tw = tonewheelBusLevels(values, this.#layer);
    tw.forEach((level, i) => this.#drawbarBuses[i]!.gain.setTargetAtTime(level, t, SMOOTH));
    const pipe = drawbars(values, this.#layer).map(drawbarLevel);
    pipe.forEach((level, i) => this.#pipeBuses[i]!.gain.setTargetAtTime(level, t, SMOOTH));
    this.#pipeSum.gain.setTargetAtTime(pipeSumGain(pipe), t, SMOOTH);
    const bright = voxBrightness(values, this.#layer);
    this.#soft.gain.setTargetAtTime(1 - bright, t, SMOOTH);
    this.#bright.gain.setTargetAtTime(bright, t, SMOOTH);
  }

  updateLevel(values: ValueReader, t: number): void {
    this.#level.gain.setTargetAtTime(layerLevelGain(values, this.#layer), t, SMOOTH);
  }

  /** The scanner of the layer's current model and vibrato settings. */
  updateScanner(values: ValueReader, t: number): void {
    const s = scannerSpec(values, this.#layer, modelOf(values, this.#layer));
    this.#lfo.frequency.setTargetAtTime(s.rateHz, t, SMOOTH);
    this.#depth.gain.setTargetAtTime(s.depth, t, SMOOTH);
    this.#dry.gain.setTargetAtTime(s.dry, t, SMOOTH);
    this.#wet.gain.setTargetAtTime(s.wet, t, SMOOTH);
  }

  refresh(values: ValueReader, t: number): void {
    this.updateDrawbars(values, t);
    this.updateLevel(values, t);
    this.updateScanner(values, t);
  }

  dispose(): void {
    this.#lfo.stop();
    for (const n of this.#nodes) n.disconnect();
  }
}
