/**
 * Composition root of the Stage 4 editor (/nord): builds the store from the init program and
 * mounts the page, the panel, the display, the synth region, the program, organ, piano and layer
 * effects regions, the extern · midi region, the controller strip and the print-out; then wires
 * play input (computer keys, virtual keyboard, controller strip, MIDI) through the play bus to the
 * note router, which plays the organ, piano and synth engines on one shared master (plan section
 * 13.5) through the layer effects and the global units (plan section 15.1).
 *
 * Plan section 15.12 wiring: every engine, effects chain, global unit and the extern output read
 * one MorphedValues over the store, so morphs sound without the engines knowing (15.2); a moved
 * wheel, pressure or pedal becomes 'morph' changes for the engines only, never for the store or
 * MIDI out. Own samples live in IndexedDB on this device and reach the synth through a source
 * provider (15.3); the AudioWorklet voices load at audio start and the native voice plays until
 * they are ready (15.7). MIDI control in, MIDI out and extern send nothing until the user switches
 * them on (15.4–15.6); SysEx is never requested. DOM calls only, no inline styles or scripts, so
 * the page works under a strict CSP.
 */
import { SynthEngine } from './audio/engine.ts';
import { globalFxFactory } from './audio/fx/global.ts';
import { fxChainFactory } from './audio/fx/chain.ts';
import type { ClockReader, FxHooks, GlobalFx } from './audio/fx/types.ts';
import { NoteGate } from './audio/gate.ts';
import { AudioHost } from './audio/host.ts';
import { clockBpm, coarsePatterns, SAMPLES_MODE_SILENT, silentLayers } from './audio/mapping.ts';
import { MasterBus } from './audio/master.ts';
import { OrganEngine } from './audio/organ/engine.ts';
import { pianoFactory } from './audio/piano/engine.ts';
import { Router } from './audio/router.ts';
import { decodeSample } from './audio/samples/decode.ts';
import { SampleSources } from './audio/samples/provider.ts';
import type { SectionContext, SectionEngine } from './audio/section.ts';
import { teeSection } from './audio/tee.ts';
import { createWorkletVoices, type WorkletVoices } from './audio/worklet/engine.ts';
import { WORKLET_MODULE_URL } from './audio/worklet/module-url.ts';
import { openSampleStore, type SampleStore } from './formats/samples-db.ts';
import { readSettings, storedMidiOut, writeSettings } from './formats/settings.ts';
import { bindComputerKeys, ComputerKeys, keyLabels } from './input/computer-keys.ts';
import { ScreenControllers } from './input/controllers.ts';
import { HeldNotes, NoteMerge, PlayBus, type PlayEvent } from './input/events.ts';
import { bindReleaseOnHide } from './input/hide.ts';
import { PointerNotes } from './input/pointer.ts';
import {
  canEnableMidi, MidiInput, type MidiNavigator, midiLed, type MidiStatus, midiStatusDescription, midiStatusText,
} from './midi/access.ts';
import { MidiControlIn } from './midi/cc-in.ts';
import { ExternOut } from './midi/extern.ts';
import { MidiOut } from './midi/send.ts';
import { initProgram } from './model/init.ts';
import { patternOf, type SynthLayer } from './model/keys.ts';
import { MorphedValues, positionOf, SOURCE_OF_CONTROLLER } from './model/morph.ts';
import { focusedLayer } from './model/scene.ts';
import { type Change, ParamStore } from './model/store.ts';
import { SampleAssignments } from './model/user-samples.ts';
import { mountControllerStrip } from './ui/controller-strip.ts';
import { mountDisplay } from './ui/display.ts';
import { mountFileBar } from './ui/file-bar.ts';
import { browserStorage, type PresetSamples } from './ui/files.ts';
import { mountKeyboard } from './ui/keyboard-view.ts';
import { mountMidiPanel } from './ui/midi-panel.ts';
import { OwnSamples } from './ui/own-samples.ts';
import { mountColophon, renderPage } from './ui/page.ts';
import { mountPanel } from './ui/panel.ts';
import { mountPrintout } from './ui/printout.ts';
import { type MidiStatusView, mountStatusBar, setMidiStatus } from './ui/status-bar.ts';
import { mountSynthPanel } from './ui/synth-panel.ts';

/** The browser's sample storage, or a rejection when it has none (private modes, very old browsers). */
function openDeviceSamples(): Promise<SampleStore> {
  const idb = (globalThis as { indexedDB?: IDBFactory }).indexedDB;
  if (idb === undefined) return Promise.reject(new Error('this browser keeps no sample storage here: own samples are not available'));
  const storage = (navigator as { storage?: StorageManager }).storage;
  return storage !== undefined && typeof storage.estimate === 'function'
    ? openSampleStore(idb, { estimate: () => storage.estimate() })
    : openSampleStore(idb);
}

function start(root: HTMLElement): void {
  const store = new ParamStore(initProgram());
  // What every engine reads: the stored values with the morphs at the controllers' positions (15.2).
  const morphed = new MorphedValues(store);
  const storage = browserStorage();
  const settings = readSettings(storage);

  // Own samples (15.3): assignments per program, buffers for the synth, files in IndexedDB.
  const assignments = new SampleAssignments();
  const sampleSources = new SampleSources(assignments);
  const ownSamples = new OwnSamples({ open: openDeviceSamples, decode: decodeSample, assignments, sink: sampleSources });

  const page = renderPage(root);
  const panel = mountPanel(page.instrument, store);
  const display = mountDisplay(panel.display, store);
  const touch = (key: Parameters<typeof display.show>[0]): void => display.show(key);
  const synth = mountSynthPanel(panel.synth, store, touch, ownSamples);
  const regions = panel.mountRegions(touch);
  const printout = mountPrintout(panel.printout);
  mountColophon(panel.colophon);

  // MIDI out, extern and control in (15.4–15.6): every sender off at page load; port and channels from this device.
  const midiOut = new MidiOut(store);
  midiOut.update(settings.midiOut);
  const externOut = new ExternOut(morphed, midiOut);
  const controlIn = new MidiControlIn(store);
  controlIn.update(settings.controlIn);
  const persist = (): void => {
    const problem = writeSettings(storage, { midiOut: storedMidiOut(midiOut.settings), controlIn: controlIn.settings });
    if (problem !== null && storage !== null) printout.print([`midi settings not kept on this device (${problem})`], 'notes');
  };
  controlIn.onEdit(touch);

  // Audio: the context exists only after a gesture; notes wait for it in the gate. The merger in
  // front of the gate joins the note sources, so one source's release cannot end another's note.
  const host = new AudioHost();
  const merge = new NoteMerge();
  const gate = new NoteGate();
  // One master and one router per context: the router plays organ, piano and synth (plan 13.5)
  // through the layer effects and the global units (15.1).
  let router: Router | null = null;
  let engines: { organ: SectionEngine<'organ'>; piano: SectionEngine<'piano'>; synth: SynthEngine } | null = null;
  let globalFx: GlobalFx | null = null;
  let worklet: WorkletVoices | null = null;
  const bus = new PlayBus();

  /** 'morph' changes (a controller moved, panic) go to the engines, the global units and extern, never the store. */
  const applyMorph = (changes: readonly Change[]): void => {
    if (changes.length === 0) return;
    router?.applyChanges(changes);
    globalFx?.applyChanges(changes);
    // With audio running the extern output hears changes through the router's tee.
    if (router === null) externOut.applyChanges(changes);
  };

  const startEngines = (ctx: AudioContext): Router => {
    const master = new MasterBus(ctx);
    let synthEngine: SynthEngine | null = null;
    // The effects follow the synth engine's master clock (tempo and beat grid); before it exists, the stored tempo.
    // syncClock: the chains may read before the synth engine has seen a tempo change in the same batch.
    const clock: ClockReader = {
      bpm: () => synthEngine?.syncClock().bpm ?? clockBpm(store),
      anchor: () => synthEngine?.syncClock().anchor ?? 0,
    };
    const global = globalFxFactory({ ctx, values: morphed, out: master.input, clock });
    let organ: OrganEngine | null = null;
    const fx: FxHooks = { chain: fxChainFactory, rotary: () => organ?.rotaryInput ?? null, clock };
    const c: SectionContext = { ctx, values: morphed, out: global.input, fx };
    // The organ first: its rotary must exist when the piano and synth chains connect "To Rotary".
    organ = new OrganEngine(c);
    const voices = createWorkletVoices(ctx);
    worklet = voices;
    // The markers follow `ready` both ways: off once the module loads, back on if a processor fails later.
    voices.onReadyChange(() => markCoarse());
    void voices.load(WORKLET_MODULE_URL);
    synthEngine = new SynthEngine(ctx, morphed, undefined, c.out, {
      fx, hooks: { sources: [sampleSources, voices.sources], filters: [voices.filters] },
    });
    engines = { organ, piano: pianoFactory(c), synth: synthEngine };
    globalFx = global;
    return new Router(store, { organ, piano: engines.piano, synth: teeSection(synthEngine, externOut) });
  };

  const ensureAudio = (): void => {
    if (host.running) return;
    void host.start();
  };
  const panic = (): void => bus.emit({ type: 'panic' });
  const status = mountStatusBar(panel.status, { startAudio: ensureAudio, panic, audio: host.status });
  host.onStatus((s) => {
    status.setAudio(s);
    if (s.kind !== 'running' || host.context === null) return;
    if (router === null) router = startEngines(host.context);
    for (const e of gate.flush()) router.handle(e);
  });

  // App presets carry the layers' own sample references, and the files when the user embeds them (15.3).
  const presetSamples: PresetSamples = {
    extras: async (embed) => {
      const samples = assignments.all();
      if (!embed) return { samples, embedded: new Map() };
      const { embedded, notes } = await ownSamples.embedded();
      return { samples, embedded, notes };
    },
    apply: async (extras) => {
      assignments.load(extras.samples);
      const notes = await ownSamples.storeEmbedded(extras.embedded);
      // IndexedDB opens only when the preset names own samples (a plain program needs no storage).
      if (assignments.hashes().size === 0) return notes;
      await ownSamples.open();
      await ownSamples.loadAssigned();
      return [...notes, ...ownSamples.missingNotes()];
    },
    clear: () => assignments.load({}),
    // Browser slots and the working copy keep the references too, so a reload keeps the assignments.
    current: () => assignments.all(),
    onChange: (fn) => assignments.onChange(() => fn()),
  };
  mountFileBar(panel.files, { store, printout, display, onLoad: panic, samples: presetSamples, ownSamples });

  // Play input.
  const held = new HeldNotes();
  held.attach(bus);
  const keys = new ComputerKeys(bus);
  const pointer = new PointerNotes(bus);
  const keyboard = mountKeyboard(panel.keyboard, {
    pointer, legend: panel.keyboardLegend, octaveRange: { min: keys.minOctave, max: keys.maxOctave },
  });
  held.onChange((notes) => keyboard.setHeld(notes));
  // The octave keys step the computer keys' octave, which the virtual keys follow; at a limit the key is unavailable.
  const showOctave = (octave: number): void => {
    panel.octaveDown.setAttribute('aria-disabled', String(octave <= keys.minOctave));
    panel.octaveUp.setAttribute('aria-disabled', String(octave >= keys.maxOctave));
  };
  keys.onOctave((octave) => {
    keyboard.setOctave(octave);
    showOctave(octave);
  });
  showOctave(keys.octave);
  panel.octaveDown.addEventListener('click', () => keys.setOctave(keys.octave - 1));
  panel.octaveUp.addEventListener('click', () => keys.setOctave(keys.octave + 1));
  void keyLabels(navigator as Parameters<typeof keyLabels>[0]).then((labels) => keyboard.setLabels(labels));

  // The controller strip (wheel, a.t., ctrl ped) emits the same controller events as MIDI (15.2).
  // It emits through its own bus so MIDI out knows a strip move from a MIDI one: the strip's go
  // out with send notes on (15.5) and reach extern channels; MIDI input never goes back out.
  let fromScreen = false;
  const screenBus = new PlayBus();
  screenBus.on((e) => {
    fromScreen = true;
    try {
      bus.emit(e);
    } finally {
      fromScreen = false;
    }
  });
  const screen = new ScreenControllers(screenBus);
  screen.attach(bus);
  panel.controllers.replaceChildren(mountControllerStrip(screen).el);

  bus.on((e: PlayEvent) => {
    // A key or pointer press is the gesture that starts audio (the bus runs inside its handler).
    // A MIDI note is no gesture: it tries once from idle (works after an earlier click on the page,
    // else the strip shows blocked and its start audio key); the gate drops MIDI notes until audio runs.
    if (e.type === 'noteOn' && (e.source !== 'midi' || host.status.kind === 'idle')) ensureAudio();
    const running = host.running && router !== null;
    for (const m of merge.handle(e)) for (const x of gate.handle(m, running)) router?.handle(x);
    // Morph sources: wheel, pressure and pedal move the morphed values (15.2); the global units see the pedal too.
    if (e.type === 'controller') {
      applyMorph(morphed.move(SOURCE_OF_CONTROLLER[e.kind], positionOf(e.value)));
      globalFx?.controller(e.kind, e.value);
    }
    // MIDI out sends notes and controllers only while the user has switched send notes on (15.5);
    // it also ends the notes it sent on panic. Sustain and bend come only from MIDI input here.
    midiOut.play(e, e.type === 'controller' && fromScreen ? 'screen' : undefined);
  });
  bindComputerKeys(document, keys);
  // Browsers start audio only inside a user gesture, so it cannot start on load. Any first touch,
  // click or key anywhere on the page counts, not only the keyboard; touch browsers grant it on
  // pointerup/touchend, desktop ones on pointerdown/keydown. The listeners go once audio runs.
  const unlockEvents = ['pointerdown', 'pointerup', 'touchend', 'keydown'] as const;
  const unlock = (): void => {
    ensureAudio();
    if (host.running) for (const type of unlockEvents) document.removeEventListener(type, unlock, true);
  };
  for (const type of unlockEvents) document.addEventListener(type, unlock, true);

  // MIDI input: same bus as the keys; access is asked for only from the enable midi key.
  const midi = new MidiInput(bus, navigator as MidiNavigator);
  const midiView = (s: MidiStatus): MidiStatusView => ({
    led: midiLed(s),
    text: midiStatusText(s),
    description: midiStatusDescription(s),
    action: canEnableMidi(s) ? { label: 'enable midi', run: () => void midi.enable() } : null,
  });
  midi.onStatus((s) => setMidiStatus(status, midiView(s)));
  setMidiStatus(status, midiView(midi.status));
  // Control in hears every parsed message; MIDI out reads the ports of the same access (never SysEx).
  midi.onMessage((e) => controlIn.handle(e));
  midi.onAccess((a) => midiOut.setAccess(a));
  const midiPanel = mountMidiPanel(panel.extern, {
    store, onTouch: touch, out: midiOut, controlIn, input: midi, printout, persist,
  });

  // Every panic (Esc, the panic key, a load, CC120/123, hide) also forgets what the sources hold,
  // so a key that was down plays again on its next press. Subscribed after the engine path: the
  // merger has already forgotten every holder, so the note offs of releaseAll are absorbed there.
  // The guard keeps a panic emitted while this runs from recursing.
  let clearing = false;
  bus.on((e) => {
    if (e.type !== 'panic' || clearing) return;
    clearing = true;
    try {
      keys.releaseAll();
      pointer.releaseAll();
      midi.forgetHeld();
      // Panic resets the morph sources ("reset incoming CC messages", M p.56) and cuts the global
      // effect tails (the layer chains go quiet with their engines' panic). MIDI out ends its notes
      // in the engine path's midiOut.play; extern hears the panic through the router's tee.
      applyMorph(morphed.rest());
      globalFx?.silence();
      // While the context is not running the gate keeps the panic from the router: stop it here.
      if (router === null) externOut.panic();
      else if (!host.running) router.panic();
    } finally {
      clearing = false;
    }
  });

  document.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Escape' || ev.repeat || ev.defaultPrevented) return;
    panic();
  });
  bindReleaseOnHide(window, document, panic);

  // Store → router (and through it every engine), coarse markers, silent-layer notes. The synth
  // focus is the active scene's (model/scene.ts).
  const focused = (): SynthLayer => focusedLayer(store, 'synth');
  const markCoarse = (): void => {
    // The AudioWorklet engine, once loaded, renders what the native voice only approximates (15.7).
    const coarse = coarsePatterns(store, focused(), worklet?.ready ?? false);
    for (const c of synth.controls) c.setCoarse(coarse.has(patternOf(c.key)));
  };
  let silentText = '';
  const noteSilent = (): void => {
    // A layer an own sample covers sounds (15.3). An assigned sample that does not play yet is
    // never "no own sample assigned": still loading (no note), not on this device (its own note),
    // or stored but not decodable here (why).
    const lines: string[] = [];
    for (const s of silentLayers(store)) {
      if (sampleSources.covers(store, s.layer)) continue;
      let reason: string | null = s.reason;
      if (s.reason === SAMPLES_MODE_SILENT && assignments.get(s.layer) !== null) reason = ownSamples.failedNote(s.layer);
      if (reason !== null) lines.push(`layer ${s.layer.toLowerCase()} is silent: ${reason}`);
    }
    lines.push(...ownSamples.missingNotes());
    const text = lines.join('\n');
    if (text === silentText) return;
    if (lines.length > 0) printout.print(lines, 'notes');
    else if (silentText !== '') printout.print(['every enabled synth layer sounds again'], 'notes');
    silentText = text;
  };
  store.onChange((batch) => {
    const expanded = morphed.expand(batch);
    router?.applyChanges(expanded);
    globalFx?.applyChanges(expanded);
    if (router === null) externOut.applyChanges(expanded);
    // MIDI out sends the user's edits (stored values) while send to stage 4 is on.
    midiOut.changes(batch);
    markCoarse();
    noteSilent();
  });
  assignments.onChange(() => {
    noteSilent();
    void ownSamples.loadAssigned();
  });
  ownSamples.onChange(noteSilent);
  markCoarse();
  noteSilent();

  if (import.meta.env.DEV) {
    // Inspection handle for local checks in the browser console; not in production builds.
    (globalThis as Record<string, unknown>)['__ns4Editor'] = {
      store, morphed, host, bus, midi, midiOut, controlIn, externOut, regions, midiPanel, assignments, ownSamples, screen,
      get router() { return router; },
      get globalFx() { return globalFx; },
      get worklet() { return worklet; },
      get engines() { return engines; },
      get engine() { return engines?.synth ?? null; },
    };
  }
}

const root = document.getElementById('app');
if (root !== null) start(root);
