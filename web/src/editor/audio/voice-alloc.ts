/**
 * Voice allocation (plan sections 1 and 2, AC 8). Pure: it turns note events into voice commands
 * that the audio engine carries out, and keeps count of the voices that still sound. No Web Audio.
 *
 * - Poly layers start one voice per note. When all MAX_VOICES are busy, the oldest releasing voice
 *   is stolen first, then the oldest sustained one, then the oldest held one.
 * - Mono and legato layers own one voice and a stack of the keys held for that layer. Priority
 *   'none' plays the last key, 'low' the lowest, 'high' the highest. Mono retriggers the envelopes
 *   on every note change; legato glides without retrigger while a key stays down.
 * - The sustain pedal defers releases for layers whose voicing has `sustain` on.
 * - allNotesOff kills every voice and forgets every held and sustained note.
 */
import type { SynthLayer } from '../model/keys.ts';

/** Stage 4 maximum polyphony of the synth section, counted per voice and layer. */
export const MAX_VOICES = 46;

export interface LayerVoicing {
  layer: SynthLayer;
  mode: 'poly' | 'mono' | 'legato';
  priority: 'none' | 'low' | 'high';
  /** Whether the sustain pedal holds this layer's notes. */
  sustain: boolean;
}

export type VoiceCommand =
  | { type: 'start'; id: number; layer: SynthLayer; note: number; velocity: number }
  | { type: 'retarget'; id: number; note: number; retrigger: boolean } // mono/legato
  | { type: 'release'; id: number }
  | { type: 'kill'; id: number }; // kill = steal or panic

type VoiceState = 'held' | 'sustained' | 'releasing';

interface Voice {
  id: number;
  layer: SynthLayer;
  note: number;
  state: VoiceState;
  /** Whether the pedal holds this voice. */
  sustain: boolean;
  /** Allocation order; the smallest is the oldest. */
  order: number;
  /** True for the single voice of a mono or legato layer. */
  mono: boolean;
}

interface MonoLayer {
  voicing: LayerVoicing;
  /** Held keys in press order. */
  stack: Array<{ note: number; velocity: number }>;
  voiceId: number | null;
}

const STEAL_ORDER: readonly VoiceState[] = ['releasing', 'sustained', 'held'];

export class VoiceAllocator {
  readonly #max: number;
  readonly #voices = new Map<number, Voice>();
  readonly #mono = new Map<SynthLayer, MonoLayer>();
  #nextId = 1;
  #order = 0;
  #pedal = false;

  constructor(maxVoices: number = MAX_VOICES) {
    if (!Number.isInteger(maxVoices) || maxVoices < 1) throw new RangeError(`maxVoices must be a positive integer, not ${maxVoices}`);
    this.#max = maxVoices;
  }

  noteOn(note: number, velocity: number, layers: readonly LayerVoicing[]): VoiceCommand[] {
    const out: VoiceCommand[] = [];
    for (const voicing of layers) {
      if (voicing.mode === 'poly') this.#polyOn(note, velocity, voicing, out);
      else this.#monoOn(note, velocity, voicing, out);
    }
    return out;
  }

  noteOff(note: number): VoiceCommand[] {
    const out: VoiceCommand[] = [];
    for (const v of [...this.#voices.values()]) {
      if (v.mono || v.note !== note || v.state !== 'held') continue;
      this.#letGo(v, out);
    }
    for (const layer of this.#mono.values()) this.#monoOff(note, layer, out);
    return out;
  }

  sustain(on: boolean): VoiceCommand[] {
    this.#pedal = on;
    const out: VoiceCommand[] = [];
    if (on) return out;
    for (const v of [...this.#voices.values()]) {
      if (v.state !== 'sustained') continue;
      v.state = 'releasing';
      out.push({ type: 'release', id: v.id });
    }
    return out;
  }

  /** Panic and hide: kills every voice, clears held and sustained notes and the pedal. */
  allNotesOff(): VoiceCommand[] {
    const out: VoiceCommand[] = [...this.#voices.keys()].map((id) => ({ type: 'kill', id }) as const);
    this.#voices.clear();
    this.#mono.clear();
    this.#pedal = false;
    return out;
  }

  /** The engine reports that a voice has fallen silent (release tail done, or a zero-sustain envelope). */
  voiceEnded(id: number): void {
    const v = this.#voices.get(id);
    if (v === undefined) return;
    this.#voices.delete(id);
    if (v.mono) {
      const layer = this.#mono.get(v.layer);
      if (layer !== undefined && layer.voiceId === id) layer.voiceId = null;
    }
  }

  /** Held + sustained + releasing voices. */
  get activeCount(): number {
    return this.#voices.size;
  }

  get sustainOn(): boolean {
    return this.#pedal;
  }

  /** Snapshot for tests and diagnostics. */
  voices(): ReadonlyArray<Readonly<{ id: number; layer: SynthLayer; note: number; state: VoiceState }>> {
    return [...this.#voices.values()].map(({ id, layer, note, state }) => ({ id, layer, note, state }));
  }

  #polyOn(note: number, velocity: number, voicing: LayerVoicing, out: VoiceCommand[]): void {
    // A key struck again while its voice is held or sustained: release that voice, start a fresh one.
    for (const v of this.#voices.values()) {
      if (!v.mono && v.layer === voicing.layer && v.note === note && v.state !== 'releasing') {
        v.state = 'releasing';
        out.push({ type: 'release', id: v.id });
      }
    }
    this.#start(note, velocity, voicing, false, out);
  }

  #monoOn(note: number, velocity: number, voicing: LayerVoicing, out: VoiceCommand[]): void {
    let layer = this.#mono.get(voicing.layer);
    if (layer === undefined) {
      layer = { voicing, stack: [], voiceId: null };
      this.#mono.set(voicing.layer, layer);
    }
    layer.voicing = voicing;
    const keyWasDown = layer.stack.length > 0;
    layer.stack = layer.stack.filter((k) => k.note !== note);
    layer.stack.push({ note, velocity });
    const target = pick(layer.stack, voicing.priority)!;
    const voice = layer.voiceId === null ? undefined : this.#voices.get(layer.voiceId);
    if (voice === undefined) {
      layer.voiceId = this.#start(target.note, target.velocity, voicing, true, out);
      return;
    }
    const wasSounding = voice.state === 'held';
    voice.state = 'held';
    voice.sustain = voicing.sustain;
    if (voice.note === target.note && wasSounding) return; // priority keeps the current note
    voice.note = target.note;
    out.push({ type: 'retarget', id: voice.id, note: target.note, retrigger: voicing.mode === 'mono' || !keyWasDown || !wasSounding });
  }

  #monoOff(note: number, layer: MonoLayer, out: VoiceCommand[]): void {
    const before = layer.stack.length;
    layer.stack = layer.stack.filter((k) => k.note !== note);
    if (layer.stack.length === before) return;
    const voice = layer.voiceId === null ? undefined : this.#voices.get(layer.voiceId);
    if (voice === undefined || voice.state !== 'held') return;
    if (layer.stack.length > 0) {
      const target = pick(layer.stack, layer.voicing.priority)!;
      if (target.note === voice.note) return;
      voice.note = target.note;
      out.push({ type: 'retarget', id: voice.id, note: target.note, retrigger: layer.voicing.mode === 'mono' });
      return;
    }
    this.#letGo(voice, out);
  }

  /** The key of a held voice comes up: sustained while the pedal holds it, else released. */
  #letGo(v: Voice, out: VoiceCommand[]): void {
    if (this.#pedal && v.sustain) {
      v.state = 'sustained';
      return;
    }
    v.state = 'releasing';
    out.push({ type: 'release', id: v.id });
  }

  #start(note: number, velocity: number, voicing: LayerVoicing, mono: boolean, out: VoiceCommand[]): number {
    while (this.#voices.size >= this.#max) this.#steal(out);
    const id = this.#nextId++;
    this.#voices.set(id, { id, layer: voicing.layer, note, state: 'held', sustain: voicing.sustain, order: this.#order++, mono });
    out.push({ type: 'start', id, layer: voicing.layer, note, velocity });
    return id;
  }

  #steal(out: VoiceCommand[]): void {
    let victim: Voice | undefined;
    for (const state of STEAL_ORDER) {
      for (const v of this.#voices.values()) {
        if (v.state === state && (victim === undefined || v.order < victim.order)) victim = v;
      }
      if (victim !== undefined) break;
    }
    if (victim === undefined) return;
    out.push({ type: 'kill', id: victim.id });
    this.voiceEnded(victim.id);
  }
}

function pick(stack: ReadonlyArray<{ note: number; velocity: number }>, priority: LayerVoicing['priority']):
  { note: number; velocity: number } | undefined {
  if (stack.length === 0) return undefined;
  if (priority === 'none') return stack.at(-1);
  let best = stack[0]!;
  for (const k of stack) {
    if (priority === 'low' ? k.note < best.note : k.note > best.note) best = k;
  }
  return best;
}
