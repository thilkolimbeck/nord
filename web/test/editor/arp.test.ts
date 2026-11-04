/**
 * Plan section 14: the arpeggiator and gate scheduler (audio/arp.ts), pure. Note order for every
 * direction, zig zag, range and Poly inversions; look-ahead scheduling on a step grid; KB sync
 * restart versus the running grid; pattern step count; the rate from the free BPM curve and from a
 * master clock division; gate steps; note offs and flush.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type ArpEvent, arpNotes, arpOrder, ArpScheduler, type ArpSettings } from '../../src/editor/audio/arp.ts';
import { MasterClock } from '../../src/editor/audio/clock.ts';
import { arpRangeSemitones, arpSpec } from '../../src/editor/audio/mapping.ts';
import { ARP_DIVISIONS, arpFreeBpm, arpFreeStepSeconds, divisionOf } from '../../src/editor/model/clock.ts';
import { descriptorOf, formatValue } from '../../src/editor/model/descriptors.ts';
import { initProgram } from '../../src/editor/model/init.ts';
import { ParamStore } from '../../src/editor/model/store.ts';

const BASE: ArpSettings = { mode: 'arp', direction: 'up', zigzag: false, rangeSemitones: 0, patternSteps: null, noteLength: 0.5 };
const GRID = { period: 0.25, anchor: 0 };
const H = { velocity: 90, gain: 1 };

function chord(notes: readonly number[], t = 0): ArpScheduler {
  const a = new ArpScheduler(() => 0.5);
  for (const n of notes) a.noteOn(n, H, t);
  return a;
}

const ons = (events: readonly ArpEvent[]): Array<[number, number]> =>
  events.filter((e) => e.type === 'on').map((e) => [Number(e.time.toFixed(4)), (e as { note: number }).note]);

function notesOf(s: ArpSettings, held: readonly number[], steps: number): number[] {
  const a = chord(held);
  return ons(a.schedule(0, steps * GRID.period - 1e-9, s, GRID)).map(([, n]) => n);
}

test('arpOrder: up, down, up/down without repeated ends', () => {
  assert.deepEqual(arpOrder(4, 'up', false), [0, 1, 2, 3]);
  assert.deepEqual(arpOrder(4, 'down', false), [3, 2, 1, 0]);
  assert.deepEqual(arpOrder(4, 'updown', false), [0, 1, 2, 3, 2, 1]);
  assert.deepEqual(arpOrder(1, 'updown', false), [0]);
  assert.deepEqual(arpOrder(2, 'updown', false), [0, 1]);
  assert.deepEqual(arpOrder(0, 'up', false), []);
});

test('arpOrder: zig zag jumps two steps and back one (M p.17, 35)', () => {
  assert.deepEqual(arpOrder(5, 'up', true), [0, 2, 1, 3, 2, 4, 3, 4]);
  assert.deepEqual(arpOrder(3, 'up', true), [0, 2, 1, 2]);
  assert.deepEqual(arpOrder(3, 'down', true), [2, 0, 1, 0]);
  assert.deepEqual(arpOrder(2, 'up', true), [0, 1]);
  for (const n of [1, 2, 3, 4, 6, 9]) {
    const order = arpOrder(n, 'updown', true);
    assert.ok(order.every((i) => i >= 0 && i < n), `${n}: ${order}`);
    assert.deepEqual(new Set(order).size, n, `${n}: every item appears`);
  }
});

test('directions over a held chord', () => {
  const held = [60, 64, 67];
  assert.deepEqual(notesOf(BASE, held, 6), [60, 64, 67, 60, 64, 67]);
  assert.deepEqual(notesOf({ ...BASE, direction: 'down' }, held, 4), [67, 64, 60, 67]);
  assert.deepEqual(notesOf({ ...BASE, direction: 'updown' }, held, 6), [60, 64, 67, 64, 60, 64]);
  assert.deepEqual(notesOf({ ...BASE, zigzag: true }, [60, 62, 64, 65, 67], 8), [60, 64, 62, 65, 64, 67, 65, 67]);
  const random = notesOf({ ...BASE, direction: 'random' }, held, 20);
  assert.ok(random.every((n) => held.includes(n)));
  for (let i = 1; i < random.length; i++) assert.notEqual(random[i], random[i - 1], 'random never repeats a note at once');
});

test('range: octave copies up to the range above the highest held note (M p.17, 35)', () => {
  assert.deepEqual(arpNotes([64, 60, 67], 0), [60, 64, 67]);
  assert.deepEqual(arpNotes([60, 64, 67], 12), [60, 64, 67, 72, 76, 79]);
  assert.deepEqual(arpNotes([60, 64, 67], 4), [60, 64, 67], 'C\' lies 5 semitones above G');
  assert.deepEqual(arpNotes([60, 64, 67], 8), [60, 64, 67, 72]);
  assert.deepEqual(arpNotes([60], 48), [60, 72, 84, 96, 108]);
  assert.deepEqual(arpNotes([120], 24), [120], 'nothing above 127');
  assert.deepEqual(arpNotes([], 12), []);
  // The knob: 0 plays the held notes, the top 4 octaves, in thirds of an octave.
  assert.equal(arpRangeSemitones(0), 0);
  assert.equal(arpRangeSemitones(127), 48);
  assert.equal(arpRangeSemitones(32), 12);
  for (let v = 0; v <= 127; v++) assert.equal(arpRangeSemitones(v) % 4, 0, String(v));
  assert.deepEqual(notesOf({ ...BASE, rangeSemitones: 12 }, [60, 64, 67], 6), [60, 64, 67, 72, 76, 79]);
});

test('poly: the chord on every step, its inversions with a range (M p.35)', () => {
  const a = chord([60, 64, 67]);
  const events = a.schedule(0, 0.5 - 1e-9, { ...BASE, mode: 'poly' }, GRID);
  assert.deepEqual(ons(events), [[0, 60], [0, 64], [0, 67], [0.25, 60], [0.25, 64], [0.25, 67]]);
  const inv = chord([60, 64, 67]).schedule(0, 1 - 1e-9, { ...BASE, mode: 'poly', rangeSemitones: 12 }, GRID);
  const byStep = new Map<number, number[]>();
  for (const [t, n] of ons(inv)) byStep.set(t, [...(byStep.get(t) ?? []), n]);
  assert.deepEqual([...byStep.values()], [[60, 64, 67], [64, 67, 72], [67, 72, 76], [72, 76, 79]]);
});

test('look-ahead: only steps before the horizon, each note off half a step later', () => {
  const a = chord([60, 64]);
  const first = a.schedule(0, 0.1, BASE, GRID);
  assert.deepEqual(first.map((e) => [e.type, e.time]), [['on', 0]]);
  const second = a.schedule(0.1, 0.2, BASE, GRID);
  assert.deepEqual(second.map((e) => [e.type, e.time]), [['off', 0.125]]);
  const third = a.schedule(0.2, 0.3, BASE, GRID);
  assert.deepEqual(third.map((e) => [e.type, e.time, (e as { note: number }).note]), [['on', 0.25, 64]]);
  assert.deepEqual(a.schedule(0.3, 0.4, BASE, GRID).map((e) => e.type), ['off']);
});

test('velocity and crossfade gain come from the held note an arpeggiated note stems from', () => {
  const a = new ArpScheduler();
  a.noteOn(60, { velocity: 40, gain: 0.5 }, 0);
  a.noteOn(67, { velocity: 120, gain: 1 }, 0);
  const events = a.schedule(0, 1 - 1e-9, { ...BASE, rangeSemitones: 12 }, GRID).filter((e) => e.type === 'on');
  assert.deepEqual(events.map((e) => [(e as { note: number }).note, (e as { velocity: number }).velocity]),
    [[60, 40], [67, 120], [72, 40], [79, 120]]);
});

test('without KB sync a new chord waits for the running grid; with KB sync it starts on the key', () => {
  const grid = { period: 0.25, anchor: 0 };
  const late = new ArpScheduler();
  late.noteOn(60, H, 0.31);
  assert.deepEqual(ons(late.schedule(0.31, 0.6, BASE, grid)), [[0.5, 60]], 'next grid step');
  const synced = new ArpScheduler();
  synced.restart(0.31);
  synced.noteOn(60, H, 0.31);
  const shifted = { period: 0.25, anchor: 0.31 };
  assert.deepEqual(ons(synced.schedule(0.31, 0.6, BASE, shifted)), [[0.31, 60], [0.56, 60]]);
});

test('the note order restarts with a new chord after all keys were lifted', () => {
  const a = chord([60, 64, 67]);
  assert.deepEqual(ons(a.schedule(0, 0.3, BASE, GRID)).map(([, n]) => n), [60, 64]);
  for (const n of [60, 64, 67]) a.noteOff(n);
  assert.deepEqual(ons(a.schedule(0.3, 0.6, BASE, GRID)), [], 'nothing held: no steps');
  assert.equal(a.running, false);
  a.noteOn(62, H, 0.6);
  a.noteOn(65, H, 0.6);
  assert.deepEqual(ons(a.schedule(0.6, 1.1, BASE, GRID)).map(([, n]) => n), [62, 65], 'from the first note again');
});

test('pattern: events carry the step of a flat pattern counted from the grid anchor', () => {
  const a = chord([60]);
  const events = a.schedule(0, 2.5 - 1e-9, { ...BASE, patternSteps: 4 }, GRID).filter((e) => e.type === 'on');
  assert.deepEqual(events.map((e) => e.step), [0, 1, 2, 3, 0, 1, 2, 3, 0, 1]);
  assert.equal(events.length, 10, 'every step plays (the pattern content is not decoded)');
  const off = chord([60]).schedule(0, 0.5, BASE, GRID).filter((e) => e.type === 'on');
  assert.ok(off.every((e) => e.step === null), 'no pattern without Pattern on');
  // arpPtnLen 1–15 is 2–16 steps (table 432-7).
  const s = new ParamStore(initProgram());
  assert.equal(arpSpec(s, 'A').patternSteps, null);
  s.set('synthA.arpPtnEnable', 1);
  assert.equal(arpSpec(s, 'A').patternSteps, 8, 'the default 7 shows as 8 steps');
  s.set('synthA.arpPtnLen', 15);
  assert.equal(arpSpec(s, 'A').patternSteps, 16);
  s.set('synthA.arpPtnLen', 1);
  assert.equal(arpSpec(s, 'A').patternSteps, 2);
});

test('rate: free BPM curve, eighth-note steps; master clock divisions', () => {
  assert.equal(arpFreeBpm(0), 30);
  assert.equal(arpFreeBpm(127), 240);
  assert.equal(Math.round(arpFreeBpm(54)), 119, 'the default rate is about 120 BPM');
  assert.ok(Math.abs(arpFreeStepSeconds(127) - 0.125) < 1e-9, 'an eighth note at 240 BPM');
  for (let v = 1; v <= 127; v++) assert.ok(arpFreeStepSeconds(v) < arpFreeStepSeconds(v - 1), 'faster clockwise');
  assert.equal(divisionOf(0, ARP_DIVISIONS).label, '1/2');
  assert.equal(divisionOf(127, ARP_DIVISIONS).label, '1/32');
  assert.equal(divisionOf(54, ARP_DIVISIONS).label, '1/8');

  const clock = new MasterClock(120, 0);
  const eighth = clock.grid(divisionOf(54, ARP_DIVISIONS).beats);
  assert.equal(eighth.period, 0.25, '1/8 at 120 BPM');
  const a = chord([60]);
  assert.deepEqual(ons(a.schedule(0, 1 - 1e-9, BASE, eighth)).map(([t]) => t), [0, 0.25, 0.5, 0.75]);
  // A tempo change: the next steps follow the new period from the beat reached.
  clock.setBpm(60, 1);
  const slow = clock.grid(0.5);
  assert.equal(slow.period, 0.5);
  assert.deepEqual(ons(a.schedule(1, 2.5 - 1e-9, BASE, slow)).map(([t]) => t), [1, 1.5, 2]);
  const triplet = divisionOf(70, ARP_DIVISIONS);
  assert.equal(triplet.label, '1/8T');
  assert.ok(Math.abs(new MasterClock(120).grid(triplet.beats).period - 1 / 6) < 1e-9);
});

test('gate: a step event on every grid step whether notes are held or not; direction has no effect', () => {
  const a = new ArpScheduler();
  const gate: ArpSettings = { ...BASE, mode: 'gate', direction: 'random' };
  const events = a.schedule(0, 1 - 1e-9, gate, GRID);
  assert.deepEqual(events.map((e) => [e.type, e.time]), [['gate', 0], ['gate', 0.25], ['gate', 0.5], ['gate', 0.75]]);
  assert.ok(events.every((e) => e.type === 'gate' && e.period === 0.25));
  a.restart(1.1);
  const restarted = a.schedule(1.1, 1.5, gate, { period: 0.25, anchor: 1.1 });
  assert.deepEqual(restarted.map((e) => e.time), [1.1, 1.35], 'KB sync restarts the gate on the key');
});

test('late ticks skip steps that are already past; flush ends pending notes; reset forgets everything', () => {
  const a = chord([60]);
  a.schedule(0, 0.1, BASE, GRID);
  const late = a.schedule(1.02, 1.1, BASE, GRID);
  assert.deepEqual(ons(late), [], 'steps at 0.25 … 1.0 are skipped');
  assert.deepEqual(late.filter((e) => e.type === 'off').map((e) => e.time), [0.125], 'the pending off still comes');
  const b = chord([60, 64]);
  b.schedule(0, 0.1, BASE, GRID);
  assert.deepEqual(b.flush(0.05).map((e) => [e.type, e.time]), [['off', 0.125]]);
  assert.deepEqual(b.flush(0.05), []);
  b.reset();
  assert.equal(b.size, 0);
  assert.deepEqual(b.schedule(0.2, 0.6, BASE, GRID), []);
});

test('poly: a key that comes just after a step still plays in its chord', () => {
  const a = new ArpScheduler();
  a.noteOn(60, H, 0);
  const first = a.schedule(0, 0.1, { ...BASE, mode: 'poly' }, GRID);
  assert.deepEqual(ons(first), [[0, 60]]);
  const joined = a.noteOn(64, H, 0.01);
  assert.deepEqual(ons(joined), [[0.01, 64]], 'joins the step at 0');
  assert.deepEqual(a.noteOn(67, H, 0.2), [], 'too late for that step: plays from the next');
  const next = a.schedule(0.1, 0.3, { ...BASE, mode: 'poly' }, GRID);
  assert.deepEqual(next.filter((e) => e.type === 'off').map((e) => (e as { note: number }).note).sort(), [60, 64]);
  assert.deepEqual(ons(next).map(([, n]) => n), [60, 64, 67]);
  const arp = chord([60]);
  arp.schedule(0, 0.1, BASE, GRID);
  assert.deepEqual(arp.noteOn(64, H, 0.01), [], 'arp mode: the note joins the order, no extra event');
});

test('rate labels: free BPM, or the clock division while mst clk is on (the label follows the switch)', () => {
  const s = new ParamStore(initProgram());
  const d = descriptorOf('synthB.arpRateClkDiv');
  assert.equal(d.kind, 'continuous', 'still a fader');
  assert.equal(d.status, 'unverified');
  assert.deepEqual(d.deps, ['synthB.arpClkEnable']);
  assert.equal(formatValue(d, 54, s).text, '119 bpm');
  assert.equal(formatValue(d, 0, s).text, '30 bpm');
  s.set('synthB.arpClkEnable', 1);
  assert.equal(formatValue(d, 54, s).text, '1/8');
  assert.equal(formatValue(descriptorOf('synthA.arpRateClkDiv'), 54, s).text, '119 bpm', 'layer A has its own switch');
  const lfo = descriptorOf('synthCSound.lfoRateClkDiv');
  assert.deepEqual(lfo.deps, ['synthCSound.lfoClkEnable']);
  assert.equal(formatValue(lfo, 64, s).text, '64', 'free LFO: the stored step, as before');
  s.set('synthCSound.lfoClkEnable', 1);
  assert.equal(formatValue(lfo, 0, s).text, '8/1');
  assert.equal(formatValue(lfo, 127, s).text, '1/32');
  assert.equal(formatValue(descriptorOf('common.masterClockRate'), 120, s).text, '120 bpm');
});

test('a grid change moves the pending step onto the new grid: no doubled step, no gap of the old step', () => {
  // 120 → 119 BPM between steps: the new grid's next step lies 2.5 ms after the pending one.
  const clock = new MasterClock(120, 0);
  const a = chord([60]);
  const times: number[] = [];
  const tickTo = (end: number, t0: number): void => {
    for (let t = t0; t < end - 1e-9; t += 0.025) times.push(...ons(a.schedule(t, t + 0.1, BASE, clock.grid(0.5))).map(([x]) => x));
  };
  tickTo(0.45, 0);
  clock.setBpm(119, 0.45);
  tickTo(2, 0.45);
  const gaps = times.slice(1).map((t, i) => t - times[i]!);
  assert.ok(gaps.every((d) => d > 0.2), `steps ${times}`);
  // A slow rate turned fast: the next step follows the new rate, not the old step's end.
  const b = chord([60]);
  ons(b.schedule(0, 0.1, BASE, { period: 1, anchor: 0 }));
  assert.deepEqual(ons(b.schedule(0.3, 0.6, BASE, { period: 0.25, anchor: 0 })), [[0.5, 60]]);
});

test('a restart drops the note offs of the steps planned after it', () => {
  const a = chord([60, 64]);
  a.schedule(0, 0.3, BASE, GRID); // steps at 0 (60) and 0.25 (64), whose off at 0.375 is pending
  a.restart(0.2);
  const after = a.schedule(0.2, 0.42, BASE, { period: 0.25, anchor: 0.2 });
  assert.deepEqual(after.filter((e) => e.type === 'off').map((e) => [e.time, (e as { note: number }).note]), [[0.325, 60]]);
  assert.deepEqual(ons(after), [[0.2, 60]]);
});
