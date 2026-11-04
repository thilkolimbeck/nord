/**
 * The contract between the note router and the three section engines (plan section 13.5).
 *
 *   PlayEvent ─► NoteGate (main) ─► Router ─► routeNote(values, key): which layers of which section
 *                                     │        play the key, each with its split crossfade gain
 *                                     ├─► OrganEngine.handle(SectionEvent<'organ'>)
 *                                     ├─► PianoEngine.handle(SectionEvent<'piano'>)
 *                                     └─► SynthEngine.handle(SectionEvent<'synth'>)
 *   every engine ─► SectionContext.out (the shared master: −12 dB headroom, limiter) ─► destination
 *
 * The router owns the program logic: the active layer scene, section and layer switches, split
 * points with their crossfades, each layer's keyboard zones and the program transpose. An engine
 * only plays what it is handed: its layer's own sound, octave shift, pitch stick, sustain switch
 * and level. Types and constants only: no Web Audio, no DOM.
 */
import type { PlayEvent } from '../input/events.ts';
import type { ValueReader } from '../model/labels.ts';
import type { LayerOf, SectionId } from '../model/scene.ts';
import type { Change } from '../model/store.ts';

export type { LayerOf, OrganLayer, PianoLayer, SectionId } from '../model/scene.ts';

/** Router hits below this crossfade gain are dropped: the layer does not start a voice. */
export const XFADE_FLOOR = 0.001;

/** One layer of one section that plays a note. */
export interface LayerHit<L extends string = string> {
  readonly layer: L;
  /**
   * XFADE_FLOOR < gain ≤ 1: the split crossfade weight of this layer at this key (1 outside every
   * xfade region and while split is off). The engine multiplies the voice's output by it, once, at
   * note-on; it does not follow later split edits.
   */
  readonly gain: number;
}

/** A key goes down: the layers of one section that play it. */
export interface RoutedNoteOn<L extends string = string> {
  readonly type: 'noteOn';
  /** The physical key (MIDI number, 0..127) before transpose; the zones were computed from it. */
  readonly key: number;
  /**
   * The sounding note: key + program transpose (0..127). It names the note until its noteOff,
   * which carries the same value even when the transpose changed meanwhile. The engine adds its
   * own layer octave shift and pitch stick.
   */
  readonly note: number;
  /** 1..127. */
  readonly velocity: number;
  /** Non-empty; each layer at most once, in layer order. */
  readonly layers: readonly LayerHit<L>[];
}

/** The key comes up: release every voice of `note` in this section, whatever layers it started on. */
export interface RoutedNoteOff {
  readonly type: 'noteOff';
  readonly key: number;
  readonly note: number;
}

type Broadcast = Extract<PlayEvent, { type: 'sustain' | 'bend' | 'controller' }>;

/**
 * What an engine receives. Sustain, bend and controllers go to every engine unchanged; each
 * applies them per layer (sustain and pitch stick switches). Panic is the panic() method.
 */
export type SectionEvent<L extends string = string> = RoutedNoteOn<L> | RoutedNoteOff | Broadcast;

/** Everything an engine needs at construction. */
export interface SectionContext {
  readonly ctx: BaseAudioContext;
  /** The program values (the store); engines read them, never write. */
  readonly values: ValueReader;
  /** Where the section's stereo output goes: the shared master input. */
  readonly out: AudioNode;
}

/** One section's sound generator. OrganEngine, PianoEngine and SynthEngine implement it. */
export interface SectionEngine<S extends SectionId = SectionId> {
  readonly section: S;
  /** Play a routed note or a broadcast event. Never throws for a layer it cannot play (it stays silent). */
  handle(e: SectionEvent<LayerOf<S>>): void;
  /**
   * Follow a batch of store changes. Keys of other sections are ignored. A batch with origin
   * 'load' or 'init' means a new program: the engine runs reload() itself.
   */
  applyChanges(batch: readonly Change[]): void;
  /** All notes off at once: activeCount is 0 when it returns; the nodes fade out over about 10 ms. */
  panic(): void;
  /** After a program load: panic, then set every layer from the new values. */
  reload(): void;
  /** Voices (organ: note-layers) held, sustained or still releasing. */
  readonly activeCount: number;
  /** panic(), then disconnect and stop every node the engine created. The engine is unusable afterwards. */
  dispose(): void;
}

export type SectionFactory<S extends SectionId = SectionId> = (c: SectionContext) => SectionEngine<S>;

/** The engines the router drives; a missing section is never routed to. */
export type SectionEngines = { readonly [S in SectionId]?: SectionEngine<S> };

/** The layers of one section that play a key. */
export interface SectionRoute<S extends SectionId = SectionId> {
  readonly section: S;
  /** Non-empty, in layer order. */
  readonly layers: readonly LayerHit<LayerOf<S>>[];
}

/** SectionRoute as a union discriminated by `section`. */
export type AnySectionRoute = { [S in SectionId]: SectionRoute<S> }[SectionId];

/** Where a key goes: the router's pure answer for the current values (plan section 13.5). */
export interface NoteRouting {
  readonly key: number;
  /** key + transpose; null when that falls outside 0..127 (the key is not played). */
  readonly note: number | null;
  /** Sections with at least one hit, in the order organ, piano, synth. Empty when nothing plays the key. */
  readonly routes: readonly AnySectionRoute[];
}

/** The routing function audio/router.ts exports as `routeNote`. */
export type RouteNote = (values: ValueReader, key: number) => NoteRouting;
