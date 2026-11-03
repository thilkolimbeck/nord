/**
 * Plan section 2: notes wait for audio; released first, they are dropped; MIDI notes are ignored
 * until audio runs; the latest sustain, bend and controllers wait and are replayed first.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NoteGate } from '../../src/editor/audio/gate.ts';

test('while audio does not run, key and pointer notes wait and play when it runs', () => {
  const g = new NoteGate();
  assert.deepEqual(g.handle({ type: 'noteOn', note: 60, velocity: 100, source: 'computer' }, false), []);
  assert.deepEqual(g.handle({ type: 'noteOn', note: 64, velocity: 90, source: 'pointer' }, false), []);
  assert.deepEqual(g.flush().map((e) => (e.type === 'noteOn' ? e.note : null)), [60, 64]);
  assert.equal(g.size, 0);
});

test('a note released before audio runs is dropped; panic clears; MIDI is ignored', () => {
  const g = new NoteGate();
  g.handle({ type: 'noteOn', note: 60, velocity: 100, source: 'computer' }, false);
  g.handle({ type: 'noteOff', note: 60, source: 'computer' }, false);
  g.handle({ type: 'noteOn', note: 61, velocity: 100, source: 'midi' }, false);
  assert.equal(g.size, 0);
  g.handle({ type: 'noteOn', note: 62, velocity: 100, source: 'pointer' }, false);
  g.handle({ type: 'panic' }, false);
  assert.deepEqual(g.flush(), []);
});

test('while running everything passes through', () => {
  const g = new NoteGate();
  const e = { type: 'sustain', on: true } as const;
  assert.deepEqual(g.handle(e, true), [e]);
  assert.deepEqual(g.handle({ type: 'noteOn', note: 1, velocity: 1, source: 'midi' }, true).length, 1);
});

test('the latest sustain, bend and controllers wait and are replayed before the notes', () => {
  const g = new NoteGate();
  g.handle({ type: 'sustain', on: false }, false);
  g.handle({ type: 'noteOn', note: 60, velocity: 100, source: 'computer' }, false);
  g.handle({ type: 'sustain', on: true }, false);
  g.handle({ type: 'bend', value: 100 }, false);
  g.handle({ type: 'bend', value: -200 }, false);
  g.handle({ type: 'controller', kind: 'wheel', value: 10 }, false);
  g.handle({ type: 'controller', kind: 'pedal', value: 90 }, false);
  g.handle({ type: 'controller', kind: 'wheel', value: 40 }, false);
  assert.deepEqual(g.flush(), [
    { type: 'sustain', on: true },
    { type: 'bend', value: -200 },
    { type: 'controller', kind: 'wheel', value: 40 },
    { type: 'controller', kind: 'pedal', value: 90 },
    { type: 'noteOn', note: 60, velocity: 100, source: 'computer' },
  ]);
  assert.deepEqual(g.flush(), [], 'empty after a flush');
});

test('MIDI sustain before audio runs is kept although MIDI notes are not', () => {
  const g = new NoteGate();
  g.handle({ type: 'noteOn', note: 60, velocity: 100, source: 'midi' }, false);
  g.handle({ type: 'sustain', on: true }, false);
  assert.deepEqual(g.flush(), [{ type: 'sustain', on: true }]);
});

test('panic forgets the kept sustain, bend and controllers', () => {
  const g = new NoteGate();
  g.handle({ type: 'sustain', on: true }, false);
  g.handle({ type: 'bend', value: 500 }, false);
  g.handle({ type: 'controller', kind: 'pressure', value: 70 }, false);
  g.handle({ type: 'panic' }, false);
  assert.deepEqual(g.flush(), []);
});
