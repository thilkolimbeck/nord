/** AC 6: computer keys as a two-row piano (plan section 7), plus release on hide (AC 8). */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BLACK_CODES, ComputerKeys, keyLabels, keyboardAriaLabel, legendText, noteName, NOTE_CODES, OCTAVE_DOWN, OCTAVE_UP,
  semitoneFor, shouldIgnore, usLabels, WHITE_CODES, type KeyLike, type TargetLike,
} from '../../src/editor/input/computer-keys.ts';
import { HeldNotes, PlayBus, type PlayEvent } from '../../src/editor/input/events.ts';
import { bindReleaseOnHide } from '../../src/editor/input/hide.ts';

function key(code: string, extra: Partial<KeyLike> = {}): KeyLike {
  return { code, repeat: false, metaKey: false, ctrlKey: false, altKey: false, ...extra };
}

function setup(opts: ConstructorParameters<typeof ComputerKeys>[1] = {}): { keys: ComputerKeys; events: PlayEvent[] } {
  const bus = new PlayBus();
  const events: PlayEvent[] = [];
  bus.on((e) => events.push(e));
  return { keys: new ComputerKeys(bus, opts), events };
}

const DIV: TargetLike = { tagName: 'DIV' };

test('16 codes map to semitones: A–L white keys, W E T Y U O P black keys', () => {
  const expected: Record<string, number> = {
    KeyA: 0, KeyW: 1, KeyS: 2, KeyE: 3, KeyD: 4, KeyF: 5, KeyT: 6, KeyG: 7,
    KeyY: 8, KeyH: 9, KeyU: 10, KeyJ: 11, KeyK: 12, KeyO: 13, KeyL: 14, KeyP: 15,
  };
  assert.equal(NOTE_CODES.length, 16);
  assert.equal(WHITE_CODES.length, 9);
  assert.equal(Object.keys(BLACK_CODES).length, 7);
  for (const [code, semi] of Object.entries(expected)) assert.equal(semitoneFor(code), semi, code);
  for (const code of ['KeyQ', 'KeyR', 'KeyI', 'KeyZ', 'KeyX', 'Semicolon', 'Space', 'Digit1']) assert.equal(semitoneFor(code), null, code);
});

test('each code plays its note at velocity 100 from C4, and keyup releases it', () => {
  const { keys, events } = setup();
  for (const code of NOTE_CODES) {
    assert.equal(keys.keyDown(key(code), DIV), true);
    assert.equal(keys.keyUp(key(code)), true);
  }
  const ons = events.filter((e) => e.type === 'noteOn');
  assert.deepEqual(ons.map((e) => e.note), NOTE_CODES.map((c) => 60 + semitoneFor(c)!));
  assert.ok(ons.every((e) => e.velocity === 100 && e.source === 'computer'));
  assert.equal(events.filter((e) => e.type === 'noteOff').length, 16);
});

test('Z and X shift the octave within the limits', () => {
  const { keys, events } = setup();
  const seen: number[] = [];
  keys.onOctave((o) => seen.push(o));
  assert.equal(keys.keyDown(key(OCTAVE_UP), DIV), true);
  assert.equal(keys.octave, 1);
  keys.keyDown(key('KeyA'), DIV);
  assert.deepEqual(events.at(-1), { type: 'noteOn', note: 72, velocity: 100, source: 'computer' });
  keys.keyUp(key('KeyA'));
  for (let i = 0; i < 10; i++) keys.keyDown(key(OCTAVE_UP), DIV);
  assert.equal(keys.octave, 3);
  for (let i = 0; i < 10; i++) keys.keyDown(key(OCTAVE_DOWN), DIV);
  assert.equal(keys.octave, -3);
  keys.keyDown(key('KeyA'), DIV);
  assert.equal((events.at(-1) as { note: number }).note, 24);
  assert.deepEqual(seen, [1, 2, 3, 2, 1, 0, -1, -2, -3]);
  // octave keys emit nothing on the bus
  assert.equal(events.filter((e) => e.type !== 'noteOn' && e.type !== 'noteOff').length, 0);
});

test('custom octave limits apply', () => {
  const { keys } = setup({ minOctave: -1, maxOctave: 1 });
  keys.setOctave(5);
  assert.equal(keys.octave, 1);
  keys.setOctave(-5);
  assert.equal(keys.octave, -1);
});

test('auto-repeat is swallowed without a new note or octave step', () => {
  const { keys, events } = setup();
  keys.keyDown(key('KeyA'), DIV);
  assert.equal(keys.keyDown(key('KeyA', { repeat: true }), DIV), true);
  assert.equal(keys.keyDown(key(OCTAVE_UP, { repeat: true }), DIV), true);
  assert.equal(keys.octave, 0);
  assert.equal(events.length, 1);
  assert.equal(shouldIgnore(key('KeyA', { repeat: true }), DIV), true);
});

test('Cmd, Ctrl and Alt chords are ignored', () => {
  const { keys, events } = setup();
  for (const mod of ['metaKey', 'ctrlKey', 'altKey'] as const) {
    assert.equal(keys.keyDown(key('KeyS', { [mod]: true }), DIV), false, mod);
    assert.equal(keys.keyDown(key(OCTAVE_UP, { [mod]: true }), DIV), false, mod);
    assert.equal(shouldIgnore(key('KeyS', { [mod]: true }), DIV), true);
  }
  assert.equal(events.length, 0);
  assert.equal(keys.octave, 0);
  // without the modifier the same key plays
  assert.equal(keys.keyDown(key('KeyS'), DIV), true);
});

test('typing in text inputs, textareas, selects and contenteditable is ignored; range inputs and buttons play', () => {
  const ignored: TargetLike[] = [
    { tagName: 'INPUT', type: 'text' }, { tagName: 'INPUT' }, { tagName: 'INPUT', type: 'search' },
    { tagName: 'INPUT', type: 'number' }, { tagName: 'TEXTAREA' }, { tagName: 'SELECT' },
    { tagName: 'DIV', isContentEditable: true }, { tagName: 'input', type: 'email' },
  ];
  const playing: Array<TargetLike | null> = [
    null, DIV, { tagName: 'INPUT', type: 'range' }, { tagName: 'BUTTON' }, { tagName: 'INPUT', type: 'checkbox' }, { tagName: 'BODY' },
  ];
  for (const t of ignored) {
    const { keys, events } = setup();
    assert.equal(keys.keyDown(key('KeyA'), t), false, JSON.stringify(t));
    assert.equal(keys.keyDown(key(OCTAVE_UP), t), false, JSON.stringify(t));
    assert.equal(events.length, 0);
    assert.equal(shouldIgnore(key('KeyA'), t), true);
  }
  for (const t of playing) {
    const { keys, events } = setup();
    assert.equal(keys.keyDown(key('KeyA'), t), true, JSON.stringify(t));
    assert.equal(events.length, 1);
    assert.equal(shouldIgnore(key('KeyA'), t), false);
  }
});

test('keys outside the piano are not handled', () => {
  const { keys, events } = setup();
  for (const code of ['KeyQ', 'Space', 'Tab', 'Escape', 'ArrowLeft', 'Enter']) assert.equal(keys.keyDown(key(code), DIV), false, code);
  assert.equal(keys.keyUp(key('KeyQ')), false);
  assert.equal(events.length, 0);
});

test('keyup after an octave change releases the originally sounded note', () => {
  const { keys, events } = setup();
  keys.keyDown(key('KeyD'), DIV); // E4 = 64
  keys.keyDown(key(OCTAVE_UP), DIV);
  keys.keyDown(key(OCTAVE_UP), DIV);
  keys.keyUp(key('KeyD'));
  assert.deepEqual(events, [
    { type: 'noteOn', note: 64, velocity: 100, source: 'computer' },
    { type: 'noteOff', note: 64, source: 'computer' },
  ]);
  keys.keyDown(key('KeyD'), DIV);
  assert.equal((events.at(-1) as { note: number }).note, 88);
});

test('a second keydown without keyup does not stack notes', () => {
  const { keys, events } = setup();
  keys.keyDown(key('KeyA'), DIV);
  keys.keyDown(key('KeyA'), DIV);
  keys.keyUp(key('KeyA'));
  keys.keyUp(key('KeyA'));
  assert.deepEqual(events.map((e) => e.type), ['noteOn', 'noteOff']);
});

test('releaseAll releases every held note once', () => {
  const { keys, events } = setup();
  keys.keyDown(key('KeyA'), DIV);
  keys.keyDown(key('KeyW'), DIV);
  keys.keyDown(key(OCTAVE_DOWN), DIV);
  keys.keyDown(key('KeyL'), DIV);
  events.length = 0;
  keys.releaseAll();
  assert.deepEqual(events.map((e) => (e.type === 'noteOff' ? e.note : -1)).sort((x, y) => x - y), [60, 61, 62]); // L at octave -1 = 62
  events.length = 0;
  keys.releaseAll();
  keys.keyUp(key('KeyA'));
  assert.equal(events.length, 0);
});

test('legend: US letters by default, real labels from the layout map, fallback on errors', async () => {
  const us = usLabels();
  assert.equal(legendText(us, 48, 84), 'keyboard · c3–c6 · keys a s d f g h j k l · w e t y u o p · z/x octave');
  assert.deepEqual(await keyLabels(undefined), us);
  assert.deepEqual(await keyLabels({}), us);
  const qwertz = new Map([['KeyY', 'z'], ['KeyZ', 'y']]);
  const labels = await keyLabels({ keyboard: { getLayoutMap: async () => qwertz } });
  assert.equal(legendText(labels, 60, 96), 'keyboard · c4–c7 · keys a s d f g h j k l · w e t z u o p · y/x octave');
  const broken = await keyLabels({ keyboard: { getLayoutMap: () => Promise.reject(new Error('denied')) } });
  assert.deepEqual(broken, us);
  const label = keyboardAriaLabel(us, { current: 1, min: -3, max: 3 });
  assert.ok(/a s d f g h j k l for white keys/.test(label), label);
  assert.ok(/z\/x for octave down and up \(octave \+1, range -3 to \+3\)/.test(label), label);
  assert.equal(noteName(61), 'c#4');
  assert.equal(noteName(0), 'c-1');
});

test('HeldNotes lights a note while any source holds it, and clears on panic', () => {
  const bus = new PlayBus();
  const held = new HeldNotes();
  held.attach(bus);
  const seen: number[][] = [];
  held.onChange((n) => seen.push([...n].sort()));
  bus.emit({ type: 'noteOn', note: 60, velocity: 100, source: 'computer' });
  bus.emit({ type: 'noteOn', note: 60, velocity: 90, source: 'pointer' });
  bus.emit({ type: 'noteOff', note: 60, source: 'computer' });
  assert.deepEqual([...held.notes], [60]);
  bus.emit({ type: 'noteOff', note: 60, source: 'pointer' });
  assert.deepEqual([...held.notes], []);
  bus.emit({ type: 'noteOn', note: 62, velocity: 100, source: 'midi' });
  bus.emit({ type: 'panic' });
  assert.deepEqual(seen, [[60], [], [62], []]);
});

test('bindReleaseOnHide releases on blur, pagehide and hidden visibility, and unbinds', () => {
  const listeners = new Map<string, () => void>();
  const target = {
    addEventListener: (t: string, fn: () => void) => listeners.set(t, fn),
    removeEventListener: (t: string) => listeners.delete(t),
  };
  const doc = { visibilityState: 'visible', ...target };
  let calls = 0;
  const unbind = bindReleaseOnHide(target, doc, () => calls++);
  listeners.get('blur')!();
  listeners.get('pagehide')!();
  listeners.get('visibilitychange')!();
  assert.equal(calls, 2);
  doc.visibilityState = 'hidden';
  listeners.get('visibilitychange')!();
  assert.equal(calls, 3);
  unbind();
  assert.equal(listeners.size, 0);
});
