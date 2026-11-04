/**
 * Plan sections 13.4 and 13.5: the program logic of the note router. Zone masks from the Stage 4
 * kbZone labels for every split configuration, split boundaries, crossfade gains at b − w, b and
 * b + w, runs across merged zones, split off, transpose, and the Router itself with fake engines:
 * routing per section, noteOff after a transpose edit, colliding sounding notes, a scene switch
 * while a key is held, broadcasts, panic and loads. No Web Audio.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  isRouterKey, routeNote, Router, SPLIT_NOTES, type SplitBoundary, splitBoundaries, transposeSemitones, zoneGain,
  zoneMask,
} from '../../src/editor/audio/router.ts';
import { type SectionEngine, type SectionEvent, XFADE_FLOOR } from '../../src/editor/audio/section.ts';
import { DESCRIPTORS } from '../../src/editor/model/descriptors.ts';
import { initProgram } from '../../src/editor/model/init.ts';
import type { Ns4Key } from '../../src/editor/model/keys.ts';
import { ns4Label, tableLabel } from '../../src/editor/model/labels.ts';
import { SCENE_KEYS, type SectionId } from '../../src/editor/model/scene.ts';
import { type Change, ParamStore } from '../../src/editor/model/store.ts';

const fresh = (): ParamStore => new ParamStore(initProgram());
const HALF = Math.SQRT1_2;
const near = (a: number, b: number, what: string): void => assert.ok(Math.abs(a - b) < 1e-9, `${what}: ${a} ≠ ${b}`);

const POINTS = ['Low', 'Mid', 'High'] as const;
const ZONE_KEYS: readonly Ns4Key[] = ['organA.kbZone', 'organB.kbZone', 'pianoA.kbZone', 'pianoB.kbZone',
  'synthA.kbZone', 'synthB.kbZone', 'synthC.kbZone'];

/** A split with the given points on (C2 = 0 … C7 = 10 positions, widths 0/1/2). */
function split(s: ParamStore, points: Partial<Record<(typeof POINTS)[number], { pos: number; width?: number }>>): void {
  const entries: Array<readonly [Ns4Key, number]> = [['common.splitEnabled', 1]];
  for (const p of POINTS) {
    const cfg = points[p];
    entries.push([`common.splitEnabled${p}`, cfg === undefined ? 0 : 1]);
    if (cfg !== undefined) {
      entries.push([`common.splitPos${p}`, cfg.pos], [`common.splitWidth${p}`, cfg.width ?? 0]);
    }
  }
  s.setMany(entries, 'ui');
}

const bound = (point: SplitBoundary['point'], note: number, width: SplitBoundary['width'] = 0): SplitBoundary =>
  ({ point, note, width });

// ---------------------------------------------------------------------------------------------
// Split points and zones

test('SPLIT_NOTES are the splitPos labels as MIDI notes (C4 = 60)', () => {
  const names: Record<string, number> = { C: 0, F: 5 };
  for (const p of POINTS) {
    SPLIT_NOTES.forEach((note, v) => {
      const label = tableLabel(`common.splitPos${p}`, v)!;
      const m = /^([CF])(\d)$/.exec(label);
      assert.ok(m !== null, label);
      assert.equal(note, 12 * (Number(m[2]) + 1) + names[m[1]!]!, `${p} ${v} ${label}`);
    });
  }
});

test('zone masks follow the kbZone labels in every split configuration; no label plays every zone', () => {
  for (let cfg = 0; cfg < 8; cfg++) {
    const s = fresh();
    s.setMany(POINTS.map((p, i) => [`common.splitEnabled${p}` as Ns4Key, (cfg >> i) & 1] as const), 'ui');
    for (const key of ZONE_KEYS) {
      for (let v = 0; v <= 11; v++) {
        s.set(key, v);
        const label = ns4Label(key, v, s);
        const want = label === null ? 0b1111 : [...label].reduce((m, c, z) => (c === '1' ? m | (1 << z) : m), 0);
        assert.equal(zoneMask(s, key), want, `${key}=${v} cfg ${cfg} (${label})`);
      }
    }
  }
});

test('zones that a disabled point merges carry the same character, so the nominal zone reads right', () => {
  // Zone z+1 starts at point z (Low → 2, Mid → 3, High → 4); a disabled point merges it with the zone below.
  for (let cfg = 0; cfg < 8; cfg++) {
    const s = fresh();
    s.setMany(POINTS.map((p, i) => [`common.splitEnabled${p}` as Ns4Key, (cfg >> i) & 1] as const), 'ui');
    for (const key of ZONE_KEYS) {
      for (let v = 0; v <= 10; v++) {
        const label = ns4Label(key, v, s)!;
        for (let i = 0; i < 3; i++) {
          if (((cfg >> i) & 1) === 0) assert.equal(label[i + 1], label[i], `${key}=${v} cfg ${cfg}: ${label}`);
        }
      }
    }
  }
});

test('splitBoundaries: empty while split is off or no point is on; sorted by note, ties Low, Mid, High', () => {
  const s = fresh();
  assert.deepEqual(splitBoundaries(s), [], 'init: split off (the Mid point is on by default)');
  split(s, {});
  assert.deepEqual(splitBoundaries(s), []);
  split(s, { Low: { pos: 4, width: 1 }, Mid: { pos: 2 }, High: { pos: 4, width: 2 } });
  // Positions out of order: each keeps its note and width; the zones go by rank (Low, Mid, High).
  assert.deepEqual(splitBoundaries(s), [bound('Low', 48), bound('Mid', 60, 6), bound('High', 60, 12)]);
  s.set('common.splitEnabled', 0);
  assert.deepEqual(splitBoundaries(s), []);
});

test('out-of-order positions still give rising zones: a zones 1–2 layer plays one contiguous range', () => {
  const s = fresh();
  split(s, { Low: { pos: 6 }, Mid: { pos: 2 } }); // Low at C5 (72), Mid at C3 (48)
  const b = splitBoundaries(s);
  assert.deepEqual(b.map((x) => [x.point, x.note]), [['Low', 48], ['Mid', 72]]);
  const mask = 0b0011; // zones 1 and 2 ('11oo')
  for (const k of [30, 47, 48, 60, 71]) assert.equal(zoneGain(b, mask, k), 1, `key ${k}`);
  for (const k of [72, 90]) assert.equal(zoneGain(b, mask, k), 0, `key ${k}`);
  // The same configuration with ordered positions routes the same way.
  split(s, { Low: { pos: 2 }, Mid: { pos: 6 } });
  assert.deepEqual(splitBoundaries(s), b);
});

test('zoneGain without width: the split note belongs to the upper zone', () => {
  const b = [bound('Low', 60)];
  assert.equal(zoneGain(b, 0b0001, 59), 1);
  assert.equal(zoneGain(b, 0b0001, 60), 0);
  assert.equal(zoneGain(b, 0b1110, 59), 0);
  assert.equal(zoneGain(b, 0b1110, 60), 1);
  assert.equal(zoneGain(b, 0b1111, 30), 1);
  assert.equal(zoneGain(b, 0b1111, 90), 1);
  assert.equal(zoneGain([], 0b0001, 100), 1, 'no boundaries: every key at 1');
});

test('crossfade: equal power, lower zone 1 / √½ / 0 and upper 0 / √½ / 1 at b − w, b, b + w', () => {
  for (const w of [6, 12] as const) {
    const b = [bound('Mid', 60, w)];
    const lower = (k: number): number => zoneGain(b, 0b0001, k);
    const upper = (k: number): number => zoneGain(b, 0b0100, k);
    near(lower(60 - w), 1, `lower b-w, w ${w}`);
    near(lower(60), HALF, `lower b, w ${w}`);
    assert.ok(lower(60 + w) <= XFADE_FLOOR, `lower b+w, w ${w}`);
    assert.ok(upper(60 - w) <= XFADE_FLOOR, `upper b-w, w ${w}`);
    near(upper(60), HALF, `upper b, w ${w}`);
    near(upper(60 + w), 1, `upper b+w, w ${w}`);
    for (let k = 60 - w; k <= 60 + w; k++) near(lower(k) ** 2 + upper(k) ** 2, 1, `power at ${k}`);
    assert.equal(lower(60 - w - 1), 1);
    assert.ok(lower(60 + w + 1) < XFADE_FLOOR);
  }
});

test('a run over several played segments fades only at its outer boundaries', () => {
  const b = [bound('Low', 48, 12), bound('Mid', 60, 12), bound('High', 72, 12)];
  const mid = 0b0110; // zones 2 and 3
  near(zoneGain(b, mid, 60), 1, 'no fade at the Mid point inside the run');
  near(zoneGain(b, mid, 48), HALF, 'fade in at Low');
  near(zoneGain(b, mid, 72), HALF, 'fade out at High');
  assert.ok(zoneGain(b, mid, 36) <= XFADE_FLOOR);
  // Neighbouring fades overlap in a narrow zone: zone 3 alone at its centre is faded from both sides.
  near(zoneGain(b, 0b0100, 66), Math.sin(0.75 * Math.PI / 2) * Math.cos(0.25 * Math.PI / 2), 'narrow zone');
  // Two separate runs, zones 1 and 3: the larger of the two fades wins, and nothing plays in between.
  const wide = [bound('Low', 36, 6), bound('Mid', 60, 6), bound('High', 84, 6)];
  near(zoneGain(wide, 0b0101, 30), 1, 'lower run');
  near(zoneGain(wide, 0b0101, 72), 1, 'upper run');
  assert.equal(zoneGain(wide, 0b0101, 48), 0);
  near(zoneGain(wide, 0b0101, 57), Math.sin(0.25 * Math.PI / 2), 'fading into the upper run');
});

test('a run across a disabled point: its zones merge, no boundary there', () => {
  const s = fresh();
  split(s, { Low: { pos: 2 }, High: { pos: 6 } }); // C3 and C5 on, Mid off
  s.set('synthA.kbZone', 2); // cfg Low+High: '111o' = zones 1–3, i.e. below C5
  const b = splitBoundaries(s);
  assert.deepEqual(b.map((x) => x.point), ['Low', 'High']);
  const mask = zoneMask(s, 'synthA.kbZone');
  for (const k of [30, 47, 48, 60, 71]) assert.equal(zoneGain(b, mask, k), 1, `key ${k}`);
  assert.equal(zoneGain(b, mask, 72), 0);
});

// ---------------------------------------------------------------------------------------------
// routeNote and transpose

test('routeNote: split off plays every enabled layer at 1, whatever its zone', () => {
  const s = fresh();
  s.setMany([['common.sectionEnablePno_I', 1], ['piano.layerEnablePno_I', 3], ['synth.layerEnableSyn_I', 5],
    ['synthA.kbZone', 0], ['pianoB.kbZone', 10]], 'ui');
  const r = routeNote(s, 60);
  assert.equal(r.note, 60);
  assert.deepEqual(r.routes, [
    { section: 'piano', layers: [{ layer: 'A', gain: 1 }, { layer: 'B', gain: 1 }] },
    { section: 'synth', layers: [{ layer: 'A', gain: 1 }, { layer: 'C', gain: 1 }] },
  ]);
});

test('routeNote: sections in organ, piano, synth order; zones per layer; crossfade gains; hits at the floor dropped', () => {
  const s = fresh();
  s.setMany([['common.sectionEnableOrg_I', 1], ['organ.layerEnableOrg_I', 1], ['common.sectionEnablePno_I', 1],
    ['piano.layerEnablePno_I', 1]], 'ui');
  split(s, { Mid: { pos: 4, width: 1 } }); // C4 ±6
  s.setMany([['pianoA.kbZone', 0], ['synthA.kbZone', 6], ['organA.kbZone', 5]], 'ui'); // lower, upper, all
  assert.equal(ns4Label('pianoA.kbZone', 0, s), '11oo');
  assert.equal(ns4Label('synthA.kbZone', 6, s), 'oo11');
  const at = (k: number) => routeNote(s, k).routes.map((r) => [r.section, r.layers.map((h) => +h.gain.toFixed(4))]);
  assert.deepEqual(at(40), [['organ', [1]], ['piano', [1]]]);
  assert.deepEqual(at(54), [['organ', [1]], ['piano', [1]]], 'b − w: the upper zone is at 0 and dropped');
  assert.deepEqual(at(60), [['organ', [1]], ['piano', [0.7071]], ['synth', [0.7071]]]);
  assert.deepEqual(at(66), [['organ', [1]], ['synth', [1]]]);
});

test('routeNote: a section that is off, or a layer that is off, is not routed', () => {
  const s = fresh();
  s.set('synth.layerEnableSyn_I', 0);
  assert.deepEqual(routeNote(s, 60).routes, []);
  s.set('synth.layerEnableSyn_I', 1);
  s.set('common.sectionEnableSyn_I', 0);
  assert.deepEqual(routeNote(s, 60).routes, []);
});

test('routeNote follows the active scene', () => {
  const s = fresh();
  assert.deepEqual(routeNote(s, 60).routes.map((r) => r.section), ['synth']);
  s.set('common.layerScene', 1); // scene II keeps the layout defaults: piano layer A
  assert.deepEqual(routeNote(s, 60).routes, [{ section: 'piano', layers: [{ layer: 'A', gain: 1 }] }]);
});

test('transpose: only while enabled; moves the sounding note, not the zones; out of range is not played', () => {
  const s = fresh();
  s.set('common.transposeValue', 5);
  assert.equal(transposeSemitones(s), 0, 'transpose off');
  assert.equal(routeNote(s, 60).note, 60);
  s.set('common.transposeEnable', 1);
  assert.equal(transposeSemitones(s), 5);
  assert.equal(routeNote(s, 60).note, 65);
  assert.deepEqual(routeNote(s, 123), { key: 123, note: null, routes: [] });
  s.set('common.transposeValue', -6);
  assert.equal(routeNote(s, 6).note, 0);
  assert.equal(routeNote(s, 5).note, null);
  // Zones use the physical key: a lower-zone layer below C4 still plays key 59 transposed up to 65.
  s.set('common.transposeValue', 6);
  split(s, { Mid: { pos: 4 } });
  s.set('synthA.kbZone', 0); // '11oo': below C4
  assert.equal(routeNote(s, 59).routes.length, 1);
  assert.equal(routeNote(s, 59).note, 65);
  assert.equal(routeNote(s, 60).routes.length, 0);
});

// ---------------------------------------------------------------------------------------------
// Router with fake engines

class FakeEngine<S extends SectionId> implements SectionEngine<S> {
  readonly section: S;
  readonly events: SectionEvent[] = [];
  readonly batches: Array<readonly Change[]> = [];
  panics = 0;
  reloads = 0;
  disposed = false;
  count = 0;
  constructor(section: S) {
    this.section = section;
  }
  handle(e: SectionEvent): void { this.events.push(e); }
  applyChanges(batch: readonly Change[]): void { this.batches.push(batch); }
  panic(): void { this.panics += 1; }
  reload(): void { this.reloads += 1; }
  get activeCount(): number { return this.count; }
  dispose(): void { this.disposed = true; }
}

function rig() {
  const store = fresh();
  const organ = new FakeEngine('organ');
  const piano = new FakeEngine('piano');
  const synth = new FakeEngine('synth');
  const router = new Router(store, { organ, piano, synth });
  store.onChange((batch) => router.applyChanges(batch));
  const on = (note: number, velocity = 100): void => router.handle({ type: 'noteOn', note, velocity, source: 'midi' });
  const off = (note: number): void => router.handle({ type: 'noteOff', note, source: 'midi' });
  const notes = (e: FakeEngine<SectionId>) => e.events
    .filter((x) => x.type === 'noteOn' || x.type === 'noteOff')
    .map((x) => (x.type === 'noteOn' ? `on ${x.key}>${x.note}` : `off ${x.key}>${x.note}`));
  return { store, organ, piano, synth, router, on, off, notes };
}

test('Router: a routed note-on and its note-off reach only the section that plays', () => {
  const { organ, piano, synth, router, on, off, notes } = rig();
  on(60, 90);
  assert.deepEqual(synth.events, [{ type: 'noteOn', key: 60, note: 60, velocity: 90, layers: [{ layer: 'A', gain: 1 }] }]);
  assert.deepEqual(router.held(), [{ key: 60, note: 60, sections: ['synth'] }]);
  off(60);
  assert.deepEqual(notes(synth), ['on 60>60', 'off 60>60']);
  assert.deepEqual([organ.events, piano.events], [[], []]);
  assert.deepEqual(router.held(), []);
  off(60);
  assert.equal(synth.events.length, 2, 'an unknown key sends nothing');
});

test('Router: split sends the lower key to one section and the upper key to another', () => {
  const { store, piano, synth, on, notes } = rig();
  store.setMany([['common.sectionEnablePno_I', 1], ['piano.layerEnablePno_I', 1]], 'ui');
  split(store, { Mid: { pos: 4 } });
  store.setMany([['pianoA.kbZone', 0], ['synthA.kbZone', 6]], 'ui');
  on(50);
  on(70);
  assert.deepEqual(notes(piano), ['on 50>50']);
  assert.deepEqual(notes(synth), ['on 70>70']);
});

test('Router: noteOff after a transpose edit uses the remembered sounding note', () => {
  const { store, synth, on, off, notes } = rig();
  store.setMany([['common.transposeEnable', 1], ['common.transposeValue', 2]], 'ui');
  on(60);
  store.set('common.transposeValue', 5);
  off(60);
  assert.deepEqual(notes(synth), ['on 60>62', 'off 60>62']);
});

test('Router: a key whose sounding note another held key already plays ends that key first', () => {
  const { store, synth, router, on, off, notes } = rig();
  store.setMany([['common.transposeEnable', 1], ['common.transposeValue', 2]], 'ui');
  on(60); // sounds 62
  store.set('common.transposeValue', 0);
  on(62); // sounds 62 as well
  assert.deepEqual(notes(synth), ['on 60>62', 'off 60>62', 'on 62>62']);
  off(60);
  assert.equal(notes(synth).length, 3, 'the first key was already ended');
  assert.deepEqual(router.held().map((h) => h.key), [62]);
});

test('Router: a key pressed again without a note-off ends its earlier note first', () => {
  const { synth, on, notes } = rig();
  on(60);
  on(60);
  assert.deepEqual(notes(synth), ['on 60>60', 'off 60>60', 'on 60>60']);
});

test('Router: a scene switch does not cut a held note; new notes follow the new scene', () => {
  const { store, piano, synth, on, off, notes } = rig();
  on(60);
  store.set('common.layerScene', 1);
  on(64);
  off(60);
  off(64);
  assert.deepEqual(notes(synth), ['on 60>60', 'off 60>60']);
  assert.deepEqual(notes(piano), ['on 64>64', 'off 64>64']);
});

test('Router: a key nothing plays (or out of range) is neither sent nor remembered', () => {
  const { store, organ, piano, synth, router, on } = rig();
  store.set('common.sectionEnableSyn_I', 0);
  on(60);
  store.setMany([['common.sectionEnableSyn_I', 1], ['common.transposeEnable', 1], ['common.transposeValue', 6]], 'ui');
  on(125);
  assert.deepEqual([organ.events, piano.events, synth.events], [[], [], []]);
  assert.deepEqual(router.held(), []);
});

test('Router: sustain, bend and controllers go to every engine; panic forgets held keys', () => {
  const { organ, piano, synth, router, on, off } = rig();
  router.handle({ type: 'sustain', on: true });
  router.handle({ type: 'bend', value: 4000 });
  router.handle({ type: 'controller', kind: 'wheel', value: 64 });
  for (const e of [organ, piano, synth]) {
    assert.deepEqual(e.events, [{ type: 'sustain', on: true }, { type: 'bend', value: 4000 },
      { type: 'controller', kind: 'wheel', value: 64 }], e.section);
  }
  on(60);
  router.handle({ type: 'panic' });
  assert.deepEqual([organ.panics, piano.panics, synth.panics], [1, 1, 1]);
  assert.deepEqual(router.held(), []);
  const before = synth.events.length;
  off(60);
  assert.equal(synth.events.length, before, 'no note-off after panic');
});

test('Router: store batches reach every engine; a load forgets held keys; reload, count and dispose fan out', () => {
  const { store, organ, piano, synth, router, on, off } = rig();
  store.set('synthASound.fltFreq', 40);
  for (const e of [organ, piano, synth]) assert.equal(e.batches.length, 1, e.section);
  on(60);
  store.load(initProgram(), 'load');
  assert.deepEqual(router.held(), []);
  assert.ok(synth.batches.at(-1)!.some((c) => c.origin === 'load'));
  const before = synth.events.length;
  off(60);
  assert.equal(synth.events.length, before);
  organ.count = 2;
  synth.count = 3;
  assert.equal(router.activeCount, 5);
  router.reload();
  assert.deepEqual([organ.reloads, piano.reloads, synth.reloads], [1, 1, 1]);
  router.dispose();
  assert.ok(organ.disposed && piano.disposed && synth.disposed);
});

test('Router: a missing engine is never routed to and its key is not remembered', () => {
  const store = fresh();
  const synth = new FakeEngine('synth');
  const router = new Router(store, { synth });
  store.setMany([['common.sectionEnablePno_I', 1], ['piano.layerEnablePno_I', 1], ['common.sectionEnableSyn_I', 0]], 'ui');
  router.handle({ type: 'noteOn', note: 60, velocity: 100, source: 'midi' });
  assert.deepEqual(router.held(), []);
  assert.deepEqual(synth.events, []);
});

// ---------------------------------------------------------------------------------------------
// Router-owned keys

test('isRouterKey: scene, scene switches, split, transpose and every kbZone; nothing else', () => {
  assert.equal(SCENE_KEYS.length, 18);
  for (const k of [...SCENE_KEYS, ...ZONE_KEYS, 'common.layerScene', 'common.splitEnabled', 'common.splitPosHigh',
    'common.splitWidthLow', 'common.transposeEnable', 'common.transposeValue'] as Ns4Key[]) {
    assert.ok(isRouterKey(k), k);
  }
  for (const k of ['synthASound.fltFreq', 'common.masterClockRate', 'common.pdlLayerSceneEnable', 'organ.layerLevelOrgA',
    'pianoA.octaveShift', 'common.auxKbdEnable'] as Ns4Key[]) {
    assert.ok(!isRouterKey(k), k);
  }
});

test('every live or unverified program-region field is router-owned', () => {
  for (const d of DESCRIPTORS.values()) {
    if (d.region === 'program' && (d.status === 'live' || d.status === 'unverified')) assert.ok(isRouterKey(d.key), d.key);
  }
});
