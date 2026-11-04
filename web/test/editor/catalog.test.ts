/** The piano model catalogue (plan section 13.3): every Stage 4 piano name gets a type, a family and a unique entry. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PIANO_NAMES } from '../../src/engine/generated/tables-ns4.ts';
import {
  classifyPiano, DEFAULT_FAMILY, modelsOfType, PIANO_MODELS, PIANO_TYPES, pianoFamily, pianoModel, pianoType,
} from '../../src/editor/model/pianos.ts';

test('every piano name is in the catalogue once, with a type and a family', () => {
  assert.equal(PIANO_MODELS.length, Object.keys(PIANO_NAMES).length);
  assert.equal(PIANO_MODELS.length, 295);
  assert.equal(new Set(PIANO_MODELS.map((m) => m.hash)).size, 295);
  for (const m of PIANO_MODELS) {
    assert.equal(PIANO_NAMES[m.hash], m.name);
    assert.ok(PIANO_TYPES.includes(m.type), m.name);
    assert.ok(!/\s{2}/.test(m.label) && m.label === m.label.trim(), m.label);
    assert.ok(m.ordinal >= 1 && m.ordinal <= m.count, `${m.label} ${m.ordinal}/${m.count}`);
  }
  // Entries that share a label are numbered 1..count in hash order.
  const wurli = PIANO_MODELS.filter((m) => m.label === 'Wurlitzer 1');
  assert.deepEqual(wurli.map((m) => m.ordinal), wurli.map((_, i) => i + 1));
  assert.deepEqual([...wurli.map((m) => m.hash)], [...wurli.map((m) => m.hash)].sort((a, b) => a - b));
});

test('the catalogue is sorted by type, then label', () => {
  const order = PIANO_MODELS.map((m) => PIANO_TYPES.indexOf(m.type));
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
  for (const type of PIANO_TYPES) assert.ok(modelsOfType(type).length > 0, type);
});

test('names fall into the types of manual p.24', () => {
  const kind = (name: string): string => {
    const k = classifyPiano(name);
    return k === null ? 'none' : `${k.type}/${k.family}`;
  };
  assert.equal(kind('White Grand XL'), 'grand/grand');
  assert.equal(kind('Grand Upright Lrg'), 'upright/upright');
  assert.equal(kind('HonkyTonkUpright Med'), 'upright/upright');
  assert.equal(kind('Electric Grand 1'), 'grand/electric-grand');
  assert.equal(kind('EGrand 3 Sml'), 'grand/electric-grand');
  assert.equal(kind('Mozart Forte Pno Lrg'), 'grand/fortepiano');
  assert.equal(kind('EP5 BrightTines Med'), 'electric/tine');
  assert.equal(kind('EPiano 1    Mk I'), 'electric/tine');
  assert.equal(kind('Wurlitzer 2 XL'), 'electric/reed');
  assert.equal(kind('Clavinet D6 6.1'), 'clav/clavinet');
  assert.equal(kind('French Harpsi 1A'), 'clav/harpsichord');
  assert.equal(kind('DX7 FullTines Lrg'), 'digital/fm');
  assert.equal(kind('MKS20 A.Piano1 Lrg'), 'digital/digital-acoustic');
  assert.equal(kind('MK80 E.Piano2 Lrg'), 'digital/digital-electric');
  assert.equal(kind('DigiGrand 1 Sml'), 'digital/digital-acoustic');
  assert.equal(kind('Vibraphone mono'), 'misc/vibraphone');
  assert.equal(kind('Marimba'), 'misc/marimba');
  assert.equal(kind('Organ Pad'), 'none');
});

test('sizes come from the last word', () => {
  assert.equal(PIANO_MODELS.find((m) => m.label === 'White Grand XL')?.size, 'XL');
  assert.equal(PIANO_MODELS.find((m) => m.label === 'Bright Grand XM')?.size, null);
  assert.equal(PIANO_MODELS.find((m) => m.label === 'Clavinet D6 5.0')?.size, null);
});

test('pianoFamily: the stored model when it matches the type, else the type default', () => {
  const tine = PIANO_MODELS.find((m) => m.label === 'EP5 BrightTines Med')!;
  assert.equal(pianoModel(tine.hash), tine);
  assert.equal(pianoModel(0), null);
  assert.equal(pianoFamily(2, tine.hash), 'tine');
  const wurli = PIANO_MODELS.find((m) => m.family === 'reed')!;
  assert.equal(pianoFamily(2, wurli.hash), 'reed');
  assert.equal(pianoFamily(0, wurli.hash), 'grand', 'a Wurlitzer hash on the Grand type plays the grand default');
  assert.equal(pianoFamily(3, 0), 'clavinet');
  assert.equal(pianoFamily(5, 12345), DEFAULT_FAMILY.misc);
  assert.equal(pianoType(4), 'digital');
  assert.equal(pianoType(9), 'grand');
});
