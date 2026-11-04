/**
 * Plan section 15.4 (builder B2): MIDI control in. Off does nothing; on, every mapped Appendix II
 * entry (manual p.68–69) writes its field with origin 'midi' in one batch; NRPNs are assembled from
 * CC99/98/6/38; layer controllers address the focused layer of the active scene and effects
 * controllers the FX focus block; synth Groups and effects group mode propagate (still 'midi');
 * the play bus's controllers and unmapped entries change nothing; the channel filter holds.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { APPENDIX_II, type CcEntry, resolveTarget, scaleIn } from '../../src/editor/midi/cc-map.ts';
import { controlInEntries, DEFAULT_CONTROL_IN, MidiControlIn } from '../../src/editor/midi/cc-in.ts';
import { type MidiEvent, parseMidiMessage } from '../../src/editor/midi/parser.ts';
import { FX_GROUP_KEYS, fxFocusEntries } from '../../src/editor/model/fx.ts';
import { initProgram } from '../../src/editor/model/init.ts';
import type { Ns4Key } from '../../src/editor/model/keys.ts';
import { type Change, ParamStore } from '../../src/editor/model/store.ts';

function setup() {
  const store = new ParamStore(initProgram());
  const batches: Array<readonly Change[]> = [];
  store.onChange((b) => batches.push(b));
  const cin = new MidiControlIn(store);
  const edits: Ns4Key[] = [];
  cin.onEdit((k) => edits.push(k));
  const send = (...data: number[]): void => {
    const e = parseMidiMessage(Uint8Array.from(data));
    assert.ok(e !== null, `parses ${data.join(' ')}`);
    cin.handle(e);
  };
  const cc = (n: number, v: number, ch = 0): void => send(0xb0 | ch, n, v);
  const nrpn = (msb: number, lsb: number, v: number, ch = 0): void => {
    cc(99, msb, ch);
    cc(98, lsb, ch);
    cc(6, 0, ch);
    cc(38, v, ch);
  };
  return { store, batches, cin, edits, send, cc, nrpn };
}

test('off by default: no controller changes anything', () => {
  const { store, batches, cin, cc, nrpn } = setup();
  assert.deepEqual(cin.settings, DEFAULT_CONTROL_IN);
  assert.equal(cin.settings.enabled, false);
  cc(59, 3);
  nrpn(3, 51, 2);
  cc(13, 0);
  assert.equal(batches.length, 0);
  assert.equal(store.dirty, false);
});

/** A raw value whose scaled value differs from the field's current one. */
function differentRaw(entry: CcEntry, key: Ns4Key, current: number): number | null {
  for (const raw of [127, 0, 64, 1, 2, 3, 4, 5, 6, 7, 100, 30]) if (scaleIn(entry, key, raw) !== current) return raw;
  return null;
}

test('on: every mapped entry writes its resolved field, origin midi, one batch per message', () => {
  let mapped = 0;
  for (const entry of APPENDIX_II) {
    if (entry.target.kind === 'none') continue;
    const { store, batches, cin, edits, cc, nrpn } = setup();
    cin.update({ enabled: true });
    const key = resolveTarget(entry, store);
    assert.ok(key !== null, entry.name);
    const raw = differentRaw(entry, key, store.get(key));
    assert.ok(raw !== null, `${entry.name}: some value moves ${key}`);
    const a = entry.address;
    if (a.kind === 'cc') cc(a.cc, raw);
    else nrpn(a.msb, a.lsb, raw);
    assert.equal(batches.length, 1, `${entry.name}: one batch`);
    const batch = batches[0]!;
    assert.ok(batch.every((c) => c.origin === 'midi'), `${entry.name}: origin midi`);
    const change = batch.find((c) => c.key === key);
    assert.ok(change !== undefined, `${entry.name} writes ${key}`);
    assert.equal(change.value, scaleIn(entry, key, raw));
    assert.deepEqual(edits, [key]);
    mapped++;
  }
  assert.equal(mapped, 133, 'the plan counts 133 mapped entries');
});

test('NRPN: assembled from CC99, CC98, CC6 and CC38; running data entry; a half package does nothing', () => {
  const { store, cin, cc } = setup();
  cin.update({ enabled: true });
  cc(99, 3);
  cc(98, 51); // Synth Filter Type
  cc(38, 2); // CC6 absent: data MSB 0
  assert.equal(store.get('synthASound.fltType'), 2);
  cc(38, 3); // running data entry: same parameter
  assert.equal(store.get('synthASound.fltType'), 3);
  cc(99, 3);
  cc(38, 1); // CC99 alone keeps the old LSB: 3:51 again
  assert.equal(store.get('synthASound.fltType'), 1);
  cin.update({ enabled: false });
  cin.update({ enabled: true });
  cc(38, 4);
  assert.equal(store.get('synthASound.fltType'), 1, 'switching off forgot the selection');
  cc(99, 3);
  cc(98, 51);
  cc(6, 1);
  cc(38, 0); // data 128: clamped to the field
  assert.ok(store.get('synthASound.fltType') <= 6);
  cc(99, 3);
  cc(98, 51);
  cc(123, 0); // all notes off: the decoder forgets too
  cc(38, 2);
  assert.notEqual(store.get('synthASound.fltType'), 2);
});

test('NRPN: an RPN select (CC101/CC100) ends the selection, so its data entry changes no NRPN field', () => {
  const { store, cin, cc, nrpn } = setup();
  cin.update({ enabled: true });
  nrpn(3, 51, 2); // Synth Filter Type
  assert.equal(store.get('synthASound.fltType'), 2);
  // Pitch-bend range from another device on the same channel.
  cc(101, 0);
  cc(100, 0);
  cc(6, 2);
  cc(38, 0);
  assert.equal(store.get('synthASound.fltType'), 2, 'the RPN data is not applied to 3:51');
  nrpn(3, 51, 4);
  assert.equal(store.get('synthASound.fltType'), 4, 'a new NRPN package works again');
});

test('focus addressing: the focused layer of the active scene; the focus controllers move it first', () => {
  const { store, cin, cc } = setup();
  cin.update({ enabled: true });
  store.setMany([['synth.layerFocusSyn_I', 1], ['synth.layerFocusSyn_II', 2], ['common.layerScene', 0]], 'ui');
  const before = { A: store.get('synthASound.fltFreq'), B: store.get('synthBSound.fltFreq'), C: store.get('synthCSound.fltFreq') };
  cc(59, 11);
  assert.equal(store.get('synthBSound.fltFreq'), 11, 'scene I focuses B');
  assert.equal(store.get('synthASound.fltFreq'), before.A);
  cc(8, 127); // Layer Scene: II
  assert.equal(store.get('common.layerScene'), 1);
  cc(59, 22);
  assert.equal(store.get('synthCSound.fltFreq'), 22, 'scene II focuses C');
  cc(119, 0); // Synth Layers Focus Scene II: A
  cc(59, 33);
  assert.equal(store.get('synthASound.fltFreq'), 33);
  assert.equal(store.get('synthBSound.fltFreq'), 11);
  cc(83, 1); // organ focus scene II: B
  cc(16, 127); // drawbar 1, linear 0..8
  assert.equal(store.get('organBDrawbars.org_Preset_kDb1'), 8);
  cc(16, 64);
  assert.equal(store.get('organBDrawbars.org_Preset_kDb1'), 4);
});

test('effects controllers address the FX focus block; CC31 moves the section focus', () => {
  const { store, cin, cc, nrpn } = setup();
  cin.update({ enabled: true });
  store.setMany([[FX_GROUP_KEYS.piano, 0], [FX_GROUP_KEYS.synth, 0], ...fxFocusEntries('pianoBFx')], 'ui');
  cc(113, 99);
  assert.equal(store.get('pianoBFx.rvbAmt'), 99);
  assert.notEqual(store.get('pianoAFx.rvbAmt'), 99);
  cc(31, 0); // FX focus: organ
  cc(113, 55);
  assert.equal(store.get('organFx.rvbAmt'), 55);
  nrpn(2, 104, 1); // Reverb Enable
  assert.equal(store.get('organFx.rvbEnable'), 1);
  cc(102, 0); // bass, linear: -60
  assert.equal(store.get('organFx.ampBass'), -60);
});

test('synth Groups and effects group mode propagate the write, every copy with origin midi', () => {
  const { store, batches, cin, cc } = setup();
  cin.update({ enabled: true });
  store.setMany([['synth.multiLayerFlt', 1], [FX_GROUP_KEYS.synth, 1], ...fxFocusEntries('synthCFx')], 'ui');
  batches.length = 0;
  cc(60, 77); // filter resonance, Group on
  for (const l of ['A', 'B', 'C']) assert.equal(store.get(`synth${l}Sound.fltRes` as Ns4Key), 77);
  assert.equal(batches.length, 1);
  assert.ok(batches[0]!.every((c) => c.origin === 'midi'));
  cc(79, 40); // LFO rate: the LFO Group is off
  const focus = 'synth.layerFocusSyn_I';
  const layer = ['A', 'B', 'C'][store.get(focus)]!;
  assert.equal(store.get(`synth${layer}Sound.lfoRateClkDiv` as Ns4Key), 40);
  assert.equal(batches.at(-1)!.length, 1, 'one field only');
  cc(93, 66); // delay dry/wet in synth group mode
  for (const b of ['synthAFx', 'synthBFx', 'synthCFx']) assert.equal(store.get(`${b}.dlyMix` as Ns4Key), 66);
  assert.notEqual(store.get('pianoAFx.dlyMix'), 66);
  assert.deepEqual(controlInEntries(store, 'organFx.dlyMix', 5), [['organFx.dlyMix', 5]]);
  store.set(FX_GROUP_KEYS.synth, 0);
  assert.deepEqual(controlInEntries(store, 'synthBFx.dlyMix', 5), [['synthBFx.dlyMix', 5]]);
});

test('the play bus controllers and unmapped entries change nothing; other messages are ignored', () => {
  const { store, batches, cin, cc, send } = setup();
  cin.update({ enabled: true });
  for (const n of [1, 11, 64, 120, 123, 0, 32, 7, 66, 67, 118, 15, 87]) cc(n, 127);
  send(0x90, 60, 100);
  send(0xe0, 0, 64);
  send(0xd0, 50);
  assert.equal(batches.length, 0);
  assert.equal(store.dirty, false);
});

test('the channel filter: every channel, or only the chosen one (1..16); an invalid channel is ignored', () => {
  const { store, cin, cc } = setup();
  cin.update({ enabled: true, channel: 3 });
  assert.equal(cin.settings.channel, 3);
  cc(13, 5, 0);
  assert.notEqual(store.get('organ.layerLevelOrgA'), 5, 'channel 1 ignored');
  cc(13, 5, 2);
  assert.equal(store.get('organ.layerLevelOrgA'), 5, 'channel 3 counts');
  cin.update({ channel: 17 });
  cin.update({ channel: 0 });
  assert.equal(cin.settings.channel, 3);
  cin.update({ channel: 'all' });
  cc(13, 9, 15);
  assert.equal(store.get('organ.layerLevelOrgA'), 9);
});

test('a listener that throws does not undo the write; unsubscribing stops edits', () => {
  const store = new ParamStore(initProgram());
  const cin = new MidiControlIn(store);
  cin.update({ enabled: true });
  const off = cin.onEdit(() => {
    throw new Error('display');
  });
  const e: MidiEvent = { type: 'cc', channel: 0, controller: 14, value: 3 };
  assert.throws(() => cin.handle(e), /display/);
  assert.equal(store.get('organ.layerLevelOrgB'), 3);
  off();
  cin.handle({ ...e, value: 4 });
  assert.equal(store.get('organ.layerLevelOrgB'), 4);
});

test('a layer focus controller moves the FX focus too, as the layer keys do (all origin midi)', () => {
  const { store, batches, cin, cc } = setup();
  cin.update({ enabled: true });
  // Synth Layers Focus Scene I (CC 115) → layer B; scene I is active.
  cc(115, 1);
  assert.equal(batches.length, 1, 'one batch');
  assert.equal(store.get('synth.layerFocusSyn_I'), 1);
  for (const [k, v] of fxFocusEntries('synthBFx')) assert.equal(store.get(k), v, k);
  assert.ok(batches[0]!.every((c) => c.origin === 'midi'), 'nothing tagged derived: MIDI out never echoes it');
  // Piano Layers Focus Scene II (CC 112) while scene I is active: the FX focus stays on synth B.
  cc(112, 1);
  assert.equal(store.get('piano.layerFocusPno_II'), 1);
  for (const [k, v] of fxFocusEntries('synthBFx')) assert.equal(store.get(k), v, k);
  // Organ Layers Focus Scene I (CC 82): the organ block.
  cc(82, 1);
  assert.equal(store.get('organ.layerFocusOrg_I'), 1);
  for (const [k, v] of fxFocusEntries('organFx')) assert.equal(store.get(k), v, k);
});
