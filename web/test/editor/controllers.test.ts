/**
 * Plan section 15.2 (builder B2): the on-screen wheel, pressure strip and control pedal emit the
 * play events MIDI CC1, channel pressure and CC11 emit; pressure springs back on release; MIDI
 * moves show on the strip without being emitted again; panic returns every control to 0.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CONTROLLER_KINDS, controllerValue, ScreenControllers } from '../../src/editor/input/controllers.ts';
import { type PlayEvent, PlayBus } from '../../src/editor/input/events.ts';
import { parseMidiMessage, toPlayEvents } from '../../src/editor/midi/parser.ts';

function setup() {
  const bus = new PlayBus();
  const events: PlayEvent[] = [];
  bus.on((e) => events.push(e));
  const c = new ScreenControllers(bus);
  const seen: Array<[string, number]> = [];
  c.onChange((kind, value) => seen.push([kind, value]));
  return { bus, events, c, seen };
}

test('set emits one controller event per change, with the value clamped and rounded to 0..127', () => {
  const { events, c, seen } = setup();
  assert.deepEqual(CONTROLLER_KINDS, ['wheel', 'pressure', 'pedal']);
  c.set('wheel', 64);
  c.set('wheel', 64);
  c.set('pedal', 200);
  c.set('pressure', 10.6);
  c.set('pressure', -3);
  assert.deepEqual(events, [
    { type: 'controller', kind: 'wheel', value: 64 },
    { type: 'controller', kind: 'pedal', value: 127 },
    { type: 'controller', kind: 'pressure', value: 11 },
    { type: 'controller', kind: 'pressure', value: 0 },
  ]);
  assert.deepEqual(seen, [['wheel', 64], ['pedal', 127], ['pressure', 11], ['pressure', 0]]);
  assert.equal(c.value('wheel'), 64);
  assert.equal(c.value('pedal'), 127);
  assert.equal(controllerValue(Number.NaN), 0);
});

test('release springs the pressure strip back to 0; the wheel and the pedal stay', () => {
  const { events, c } = setup();
  c.set('pressure', 90);
  c.set('wheel', 30);
  c.set('pedal', 50);
  events.length = 0;
  c.release('wheel');
  c.release('pedal');
  assert.deepEqual(events, []);
  c.release('pressure');
  assert.deepEqual(events, [{ type: 'controller', kind: 'pressure', value: 0 }]);
  c.release('pressure');
  assert.equal(events.length, 1, 'already at rest: nothing more');
  assert.deepEqual([c.value('wheel'), c.value('pedal'), c.value('pressure')], [30, 50, 0]);
});

test('attached, MIDI moves show on the strip without a second event; panic rests every control', () => {
  const { bus, events, c, seen } = setup();
  const detach = c.attach(bus);
  for (const data of [[0xb0, 1, 100], [0xd3, 70], [0xb0, 11, 20]]) {
    const e = parseMidiMessage(Uint8Array.from(data));
    assert.ok(e !== null);
    for (const p of toPlayEvents(e)) bus.emit(p);
  }
  assert.deepEqual([c.value('wheel'), c.value('pressure'), c.value('pedal')], [100, 70, 20]);
  assert.equal(events.length, 3, 'only the three MIDI events');
  assert.deepEqual(seen, [['wheel', 100], ['pressure', 70], ['pedal', 20]]);
  c.set('wheel', 100);
  assert.equal(events.length, 3, 'the strip already shows the MIDI value');
  bus.emit({ type: 'panic' });
  assert.deepEqual([c.value('wheel'), c.value('pressure'), c.value('pedal')], [0, 0, 0]);
  assert.equal(events.length, 4, 'panic itself, no controller events');
  detach();
  bus.emit({ type: 'controller', kind: 'wheel', value: 5 });
  assert.equal(c.value('wheel'), 0, 'detached');
});

test('a failing strip listener does not stop the event', () => {
  const { events, c } = setup();
  c.onChange(() => {
    throw new Error('strip');
  });
  assert.throws(() => c.set('wheel', 3), /strip/);
  assert.deepEqual(events, [{ type: 'controller', kind: 'wheel', value: 3 }]);
});
