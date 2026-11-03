/**
 * Composition root of the Stage 4 editor (/nordconvert/editor): builds the store from the init
 * program and mounts the page, the panel, the display, the synth region and the print-out; then
 * wires play input (computer keys, virtual keyboard) through the play bus to the browser synth,
 * the audio status strip with panic (also Esc), release on blur or hide, store changes to the
 * engine, the coarse markers and the silent-layer notes; MIDI input (inputs only, after the
 * `enable midi` key) feeds the same play bus and fills the status strip's MIDI slot. Files (T6,
 * T7) arrive through the panel's mount points. DOM calls only, no inline
 * styles or scripts, so the page works under a strict CSP.
 */
import { SynthEngine } from './audio/engine.ts';
import { NoteGate } from './audio/gate.ts';
import { AudioHost } from './audio/host.ts';
import { coarsePatterns, silentLayers } from './audio/mapping.ts';
import { bindComputerKeys, ComputerKeys, keyLabels } from './input/computer-keys.ts';
import { HeldNotes, NoteMerge, PlayBus, type PlayEvent } from './input/events.ts';
import { bindReleaseOnHide } from './input/hide.ts';
import { PointerNotes } from './input/pointer.ts';
import {
  canEnableMidi, MidiInput, type MidiNavigator, midiLed, type MidiStatus, midiStatusDescription, midiStatusText,
} from './midi/access.ts';
import { initProgram } from './model/init.ts';
import { LAYERS, patternOf, type SynthLayer } from './model/keys.ts';
import { ParamStore } from './model/store.ts';
import { mountDisplay } from './ui/display.ts';
import { mountFileBar } from './ui/file-bar.ts';
import { mountKeyboard } from './ui/keyboard-view.ts';
import { renderPage } from './ui/page.ts';
import { mountPanel } from './ui/panel.ts';
import { mountPrintout } from './ui/printout.ts';
import { type MidiStatusView, mountStatusBar, setMidiStatus } from './ui/status-bar.ts';
import { mountSynthPanel } from './ui/synth-panel.ts';

const FOCUS = 'synth.layerFocusSyn_I';

function start(root: HTMLElement): void {
  const store = new ParamStore(initProgram());
  const page = renderPage(root);
  const panel = mountPanel(page.instrument, store);
  const display = mountDisplay(panel.display, store);
  const synth = mountSynthPanel(panel.synth, store, (key) => display.show(key));
  const printout = mountPrintout(panel.printout);

  // Audio: the context exists only after a gesture; notes wait for it in the gate. The merger in
  // front of the gate joins the note sources, so one source's release cannot end another's note.
  const host = new AudioHost();
  const merge = new NoteMerge();
  const gate = new NoteGate();
  let engine: SynthEngine | null = null;
  const bus = new PlayBus();

  const ensureAudio = (): void => {
    if (host.running) return;
    void host.start();
  };
  const panic = (): void => bus.emit({ type: 'panic' });
  const status = mountStatusBar(panel.status, { startAudio: ensureAudio, panic, audio: host.status });
  host.onStatus((s) => {
    status.setAudio(s);
    if (s.kind !== 'running' || host.context === null) return;
    engine ??= new SynthEngine(host.context, store);
    for (const e of gate.flush()) engine.handle(e);
  });
  mountFileBar(panel.files, { store, printout, display, onLoad: panic });

  // Play input.
  const held = new HeldNotes();
  held.attach(bus);
  const keys = new ComputerKeys(bus);
  const pointer = new PointerNotes(bus);
  const keyboard = mountKeyboard(panel.keyboard, {
    pointer, legend: panel.keyboardLegend, octaveRange: { min: keys.minOctave, max: keys.maxOctave },
  });
  held.onChange((notes) => keyboard.setHeld(notes));
  keys.onOctave((octave) => keyboard.setOctave(octave));
  void keyLabels(navigator as Parameters<typeof keyLabels>[0]).then((labels) => keyboard.setLabels(labels));

  bus.on((e: PlayEvent) => {
    // A key or pointer press is the gesture that starts audio (the bus runs inside its handler).
    // A MIDI note is no gesture: it tries once from idle (works after an earlier click on the page,
    // else the strip shows blocked and its start audio key); the gate drops MIDI notes until audio runs.
    if (e.type === 'noteOn' && (e.source !== 'midi' || host.status.kind === 'idle')) ensureAudio();
    const running = host.running && engine !== null;
    for (const m of merge.handle(e)) for (const x of gate.handle(m, running)) engine?.handle(x);
  });
  bindComputerKeys(document, keys);
  // Touch browsers grant audio only on pointerup or touchend: retry there so the next touch plays.
  panel.keyboard.addEventListener('pointerup', ensureAudio);

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
    } finally {
      clearing = false;
    }
  });

  document.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Escape' || ev.repeat || ev.defaultPrevented) return;
    panic();
  });
  bindReleaseOnHide(window, document, panic);

  // Store → engine, coarse markers, silent-layer notes.
  const focused = (): SynthLayer => LAYERS[store.get(FOCUS)] ?? 'A';
  const markCoarse = (): void => {
    const coarse = coarsePatterns(store, focused());
    for (const c of synth.controls) c.setCoarse(coarse.has(patternOf(c.key)));
  };
  let silentText = '';
  const noteSilent = (): void => {
    const silent = silentLayers(store);
    const lines = silent.map((s) => `layer ${s.layer.toLowerCase()} is silent: ${s.reason}`);
    const text = lines.join('\n');
    if (text === silentText) return;
    if (lines.length > 0) printout.print(lines, 'notes');
    else if (silentText !== '') printout.print(['every enabled synth layer sounds again'], 'notes');
    silentText = text;
  };
  store.onChange((batch) => {
    engine?.applyChanges(batch);
    markCoarse();
    noteSilent();
  });
  markCoarse();
  noteSilent();

  if (import.meta.env.DEV) {
    // Inspection handle for local checks in the browser console; not in production builds.
    (globalThis as Record<string, unknown>)['__ns4Editor'] = { store, host, bus, midi, get engine() { return engine; } };
  }
}

const root = document.getElementById('app');
if (root !== null) start(root);
