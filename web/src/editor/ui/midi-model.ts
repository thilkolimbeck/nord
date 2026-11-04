/**
 * What the MIDI part of the extern · midi region shows, without the DOM (plan sections 15.4–15.6):
 * the output port picker (or why there is none), the channel lists, which keys are available and
 * the result line of "send all". midi-panel.ts renders these; the tests check them in Node.
 */
import type { MidiStatus } from '../midi/access.ts';
import type { MidiOutSettings, MidiOutStatus } from '../midi/output.ts';

export const MIDI_PANEL_LEGEND = 'extern · midi';
/** What the Stage 4 needs to receive controllers (M p.62). */
export const STAGE4_MIDI_LINE = 'the stage 4\'s midi menu needs ctrl receive and cc & nrpn (p.62)';
export const NEVER_SENT = 'nothing is sent until you switch a sender on; never sysex';
export const NO_PORT_PICKED = 'no output';

export interface Choice {
  readonly value: string;
  readonly label: string;
}

/** The port select: its options, whether it is usable, and why not. */
export interface PortView {
  readonly disabled: boolean;
  readonly options: readonly Choice[];
  /** The selected value ('' = none picked). */
  readonly value: string;
  /** Why the picker is empty or what happened to the picked port; null when ready. */
  readonly note: string | null;
}

/**
 * The port picker. Without Web MIDI (Safari) it says so; before `enable midi` it asks for that;
 * without outputs it says so; a picked port that went away stays listed as gone until it returns.
 */
export function portView(out: MidiOutStatus, settings: MidiOutSettings, input: MidiStatus): PortView {
  const none: Choice = { value: '', label: NO_PORT_PICKED };
  if (input.kind === 'unsupported') return { disabled: true, options: [none], value: '', note: 'not supported in this browser' };
  if (input.kind === 'denied') return { disabled: true, options: [none], value: '', note: 'midi permission denied' };
  switch (out.kind) {
    case 'no-access':
      return { disabled: true, options: [none], value: '', note: 'enable midi first (status strip above)' };
    case 'no-outputs':
      return { disabled: true, options: [none], value: '', note: 'no outputs' };
    case 'port-gone':
      return {
        disabled: false, options: [none, { value: settings.portId ?? '', label: `${out.name} (disconnected)` }],
        value: settings.portId ?? '', note: `${out.name} is disconnected: sending stops until it returns`,
      };
    case 'ready': {
      const options = [none, ...out.ports.map((p) => ({ value: p.id, label: p.name }))];
      const value = settings.portId !== null && out.ports.some((p) => p.id === settings.portId) ? settings.portId : '';
      return { disabled: false, options, value, note: null };
    }
  }
}

/** Channels 1–16 for a select. */
export const CHANNELS: readonly Choice[] = Array.from({ length: 16 }, (_, i) => ({ value: String(i + 1), label: `ch ${i + 1}` }));
/** The control-in channel: every channel, or one. */
export const CONTROL_IN_CHANNELS: readonly Choice[] = [{ value: 'all', label: 'every ch' }, ...CHANNELS];

/** The switches of the MIDI group, in panel order: label, settings field, description. */
export const MIDI_SWITCHES: ReadonlyArray<{
  readonly field: 'sendControls' | 'sendNotes' | 'extern' | 'echoToExtern';
  readonly label: string;
  readonly note: string;
}> = [
  { field: 'sendControls', label: 'send to stage 4',
    note: 'your edits go out as the documented cc or nrpn (manual appendix ii) on the global channel; off at every page load' },
  { field: 'sendNotes', label: 'send notes',
    note: 'notes, bend, sustain, wheel, pressure and pedal from the on-screen and computer keyboards go out on the global '
      + 'channel; off at every page load' },
  { field: 'extern', label: 'extern out',
    note: 'synth layers in extern mode play their extern channel (manual p.46–47, 63); off at every page load' },
  { field: 'echoToExtern', label: 'echo midi in',
    note: 'notes from midi input also reach the extern channels (manual p.63, echo global to extern); off at every page load' },
];

/** Whether `send all` can run: send to stage 4 on and a port picked. */
export function sendAllAvailable(s: MidiOutSettings, out: MidiOutStatus): boolean {
  return s.sendControls && s.portId !== null && out.kind === 'ready';
}

/** The print-out line after send all (plan 15.5). */
export function sendAllText(count: number): string {
  return `sent ${count} controllers; the stage 4 receives no split, zone, morph, arp pattern, extern or sample setting `
    + 'over midi: use the .ns4p export for those';
}
