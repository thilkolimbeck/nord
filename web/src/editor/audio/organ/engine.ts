/**
 * The browser organ (plan section 13.2): additive approximations of the Stage 4 organ models B3,
 * Vox, Farf, Pipe 1, Pipe 2 and B3 Bass on two layers, with drawbars, percussion, vibrato/chorus
 * and an approximated rotary speaker. It is not the Stage 4 organ engine; every timbre is invented
 * from the manual's descriptions (M p.18–22, 53).
 *
 *   router ─► handle(RoutedNoteOn) ─► one OrganVoice per hit layer ─► that layer's taps
 *   layer A, layer B (layer.ts) ─► organ bus ─┬─► direct ─────────────► out
 *                                             └─► send ─► rotary.ts ─► out
 *   shared: tonewheel generator (lazy), looped noise (lazy), bend ConstantSourceNode (pitch stick)
 *
 * The router decides which layers play a key (scene, section and layer switches, zones, split
 * crossfade); the engine plays the layer's own sound, octave shift, sustain switch and level, and
 * the organ-wide pitch stick. Voices: full polyphony (M p.19), with a guard of 128 note-layers
 * (oldest releasing first, then oldest sustained, then oldest held).
 */
import type { ValueReader } from '../../model/labels.ts';
import type { Change } from '../../model/store.ts';
import type {
  OrganLayer, RoutedNoteOn, SectionContext, SectionEngine, SectionEvent, SectionFactory,
} from '../section.ts';
import { type OrganEffect, organBindingOf, organLayerOf } from './bindings.ts';
import { OrganLayerNodes } from './layer.ts';
import {
  drawbars, MAX_ORGAN_VOICES, modelOf, octaveSemitones, organBendCents, ORGAN_LAYERS, type OrganModel,
  percussionFires, percussionSpec, rotaryOn, sustainSwitch, vibratoOn,
} from './params.ts';
import { Rotary } from './rotary.ts';
import { NoiseSource, TonewheelGenerator } from './tonewheels.ts';
import { OrganVoice, type OrganVoiceState, type SharedSources } from './voice.ts';
import { pipeSpectrum } from './waves.ts';

const SMOOTH = 0.01;

export interface OrganVoiceInfo {
  readonly id: number;
  readonly layer: OrganLayer;
  readonly note: number;
  readonly pitch: number;
  readonly model: OrganModel;
  readonly state: OrganVoiceState;
  readonly percussion: boolean;
}

export class OrganEngine implements SectionEngine<'organ'> {
  readonly section = 'organ';
  readonly #ctx: BaseAudioContext;
  readonly #values: ValueReader;
  readonly #bus: GainNode;
  readonly #direct: GainNode;
  readonly #send: GainNode;
  readonly #rotary: Rotary;
  readonly #bendSource: ConstantSourceNode;
  readonly #layers: Readonly<Record<OrganLayer, OrganLayerNodes>>;
  readonly #voices = new Map<number, OrganVoice>();
  readonly #shared: SharedSources;
  readonly #handlers: Readonly<Record<OrganEffect, (layer: OrganLayer | null, t: number) => void>>;
  readonly #pipeWaves = new Map<'pipe1' | 'pipe2', PeriodicWave>();
  #tonewheels: TonewheelGenerator | null = null;
  #noise: NoiseSource | null = null;
  #nextId = 1;
  #pedal = false;
  #bend = 0;
  #disposed = false;

  constructor(c: SectionContext) {
    const ctx = c.ctx;
    this.#ctx = ctx;
    this.#values = c.values;
    this.#bus = ctx.createGain();
    this.#direct = ctx.createGain();
    this.#send = ctx.createGain();
    this.#rotary = new Rotary(ctx, c.out, c.values);
    this.#bus.connect(this.#direct).connect(c.out);
    this.#bus.connect(this.#send).connect(this.#rotary.input);
    this.#bendSource = ctx.createConstantSource();
    this.#bendSource.offset.value = 0;
    this.#bendSource.start(ctx.currentTime);
    this.#layers = { A: new OrganLayerNodes(ctx, 'A', this.#bus), B: new OrganLayerNodes(ctx, 'B', this.#bus) };

    this.#shared = {
      ctx,
      bend: this.#bendSource,
      wheel: (n) => {
        this.#tonewheels ??= new TonewheelGenerator(ctx, this.#bendSource);
        return this.#tonewheels.wheel(n);
      },
      noise: () => {
        this.#noise ??= new NoiseSource(ctx);
        return this.#noise.node;
      },
      pipeWave: (model) => {
        let wave = this.#pipeWaves.get(model);
        if (wave === undefined) {
          const s = pipeSpectrum(model);
          wave = ctx.createPeriodicWave(s.real, s.imag);
          this.#pipeWaves.set(model, wave);
        }
        return wave;
      },
    };

    const none = (): void => undefined;
    const layerFn = (fn: (l: OrganLayerNodes, t: number) => void) => (layer: OrganLayer | null, t: number): void => {
      for (const l of layer === null ? ORGAN_LAYERS : [layer]) fn(this.#layers[l], t);
    };
    this.#handlers = {
      router: none, focus: none, voicing: none,
      level: layerFn((l, t) => l.updateLevel(this.#values, t)),
      bend: (_layer, t) => this.#updateBend(t),
      model: layerFn((l, t) => {
        l.updateScanner(this.#values, t);
        l.updateDrawbars(this.#values, t);
      }),
      drawbars: layerFn((l, t) => {
        l.updateDrawbars(this.#values, t);
        const positions = drawbars(this.#values, l.layer);
        for (const v of this.#voices.values()) if (v.layer === l.layer) v.rebuildWave(positions, t);
      }),
      vibrato: layerFn((l, t) => l.updateScanner(this.#values, t)),
      vibratoType: layerFn((l, t) => l.updateScanner(this.#values, t)),
      percussion: layerFn((l, t) => l.updateDrawbars(this.#values, t)),
      rotary: (_layer, t) => this.#updateRotarySwitch(t),
      rotarySpeed: (_layer, t) => this.#rotary.updateSpeed(this.#values, t),
      rotaryDrive: () => this.#rotary.updateDrive(this.#values),
      rotaryMic: (_layer, t) => this.#rotary.updateMic(this.#values, t),
    };
    this.#refresh(true);
  }

  /** Note-layers held, sustained or still releasing. */
  get activeCount(): number {
    return this.#voices.size;
  }

  /** The rotor speeds the rotary is heading for, in Hz. */
  get rotorTargets(): { readonly horn: number; readonly drum: number } {
    return this.#rotary.targets;
  }

  /** Whether the tonewheel generator has been created (at the first B3 or B3 Bass note). */
  get tonewheelsRunning(): boolean {
    return this.#tonewheels !== null;
  }

  /** The sounding voices, oldest first, for inspection. */
  voices(): OrganVoiceInfo[] {
    return [...this.#voices.values()].map((v) => ({
      id: v.id, layer: v.layer, note: v.note, pitch: v.pitch, model: v.model, state: v.state, percussion: v.percussion,
    }));
  }

  handle(e: SectionEvent<OrganLayer>): void {
    if (this.#disposed) return;
    const t = this.#ctx.currentTime;
    switch (e.type) {
      case 'noteOn':
        this.#noteOn(e, t);
        return;
      case 'noteOff':
        for (const v of this.#voices.values()) {
          if (v.note !== e.note || v.state !== 'held') continue;
          if (this.#pedal && v.sustainable) v.state = 'sustained';
          else v.release(t);
        }
        return;
      case 'sustain':
        this.#pedal = e.on;
        if (!e.on) for (const v of this.#voices.values()) if (v.state === 'sustained') v.release(t);
        return;
      case 'bend':
        this.#bend = e.value;
        this.#updateBend(t);
        return;
      case 'controller':
        // The swell pedal and morphs are not modelled (plan section 13.2).
        return;
    }
  }

  applyChanges(batch: readonly Change[]): void {
    if (this.#disposed) return;
    if (batch.some((c) => c.origin === 'load' || c.origin === 'init')) {
      this.reload();
      return;
    }
    const t = this.#ctx.currentTime;
    const done = new Set<string>();
    for (const c of batch) {
      const binding = organBindingOf(c.key);
      if (binding === null) continue;
      const layer = organLayerOf(c.key);
      const id = `${binding.effect}:${layer ?? '-'}`;
      if (done.has(id)) continue;
      done.add(id);
      this.#handlers[binding.effect](layer, t);
    }
  }

  /** Kills every voice and forgets the pedal, as the synth (voice-alloc.ts allNotesOff) and the piano do. */
  panic(): void {
    const t = this.#ctx.currentTime;
    for (const v of this.#voices.values()) v.kill(t);
    this.#voices.clear();
    this.#pedal = false;
  }

  reload(): void {
    this.panic();
    this.#refresh(true);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.panic();
    this.#disposed = true;
    this.#tonewheels?.dispose();
    this.#noise?.dispose();
    this.#rotary.dispose();
    for (const l of ORGAN_LAYERS) this.#layers[l].dispose();
    this.#bendSource.stop();
    for (const n of [this.#bus, this.#direct, this.#send, this.#bendSource]) n.disconnect();
  }

  #noteOn(e: RoutedNoteOn<OrganLayer>, t: number): void {
    for (const hit of e.layers) {
      const layer = hit.layer;
      const values = this.#values;
      // The same note struck again on a layer (after a transpose edit, or while sustained): the old voice ends.
      for (const v of this.#voices.values()) if (v.layer === layer && v.note === e.note && v.state !== 'releasing') v.release(t);
      const held = this.voices().filter((v) => v.layer === layer && v.state === 'held').length;
      const perc = percussionSpec(values, layer);
      const model = modelOf(values, layer);
      if (this.#voices.size >= MAX_ORGAN_VOICES) this.#steal(t);
      const voice = new OrganVoice({
        id: this.#nextId++, layer, note: e.note, pitch: e.note + octaveSemitones(values, layer), model,
        gain: hit.gain, sustainable: sustainSwitch(values, layer),
        percussion: percussionFires(perc, held) ? perc : null,
        pipeDetune: (model === 'pipe1' || model === 'pipe2') && vibratoOn(values, layer),
        drawbars: drawbars(values, layer), time: t,
      }, this.#layers[layer].taps, this.#shared);
      voice.onEnded = (v) => {
        if (this.#voices.get(v.id) === v) this.#voices.delete(v.id);
      };
      this.#voices.set(voice.id, voice);
    }
  }

  /** Free one voice for a new one: the oldest releasing, else the oldest sustained, else the oldest held. */
  #steal(t: number): void {
    for (const state of ['releasing', 'sustained', 'held'] as const) {
      for (const v of this.#voices.values()) {
        if (v.state !== state) continue;
        v.kill(t);
        this.#voices.delete(v.id);
        return;
      }
    }
  }

  #updateBend(t: number): void {
    this.#bendSource.offset.setTargetAtTime(organBendCents(this.#values, this.#bend), t, 0.005);
  }

  #updateRotarySwitch(t: number, immediate = false): void {
    const on = rotaryOn(this.#values);
    for (const [g, v] of [[this.#send, on ? 1 : 0], [this.#direct, on ? 0 : 1]] as const) {
      if (immediate) {
        g.gain.cancelScheduledValues(t);
        g.gain.setValueAtTime(v, t);
      } else g.gain.setTargetAtTime(v, t, SMOOTH);
    }
  }

  #refresh(immediate: boolean): void {
    const t = this.#ctx.currentTime;
    for (const l of ORGAN_LAYERS) this.#layers[l].refresh(this.#values, t);
    this.#updateRotarySwitch(t, immediate);
    this.#rotary.refresh(this.#values, immediate);
    this.#updateBend(t);
  }
}

export const organFactory: SectionFactory<'organ'> = (c) => new OrganEngine(c);
