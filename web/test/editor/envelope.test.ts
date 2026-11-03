/** AC 9 / plan section 4.1: envelope levels at attack, decay, hold and release, end times and automation steps. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  attackSteps, envEndTime, type EnvSchedule, envValueAt, releaseSteps, SILENCE, TAU_DIVISOR,
} from '../../src/editor/audio/envelope.ts';

const near = (a: number, b: number, eps = 1e-9): void => assert.ok(Math.abs(a - b) <= eps, `${a} ≉ ${b}`);
const S: EnvSchedule = { start: 1, attack: 0.1, decay: 2, releaseAt: null, release: 0.5, peak: 0.8 };

test('attack ramps linearly from 0 to the peak', () => {
  near(envValueAt(S, 0.5), 0);
  near(envValueAt(S, 1), 0);
  near(envValueAt(S, 1.05), 0.4);
  near(envValueAt(S, 1.1), 0.8);
});

test('decay falls 40 dB over the table time', () => {
  near(envValueAt(S, 1.1 + 2), 0.8 / 100, 1e-6);
  const mid = envValueAt(S, 1.1 + 1);
  assert.ok(mid < 0.8 && mid > 0.008);
});

test('an infinite decay holds the peak', () => {
  const hold = { ...S, decay: Infinity };
  near(envValueAt(hold, 50), 0.8);
  assert.equal(envEndTime(hold), Infinity);
});

test('release falls from the level reached, also during the attack', () => {
  const rel = { ...S, decay: Infinity, releaseAt: 2 };
  near(envValueAt(rel, 2), 0.8);
  near(envValueAt(rel, 2.5), 0.008, 1e-6);
  const early = { ...S, releaseAt: 1.05 };
  near(envValueAt(early, 1.05), 0.4);
  near(envValueAt(early, 1.05 + 0.5), 0.004, 1e-6);
  near(envValueAt({ ...rel, release: 0 }, 2.0001), 0);
});

test('a retrigger starts the attack from the current level', () => {
  const re = { ...S, from: 0.4 };
  near(envValueAt(re, 1), 0.4);
  near(envValueAt(re, 1.05), 0.6);
});

test('the end time is where the level falls below -80 dB', () => {
  const end = envEndTime(S);
  near(end, 1.1 + (2 / TAU_DIVISOR) * Math.log(0.8 / SILENCE), 1e-9);
  near(envValueAt(S, end), SILENCE, 1e-9);
  const rel = { ...S, decay: Infinity, releaseAt: 3 };
  const relEnd = envEndTime(rel);
  near(envValueAt(rel, relEnd), SILENCE, 1e-9);
  assert.ok(relEnd > 3);
  assert.equal(envEndTime({ ...rel, release: 0 }), 3);
});

test('levels stay within 0..peak and finite for every phase', () => {
  for (const s of [S, { ...S, decay: Infinity }, { ...S, releaseAt: 1.5 }, { ...S, attack: 0, releaseAt: 1 }]) {
    for (let t = 0; t < 10; t += 0.01) {
      const v = envValueAt(s, t);
      assert.ok(Number.isFinite(v) && v >= 0 && v <= s.peak + 1e-12, `${v} at ${t}`);
    }
  }
});

test('automation steps: set, ramp, target; release sets the reached level then falls', () => {
  assert.deepEqual(attackSteps(S), [
    { kind: 'set', time: 1, value: 0 },
    { kind: 'linear', time: 1.1, value: 0.8 },
    { kind: 'target', time: 1.1, target: 0, tau: 2 / TAU_DIVISOR },
  ]);
  assert.deepEqual(attackSteps({ ...S, decay: Infinity }).map((s) => s.kind), ['set', 'linear']);
  const steps = releaseSteps({ ...S, releaseAt: 1.05 });
  assert.equal(steps[0]!.kind, 'set');
  near((steps[0] as { value: number }).value, 0.4);
  assert.deepEqual(steps[1], { kind: 'target', time: 1.05, target: 0, tau: 0.5 / TAU_DIVISOR });
});
