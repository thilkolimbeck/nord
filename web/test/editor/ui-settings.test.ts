/**
 * Settings on this device and the MIDI panel's logic (plan sections 15.4–15.6), without the DOM:
 * port and channels and control in are kept, the senders never; the port picker says why it is
 * empty; send all needs send to stage 4 and a port.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_SETTINGS, parseSettings, readSettings, SETTINGS_KEY, storedMidiOut, writeSettings,
} from '../../src/editor/formats/settings.ts';
import type { StorageLike } from '../../src/editor/formats/storage.ts';
import { DEFAULT_MIDI_OUT, type MidiOutSettings } from '../../src/editor/midi/output.ts';
import {
  CHANNELS, CONTROL_IN_CHANNELS, MIDI_SWITCHES, portView, sendAllAvailable, sendAllText,
} from '../../src/editor/ui/midi-model.ts';

class FakeStorage implements StorageLike {
  readonly data = new Map<string, string>();
  fail: Error | null = null;
  getItem(key: string): string | null {
    if (this.fail !== null) throw this.fail;
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    if (this.fail !== null) throw this.fail;
    this.data.set(key, value);
  }
  removeItem(key: string): void {
    this.data.delete(key);
  }
}

test('defaults: no port, channel 1, extern 13/14/15, control in off on every channel', () => {
  assert.deepEqual(readSettings(null), DEFAULT_SETTINGS);
  assert.deepEqual(DEFAULT_SETTINGS.midiOut, { portId: null, channel: 1, externChannels: { A: 13, B: 14, C: 15 } });
  assert.deepEqual(DEFAULT_SETTINGS.controlIn, { enabled: false, channel: 'all' });
});

test('port, channels and control in round-trip; the senders are never stored', () => {
  const storage = new FakeStorage();
  const out: MidiOutSettings = {
    ...DEFAULT_MIDI_OUT, portId: 'out-7', channel: 3, externChannels: { A: 9, B: 10, C: 11 },
    sendControls: true, sendNotes: true, extern: true, echoToExtern: true,
  };
  assert.equal(writeSettings(storage, { midiOut: storedMidiOut(out), controlIn: { enabled: true, channel: 5 } }), null);
  const json = JSON.parse(storage.data.get(SETTINGS_KEY)!) as { midiOut: Record<string, unknown> };
  assert.deepEqual(Object.keys(json.midiOut).sort(), ['channel', 'externChannels', 'portId']);
  assert.deepEqual(readSettings(storage), {
    midiOut: { portId: 'out-7', channel: 3, externChannels: { A: 9, B: 10, C: 11 } },
    controlIn: { enabled: true, channel: 5 },
  });
});

test('bad or partial stored settings fall back field by field; storage errors change nothing', () => {
  assert.deepEqual(parseSettings('not json'), DEFAULT_SETTINGS);
  assert.deepEqual(parseSettings('[]'), DEFAULT_SETTINGS);
  const partial = parseSettings(JSON.stringify({ midiOut: { channel: 99, portId: '', externChannels: { B: 2 } },
    controlIn: { enabled: 'yes', channel: 0 } }));
  assert.deepEqual(partial, {
    midiOut: { portId: null, channel: 1, externChannels: { A: 13, B: 2, C: 15 } },
    controlIn: { enabled: false, channel: 'all' },
  });
  const storage = new FakeStorage();
  storage.fail = Object.assign(new Error('full'), { name: 'QuotaExceededError' });
  assert.equal(writeSettings(storage, DEFAULT_SETTINGS), 'full');
  assert.deepEqual(readSettings(storage), DEFAULT_SETTINGS);
  assert.equal(writeSettings(null, DEFAULT_SETTINGS), 'unavailable');
});

test('the port picker says why it is empty, and keeps a gone port listed', () => {
  const s = DEFAULT_MIDI_OUT;
  assert.equal(portView({ kind: 'no-access' }, s, { kind: 'unsupported' }).note, 'not supported in this browser');
  assert.equal(portView({ kind: 'no-access' }, s, { kind: 'off' }).note, 'enable midi first (status strip above)');
  assert.ok(portView({ kind: 'no-access' }, s, { kind: 'off' }).disabled);
  assert.equal(portView({ kind: 'no-outputs' }, s, { kind: 'no-inputs' }).note, 'no outputs');
  const ready = portView({ kind: 'ready', ports: [{ id: 'p1', name: 'Stage 4' }, { id: 'p2', name: 'IAC' }] },
    { ...s, portId: 'p2' }, { kind: 'connected', inputs: ['Stage 4'] });
  assert.deepEqual([ready.disabled, ready.value, ready.note, ready.options.map((o) => o.label)],
    [false, 'p2', null, ['no output', 'Stage 4', 'IAC']]);
  const unknown = portView({ kind: 'ready', ports: [{ id: 'p1', name: 'Stage 4' }] }, { ...s, portId: 'zz' }, { kind: 'off' });
  assert.equal(unknown.value, '');
  const gone = portView({ kind: 'port-gone', name: 'Stage 4' }, { ...s, portId: 'p1' }, { kind: 'connected', inputs: [] });
  assert.equal(gone.value, 'p1');
  assert.ok(/disconnected: sending stops until it returns/.test(gone.note!), gone.note!);
});

test('switches, channels and send all', () => {
  assert.deepEqual(MIDI_SWITCHES.map((x) => x.label), ['send to stage 4', 'send notes', 'extern out', 'echo midi in']);
  for (const x of MIDI_SWITCHES) assert.ok(/off at every page load/.test(x.note), x.note);
  assert.equal(CHANNELS.length, 16);
  assert.deepEqual(CONTROL_IN_CHANNELS[0], { value: 'all', label: 'every ch' });
  const ready = { kind: 'ready', ports: [{ id: 'p', name: 'x' }] } as const;
  assert.ok(!sendAllAvailable({ ...DEFAULT_MIDI_OUT, portId: 'p' }, ready), 'send to stage 4 off');
  assert.ok(!sendAllAvailable({ ...DEFAULT_MIDI_OUT, sendControls: true }, ready), 'no port');
  assert.ok(sendAllAvailable({ ...DEFAULT_MIDI_OUT, portId: 'p', sendControls: true }, ready));
  assert.ok(!sendAllAvailable({ ...DEFAULT_MIDI_OUT, portId: 'p', sendControls: true }, { kind: 'port-gone', name: 'x' }));
  assert.ok(/^sent 42 controllers; the stage 4 receives no split, zone, morph, arp pattern, extern or sample/.test(sendAllText(42)), sendAllText(42));
});
