/** Plan section 2, AC 8: the note sources merge into one stream; one source never ends another's note. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NoteMerge, type NoteSource, type PlayEvent } from '../../src/editor/input/events.ts';

const on = (note: number, source: NoteSource, velocity = 100): PlayEvent => ({ type: 'noteOn', note, velocity, source });
const off = (note: number, source: NoteSource): PlayEvent => ({ type: 'noteOff', note, source });

test('a note held by a computer key survives a pointer press and release on the same note', () => {
  const m = new NoteMerge();
  assert.deepEqual(m.handle(on(60, 'computer', 90)), [on(60, 'computer', 90)]);
  assert.deepEqual(m.handle(on(60, 'pointer', 30)), [], 'no restrike from the second holder');
  assert.deepEqual(m.handle(off(60, 'pointer')), [], 'the pointer release does not end the note');
  assert.deepEqual([...m.notes], [60]);
  assert.deepEqual(m.handle(off(60, 'computer')), [off(60, 'computer')]);
  assert.deepEqual([...m.notes], []);
});

test('the first press gives the velocity; the last release passes, whichever source it is', () => {
  const m = new NoteMerge();
  assert.deepEqual(m.handle(on(64, 'midi', 20)), [on(64, 'midi', 20)]);
  assert.deepEqual(m.handle(on(64, 'computer', 127)), []);
  assert.deepEqual(m.handle(off(64, 'midi')), []);
  assert.deepEqual(m.handle(off(64, 'computer')), [off(64, 'computer')]);
});

test('two holders of one source release one at a time', () => {
  const m = new NoteMerge();
  m.handle(on(60, 'computer'));
  assert.deepEqual(m.handle(on(60, 'computer')), []);
  assert.deepEqual(m.handle(off(60, 'computer')), []);
  assert.deepEqual(m.handle(off(60, 'computer')), [off(60, 'computer')]);
});

test('MIDI repeating a note on holds it once: one note off ends it', () => {
  const m = new NoteMerge();
  m.handle(on(60, 'midi'));
  assert.deepEqual(m.handle(on(60, 'midi')), []);
  assert.deepEqual(m.handle(off(60, 'midi')), [off(60, 'midi')]);
});

test('a release by a source that does not hold the note is absorbed', () => {
  const m = new NoteMerge();
  assert.deepEqual(m.handle(off(60, 'computer')), []);
  m.handle(on(60, 'computer'));
  assert.deepEqual(m.handle(off(60, 'pointer')), []);
  assert.deepEqual([...m.notes], [60]);
});

test('panic passes and forgets every holder; later releases are absorbed, new presses play', () => {
  const m = new NoteMerge();
  m.handle(on(60, 'computer'));
  m.handle(on(60, 'pointer'));
  m.handle(on(62, 'midi'));
  assert.deepEqual(m.handle({ type: 'panic' }), [{ type: 'panic' }]);
  assert.deepEqual([...m.notes], []);
  assert.deepEqual(m.handle(off(60, 'computer')), []);
  assert.deepEqual(m.handle(off(62, 'midi')), []);
  assert.deepEqual(m.handle(on(60, 'computer')), [on(60, 'computer')]);
});

test('sustain, bend and controllers pass unchanged', () => {
  const m = new NoteMerge();
  for (const e of [
    { type: 'sustain', on: true },
    { type: 'bend', value: -100 },
    { type: 'controller', kind: 'wheel', value: 64 },
  ] satisfies PlayEvent[]) assert.deepEqual(m.handle(e), [e]);
});
