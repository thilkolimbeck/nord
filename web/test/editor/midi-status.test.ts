/** AC 7: MIDI status machine and texts, and MidiInput against a fake Web MIDI (inputs only, no SysEx). */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PlayBus, type PlayEvent } from '../../src/editor/input/events.ts';
import {
  canEnableMidi, MIDI_OFF, type MidiAccessLike, MidiInput, type MidiInputLike, midiLed, type MidiStatus,
  midiStatusFromError, midiStatusReducer, midiStatusText,
} from '../../src/editor/midi/access.ts';

function domError(name: string, message = ''): Error {
  const e = new Error(message);
  e.name = name;
  return e;
}

test('texts of the status strip', () => {
  assert.equal(midiStatusText(MIDI_OFF), '');
  assert.equal(midiStatusText({ kind: 'unsupported' }), 'not supported in this browser');
  assert.equal(midiStatusText({ kind: 'denied' }), 'permission denied');
  assert.equal(midiStatusText({ kind: 'no-inputs' }), 'no inputs');
  assert.equal(midiStatusText({ kind: 'connected', inputs: ['IAC Driver Bus 1'] }), 'connected: IAC Driver Bus 1');
  assert.equal(midiStatusText({ kind: 'connected', inputs: ['A', 'B'] }), 'connected: A, B');
});

test('enable midi key while off and after an error; LEDs', () => {
  assert.ok(canEnableMidi(MIDI_OFF));
  assert.ok(canEnableMidi({ kind: 'error', message: 'x' }));
  for (const s of [{ kind: 'denied' }, { kind: 'unsupported' }, { kind: 'no-inputs' }, { kind: 'requesting' }] as MidiStatus[]) {
    assert.ok(!canEnableMidi(s), s.kind);
  }
  assert.equal(midiLed({ kind: 'connected', inputs: ['A'] }), 'on');
  assert.equal(midiLed({ kind: 'no-inputs' }), 'off');
  assert.equal(midiLed(MIDI_OFF), 'off');
  assert.equal(midiLed({ kind: 'denied' }), 'alert');
  assert.equal(midiLed({ kind: 'unsupported' }), 'alert');
});

test('errors: NotAllowedError and SecurityError → permission denied', () => {
  assert.deepEqual(midiStatusFromError(domError('NotAllowedError')), { kind: 'denied' });
  assert.deepEqual(midiStatusFromError(domError('SecurityError')), { kind: 'denied' });
  assert.deepEqual(midiStatusFromError({ name: 'NotAllowedError' }), { kind: 'denied' });
  assert.deepEqual(midiStatusFromError(domError('NotSupportedError')), { kind: 'unsupported' });
  assert.deepEqual(midiStatusFromError(domError('AbortError', 'boom')), { kind: 'error', message: 'boom' });
  assert.deepEqual(midiStatusFromError('odd'), { kind: 'error', message: 'odd' });
});

test('reducer: request → connected → disconnect → no inputs; disable → off', () => {
  let s = midiStatusReducer(MIDI_OFF, { type: 'request' });
  assert.deepEqual(s, { kind: 'requesting' });
  s = midiStatusReducer(s, { type: 'inputs', names: ['Keys'] });
  assert.deepEqual(s, { kind: 'connected', inputs: ['Keys'] });
  assert.equal(midiStatusReducer(s, { type: 'inputs', names: ['Keys'] }), s, 'same inputs keep the object');
  s = midiStatusReducer(s, { type: 'inputs', names: [] });
  assert.deepEqual(s, { kind: 'no-inputs' });
  assert.equal(midiStatusText(s), 'no inputs');
  assert.deepEqual(midiStatusReducer(s, { type: 'disable' }), MIDI_OFF);
  assert.equal(midiStatusReducer(MIDI_OFF, { type: 'inputs', names: ['Keys'] }), MIDI_OFF, 'no access, no status');
});

test('reducer: unsupported stays; denied ignores input lists', () => {
  const u = midiStatusReducer(MIDI_OFF, { type: 'unsupported' });
  assert.equal(midiStatusReducer(u, { type: 'request' }), u);
  const d = midiStatusReducer({ kind: 'requesting' }, { type: 'failed', error: domError('SecurityError') });
  assert.deepEqual(d, { kind: 'denied' });
  assert.equal(midiStatusReducer(d, { type: 'inputs', names: ['A'] }), d);
});

// A fake Web MIDI.
class FakeInput implements MidiInputLike {
  onmidimessage: MidiInputLike['onmidimessage'] = null;
  state = 'connected';
  readonly id: string;
  readonly name: string | null;
  constructor(id: string, name: string | null) {
    this.id = id;
    this.name = name;
  }
  send(...bytes: number[]): void {
    this.onmidimessage?.({ data: new Uint8Array(bytes) });
  }
}
class FakeAccess implements MidiAccessLike {
  onstatechange: MidiAccessLike['onstatechange'] = null;
  readonly list: FakeInput[] = [];
  readonly inputs = { forEach: (fn: (i: MidiInputLike) => void) => this.list.forEach(fn) };
  change(): void {
    this.onstatechange?.({});
  }
}

function setup(nav: ConstructorParameters<typeof MidiInput>[1]) {
  const bus = new PlayBus();
  const events: PlayEvent[] = [];
  bus.on((e) => events.push(e));
  const midi = new MidiInput(bus, nav);
  const statuses: string[] = [];
  midi.onStatus((s) => statuses.push(midiStatusText(s) || s.kind));
  return { midi, events, statuses };
}

test('no Web MIDI: not supported in this browser', async () => {
  const { midi, statuses } = setup({});
  await midi.enable();
  assert.deepEqual(statuses, ['not supported in this browser']);
});

test('denied permission: permission denied', async () => {
  const { midi, statuses } = setup({ requestMIDIAccess: () => Promise.reject(domError('NotAllowedError')) });
  await midi.enable();
  assert.deepEqual(statuses, ['waiting for permission', 'permission denied']);
});

test('asks without SysEx, plays from every input, follows connect and disconnect', async () => {
  const access = new FakeAccess();
  const asked: unknown[] = [];
  const { midi, events, statuses } = setup({
    requestMIDIAccess: (o) => {
      asked.push(o);
      return Promise.resolve(access);
    },
  });
  await midi.enable();
  assert.deepEqual(asked, [{ sysex: false }]);
  assert.deepEqual(midi.status, { kind: 'no-inputs' });

  const keys = new FakeInput('1', 'Keys');
  access.list.push(keys);
  access.change();
  assert.deepEqual(midi.status, { kind: 'connected', inputs: ['Keys'] });

  keys.send(0x90, 60, 100);
  keys.send(0xb0, 64, 127);
  keys.send(0xf8); // clock: ignored
  assert.deepEqual(events, [
    { type: 'noteOn', note: 60, velocity: 100, source: 'midi' },
    { type: 'sustain', on: true },
  ]);

  // Unplugged while holding: its notes and sustain are released, the strip says no inputs.
  events.length = 0;
  keys.state = 'disconnected';
  access.change();
  assert.deepEqual(events, [{ type: 'noteOff', note: 60, source: 'midi' }, { type: 'sustain', on: false }]);
  assert.equal(keys.onmidimessage, null);
  assert.deepEqual(statuses, ['waiting for permission', 'no inputs', 'connected: Keys', 'no inputs']);
});

test('disable stops listening and releases held notes', async () => {
  const access = new FakeAccess();
  const a = new FakeInput('a', '');
  access.list.push(a);
  const { midi, events } = setup({ requestMIDIAccess: () => Promise.resolve(access) });
  await midi.enable();
  assert.deepEqual(midi.status, { kind: 'connected', inputs: ['unnamed input'] });
  a.send(0x91, 62, 80);
  events.length = 0;
  midi.disable();
  assert.deepEqual(events, [{ type: 'noteOff', note: 62, source: 'midi' }]);
  assert.equal(a.onmidimessage, null);
  assert.equal(access.onstatechange, null);
  assert.deepEqual(midi.status, MIDI_OFF);
});

test('forgetHeld after a panic: nothing is emitted, and a later disable sends no stale note off', async () => {
  const access = new FakeAccess();
  const a = new FakeInput('a', 'A');
  access.list.push(a);
  const { midi, events } = setup({ requestMIDIAccess: () => Promise.resolve(access) });
  await midi.enable();
  a.send(0x90, 60, 100);
  a.send(0xb0, 64, 127);
  events.length = 0;
  midi.forgetHeld();
  assert.deepEqual(events, []);
  midi.disable();
  assert.deepEqual(events, []);
});
