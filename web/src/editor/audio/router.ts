/**
 * The program logic of the editor (plan sections 13.4 and 13.5): which layers of which section
 * play a key, at what crossfade gain, and at which sounding note.
 *
 *   PlayEvent ─► Router.handle ─► routeNote(values, key)
 *                                   active layer scene (M p.15, 43): section and layer switches
 *                                   split points, xfade widths, each layer's kbZone (M p.39)
 *                                   program transpose (M p.40)
 *                                 ─► RoutedNoteOn / RoutedNoteOff ─► organ, piano, synth engines
 *
 * The pure part (splitBoundaries, zoneMask, zoneGain, transposeSemitones, routeNote) reads only the
 * program values. The Router keeps which sections each held key went to and at which sounding
 * note, so its noteOff reaches the same voices after a scene, split or transpose edit. Scene,
 * section and layer switches do not cut sounding notes (assumed; the manual promises switching
 * "instantly and seamlessly", p.43). No Web Audio, no DOM.
 */
import type { PlayEvent } from '../input/events.ts';
import type { Ns4Key } from '../model/keys.ts';
import { ns4Label, type ValueReader } from '../model/labels.ts';
import { enabledLayers, type LayerOf, parseSceneKey, SCENE_KEY, SECTIONS, type SectionId } from '../model/scene.ts';
import type { Change } from '../model/store.ts';
import {
  type AnySectionRoute, type LayerHit, type NoteRouting, type RouteNote, type SectionEngine, type SectionEngines,
  type SectionRoute, XFADE_FLOOR,
} from './section.ts';

// ---------------------------------------------------------------------------------------------
// Split points (M p.39)

/** The split note of each splitPos value (tables 050-5, 051-1, 051-5: C2 … C7, C4 = MIDI 60). */
export const SPLIT_NOTES: readonly number[] = [36, 41, 48, 53, 60, 65, 72, 77, 84, 89, 96];

/** The crossfade half width of each splitWidth value (tables 052-1, 052-3, 052-5: none, ±6, ±12 semitones). */
const SPLIT_WIDTHS: readonly (0 | 6 | 12)[] = [0, 6, 12];

export type SplitPoint = 'Low' | 'Mid' | 'High';
const POINTS: readonly SplitPoint[] = ['Low', 'Mid', 'High'];

/** The zone that starts above a split point: Low → 2, Mid → 3, High → 4 (zone 1 lies below every point). */
const ZONE_ABOVE: Readonly<Record<SplitPoint, number>> = { Low: 2, Mid: 3, High: 4 };

export interface SplitBoundary {
  /**
   * The point whose zone starts above this boundary (Low → 2, Mid → 3, High → 4). The k-th lowest
   * enabled position takes the k-th enabled point in Low, Mid, High order, so the zones always
   * rise with the keys, even when the stored positions are out of order (Low above Mid). Whether
   * the Stage 4 allows such positions is unknown; for ordered ones this is the stored point.
   */
  readonly point: SplitPoint;
  /** The split note; it belongs to the zone above (assumed). */
  readonly note: number;
  /** Crossfade half width in semitones: the zone below reaches `width` notes above the split, the zone above as far below. */
  readonly width: 0 | 6 | 12;
}

/**
 * The enabled split points, sorted by note (ties: Low, Mid, High); empty while split is off. Each
 * keeps its own position and width; the zone names are handed out by rank (SplitBoundary.point).
 */
export function splitBoundaries(values: ValueReader): readonly SplitBoundary[] {
  if (values.get('common.splitEnabled') === 0) return [];
  const out: SplitBoundary[] = [];
  for (const point of POINTS) {
    if (values.get(`common.splitEnabled${point}`) === 0) continue;
    const note = SPLIT_NOTES[values.get(`common.splitPos${point}`)];
    if (note === undefined) continue;
    out.push({ point, note, width: SPLIT_WIDTHS[values.get(`common.splitWidth${point}`)] ?? 0 });
  }
  // The points in Low, Mid, High order, before sorting; Array.prototype.sort is stable, so ties keep that order.
  const ranks = out.map((b) => b.point);
  return out.sort((a, b) => a.note - b.note).map((b, i) => ({ ...b, point: ranks[i]! }));
}

const ALL_ZONES = 0b1111;
const ZONE_LABEL = /^[1o]{4}$/;

/**
 * The zones a layer plays, from the label of its kbZone value in the split-dependent table
 * (dep tables 113-1 organ, 243-1 piano, 414-3 synth): character z is zone z, '1' plays, 'o' does
 * not. Bit z−1 is zone z. A value without a label plays every zone.
 */
export function zoneMask(values: ValueReader, kbZoneKey: Ns4Key): number {
  const label = ns4Label(kbZoneKey, values.get(kbZoneKey), values);
  if (label === null || !ZONE_LABEL.test(label)) return ALL_ZONES;
  let mask = 0;
  for (let z = 0; z < 4; z++) if (label[z] === '1') mask |= 1 << z;
  return mask;
}

/** Equal-power fade into the zone above boundary b (guessed curve): 0 at b − w, √½ at b, 1 at b + w. */
function fadeIn(key: number, b: SplitBoundary | null): number {
  if (b === null) return 1;
  if (b.width === 0) return key >= b.note ? 1 : 0;
  const x = fadePosition(key, b);
  return x === 0 ? 0 : x === 1 ? 1 : Math.sin(x * Math.PI / 2);
}

/** Equal-power fade out of the zone below boundary b: 1 at b − w, √½ at b, 0 at b + w. */
function fadeOut(key: number, b: SplitBoundary | null): number {
  if (b === null) return 1;
  if (b.width === 0) return key < b.note ? 1 : 0;
  const x = fadePosition(key, b);
  return x === 0 ? 1 : x === 1 ? 0 : Math.cos(x * Math.PI / 2);
}

function fadePosition(key: number, b: SplitBoundary): number {
  return Math.min(1, Math.max(0, (key - (b.note - b.width)) / (2 * b.width)));
}

/**
 * The crossfade gain of a layer with zone mask `mask` at physical key `key` (plan 13.4 steps 2–4).
 * Segment 0 lies below the first boundary and has zone 1; the segment above a boundary has that
 * point's zone. Consecutive played segments form a run; the gain is the largest, over the runs,
 * of the fade into the run at its lower boundary times the fade out at its upper one. Without
 * boundaries (split off) every layer plays every key at 1.
 */
export function zoneGain(boundaries: readonly SplitBoundary[], mask: number, key: number): number {
  if (boundaries.length === 0) return 1;
  const played = (segment: number): boolean => {
    const zone = segment === 0 ? 1 : ZONE_ABOVE[boundaries[segment - 1]!.point];
    return (mask & (1 << (zone - 1))) !== 0;
  };
  let gain = 0;
  let segment = 0;
  while (segment <= boundaries.length) {
    if (!played(segment)) {
      segment += 1;
      continue;
    }
    const first = segment;
    while (segment + 1 <= boundaries.length && played(segment + 1)) segment += 1;
    const lower = first === 0 ? null : boundaries[first - 1]!;
    const upper = segment === boundaries.length ? null : boundaries[segment]!;
    gain = Math.max(gain, fadeIn(key, lower) * fadeOut(key, upper));
    segment += 1;
  }
  return gain;
}

// ---------------------------------------------------------------------------------------------
// Transpose (M p.40) and routing

/** The program transpose in semitones: transposeValue while transposeEnable is on, else 0. It moves every layer. */
export function transposeSemitones(values: ValueReader): number {
  return values.get('common.transposeEnable') === 0 ? 0 : values.get('common.transposeValue');
}

/** The kbZone key of a layer: organA.kbZone, pianoB.kbZone, synthC.kbZone. */
function kbZoneKey(section: SectionId, layer: string): Ns4Key {
  return `${section}${layer}.kbZone` as Ns4Key;
}

function sectionRoute<S extends SectionId>(values: ValueReader, section: S, boundaries: readonly SplitBoundary[],
  key: number): SectionRoute<S> | null {
  const layers: LayerHit<LayerOf<S>>[] = [];
  for (const layer of enabledLayers(values, section)) {
    const gain = boundaries.length === 0 ? 1 : zoneGain(boundaries, zoneMask(values, kbZoneKey(section, layer)), key);
    if (gain > XFADE_FLOOR) layers.push({ layer, gain: Math.min(1, gain) });
  }
  return layers.length === 0 ? null : { section, layers };
}

/**
 * Where a physical key goes now: the sounding note (key + transpose; null outside 0..127) and, per
 * section in the order organ, piano, synth, the layers of the active scene that play the key with
 * their crossfade gains. Zones use the physical key; the transpose moves only the pitch (assumed).
 */
export const routeNote: RouteNote = (values: ValueReader, key: number): NoteRouting => {
  const sounding = key + transposeSemitones(values);
  if (!Number.isInteger(sounding) || sounding < 0 || sounding > 127) return { key, note: null, routes: [] };
  const boundaries = splitBoundaries(values);
  const routes: AnySectionRoute[] = [];
  for (const section of SECTIONS) {
    const route = sectionRoute(values, section, boundaries, key);
    if (route !== null) routes.push(route as AnySectionRoute);
  }
  return { key, note: sounding, routes };
};

const KB_ZONE = /^(?:organ|piano|synth)[ABC]\.kbZone$/;

/**
 * Whether the router owns a key (plan 13.1): the active scene, the 18 scene switches, split points
 * and widths, transpose and every layer's kbZone. They matter only at the next note-on; no engine
 * reacts to them.
 */
export function isRouterKey(key: Ns4Key): boolean {
  return key === SCENE_KEY || parseSceneKey(key) !== null || key.startsWith('common.split')
    || key.startsWith('common.transpose') || KB_ZONE.test(key);
}

// ---------------------------------------------------------------------------------------------
// Router

interface Held {
  readonly note: number;
  readonly sections: readonly SectionId[];
}

/** Drives the section engines from play events and store changes (plan section 13.5). */
export class Router {
  readonly #values: ValueReader;
  readonly #engines: SectionEngines;
  /** Physical key → the sounding note and the sections its noteOn went to. */
  readonly #held = new Map<number, Held>();

  constructor(values: ValueReader, engines: SectionEngines) {
    this.#values = values;
    this.#engines = engines;
  }

  handle(e: PlayEvent): void {
    switch (e.type) {
      case 'noteOn':
        this.#noteOn(e.note, e.velocity);
        return;
      case 'noteOff':
        this.#release(e.note);
        return;
      case 'sustain':
      case 'bend':
      case 'controller':
        for (const engine of this.#each()) engine.handle(e);
        return;
      case 'panic':
        this.panic();
        return;
    }
  }

  /** Hands the batch to every engine; a load or init batch first forgets every held key (the engines reload). */
  applyChanges(batch: readonly Change[]): void {
    if (batch.some((c) => c.origin === 'load' || c.origin === 'init')) this.#held.clear();
    for (const engine of this.#each()) engine.applyChanges(batch);
  }

  panic(): void {
    this.#held.clear();
    for (const engine of this.#each()) engine.panic();
  }

  reload(): void {
    this.#held.clear();
    for (const engine of this.#each()) engine.reload();
  }

  /** Voices of every engine (organ: note-layers) held, sustained or releasing. */
  get activeCount(): number {
    let n = 0;
    for (const engine of this.#each()) n += engine.activeCount;
    return n;
  }

  /** Keys held now, with their sounding note and sections, for inspection. */
  held(): Array<{ key: number; note: number; sections: readonly SectionId[] }> {
    return [...this.#held].map(([key, h]) => ({ key, note: h.note, sections: h.sections }));
  }

  dispose(): void {
    this.#held.clear();
    for (const engine of this.#each()) engine.dispose();
  }

  #noteOn(key: number, velocity: number): void {
    // A key pressed again without its note off: end the earlier note first, so nothing hangs.
    this.#release(key);
    const routing = routeNote(this.#values, key);
    if (routing.note === null || routing.routes.length === 0) return;
    const note = routing.note;
    // Another held key with the same sounding note (a transpose edit in between): it ends first.
    for (const [other, h] of this.#held) if (h.note === note) this.#release(other);
    const sections: SectionId[] = [];
    for (const route of routing.routes) {
      const sent = this.#send(route, key, note, velocity);
      if (sent) sections.push(route.section);
    }
    if (sections.length > 0) this.#held.set(key, { note, sections });
  }

  #send(route: AnySectionRoute, key: number, note: number, velocity: number): boolean {
    switch (route.section) {
      case 'organ': {
        const engine = this.#engines.organ;
        engine?.handle({ type: 'noteOn', key, note, velocity, layers: route.layers });
        return engine !== undefined;
      }
      case 'piano': {
        const engine = this.#engines.piano;
        engine?.handle({ type: 'noteOn', key, note, velocity, layers: route.layers });
        return engine !== undefined;
      }
      case 'synth': {
        const engine = this.#engines.synth;
        engine?.handle({ type: 'noteOn', key, note, velocity, layers: route.layers });
        return engine !== undefined;
      }
    }
  }

  #release(key: number): void {
    const h = this.#held.get(key);
    if (h === undefined) return;
    this.#held.delete(key);
    for (const section of h.sections) this.#engine(section)?.handle({ type: 'noteOff', key, note: h.note });
  }

  #engine(section: SectionId): SectionEngine | undefined {
    return this.#engines[section];
  }

  *#each(): Generator<SectionEngine> {
    for (const section of SECTIONS) {
      const engine = this.#engine(section);
      if (engine !== undefined) yield engine;
    }
  }
}
