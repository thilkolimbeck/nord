/**
 * A second listener on one section's routed events (plan section 15.6): the extern MIDI output
 * (midi/extern.ts) hears every note the router hands the synth, with the layers and crossfade
 * gains the router chose, without the router or the synth engine knowing about MIDI. main wires
 * `teeSection(synth, extern)` into the router in place of the synth engine. The sink is structural,
 * so midi/ implements it without importing audio/. No Web Audio, no DOM.
 */
import type { Change } from '../model/store.ts';
import type { LayerOf, SectionEngine, SectionEvent, SectionId } from './section.ts';

/** What a sink receives: the same events, changes and panics as the engine. */
export interface SectionSink<S extends SectionId = SectionId> {
  handle(e: SectionEvent<LayerOf<S>>): void;
  applyChanges(batch: readonly Change[]): void;
  panic(): void;
}

/**
 * The engine, with every event, batch and panic also handed to `sink` (after the engine). A
 * throwing sink does not stop the sound: the engine has already played the event. reload() and
 * dispose() reach the engine only (a reload is a panic for the sink); activeCount is the engine's.
 */
export function teeSection<S extends SectionId>(engine: SectionEngine<S>, sink: SectionSink<S>): SectionEngine<S> {
  const quiet = (fn: () => void): void => {
    try {
      fn();
    } catch (err) {
      // The sink (MIDI out) must never break local sound; report and go on.
      console.error(err);
    }
  };
  return {
    section: engine.section,
    handle(e) {
      engine.handle(e);
      quiet(() => sink.handle(e));
    },
    applyChanges(batch) {
      engine.applyChanges(batch);
      quiet(() => sink.applyChanges(batch));
    },
    panic() {
      engine.panic();
      quiet(() => sink.panic());
    },
    reload() {
      engine.reload();
      quiet(() => sink.panic());
    },
    get activeCount() {
      return engine.activeCount;
    },
    dispose() {
      engine.dispose();
      quiet(() => sink.panic());
    },
  };
}
