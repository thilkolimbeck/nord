/**
 * One organ voice: one key on one layer, with the model, pitch and switches it started with
 * (plan section 13.2). Organs ignore velocity.
 *
 * Every voice has a gate: a ConstantSourceNode whose offset ramps 0 → the router's crossfade gain
 * over the model's attack and back to 0 over its release. It drives the gain AudioParam of every
 * per-voice GainNode the voice feeds through (tonewheel contacts, the Vox or Farf VCA, the pipe
 * gates), so the crossfade gain is applied once, at note-on, as the router contract asks, and its
 * end (onended) frees the voice.
 *
 * - B3: nine contacts from the shared tonewheels into the layer's drawbar buses; a key click
 *   (band-passed noise burst at key-down and key-up, M p.20); percussion when it fires (M p.20).
 * - B3 Bass: contacts on db1 (16′) and db2 (8′), 5 ms attack, no click, no percussion (M p.21).
 * - Vox, Farf: one OscillatorNode with a PeriodicWave on the 16′ grid (M p.20–21), rebuilt when a
 *   drawbar moves.
 * - Pipe 1, Pipe 2: one OscillatorNode per drawbar above 0 at pure footage ratios into the
 *   layer's pipe buses; Pipe 2 speaks with a chiff; vibrato on detunes each footage (M p.21).
 */
import { TAU_DIVISOR } from '../envelope.ts';
import type { OrganLayer } from '../section.ts';
import type { LayerTaps } from './layer.ts';
import {
  contactsFor, gateTimes, mtof, type OrganModel, PIPE_RATIOS, pipeDetuneCents, type PercussionSpec, wheelIndex,
} from './params.ts';
import { unlink } from './tonewheels.ts';
import { farfSpectrum, type Spectrum, voxSpectrum, waveGain } from './waves.ts';

/** Panic and voice stealing fade a voice over this time. */
export const KILL_FADE = 0.01;
/** Extra time after a gate reaches 0 before its sources stop. */
const TAIL = 0.01;
const SMOOTH = 0.01;
const CLICK_LEVEL = 0.15;
const RELEASE_CLICK_LEVEL = 0.05;
const CHIFF_LEVEL = 0.1; // −20 dB

export type OrganVoiceState = 'held' | 'sustained' | 'releasing';

/** What a voice needs from the engine besides its layer's taps. */
export interface SharedSources {
  readonly ctx: BaseAudioContext;
  /** The organ's pitch stick in cents; voices connect it to every detune they own. */
  readonly bend: AudioNode;
  wheel(n: number): AudioNode;
  noise(): AudioNode;
  /** A PeriodicWave for the pipe timbres, cached per context. */
  pipeWave(model: 'pipe1' | 'pipe2'): PeriodicWave;
}

export interface OrganVoiceSpec {
  readonly id: number;
  readonly layer: OrganLayer;
  /** The sounding note the router named (noteOff matches it). */
  readonly note: number;
  /** The played pitch: note + octave shift. */
  readonly pitch: number;
  readonly model: OrganModel;
  /** The router's crossfade gain, applied once. */
  readonly gain: number;
  /** Whether the sustain pedal holds this voice (the layer's sustain switch at note-on). */
  readonly sustainable: boolean;
  /** Percussion for this note, or null when it does not fire. */
  readonly percussion: PercussionSpec | null;
  /** Pipe vibrato: the detuned model (M p.21). */
  readonly pipeDetune: boolean;
  /** Drawbar positions 0..8 at note-on (Pipe oscillators exist only for drawbars above 0). */
  readonly drawbars: readonly number[];
  readonly time: number;
}

export class OrganVoice {
  readonly id: number;
  readonly layer: OrganLayer;
  readonly note: number;
  readonly pitch: number;
  readonly model: OrganModel;
  readonly sustainable: boolean;
  /** Whether percussion fired for this voice. */
  readonly percussion: boolean;
  state: OrganVoiceState = 'held';
  onEnded: ((v: OrganVoice) => void) | null = null;

  readonly #shared: SharedSources;
  readonly #gate: ConstantSourceNode;
  readonly #start: number;
  readonly #attack: number;
  readonly #release: number;
  readonly #peak: number;
  /** Nodes this voice created, disconnected at the end. */
  readonly #own: AudioNode[] = [];
  /** Edges from shared sources into this voice, removed at the end. */
  readonly #links: Array<readonly [AudioNode, AudioNode | AudioParam]> = [];
  readonly #oscillators: OscillatorNode[] = [];
  #click: GainNode | null = null;
  /** Vox and Farf: the oscillator and its normalising gain. */
  #wave: { readonly osc: OscillatorNode; readonly norm: GainNode } | null = null;
  #stopAt = Infinity;
  #ended = false;
  /** The current fade to 0: from `level` at `from` until `to`; null while the gate is open. */
  #fadeRamp: { readonly from: number; readonly level: number; readonly to: number } | null = null;

  constructor(spec: OrganVoiceSpec, taps: LayerTaps, shared: SharedSources) {
    this.id = spec.id;
    this.layer = spec.layer;
    this.note = spec.note;
    this.pitch = spec.pitch;
    this.model = spec.model;
    this.sustainable = spec.sustainable;
    this.#shared = shared;
    const ctx = shared.ctx;
    const t = spec.time;
    const times = gateTimes(spec.model);
    this.#start = t;
    this.#attack = times.attack;
    this.#release = times.release;
    this.#peak = spec.gain;

    this.#gate = ctx.createConstantSource();
    this.#gate.offset.value = 0;
    this.#gate.offset.setValueAtTime(0, t);
    this.#gate.offset.linearRampToValueAtTime(this.#peak, t + this.#attack);
    this.#gate.onended = () => this.#end();
    this.#own.push(this.#gate);

    let percussion = false;
    switch (spec.model) {
      case 'b3':
      case 'b3bass':
        for (const c of contactsFor(spec.model, spec.pitch)) this.#gated(shared.wheel(c.wheel), taps.drawbarBuses[c.drawbar]!);
        if (spec.model === 'b3') {
          this.#click = this.#noiseBurst(taps.tonewheelIn, 'bandpass', 2100, 1.4);
          this.#burst(this.#click.gain, CLICK_LEVEL * this.#peak, 0.0015, 0.003, t);
          if (spec.percussion !== null) {
            percussion = true;
            this.#percussion(spec.percussion, taps.tonewheelIn, t);
          }
        }
        break;
      case 'vox':
      case 'farf':
        this.#waveVoice(spec, spec.model === 'vox' ? taps.voxIn : taps.directIn, t);
        break;
      case 'pipe1':
      case 'pipe2':
        this.#pipes(spec, taps, t);
        break;
    }
    this.percussion = percussion;
    this.#gate.start(t);
  }

  /** The gate level at time t (attack ramp, then the peak), for releases that start mid-attack. */
  levelAt(t: number): number {
    const f = this.#fadeRamp;
    if (f !== null && t >= f.from) return t >= f.to ? 0 : f.level * (1 - (t - f.from) / (f.to - f.from));
    if (t <= this.#start) return 0;
    if (t >= this.#start + this.#attack) return this.#peak;
    return (this.#peak * (t - this.#start)) / this.#attack;
  }

  /** Key-up (or pedal-up): the gate falls over the model's release time. */
  release(t: number): void {
    if (this.state === 'releasing') return;
    this.state = 'releasing';
    if (this.#click !== null) this.#burst(this.#click.gain, RELEASE_CLICK_LEVEL * this.#peak, 0.001, 0.002, t);
    this.#fade(t, this.#release);
  }

  /** Panic or stealing: fade over KILL_FADE whatever the state. The engine forgets the voice at once. */
  kill(t: number): void {
    this.state = 'releasing';
    this.#fade(t, KILL_FADE);
  }

  /** Vox and Farf: rebuild the wave and its gain from new drawbar positions. */
  rebuildWave(positions: readonly number[], t: number): void {
    if (this.#wave === null || (this.model !== 'vox' && this.model !== 'farf')) return;
    const spectrum = this.#spectrum(this.model, positions);
    this.#wave.osc.setPeriodicWave(this.#periodicWave(spectrum));
    this.#wave.norm.gain.setTargetAtTime(waveGain(this.model, spectrum), t, SMOOTH);
  }

  get ended(): boolean {
    return this.#ended;
  }

  #fade(t: number, time: number): void {
    const level = this.levelAt(t);
    const p = this.#gate.offset;
    p.cancelScheduledValues(t);
    p.setValueAtTime(level, t);
    p.linearRampToValueAtTime(0, t + time);
    this.#fadeRamp = { from: t, level, to: t + time };
    const stop = t + time + TAIL;
    if (stop >= this.#stopAt) return;
    this.#stopAt = stop;
    this.#gate.stop(stop);
    for (const o of this.#oscillators) o.stop(stop);
  }

  /** A per-voice GainNode driven by the gate, from `from` into `to`. */
  #gated(from: AudioNode, to: AudioNode, shared = true): GainNode {
    const g = this.#shared.ctx.createGain();
    g.gain.value = 0;
    this.#gate.connect(g.gain);
    from.connect(g);
    if (shared) this.#links.push([from, g]);
    g.connect(to);
    this.#own.push(g);
    return g;
  }

  /** Shared noise ─► filter ─► burst gain ─► `to`; the burst gain starts silent. */
  #noiseBurst(to: AudioNode, type: BiquadFilterType, hz: number, q: number): GainNode {
    const ctx = this.#shared.ctx;
    const noise = this.#shared.noise();
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = hz;
    filter.Q.value = q;
    const g = ctx.createGain();
    g.gain.value = 0;
    noise.connect(filter);
    this.#links.push([noise, filter]);
    filter.connect(g).connect(to);
    this.#own.push(filter, g);
    return g;
  }

  #burst(p: AudioParam, peak: number, rise: number, end: number, t: number): void {
    p.cancelScheduledValues(t);
    p.setValueAtTime(0, t);
    p.linearRampToValueAtTime(peak, t + rise);
    p.linearRampToValueAtTime(0, t + end);
  }

  /** Percussion (M p.20): the harmonic's wheel through a decaying envelope, inside the gate. */
  #percussion(spec: PercussionSpec, to: AudioNode, t: number): void {
    const ctx = this.#shared.ctx;
    const wheel = this.#shared.wheel(percussionWheel(this.pitch, spec));
    const env = ctx.createGain();
    env.gain.value = 0;
    env.gain.setValueAtTime(spec.peak, t);
    env.gain.setTargetAtTime(0, t, spec.decay / TAU_DIVISOR);
    wheel.connect(env);
    this.#links.push([wheel, env]);
    this.#own.push(env);
    this.#gated(env, to, false);
  }

  #spectrum(model: 'vox' | 'farf', positions: readonly number[]): Spectrum {
    const f16 = mtof(this.pitch - 12);
    const sr = this.#shared.ctx.sampleRate;
    return model === 'vox' ? voxSpectrum(positions, f16, sr) : farfSpectrum(positions, f16, sr);
  }

  #periodicWave(s: Spectrum): PeriodicWave {
    return this.#shared.ctx.createPeriodicWave(s.real, s.imag, { disableNormalization: true });
  }

  #waveVoice(spec: OrganVoiceSpec, to: AudioNode, t: number): void {
    const ctx = this.#shared.ctx;
    const model = spec.model as 'vox' | 'farf';
    const spectrum = this.#spectrum(model, spec.drawbars);
    const osc = ctx.createOscillator();
    osc.frequency.value = mtof(spec.pitch - 12);
    osc.setPeriodicWave(this.#periodicWave(spectrum));
    this.#shared.bend.connect(osc.detune);
    this.#links.push([this.#shared.bend, osc.detune]);
    const norm = ctx.createGain();
    norm.gain.value = waveGain(model, spectrum);
    this.#gated(osc, norm, false);
    norm.connect(to);
    this.#own.push(osc, norm);
    this.#oscillators.push(osc);
    this.#wave = { osc, norm };
    osc.start(t);
  }

  #pipes(spec: OrganVoiceSpec, taps: LayerTaps, t: number): void {
    const ctx = this.#shared.ctx;
    const model = spec.model as 'pipe1' | 'pipe2';
    const f8 = mtof(spec.pitch);
    const wave = this.#shared.pipeWave(model);
    PIPE_RATIOS.forEach((ratio, n) => {
      if ((spec.drawbars[n] ?? 0) <= 0 || f8 * ratio > 0.45 * ctx.sampleRate) return;
      const osc = ctx.createOscillator();
      osc.frequency.value = f8 * ratio;
      osc.setPeriodicWave(wave);
      osc.detune.value = spec.pipeDetune ? pipeDetuneCents(spec.pitch, n) : 0;
      this.#shared.bend.connect(osc.detune);
      this.#links.push([this.#shared.bend, osc.detune]);
      this.#gated(osc, taps.pipeBuses[n]!, false);
      this.#own.push(osc);
      this.#oscillators.push(osc);
      osc.start(t);
    });
    if (model === 'pipe2') {
      const chiff = this.#noiseBurst(taps.directIn, 'bandpass', Math.min(3 * f8, 0.45 * ctx.sampleRate), 2);
      this.#burst(chiff.gain, CHIFF_LEVEL * this.#peak, 0.002, 0.03, t);
    }
  }

  #end(): void {
    if (this.#ended) return;
    this.#ended = true;
    for (const [from, to] of this.#links) unlink(from, to);
    for (const n of this.#own) n.disconnect();
    this.onEnded?.(this);
  }
}

/** The wheel of a key's percussion: the 4′ (2nd harmonic) or the 2⅔′ (3rd) of the key (M p.20). */
export function percussionWheel(pitch: number, spec: PercussionSpec): number {
  return wheelIndex(pitch, spec.offset);
}
