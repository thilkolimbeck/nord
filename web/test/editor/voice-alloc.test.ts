/** AC 8 and voice management (plan section 7): poly, stealing, mono priorities, legato, sustain, all notes off. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_VOICES, VoiceAllocator, type LayerVoicing, type VoiceCommand } from '../../src/editor/audio/voice-alloc.ts';

const POLY_A: LayerVoicing = { layer: 'A', mode: 'poly', priority: 'none', sustain: true };
const POLY_B: LayerVoicing = { layer: 'B', mode: 'poly', priority: 'none', sustain: true };
const mono = (priority: LayerVoicing['priority'], mode: 'mono' | 'legato' = 'mono'): LayerVoicing =>
  ({ layer: 'A', mode, priority, sustain: true });

function startOf(cmds: VoiceCommand[]): Extract<VoiceCommand, { type: 'start' }> {
  const s = cmds.find((c) => c.type === 'start');
  assert.ok(s, JSON.stringify(cmds));
  return s;
}

test('MAX_VOICES is 46', () => {
  assert.equal(MAX_VOICES, 46);
});

test('poly: one voice per note and layer, released on note off, freed when ended', () => {
  const va = new VoiceAllocator();
  const a = startOf(va.noteOn(60, 100, [POLY_A]));
  assert.deepEqual(a, { type: 'start', id: a.id, layer: 'A', note: 60, velocity: 100 });
  const two = va.noteOn(64, 80, [POLY_A, POLY_B]);
  assert.deepEqual(two.map((c) => c.type === 'start' && `${c.layer}${c.note}`), ['A64', 'B64']);
  assert.equal(va.activeCount, 3);
  const off = va.noteOff(64);
  assert.deepEqual(off.map((c) => c.type), ['release', 'release']);
  assert.equal(va.activeCount, 3); // releasing voices still count
  for (const c of off) va.voiceEnded(c.id);
  assert.equal(va.activeCount, 1);
  assert.deepEqual(va.noteOff(60), [{ type: 'release', id: a.id }]);
  assert.deepEqual(va.noteOff(60), []); // already released
  const ids = new Set([a.id, ...two.map((c) => c.id)]);
  assert.equal(ids.size, 3); // unique ids
});

test('poly: the 47th voice steals the oldest', () => {
  const va = new VoiceAllocator();
  const starts: number[] = [];
  for (let n = 0; n < MAX_VOICES; n++) {
    const cmds = va.noteOn(30 + n, 100, [POLY_A]);
    assert.deepEqual(cmds.map((c) => c.type), ['start']);
    starts.push(cmds[0]!.id);
  }
  assert.equal(va.activeCount, MAX_VOICES);
  const cmds = va.noteOn(100, 100, [POLY_A]);
  assert.deepEqual(cmds.map((c) => c.type), ['kill', 'start']);
  assert.equal(cmds[0]!.id, starts[0]);
  assert.equal(va.activeCount, MAX_VOICES);
  // the stolen note's later note off does nothing
  assert.deepEqual(va.noteOff(30), []);
});

test('stealing prefers releasing, then sustained, then held voices', () => {
  const va = new VoiceAllocator(3);
  const held = startOf(va.noteOn(60, 100, [POLY_A])).id;
  va.sustain(true);
  const sustained = startOf(va.noteOn(62, 100, [POLY_A])).id;
  va.noteOff(62);
  va.sustain(false);
  // 62 now releasing; make a sustained one again
  va.sustain(true);
  const sus2 = startOf(va.noteOn(64, 100, [POLY_A])).id;
  va.noteOff(64);
  let cmds = va.noteOn(65, 100, [POLY_A]);
  assert.deepEqual(cmds[0], { type: 'kill', id: sustained }); // the releasing voice goes first
  cmds = va.noteOn(67, 100, [POLY_A]);
  assert.deepEqual(cmds[0], { type: 'kill', id: sus2 }); // then the sustained one
  cmds = va.noteOn(69, 100, [POLY_A]);
  assert.deepEqual(cmds[0], { type: 'kill', id: held }); // then the oldest held
  assert.equal(va.activeCount, 3);
});

test('a key struck again while its voice sounds releases that voice and starts a new one', () => {
  const va = new VoiceAllocator();
  const first = startOf(va.noteOn(60, 100, [POLY_A])).id;
  const cmds = va.noteOn(60, 90, [POLY_A]);
  assert.deepEqual(cmds[0], { type: 'release', id: first });
  assert.equal(cmds[1]!.type, 'start');
});

test('mono priority none: the last key plays; releasing it returns to the previous key', () => {
  const va = new VoiceAllocator();
  const v = startOf(va.noteOn(60, 100, [mono('none')])).id;
  assert.deepEqual(va.noteOn(64, 100, [mono('none')]), [{ type: 'retarget', id: v, note: 64, retrigger: true }]);
  assert.deepEqual(va.noteOn(62, 100, [mono('none')]), [{ type: 'retarget', id: v, note: 62, retrigger: true }]);
  assert.equal(va.activeCount, 1);
  assert.deepEqual(va.noteOff(62), [{ type: 'retarget', id: v, note: 64, retrigger: true }]);
  assert.deepEqual(va.noteOff(60), []); // not the sounding key
  assert.deepEqual(va.noteOff(64), [{ type: 'release', id: v }]);
});

test('mono priority low: the lowest held key plays', () => {
  const va = new VoiceAllocator();
  const v = startOf(va.noteOn(64, 100, [mono('low')])).id;
  assert.deepEqual(va.noteOn(67, 100, [mono('low')]), []); // higher: keeps 64
  assert.deepEqual(va.noteOn(60, 100, [mono('low')]), [{ type: 'retarget', id: v, note: 60, retrigger: true }]);
  assert.deepEqual(va.noteOff(60), [{ type: 'retarget', id: v, note: 64, retrigger: true }]);
  assert.deepEqual(va.noteOff(64), [{ type: 'retarget', id: v, note: 67, retrigger: true }]);
  assert.deepEqual(va.noteOff(67), [{ type: 'release', id: v }]);
});

test('mono priority high: the highest held key plays', () => {
  const va = new VoiceAllocator();
  const v = startOf(va.noteOn(64, 100, [mono('high')])).id;
  assert.deepEqual(va.noteOn(60, 100, [mono('high')]), []); // lower: keeps 64
  assert.deepEqual(va.noteOn(67, 100, [mono('high')]), [{ type: 'retarget', id: v, note: 67, retrigger: true }]);
  assert.deepEqual(va.noteOff(67), [{ type: 'retarget', id: v, note: 64, retrigger: true }]);
  assert.deepEqual(va.noteOff(64), [{ type: 'retarget', id: v, note: 60, retrigger: true }]);
  assert.equal(va.activeCount, 1);
});

test('legato: overlapping keys retarget without retrigger; a detached key retriggers', () => {
  const va = new VoiceAllocator();
  const L = mono('none', 'legato');
  const v = startOf(va.noteOn(60, 100, [L])).id;
  assert.deepEqual(va.noteOn(62, 100, [L]), [{ type: 'retarget', id: v, note: 62, retrigger: false }]);
  assert.deepEqual(va.noteOff(62), [{ type: 'retarget', id: v, note: 60, retrigger: false }]);
  assert.deepEqual(va.noteOff(60), [{ type: 'release', id: v }]);
  // the released voice is reused while its tail sounds, with a retrigger
  assert.deepEqual(va.noteOn(65, 100, [L]), [{ type: 'retarget', id: v, note: 65, retrigger: true }]);
  va.noteOff(65);
  va.voiceEnded(v);
  assert.equal(va.activeCount, 0);
  const next = va.noteOn(67, 100, [L]);
  assert.deepEqual(next.map((c) => c.type), ['start']);
});

test('mono and poly layers together: one note starts a voice on each', () => {
  const va = new VoiceAllocator();
  const B_MONO: LayerVoicing = { layer: 'B', mode: 'mono', priority: 'none', sustain: true };
  va.noteOn(60, 100, [POLY_A, B_MONO]);
  va.noteOn(64, 100, [POLY_A, B_MONO]);
  assert.equal(va.activeCount, 3); // two poly A, one mono B
  const off = va.noteOff(64);
  assert.deepEqual(off.map((c) => c.type).sort(), ['release', 'retarget']);
});

test('sustain defers release until the pedal comes up', () => {
  const va = new VoiceAllocator();
  va.sustain(true);
  const a = startOf(va.noteOn(60, 100, [POLY_A])).id;
  const b = startOf(va.noteOn(64, 100, [POLY_A])).id;
  assert.deepEqual(va.noteOff(60), []);
  assert.deepEqual(va.noteOff(64), []);
  assert.equal(va.activeCount, 2);
  assert.deepEqual(va.voices().map((v) => v.state), ['sustained', 'sustained']);
  const c = startOf(va.noteOn(67, 100, [POLY_A])).id; // still held at pedal up
  assert.deepEqual(va.sustain(false), [{ type: 'release', id: a }, { type: 'release', id: b }]);
  assert.deepEqual(va.noteOff(67), [{ type: 'release', id: c }]);
});

test('sustain is ignored by layers whose voicing has sustain off', () => {
  const va = new VoiceAllocator();
  va.sustain(true);
  const v = startOf(va.noteOn(60, 100, [{ ...POLY_A, sustain: false }])).id;
  assert.deepEqual(va.noteOff(60), [{ type: 'release', id: v }]);
});

test('sustain holds a mono voice after the last key; the next key retriggers it', () => {
  const va = new VoiceAllocator();
  va.sustain(true);
  const v = startOf(va.noteOn(60, 100, [mono('none', 'legato')])).id;
  assert.deepEqual(va.noteOff(60), []);
  assert.deepEqual(va.noteOn(62, 100, [mono('none', 'legato')]), [{ type: 'retarget', id: v, note: 62, retrigger: true }]);
  va.noteOff(62);
  assert.deepEqual(va.sustain(false), [{ type: 'release', id: v }]);
});

test('allNotesOff after held, sustained and releasing voices leaves activeCount 0', () => {
  const va = new VoiceAllocator();
  va.noteOn(60, 100, [POLY_A, POLY_B]); // held ×2
  va.sustain(true);
  va.noteOn(62, 100, [POLY_A]);
  va.noteOff(62); // sustained
  va.sustain(false); // 62 releasing
  va.sustain(true);
  va.noteOn(64, 100, [POLY_A]);
  va.noteOff(64); // sustained
  va.noteOn(70, 100, [mono('high')].map((m) => ({ ...m, layer: 'C' as const }))); // mono held
  assert.deepEqual(new Set(va.voices().map((v) => v.state)), new Set(['held', 'sustained', 'releasing']));
  const before = va.activeCount;
  assert.equal(before, 5);
  const cmds = va.allNotesOff();
  assert.equal(cmds.length, before);
  assert.ok(cmds.every((c) => c.type === 'kill'));
  assert.equal(va.activeCount, 0);
  assert.equal(va.sustainOn, false);
  // nothing lingers: old note offs and pedal changes produce no commands
  assert.deepEqual(va.noteOff(60), []);
  assert.deepEqual(va.noteOff(70), []);
  assert.deepEqual(va.sustain(false), []);
  // late voiceEnded for killed voices is harmless
  for (const c of cmds) va.voiceEnded(c.id);
  assert.equal(va.activeCount, 0);
  // and the allocator plays again
  assert.equal(startOf(va.noteOn(60, 100, [mono('none')])).note, 60);
});

test('maxVoices must be a positive integer', () => {
  assert.throws(() => new VoiceAllocator(0), RangeError);
  assert.throws(() => new VoiceAllocator(1.5), RangeError);
});
