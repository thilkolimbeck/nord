/**
 * Editor settings kept on this device (plan sections 15.4 and 15.5), apart from programs and
 * presets: the MIDI output port, the Stage 4's global channel and the extern channels, and MIDI
 * control in (on/off and its channel). The MIDI output switches (send to stage 4, send notes,
 * extern out, echo) are never stored: they are off at every page load (midi/output.ts). One
 * JSON entry in browser storage:
 *
 *     ns4-editor:v1:settings   { "midiOut": { portId, channel, externChannels }, "controlIn": { enabled, channel } }
 *
 * Storage may be missing, blocked or full: reading falls back to the defaults, writing reports
 * the problem and changes nothing else. The caller passes the Storage object (or null), so this
 * module stays free of browser globals.
 */
import type { SynthLayer } from '../model/keys.ts';
import { type ControlInSettings, DEFAULT_CONTROL_IN } from '../midi/cc-in.ts';
import { DEFAULT_MIDI_OUT, type MidiOutSettings, STORED_MIDI_OUT_FIELDS } from '../midi/output.ts';
import { PREFIX, problemOf, type StorageLike, type StorageProblem } from './storage.ts';

export const SETTINGS_KEY = `${PREFIX}settings`;

/** The MIDI output settings that are stored: port and channels, never the switches. */
export type StoredMidiOut = Pick<MidiOutSettings, (typeof STORED_MIDI_OUT_FIELDS)[number]>;

export interface DeviceSettings {
  readonly midiOut: StoredMidiOut;
  readonly controlIn: ControlInSettings;
}

export const DEFAULT_SETTINGS: DeviceSettings = {
  midiOut: { portId: DEFAULT_MIDI_OUT.portId, channel: DEFAULT_MIDI_OUT.channel, externChannels: DEFAULT_MIDI_OUT.externChannels },
  controlIn: DEFAULT_CONTROL_IN,
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function channelOr(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 16 ? v : fallback;
}

/** The stored part of the output settings (the switches dropped). */
export function storedMidiOut(s: MidiOutSettings): StoredMidiOut {
  return { portId: s.portId, channel: s.channel, externChannels: { ...s.externChannels } };
}

/** Settings from their JSON text; anything missing or invalid takes its default. */
export function parseSettings(text: string | null): DeviceSettings {
  if (text === null) return DEFAULT_SETTINGS;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return DEFAULT_SETTINGS;
  }
  if (!isRecord(raw)) return DEFAULT_SETTINGS;
  const out = isRecord(raw['midiOut']) ? raw['midiOut'] : {};
  const ext = isRecord(out['externChannels']) ? out['externChannels'] : {};
  const d = DEFAULT_SETTINGS.midiOut;
  const externChannels = Object.fromEntries((['A', 'B', 'C'] as const).map(
    (l: SynthLayer) => [l, channelOr(ext[l], d.externChannels[l])])) as Record<SynthLayer, number>;
  const portId = typeof out['portId'] === 'string' && out['portId'] !== '' ? out['portId'] : null;
  const inRaw = isRecord(raw['controlIn']) ? raw['controlIn'] : {};
  const ch = inRaw['channel'];
  return {
    midiOut: { portId, channel: channelOr(out['channel'], d.channel), externChannels },
    controlIn: {
      enabled: inRaw['enabled'] === true,
      channel: ch === 'all' ? 'all' : channelOr(ch, Number.NaN) || DEFAULT_CONTROL_IN.channel,
    },
  };
}

/** The settings on this device, or the defaults when there are none or storage refuses. */
export function readSettings(storage: StorageLike | null): DeviceSettings {
  if (storage === null) return DEFAULT_SETTINGS;
  try {
    return parseSettings(storage.getItem(SETTINGS_KEY));
  } catch {
    return DEFAULT_SETTINGS;
  }
}

/** Keep the settings; returns the problem instead of throwing, null on success. */
export function writeSettings(storage: StorageLike | null, s: DeviceSettings): StorageProblem | null {
  if (storage === null) return 'unavailable';
  const json = JSON.stringify({ midiOut: s.midiOut, controlIn: { enabled: s.controlIn.enabled, channel: s.controlIn.channel } });
  try {
    storage.setItem(SETTINGS_KEY, json);
    return null;
  } catch (err) {
    return problemOf(err);
  }
}
