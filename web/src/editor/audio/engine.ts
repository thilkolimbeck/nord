/**
 * The browser synth (plan sections 2, 4 and 13.5): layers A, B and C, voices on native nodes, the
 * shared 46-voice cap of voice-alloc.ts, panic, and live parameter changes through bindings.ts. It
 * approximates the Stage 4 synth; it is not the Stage 4 engine. As a SectionEngine it plays the
 * layers the router hands it (active scene, split zones, transpose already applied), each voice
 * scaled once by its layer's split crossfade gain.
 *
 *   per layer:  LFO ─► depth gains (pitch, filter, osc ctrl) ─► every voice of the layer
 *               vibrato OscillatorNode ─► depth gain ─► every voice (each with its own delay ramp)
 *               bend ConstantSourceNode ─► every voice's pitch
 *               voice ─► xfade GainNode (split gain) ─► layer bus GainNode (level)
 *                     ─► StereoPannerNode (pan) ─► out
 *   out:        the shared MasterBus input (master.ts); without one the engine builds its own
 */
import type { PlayEvent } from '../input/events.ts';
import { LAYERS, layerOf, type SynthLayer } from '../model/keys.ts';
import type { ValueReader } from '../model/labels.ts';
import type { Change } from '../model/store.ts';
import { bindingOf, type Effect } from './bindings.ts';
import {
  bendCents, enabledLayers, layerGain, layerPan, type LfoShape, lfoSpec, silentReason, vibDepthCents, vibSpec, voicing,
} from './mapping.ts';
import { MasterBus } from './master.ts';
import type { LayerHit, SectionEngine, SectionEvent, SectionFactory } from './section.ts';
import { VoiceAllocator, type VoiceCommand } from './voice-alloc.ts';
import { type LayerTaps, Voice, type VoiceUpdate } from './voice.ts';
import { basic, cycle, rng, toCoefficients } from './waveforms.ts';

const SMOOTH = 0.01;
/** Sample-and-hold LFO: 64 random steps of 256 samples each, looped; the playback rate sets the step rate. */
const SH_STEPS = 64;
const SH_STEP_SAMPLES = 256;

export interface Controllers {
  wheel: number;
  pressure: number;
  pedal: number;
}

/** One layer's shared nodes: bus, pan, LFO, vibrato and bend. */
class LayerNodes {
  readonly taps: LayerTaps;
  readonly #ctx: BaseAudioContext;
  readonly #layer: SynthLayer;
  readonly #bus: GainNode;
  readonly #pan: StereoPannerNode;
  readonly #bend: ConstantSourceNode;
  readonly #lfoOut: GainNode;
  readonly #lfoPitch: GainNode;
  readonly #lfoFilter: GainNode;
  readonly #lfoCtrl: GainNode;
  readonly #vibOsc: OscillatorNode;
  readonly #vibDepth: GainNode;
  #lfo: { shape: LfoShape; node: OscillatorNode | AudioBufferSourceNode } | null = null;

  constructor(ctx: BaseAudioContext, layer: SynthLayer, out: AudioNode) {
    this.#ctx = ctx;
    this.#layer = layer;
    this.#bus = ctx.createGain();
    this.#pan = ctx.createStereoPanner();
    this.#bus.connect(this.#pan).connect(out);
    this.#bend = ctx.createConstantSource();
    this.#bend.offset.value = 0;
    this.#lfoOut = ctx.createGain();
    this.#lfoPitch = ctx.createGain();
    this.#lfoFilter = ctx.createGain();
    this.#lfoCtrl = ctx.createGain();
    for (const g of [this.#lfoPitch, this.#lfoFilter, this.#lfoCtrl]) {
      g.gain.value = 0;
      this.#lfoOut.connect(g);
    }
    this.#vibOsc = ctx.createOscillator();
    this.#vibOsc.type = 'sine';
    this.#vibDepth = ctx.createGain();
    this.#vibDepth.gain.value = 0;
    this.#vibOsc.connect(this.#vibDepth);
    this.#bend.start();
    this.#vibOsc.start();
    this.taps = {
      bus: this.#bus, pitchMods: [this.#bend, this.#lfoPitch], vibrato: this.#vibDepth,
      filterMod: this.#lfoFilter, ctrlMod: this.#lfoCtrl,
    };
  }

  updateBus(values: ValueReader, t: number): void {
    this.#bus.gain.setTargetAtTime(layerGain(values, this.#layer), t, SMOOTH);
    this.#pan.pan.setTargetAtTime(layerPan(values, this.#layer), t, SMOOTH);
  }

  updateLfo(values: ValueReader, t: number): void {
    const spec = lfoSpec(values, this.#layer);
    if (this.#lfo === null || this.#lfo.shape !== spec.shape) {
      const old = this.#lfo;
      this.#lfo = { shape: spec.shape, node: this.#lfoSource(spec.shape) };
      this.#lfo.node.connect(this.#lfoOut);
      this.#lfo.node.start(t);
      if (old !== null) {
        old.node.stop(t);
        old.node.onended = () => old.node.disconnect();
      }
    }
    const node = this.#lfo.node;
    if (node instanceof OscillatorNode) node.frequency.setTargetAtTime(spec.rateHz, t, SMOOTH);
    else node.playbackRate.setTargetAtTime((spec.rateHz * SH_STEP_SAMPLES) / this.#ctx.sampleRate, t, SMOOTH);
    this.#lfoPitch.gain.setTargetAtTime(spec.target === 'pitch' ? spec.depth : 0, t, SMOOTH);
    this.#lfoFilter.gain.setTargetAtTime(spec.target === 'filter' ? spec.depth : 0, t, SMOOTH);
    this.#lfoCtrl.gain.setTargetAtTime(spec.target === 'ctrl' ? spec.depth : 0, t, SMOOTH);
  }

  updateVibrato(values: ValueReader, ctl: Controllers, t: number): void {
    const v = vibSpec(values, this.#layer);
    this.#vibOsc.frequency.setTargetAtTime(v.rateHz, t, SMOOTH);
    this.#vibDepth.gain.setTargetAtTime(vibDepthCents(v, ctl), t, SMOOTH);
  }

  updateBend(values: ValueReader, bend: number, t: number): void {
    this.#bend.offset.setTargetAtTime(bendCents(values, this.#layer, bend), t, 0.005);
  }

  dispose(): void {
    this.#lfo?.node.stop();
    this.#bend.stop();
    this.#vibOsc.stop();
    for (const n of [this.#bus, this.#pan, this.#bend, this.#lfoOut, this.#lfoPitch, this.#lfoFilter, this.#lfoCtrl,
      this.#vibOsc, this.#vibDepth]) n.disconnect();
    this.#lfo?.node.disconnect();
  }

  #lfoSource(shape: LfoShape): OscillatorNode | AudioBufferSourceNode {
    const ctx = this.#ctx;
    if (shape === 'sh') {
      const buf = ctx.createBuffer(1, SH_STEPS * SH_STEP_SAMPLES, ctx.sampleRate);
      const data = buf.getChannelData(0);
      const next = rng(7);
      for (let s = 0; s < SH_STEPS; s++) data.fill(next() * 2 - 1, s * SH_STEP_SAMPLES, (s + 1) * SH_STEP_SAMPLES);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      return src;
    }
    const osc = ctx.createOscillator();
    if (shape === 'triangle') osc.type = 'triangle';
    else if (shape === 'saw') osc.type = 'sawtooth';
    else if (shape === 'square') osc.type = 'square';
    else {
      const { real, imag } = toCoefficients(cycle((p) => -basic('saw', p)), 32);
      osc.setPeriodicWave(ctx.createPeriodicWave(real, imag));
    }
    return osc;
  }
}

export interface VoiceInfo {
  readonly id: number;
  readonly layer: SynthLayer;
  readonly note: number;
  readonly filterHz: readonly number[];
  /** The split crossfade gain the voice started with. */
  readonly gain: number;
}

export class SynthEngine implements SectionEngine<'synth'> {
  readonly section = 'synth';
  readonly #ctx: BaseAudioContext;
  readonly #values: ValueReader;
  readonly #alloc: VoiceAllocator;
  /** The engine's own master when no shared output was given; null otherwise. */
  readonly #ownMaster: MasterBus | null;
  readonly #layers: Readonly<Record<SynthLayer, LayerNodes>>;
  readonly #voices = new Map<number, Voice>();
  /** Each sounding voice's split crossfade GainNode, by voice id. */
  readonly #xfades = new Map<number, GainNode>();
  readonly #ctl: Controllers = { wheel: 0, pressure: 0, pedal: 0 };
  #bend = 0;
  readonly #handlers: Readonly<Record<Effect, (layer: SynthLayer | null, t: number) => void>>;

  /**
   * With `out` the layer pans feed it (the shared MasterBus input) and the engine builds no master
   * of its own; without it the engine owns a MasterBus to the destination, as before section 13.
   */
  constructor(ctx: BaseAudioContext, values: ValueReader, allocator: VoiceAllocator = new VoiceAllocator(),
    out?: AudioNode) {
    this.#ctx = ctx;
    this.#values = values;
    this.#alloc = allocator;
    this.#ownMaster = out === undefined ? new MasterBus(ctx) : null;
    const dest = out ?? this.#ownMaster!.input;
    this.#layers = {
      A: new LayerNodes(ctx, 'A', dest),
      B: new LayerNodes(ctx, 'B', dest),
      C: new LayerNodes(ctx, 'C', dest),
    };

    const none = (): void => undefined;
    const voices = (kind: VoiceUpdate) => (layer: SynthLayer | null, t: number): void => {
      for (const v of this.#voices.values()) if (layer === null || v.layer === layer) v.update(kind, this.#values, t);
    };
    const layerFn = (fn: (l: LayerNodes, t: number) => void) => (layer: SynthLayer | null, t: number): void => {
      for (const l of layer === null ? LAYERS : [layer]) fn(this.#layers[l], t);
    };
    this.#handlers = {
      // Read at the next note, the next envelope stage, or not at all.
      layers: none, focus: none, envTimes: none, ampVelocity: none, voicing: none, glide: none, unison: none,
      vibDelay: none,
      layerBus: layerFn((l, t) => l.updateBus(this.#values, t)),
      lfo: layerFn((l, t) => l.updateLfo(this.#values, t)),
      vibrato: layerFn((l, t) => l.updateVibrato(this.#values, this.#ctl, t)),
      bend: layerFn((l, t) => l.updateBend(this.#values, this.#bend, t)),
      source: voices('source'),
      ctrl: voices('ctrl'),
      pitch: voices('pitch'),
      oscEnvDepth: voices('oscEnvDepth'),
      filterChain: voices('filterChain'),
      filterParams: voices('filterParams'),
      filterEnvDepth: voices('filterEnvDepth'),
    };
    this.#refreshLayers();
  }

  get context(): BaseAudioContext {
    return this.#ctx;
  }

  /** Voices held, sustained or releasing (the allocator's count). */
  get activeCount(): number {
    return this.#alloc.activeCount;
  }

  /** Alias of activeCount (plan section 1 name). */
  get activeVoices(): number {
    return this.activeCount;
  }

  /** The voices that sound right now, for inspection. */
  voices(): VoiceInfo[] {
    return [...this.#voices.values()].map((v) => ({
      id: v.id, layer: v.layer, note: v.note, filterHz: v.filterFrequencies, gain: this.#xfades.get(v.id)?.gain.value ?? 1,
    }));
  }

  /**
   * A routed note-on plays the hits whose layer can sound, each voice at its hit's crossfade gain.
   * A plain PlayEvent note-on (tests, console) plays every layer enabled in the active scene at 1.
   * A note-off releases every voice of the note, on whatever layers it started.
   */
  handle(e: SectionEvent<SynthLayer> | PlayEvent): void {
    const t = this.#ctx.currentTime;
    switch (e.type) {
      case 'noteOn': {
        const hits: readonly LayerHit<SynthLayer>[] = 'layers' in e
          ? e.layers
          : enabledLayers(this.#values).map((layer) => ({ layer, gain: 1 }));
        const playable = hits.filter((h) => silentReason(this.#values, h.layer) === null);
        if (playable.length === 0) return;
        const gains = new Map(playable.map((h) => [h.layer, h.gain] as const));
        this.#run(this.#alloc.noteOn(e.note, e.velocity, playable.map((h) => voicing(this.#values, h.layer))), t, gains);
        return;
      }
      case 'noteOff':
        this.#run(this.#alloc.noteOff(e.note), t);
        return;
      case 'sustain':
        this.#run(this.#alloc.sustain(e.on), t);
        return;
      case 'bend':
        this.#bend = e.value;
        for (const l of LAYERS) this.#layers[l].updateBend(this.#values, this.#bend, t);
        return;
      case 'controller':
        this.#ctl[e.kind] = e.value;
        for (const l of LAYERS) this.#layers[l].updateVibrato(this.#values, this.#ctl, t);
        return;
      case 'panic':
        this.panic();
        return;
    }
  }

  /** Follow a batch of store changes; a load or init rebuilds everything after a panic. */
  applyChanges(batch: readonly Change[]): void {
    if (batch.some((c) => c.origin === 'load' || c.origin === 'init')) {
      this.reload();
      return;
    }
    const t = this.#ctx.currentTime;
    const done = new Set<string>();
    for (const c of batch) {
      const binding = bindingOf(c.key);
      if (binding === null) continue;
      const layer = layerOf(c.key);
      const id = `${binding.effect}:${layer ?? '-'}`;
      if (done.has(id)) continue;
      done.add(id);
      this.#handlers[binding.effect](layer, t);
    }
  }

  /** After a program load: stop every voice and set the layers from the new values. */
  reload(): void {
    this.panic();
    this.#refreshLayers();
  }

  /** All notes off at once: every voice is freed (count 0) and fades out over 10 ms. */
  panic(): void {
    const t = this.#ctx.currentTime;
    this.#run(this.#alloc.allNotesOff(), t);
    for (const v of this.#voices.values()) v.kill(t);
    this.#voices.clear();
  }

  /** Stops every voice and frees the layer nodes; a shared output (`out`) is left alone. */
  dispose(): void {
    this.panic();
    for (const l of LAYERS) this.#layers[l].dispose();
    this.#ownMaster?.dispose();
  }

  #refreshLayers(): void {
    const t = this.#ctx.currentTime;
    for (const l of LAYERS) {
      const nodes = this.#layers[l];
      nodes.updateBus(this.#values, t);
      nodes.updateLfo(this.#values, t);
      nodes.updateVibrato(this.#values, this.#ctl, t);
      nodes.updateBend(this.#values, this.#bend, t);
    }
  }

  /** Carry out voice commands; `gains` gives the crossfade gain of each layer a start may begin (default 1). */
  #run(cmds: readonly VoiceCommand[], t: number, gains?: ReadonlyMap<SynthLayer, number>): void {
    for (const cmd of cmds) {
      switch (cmd.type) {
        case 'start': {
          // The crossfade gain is set once, at note-on; a mono or legato retarget keeps it.
          const taps = this.#layers[cmd.layer].taps;
          const xfade = this.#ctx.createGain();
          xfade.gain.value = gains?.get(cmd.layer) ?? 1;
          xfade.connect(taps.bus);
          const v = new Voice(this.#ctx, { ...taps, bus: xfade }, this.#values, {
            id: cmd.id, layer: cmd.layer, note: cmd.note, velocity: cmd.velocity, time: t,
            mode: voicing(this.#values, cmd.layer).mode,
          });
          this.#xfades.set(cmd.id, xfade);
          v.onEnded = (id) => {
            if (this.#voices.get(id) === v) this.#voices.delete(id);
            // A killed voice ends after its 10 ms fade: its crossfade node goes with it, not before.
            if (this.#xfades.get(id) === xfade) this.#xfades.delete(id);
            xfade.disconnect();
            this.#alloc.voiceEnded(id);
          };
          this.#voices.set(cmd.id, v);
          break;
        }
        case 'retarget':
          this.#voices.get(cmd.id)?.retarget(cmd.note, cmd.retrigger, this.#values, t);
          break;
        case 'release':
          this.#voices.get(cmd.id)?.release(this.#values, t);
          break;
        case 'kill':
          this.#voices.get(cmd.id)?.kill(t);
          this.#voices.delete(cmd.id);
          break;
      }
    }
  }
}

/** The synth as a section of the shared master (plan section 13.5). */
export const synthFactory: SectionFactory<'synth'> = (c) => new SynthEngine(c.ctx, c.values, undefined, c.out);
