/** AC 7: MIDI messages → channel events → play events (omni; system and SysEx ignored). */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseMidiMessage, toPlayEvents } from '../../src/editor/midi/parser.ts';

const msg = (...bytes: number[]): Uint8Array => new Uint8Array(bytes);
const play = (...bytes: number[]) => {
  const e = parseMidiMessage(msg(...bytes));
  return e === null ? null : toPlayEvents(e);
};

test('note on with velocity plays on every channel (omni)', () => {
  assert.deepEqual(parseMidiMessage(msg(0x90, 60, 100)), { type: 'noteOn', channel: 0, note: 60, velocity: 100 });
  assert.deepEqual(parseMidiMessage(msg(0x9f, 21, 1)), { type: 'noteOn', channel: 15, note: 21, velocity: 1 });
  assert.deepEqual(play(0x93, 64, 127), [{ type: 'noteOn', note: 64, velocity: 127, source: 'midi' }]);
});

test('note off, and note on with velocity 0 is a note off', () => {
  assert.deepEqual(parseMidiMessage(msg(0x80, 60, 64)), { type: 'noteOff', channel: 0, note: 60 });
  assert.deepEqual(parseMidiMessage(msg(0x95, 60, 0)), { type: 'noteOff', channel: 5, note: 60 });
  assert.deepEqual(play(0x90, 60, 0), [{ type: 'noteOff', note: 60, source: 'midi' }]);
  assert.deepEqual(play(0x8a, 72, 0), [{ type: 'noteOff', note: 72, source: 'midi' }]);
});

test('CC64 sustain: on at 64 and above, off below', () => {
  assert.deepEqual(play(0xb0, 64, 127), [{ type: 'sustain', on: true }]);
  assert.deepEqual(play(0xb0, 64, 64), [{ type: 'sustain', on: true }]);
  assert.deepEqual(play(0xb0, 64, 63), [{ type: 'sustain', on: false }]);
  assert.deepEqual(play(0xb7, 64, 0), [{ type: 'sustain', on: false }]);
});

test('CC1 mod wheel, CC11 expression pedal, channel pressure', () => {
  assert.deepEqual(play(0xb0, 1, 90), [{ type: 'controller', kind: 'wheel', value: 90 }]);
  assert.deepEqual(play(0xb2, 11, 33), [{ type: 'controller', kind: 'pedal', value: 33 }]);
  assert.deepEqual(parseMidiMessage(msg(0xd4, 77)), { type: 'pressure', channel: 4, value: 77 });
  assert.deepEqual(play(0xd0, 77), [{ type: 'controller', kind: 'pressure', value: 77 }]);
});

test('14-bit pitch bend: centre 0x2000 is 0, extremes -8192 and 8191', () => {
  assert.deepEqual(play(0xe0, 0x00, 0x40), [{ type: 'bend', value: 0 }]);
  assert.deepEqual(play(0xe0, 0x00, 0x00), [{ type: 'bend', value: -8192 }]);
  assert.deepEqual(play(0xe0, 0x7f, 0x7f), [{ type: 'bend', value: 8191 }]);
  // LSB first: 0x01 + 0x40 << 7 = 8193 → +1
  assert.deepEqual(play(0xe1, 0x01, 0x40), [{ type: 'bend', value: 1 }]);
});

test('CC120 all sound off and CC123 all notes off → panic', () => {
  assert.deepEqual(play(0xb0, 120, 0), [{ type: 'panic' }]);
  assert.deepEqual(play(0xbf, 123, 0), [{ type: 'panic' }]);
});

test('other controllers give no play event', () => {
  assert.deepEqual(play(0xb0, 7, 100), []);
  assert.deepEqual(play(0xb0, 74, 100), []);
});

test('system messages and SysEx are ignored', () => {
  assert.equal(parseMidiMessage(msg(0xf0, 0x33, 0x7f, 0x01, 0xf7)), null); // SysEx
  for (const status of [0xf1, 0xf2, 0xf3, 0xf6, 0xf8, 0xfa, 0xfb, 0xfc, 0xfe, 0xff]) {
    assert.equal(parseMidiMessage(msg(status, 0, 0)), null, status.toString(16));
  }
});

test('unused and malformed messages are ignored', () => {
  assert.equal(parseMidiMessage(msg()), null);
  assert.equal(parseMidiMessage(msg(0x40, 60, 100)), null); // data byte without status
  assert.equal(parseMidiMessage(msg(0x90, 60)), null); // truncated
  assert.equal(parseMidiMessage(msg(0x90, 0x80, 100)), null); // status byte where data belongs
  assert.equal(parseMidiMessage(msg(0xa0, 60, 50)), null); // polyphonic aftertouch
  assert.equal(parseMidiMessage(msg(0xc0, 5)), null); // program change
});
