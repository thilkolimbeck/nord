/**
 * Plan section 15.6 (manual p.46–47, 63): extern layers on a fake output port. Notes follow the
 * router's zones and transpose plus the layer's octave shift, the velocity curve and crossfade
 * gain; sustain and bend by the layer's switches; wheel, pressure and pedal by the device enables;
 * program data (bank select, program change, CC numbers and values, CC7) on edits and, with Send
 * On Load, on loads; MIDI input only with echo; nothing without extern out; panic ends the notes.
 * No Web MIDI, no Web Audio.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Router, routeNote, transposeSemitones } from '../../src/editor/audio/router.ts';
import type { SectionEngine } from '../../src/editor/audio/section.ts';
import { teeSection } from '../../src/editor/audio/tee.ts';
import type { MidiAccessLike } from '../../src/editor/midi/access.ts';
import {
  externBankValue, externCcNumber, externKey, externPart, ExternOut, externVelocity,
} from '../../src/editor/midi/extern.ts';
import { MidiOut } from '../../src/editor/midi/send.ts';
import { initProgram } from '../../src/editor/model/init.ts';
import type { Ns4Key, SynthLayer } from '../../src/editor/model/keys.ts';
import { MorphedValues } from '../../src/editor/model/morph.ts';
import { layerToggle, sectionEntry } from '../../src/editor/model/scene.ts';
import { type Change, ParamStore } from '../../src/editor/model/store.ts';

function setup(layers: readonly SynthLayer[] = ['A']) {
  const store = new ParamStore(initProgram());
  // Synth section on in scene I with the given layers, all of them extern.
  store.setMany([sectionEntry('synth', true, 'I')], 'ui');
  for (const l of ['A', 'B', 'C'] as const) store.setMany([layerToggle(store, 'synth', l, layers.includes(l), 'I')], 'ui');
  for (const l of layers) store.set(externKey(l, 'externEnable'), 1, 'ui');
  const morphed = new MorphedValues(store);
  const sent: number[][] = [];
  const port = { id: 'p', name: 'Stage 4', state: 'connected', send: (d: readonly number[] | Uint8Array) => {
    sent.push([...d]);
  } };
  const access: MidiAccessLike = { inputs: { forEach: () => undefined }, outputs: { forEach: (fn) => fn(port) }, onstatechange: null };
  const out = new MidiOut(store, { now: () => 0, setTimer: () => 0, clearTimer: () => undefined });
  out.setAccess(access);
  const extern = new ExternOut(morphed, out);
  return { store, morphed, out, extern, sent };
}

const silent: SectionEngine<'synth'> = {
  section: 'synth', handle: () => undefined, applyChanges: () => undefined, panic: () => undefined,
  reload: () => undefined, activeCount: 0, dispose: () => undefined,
};

test('encodings: CC number raw − 1 (0 = off), bank select raw − 1 (0 = "--"), the velocity curve', () => {
  assert.equal(externCcNumber(0), null);
  assert.equal(externCcNumber(1), 0);
  assert.equal(externCcNumber(3), 2, 'the layout default 3 is the manual default CC 2');
  assert.equal(externCcNumber(120), 119);
  assert.equal(externBankValue(0), null);
  assert.equal(externBankValue(1), 0);
  assert.equal(externBankValue(128), 127);
  assert.equal(externVelocity(64, 1), 64, 'mid is linear');
  assert.ok(externVelocity(64, 0) > 64, 'soft: higher velocities come easier');
  assert.ok(externVelocity(64, 2) < 64, 'hard');
  assert.equal(externVelocity(127, 0), 127);
  assert.equal(externVelocity(100, 1, 0.5), 50, 'times the crossfade gain');
  assert.equal(externVelocity(1, 2, 0.01), 1, 'never 0 (that would be a note off)');
  assert.deepEqual(externPart('synthB.externPCValue'), { layer: 'B', part: 'program' });
  assert.deepEqual(externPart('synth.layerLevelSynC'), { layer: 'C', part: 'level' });
  assert.equal(externPart('synthA.octaveShift'), null);
});

test('nothing goes out without extern out, or without a port', () => {
  const { store, out, extern, sent } = setup();
  out.update({ portId: 'p' });
  extern.handle({ type: 'noteOn', key: 60, note: 60, velocity: 100, layers: [{ layer: 'A', gain: 1 }], source: 'pointer' });
  out.play({ type: 'controller', kind: 'wheel', value: 50 }, 'screen');
  store.set(externKey('A', 'externPCValue'), 9, 'ui');
  extern.applyChanges([{ key: externKey('A', 'externPCValue'), value: 9, previous: 0, origin: 'ui' }]);
  assert.deepEqual(sent, []);
  out.update({ portId: null, extern: true });
  extern.handle({ type: 'noteOn', key: 61, note: 61, velocity: 100, layers: [{ layer: 'A', gain: 1 }], source: 'pointer' });
  assert.deepEqual(sent, []);
});

test('notes: through the router with zones and transpose, plus the octave shift, on the layer channel', () => {
  const { store, out, extern, sent } = setup(['A', 'B']);
  out.update({ portId: 'p', extern: true, externChannels: { A: 10, B: 11, C: 12 } });
  store.setMany([['common.transposeEnable', 1], ['common.transposeValue', 2], [externKey('B', 'octaveShift'), -1]], 'ui');
  // A split with layer A in a part of the zones only.
  store.setMany([['common.splitEnabled', 1], ['common.splitEnabledMid', 1], ['common.splitPosMid', 4]], 'ui');
  let partial = -1;
  for (let v = 0; v <= 11 && partial < 0; v++) {
    store.set('synthA.kbZone', v, 'ui');
    const plays = [36, 96].map((k) => routeNote(store, k).routes.some((r) => r.section === 'synth' && r.layers.some((h) => h.layer === 'A')));
    if (plays[0] !== plays[1]) partial = v;
  }
  assert.ok(partial >= 0, 'a kbZone value that plays only part of the keyboard');
  const router = new Router(store, { synth: teeSection(silent, extern) });
  const t = transposeSemitones(store);
  assert.equal(t, 2);
  for (const key of [36, 96]) {
    sent.length = 0;
    router.handle({ type: 'noteOn', note: key, velocity: 100, source: 'pointer' });
    const route = routeNote(store, key).routes.find((r) => r.section === 'synth');
    const expected: number[][] = [];
    for (const h of route?.layers ?? []) {
      const ch = h.layer === 'A' ? 9 : 10;
      const shift = h.layer === 'B' ? -12 : 0;
      expected.push([0x90 | ch, key + t + shift, externVelocity(100, 1, h.gain)]);
    }
    assert.deepEqual(sent, expected, `key ${key}`);
    sent.length = 0;
    router.handle({ type: 'noteOff', note: key, source: 'pointer' });
    assert.deepEqual(sent, expected.map((m) => [m[0]! - 0x10, m[1], 0]), `key ${key} off`);
  }
});

test('notes: outside 0..127 after the shift they are dropped; the velocity curve; MIDI input only with echo', () => {
  const { store, out, extern, sent } = setup();
  out.update({ portId: 'p', extern: true });
  store.setMany([[externKey('A', 'octaveShift'), 2], [externKey('A', 'externVelCurve'), 2]], 'ui');
  extern.handle({ type: 'noteOn', key: 120, note: 120, velocity: 100, layers: [{ layer: 'A', gain: 1 }], source: 'pointer' });
  assert.deepEqual(sent, [], '120 + 24 is above 127');
  extern.handle({ type: 'noteOn', key: 60, note: 60, velocity: 100, layers: [{ layer: 'A', gain: 1 }], source: 'computer' });
  assert.deepEqual(sent, [[0x9c, 84, externVelocity(100, 2)]]);
  sent.length = 0;
  extern.handle({ type: 'noteOn', key: 62, note: 62, velocity: 100, layers: [{ layer: 'A', gain: 1 }], source: 'midi' });
  extern.handle({ type: 'noteOn', key: 63, note: 63, velocity: 100, layers: [{ layer: 'A', gain: 1 }] });
  assert.deepEqual(sent, [], 'echo midi in is off by default (p.63); an event without a source counts as MIDI');
  out.update({ echoToExtern: true });
  extern.handle({ type: 'noteOn', key: 62, note: 62, velocity: 100, layers: [{ layer: 'A', gain: 1 }], source: 'midi' });
  assert.equal(sent.length, 1);
  out.update({ echoToExtern: false });
  extern.handle({ type: 'noteOff', key: 62, note: 62 });
  assert.deepEqual(sent.at(-1), [0x8c, 86, 0], 'the note off of a sent note goes out without echo');
});

test('a layer that is not extern sends nothing; switching extern off ends its notes', () => {
  const { store, out, extern, sent } = setup(['A', 'B']);
  store.set(externKey('B', 'externEnable'), 0, 'ui');
  out.update({ portId: 'p', extern: true });
  extern.handle({ type: 'noteOn', key: 60, note: 60, velocity: 100,
    layers: [{ layer: 'A', gain: 1 }, { layer: 'B', gain: 1 }], source: 'pointer' });
  assert.deepEqual(sent, [[0x9c, 60, 100]]);
  sent.length = 0;
  store.set(externKey('A', 'externEnable'), 0, 'ui');
  extern.applyChanges([{ key: externKey('A', 'externEnable'), value: 0, previous: 1, origin: 'ui' }]);
  assert.deepEqual(sent, [[0x8c, 60, 0]]);
  extern.handle({ type: 'noteOff', key: 60, note: 60 });
  assert.equal(sent.length, 1, 'no second note off');
});

test('sustain and pitch bend by the layer switches; wheel, pressure and pedal by the device enables', () => {
  const { store, out, extern, sent } = setup(['A', 'B']);
  out.update({ portId: 'p', extern: true });
  store.setMany([[externKey('B', 'sustainEnable'), 0], [externKey('B', 'pStickEnable'), 0],
    [externKey('B', 'externModWheelEnable'), 0], [externKey('A', 'externAftertouchEnable'), 0]], 'ui');
  out.play({ type: 'sustain', on: true }, 'pointer');
  out.play({ type: 'bend', value: 0 }, 'pointer');
  out.play({ type: 'controller', kind: 'wheel', value: 10 }, 'screen');
  out.play({ type: 'controller', kind: 'pressure', value: 20 }, 'screen');
  out.play({ type: 'controller', kind: 'pedal', value: 30 }, 'screen');
  assert.deepEqual(sent, [
    [0xbc, 64, 127], [0xec, 0, 64], [0xbc, 1, 10], [0xdd, 20], [0xbc, 11, 30], [0xbd, 11, 30],
  ]);
  sent.length = 0;
  store.set(externKey('A', 'sustainEnable'), 0, 'ui');
  out.play({ type: 'sustain', on: false }, 'pointer');
  assert.deepEqual(sent, [[0xbc, 64, 0]], 'sustain off reaches the channel it went on, whatever the switch now');
  sent.length = 0;
  out.play({ type: 'controller', kind: 'wheel', value: 99 }); // MIDI input (no source)
  extern.handle({ type: 'controller', kind: 'wheel', value: 98 }); // the tee's copy is ignored
  assert.deepEqual(sent, [], 'no echo without echo midi in');
  out.update({ echoToExtern: true });
  out.play({ type: 'controller', kind: 'wheel', value: 99 }, 'midi');
  assert.deepEqual(sent, [[0xbc, 1, 99]]);
});

test('program data: bank select (unless "--"), program change, CCs and CC7 on edits; never what came in over MIDI', () => {
  const { store, morphed, out, extern, sent } = setup();
  out.update({ portId: 'p', extern: true, externChannels: { A: 1, B: 14, C: 15 } });
  const apply = (entries: Array<readonly [Ns4Key, number]>, origin: 'ui' | 'midi' = 'ui'): void => {
    const un = store.onChange((b) => extern.applyChanges(morphed.expand(b)));
    store.setMany(entries, origin);
    un();
  };
  apply([[externKey('A', 'externPCValue'), 12]]);
  assert.deepEqual(sent, [[0xc0, 12]], 'bank select "--" by default');
  sent.length = 0;
  apply([[externKey('A', 'externBCValue_MSB'), 1], [externKey('A', 'externBCValue_LSB'), 6]]);
  assert.deepEqual(sent, [[0xb0, 0, 0], [0xb0, 32, 5], [0xc0, 12]], 'one program message for the batch');
  sent.length = 0;
  apply([[externKey('A', 'externCCValue1'), 77]]);
  assert.deepEqual(sent, [[0xb0, 2, 77]], 'CC number 1 by default raw 3 = CC 2');
  sent.length = 0;
  apply([[externKey('A', 'externCCNumber2'), 75]]);
  assert.deepEqual(sent, [[0xb0, 74, store.get(externKey('A', 'externCCValue2'))]]);
  sent.length = 0;
  apply([[externKey('A', 'externCCNumber1'), 0]]);
  assert.deepEqual(sent, [], 'a CC number off sends nothing');
  apply([['synth.layerLevelSynA', 90]]);
  assert.deepEqual(sent, [[0xb0, 7, 90]], 'the layer level as CC7 (p.47)');
  sent.length = 0;
  apply([[externKey('A', 'externPCValue'), 13], ['synth.layerLevelSynA', 91]], 'midi');
  assert.deepEqual(sent, [], 'MIDI input is not sent back');
});

test('morphs: an extern CC value goes out at its effective value as a morph source moves (M p.39)', () => {
  const { store, morphed, out, extern, sent } = setup();
  out.update({ portId: 'p', extern: true });
  store.setMany([[externKey('A', 'externCCValue1'), 20], ['synthA.externCCValue1.morphWheel' as Ns4Key, 40]], 'ui');
  sent.length = 0;
  extern.applyChanges(morphed.move('wheel', 1));
  assert.deepEqual(sent, [[0xbc, 2, 60]]);
});

test('send on load: bank select, program change, CC7 and both CCs for extern layers on in the active scene', () => {
  const { store, out, extern, sent } = setup(['A', 'B']);
  out.update({ portId: 'p', extern: true });
  const load = (entries: Array<readonly [Ns4Key, number]>): void => {
    const batch: Change[] = [];
    const un = store.onChange((b) => batch.push(...b));
    store.setMany(entries, 'load');
    un();
    extern.applyChanges(batch.length > 0 ? batch : [{ key: 'common.layerScene', value: 0, previous: 0, origin: 'load' }]);
  };
  load([[externKey('A', 'externSendOnLoad'), 1], [externKey('A', 'externPCValue'), 4], [externKey('A', 'externBCValue_MSB'), 3],
    [externKey('A', 'externCCValue1'), 11], [externKey('A', 'externCCNumber2'), 8], [externKey('A', 'externCCValue2'), 22],
    ['synth.layerLevelSynA', 100], [externKey('B', 'externSendOnLoad'), 0]]);
  assert.deepEqual(sent, [[0xbc, 0, 2], [0xcc, 4], [0xbc, 7, 100], [0xbc, 2, 11], [0xbc, 7, 22]]);
  sent.length = 0;
  // Layer A off in the active scene: nothing on load.
  store.setMany([layerToggle(store, 'synth', 'A', false, 'I')], 'ui');
  load([[externKey('A', 'externPCValue'), 5]]);
  assert.deepEqual(sent, []);
});

test('panic and loads end every extern note and sustain', () => {
  const { out, extern, sent } = setup(['A', 'C']);
  out.update({ portId: 'p', extern: true });
  extern.handle({ type: 'noteOn', key: 60, note: 60, velocity: 100,
    layers: [{ layer: 'A', gain: 1 }, { layer: 'C', gain: 1 }], source: 'pointer' });
  out.play({ type: 'sustain', on: true }, 'computer');
  sent.length = 0;
  extern.panic();
  assert.deepEqual(sent, [[0x8c, 60, 0], [0x8e, 60, 0], [0xbc, 64, 0], [0xbe, 64, 0]]);
  sent.length = 0;
  extern.panic();
  assert.deepEqual(sent, []);
  // The tee hands reload as a panic to the sink.
  const engine = teeSection(silent, extern);
  extern.handle({ type: 'noteOn', key: 61, note: 61, velocity: 100, layers: [{ layer: 'A', gain: 1 }], source: 'pointer' });
  sent.length = 0;
  engine.reload();
  assert.deepEqual(sent, [[0x8c, 61, 0]]);
  // MidiOut's panic then sends CC123 and CC64 0 on the extern channels it started notes on.
  sent.length = 0;
  out.panic();
  assert.deepEqual(sent, [[0xbc, 123, 0], [0xbc, 64, 0], [0xbe, 123, 0], [0xbe, 64, 0]]);
});
