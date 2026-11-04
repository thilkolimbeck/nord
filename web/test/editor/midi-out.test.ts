/**
 * Plan section 15.5: MIDI out to a connected Stage 4 on a fake output port and fake timers.
 * Nothing goes out with any switch off or without a port; control edits go out as their CC or
 * NRPN after the focus the Stage 4 needs, and the editor's focus comes back afterwards; a drag
 * sends at most one value per field per 20 ms; send all: order, count, pacing, stop; notes and
 * performance controls only from the editor's own sources; panic and switching off end the notes;
 * never SysEx. No Web MIDI, no DOM.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { MidiAccessLike } from '../../src/editor/midi/access.ts';
import { ccEntry, entryForKey, nrpnEntry } from '../../src/editor/midi/cc-map.ts';
import type { MidiOutputLike } from '../../src/editor/midi/output.ts';
import {
  COALESCE_MS, isChannelMessage, MidiOut, SEND_ALL_CHUNK, sendAllText,
} from '../../src/editor/midi/send.ts';
import { initProgram } from '../../src/editor/model/init.ts';
import type { Ns4Key } from '../../src/editor/model/keys.ts';
import { ParamStore } from '../../src/editor/model/store.ts';

/** A fake clock with timers that run when the test advances it. */
function fakeTiming() {
  let now = 1000;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    timing: {
      now: () => now,
      setTimer: (fn: () => void, ms: number) => {
        const id = ++seq;
        timers.set(id, { at: now + ms, fn });
        return id;
      },
      clearTimer: (h: unknown) => {
        timers.delete(h as number);
      },
    },
    advance(ms: number): void {
      const until = now + ms;
      for (;;) {
        const due = [...timers].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (due === undefined) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
      }
      now = until;
    },
    get pending(): number {
      return timers.size;
    },
  };
}

interface Sent {
  readonly data: number[];
  readonly at: number | undefined;
}

function fakePort(id = 'out1', name: string | null = 'Stage 4 MIDI') {
  const sent: Sent[] = [];
  const port: MidiOutputLike & { state: string } = {
    id, name, state: 'connected',
    send: (d, at) => {
      sent.push({ data: [...d], at });
    },
  };
  return { port, sent };
}

function fakeAccess(ports: MidiOutputLike[]): MidiAccessLike {
  return {
    inputs: { forEach: () => undefined },
    outputs: { forEach: (fn) => ports.forEach(fn) },
    onstatechange: null,
  };
}

function setup() {
  const store = new ParamStore(initProgram());
  const t = fakeTiming();
  const out = new MidiOut(store, t.timing);
  const p = fakePort();
  out.setAccess(fakeAccess([p.port]));
  return { store, t, out, ...p };
}

const cc = (n: number, v: number, ch = 0): number[] => [0xb0 | ch, n, v];
const data = (s: readonly Sent[]): number[][] => s.map((x) => x.data);

test('nothing goes out: every switch off, no port, or no access', async () => {
  const { store, out, sent } = setup();
  store.set('synthASound.fltFreq', 30, 'ui');
  out.changes([{ key: 'synthASound.fltFreq', value: 30, previous: 0, origin: 'ui' }]);
  out.play({ type: 'noteOn', note: 60, velocity: 100, source: 'pointer' });
  out.play({ type: 'controller', kind: 'wheel', value: 64 }, 'screen');
  assert.equal(await out.sendAll(), 0);
  out.panic();
  assert.deepEqual(sent, [], 'switches off by default');

  // Every switch on but no port picked.
  out.update({ sendControls: true, sendNotes: true, extern: true });
  store.set('synthASound.fltFreq', 31, 'ui');
  out.changes([{ key: 'synthASound.fltFreq', value: 31, previous: 30, origin: 'ui' }]);
  out.play({ type: 'noteOn', note: 61, velocity: 100, source: 'pointer' });
  assert.equal(out.send([0x90, 60, 1], { kind: 'extern', source: 'pointer' }), false);
  assert.equal(await out.sendAll(), 0);
  assert.deepEqual(sent, [], 'no port');

  // A port picked, but MIDI access gone.
  out.update({ portId: 'out1' });
  out.setAccess(null);
  assert.equal(out.status.kind, 'no-access');
  out.play({ type: 'noteOn', note: 62, velocity: 100, source: 'pointer' });
  assert.deepEqual(sent, [], 'no access');
});

test('status: no access, no outputs, ready with the ports, port gone and back', () => {
  const store = new ParamStore(initProgram());
  const out = new MidiOut(store, fakeTiming().timing);
  const seen: string[] = [];
  out.onStatus((s) => seen.push(s.kind));
  assert.deepEqual(out.status, { kind: 'no-access' });
  out.setAccess(fakeAccess([]));
  assert.deepEqual(out.status, { kind: 'no-outputs' });
  const a = fakePort('a', 'Stage 4');
  const b = fakePort('b', null);
  out.setAccess(fakeAccess([a.port, b.port]));
  assert.deepEqual(out.status, { kind: 'ready', ports: [{ id: 'a', name: 'Stage 4' }, { id: 'b', name: 'unnamed output' }] });
  out.update({ portId: 'a', sendNotes: true });
  a.port.state = 'disconnected';
  out.setAccess(fakeAccess([a.port, b.port]));
  assert.deepEqual(out.status, { kind: 'port-gone', name: 'Stage 4' });
  assert.deepEqual(out.ports, [{ id: 'b', name: 'unnamed output' }], 'the picker can still offer the others');
  out.play({ type: 'noteOn', note: 60, velocity: 90, source: 'pointer' });
  assert.deepEqual(a.sent, [], 'nothing to a gone port');
  a.port.state = 'connected';
  out.setAccess(fakeAccess([a.port, b.port]));
  assert.equal(out.status.kind, 'ready');
  assert.equal(out.settings.sendNotes, true, 'the switch stays on');
  out.play({ type: 'noteOn', note: 60, velocity: 90, source: 'pointer' });
  assert.deepEqual(data(a.sent), [[0x90, 60, 90]], 'resumes when the port returns');
  assert.deepEqual(seen, ['no-outputs', 'ready', 'port-gone', 'ready']);
});

test('settings: switches merge, channels stay 1..16, listeners hear changes', () => {
  const { out } = setup();
  const heard: boolean[] = [];
  out.onSettings((s) => heard.push(s.sendNotes));
  out.update({ sendNotes: true, channel: 0 });
  assert.equal(out.settings.channel, 1, 'an invalid channel keeps the previous one');
  out.update({ channel: 16, externChannels: { A: 2, B: 99, C: 3 } });
  assert.deepEqual(out.settings.externChannels, { A: 2, B: 14, C: 3 });
  assert.equal(out.settings.channel, 16);
  out.update({ sendNotes: true });
  assert.deepEqual(heard, [true, true], 'no notification without a change');
});

/** Store edit + the batch the store emits, as main wires it. */
function edit(store: ParamStore, out: MidiOut, key: Ns4Key, value: number, origin: 'ui' | 'derived' | 'midi' | 'load' = 'ui'): void {
  const un = store.onChange((b) => out.changes(b));
  if (origin === 'load') store.setMany([[key, value]], 'load');
  else store.setMany([[key, value]], origin);
  un();
}

test('send to stage 4: a layer controller goes out after its layer focus, only edits made in the editor', () => {
  const { store, t, out, sent } = setup();
  out.update({ portId: 'out1', sendControls: true });
  const focusI = entryForKey('synth.layerFocusSyn_I')!.entry;
  assert.deepEqual(focusI.address, { kind: 'cc', cc: 115 });
  assert.equal(store.get('synth.layerFocusSyn_I'), 0, 'init: synth focus A');
  edit(store, out, 'synthASound.fltFreq', 40);
  assert.deepEqual(data(sent), [cc(115, 0), cc(59, 40)], 'focus A first (none sent yet), then the cutoff');
  sent.length = 0;
  t.advance(COALESCE_MS);
  edit(store, out, 'synthASound.fltFreq', 41);
  assert.deepEqual(data(sent), [cc(59, 41)], 'the focus is already A');
  sent.length = 0;
  for (const origin of ['midi', 'load'] as const) {
    t.advance(COALESCE_MS);
    edit(store, out, 'synthASound.fltFreq', 50, origin);
  }
  out.changes([{ key: 'synthASound.fltFreq', value: 60, previous: 50, origin: 'morph' }]);
  t.advance(100);
  assert.deepEqual(sent, [], 'MIDI input, loads and morphs are never sent');
  edit(store, out, 'synthA.externPCValue', 5);
  assert.deepEqual(sent, [], 'a field without a controller sends nothing');
});

test('send to stage 4: another layer gets its focus and the editor focus comes back; NRPN as four messages', () => {
  const { store, out, sent } = setup();
  out.update({ portId: 'out1', sendControls: true, channel: 3 });
  edit(store, out, 'synthBSound.fltFreq', 70, 'derived');
  assert.deepEqual(data(sent), [cc(115, 1, 2), cc(59, 70, 2), cc(115, 0, 2)]);
  sent.length = 0;
  const type = entryForKey('synthCSound.fltType')!;
  assert.deepEqual(type.entry.address, { kind: 'nrpn', msb: 3, lsb: 51 });
  edit(store, out, 'synthCSound.fltType', 2);
  assert.deepEqual(data(sent), [cc(115, 2, 2), cc(99, 3, 2), cc(98, 51, 2), cc(6, 0, 2), cc(38, 2, 2), cc(115, 0, 2)]);
  sent.length = 0;
  // Scene II active: the focus controller of scene II (CC 119).
  edit(store, out, 'common.layerScene', 1);
  assert.deepEqual(data(sent), [cc(8, 127, 2)]);
  sent.length = 0;
  edit(store, out, 'synthBSound.fltRes', 9);
  assert.deepEqual(data(sent), [cc(119, 1, 2), cc(60, 9, 2), cc(119, store.get('synth.layerFocusSyn_II'), 2)]);
});

test('send to stage 4: an effects controller goes out after the FX focus and the layer focus of its block', () => {
  const { store, out, sent } = setup();
  out.update({ portId: 'out1', sendControls: true });
  const shownFx = store.get('common.fxSectionFocus');
  const shownPiano = store.get('piano.layerFocusPno_I');
  edit(store, out, 'pianoBFx.rvbAmt' as Ns4Key, 77);
  const msgs = data(sent);
  assert.deepEqual(msgs.slice(0, 3), [cc(109, 1), cc(31, 1), cc(113, 77)], 'the layer focus, then CC31');
  const restore = msgs.slice(3);
  assert.deepEqual(restore.filter((m) => m[1] === 109), shownPiano === 1 ? [] : [cc(109, shownPiano)]);
  // Restoring the piano focus may move the FX focus: CC31 then goes out again, last.
  assert.deepEqual(restore.filter((m) => m[1] === 31), shownFx === 1 && shownPiano === 1 ? [] : [cc(31, shownFx)]);
  if (restore.length > 0) assert.equal(restore.at(-1)![1], 31, 'CC31 is restored last');
  sent.length = 0;
  edit(store, out, 'organFx.rvbAmt' as Ns4Key, 10);
  assert.deepEqual(data(sent).slice(0, 2), [cc(31, 0), cc(113, 10)], 'the organ block needs no layer focus');
});

test('send to stage 4: after a layer focus the FX focus counts as unknown, so the next effects value sends CC31', () => {
  const { store, t, out, sent } = setup();
  out.update({ portId: 'out1', sendControls: true });
  edit(store, out, 'common.fxSectionFocus', 0, 'derived');
  edit(store, out, 'synth.layerFocusSyn_I', 0, 'derived');
  sent.length = 0;
  edit(store, out, 'synthBFx.dlyMix' as Ns4Key, 99);
  const mix = entryForKey('synthBFx.dlyMix' as Ns4Key)!.entry.address;
  assert.equal(mix.kind, 'cc');
  const mixCc = mix.kind === 'cc' ? mix.cc : -1;
  assert.deepEqual(data(sent), [cc(115, 1), cc(31, 2), cc(mixCc, 99), cc(115, 0), cc(31, 0)],
    'the layer focus restored before CC31');
  sent.length = 0;
  edit(store, out, 'organFx.rvbAmt' as Ns4Key, 33);
  assert.deepEqual(data(sent), [cc(113, 33)], 'CC31 was restored last, so the organ block is in focus');
  sent.length = 0;
  t.advance(COALESCE_MS);
  edit(store, out, 'synthBSound.fltFreq', 70);
  edit(store, out, 'organFx.rvbAmt' as Ns4Key, 34);
  assert.deepEqual(data(sent), [cc(115, 1), cc(59, 70), cc(115, 0), cc(31, 0), cc(113, 34)],
    'a layer focus may have moved the FX focus: CC31 goes out again');
});

test('send to stage 4: the organ vibrato type goes out with the focus on an organ layer of its model', () => {
  const { store, out, sent } = setup();
  out.update({ portId: 'out1', sendControls: true });
  edit(store, out, 'organA.model' as Ns4Key, 0, 'derived'); // B3
  edit(store, out, 'organB.model' as Ns4Key, 1, 'derived'); // Vox
  edit(store, out, 'organ.layerFocusOrg_I' as Ns4Key, 0, 'derived');
  sent.length = 0;
  edit(store, out, 'organ.vibratoTypeVox' as Ns4Key, 0);
  const focus = entryForKey('organ.layerFocusOrg_I' as Ns4Key)!.entry.address;
  const focusCc = focus.kind === 'cc' ? focus.cc : -1;
  assert.deepEqual(data(sent).slice(0, 1), [cc(focusCc, 1)], 'layer B (Vox) in focus first');
  assert.deepEqual(data(sent).slice(1, 3), [cc(99, 2), cc(98, 19)]);
  assert.deepEqual(data(sent).at(-1), cc(focusCc, 0), 'the editor focus comes back');
  sent.length = 0;
  edit(store, out, 'organ.vibratoTypeB3' as Ns4Key, 2);
  assert.deepEqual(data(sent).slice(0, 2), [cc(99, 2), cc(98, 19)], 'layer A (B3) is in focus already');
  sent.length = 0;
  edit(store, out, 'organ.vibratoTypeFarfisa' as Ns4Key, 1);
  assert.deepEqual(sent, [], 'no organ layer is a Farfisa: nothing would receive it');
});

test('a drag sends at most one value per field per 20 ms, the last one wins', () => {
  const { store, t, out, sent } = setup();
  out.update({ portId: 'out1', sendControls: true });
  edit(store, out, 'synthASound.fltFreq', 10);
  sent.length = 0;
  t.advance(5);
  edit(store, out, 'synthASound.fltFreq', 11);
  t.advance(5);
  edit(store, out, 'synthASound.fltFreq', 12);
  edit(store, out, 'synthASound.fltRes', 3); // another field is not held back
  assert.deepEqual(data(sent), [cc(60, 3)]);
  t.advance(9);
  assert.deepEqual(data(sent), [cc(60, 3)], 'still inside the 20 ms');
  t.advance(1);
  assert.deepEqual(data(sent), [cc(60, 3), cc(59, 12)]);
  // Switching off drops what waits.
  edit(store, out, 'synthASound.fltFreq', 13);
  out.update({ sendControls: false });
  t.advance(100);
  assert.deepEqual(data(sent), [cc(60, 3), cc(59, 12)]);
  assert.equal(t.pending, 0);
});

test('send all: order, count, 1 ms pacing in chunks, the editor focus last, only with send to stage 4 on', async () => {
  const { store, t, out, sent } = setup();
  out.update({ portId: 'out1' });
  assert.equal(await out.sendAll(), 0, 'off: nothing');
  assert.equal(sent.length, 0);
  out.update({ sendControls: true, channel: 2 });
  const running = out.sendAll();
  assert.equal(out.sending, true);
  assert.equal(out.sendAll(), running, 'a second press while it runs');
  assert.equal(sent.length, SEND_ALL_CHUNK, 'one chunk per tick');
  while (out.sending) t.advance(SEND_ALL_CHUNK);
  const count = await running;
  const msgs = data(sent);
  assert.ok(msgs.every((m) => m[0] === 0xb1 && isChannelMessage(m)), 'controllers on the global channel only');
  assert.deepEqual(msgs[0], [0xb1, 8, 0], 'the active layer scene first');
  sent.forEach((s, i) => assert.equal(s.at, 1000 + i, `message ${i} timestamp`));
  // Count: every plain CC and every complete NRPN (CC38) is one controller value.
  const nrpn = msgs.filter((m) => m[1] === 38).length;
  const plain = msgs.filter((m) => ![99, 98, 6, 38].includes(m[1]!)).length;
  assert.equal(count, plain + nrpn);
  assert.ok(count > 150, `${count} controllers`);
  // The last messages: CC31 and the three layer focus controllers of the active scene, as the editor shows.
  assert.deepEqual(msgs.slice(-4), [[0xb1, 31, store.get('common.fxSectionFocus')], [0xb1, 82, store.get('organ.layerFocusOrg_I')],
    [0xb1, 109, store.get('piano.layerFocusPno_I')], [0xb1, 115, store.get('synth.layerFocusSyn_I')]]);
  // Every synth layer's cutoff goes out after that layer's focus.
  for (const [layer, idx] of [['A', 0], ['B', 1], ['C', 2]] as const) {
    const at = msgs.findIndex((m, i) => m[1] === 59 && msgs.slice(0, i).reverse().find((x) => x[1] === 115)?.[2] === idx);
    assert.ok(at >= 0, `synth ${layer} cutoff after focus ${idx}`);
  }
  assert.ok(sendAllText(count).startsWith(`sent ${count} controllers`));
});

test('send all stops when send to stage 4 goes off; edits meanwhile wait and go out after', async () => {
  const { store, t, out, sent } = setup();
  out.update({ portId: 'out1', sendControls: true });
  const running = out.sendAll();
  const before = sent.length;
  edit(store, out, 'synthASound.fltFreq', 99);
  assert.equal(sent.length, before, 'a live edit waits for send all');
  t.advance(SEND_ALL_CHUNK);
  out.update({ sendControls: false });
  t.advance(1000);
  const n = await running;
  assert.ok(n > 0 && sent.length <= before + SEND_ALL_CHUNK * 2, `stopped after ${sent.length} messages`);
  assert.equal(out.sending, false);
  assert.ok(!data(sent).some((m) => m[1] === 59 && m[2] === 99), 'the waiting edit is dropped with the switch off');

  // With the switch on, the waiting edit goes out after send all.
  out.update({ sendControls: true });
  const again = out.sendAll();
  edit(store, out, 'synthASound.fltFreq', 98);
  while (out.sending) t.advance(SEND_ALL_CHUNK);
  await again;
  assert.ok(data(sent).slice(-3).some((m) => m[1] === 59 && m[2] === 98), 'sent after send all');
  // Queued behind send all's last messages (still ahead in time), never between two halves of an NRPN.
  const tail = sent.slice(-6);
  assert.ok(tail.every((m) => m.at !== undefined), 'timestamped behind the queue');
  for (let i = 1; i < tail.length; i++) assert.ok(tail[i]!.at! > tail[i - 1]!.at!, 'in order, 1 ms apart');
});

test('send notes: notes and performance controls from the editor on the global channel, never MIDI input', () => {
  const { out, sent } = setup();
  out.update({ portId: 'out1', sendNotes: true, channel: 5 });
  out.play({ type: 'noteOn', note: 60, velocity: 100, source: 'pointer' });
  out.play({ type: 'noteOn', note: 62, velocity: 90, source: 'midi' });
  out.play({ type: 'noteOn', note: 60, velocity: 80, source: 'computer' }); // held already: no restrike
  out.play({ type: 'noteOff', note: 62, source: 'midi' });
  out.play({ type: 'noteOff', note: 60, source: 'pointer' });
  assert.deepEqual(data(sent), [[0x94, 60, 100]], 'one note on; the computer key still holds 60');
  out.update({ channel: 6 });
  out.play({ type: 'noteOff', note: 60, source: 'computer' });
  assert.deepEqual(data(sent).at(-1), [0x84, 60, 0], 'the note off goes to the channel of its note on');
  sent.length = 0;
  out.play({ type: 'controller', kind: 'wheel', value: 64 }); // no source: counts as MIDI input
  out.play({ type: 'sustain', on: true });
  out.play({ type: 'bend', value: 100 }, 'midi');
  assert.deepEqual(sent, []);
  out.play({ type: 'controller', kind: 'wheel', value: 64 }, 'screen');
  out.play({ type: 'controller', kind: 'pressure', value: 30 }, 'screen');
  out.play({ type: 'controller', kind: 'pedal', value: 127 }, 'screen');
  out.play({ type: 'sustain', on: true }, 'computer');
  out.play({ type: 'bend', value: -8192 }, 'computer');
  out.play({ type: 'bend', value: 8191 }, 'computer');
  assert.deepEqual(data(sent), [[0xb5, 1, 64], [0xd5, 30], [0xb5, 11, 127], [0xb5, 64, 127], [0xe5, 0, 0], [0xe5, 127, 127]]);
});

test('panic and switching a sender off: CC123 and CC64 0 on every channel notes went out on, once', () => {
  const { out, sent } = setup();
  out.update({ portId: 'out1', sendNotes: true, extern: true, channel: 1 });
  out.play({ type: 'noteOn', note: 60, velocity: 100, source: 'pointer' });
  out.update({ channel: 2 });
  out.play({ type: 'noteOn', note: 61, velocity: 100, source: 'pointer' });
  out.send([0x9c, 40, 90], { kind: 'extern', source: 'pointer' }); // an extern note on channel 13
  sent.length = 0;
  out.play({ type: 'panic' });
  assert.deepEqual(data(sent), [cc(123, 0, 0), cc(64, 0, 0), cc(123, 0, 1), cc(64, 0, 1), cc(123, 0, 12), cc(64, 0, 12)]);
  sent.length = 0;
  out.panic();
  assert.deepEqual(sent, [], 'nothing more to end');
  out.play({ type: 'noteOn', note: 64, velocity: 100, source: 'computer' });
  sent.length = 0;
  out.update({ sendNotes: false });
  assert.deepEqual(data(sent), [cc(123, 0, 1), cc(64, 0, 1)], 'switching send notes off ends its notes');
  sent.length = 0;
  out.play({ type: 'noteOff', note: 64, source: 'computer' });
  assert.deepEqual(sent, [], 'its note off is not sent any more');
});

test('a port change ends the notes on the old port first', () => {
  const store = new ParamStore(initProgram());
  const out = new MidiOut(store, fakeTiming().timing);
  const a = fakePort('a');
  const b = fakePort('b');
  out.setAccess(fakeAccess([a.port, b.port]));
  out.update({ portId: 'a', sendNotes: true });
  out.play({ type: 'noteOn', note: 60, velocity: 100, source: 'pointer' });
  out.update({ portId: 'b' });
  assert.deepEqual(data(a.sent), [[0x90, 60, 100], cc(123, 0), cc(64, 0)]);
  assert.deepEqual(b.sent, []);
});

test('never SysEx: only complete channel messages reach the port', () => {
  assert.equal(isChannelMessage([0xf0, 0x7e, 0x7f, 0xf7]), false);
  assert.equal(isChannelMessage([0xf8]), false);
  assert.equal(isChannelMessage([0xb0, 128, 0]), false);
  assert.equal(isChannelMessage([0xb0, 1]), false);
  assert.equal(isChannelMessage([0xc0, 5]), true);
  assert.equal(isChannelMessage([0x90, 60, 100]), true);
  const { out, sent } = setup();
  out.update({ portId: 'out1', extern: true });
  assert.throws(() => out.send([0xf0, 0x33, 0xf7], { kind: 'extern', source: 'program' }));
  assert.deepEqual(sent, []);
  // The appendix entries used here exist as the tests assume.
  assert.equal(ccEntry(59)?.name, 'Synth Filter Freq');
  assert.equal(nrpnEntry(3, 51)?.name, 'Synth Filter Type');
});
