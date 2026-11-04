/**
 * One piano voice: one note on one layer, built from a recipe (recipes.ts) on native nodes.
 *
 *   per unison copy:  oscillators (sine or wave) ─► envelope GainNodes ─► copy GainNode (1/norm) ─► [pan] ─┐
 *                     FM modulator ─► index GainNode ─► carrier frequency                                │
 *   voice bus ◄────────────────────────────────────────────────────────────────────────────────────────────┘
 *   voice bus ─► [clav sweep] ─► static filters ─► [tanh shaper] ─► out GainNode (level × xfade) ─► layer input
 *   noise bursts (hammer, thump, thunk) ─► band filter ─► burst GainNode ─► out GainNode
 *   out GainNode ─► resonance send (eligible voices only)
 *
 * The voice decays by itself and frees itself below −80 dB of full scale: every oscillator stops
 * at the computed end time and the first one's onended tells the engine. A release recomputes the
 * end; a fade (re-strike 30 ms, panic or steal 10 ms) ramps the out gain to 0 and stops at once.
 * Levels are computed here, never read back from AudioParams (cancelAndHoldAtTime is missing in
 * some browsers).
 */
import type { PianoLayer } from '../../model/scene.ts';
import { SILENCE } from '../envelope.ts';
import {
  type Env, envEnd, envLevel, type FilterSpec, type NoiseSpec, releaseEnd, STAGE1_SECONDS, STAGE1_TARGET, STAGE1_TAU,
  tauOf, type VoiceRecipe, type WaveSpec,
} from './recipes.ts';

export interface VoiceCopy {
  /** Cents added to every oscillator of the copy. */
  readonly detune: number;
  /** StereoPanner position; null: no panner (the plain copy). */
  readonly pan: number | null;
  readonly gain: number;
}

export interface VoiceShared {
  readonly ctx: BaseAudioContext;
  /** PeriodicWave for a recipe wave (cached by the engine). */
  wave(spec: WaveSpec): PeriodicWave;
  /** The shared noise buffer (created by the engine on first use). */
  noise(): AudioBuffer;
  /** A tanh curve for a shaper pre-gain (cached by the engine). */
  curve(preGain: number): Float32Array<ArrayBuffer>;
}

export interface VoiceInit {
  readonly id: number;
  readonly layer: PianoLayer;
  /** The sounding note the router named (key + transpose); noteOff matches it. */
  readonly note: number;
  /** MIDI note after the layer's octave shift (the recipe's note). */
  readonly pitch: number;
  readonly time: number;
  readonly recipe: VoiceRecipe;
  readonly copies: readonly VoiceCopy[];
  /** level × LEVEL_SCALE × the router's crossfade gain. */
  readonly outScale: number;
  /** Whether the sustain pedal holds this voice (the layer's switch at note-on). */
  readonly sustain: boolean;
  readonly bend: AudioNode;
  readonly dest: AudioNode;
  readonly resonance: AudioNode | null;
}

export type VoiceState = 'held' | 'sustained' | 'releasing';

interface Part {
  readonly osc: OscillatorNode;
  readonly gain: GainNode;
  readonly env: Env;
  /** env level (relative) at which this part reaches −80 dB of full scale. */
  readonly floor: number;
}

function scheduleEnv(param: AudioParam, env: Env, t0: number): void {
  param.setValueAtTime(0, t0);
  const peakAt = t0 + Math.max(0, env.attack);
  if (env.attack > 0) param.linearRampToValueAtTime(env.amp, peakAt);
  else param.setValueAtTime(env.amp, peakAt);
  if (env.twoStage) {
    param.setTargetAtTime(env.amp * STAGE1_TARGET, peakAt, STAGE1_TAU);
    param.setTargetAtTime(0, peakAt + STAGE1_SECONDS, env.tau);
  } else {
    param.setTargetAtTime(0, peakAt, env.tau);
  }
}

export class PianoVoice {
  readonly id: number;
  readonly layer: PianoLayer;
  readonly note: number;
  readonly pitch: number;
  readonly family: VoiceRecipe['family'];
  readonly sustain: boolean;
  readonly start: number;
  readonly releaseTime: number;
  readonly hasReleaseNoise: boolean;
  state: VoiceState = 'held';
  /** Called once, when the voice has fallen silent or finished fading. */
  onEnded: ((v: PianoVoice) => void) | null = null;

  readonly #shared: VoiceShared;
  readonly #recipe: VoiceRecipe;
  readonly #bend: AudioNode;
  readonly #parts: Part[] = [];
  readonly #nodes: AudioNode[] = [];
  readonly #oscs: OscillatorNode[] = [];
  readonly #noises = new Set<AudioBufferSourceNode>();
  readonly #out: GainNode;
  readonly #outScale: number;
  #endAt: number;
  #released = false;
  #faded = false;
  #ended = false;

  constructor(shared: VoiceShared, o: VoiceInit) {
    const ctx = shared.ctx;
    const r = o.recipe;
    const t = o.time;
    this.#shared = shared;
    this.#recipe = r;
    this.#bend = o.bend;
    this.id = o.id;
    this.layer = o.layer;
    this.note = o.note;
    this.pitch = o.pitch;
    this.family = r.family;
    this.sustain = o.sustain;
    this.start = t;
    this.releaseTime = r.releaseTime;
    this.hasReleaseNoise = r.releaseNoise !== null;
    this.#outScale = o.outScale;

    this.#out = ctx.createGain();
    this.#out.gain.value = o.outScale;
    this.#out.connect(o.dest);
    if (o.resonance !== null) this.#out.connect(o.resonance);
    this.#nodes.push(this.#out);

    // Post chain, built backwards from the out gain.
    let post: AudioNode = this.#out;
    if (r.shaper !== null) {
      const ws = ctx.createWaveShaper();
      ws.curve = shared.curve(r.shaper);
      ws.connect(post);
      this.#nodes.push(ws);
      post = ws;
    }
    for (const spec of [...r.filters].reverse()) post = this.#filter(spec, post);
    if (r.sweep !== null) {
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.Q.value = r.sweep.Q;
      f.frequency.setValueAtTime(r.sweep.from, t);
      f.frequency.setTargetAtTime(r.sweep.to, t, r.sweep.tau);
      f.connect(post);
      this.#nodes.push(f);
      post = f;
    }
    const bus = ctx.createGain();
    bus.connect(post);
    this.#nodes.push(bus);

    const wave = r.wave === null ? null : shared.wave(r.wave);
    const norm = r.norm > 0 ? r.norm : 1;
    for (const copy of o.copies) {
      const copyGain = ctx.createGain();
      copyGain.gain.value = copy.gain / norm;
      this.#nodes.push(copyGain);
      if (copy.pan === null) copyGain.connect(bus);
      else {
        const pan = ctx.createStereoPanner();
        pan.pan.value = copy.pan;
        copyGain.connect(pan).connect(bus);
        this.#nodes.push(pan);
      }
      // Absolute level of a part = env × copy.gain / norm × outScale; silent below SILENCE.
      const scale = (copy.gain / norm) * o.outScale;
      const floor = scale > 0 ? SILENCE / scale : Infinity;
      let carrier: OscillatorNode | null = null;
      for (const c of r.components) {
        const osc = this.#osc(r.f0 * c.ratio, c.detune + copy.detune, wave);
        const g = ctx.createGain();
        g.gain.value = 0;
        osc.connect(g).connect(copyGain);
        scheduleEnv(g.gain, c.env, t);
        this.#parts.push({ osc, gain: g, env: c.env, floor });
        this.#nodes.push(g);
        carrier ??= osc;
      }
      if (r.fm !== null && carrier !== null) {
        const mod = this.#osc(r.f0, copy.detune, null);
        const index = ctx.createGain();
        index.gain.setValueAtTime(r.fm.index0 * r.f0, t);
        index.gain.setTargetAtTime(r.fm.indexEnd * r.f0, t, r.fm.tau);
        mod.connect(index).connect(carrier.frequency);
        this.#nodes.push(index);
      }
    }
    if (r.attackNoise !== null && this.#parts.length > 0) this.#burst(r.attackNoise, t);

    for (const osc of this.#oscs) osc.start(t);
    this.#endAt = t + Math.max(0, ...this.#parts.map((p) => envEnd(p.env, p.floor)));
    const clock = this.#oscs[0];
    if (clock === undefined) {
      this.#endAt = t;
    } else {
      clock.onended = () => this.#finish();
      for (const osc of this.#oscs) osc.stop(this.#endAt);
    }
  }

  /** Context time when the voice falls silent (or finishes its fade). */
  get endAt(): number {
    return this.#endAt;
  }

  get ended(): boolean {
    return this.#ended;
  }

  /** Whether the voice has no oscillator (a note above the recipe's range): the engine drops it. */
  get silent(): boolean {
    return this.#oscs.length === 0;
  }

  /** Oscillator count, for the source budget tests. */
  get sourceCount(): number {
    return this.#oscs.length + this.#noises.size;
  }

  /**
   * The damper falls at `t`: every part decays with the shorter of its own decay and the release
   * (time to −40 dB `seconds`); Infinity leaves the voice decaying naturally. Plays the release noise.
   */
  release(t: number, seconds: number): void {
    this.state = 'releasing';
    if (this.#released || this.#faded || this.#ended || !Number.isFinite(seconds)) return;
    this.#released = true;
    const relTau = tauOf(Math.max(seconds, 1e-3));
    let end = t;
    for (const p of this.#parts) {
      const level = envLevel(p.env, t - this.start);
      const tau = Math.min(p.env.tau, relTau);
      p.gain.gain.cancelScheduledValues(t);
      p.gain.gain.setValueAtTime(level, t);
      p.gain.gain.setTargetAtTime(0, t, tau);
      end = Math.max(end, t + releaseEnd(level, tau, p.floor));
    }
    if (this.#recipe.releaseNoise !== null) this.#burst(this.#recipe.releaseNoise, t);
    this.#endAt = Math.min(this.#endAt, end);
    for (const osc of this.#oscs) osc.stop(this.#endAt);
  }

  /** Ramp the voice out over `seconds` and stop (re-strike, steal, panic). */
  fade(t: number, seconds: number): void {
    if (this.#faded || this.#ended) return;
    this.#faded = true;
    const g = this.#out.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(this.#outScale, t);
    g.linearRampToValueAtTime(0, t + seconds);
    const stopAt = t + seconds + 0.005;
    this.#endAt = Math.min(this.#endAt, stopAt);
    for (const osc of this.#oscs) osc.stop(this.#endAt);
    for (const n of this.#noises) n.stop(stopAt);
    if (this.#oscs.length === 0) this.#finish();
  }

  #osc(freq: number, detune: number, wave: PeriodicWave | null): OscillatorNode {
    const osc = this.#shared.ctx.createOscillator();
    if (wave === null) osc.type = 'sine';
    else osc.setPeriodicWave(wave);
    osc.frequency.value = freq;
    osc.detune.value = detune;
    this.#bend.connect(osc.detune);
    this.#oscs.push(osc);
    this.#nodes.push(osc);
    return osc;
  }

  #filter(spec: FilterSpec, dest: AudioNode): BiquadFilterNode {
    const f = this.#shared.ctx.createBiquadFilter();
    f.type = spec.type;
    f.frequency.value = spec.freq;
    f.gain.value = spec.gain;
    f.Q.value = spec.Q;
    f.connect(dest);
    this.#nodes.push(f);
    return f;
  }

  #burst(spec: NoiseSpec, t: number): void {
    if (spec.level <= 0) return;
    const ctx = this.#shared.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.#shared.noise();
    const f = ctx.createBiquadFilter();
    f.type = spec.filter;
    f.frequency.value = spec.freq;
    f.Q.value = spec.Q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(spec.level, t);
    g.gain.linearRampToValueAtTime(0, t + spec.duration);
    src.connect(f).connect(g).connect(this.#out);
    src.onended = () => {
      this.#noises.delete(src);
      for (const n of [src, f, g]) n.disconnect();
    };
    this.#noises.add(src);
    src.start(t);
    src.stop(t + spec.duration + 0.005);
  }

  #finish(): void {
    if (this.#ended) return;
    this.#ended = true;
    for (const n of this.#noises) n.stop();
    for (const osc of this.#oscs) this.#bend.disconnect(osc.detune);
    for (const n of this.#nodes) n.disconnect();
    this.onEnded?.(this);
  }
}
