/**
 * Plan section 14: the master clock (model/clock.ts, audio/clock.ts). BPM to seconds per
 * division, the division lists, the grid helpers, a tempo change that keeps the beat position,
 * keyboard sync (off, on, soft and which layers' keys may reset the clock), and tap tempo.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CLOCK_KEYS, gridAfter, gridCeil, gridIndex, isClockKey, MasterClock, shouldResetClock,
} from '../../src/editor/audio/clock.ts';
import {
  ARP_DIVISIONS, beatSeconds, BPM_MAX, BPM_MIN, divisionOf, divisionSeconds, LFO_DIVISIONS, TapTempo,
} from '../../src/editor/model/clock.ts';

const near = (a: number, b: number, msg?: string): void => assert.ok(Math.abs(a - b) < 1e-9, msg ?? `${a} ≈ ${b}`);

test('BPM to seconds: quarter notes and divisions (M p.34, 36: 1/4 = quarter notes, T = triplets)', () => {
  near(beatSeconds(120), 0.5);
  near(beatSeconds(60), 1);
  near(beatSeconds(10), 2, 'below the range: 30 BPM');
  near(beatSeconds(1000), 0.25, 'above the range: 240 BPM');
  const d = (label: string) => [...ARP_DIVISIONS, ...LFO_DIVISIONS].find((x) => x.label === label)!;
  near(divisionSeconds(120, d('1/4')), 0.5);
  near(divisionSeconds(120, d('1/8')), 0.25);
  near(divisionSeconds(120, d('1/16')), 0.125);
  near(divisionSeconds(120, d('1/2')), 1);
  near(divisionSeconds(120, d('1/8T')), 1 / 6);
  near(divisionSeconds(120, d('1/1')), 2);
  near(divisionSeconds(120, d('8/1')), 16, 'the LFO reaches over several bars (M p.17)');
});

test('division lists run slow to fast and split 0–127 evenly', () => {
  for (const list of [ARP_DIVISIONS, LFO_DIVISIONS]) {
    for (let i = 1; i < list.length; i++) assert.ok(list[i]!.beats < list[i - 1]!.beats, list[i]!.label);
    assert.equal(divisionOf(0, list), list[0]);
    assert.equal(divisionOf(127, list), list.at(-1));
    const used = new Set(Array.from({ length: 128 }, (_, v) => divisionOf(v, list).label));
    assert.equal(used.size, list.length, 'every division is reachable');
  }
  assert.ok(ARP_DIVISIONS.some((x) => x.label === '1/8') && ARP_DIVISIONS.some((x) => x.label.endsWith('T')));
});

test('grid helpers', () => {
  const g = { period: 0.25, anchor: 0.1 };
  near(gridCeil(g, 0.1), 0.1);
  near(gridCeil(g, 0.2), 0.35);
  near(gridAfter(g, 0.1), 0.35);
  near(gridAfter(g, 0.34), 0.35);
  near(gridCeil(g, 0), 0.1);
  near(gridCeil(g, -0.3), -0.15);
  assert.equal(gridIndex(g, 0.85), 3);
});

test('MasterClock: grid per division, a tempo change keeps the beat position, reset moves beat 0', () => {
  const c = new MasterClock(120, 0);
  assert.equal(c.bpm, 120);
  near(c.grid(0.5).period, 0.25);
  near(c.beatsAt(2), 4);
  c.setBpm(60, 2);
  near(c.beatsAt(2), 4, 'the beat reached at the change stays');
  near(c.beatsAt(3), 5);
  near(c.grid(1).period, 1);
  c.reset(7.3);
  near(c.anchor, 7.3);
  near(c.beatsAt(7.3), 0);
  c.setBpm(500, 8);
  assert.equal(c.bpm, BPM_MAX);
  c.setBpm(1, 8);
  assert.equal(c.bpm, BPM_MIN);
  assert.deepEqual([...CLOCK_KEYS], ['common.masterClockRate', 'common.masterClockKbdSync']);
  assert.ok(isClockKey('common.masterClockRate'));
  assert.ok(!isClockKey('common.pdlTapEnable'));
});

test('keyboard sync: off never, on at the first key, soft only after more than a quarter note (M p.40)', () => {
  const q = { idle: 0.1, beat: 0.5, reachesSyncLayer: false, anySyncLayer: false };
  assert.equal(shouldResetClock({ ...q, mode: 'off', idle: 10 }), false);
  assert.equal(shouldResetClock({ ...q, mode: 'on' }), true);
  assert.equal(shouldResetClock({ ...q, mode: 'soft' }), false, 'played again within a quarter note');
  assert.equal(shouldResetClock({ ...q, mode: 'soft', idle: 0.6 }), true);
  assert.equal(shouldResetClock({ ...q, mode: 'soft', idle: Infinity }), true, 'the very first key');
});

test('keyboard sync: layers with kb sync on decide which keys reset the clock (M p.37)', () => {
  const q = { mode: 'on' as const, idle: 1, beat: 0.5 };
  assert.equal(shouldResetClock({ ...q, anySyncLayer: true, reachesSyncLayer: true }), true);
  assert.equal(shouldResetClock({ ...q, anySyncLayer: true, reachesSyncLayer: false }), false,
    'a lead layer without kb sync does not reset the arpeggio layer\'s clock');
  assert.equal(shouldResetClock({ ...q, anySyncLayer: false, reachesSyncLayer: false }), true,
    'no layer has kb sync: any key resets');
});

test('tap tempo: four taps at least, the mean of the last taps, new series after a pause (M p.17, 40)', () => {
  const tap = new TapTempo();
  assert.equal(tap.tap(10), null);
  assert.equal(tap.tap(10.5), null);
  assert.equal(tap.tap(11), null);
  assert.equal(tap.tap(11.5), 120, 'the fourth tap sets 120 BPM');
  assert.equal(tap.tap(12.1), 114, 'averaged over the series: 4 intervals in 2.1 s');
  // A pause longer than 2.5 s starts over.
  assert.equal(tap.tap(20), null);
  assert.equal(tap.count, 1);
  for (const t of [20.4, 20.8]) assert.equal(tap.tap(t), null);
  assert.equal(tap.tap(21.2), 150);
  // Only the last eight taps count.
  const long = new TapTempo();
  let bpm: number | null = null;
  for (let i = 0; i < 6; i++) bpm = long.tap(i * 1);
  assert.equal(bpm, 60);
  for (let i = 0; i < 8; i++) bpm = long.tap(6 + i * 0.25);
  assert.equal(bpm, 240);
  assert.equal(long.count, TapTempo.MAX_TAPS);
});

test('tap tempo: bounces and auto-repeat are one tap; the result stays in 30–240 BPM', () => {
  const tap = new TapTempo();
  tap.tap(0);
  assert.equal(tap.tap(0.03), null);
  assert.equal(tap.count, 1, 'a tap 30 ms later is ignored');
  for (const t of [0.13, 0.26]) tap.tap(t);
  assert.equal(tap.tap(0.39), 240, 'clamped to the fastest tempo');
  const slow = new TapTempo();
  for (const t of [0, 1.99, 3.98]) slow.tap(t);
  assert.equal(slow.tap(5.97), 30);
  tap.reset();
  assert.equal(tap.count, 0);
});
