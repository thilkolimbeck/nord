/** Display labels to numbers and units, and the short formatter. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DESCRIPTORS } from '../../src/editor/model/descriptors.ts';
import { initProgram } from '../../src/editor/model/init.ts';
import { ns4Label } from '../../src/editor/model/labels.ts';
import { formatSi, parseDisplay } from '../../src/editor/model/units.ts';

test('parseDisplay reads every unit the Stage 4 tables use', () => {
  const cases: ReadonlyArray<readonly [string, number, string]> = [
    ['0.5 ms', 0.5e-3, 's'], ['45 s', 45, 's'], ['0.7 sec', 0.7, 's'], ['inf', Infinity, 's'],
    ['14 Hz', 14, 'Hz'], ['1.2 kHz', 1200, 'Hz'], ['32 kHz', 32000, 'Hz'],
    ['-0.3 dB', -0.3, 'dB'], ['+15.0 dB', 15, 'dB'], ['0.0 dB', 0, 'dB'], ['volume off', -Infinity, 'dB'],
    ['+ 0 semi', 0, 'semi'], ['- 3 semi', -3, 'semi'], ['-24 semi', -24, 'semi'], ['+12 semitones', 12, 'semi'],
    ['- 3 cent', -3, 'cent'], ['+50 cent', 50, 'cent'], ['5.0', 5, ''], ['-2', -2, ''], ['+1', 1, ''], ['16', 16, ''],
  ];
  for (const [label, value, unit] of cases) assert.deepEqual(parseDisplay(label), { value, unit }, label);
  assert.equal(Object.is(parseDisplay('- 0 semi')!.value, -0), false);
});

test('parseDisplay returns null for names', () => {
  for (const label of ['LP24', '2/3', '+/- 2', '+2 / -12', 'C2', 'off', '1 (ANALOG)', 'not decoded', 'slot  1/2', '5 m', '']) {
    assert.equal(parseDisplay(label), null, label);
  }
});

test('every label of every continuous synth control parses, in the control unit', () => {
  const values = initProgram().values;
  const reader = { get: (k: keyof typeof values) => values[k] };
  let checked = 0;
  for (const d of DESCRIPTORS.values()) {
    if (d.region !== 'synth' || d.kind !== 'continuous' || d.labelSource === 'raw') continue;
    assert.notEqual(d.unit, null, d.key);
    for (let v = d.min; v <= d.max; v++) {
      const label = ns4Label(d.key, v, reader);
      if (label === null || label === 'not decoded') continue;
      assert.equal(parseDisplay(label)?.unit, d.unit, `${d.key} ${label}`);
      checked += 1;
    }
  }
  assert.ok(checked > 3000, `only ${checked} labels`);
});

test('formatSi writes short values', () => {
  assert.equal(formatSi(0.0005, 's'), '0.5 ms');
  assert.equal(formatSi(0.12, 's'), '120 ms');
  assert.equal(formatSi(1.05, 's'), '1.05 s');
  assert.equal(formatSi(Infinity, 's'), 'inf');
  assert.equal(formatSi(14, 'Hz'), '14 Hz');
  assert.equal(formatSi(1200, 'Hz'), '1.2 kHz');
  assert.equal(formatSi(-Infinity, 'dB'), 'volume off');
  assert.equal(formatSi(-0.3, 'dB'), '-0.3 dB');
  assert.equal(formatSi(3, 'dB'), '+3 dB');
  assert.equal(formatSi(-3, 'semi'), '-3 semi');
  assert.equal(formatSi(7, 'cent'), '+7 cent');
  assert.equal(formatSi(5, ''), '5');
  assert.equal(formatSi(Number.NaN, 'Hz'), '–');
});
