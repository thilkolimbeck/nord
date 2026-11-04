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
 *                     ─► gate GainNode (arpeggiator gate mode) ─► StereoPannerNode (pan)
 *                     ─► the layer's effects chain (fx/types.ts, synth{L}Fx; a pass-through without hooks) ─► out
 *   out:        the shared output (global effects, then the MasterBus); without one the engine builds its own master
 *
 * Voice hooks (sources.ts): source and filter providers (own samples, the AudioWorklet engine) reach
 * every voice through the layer taps; a layer a source provider covers (samples mode with an own
 * sample) is not silent.
 *
 * Between the router and the voices sit, per layer (manual p.35–37):
 *
 * - KB hold: with KB Hold on and the layer included, a key-up keeps the note; the next key on the
 *   layer after all its keys were lifted releases the kept notes first (a new chord replaces the
 *   old one; while keys are down, new notes join). Panic and KB Hold off release them.
 * - The arpeggiator (arp.ts): with Arp Run in Arp or Poly mode the layer's held notes feed the
 *   scheduler instead of starting voices; tick() (every 25 ms while an arpeggiator runs, with a
 *   100 ms horizon) plays its note events at their times on the layer. In Gate mode notes play
 *   directly and the scheduler opens and closes the layer's gate GainNode on every step.
 *   A layer that is off or silent starts no arpeggio notes; switching it off releases its KB hold notes.
 * - The master clock (clock.ts): the synced arpeggiators' step grid and the synced LFOs' rate; its
 *   keyboard sync resets it at the first synth key after all synth keys were lifted.
 */
import type { PlayEvent } from '../input/events.ts';
import { LAYERS, layerKey, layerOf, type SynthLayer } from '../model/keys.ts';
import type { ValueReader } from '../model/labels.ts';
import { focusedLayer, SCENE_KEY } from '../model/scene.ts';
import type { Change } from '../model/store.ts';
import { type ArpEvent, type ArpHeld, type ArpMode, ArpScheduler } from './arp.ts';
import { bindingOf, type Effect } from './bindings.ts';
import { CLOCK_KBD_SYNC, MasterClock, shouldResetClock, type StepGrid } from './clock.ts';
import {
  type ArpSpec, arpSpec, bendCents, clockBpm, enabledLayers, gateTau, holdOn, layerGain, layerPan, type LfoShape,
  lfoSpec, lfoSynced, vibDepthCents, vibSpec, voicing,
} from './mapping.ts';
import { fxChainFor, type FxChain, type FxHooks, type FxHost } from './fx/types.ts';
import { MasterBus } from './master.ts';
import type { LayerHit, SectionEngine, SectionEvent, SectionFactory } from './section.ts';
import { layerSilence, NO_HOOKS, type VoiceHooks } from './sources.ts';
import { VoiceAllocator, type VoiceCommand } from './voice-alloc.ts';
import { type LayerTaps, Voice, type VoiceUpdate } from './voice.ts';
import { basic, cycle, rng, toCoefficients } from './waveforms.ts';

const SMOOTH = 0.01;
/** Sample-and-hold LFO: 64 random steps of 256 samples each, looped; the playback rate sets the step rate. */
const SH_STEPS = 64;
const SH_STEP_SAMPLES = 256;
/** Arpeggiator scheduling: a tick every 25 ms plans the next 100 ms on the audio clock. */
export const ARP_TICK_MS = 25;
export const ARP_HORIZON = 0.1;
/** How many recent arpeggiator events arpLog() keeps, for inspection. */
const ARP_LOG = 256;

/** The periodic callback that drives tick(); tests pass a manual one. */
export interface ArpTimer {
  start(fn: () => void, ms: number): unknown;
  stop(handle: unknown): void;
}

const INTERVAL_TIMER: ArpTimer = {
  start: (fn, ms) => globalThis.setInterval(fn, ms),
  stop: (handle) => globalThis.clearInterval(handle as ReturnType<typeof setInterval>),
};

export interface SynthOptions {
  readonly timer?: ArpTimer;
  /** Random source of the arpeggiator's random direction (default Math.random). */
  readonly random?: () => number;
  /** The layer effects (SectionContext.fx); without them each layer's chain passes through. */
  readonly fx?: FxHooks;
  /** Source and filter providers for every voice (own samples, AudioWorklet); default none. */
  readonly hooks?: VoiceHooks;
}

/** What a layer's arpeggiator does: nothing, arpeggiate notes, or gate the sound. */
type ArpState = 'off' | ArpMode;

export interface Controllers {
  wheel: number;
  pressure: number;
  pedal: number;
}

/** One layer's shared nodes: bus, pan, effects chain, LFO, vibrato and bend. */
class LayerNodes {
  readonly taps: LayerTaps;
  readonly chain: FxChain;
  readonly #ctx: BaseAudioContext;
  readonly #layer: SynthLayer;
  readonly #bus: GainNode;
  readonly #gate: GainNode;
  readonly #pan: StereoPannerNode;
  readonly #bend: ConstantSourceNode;
  readonly #lfoOut: GainNode;
  readonly #lfoPitch: GainNode;
  readonly #lfoFilter: GainNode;
  readonly #lfoCtrl: GainNode;
  readonly #vibOsc: OscillatorNode;
  readonly #vibDepth: GainNode;
  #lfo: { shape: LfoShape; node: OscillatorNode | AudioBufferSourceNode } | null = null;

  constructor(ctx: BaseAudioContext, layer: SynthLayer, out: AudioNode, host: FxHost, hooks: VoiceHooks) {
    this.#ctx = ctx;
    this.#layer = layer;
    this.#bus = ctx.createGain();
    this.#gate = ctx.createGain();
    this.#gate.gain.value = 1;
    this.#pan = ctx.createStereoPanner();
    this.#bus.connect(this.#gate).connect(this.#pan);
    this.chain = fxChainFor(host, `synth${layer}Fx`, this.#pan, out);
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
      filterMod: this.#lfoFilter, ctrlMod: this.#lfoCtrl, hooks,
    };
  }

  updateBus(values: ValueReader, t: number): void {
    this.#bus.gain.setTargetAtTime(layerGain(values, this.#layer), t, SMOOTH);
    this.#pan.pan.setTargetAtTime(layerPan(values, this.#layer), t, SMOOTH);
  }

  updateLfo(values: ValueReader, t: number, restart = false): void {
    const spec = lfoSpec(values, this.#layer);
    let fresh = false;
    if (restart || this.#lfo === null || this.#lfo.shape !== spec.shape) {
      const old = this.#lfo;
      this.#lfo = { shape: spec.shape, node: this.#lfoSource(spec.shape) };
      this.#lfo.node.connect(this.#lfoOut);
      this.#lfo.node.start(t);
      fresh = true;
      if (old !== null) {
        old.node.stop(t);
        old.node.onended = () => old.node.disconnect();
      }
    }
    const node = this.#lfo.node;
    // A new source starts at its rate; a running one glides to a new rate.
    const rate = node instanceof OscillatorNode ? node.frequency : node.playbackRate;
    const value = node instanceof OscillatorNode ? spec.rateHz : (spec.rateHz * SH_STEP_SAMPLES) / this.#ctx.sampleRate;
    if (fresh) rate.setValueAtTime(value, t);
    else rate.setTargetAtTime(value, t, SMOOTH);
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

  /** Gate mode: open at the step, close half a step later; the hardness sets how sharp the edges are (M p.35). */
  gateStep(time: number, period: number, hardness: number): void {
    const tau = gateTau(period, hardness);
    this.#gate.gain.setTargetAtTime(1, time, tau);
    this.#gate.gain.setTargetAtTime(0, time + period / 2, tau);
  }

  /** KB sync restart of the gate: steps planned on the old grid after `t` are dropped. */
  gateCancel(t: number): void {
    this.#gate.gain.cancelScheduledValues(t);
  }

  /** Gate mode ends: the layer sounds open again. */
  gateOpen(t: number): void {
    this.#gate.gain.cancelScheduledValues(t);
    this.#gate.gain.setTargetAtTime(1, t, 0.005);
  }

  dispose(): void {
    this.#lfo?.node.stop();
    this.#bend.stop();
    this.#vibOsc.stop();
    for (const n of [this.#bus, this.#gate, this.#pan, this.#bend, this.#lfoOut, this.#lfoPitch, this.#lfoFilter, this.#lfoCtrl,
      this.#vibOsc, this.#vibDepth]) n.disconnect();
    this.#lfo?.node.disconnect();
    this.chain.dispose();
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
  readonly #hooks: VoiceHooks;
  #bend = 0;
  readonly #handlers: Readonly<Record<Effect, (layer: SynthLayer | null, t: number) => void>>;
  readonly #clock: MasterClock;
  readonly #timer: ArpTimer;
  #timerHandle: unknown = null;
  readonly #arps: Readonly<Record<SynthLayer, ArpScheduler>>;
  readonly #arpState: Record<SynthLayer, ArpState> = { A: 'off', B: 'off', C: 'off' };
  /** Anchor of each layer's free-running step grid (moved by KB sync). */
  readonly #freeAnchor: Record<SynthLayer, number> = { A: 0, B: 0, C: 0 };
  /** Keys down per layer (as routed), with velocity and crossfade gain. */
  readonly #keys: Readonly<Record<SynthLayer, Map<number, ArpHeld>>> = { A: new Map(), B: new Map(), C: new Map() };
  /** Notes KB hold keeps after key-up, per layer. */
  readonly #latched: Readonly<Record<SynthLayer, Map<number, ArpHeld>>> = { A: new Map(), B: new Map(), C: new Map() };
  /** When the last synth key was lifted (for the master clock's soft keyboard sync). */
  #lastAllUp = -Infinity;
  readonly #arpLog: Array<{ layer: SynthLayer } & ArpEvent> = [];
  /** Voices the arpeggiator started that had not begun at the last tick: id → start time, per layer. */
  readonly #arpVoices: Readonly<Record<SynthLayer, Map<number, number>>> = { A: new Map(), B: new Map(), C: new Map() };

  /**
   * With `out` the layer pans feed it (the shared MasterBus input) and the engine builds no master
   * of its own; without it the engine owns a MasterBus to the destination, as before section 13.
   */
  constructor(ctx: BaseAudioContext, values: ValueReader, allocator: VoiceAllocator = new VoiceAllocator(),
    out?: AudioNode, options: SynthOptions = {}) {
    this.#ctx = ctx;
    this.#values = values;
    this.#alloc = allocator;
    this.#timer = options.timer ?? INTERVAL_TIMER;
    this.#clock = new MasterClock(clockBpm(values), ctx.currentTime);
    const random = options.random ?? Math.random;
    this.#arps = { A: new ArpScheduler(random), B: new ArpScheduler(random), C: new ArpScheduler(random) };
    this.#ownMaster = out === undefined ? new MasterBus(ctx) : null;
    const dest = out ?? this.#ownMaster!.input;
    this.#hooks = options.hooks ?? NO_HOOKS;
    const host: FxHost = options.fx === undefined ? { ctx, values } : { ctx, values, fx: options.fx };
    this.#layers = {
      A: new LayerNodes(ctx, 'A', dest, host, this.#hooks),
      B: new LayerNodes(ctx, 'B', dest, host, this.#hooks),
      C: new LayerNodes(ctx, 'C', dest, host, this.#hooks),
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
      layers: (_, t) => {
        // A layer that can no longer play lets go of the notes KB hold keeps (they have no key-up).
        for (const l of LAYERS) if (!this.#playable(l)) this.#releaseLatched(l, t);
      },
      focus: none, envTimes: none, ampVelocity: none, voicing: none, glide: none, unison: none,
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
      arp: (layer, t) => {
        for (const l of layer === null ? LAYERS : [layer]) this.#syncArp(l, t);
      },
      arpGroup: () => this.#alignArpGroup(),
      hold: (_, t) => {
        for (const l of LAYERS) if (!holdOn(this.#values, l)) this.#releaseLatched(l, t);
      },
      // The filter group is the store's job (model/actions.ts): the layers' values are equal.
      group: none,
      lfoGroup: (_, t) => {
        if (this.#values.get('synth.multiLayerLFO') === 0) return;
        for (const l of LAYERS) this.#layers[l].updateLfo(this.#values, t, true);
      },
    };
    this.#refreshLayers();
    for (const l of LAYERS) this.#syncArp(l, ctx.currentTime);
  }

  /** The master clock (tempo and anchor), for inspection. */
  get clock(): MasterClock {
    return this.#clock;
  }

  /**
   * Bring the master clock to the stored tempo now (a no-op when it is there already). Readers that
   * may run before this engine sees a tempo change (the effects chains, earlier in a batch) call it
   * first, so they never time a delay or an LFO from the previous tempo.
   */
  syncClock(): MasterClock {
    this.#clock.setBpm(clockBpm(this.#values), this.#ctx.currentTime);
    return this.#clock;
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
        this.#noteOn(e.note, e.velocity, hits, t);
        return;
      }
      case 'noteOff':
        this.#noteOff(e.note, t);
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
        for (const l of LAYERS) {
          this.#layers[l].updateVibrato(this.#values, this.#ctl, t);
          this.#layers[l].chain.controller(e.kind, e.value);
        }
        return;
      case 'panic':
        this.panic();
        return;
    }
  }

  /** Follow a batch of store changes; a load or init rebuilds everything after a panic. */
  applyChanges(batch: readonly Change[]): void {
    // The effects chains read their own block, the effects switches and the clock (a load included).
    for (const l of LAYERS) this.#layers[l].chain.applyChanges(batch);
    if (batch.some((c) => c.origin === 'load' || c.origin === 'init')) {
      this.reload();
      return;
    }
    const t = this.#ctx.currentTime;
    const done = new Set<string>();
    if (batch.some((c) => c.key === 'common.masterClockRate')) {
      // A tempo change: synced arpeggiators read the clock at their next step, synced LFOs follow now.
      this.syncClock();
      for (const l of LAYERS) this.#layers[l].updateLfo(this.#values, t);
    }
    if (batch.some((c) => c.key === SCENE_KEY)) {
      // A scene switch changes which layers play, like a layer or section switch.
      done.add('layers:-');
      this.#handlers.layers(null, t);
    }
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
    this.syncClock();
    this.#refreshLayers();
    for (const l of LAYERS) this.#syncArp(l, this.#ctx.currentTime);
  }

  /**
   * All notes off at once: every voice is freed (count 0) and fades out over 10 ms; keys, notes kept
   * by KB hold and the arpeggiators' notes are forgotten.
   */
  panic(): void {
    const t = this.#ctx.currentTime;
    this.#run(this.#alloc.allNotesOff(), t);
    for (const v of this.#voices.values()) v.kill(t);
    this.#voices.clear();
    for (const l of LAYERS) {
      this.#keys[l].clear();
      this.#latched[l].clear();
      this.#arps[l].reset();
      this.#arpVoices[l].clear();
      this.#layers[l].chain.silence();
    }
  }

  /** Stops every voice and the arpeggiator timer, frees the layer nodes; a shared output (`out`) is left alone. */
  dispose(): void {
    this.panic();
    for (const l of LAYERS) this.#arpState[l] = 'off';
    this.#updateTimer();
    for (const l of LAYERS) this.#layers[l].dispose();
    this.#ownMaster?.dispose();
  }

  /**
   * Plan the arpeggiators' next ARP_HORIZON seconds: note events and gate steps at their audio
   * times. The timer calls it every ARP_TICK_MS while an arpeggiator runs; a key that reaches an
   * arpeggiator calls it at once, so a KB sync restart plays on the key.
   */
  tick(): void {
    const now = this.#ctx.currentTime;
    for (const l of LAYERS) {
      for (const [id, start] of this.#arpVoices[l]) if (start <= now) this.#arpVoices[l].delete(id);
      if (this.#arpState[l] === 'off') continue;
      const spec = arpSpec(this.#values, l);
      const events = this.#arps[l].schedule(now, now + ARP_HORIZON, spec, this.#arpGrid(l, spec));
      // A layer switched off (or silent) starts no arpeggio notes; their offs still pass.
      this.#playArp(l, this.#playable(l) ? events : events.filter((e) => e.type !== 'on'), spec);
    }
  }

  /** The most recent arpeggiator events (notes and gate steps), oldest first, for inspection. */
  arpLog(): ReadonlyArray<{ layer: SynthLayer } & ArpEvent> {
    return [...this.#arpLog];
  }

  /** Per layer: keys down, notes kept by KB hold, and the arpeggiator's state, for inspection. */
  held(): Record<SynthLayer, { keys: number[]; hold: number[]; arp: ArpState }> {
    const out = {} as Record<SynthLayer, { keys: number[]; hold: number[]; arp: ArpState }>;
    for (const l of LAYERS) {
      out[l] = { keys: [...this.#keys[l].keys()].sort((a, b) => a - b),
        hold: [...this.#latched[l].keys()].sort((a, b) => a - b), arp: this.#arpState[l] };
    }
    return out;
  }

  #noteOn(note: number, velocity: number, hits: readonly LayerHit<SynthLayer>[], t: number): void {
    const playable = hits.filter((h) => layerSilence(this.#values, h.layer, this.#hooks.sources) === null);
    if (playable.length === 0) return;
    // A restart (KB sync, a master clock reset) must plan its first step on the key, the gate's too.
    let plan = LAYERS.every((l) => this.#keys[l].size === 0) && this.#keyboardSync(playable, t);
    const direct: LayerHit<SynthLayer>[] = [];
    for (const h of playable) {
      const l = h.layer;
      const first = this.#keys[l].size === 0;
      // KB hold: the first key after all keys were lifted starts a new chord.
      if (first) this.#releaseLatched(l, t);
      this.#latched[l].delete(note);
      const entry: ArpHeld = { velocity, gain: h.gain };
      this.#keys[l].set(note, entry);
      const state = this.#arpState[l];
      if (state !== 'off' && first) {
        const spec = arpSpec(this.#values, l);
        if (spec.kbSync && !spec.clockSync) {
          this.#restartFree(l, t);
          plan = true;
        }
      }
      if (state === 'arp' || state === 'poly') {
        this.#playArp(l, this.#arps[l].noteOn(note, entry, t), arpSpec(this.#values, l));
        plan = true;
      } else direct.push(h);
    }
    if (direct.length > 0) {
      const gains = new Map(direct.map((h) => [h.layer, h.gain] as const));
      this.#run(this.#alloc.noteOn(note, velocity, direct.map((h) => voicing(this.#values, h.layer))), t, gains);
    }
    if (plan) this.tick();
  }

  #noteOff(note: number, t: number): void {
    const direct: SynthLayer[] = [];
    let known = false;
    for (const l of LAYERS) {
      const held = this.#keys[l].get(note);
      if (held === undefined) continue;
      known = true;
      this.#keys[l].delete(note);
      if (holdOn(this.#values, l)) this.#latched[l].set(note, held);
      else if (this.#arpeggiates(l)) this.#arps[l].noteOff(note);
      else direct.push(l);
    }
    if (known && LAYERS.every((l) => this.#keys[l].size === 0)) this.#lastAllUp = t;
    for (const l of direct) this.#run(this.#alloc.noteOff(note, l), t);
  }

  /** Whether a layer's held notes feed its arpeggiator (Arp or Poly mode) instead of voices. */
  #arpeggiates(l: SynthLayer): boolean {
    return this.#arpState[l] === 'arp' || this.#arpState[l] === 'poly';
  }

  /** Whether a layer can start notes now: on in the active scene and not silent. */
  #playable(l: SynthLayer): boolean {
    return enabledLayers(this.#values).includes(l) && layerSilence(this.#values, l, this.#hooks.sources) === null;
  }

  /**
   * Cancel the notes and gate steps a layer's arpeggiator planned for after `t` (a restart or a
   * stop): those voices end before they begin, and the allocator forgets them.
   */
  #cancelArpAfter(l: SynthLayer, t: number): void {
    for (const [id, start] of this.#arpVoices[l]) {
      if (start <= t) continue;
      this.#arpVoices[l].delete(id);
      // Killed before it begins: the attack is cancelled and the voice stays at 0 until it stops.
      this.#voices.get(id)?.kill(t);
      this.#voices.delete(id);
      this.#alloc.voiceEnded(id);
    }
    if (this.#arpState[l] === 'gate') this.#layers[l].gateCancel(t);
  }

  /** KB hold lets go of a layer's kept notes (a new chord, KB Hold off, the layer excluded). */
  #releaseLatched(l: SynthLayer, t: number): void {
    const latched = this.#latched[l];
    if (latched.size === 0) return;
    for (const note of latched.keys()) {
      if (this.#keys[l].has(note)) continue;
      if (this.#arpeggiates(l)) this.#arps[l].noteOff(note);
      else this.#run(this.#alloc.noteOff(note, l), t);
    }
    latched.clear();
  }

  /** The notes a layer holds now: keys down and notes kept by KB hold. */
  #heldEntries(l: SynthLayer): Array<[number, ArpHeld]> {
    return [...new Map([...this.#latched[l], ...this.#keys[l]])];
  }

  /** Follow a layer's Arp Run and mode: hand the held notes between the voices and the arpeggiator. */
  #syncArp(l: SynthLayer, t: number): void {
    const spec = arpSpec(this.#values, l);
    const next: ArpState = spec.run ? spec.mode : 'off';
    const prev = this.#arpState[l];
    if (next === prev) return;
    const wasNotes = prev === 'arp' || prev === 'poly';
    const isNotes = next === 'arp' || next === 'poly';
    this.#arpState[l] = next;
    if (prev === 'gate') this.#layers[l].gateOpen(t);
    if (wasNotes && !isNotes) {
      // The arpeggio stops: its notes end (those planned for later never start), and the notes
      // still held sound directly again.
      this.#cancelArpAfter(l, t);
      this.#playArp(l, this.#arps[l].flush(t), spec);
      this.#arps[l].reset();
      for (const [note, h] of this.#heldEntries(l)) {
        this.#run(this.#alloc.noteOn(note, h.velocity, [voicing(this.#values, l)]), t, new Map([[l, h.gain]]));
      }
    } else if (!wasNotes && isNotes) {
      // The arpeggio starts: the layer's direct voices end and its held notes feed the scheduler.
      this.#arps[l].reset();
      for (const [note, h] of this.#heldEntries(l)) {
        this.#run(this.#alloc.noteOff(note, l), t);
        this.#playArp(l, this.#arps[l].noteOn(note, h, t), spec);
      }
    } else if (next === 'gate') this.#arps[l].reset();
    this.#updateTimer();
    if (next !== 'off') this.tick();
  }

  #arpGrid(l: SynthLayer, spec: ArpSpec): StepGrid {
    return spec.clockSync ? this.#clock.grid(spec.division.beats) : { period: spec.freeStep, anchor: this.#freeAnchor[l] };
  }

  /** KB sync of a free-running arpeggiator: its grid starts at `t`; with the arp group on, every layer's does. */
  #restartFree(l: SynthLayer, t: number): void {
    const grouped = this.#values.get('synth.multiLayerArp') !== 0;
    for (const m of grouped ? LAYERS : [l]) {
      this.#freeAnchor[m] = t;
      if (this.#arpState[m] !== 'off' && !arpSpec(this.#values, m).clockSync) this.#restartArp(m, t);
    }
  }

  /** A layer's arpeggio or gate starts again at `t`: what it planned on the old grid after `t` is dropped. */
  #restartArp(l: SynthLayer, t: number): void {
    this.#cancelArpAfter(l, t);
    this.#arps[l].restart(t);
  }

  /** The arp group: every layer's free grid follows the focused layer's, so grouped arpeggios step together. */
  #alignArpGroup(): void {
    if (this.#values.get('synth.multiLayerArp') === 0) return;
    const anchor = this.#freeAnchor[focusedLayer(this.#values, 'synth')];
    for (const l of LAYERS) this.#freeAnchor[l] = anchor;
  }

  /**
   * The first synth key after all synth keys were lifted: the master clock's keyboard sync may reset
   * it (clock.ts shouldResetClock); then synced arpeggiators restart on the key and synced LFOs
   * restart their phase (M p.37: the reset affects everything synced to the clock).
   */
  #keyboardSync(hits: readonly LayerHit<SynthLayer>[], t: number): boolean {
    const v = this.#values;
    const kbSync = (l: SynthLayer): boolean => v.get(layerKey(l, 'synth{L}.arpKbdSync')) !== 0;
    const reset = shouldResetClock({
      mode: CLOCK_KBD_SYNC[v.get('common.masterClockKbdSync')] ?? 'off',
      idle: t - this.#lastAllUp,
      beat: this.#clock.beat,
      reachesSyncLayer: hits.some((h) => kbSync(h.layer)),
      anySyncLayer: enabledLayers(v).some(kbSync),
    });
    if (!reset) return false;
    this.#clock.reset(t);
    let restarted = false;
    for (const l of LAYERS) {
      if (this.#arpState[l] !== 'off' && arpSpec(v, l).clockSync) {
        this.#restartArp(l, t);
        restarted = true;
      }
      if (lfoSynced(v, l)) this.#layers[l].updateLfo(v, t, true);
    }
    return restarted;
  }

  /** Carry out arpeggiator events on a layer at their times. */
  #playArp(l: SynthLayer, events: readonly ArpEvent[], spec: ArpSpec): void {
    for (const e of events) {
      this.#arpLog.push({ layer: l, ...e });
      if (e.type === 'on') {
        const cmds = this.#alloc.noteOn(e.note, e.velocity, [voicing(this.#values, l)]);
        this.#run(cmds, e.time, new Map([[l, e.gain]]));
        if (e.time > this.#ctx.currentTime) {
          for (const c of cmds) if (c.type === 'start') this.#arpVoices[l].set(c.id, e.time);
        }
      } else if (e.type === 'off') this.#run(this.#alloc.noteOff(e.note, l), e.time);
      else this.#layers[l].gateStep(e.time, e.period, spec.hardness);
    }
    if (this.#arpLog.length > ARP_LOG) this.#arpLog.splice(0, this.#arpLog.length - ARP_LOG);
  }

  /** The timer runs while any layer's arpeggiator does. */
  #updateTimer(): void {
    const need = LAYERS.some((l) => this.#arpState[l] !== 'off');
    if (need && this.#timerHandle === null) this.#timerHandle = this.#timer.start(() => this.tick(), ARP_TICK_MS);
    else if (!need && this.#timerHandle !== null) {
      this.#timer.stop(this.#timerHandle);
      this.#timerHandle = null;
    }
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

/**
 * The synth as a section of the shared output (plan sections 13.5 and 15), with voice hooks:
 * main passes the own-samples and AudioWorklet providers here. The layer effects come from the
 * context (SectionContext.fx).
 */
export function makeSynthFactory(options: Omit<SynthOptions, 'fx'> = {}): SectionFactory<'synth'> {
  return (c) => new SynthEngine(c.ctx, c.values, undefined, c.out, c.fx === undefined ? options : { ...options, fx: c.fx });
}

/** The synth as a section of the shared output, without voice hooks (plan section 13.5). */
export const synthFactory: SectionFactory<'synth'> = makeSynthFactory();
