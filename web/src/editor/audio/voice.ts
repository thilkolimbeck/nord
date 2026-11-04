/**
 * One sounding voice of one synth layer on native nodes (plan section 4.1):
 *
 *   pitch source (cents re A4) ◄─ bend, LFO, vibrato, osc env      ─► every oscillator's detune
 *   ctrl source (0..1)         ◄─ LFO, osc env                      ─► osc ctrl targets
 *   oscillators ─► mixer ─► [drive] ─► filter (1–2 biquads; LP+HP as a parallel pair) ─► VCA ─► layer bus
 *   cutoff source (cents)      ◄─ keyboard tracking, filter env, LFO ─► the filter's detune
 *
 * Envelopes are scheduled from envelope.ts and their level is computed there, never read back from
 * an AudioParam. The voice stops its sources when the amp envelope falls below -80 dB and reports
 * that through onEnded, so the allocator frees it.
 *
 * Source providers (sources.ts, plan section 15): the layer's providers may build the oscillator
 * graph instead of oscillators.ts (own samples in samples mode, the AudioWorklet oscillators); the
 * first one that answers wins, the native builder takes the rest. Filter providers likewise may
 * build the stage between the mixer and the VCA (the AudioWorklet LP M ladder and drive, plan
 * 15.7); the native drive shaper and biquads (buildBiquads) take the rest.
 */
import { attackSteps, envEndTime, type EnvSchedule, type EnvStep, envValueAt, releaseSteps } from './envelope.ts';
import {
  ampPeak, driveGain, envelope, filterEnvCents, type FilterSpec, filterSpec, glideSecondsPerSemitone, kbdTrackCents,
  oscCtrl, oscEnvDepth, oscSpec, pitchCents, unison, vibSpec,
} from './mapping.ts';
import type { SynthLayer } from '../model/keys.ts';
import type { ValueReader } from '../model/labels.ts';
import { buildOscGraph, type OscGraph } from './oscillators.ts';
import { buildSource, type FilterStage, type VoiceHooks } from './sources.ts';
import { tanhCurve } from './waveforms.ts';

/** What a layer hands its voices: where to play and the shared modulation signals. */
export interface LayerTaps {
  readonly bus: AudioNode;
  /** Signals in cents that add to the pitch of every voice (bend, LFO). */
  readonly pitchMods: readonly AudioNode[];
  /** The layer vibrato in cents; each voice scales it (vibrato delay). */
  readonly vibrato: AudioNode;
  /** LFO to the filter, in cents. */
  readonly filterMod: AudioNode;
  /** LFO to osc ctrl, in osc ctrl units. */
  readonly ctrlMod: AudioNode;
  /** Source and filter providers of the layer (sources.ts); none: the native graph only. */
  readonly hooks?: VoiceHooks;
}

/** Live changes a voice follows while it sounds (audio/bindings.ts names which field causes which). */
export type VoiceUpdate = 'source' | 'ctrl' | 'pitch' | 'oscEnvDepth' | 'filterChain' | 'filterParams' | 'filterEnvDepth';

export interface VoiceOptions {
  readonly id: number;
  readonly layer: SynthLayer;
  readonly note: number;
  readonly velocity: number;
  readonly time: number;
  readonly mode: 'poly' | 'mono' | 'legato';
}

/** Fade-out of a killed voice (panic, steal), so nothing clicks. */
export const KILL_FADE = 0.01;
const CROSSFADE = 0.005;
/** Time constant of live parameter changes. */
const SMOOTH = 0.01;
/** A stop time that never comes: calling stop() again replaces an earlier stop time. */
const NEVER = 1e7;
const BUTTERWORTH_Q = Math.SQRT1_2;
/**
 * The shortest gate: a key-up that arrives in the same audio block as its key-down (a fast tap,
 * a short MIDI note) releases 5 ms after the start, so the note is heard with its release tail.
 */
export const MIN_GATE = 0.005;

function apply(param: AudioParam, steps: readonly EnvStep[]): void {
  for (const s of steps) {
    if (s.kind === 'set') param.setValueAtTime(s.value, s.time);
    else if (s.kind === 'linear') param.linearRampToValueAtTime(s.value, s.time);
    else param.setTargetAtTime(s.target, s.time, Math.max(1e-4, s.tau));
  }
}

/** Biquad Q: lowpass and highpass take dB, bandpass a plain Q. */
function biquadQ(type: BiquadFilterType, q: number): number {
  return type === 'lowpass' || type === 'highpass' ? 20 * Math.log10(q) : q;
}

function unlink(from: AudioNode, to: AudioNode | AudioParam): void {
  try {
    if (to instanceof AudioParam) from.disconnect(to);
    else from.disconnect(to);
  } catch {
    // Not connected (any more).
  }
}

type FilterRole = 'main' | 'second' | 'lphp-lp' | 'lphp-hp';

function filterValues(role: FilterRole, type: BiquadFilterType, spec: FilterSpec): { freq: number; q: number } {
  if (role === 'lphp-hp') return { freq: spec.hpFreq, q: biquadQ(type, BUTTERWORTH_Q) };
  if (role === 'second' || role === 'lphp-lp') return { freq: spec.freq, q: biquadQ(type, BUTTERWORTH_Q) };
  return { freq: spec.freq, q: biquadQ(type, spec.q) };
}

/** The native filter of one voice by type (plan 4.1), without drive: biquads, the cutoff source on their detune. */
export interface BiquadNet {
  /** Connects `head` into the filter and returns the filter's output. */
  attach(head: AudioNode): AudioNode;
  /** Live frequency and resonance (Q; LP+HP: the highpass frequency). */
  update(spec: FilterSpec, t: number): void;
  /** The biquads' frequency values in Hz, for inspection. */
  frequencies(): number[];
  disconnect(): void;
}

/**
 * The biquads of a filter type: LP12 one lowpass, LP24 and LP M two (the voice adds LP M's soft
 * clip), LP+HP a parallel lowpass and highpass, BP and HP one each. `cutoff` (cents) drives every
 * detune except the LP+HP highpass. Also the filter behind the AudioWorklet drive stage.
 */
export function buildBiquads(ctx: BaseAudioContext, spec: FilterSpec, cutoff: AudioNode): BiquadNet {
  const filters: Array<{ node: BiquadFilterNode; role: FilterRole }> = [];
  const nodes: AudioNode[] = [];
  const biquad = (type: BiquadFilterType, role: FilterRole): BiquadFilterNode => {
    const f = ctx.createBiquadFilter();
    nodes.push(f);
    f.type = type;
    const v = filterValues(role, type, spec);
    f.frequency.value = v.freq;
    f.Q.value = v.q;
    if (role !== 'lphp-hp') cutoff.connect(f.detune);
    filters.push({ node: f, role });
    return f;
  };
  const wire = (): ((head: AudioNode) => AudioNode) => {
    switch (spec.type) {
      case 'lp12': {
        const f = biquad('lowpass', 'main');
        return (head) => head.connect(f);
      }
      case 'lphp': {
        const sum = ctx.createGain();
        nodes.push(sum);
        sum.gain.value = 0.7;
        const lp = biquad('lowpass', 'lphp-lp');
        const hp = biquad('highpass', 'lphp-hp');
        lp.connect(sum);
        hp.connect(sum);
        return (head) => {
          head.connect(lp);
          head.connect(hp);
          return sum;
        };
      }
      case 'bp': {
        const f = biquad('bandpass', 'main');
        return (head) => head.connect(f);
      }
      case 'hp': {
        const f = biquad('highpass', 'main');
        return (head) => head.connect(f);
      }
      case 'lp24':
      case 'lpm':
      default: {
        const a = biquad('lowpass', 'main');
        const b = biquad('lowpass', 'second');
        a.connect(b);
        return (head) => {
          head.connect(a);
          return b;
        };
      }
    }
  };
  const attach = wire();
  return {
    attach,
    update(next: FilterSpec, t: number): void {
      for (const f of filters) {
        const { freq, q } = filterValues(f.role, f.node.type, next);
        f.node.frequency.setTargetAtTime(freq, t, SMOOTH);
        f.node.Q.setTargetAtTime(q, t, SMOOTH);
      }
    },
    frequencies: () => filters.map((f) => f.node.frequency.value),
    disconnect(): void {
      for (const f of filters) if (f.role !== 'lphp-hp') unlink(cutoff, f.node.detune);
      for (const n of nodes) n.disconnect();
    },
  };
}

export class Voice {
  readonly id: number;
  readonly layer: SynthLayer;
  onEnded: ((id: number) => void) | null = null;

  readonly #ctx: BaseAudioContext;
  readonly #taps: LayerTaps;
  readonly #mode: VoiceOptions['mode'];
  readonly #unison: { copies: number; spreadCents: number };
  #note: number;
  readonly #velocity: number;

  readonly #pitch: ConstantSourceNode;
  readonly #ctrl: ConstantSourceNode;
  readonly #cutoff: ConstantSourceNode;
  readonly #oscEnv: ConstantSourceNode;
  readonly #fltEnv: ConstantSourceNode;
  readonly #sources: ConstantSourceNode[];
  readonly #vib: GainNode;
  readonly #oscEnvPitch: GainNode;
  readonly #oscEnvCtrl: GainNode;
  readonly #fltEnvGain: GainNode;
  readonly #mixer: GainNode;
  readonly #vca: GainNode;

  #graph: { osc: OscGraph; fade: GainNode } | null = null;
  /** Native drive and LP M soft-clip shapers. */
  #chain: AudioNode[] = [];
  /** The native biquads, or null with the filter off or a provider's stage in place. */
  #net: BiquadNet | null = null;
  /** A filter provider's stage and the cutoff it was last given (for inspection). */
  #stage: { readonly stage: FilterStage; hz: number[] } | null = null;
  #amp: EnvSchedule;
  #oscEnvS: EnvSchedule;
  #fltEnvS: EnvSchedule;
  /** The pitch ramp in progress (glide or a live tune change), cents. */
  #glide: { from: number; to: number; t0: number; t1: number };
  #stopAt = Infinity;
  #killed = false;
  #ended = false;

  constructor(ctx: BaseAudioContext, taps: LayerTaps, values: ValueReader, o: VoiceOptions) {
    this.id = o.id;
    this.layer = o.layer;
    this.#ctx = ctx;
    this.#taps = taps;
    this.#mode = o.mode;
    this.#note = o.note;
    this.#velocity = o.velocity;
    this.#unison = unison(values, o.layer);
    const t = o.time;
    const layer = o.layer;

    const source = (offset: number): ConstantSourceNode => {
      const s = ctx.createConstantSource();
      s.offset.value = offset;
      return s;
    };
    const base = pitchCents(values, layer, o.note);
    this.#glide = { from: base, to: base, t0: t, t1: t };
    const fSpec = filterSpec(values, layer, ctx.sampleRate);
    this.#pitch = source(base);
    this.#ctrl = source(oscCtrl(values, layer));
    this.#cutoff = source(kbdTrackCents(fSpec.kbdTrack, o.note));
    this.#oscEnv = source(0);
    this.#fltEnv = source(0);
    this.#sources = [this.#pitch, this.#ctrl, this.#cutoff, this.#oscEnv, this.#fltEnv];

    // Shared modulation in.
    for (const m of taps.pitchMods) m.connect(this.#pitch.offset);
    this.#vib = ctx.createGain();
    const vib = vibSpec(values, layer);
    if (vib.mode === 'delay' && vib.delay > 0) {
      this.#vib.gain.setValueAtTime(0, t);
      this.#vib.gain.linearRampToValueAtTime(1, t + vib.delay);
    }
    taps.vibrato.connect(this.#vib).connect(this.#pitch.offset);
    taps.ctrlMod.connect(this.#ctrl.offset);
    taps.filterMod.connect(this.#cutoff.offset);

    // Envelope depths.
    const depth = oscEnvDepth(values, layer, o.velocity);
    this.#oscEnvPitch = ctx.createGain();
    this.#oscEnvPitch.gain.value = depth.pitchCents;
    this.#oscEnvCtrl = ctx.createGain();
    this.#oscEnvCtrl.gain.value = depth.ctrl;
    this.#oscEnv.connect(this.#oscEnvPitch).connect(this.#pitch.offset);
    this.#oscEnv.connect(this.#oscEnvCtrl).connect(this.#ctrl.offset);
    this.#fltEnvGain = ctx.createGain();
    this.#fltEnvGain.gain.value = filterEnvCents(values, layer, o.velocity);
    this.#fltEnv.connect(this.#fltEnvGain).connect(this.#cutoff.offset);

    // Audio path.
    this.#mixer = ctx.createGain();
    this.#vca = ctx.createGain();
    this.#vca.gain.value = 0;
    this.#vca.connect(taps.bus);
    this.#buildChain(fSpec, values);

    // Envelopes.
    const env = (which: 'osc' | 'flt' | 'amp', peak: number): EnvSchedule => {
      const e = envelope(values, layer, which);
      return { start: t, attack: e.attack, decay: e.decay, release: e.release, releaseAt: null, peak };
    };
    this.#amp = env('amp', ampPeak(values, layer, o.velocity));
    this.#oscEnvS = env('osc', 1);
    this.#fltEnvS = env('flt', 1);
    apply(this.#vca.gain, attackSteps(this.#amp));
    apply(this.#oscEnv.offset, attackSteps(this.#oscEnvS));
    apply(this.#fltEnv.offset, attackSteps(this.#fltEnvS));

    for (const s of this.#sources) s.start(t);
    this.#pitch.onended = () => this.#finish();
    this.#setSource(values, t, false);
    this.#scheduleEnd();
  }

  get note(): number {
    return this.#note;
  }

  /** The filter's frequency values in Hz, for inspection (empty with the filter off; a provider's stage: its cutoff). */
  get filterFrequencies(): number[] {
    return this.#stage?.hz ?? this.#net?.frequencies() ?? [];
  }

  /** Whether the voice has stopped and let go of its nodes. */
  get ended(): boolean {
    return this.#ended;
  }

  /** Key-up: every envelope falls from where it is; release times are read now. */
  release(values: ValueReader, now: number): void {
    if (this.#killed || this.#ended) return;
    const t = Math.max(now, this.#amp.start + MIN_GATE);
    const rel = (which: 'osc' | 'flt' | 'amp', s: EnvSchedule): EnvSchedule & { releaseAt: number } =>
      ({ ...s, releaseAt: t, release: envelope(values, this.layer, which).release });
    const amp = rel('amp', this.#amp);
    const osc = rel('osc', this.#oscEnvS);
    const flt = rel('flt', this.#fltEnvS);
    this.#amp = amp;
    this.#oscEnvS = osc;
    this.#fltEnvS = flt;
    for (const [param, s] of [[this.#vca.gain, amp], [this.#oscEnv.offset, osc], [this.#fltEnv.offset, flt]] as const) {
      param.cancelScheduledValues(t);
      apply(param, releaseSteps(s));
    }
    this.#scheduleEnd();
  }

  /** Mono and legato: move to another note, gliding where glide is set; retrigger restarts the envelopes. */
  retarget(note: number, retrigger: boolean, values: ValueReader, t: number): void {
    if (this.#killed || this.#ended) return;
    this.#note = note;
    const to = pitchCents(values, this.layer, note);
    const from = this.#pitchAt(t);
    const perSemi = this.#mode === 'poly' ? 0 : glideSecondsPerSemitone(values, this.layer);
    const duration = (Math.abs(to - from) / 100) * perSemi;
    this.#rampPitch(from, to, t, duration);
    this.#cutoff.offset.setTargetAtTime(kbdTrackCents(filterSpec(values, this.layer, this.#ctx.sampleRate).kbdTrack, note),
      t, SMOOTH);
    this.#graph?.osc.retune(to, t);
    if (!retrigger) return;
    const again = (which: 'osc' | 'flt' | 'amp', s: EnvSchedule): EnvSchedule => {
      const e = envelope(values, this.layer, which);
      return { start: t, attack: e.attack, decay: e.decay, release: e.release, releaseAt: null, peak: s.peak,
        from: envValueAt(s, t) };
    };
    this.#amp = again('amp', this.#amp);
    this.#oscEnvS = again('osc', this.#oscEnvS);
    this.#fltEnvS = again('flt', this.#fltEnvS);
    for (const [param, s] of [[this.#vca.gain, this.#amp], [this.#oscEnv.offset, this.#oscEnvS],
      [this.#fltEnv.offset, this.#fltEnvS]] as const) {
      param.cancelScheduledValues(t);
      apply(param, attackSteps(s));
    }
    this.#scheduleEnd();
  }

  /** Panic or steal: a 10 ms fade to silence, then stop. */
  kill(t: number): void {
    if (this.#killed || this.#ended) return;
    this.#killed = true;
    const g = this.#vca.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(envValueAt(this.#amp, t), t);
    g.linearRampToValueAtTime(0, t + KILL_FADE);
    this.#stop(t + KILL_FADE + 0.005);
  }

  /** Follow a live change of the layer's fields. */
  update(kind: VoiceUpdate, values: ValueReader, t: number): void {
    if (this.#killed || this.#ended) return;
    const layer = this.layer;
    switch (kind) {
      case 'source':
        this.#setSource(values, t, true);
        break;
      case 'ctrl': {
        const c = oscCtrl(values, layer);
        this.#ctrl.offset.setTargetAtTime(c, t, SMOOTH);
        this.#graph?.osc.setCtrl(c);
        break;
      }
      case 'pitch': {
        const to = pitchCents(values, layer, this.#note);
        this.#rampPitch(this.#pitchAt(t), to, t, SMOOTH);
        this.#graph?.osc.retune(to, t);
        break;
      }
      case 'oscEnvDepth': {
        const d = oscEnvDepth(values, layer, this.#velocity);
        this.#oscEnvPitch.gain.setTargetAtTime(d.pitchCents, t, SMOOTH);
        this.#oscEnvCtrl.gain.setTargetAtTime(d.ctrl, t, SMOOTH);
        break;
      }
      case 'filterChain':
        this.#buildChain(filterSpec(values, layer, this.#ctx.sampleRate), values);
        break;
      case 'filterParams': {
        const spec = filterSpec(values, layer, this.#ctx.sampleRate);
        this.#cutoff.offset.setTargetAtTime(kbdTrackCents(spec.kbdTrack, this.#note), t, SMOOTH);
        if (this.#stage !== null) {
          this.#stage.stage.update(spec, t);
          this.#stage.hz = [spec.freq];
        } else this.#net?.update(spec, t);
        break;
      }
      case 'filterEnvDepth':
        this.#fltEnvGain.gain.setTargetAtTime(filterEnvCents(values, layer, this.#velocity), t, SMOOTH);
        break;
    }
  }

  #pitchAt(t: number): number {
    const g = this.#glide;
    if (t >= g.t1 || g.t1 <= g.t0) return g.to;
    if (t <= g.t0) return g.from;
    return g.from + ((g.to - g.from) * (t - g.t0)) / (g.t1 - g.t0);
  }

  #rampPitch(from: number, to: number, t: number, duration: number): void {
    const p = this.#pitch.offset;
    p.cancelScheduledValues(t);
    p.setValueAtTime(from, t);
    if (duration > 0) p.linearRampToValueAtTime(to, t + duration);
    else p.setValueAtTime(to, t);
    this.#glide = { from, to, t0: t, t1: t + Math.max(0, duration) };
  }

  /** Build the oscillators for the current spec; with `fade`, crossfade from the old ones. */
  #setSource(values: ValueReader, t: number, fade: boolean): void {
    const old = this.#graph;
    const spec = oscSpec(values, this.layer);
    this.#graph = null;
    const inputs = { pitch: this.#pitch, ctrl: this.#ctrl };
    const cents = this.#pitchAt(t);
    const provided = buildSource(this.#taps.hooks?.sources ?? [], {
      ctx: this.#ctx, values, layer: this.layer, note: this.#note, velocity: this.#velocity, spec, inputs,
      unison: this.#unison, cents,
    });
    const osc = provided ?? ('bank' in spec ? buildOscGraph(this.#ctx, spec, inputs, this.#unison, cents) : null);
    if (osc !== null) {
      const g = this.#ctx.createGain();
      osc.output.connect(g).connect(this.#mixer);
      if (fade && old !== null) {
        g.gain.setValueAtTime(0, t);
        g.gain.linearRampToValueAtTime(1, t + CROSSFADE);
      }
      osc.start(t);
      if (Number.isFinite(this.#stopAt)) osc.stop(this.#stopAt);
      this.#graph = { osc, fade: g };
    }
    if (old !== null) {
      old.fade.gain.cancelScheduledValues(t);
      old.fade.gain.setValueAtTime(1, t);
      old.fade.gain.linearRampToValueAtTime(0, t + CROSSFADE);
      // Disconnect once the old sources really stopped on the audio clock.
      old.osc.onEnded(() => {
        old.osc.disconnect();
        old.fade.disconnect();
      });
      old.osc.stop(t + CROSSFADE + 0.005);
    }
  }

  /**
   * mixer ─► [drive] ─► filter ─► [soft clip for LP M] ─► VCA, or mixer ─► VCA with the filter off.
   * A filter provider (plan 15.7) may build the whole stage between mixer and VCA, drive included.
   */
  #buildChain(spec: FilterSpec, values: ValueReader): void {
    const ctx = this.#ctx;
    this.#mixer.disconnect();
    for (const n of this.#chain) n.disconnect();
    this.#net?.disconnect();
    this.#stage?.stage.disconnect();
    this.#chain = [];
    this.#net = null;
    this.#stage = null;
    if (!spec.enabled) {
      this.#mixer.connect(this.#vca);
      return;
    }
    for (const provider of this.#taps.hooks?.filters ?? []) {
      const stage = provider.build({ ctx, values, layer: this.layer, spec, cutoff: this.#cutoff });
      if (stage === null) continue;
      this.#mixer.connect(stage.input);
      stage.output.connect(this.#vca);
      this.#stage = { stage, hz: [spec.freq] };
      return;
    }
    let head: AudioNode = this.#mixer;
    const shaper = (gain: number): WaveShaperNode => {
      const s = ctx.createWaveShaper();
      this.#chain.push(s);
      s.curve = tanhCurve(gain);
      s.oversample = '2x';
      return s;
    };
    if (spec.drive > 0) head = head.connect(shaper(driveGain(spec.drive)));
    const net = buildBiquads(ctx, spec, this.#cutoff);
    this.#net = net;
    head = net.attach(head);
    if (spec.type === 'lpm') head = head.connect(shaper(1.5));
    head.connect(this.#vca);
  }

  /** Stop when the amp envelope falls silent; a holding envelope that is held never stops by itself. */
  #scheduleEnd(): void {
    const end = envEndTime(this.#amp);
    this.#stop(Number.isFinite(end) ? end : this.#ctx.currentTime + NEVER);
    if (!Number.isFinite(end)) this.#stopAt = Infinity;
  }

  #stop(t: number): void {
    this.#stopAt = t;
    for (const s of this.#sources) s.stop(t);
    this.#graph?.osc.stop(t);
  }

  #finish(): void {
    if (this.#ended) return;
    this.#ended = true;
    const taps = this.#taps;
    for (const m of taps.pitchMods) unlink(m, this.#pitch.offset);
    unlink(taps.vibrato, this.#vib);
    unlink(taps.ctrlMod, this.#ctrl.offset);
    unlink(taps.filterMod, this.#cutoff.offset);
    this.#graph?.osc.disconnect();
    this.#graph?.fade.disconnect();
    this.#graph = null;
    for (const n of [...this.#sources, this.#vib, this.#oscEnvPitch, this.#oscEnvCtrl, this.#fltEnvGain, this.#mixer,
      ...this.#chain, this.#vca]) n.disconnect();
    this.#net?.disconnect();
    this.#stage?.stage.disconnect();
    this.#chain = [];
    this.#net = null;
    this.#stage = null;
    this.onEnded?.(this.id);
  }
}
