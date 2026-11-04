/**
 * MIDI output: the contract (plan sections 15.5 and 15.6). The editor sends MIDI only while the user
 * has switched it on, never SysEx (requestMIDIAccess({ sysex: false }) in midi/access.ts), and only
 * to the one output port the user picked. Three switches, all off on every page load and never
 * stored, gate everything:
 *
 * - `sendControls` ("send to stage 4"): control changes the user makes in the editor go out as
 *   the documented CC or NRPN (midi/cc-map.ts) on the global channel, after the focus controller
 *   the Stage 4 needs; the "send all" key works only while this is on.
 * - `sendNotes`: notes, pitch bend, sustain and the wheel, pressure and pedal from the virtual and
 *   computer keyboards (and the on-screen controllers) go out on the global channel.
 * - `extern`: synth layers in extern mode play the extern channels (manual p.46–47, 63).
 *
 * MIDI input never echoes: changes with origin 'midi' or 'morph', loads and inits are not sent as
 * controls; notes that came in over MIDI reach the extern channels only with `echoToExtern` on
 * (p.63 "Echo Global To Extern Ch", default off). This file holds types and the pure gate; the
 * sending code is midi/send.ts and midi/extern.ts (builder B4).
 */
import type { NoteSource } from '../input/events.ts';
import type { SynthLayer } from '../model/keys.ts';
import type { Origin } from '../model/store.ts';

/** The slice of a Web MIDI output port the editor uses (structural, so tests fake it). */
export interface MidiOutputLike {
  readonly id: string;
  readonly name: string | null;
  readonly state: string;
  /** Data is one complete message; timestamp in DOMHighResTimeStamp ms (performance.now() clock). */
  send(data: readonly number[] | Uint8Array, timestamp?: number): void;
}

/** A port as the picker lists it. */
export interface MidiOutPort {
  readonly id: string;
  /** The port's name, or 'unnamed output'. */
  readonly name: string;
}

/** User settings: the switches (never stored) and the channels and port (stored on this device). */
export interface MidiOutSettings {
  /** The picked output port id; null: none picked (nothing is sent). */
  readonly portId: string | null;
  /** The Stage 4's global channel, 1..16 (p.61: default 1). Controls and played notes go here. */
  readonly channel: number;
  /** The channels of extern layers A, B, C, 1..16 (p.62: defaults 13, 14, 15; on the Stage 4 a global setting). */
  readonly externChannels: Readonly<Record<SynthLayer, number>>;
  /** "send to stage 4": control changes go out. Off at every page load. */
  readonly sendControls: boolean;
  /** Notes and performance controls from the editor's keyboards go out. Off at every page load. */
  readonly sendNotes: boolean;
  /** Extern layers play the extern channels. Off at every page load. */
  readonly extern: boolean;
  /** Notes that came in over MIDI also go out on the extern channels (p.63, default off). */
  readonly echoToExtern: boolean;
}

export const DEFAULT_MIDI_OUT: MidiOutSettings = {
  portId: null,
  channel: 1,
  externChannels: { A: 13, B: 14, C: 15 },
  sendControls: false,
  sendNotes: false,
  extern: false,
  echoToExtern: false,
};

/** The fields of MidiOutSettings that may be stored on this device (formats/settings.ts); the switches never are. */
export const STORED_MIDI_OUT_FIELDS = ['portId', 'channel', 'externChannels'] as const;

/** What a message is for, as the gate sees it. */
export type SendKind =
  | { readonly kind: 'control'; readonly origin: Origin }
  | { readonly kind: 'sendAll' }
  | { readonly kind: 'note'; readonly source: NoteSource }
  | { readonly kind: 'performance'; readonly source: NoteSource | 'screen' }
  | { readonly kind: 'extern'; readonly source: NoteSource | 'program' };

/**
 * The one rule every sender asks before it sends (pure): a port is picked, the matching switch is
 * on, and the message does not echo MIDI input.
 */
export function mayEmit(s: MidiOutSettings, what: SendKind): boolean {
  if (s.portId === null) return false;
  switch (what.kind) {
    case 'control':
      return s.sendControls && (what.origin === 'ui' || what.origin === 'derived');
    case 'sendAll':
      return s.sendControls;
    case 'note':
      return s.sendNotes && what.source !== 'midi';
    case 'performance':
      return s.sendNotes && what.source !== 'midi';
    case 'extern':
      return s.extern && (what.source !== 'midi' || s.echoToExtern);
  }
}

/** A 1..16 channel as the 0..15 nibble of a status byte; out-of-range values fall back to channel 1. */
export function channelNibble(channel: number): number {
  return Number.isInteger(channel) && channel >= 1 && channel <= 16 ? channel - 1 : 0;
}

export type MidiOutStatus =
  | { readonly kind: 'no-access' }
  | { readonly kind: 'no-outputs' }
  | { readonly kind: 'ready'; readonly ports: readonly MidiOutPort[] }
  | { readonly kind: 'port-gone'; readonly name: string };

/** What midi/send.ts exports as its output class (builder B4); main and the MIDI panel use only this. */
export interface MidiOutApi {
  readonly settings: MidiOutSettings;
  readonly status: MidiOutStatus;
  /** Change settings (a switch, the port, a channel); switching a sender off sends nothing more. */
  update(patch: Partial<MidiOutSettings>): void;
  /** Send every documented controller of the current program (only with sendControls on); resolves with the count sent. */
  sendAll(): Promise<number>;
  onStatus(fn: (s: MidiOutStatus) => void): () => void;
  onSettings(fn: (s: MidiOutSettings) => void): () => void;
  /** All notes off on every channel the editor sent notes on (CC123), then stop. */
  panic(): void;
}
