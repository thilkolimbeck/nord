/**
 * Extern layers (plan section 15.6, manual p.46–47, 63): a synth layer in extern mode plays the
 * layer's extern MIDI channel instead of sounding: its notes within its zones, its program change
 * and bank select, its two CC values, CC7 from its level, the pitch stick, sustain and the
 * controllers it allows. It hears the router's synth events through audio/tee.ts; it sends only
 * through MidiOut while the user has switched extern out on (midi/output.ts mayEmit kind 'extern').
 *
 * - Notes (p.46 "KEYBOARD ZONES", "OCTAVE SHIFT"; p.55 transpose): the router's hits on extern
 *   layers, the routed note (key + program transpose) + 12 × the layer's octave shift, dropped
 *   outside 0..127; velocity through the layer's curve (p.63 soft/mid/hard; γ 0.7, 1, 1.4,
 *   assumed) times the hit's crossfade gain (assumed). Notes from MIDI input go out only with
 *   "echo midi in" on (p.47, 63). The note off goes to every channel its note on went to.
 * - Performance (p.46 "PITCH STICK AND SUSTAIN PEDAL MESSAGES", p.63 "DEVICE MIDI"): sustain when
 *   the layer's sustainEnable is on, pitch bend when its pStickEnable is on, the wheel (CC1),
 *   pressure (channel pressure) and control pedal (CC11) by the three device enables. They arrive
 *   from MidiOut.play with their source (the play bus carries none for them); the tee's copies of
 *   these events are ignored.
 * - Program data (p.47, 63): a change of the program or a bank select value sends bank select MSB
 *   and LSB (when not "--") and the program change; a CC number or value change sends that CC; a
 *   level change sends CC7 (p.47 "VOLUME"). On a load, layers with Send On Load on send bank
 *   select, program change, CC7 and both CCs (p.63 item 13), when they are extern and on in the
 *   active scene. Changes that came in over MIDI are not sent; morph changes are (the CC values
 *   are morphable, M p.39: the effective value goes out as a morph moves).
 *
 * Encodings (assumed, plan 15.6, nv): CC numbers raw 0 = off, raw n = CC n − 1 (the manual's
 * range 0–119, default 2, against the layout's 0..120, default 3); bank select raw 0 = "--",
 * raw n = n − 1.
 *
 * Not modelled: the arpeggiator driving an extern layer (p.47), the swell and volume pedal enables
 * (the editor has no such pedals), "Off" and "Thru" extern channels.
 */
import type { NoteSource, PlayEvent } from '../input/events.ts';
import type { Ns4Key, SynthLayer } from '../model/keys.ts';
import type { ValueReader } from '../model/labels.ts';
import { enabledLayers } from '../model/scene.ts';
import type { Change } from '../model/store.ts';
import { ccMessage } from './cc-map.ts';
import { channelNibble, type SendKind } from './output.ts';
import { bendMessage, CONTROLLER_CC, type MidiOut, noteOffMessage, noteOnMessage, type PlaySource, pressureMessage } from './send.ts';

/** The synth section's routed events (structurally audio/section.ts SectionEvent<SynthLayer>). */
export type ExternEvent =
  | {
    readonly type: 'noteOn'; readonly key: number; readonly note: number; readonly velocity: number;
    readonly layers: readonly { readonly layer: SynthLayer; readonly gain: number }[]; readonly source?: NoteSource;
  }
  | { readonly type: 'noteOff'; readonly key: number; readonly note: number }
  | { readonly type: 'sustain'; readonly on: boolean }
  | { readonly type: 'bend'; readonly value: number }
  | { readonly type: 'controller'; readonly kind: 'wheel' | 'pressure' | 'pedal'; readonly value: number };

/** The velocity curve exponents by externVelCurve value: soft, mid, hard (p.63; values assumed). */
export const EXTERN_VEL_GAMMA: readonly number[] = [0.7, 1, 1.4];

const CC_BANK_MSB = 0;
const CC_BANK_LSB = 32;
const CC_VOLUME = 7;
const CC_SUSTAIN = 64;

/** A synth layer field: ('A', 'externPCValue') → 'synthA.externPCValue'. */
export function externKey(layer: SynthLayer, field: string): Ns4Key {
  return `synth${layer}.${field}` as Ns4Key;
}

/** The layer level field (CC7 of an extern layer, p.47). */
export function levelKey(layer: SynthLayer): Ns4Key {
  return `synth.layerLevelSyn${layer}` as Ns4Key;
}

/** A sent velocity: 127 × (v/127)^γ × gain, rounded, 1..127. */
export function externVelocity(velocity: number, curve: number, gain = 1): number {
  const gamma = EXTERN_VEL_GAMMA[curve] ?? 1;
  const v = Math.min(127, Math.max(1, velocity)) / 127;
  const g = Number.isFinite(gain) ? Math.min(1, Math.max(0, gain)) : 1;
  return Math.min(127, Math.max(1, Math.round(127 * v ** gamma * g)));
}

/** The CC number a raw externCCNumber value names: raw 0 = off (null), raw n = CC n − 1 (assumed). */
export function externCcNumber(raw: number): number | null {
  return Number.isInteger(raw) && raw >= 1 && raw <= 120 ? raw - 1 : null;
}

/** A bank select value: raw 0 = "--" (not sent, null), raw n = n − 1 (assumed). */
export function externBankValue(raw: number): number | null {
  return Number.isInteger(raw) && raw >= 1 && raw <= 128 ? raw - 1 : null;
}

/** Program data a field change sends, by the field name after `synth{L}.`. */
type ProgramPart = 'program' | 'cc1' | 'cc2' | 'level' | 'enable';
const PART_OF_FIELD: Readonly<Record<string, ProgramPart>> = {
  externPCValue: 'program', externBCValue_MSB: 'program', externBCValue_LSB: 'program',
  externCCNumber1: 'cc1', externCCValue1: 'cc1', externCCNumber2: 'cc2', externCCValue2: 'cc2',
  externEnable: 'enable',
};

/** Which layer and part a changed key belongs to; null for keys extern ignores. */
export function externPart(key: Ns4Key): { readonly layer: SynthLayer; readonly part: ProgramPart } | null {
  const level = /^synth\.layerLevelSyn([ABC])$/.exec(key);
  if (level !== null) return { layer: level[1] as SynthLayer, part: 'level' };
  const m = /^synth([ABC])\.([A-Za-z0-9_]+)$/.exec(key);
  if (m === null) return null;
  const part = PART_OF_FIELD[m[2]!];
  return part === undefined ? null : { layer: m[1] as SynthLayer, part };
}

interface Sent {
  readonly layer: SynthLayer;
  readonly channel: number;
  readonly note: number;
}

export class ExternOut {
  readonly #values: ValueReader;
  readonly #out: MidiOut;
  /** Routed note → the extern notes its note on sent. */
  readonly #held = new Map<number, Sent[]>();
  /** Channels sustain is on for (to end it on panic and on sustain off). */
  readonly #sustained = new Set<number>();
  readonly #unsubscribe: () => void;

  /** `values`: the morphed values (an extern CC value follows its morphs, M p.39). */
  constructor(values: ValueReader, out: MidiOut) {
    this.#values = values;
    this.#out = out;
    this.#unsubscribe = out.onPerformance((e, from) => this.#performance(e, from));
  }

  /** The tee's synth events: notes. Sustain, bend and controllers come from MidiOut.play with their source. */
  handle(e: ExternEvent): void {
    if (e.type === 'noteOn') this.#noteOn(e);
    else if (e.type === 'noteOff') this.#noteOff(e.note);
  }

  applyChanges(batch: readonly Change[]): void {
    if (batch.some((c) => c.origin === 'load' || c.origin === 'init')) {
      this.panic();
      this.#sendOnLoad();
      return;
    }
    const due = new Map<string, { layer: SynthLayer; part: ProgramPart }>();
    for (const c of batch) {
      if (c.origin === 'midi') continue; // never echo what came in over MIDI
      const p = externPart(c.key);
      if (p === null) continue;
      if (p.part === 'enable') {
        if (c.value === 0) this.#releaseLayer(p.layer);
        continue;
      }
      due.set(`${p.layer}:${p.part}`, p);
    }
    for (const { layer, part } of due.values()) {
      if (!this.#isExtern(layer)) continue;
      if (part === 'program') this.#sendProgram(layer);
      else if (part === 'level') this.#sendLevel(layer);
      else this.#sendCc(layer, part === 'cc1' ? 1 : 2);
    }
  }

  /** Note offs for every note an extern channel holds, and sustain off where it was on. */
  panic(): void {
    for (const sent of this.#held.values()) for (const s of sent) this.#emit(noteOffMessage(s.channel, s.note));
    this.#held.clear();
    for (const ch of [...this.#sustained].sort((a, b) => a - b)) this.#emit(ccMessage(ch, CC_SUSTAIN, 0));
    this.#sustained.clear();
  }

  /** Stop listening to MidiOut's performance events. */
  dispose(): void {
    this.panic();
    this.#unsubscribe();
  }

  // --- internals -------------------------------------------------------------------------------

  #channel(layer: SynthLayer): number {
    return channelNibble(this.#out.settings.externChannels[layer]);
  }

  #isExtern(layer: SynthLayer): boolean {
    return this.#values.get(externKey(layer, 'externEnable')) !== 0;
  }

  /** Extern layers that are on in the active scene (section and layer switch). */
  #activeExtern(): SynthLayer[] {
    return enabledLayers(this.#values, 'synth').filter((l) => this.#isExtern(l));
  }

  #on(field: string, layer: SynthLayer): boolean {
    return this.#values.get(externKey(layer, field)) !== 0;
  }

  #emit(data: number[], what: SendKind = { kind: 'extern', source: 'program' }): boolean {
    return this.#out.send(data, what);
  }

  #noteOn(e: Extract<ExternEvent, { type: 'noteOn' }>): void {
    // The router always names the source; an event without one counts as MIDI input (sent only with echo).
    const what: SendKind = { kind: 'extern', source: e.source ?? 'midi' };
    const sent: Sent[] = [];
    for (const hit of e.layers) {
      if (!this.#isExtern(hit.layer)) continue;
      const note = e.note + 12 * this.#values.get(externKey(hit.layer, 'octaveShift'));
      if (!Number.isInteger(note) || note < 0 || note > 127) continue;
      const channel = this.#channel(hit.layer);
      const velocity = externVelocity(e.velocity, this.#values.get(externKey(hit.layer, 'externVelCurve')), hit.gain);
      if (this.#emit(noteOnMessage(channel, note, velocity), what)) sent.push({ layer: hit.layer, channel, note });
    }
    if (sent.length === 0) return;
    this.#held.set(e.note, [...(this.#held.get(e.note) ?? []), ...sent]);
  }

  #noteOff(note: number): void {
    const sent = this.#held.get(note);
    if (sent === undefined) return;
    this.#held.delete(note);
    // A note off for a note extern sent is never echo: it needs only extern out on.
    for (const s of sent) this.#emit(noteOffMessage(s.channel, s.note));
  }

  /** The layer stopped being extern: end its notes. */
  #releaseLayer(layer: SynthLayer): void {
    for (const [note, sent] of [...this.#held]) {
      const keep = sent.filter((s) => s.layer !== layer);
      for (const s of sent) if (s.layer === layer) this.#emit(noteOffMessage(s.channel, s.note));
      if (keep.length === 0) this.#held.delete(note);
      else this.#held.set(note, keep);
    }
  }

  #performance(e: PlayEvent, from: PlaySource): void {
    // The on-screen controllers are the editor's own, like the keys (the extern gate names no 'screen').
    const what: SendKind = { kind: 'extern', source: from === 'screen' ? 'pointer' : from };
    if (e.type === 'sustain' && !e.on) {
      // Sustain off reaches every channel sustain went on, whatever its source or the switches now (only extern out on).
      for (const ch of [...this.#sustained].sort((a, b) => a - b)) this.#emit(ccMessage(ch, CC_SUSTAIN, 0));
      this.#sustained.clear();
      return;
    }
    for (const layer of this.#activeExtern()) {
      const ch = this.#channel(layer);
      switch (e.type) {
        case 'sustain':
          if (this.#on('sustainEnable', layer) && this.#emit(ccMessage(ch, CC_SUSTAIN, 127), what)) this.#sustained.add(ch);
          break;
        case 'bend':
          if (this.#on('pStickEnable', layer)) this.#emit(bendMessage(ch, e.value), what);
          break;
        case 'controller':
          if (e.kind === 'wheel' && this.#on('externModWheelEnable', layer)) {
            this.#emit(ccMessage(ch, CONTROLLER_CC.wheel, e.value), what);
          } else if (e.kind === 'pressure' && this.#on('externAftertouchEnable', layer)) {
            this.#emit(pressureMessage(ch, e.value), what);
          } else if (e.kind === 'pedal' && this.#on('externCtrlPedalEnable', layer)) {
            this.#emit(ccMessage(ch, CONTROLLER_CC.pedal, e.value), what);
          }
          break;
        default:
          break;
      }
    }
  }

  /** Bank select MSB and LSB (when not "--"), then the program change. */
  #sendProgram(layer: SynthLayer): void {
    const ch = this.#channel(layer);
    const msb = externBankValue(this.#values.get(externKey(layer, 'externBCValue_MSB')));
    const lsb = externBankValue(this.#values.get(externKey(layer, 'externBCValue_LSB')));
    if (msb !== null) this.#emit(ccMessage(ch, CC_BANK_MSB, msb));
    if (lsb !== null) this.#emit(ccMessage(ch, CC_BANK_LSB, lsb));
    const pc = Math.min(127, Math.max(0, Math.round(this.#values.get(externKey(layer, 'externPCValue')))));
    this.#emit([0xc0 | ch, pc]);
  }

  #sendLevel(layer: SynthLayer): void {
    this.#emit(ccMessage(this.#channel(layer), CC_VOLUME, this.#values.get(levelKey(layer))));
  }

  #sendCc(layer: SynthLayer, n: 1 | 2): void {
    const cc = externCcNumber(this.#values.get(externKey(layer, `externCCNumber${n}`)));
    if (cc === null) return;
    this.#emit(ccMessage(this.#channel(layer), cc, this.#values.get(externKey(layer, `externCCValue${n}`))));
  }

  /** On a load: for every extern layer on in the active scene with Send On Load on (p.63 item 13). */
  #sendOnLoad(): void {
    for (const layer of this.#activeExtern()) {
      if (!this.#on('externSendOnLoad', layer)) continue;
      this.#sendProgram(layer);
      this.#sendLevel(layer);
      this.#sendCc(layer, 1);
      this.#sendCc(layer, 2);
    }
  }
}
