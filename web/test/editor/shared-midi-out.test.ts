/**
 * Plan sections 15.4–15.6, shared MIDI contracts (frozen): the send gate (nothing goes out unless
 * the user switched it on and a port is picked; MIDI input is never echoed except to extern with
 * the echo setting), channel nibbles, and the two hooks of midi/access.ts: every parsed message for
 * MIDI control in, and the access object for the output.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PlayBus, type PlayEvent } from '../../src/editor/input/events.ts';
import { type MidiAccessLike, MidiInput, type MidiInputLike } from '../../src/editor/midi/access.ts';
import type { SectionSink } from '../../src/editor/audio/tee.ts';
import { ExternOut } from '../../src/editor/midi/extern.ts';
import {
  channelNibble, DEFAULT_MIDI_OUT, mayEmit, type MidiOutApi, type MidiOutSettings,
} from '../../src/editor/midi/output.ts';
import { MidiOut } from '../../src/editor/midi/send.ts';
import type { MidiEvent } from '../../src/editor/midi/parser.ts';

const on = (patch: Partial<MidiOutSettings>): MidiOutSettings => ({ ...DEFAULT_MIDI_OUT, portId: 'p1', ...patch });

test('the defaults send nothing: every switch off, no port', () => {
  assert.equal(DEFAULT_MIDI_OUT.sendControls || DEFAULT_MIDI_OUT.sendNotes || DEFAULT_MIDI_OUT.extern, false);
  assert.equal(DEFAULT_MIDI_OUT.portId, null);
  assert.deepEqual(DEFAULT_MIDI_OUT.externChannels, { A: 13, B: 14, C: 15 });
  for (const what of [{ kind: 'control', origin: 'ui' }, { kind: 'sendAll' }, { kind: 'note', source: 'pointer' },
    { kind: 'performance', source: 'screen' }, { kind: 'extern', source: 'computer' }] as const) {
    assert.equal(mayEmit(DEFAULT_MIDI_OUT, what), false, what.kind);
    assert.equal(mayEmit({ ...DEFAULT_MIDI_OUT, sendControls: true, sendNotes: true, extern: true }, what), false,
      `${what.kind} without a port`);
  }
});

test('controls: only with send to stage 4 on, and only edits made in the editor', () => {
  const s = on({ sendControls: true });
  assert.equal(mayEmit(s, { kind: 'control', origin: 'ui' }), true);
  assert.equal(mayEmit(s, { kind: 'control', origin: 'derived' }), true);
  for (const origin of ['midi', 'morph', 'load', 'init'] as const) {
    assert.equal(mayEmit(s, { kind: 'control', origin }), false, origin);
  }
  assert.equal(mayEmit(s, { kind: 'sendAll' }), true);
  assert.equal(mayEmit(on({}), { kind: 'sendAll' }), false);
  assert.equal(mayEmit(s, { kind: 'note', source: 'pointer' }), false, 'notes have their own switch');
});

test('notes and performance controls: own switch, never MIDI input', () => {
  const s = on({ sendNotes: true });
  assert.equal(mayEmit(s, { kind: 'note', source: 'pointer' }), true);
  assert.equal(mayEmit(s, { kind: 'note', source: 'computer' }), true);
  assert.equal(mayEmit(s, { kind: 'note', source: 'midi' }), false);
  assert.equal(mayEmit(s, { kind: 'performance', source: 'screen' }), true);
  assert.equal(mayEmit(s, { kind: 'performance', source: 'midi' }), false);
  assert.equal(mayEmit(s, { kind: 'control', origin: 'ui' }), false);
});

test('extern: own switch; MIDI input only with echo to extern', () => {
  const s = on({ extern: true });
  assert.equal(mayEmit(s, { kind: 'extern', source: 'pointer' }), true);
  assert.equal(mayEmit(s, { kind: 'extern', source: 'program' }), true);
  assert.equal(mayEmit(s, { kind: 'extern', source: 'midi' }), false);
  assert.equal(mayEmit({ ...s, echoToExtern: true }, { kind: 'extern', source: 'midi' }), true);
});

test('channel nibbles', () => {
  assert.equal(channelNibble(1), 0);
  assert.equal(channelNibble(16), 15);
  assert.equal(channelNibble(0), 0);
  assert.equal(channelNibble(17), 0);
  assert.equal(channelNibble(2.5), 0);
});

/** A fake Web MIDI: one input, one output, statechange by hand. */
function fakeMidi() {
  const input: MidiInputLike = { id: 'in1', name: 'Stage 4 in', state: 'connected', onmidimessage: null };
  const sent: number[][] = [];
  const output = { id: 'out1', name: 'Stage 4 out', state: 'connected', send: (d: readonly number[] | Uint8Array) => {
    sent.push([...d]);
  } };
  const access: MidiAccessLike = {
    inputs: { forEach: (fn) => fn(input) },
    outputs: { forEach: (fn) => fn(output) },
    onstatechange: null,
  };
  const requests: Array<{ sysex: boolean }> = [];
  const nav = { requestMIDIAccess: (o: { sysex: boolean }) => {
    requests.push(o);
    return Promise.resolve(access);
  } };
  return { input, output, sent, access, nav, requests };
}

test('MidiInput: onMessage sees every parsed message, onAccess the access; still no SysEx, nothing sent', async () => {
  const f = fakeMidi();
  const bus = new PlayBus();
  const played: PlayEvent[] = [];
  bus.on((e) => played.push(e));
  const midi = new MidiInput(bus, f.nav);
  const messages: Array<[MidiEvent, string]> = [];
  const accesses: Array<MidiAccessLike | null> = [];
  midi.onMessage((e, id) => messages.push([e, id]));
  midi.onAccess((a) => accesses.push(a));
  assert.equal(midi.access, null);
  await midi.enable();
  assert.deepEqual(f.requests, [{ sysex: false }]);
  assert.equal(midi.access, f.access);
  assert.deepEqual(accesses, [f.access]);
  f.input.onmidimessage!({ data: new Uint8Array([0xb0, 59, 70]) });
  f.input.onmidimessage!({ data: new Uint8Array([0xb0, 1, 90]) });
  assert.deepEqual(messages.map(([e, id]) => [e.type, id]), [['cc', 'in1'], ['cc', 'in1']]);
  assert.deepEqual(played, [{ type: 'controller', kind: 'wheel', value: 90 }], 'CC59 is no play event; CC1 still is');
  f.access.onstatechange!({});
  assert.equal(accesses.length, 2, 'a port change announces the access again');
  midi.disable();
  assert.deepEqual(accesses.at(-1), null);
  assert.deepEqual(f.sent, [], 'MIDI input sends nothing');
});

test('the extern sink and the MIDI out stubs fit the contracts main wires them into', () => {
  const out = new MidiOut({ get: () => 0 });
  const extern = new ExternOut({ get: () => 0 }, out);
  // Compile-time: ExternOut is a SectionSink of the synth (audio/tee.ts), MidiOut a MidiOutApi.
  const sink: SectionSink<'synth'> = extern;
  const api: MidiOutApi = out;
  assert.ok(sink && api);
  assert.equal(out.settings.sendControls, false);
});
