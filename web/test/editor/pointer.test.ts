/** AC 5: the virtual keyboard's pointer logic (plan section 7). */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PlayBus, type PlayEvent } from '../../src/editor/input/events.ts';
import { PointerNotes, velocityFromY } from '../../src/editor/input/pointer.ts';

function setup(): { notes: PointerNotes; events: PlayEvent[] } {
  const bus = new PlayBus();
  const events: PlayEvent[] = [];
  bus.on((e) => events.push(e));
  return { notes: new PointerNotes(bus), events };
}

test('velocity from y: top soft, bottom loud, clamped to 1–127', () => {
  assert.equal(velocityFromY(100, 100, 96), 1);
  assert.equal(velocityFromY(196, 100, 96), 127);
  assert.equal(velocityFromY(148, 100, 96), 64);
  assert.equal(velocityFromY(0, 100, 96), 1); // above the key
  assert.equal(velocityFromY(500, 100, 96), 127); // below the key
  let last = 0;
  for (let y = 100; y <= 196; y += 4) {
    const v = velocityFromY(y, 100, 96);
    assert.ok(v >= last && v >= 1 && v <= 127, `y ${y}: ${v}`);
    last = v;
  }
  assert.equal(velocityFromY(10, 0, 0), 64); // degenerate key
  assert.equal(velocityFromY(Number.NaN, 0, 96), 64);
});

test('down plays the note with its velocity; up releases it', () => {
  const { notes, events } = setup();
  notes.down(1, 60, 90);
  notes.up(1);
  assert.deepEqual(events, [
    { type: 'noteOn', note: 60, velocity: 90, source: 'pointer' },
    { type: 'noteOff', note: 60, source: 'pointer' },
  ]);
});

test('two pointers hold two notes at once', () => {
  const { notes, events } = setup();
  notes.down(1, 60, 80);
  notes.down(2, 64, 100);
  assert.deepEqual([...notes.notes].sort(), [60, 64]);
  assert.equal(notes.activePointers, 2);
  notes.up(1);
  assert.deepEqual([...notes.notes], [64]);
  notes.up(2);
  assert.deepEqual(events.map((e) => `${e.type}:${'note' in e ? e.note : ''}`), ['noteOn:60', 'noteOn:64', 'noteOff:60', 'noteOff:64']);
});

test('two pointers on the same key: one note, released when the last lets go', () => {
  const { notes, events } = setup();
  notes.down(1, 60, 80);
  notes.down(2, 60, 100);
  notes.up(1);
  assert.equal(events.length, 1);
  notes.up(2);
  assert.deepEqual(events.map((e) => e.type), ['noteOn', 'noteOff']);
});

test('cancel releases like up', () => {
  const { notes, events } = setup();
  notes.down(7, 62, 50);
  notes.cancel(7);
  assert.deepEqual(events.at(-1), { type: 'noteOff', note: 62, source: 'pointer' });
  assert.equal(notes.activePointers, 0);
  notes.cancel(7);
  notes.up(7);
  assert.equal(events.length, 2);
});

test('move across keys releases the old note and starts the new one', () => {
  const { notes, events } = setup();
  notes.down(1, 60, 70);
  notes.move(1, 60, 120); // same key: nothing
  notes.move(1, 62, 110);
  notes.move(1, 64, 30);
  notes.up(1);
  assert.deepEqual(events, [
    { type: 'noteOn', note: 60, velocity: 70, source: 'pointer' },
    { type: 'noteOff', note: 60, source: 'pointer' },
    { type: 'noteOn', note: 62, velocity: 110, source: 'pointer' },
    { type: 'noteOff', note: 62, source: 'pointer' },
    { type: 'noteOn', note: 64, velocity: 30, source: 'pointer' },
    { type: 'noteOff', note: 64, source: 'pointer' },
  ]);
});

test('moving off the keys releases; moving back on while still down plays again', () => {
  const { notes, events } = setup();
  notes.down(1, 60, 70);
  notes.move(1, null, 64);
  assert.deepEqual(events.at(-1), { type: 'noteOff', note: 60, source: 'pointer' });
  notes.move(1, 65, 90);
  assert.deepEqual(events.at(-1), { type: 'noteOn', note: 65, velocity: 90, source: 'pointer' });
  notes.up(1);
  assert.equal(events.length, 4);
});

test('moves of pointers that are not down (hover) play nothing', () => {
  const { notes, events } = setup();
  notes.move(3, 60, 100);
  notes.down(3, 60, 100);
  notes.up(3);
  notes.move(3, 62, 100);
  assert.deepEqual(events.map((e) => e.type), ['noteOn', 'noteOff']);
});

test('gliding from one pointer\'s key onto another\'s keeps the shared note until both leave', () => {
  const { notes, events } = setup();
  notes.down(1, 60, 80);
  notes.down(2, 62, 80);
  notes.move(2, 60, 80); // 62 off, 60 already sounding
  notes.up(1); // 60 still held by pointer 2
  assert.deepEqual([...notes.notes], [60]);
  notes.up(2);
  assert.deepEqual(events.map((e) => `${e.type}:${'note' in e ? e.note : ''}`), ['noteOn:60', 'noteOn:62', 'noteOff:62', 'noteOff:60']);
});

test('velocity outside 1–127 is clamped; notes outside 0–127 are ignored', () => {
  const { notes, events } = setup();
  notes.down(1, 60, 0);
  notes.down(2, 61, 300);
  notes.down(3, 128, 100);
  assert.deepEqual(events.map((e) => e.type === 'noteOn' && e.velocity), [1, 127]);
  notes.move(3, 70, 100); // pointer 3 is down; gliding onto a valid key plays
  assert.deepEqual(events.at(-1), { type: 'noteOn', note: 70, velocity: 100, source: 'pointer' });
});

test('releaseAll releases every pointer', () => {
  const { notes, events } = setup();
  notes.down(1, 60, 80);
  notes.down(2, 64, 80);
  notes.down(3, 67, 80);
  events.length = 0;
  notes.releaseAll();
  assert.deepEqual(events.map((e) => (e.type === 'noteOff' ? e.note : -1)).sort((x, y) => x - y), [60, 64, 67]);
  assert.equal(notes.activePointers, 0);
  assert.equal(notes.notes.size, 0);
});
