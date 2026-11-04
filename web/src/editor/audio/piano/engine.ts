/**
 * The browser piano (plan section 13.3): layers A and B as the router hands them notes, one
 * synthesized recipe per piano family (recipes.ts), 120 voices over both layers, the sustain pedal
 * with string resonance and pedal noise, and live level, timbre and pitch stick changes through
 * bindings.ts. It approximates the Stage 4 piano types (manual p.24–26) without any Nord sample;
 * it is not the Stage 4 engine.
 *
 *   per layer:  voices ─► input ─► timbre filters ─► level ─► effects chain (piano{L}Fx; fx/types.ts) ─► SectionContext.out
 *               voices ─► resonance send ─► comb bank ─► input   (layer.ts)
 *   shared:     one white-noise AudioBuffer for every noise burst; PeriodicWaves and shaper curves cached
 *
 * Voices: one note on one layer (unison copies count as one). At note-on the same note on the
 * same layer fades in 30 ms; with 120 voices sounding the oldest releasing voice is stolen, then
 * the oldest sustained, then the oldest held (the synth allocator's order). Above 48 sounding
 * voices new voices of the additive families keep half their partials.
 */
import type { Change } from '../../model/store.ts';
import type { ValueReader } from '../../model/labels.ts';
import { enabledLayers } from '../../model/scene.ts';
import { noise, tanhCurve } from '../waveforms.ts';
import { type FxChain, fxChainFor, inertChain } from '../fx/types.ts';
import type { PianoLayer, RoutedNoteOn, SectionContext, SectionEngine, SectionEvent, SectionFactory } from '../section.ts';
import { bindingOf, type Effect, pianoLayerOf } from './bindings.ts';
import { PianoLayerNodes } from './layer.ts';
import {
  dynLevel, LEVEL_SCALE, layerSettings, type LayerSettings, PIANO_LAYERS, touchX, UNISON_COPY_GAIN, unisonSpec,
} from './mapping.ts';
import { FIXED_TOUCH, hasPedalNoise, type NoiseSpec, recipe, releaseSeconds, resonates, type WaveSpec } from './recipes.ts';
import { PianoVoice, type VoiceCopy, type VoiceShared, type VoiceState } from './voice.ts';

/** Stage 4 piano polyphony (specifications page: "120 Voice Polyphony"), over both layers. */
export const MAX_PIANO_VOICES = 120;
/** Above this many sounding voices, new voices of the additive families keep half their partials. */
export const HALF_PARTIALS_ABOVE = 48;
/** The same note struck again on the same layer: the old voice fades over this. */
export const RESTRIKE_FADE = 0.03;
/** Panic and steal fade. */
export const KILL_FADE = 0.01;
/** Seconds of noise in the shared buffer. */
const NOISE_SECONDS = 1;

/** Pedal noise (p.25): a thump at pedal-down, a swish at pedal-up, −30 dB. */
const PEDAL_DOWN_NOISE: NoiseSpec = { filter: 'lowpass', freq: 600, Q: 0.7, duration: 0.06, level: 10 ** (-30 / 20) };
const PEDAL_UP_NOISE: NoiseSpec = { filter: 'bandpass', freq: 2000, Q: 1, duration: 0.04, level: 10 ** (-30 / 20) };

const STEAL_ORDER: readonly VoiceState[] = ['releasing', 'sustained', 'held'];

export interface PianoVoiceInfo {
  readonly id: number;
  readonly layer: PianoLayer;
  readonly note: number;
  readonly pitch: number;
  readonly family: PianoVoice['family'];
  readonly state: VoiceState;
  readonly sources: number;
}

export class PianoEngine implements SectionEngine<'piano'> {
  readonly section = 'piano';
  readonly #ctx: BaseAudioContext;
  readonly #values: ValueReader;
  readonly #layers: Readonly<Record<PianoLayer, PianoLayerNodes>>;
  /** Each layer's effects chain, between its level and the section output. */
  readonly #chains: Readonly<Record<PianoLayer, FxChain>>;
  /** Insertion order is allocation order: the first entry is the oldest voice. */
  readonly #voices = new Map<number, PianoVoice>();
  readonly #waves = new Map<string, PeriodicWave>();
  readonly #curves = new Map<number, Float32Array<ArrayBuffer>>();
  readonly #pedalNoises = new Set<AudioBufferSourceNode>();
  readonly #shared: VoiceShared;
  readonly #handlers: Readonly<Record<Effect, (layer: PianoLayer | null, t: number) => void>>;
  #noise: AudioBuffer | null = null;
  #nextId = 1;
  #pedal = false;
  #bend = 0;
  #disposed = false;

  constructor(c: SectionContext) {
    this.#ctx = c.ctx;
    this.#values = c.values;
    // With effects hooks each layer's level feeds its chain; without them it feeds the output as before.
    const layerOut = (layer: PianoLayer): { node: AudioNode; chain: FxChain } => {
      if (c.fx === undefined) return { node: c.out, chain: inertChain(`piano${layer}Fx`, c.out) };
      const node = c.ctx.createGain();
      return { node, chain: fxChainFor(c, `piano${layer}Fx`, node, c.out) };
    };
    const a = layerOut('A');
    const b = layerOut('B');
    this.#chains = { A: a.chain, B: b.chain };
    this.#layers = { A: new PianoLayerNodes(c.ctx, 'A', a.node), B: new PianoLayerNodes(c.ctx, 'B', b.node) };
    this.#shared = {
      ctx: c.ctx,
      wave: (spec) => this.#wave(spec),
      noise: () => this.#noiseBuffer(),
      curve: (g) => this.#curve(g),
    };
    const none = (): void => undefined;
    const layerFn = (fn: (l: PianoLayerNodes, t: number) => void) => (layer: PianoLayer | null, t: number): void => {
      for (const l of layer === null ? PIANO_LAYERS : [layer]) fn(this.#layers[l], t);
    };
    const send = layerFn((l, t) => l.updateSend(this.#values, this.#pedal, t));
    this.#handlers = {
      // Read by the router, at the next note, at key-up or at the next pedal event.
      router: none, focus: none, nextNote: none, pedalNoise: none,
      level: layerFn((l, t) => l.updateLevel(this.#values, t)),
      timbre: layerFn((l, t) => l.updateTimbre(this.#values, t)),
      type: layerFn((l, t) => l.updateTimbre(this.#values, t)),
      bend: layerFn((l, t) => l.updateBend(this.#values, this.#bend, t)),
      resonance: send,
      sustain: send,
    };
    this.#refreshLayers();
  }

  get context(): BaseAudioContext {
    return this.#ctx;
  }

  /** Voices held, sustained or still sounding after key-up. */
  get activeCount(): number {
    return this.#voices.size;
  }

  /** Whether the sustain pedal is down (as last reported). */
  get pedal(): boolean {
    return this.#pedal;
  }

  /** One layer's shared nodes, for inspection (tests, the dev handle). */
  layerNodes(layer: PianoLayer): PianoLayerNodes {
    return this.#layers[layer];
  }

  /** The voices that sound right now, oldest first. */
  voices(): PianoVoiceInfo[] {
    return [...this.#voices.values()].map((v) => ({
      id: v.id, layer: v.layer, note: v.note, pitch: v.pitch, family: v.family, state: v.state, sources: v.sourceCount,
    }));
  }

  handle(e: SectionEvent<PianoLayer>): void {
    if (this.#disposed) return;
    const t = this.#ctx.currentTime;
    switch (e.type) {
      case 'noteOn':
        this.#noteOn(e, t);
        return;
      case 'noteOff':
        for (const v of [...this.#voices.values()]) {
          if (v.note !== e.note || v.state !== 'held') continue;
          if (this.#pedal && v.sustain) v.state = 'sustained';
          else this.#damp(v, t);
        }
        return;
      case 'sustain':
        this.#sustain(e.on, t);
        return;
      case 'bend':
        this.#bend = e.value;
        for (const l of PIANO_LAYERS) this.#layers[l].updateBend(this.#values, this.#bend, t);
        return;
      case 'controller':
        // The piano itself uses no wheel, pressure or control pedal; its effects may (Mod 1 PED, p.49).
        for (const l of PIANO_LAYERS) this.#chains[l].controller(e.kind, e.value);
        return;
    }
  }

  applyChanges(batch: readonly Change[]): void {
    if (this.#disposed) return;
    for (const l of PIANO_LAYERS) this.#chains[l].applyChanges(batch);
    if (batch.some((c) => c.origin === 'load' || c.origin === 'init')) {
      this.reload();
      return;
    }
    const t = this.#ctx.currentTime;
    const done = new Set<string>();
    for (const c of batch) {
      const binding = bindingOf(c.key);
      if (binding === null) continue;
      const layer = pianoLayerOf(c.key);
      const id = `${binding.effect}:${layer ?? '-'}`;
      if (done.has(id)) continue;
      done.add(id);
      this.#handlers[binding.effect](layer, t);
    }
  }

  /** All notes off: every voice is freed (count 0) and fades over 10 ms; the pedal counts as up. */
  panic(): void {
    const t = this.#ctx.currentTime;
    for (const v of this.#voices.values()) v.fade(t, KILL_FADE);
    this.#voices.clear();
    for (const n of this.#pedalNoises) n.stop(t);
    this.#pedal = false;
    for (const l of PIANO_LAYERS) {
      this.#layers[l].updateSend(this.#values, false, t);
      this.#chains[l].silence();
    }
  }

  reload(): void {
    this.panic();
    this.#refreshLayers();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.panic();
    this.#disposed = true;
    for (const l of PIANO_LAYERS) {
      this.#layers[l].dispose();
      this.#chains[l].dispose();
    }
  }

  #refreshLayers(): void {
    const t = this.#ctx.currentTime;
    for (const l of PIANO_LAYERS) {
      const nodes = this.#layers[l];
      nodes.updateLevel(this.#values, t);
      nodes.updateTimbre(this.#values, t);
      nodes.updateBend(this.#values, this.#bend, t);
      nodes.updateSend(this.#values, this.#pedal, t);
    }
  }

  #noteOn(e: RoutedNoteOn<PianoLayer>, t: number): void {
    for (const hit of e.layers) {
      const s = layerSettings(this.#values, hit.layer);
      // Re-strike: the same note on the same layer fades out, a new voice starts.
      for (const v of [...this.#voices.values()]) {
        if (v.layer === hit.layer && v.note === e.note) this.#drop(v, t, RESTRIKE_FADE);
      }
      const v = this.#build(e.note, e.velocity, hit.layer, hit.gain, s, t);
      if (v === null) continue;
      while (this.#voices.size >= MAX_PIANO_VOICES) this.#steal(t);
      v.onEnded = (ended) => {
        if (this.#voices.get(ended.id) === ended) this.#voices.delete(ended.id);
      };
      this.#voices.set(v.id, v);
    }
  }

  #build(note: number, velocity: number, layer: PianoLayer, gain: number, s: LayerSettings, t: number): PianoVoice | null {
    const pitch = note + s.shift;
    if (pitch < 0 || pitch > 127) return null; // like a transpose beyond the keyboard: not played
    const fixed = FIXED_TOUCH[s.family];
    const x = fixed ?? touchX(velocity, s.touch);
    const r = recipe({
      family: s.family, name: s.model?.name ?? null, note: pitch, x, variation: s.variation,
      sampleRate: this.#ctx.sampleRate, halfPartials: this.#voices.size >= HALF_PARTIALS_ABOVE,
    });
    if (r.components.length === 0) return null;
    const u = unisonSpec(s.unison);
    const copies: VoiceCopy[] = u.copies === 1
      ? [{ detune: 0, pan: null, gain: 1 }]
      : [-1, 1].map((sign) => ({ detune: sign * u.cents, pan: sign * u.pan, gain: UNISON_COPY_GAIN }));
    const nodes = this.#layers[layer];
    const res = s.stringRes && resonates(s.family, s.model?.size ?? null, pitch) ? nodes.resonanceSend() : null;
    return new PianoVoice(this.#shared, {
      id: this.#nextId++, layer, note, pitch, time: t, recipe: r, copies,
      outScale: dynLevel(x, s.dynComp) * LEVEL_SCALE * gain,
      sustain: s.sustain, bend: nodes.bend, dest: nodes.input, resonance: res,
    });
  }

  /** The damper falls on a voice: its layer's Soft Release is read now (plan: "read at key-up"). */
  #damp(v: PianoVoice, t: number): void {
    const s = layerSettings(this.#values, v.layer);
    v.release(t, releaseSeconds(v.family, v.releaseTime, v.pitch, s.softRelease));
  }

  #drop(v: PianoVoice, t: number, seconds: number): void {
    v.fade(t, seconds);
    this.#voices.delete(v.id);
  }

  #steal(t: number): void {
    for (const state of STEAL_ORDER) {
      for (const v of this.#voices.values()) {
        if (v.state === state) {
          this.#drop(v, t, KILL_FADE);
          return;
        }
      }
    }
  }

  #sustain(on: boolean, t: number): void {
    if (on === this.#pedal) return;
    this.#pedal = on;
    if (!on) {
      for (const v of [...this.#voices.values()]) if (v.state === 'sustained') this.#damp(v, t);
    }
    const playing = new Set<PianoLayer>(enabledLayers(this.#values, 'piano'));
    for (const l of PIANO_LAYERS) {
      const nodes = this.#layers[l];
      nodes.updateSend(this.#values, on, t);
      const s = layerSettings(this.#values, l);
      if (playing.has(l) && s.pedalNoise && s.sustain && hasPedalNoise(s.family)) {
        this.#pedalNoise(on ? PEDAL_DOWN_NOISE : PEDAL_UP_NOISE, nodes.input, t);
      }
    }
  }

  #pedalNoise(spec: NoiseSpec, dest: AudioNode, t: number): void {
    const ctx = this.#ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.#noiseBuffer();
    const f = ctx.createBiquadFilter();
    f.type = spec.filter;
    f.frequency.value = spec.freq;
    f.Q.value = spec.Q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(spec.level, t);
    g.gain.linearRampToValueAtTime(0, t + spec.duration);
    src.connect(f).connect(g).connect(dest);
    src.onended = () => {
      this.#pedalNoises.delete(src);
      for (const n of [src, f, g]) n.disconnect();
    };
    this.#pedalNoises.add(src);
    src.start(t);
    src.stop(t + spec.duration + 0.005);
  }

  #noiseBuffer(): AudioBuffer {
    if (this.#noise === null) {
      const length = Math.round(NOISE_SECONDS * this.#ctx.sampleRate);
      const buf = this.#ctx.createBuffer(1, length, this.#ctx.sampleRate);
      buf.getChannelData(0).set(noise('white', length, 11));
      this.#noise = buf;
    }
    return this.#noise;
  }

  #wave(spec: WaveSpec): PeriodicWave {
    let wave = this.#waves.get(spec.id);
    if (wave === undefined) {
      wave = this.#ctx.createPeriodicWave(spec.real, spec.imag);
      this.#waves.set(spec.id, wave);
    }
    return wave;
  }

  #curve(preGain: number): Float32Array<ArrayBuffer> {
    const key = Math.round(preGain * 20) / 20; // 0.05 steps
    let curve = this.#curves.get(key);
    if (curve === undefined) {
      curve = tanhCurve(key);
      this.#curves.set(key, curve);
    }
    return curve;
  }
}

export const pianoFactory: SectionFactory<'piano'> = (c) => new PianoEngine(c);
