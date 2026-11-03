/**
 * MIDI input parsing (plan section 1, AC 7). Pure: turns one complete MIDI message (as Web MIDI
 * delivers it) into a channel event, and a channel event into play events for the bus. Omni: every
 * channel plays. System messages (0xF0–0xFF, SysEx included), polyphonic aftertouch and program
 * change are ignored. Nothing is ever sent back.
 */
import type { PlayEvent } from '../input/events.ts';

export type MidiEvent =
  | { type: 'noteOn'; channel: number; note: number; velocity: number }
  | { type: 'noteOff'; channel: number; note: number }
  | { type: 'cc'; channel: number; controller: number; value: number }
  | { type: 'bend'; channel: number; value: number } // -8192..8191, 0 = centre
  | { type: 'pressure'; channel: number; value: number };

export const CC_MOD_WHEEL = 1;
export const CC_EXPRESSION = 11;
export const CC_SUSTAIN = 64;
export const CC_ALL_SOUND_OFF = 120;
export const CC_ALL_NOTES_OFF = 123;

function isData(b: number | undefined): b is number {
  return b !== undefined && b >= 0 && b < 0x80;
}

/** One message → a channel event; null for system, SysEx, unused or malformed messages. */
export function parseMidiMessage(data: Uint8Array): MidiEvent | null {
  const status = data[0];
  if (status === undefined || status < 0x80 || status >= 0xf0) return null;
  const channel = status & 0x0f;
  const a = data[1];
  const b = data[2];
  switch (status & 0xf0) {
    case 0x80:
      return isData(a) && isData(b) ? { type: 'noteOff', channel, note: a } : null;
    case 0x90:
      if (!isData(a) || !isData(b)) return null;
      return b === 0 ? { type: 'noteOff', channel, note: a } : { type: 'noteOn', channel, note: a, velocity: b };
    case 0xb0:
      return isData(a) && isData(b) ? { type: 'cc', channel, controller: a, value: b } : null;
    case 0xd0:
      return isData(a) ? { type: 'pressure', channel, value: a } : null;
    case 0xe0:
      return isData(a) && isData(b) ? { type: 'bend', channel, value: ((b << 7) | a) - 8192 } : null;
    default:
      // 0xA0 polyphonic aftertouch, 0xC0 program change: not used by the MVP.
      return null;
  }
}

/** A channel event → play events: notes, CC64 sustain, CC1 wheel, CC11 pedal, pressure, bend, CC120/123 panic. */
export function toPlayEvents(e: MidiEvent): PlayEvent[] {
  switch (e.type) {
    case 'noteOn':
      return [{ type: 'noteOn', note: e.note, velocity: e.velocity, source: 'midi' }];
    case 'noteOff':
      return [{ type: 'noteOff', note: e.note, source: 'midi' }];
    case 'bend':
      return [{ type: 'bend', value: e.value }];
    case 'pressure':
      return [{ type: 'controller', kind: 'pressure', value: e.value }];
    case 'cc':
      switch (e.controller) {
        case CC_SUSTAIN:
          return [{ type: 'sustain', on: e.value >= 64 }];
        case CC_MOD_WHEEL:
          return [{ type: 'controller', kind: 'wheel', value: e.value }];
        case CC_EXPRESSION:
          return [{ type: 'controller', kind: 'pedal', value: e.value }];
        case CC_ALL_SOUND_OFF:
        case CC_ALL_NOTES_OFF:
          return [{ type: 'panic' }];
        default:
          return [];
      }
  }
}
