# Nord Stage 4 editor: architecture and implementation plan

For the brief `.claude/briefs/nord-stage4-editor-mvp.md` (approved 2026-11-03), based on `docs/editor-feasibility.md` (Phase 1). Status: plan, nothing built. Section 9 lists the five questions for the user; everything else is a proposal the orchestrator can change.

> **Pivot to nord (2026-11-04).** The Stage 3 → Stage 4 converter is retired (Nord Sound Manager converts Stage 3 programs natively since v9.10) and the editor is the whole site, served at https://www.thilkolimbeck.com/nord (Vite base `/nord/`) from `web/index.html`. Paths moved: `web/editor/index.html` → `web/index.html`; `web/src/engine/` → `web/src/ns4/` (Stage 4 code only; `verify` from `convert.ts` is now `verify.ts`); `nordconv/_layout_ns4.py`, `_tables_ns4.py` and `labels.py` → `tools/ns4data/`. What this document says about the converter (its page `web/index.html`, `web/src/main.ts`, `web/src/state.ts`, `web/src/styles.css`, the `nordconv` package, `docs/phase1-mapping.md`, the `/nordconvert` URLs and the dev rewrite, `web/test/golden/golden.json`, `parity.test.ts`, `engine.test.ts`, `state.test.ts`) is historical; those files are in the git history up to commit `babed27`. The .ns4p import and export tests now read a generated corpus (`web/test/editor/corpus.ts`) instead of the converter's golden outputs, and `tokens.test.ts` checks `editor.css` alone.

Notation: `{L}` is a synth layer `A`, `B` or `C`; `synth{L}Sound.fltFreq` means the three keys `synthASound.fltFreq`, `synthBSound.fltFreq`, `synthCSound.fltFreq`. "M p.N" is the manual page as cited in the feasibility doc.

## 0. Page, build and hosting (historical: the two-page site under /nordconvert)

### Findings that shape the plan

1. **The TS engine has no display tables.** `web/src/engine/generated/tables-ns4.ts` holds only what the converter reads: one value table (`050-5`), one `FIELD_VALUE_TABLE` entry (`common.splitPosLow`), the keyboard-zone dependency tables and the name tables (`tools/gen_layouts.py`, `TS_VALUE_FIELDS`, `TS_DEP_PORT_IDS`). The full tables (186 value tables for 391 fields, 25 enum tables for 218 fields, the osc category/wave dependency tables `561-8`/`562-4`, port names) exist only in `nordconv/_tables_ns4.py`. The label lookup is `nordconv/labels.py` (`ns4_label`, 34 lines, keyed by raw bits within the port width), not ported.
   **Plan:** a new script `tools/gen_editor_tables.py` reads `nordconv/_tables_ns4.py` (already generated, committed, no opennord checkout needed) and writes `web/src/editor/generated/display-ns4.ts` plus a label golden `web/test/editor/labels-golden.json` computed with `ns4_label`. The editor ports `ns4_label` into its own model. The engine, `gen_layouts.py` and every existing generated file stay byte-identical. JSON size of the tables is about 185 KB raw (value 117 KB, dependency 58 KB, enum 3 KB, names 6 KB), roughly 30–40 KB gzip, loaded by the editor chunk only.
2. **`verify()` is reusable as is.** It needs header version 313, bank 0, location 0 and the given category, compares every layout field with `edits.get(key) ?? template.value(key)` and checks the uncovered bits against `template.body`. Any 3.13 `Ns4Program` works as the template, so export needs no engine change (section 5.4).
3. **Brief vs orchestrator file name.** The brief names `web/editor.html`; the plan uses `web/editor/index.html` (built to `dist/editor/index.html`) as the orchestrator asked, because `editor.html` would need `cleanUrls` or a rewrite in `web/vercel.json`.

### Build

- `web/editor/index.html`: the second Vite page. Links `/src/editor/editor.css` and `/src/editor/main.ts` with absolute paths like `index.html` does; Vite prefixes the base.
- `web/vite.config.ts`: `build.rolldownOptions.input = { main: index.html, editor: editor/index.html }` (Vite 8 name; `rollupOptions` is the deprecated alias, checked in `node_modules/vite/dist/node/index.d.ts`). `__ENGINE_VERSION__` stays shared.
- Dev and preview: Vite's HTML fallback (`htmlFallbackMiddleware`, appType `spa`) maps `/editor/` to `editor/index.html` but `/editor` (no slash) to the SPA fallback, which is the converter. The plan adds a ten-line plugin in `vite.config.ts` (`configureServer` and `configurePreviewServer`) that rewrites `/nordconvert/editor` to `/nordconvert/editor/index.html`, so the converter's link works locally. Own code, no dependency.
- Links are absolute: `/nordconvert/editor` from the converter, `/nordconvert` back. A relative `editor` would resolve to `/editor`, because production URLs have no trailing slash.
- `editor.css` repeats the converter's tokens from `web/src/styles.css` (that file stays untouched); a test keeps the two token blocks equal. Fonts come from the same `/fonts/*.woff2`.

### Vercel result

- Documented (vercel.json reference, checked 2026-11-03): `trailingSlash` defaults to `undefined`, so neither `/editor` nor `/editor/` redirects; "precedence is given to the filesystem prior to rewrites being applied".
- Not stated in the docs I found: that a path resolves to its directory's `index.html`. It is Vercel's common static behaviour, but unverified for this project.
- Production path, measured: the portfolio answers `/nordconvert/` with 308 to `/nordconvert` (Next.js trailing-slash redirect), then rewrites `/nordconvert/:path*` to `https://nord-convert.vercel.app/:path*`. So only `/editor` without a slash has to resolve upstream. Direct visits to `nord-convert.vercel.app/nordconvert/editor` go through the `web/vercel.json` rewrite to `/editor`.
- Verify on the first preview deployment, before the converter link ships: `curl -sI` on `<preview>/editor`, `<preview>/editor/`, `<preview>/nordconvert/editor`, and after release `https://www.thilkolimbeck.com/nordconvert/editor`; each must be 200 with the editor's `<title>`.
- Fallback, **ask first** (vercel.json change): rewrites `{ "source": "/editor", "destination": "/editor/index.html" }` and `{ "source": "/nordconvert/editor", "destination": "/editor/index.html" }` ahead of the catch-all.
- Portfolio: no change needed. `/nordconvert/editor` passes the proxy like `/nordconvert`; its assets sit under `/nordconvert/assets/`, which the matcher already skips. On Vercel the portfolio CSP replaces `web/vercel.json`'s, so the editor must work under both; the strict one (`script-src 'self'`, `style-src 'self'`, no `blob:` scripts) is the design limit. Neither Permissions-Policy names `midi`, so Web MIDI keeps its default (same origin). Check the live headers after release.

### CSP rules for editor code

- No inline scripts, no `<style>` injection, no `style="…"` attributes (blocked by `style-src 'self'`). Dynamic visuals use CSSOM (`el.style.setProperty('--v', …)`), which CSP allows.
- The MVP needs no AudioWorklet (section 4.2). A later worklet loads as a same-origin file built by Vite (`import url from './synth.worklet.ts?worker&url'`, type declared in `env.d.ts`); `script-src 'self'` covers worklet modules.
- Downloads use `Blob` plus `<a download>`, as the converter does under the same CSP.
- No `fetch`, XHR, WebSocket or other network use in `web/src/editor/` (a test checks this).

## 1. Module map

```
web/index.html                        page shell: landmarks and empty region containers
web/src/editor/
  main.ts                             composition root: builds store, audio host, input, MIDI, UI; wires events
  editor.css
  generated/display-ns4.ts            GENERATED (tools/gen_editor_tables.py): tables + NS4_KEYS
  model/                              state; no DOM, no Web Audio
    keys.ts  labels.ts  units.ts  curated.ts  descriptors.ts  store.ts  actions.ts  init.ts  sections.ts
  input/                              note sources without the UI
    events.ts  computer-keys.ts  pointer.ts  hide.ts
  audio/
    status.ts  host.ts  voice-alloc.ts  mapping.ts  envelope.ts  oscillators.ts  voice.ts  bindings.ts  engine.ts
  midi/
    parser.ts  access.ts
  formats/                            no DOM
    preset.ts  storage.ts  ns4p-import.ts  ns4p-export.ts  report.ts  base64.ts
  ui/                                 the only DOM-rendering code
    dom.ts  controls.ts  panel.ts  synth-panel.ts  display.ts  keyboard-view.ts  status-bar.ts  file-bar.ts  printout.ts  files.ts
tools/gen_editor_tables.py            Python, reads tools/ns4data/_tables_ns4.py and tools/ns4data/labels.py
tests/test_editor_tables.py           Python: the committed TS module and label golden equal a fresh render
```

### Dependencies (no cycles)

```
main.ts ─► ui ─► model, input, formats, audio (types, status), midi (status)
audio   ─► model, input/events
midi    ─► input/events
input   ─► model/keys (types only)
formats ─► model, ../ns4
model   ─► generated, ../ns4/layout.ts, ../ns4/template.ts, ../ns4/generated/tables-ns4.ts (read only)
```

Rules, enforced by `web/test/editor/imports.test.ts` (reads the sources, as `engine.test.ts` already does for the engine): nothing imports `ui/` or `main.ts`; `audio/` and `midi/` never import `ui/`, `formats/` or each other; `model/` and `formats/` import no DOM or Web Audio globals; no `node:` imports; no network APIs. The engine is used read-only: `index.ts` exports (`Ns4Program`, `loadTemplate`, `verify`, `ConversionError`, `NordFormatError`, `OUTPUT_SUFFIX`) plus direct imports of `NS4_LAYOUT` (`layout.ts`), `CATEGORY_NONE`, `TARGET_VERSION` (`template.ts`) and `crc32`, `buildCbin` (`cbin.ts`, tests only). No engine file changes. If only `index.ts` may be imported, re-exporting those names is the ask-first alternative.

### Public APIs

```ts
// model/keys.ts
export type Ns4Key = (typeof NS4_KEYS)[number];          // 955 literal keys, layout order (generated)
export type SynthLayer = 'A' | 'B' | 'C';
export function layerKey<P extends string>(layer: SynthLayer, pattern: P): Ns4Key; // 'synth{L}Sound.fltFreq'
export function isNs4Key(s: string): s is Ns4Key;

// model/labels.ts: port of tools/ns4data/labels.py ns4_label
export interface ValueReader { get(key: Ns4Key): number }
export function ns4Label(key: Ns4Key, value: number, values: ValueReader): string | null;

// model/units.ts
export type Unit = 's' | 'Hz' | 'dB' | 'semi' | 'cent' | '';
export function parseDisplay(label: string): { value: number; unit: Unit } | null;
  // '0.5 ms'→0.0005 s, '45 s', '0.7 sec', 'inf'→Infinity s, '1.2 kHz'→1200 Hz, '-0.3 dB',
  // 'volume off'→-Infinity dB, '+ 0 semi', '- 3 cent', '5.0'→5 ''; names ('LP24') → null

// model/descriptors.ts
export type ParamKind = 'continuous' | 'enum' | 'bool' | 'mask' | 'opaque';
export type ParamStatus = 'live' | 'unverified' | 'stored' | 'layout';
export type LabelSource = 'table' | 'enum' | 'dep' | 'manual' | 'raw';
export interface EnumOption { value: number; label: string; status?: ParamStatus }
export interface ParamDescriptor {
  key: Ns4Key; kind: ParamKind; min: number; max: number; default: number;
  width: number; enc: 'u' | 'offset' | 'twos' | 'raw';
  region: RegionId; group: GroupId; layer: SynthLayer | null;
  label: string; unit: Unit | null; labelSource: LabelSource; status: ParamStatus;
  options: readonly EnumOption[] | null;   // static options; null for dep tables
  deps: readonly Ns4Key[];                 // FIELD_DEP keys (osc cat/wave, kbZone)
  morphs: { wheel: Ns4Key; afterTouch: Ns4Key; ctrlPedal: Ns4Key } | null;
  note: string | null;                     // why unverified / not implemented (from the feasibility doc)
}
export const DESCRIPTORS: ReadonlyMap<Ns4Key, ParamDescriptor>;
export function optionsFor(d: ParamDescriptor, values: ValueReader): readonly EnumOption[];
export function formatValue(d: ParamDescriptor, value: number, values: ValueReader):
  { text: string; marker: null | 'raw' | 'not decoded' };
export function toSi(d: ParamDescriptor, value: number, values: ValueReader): number | null;
export function clampValue(d: ParamDescriptor, value: number): number;  // round, clamp; 'raw' → 0..2^32-1
export function verified(d: ParamDescriptor): boolean; // status 'live' and labelSource not 'raw'

// model/store.ts
export type Origin = 'ui' | 'midi' | 'load' | 'init' | 'derived';
export interface Change { key: Ns4Key; value: number; previous: number; origin: Origin }
export interface SourceProgram { kind: 'ns4p'; fileName: string; formatVersion: number; bytes: Uint8Array }
export interface ProgramSnapshot {
  name: string; category: number;
  values: Readonly<Record<Ns4Key, number>>;   // all 955 keys
  source: SourceProgram | null;
}
export class ParamStore implements ValueReader {
  constructor(initial: ProgramSnapshot);
  get(key: Ns4Key): number;
  set(key: Ns4Key, value: number, origin?: Origin): number; // clamps; returns the stored value
  setMany(entries: ReadonlyArray<readonly [Ns4Key, number]>, origin: Origin): void; // one batch
  load(snapshot: ProgramSnapshot, origin: 'load' | 'init'): void;  // replaces all, one batch
  snapshot(): ProgramSnapshot;                                      // deep copy
  setName(name: string): void;
  get meta(): Readonly<Pick<ProgramSnapshot, 'name' | 'category' | 'source'>>;
  get dirty(): boolean;
  subscribe(key: Ns4Key, fn: (value: number, change: Change) => void): () => void;
  onChange(fn: (batch: readonly Change[]) => void): () => void;
}

// model/actions.ts: edits that change more than one field
export function setOscBank(store: ParamStore, layer: SynthLayer, bank: number): void; // resets cat/wave without a label in the new bank
export function setLayerEnabled(store: ParamStore, layer: SynthLayer, on: boolean): void; // mask bit

// model/init.ts
export function initProgram(): ProgramSnapshot; // neutral template values + sectionEnableSyn_I=1, layerEnableSyn_I=1 (A); category None

// model/sections.ts
export type RegionId = 'program' | 'organ' | 'piano' | 'synth' | 'extern' | 'effects' | 'rotary';
export interface Group { id: GroupId; title: string; keys: readonly string[] /* patterns with {L} */; status: ParamStatus }
export interface Region { id: RegionId; title: string; status: 'live' | 'layout'; groups: readonly Group[] }
export const PANEL: readonly Region[];
export const HIDDEN: readonly Ns4Key[];   // reserved fields, scene II copies, opaque bit fields: stored, no control
export function keysOf(group: Group, layer: SynthLayer | null): Ns4Key[];

// input/events.ts
export type PlayEvent =
  | { type: 'noteOn'; note: number; velocity: number; source: 'pointer' | 'computer' | 'midi' }
  | { type: 'noteOff'; note: number; source: 'pointer' | 'computer' | 'midi' }
  | { type: 'sustain'; on: boolean }
  | { type: 'bend'; value: number }                                  // -8192..8191
  | { type: 'controller'; kind: 'wheel' | 'pressure' | 'pedal'; value: number } // 0..127
  | { type: 'panic' };
export class PlayBus { emit(e: PlayEvent): void; on(fn: (e: PlayEvent) => void): () => void }

// input/computer-keys.ts
export const WHITE_CODES: readonly string[];          // KeyA KeyS KeyD KeyF KeyG KeyH KeyJ KeyK KeyL → C D E F G A B C D
export const BLACK_CODES: Readonly<Record<string, number>>; // KeyW 1, KeyE 3, KeyT 6, KeyY 8, KeyU 10, KeyO 13, KeyP 15
export const OCTAVE_DOWN = 'KeyZ'; export const OCTAVE_UP = 'KeyX';
export function semitoneFor(code: string): number | null;
export function shouldIgnore(ev: KeyLike, target: TargetLike | null): boolean; // repeat, Cmd/Ctrl/Alt, text input, select, contenteditable
export class ComputerKeys {
  constructor(bus: PlayBus, opts?: { base?: number; velocity?: number; minOctave?: number; maxOctave?: number });
  keyDown(ev: KeyLike, target: TargetLike | null): boolean;  // true when handled (caller preventDefaults)
  keyUp(ev: KeyLike): boolean;    // releases the note that code started, even after an octave change
  releaseAll(): void;
  get octave(): number;
}

// input/pointer.ts
export function velocityFromY(y: number, top: number, height: number): number; // 1..127, soft at the top
export class PointerNotes {
  constructor(bus: PlayBus);
  down(pointerId: number, note: number, velocity: number): void;
  move(pointerId: number, note: number | null, velocity: number): void; // glide across keys
  up(pointerId: number): void; cancel(pointerId: number): void; releaseAll(): void;
}

// input/hide.ts
export function bindReleaseOnHide(win: Window, doc: Document, release: () => void): () => void; // blur, visibilitychange→hidden, pagehide

// audio/status.ts (pure) and audio/host.ts (browser)
export type AudioStatus =
  | { kind: 'idle' } | { kind: 'starting' } | { kind: 'running'; sampleRate: number }
  | { kind: 'blocked'; reason: 'suspended' | 'interrupted' } | { kind: 'unsupported' } | { kind: 'error'; message: string };
export type AudioEvent =
  | { type: 'gesture' } | { type: 'resumed'; sampleRate: number } | { type: 'state'; state: string }
  | { type: 'failed'; message: string } | { type: 'unsupported' };
export function audioStatusReducer(s: AudioStatus, e: AudioEvent): AudioStatus;
export function audioStatusText(s: AudioStatus): string;
export class AudioHost {
  start(): Promise<AudioContext | null>;  // call only inside a user-gesture handler
  get status(): AudioStatus; onStatus(fn: (s: AudioStatus) => void): () => void;
}

// audio/voice-alloc.ts (pure)
export const MAX_VOICES = 46;
export interface LayerVoicing { layer: SynthLayer; mode: 'poly' | 'mono' | 'legato'; priority: 'none' | 'low' | 'high'; sustain: boolean }
export type VoiceCommand =
  | { type: 'start'; id: number; layer: SynthLayer; note: number; velocity: number }
  | { type: 'retarget'; id: number; note: number; retrigger: boolean }   // mono/legato
  | { type: 'release'; id: number } | { type: 'kill'; id: number };      // kill = steal or panic
export class VoiceAllocator {
  constructor(maxVoices?: number);
  noteOn(note: number, velocity: number, layers: readonly LayerVoicing[]): VoiceCommand[];
  noteOff(note: number): VoiceCommand[];
  sustain(on: boolean): VoiceCommand[];
  allNotesOff(): VoiceCommand[];   // panic and hide: kills every voice, clears held and sustained notes
  voiceEnded(id: number): void;    // release tail done
  get activeCount(): number;       // held + sustained + releasing
}

// audio/mapping.ts (pure): field values → physical values; section 4.3
export function envelope(values: ValueReader, layer: SynthLayer, which: 'osc' | 'flt' | 'amp'):
  { attack: number; decay: number; release: number };   // seconds; decay Infinity = hold
export function filterSpec(values: ValueReader, layer: SynthLayer): FilterSpec;
export function oscSpec(values: ValueReader, layer: SynthLayer): OscSpec | { silent: string };
export function pitchCents(values: ValueReader, layer: SynthLayer, note: number): number;
export function layerGain(values: ValueReader, layer: SynthLayer): number;
// …one function per row of section 4.3

// audio/envelope.ts (pure)
export interface EnvSchedule { start: number; attack: number; decay: number; releaseAt: number | null; release: number; peak: number }
export function envValueAt(s: EnvSchedule, t: number): number;   // for release from the current level

// audio/bindings.ts
export const BINDINGS: Readonly<Record<string /* pattern */, { scope: 'layer' | 'voice'; apply: 'live' | 'next-note' }>>;

// audio/engine.ts
export class SynthEngine {
  constructor(ctx: BaseAudioContext, values: ValueReader, allocator?: VoiceAllocator);
  handle(e: PlayEvent): void;                  // noteOn/off, sustain, bend, controller, panic
  applyChanges(batch: readonly Change[]): void;
  reload(): void;                              // after a load: panic, rebuild layer nodes
  panic(): void;
  get activeVoices(): number;
}

// midi/parser.ts (pure)
export type MidiEvent =
  | { type: 'noteOn'; channel: number; note: number; velocity: number } | { type: 'noteOff'; channel: number; note: number }
  | { type: 'cc'; channel: number; controller: number; value: number }
  | { type: 'bend'; channel: number; value: number } | { type: 'pressure'; channel: number; value: number };
export function parseMidiMessage(data: Uint8Array): MidiEvent | null;   // ignores system and SysEx bytes
export function toPlayEvents(e: MidiEvent): PlayEvent[];  // CC64→sustain, CC1→wheel, CC11→pedal, pressure, bend, CC120/123→panic

// midi/access.ts
export type MidiStatus =
  | { kind: 'off' } | { kind: 'requesting' } | { kind: 'unsupported' } | { kind: 'denied' }
  | { kind: 'no-inputs' } | { kind: 'connected'; inputs: readonly string[] } | { kind: 'error'; message: string };
export function midiStatusFromError(err: unknown): MidiStatus;  // NotAllowedError/SecurityError → denied
export function midiStatusText(s: MidiStatus): string;
export class MidiInput {
  constructor(bus: PlayBus, nav: { requestMIDIAccess?: (o: { sysex: boolean }) => Promise<MIDIAccess> });
  enable(): Promise<void>;   // from a click; sysex: false; listens to all inputs, omni; follows statechange
  disable(): void; get status(): MidiStatus; onStatus(fn: (s: MidiStatus) => void): () => void;
}

// formats/*: section 5
export function toPresetJson(s: ProgramSnapshot, appVersion: string): string;
export function parsePreset(text: string): ProgramSnapshot;          // throws PresetError
export class PresetSlots { constructor(storage: StorageLike | null); list(): SlotInfo[]; save(name: string, s: ProgramSnapshot): SlotInfo; load(id: string): ProgramSnapshot; remove(id: string): void }
export function importNs4p(fileName: string, bytes: Uint8Array): { snapshot: ProgramSnapshot; notes: string[] }; // throws ImportError
export function exportExperimentalNs4p(s: ProgramSnapshot): { bytes: Uint8Array; fileName: string; donor: 'source' | 'neutral'; notes: string[] }; // throws ExportError
export function parameterReport(s: ProgramSnapshot, baseline: ProgramSnapshot, opts: { appVersion: string; date: string }): string;
export function reportFileName(name: string): string;               // '<name> parameter report.txt'

// ui/*: DOM only
export interface Bound { el: HTMLElement; rebind(key: Ns4Key): void; dispose(): void }
export function control(d: ParamDescriptor, store: ParamStore, onTouch: (key: Ns4Key) => void): Bound;
export function mountSynthPanel(root: HTMLElement, store: ParamStore, onTouch: (key: Ns4Key) => void): () => void;
export function mountPanel(root: HTMLElement, store: ParamStore): () => void;     // layout-only regions
export function mountDisplay(root: HTMLElement, store: ParamStore): { show(key: Ns4Key): void };
export function mountKeyboard(root: HTMLElement, notes: PointerNotes, keys: ComputerKeys): () => void;
export function mountStatus(root: HTMLElement, deps: { audio: AudioHost; midi: MidiInput; panic(): void }): () => void;
export function mountFiles(root: HTMLElement, deps: FileDeps): () => void;
export function mountPrintout(root: HTMLElement): { print(lines: readonly string[], kind: 'notes' | 'error' | 'result'): void };
```

## 2. Data flow

### Play: input → voice manager → audio graph

```
computer keys  keydown/keyup (event.code) ── ComputerKeys ──┐
virtual keys   pointerdown/move/up/cancel ── PointerNotes ──┼─► PlayBus ─► main ─► SynthEngine.handle
MIDI           MIDIMessageEvent ─ parseMidiMessage ─ toPlayEvents ┘                     │
blur, visibilitychange (hidden), pagehide, panic key ─► { type: 'panic' } ─────────────┤
                                                                                        ▼
   VoiceAllocator.noteOn(note, vel, voicings of the enabled layers in scene I)
      → VoiceCommand[] → Voice.start / retarget / release / kill (native nodes) → layer bus → master
```

- One note starts one voice per enabled synth layer (`synth.layerEnableSyn_I`, section on `common.sectionEnableSyn_I`). Each counts toward `MAX_VOICES`.
- Before audio runs: pointer and key events are user gestures, so the first one calls `AudioHost.start()`; the note is queued until the context runs and dropped if released first. MIDI events are not gestures: until audio runs they are ignored and the status line asks for a click.
- Hide and panic: `ComputerKeys.releaseAll()`, `PointerNotes.releaseAll()`, sustain off, `SynthEngine.panic()` → `allNotesOff()` frees every voice at once (allocator count 0); the nodes fade out over about 10 ms and stop, so nothing clicks.

### Edit: control → store → audio and UI

```
control input event ─► store.set(key, v, 'ui') ─► clampValue ─► batch of Change
                          ├─► subscribe(key) listeners: the control, its value readout, the display
                          ├─► onChange: main ─► SynthEngine.applyChanges(batch)
                          │       BINDINGS[pattern]: 'live' → AudioParam.setTargetAtTime(x, now, 0.01) on layer or voice nodes
                          │                          'next-note' → read at the next noteOn
                          └─► dirty flag (unsaved indicator, if the orchestrator wants one)
```

Multi-field edits (osc bank change resetting category and wave, layer mask bits) go through `model/actions.ts` and land as one batch with origin `derived` for the follow-up fields. Loads never trigger derived edits.

### Load: preset or .ns4p → store

```
file input / drop / localStorage ─► bytes or text
   .ns4p ─► importNs4p ─► Ns4Program.fromBytes (engine) ─► snapshot + notes
   .json ─► parsePreset (validate, migrate) ─► snapshot
   slot  ─► PresetSlots.load ─► parsePreset ─► snapshot
snapshot ─► store.load(snapshot, 'load') ─► one batch ─► UI rebinds all controls; SynthEngine.reload() (panic first)
notes and errors ─► print-out
```

File loads use the converter's generation counter (`Session` in `web/src/state.ts`): a read that finishes after a newer load is dropped.

## 3. Parameter model

### 3.1 Deriving a descriptor

For each key of `NS4_LAYOUT.fields`, in layout order:

1. **Range and default** come from the layout only (`min`, `max`, `default`, `enc`, `width`). Table rows outside the layout range are ignored.
2. **Morph keys** (`*.morphWheel`, `*.morphAfterTouch`, `*.morphCtrlPedal`): kind `continuous`, label source `raw`, signed delta; attached to the parent descriptor's `morphs`.
3. **Value table** (`FIELD_VALUE_TABLE[key] = [tableId, portWidth]`): for each value `v` in `min..max`, `raw = Field.encode(v)`; a label exists when `raw < 2^portWidth`, the table has `raw` and the label is not `not decoded`. Then:
   - width 1, or exactly two labels off/on → `bool`;
   - every label parses with `parseDisplay` → `continuous`, unit = the parsed unit (special labels such as `volume off` and `inf` are allowed at the ends);
   - otherwise → `enum`, options in value order.
4. Else **enum table** (`FIELD_ENUM`): `enum` with options from `ENUM_TABLES`, same raw rule.
5. Else **dependency table** (`FIELD_DEP[key] = [tableId, portWidth, deps]`): `enum` with `options = null`; `optionsFor()` builds the row prefix from the current raw values of `deps` (`bank:` for `oscCat`, `bank:cat:` for `oscWave`, three split enables for `kbZone`) and lists matching rows. Controls subscribe to `deps` as well and refresh their option list.
6. Else **curated** (`model/curated.ts`): labels from the manual for fields without a table, with the page as `note` (`voiceMode` poly/mono/legato; `fltDrive` off/1/2/3; `ampEnvVel` off/1/2/3; `oscUnison` off/1/2/3; layer focus A/B/C; layer enable mask A/B/C), label source `manual`. Remaining fields: `continuous` with label source `raw` (`fltRes`, `lfoRateClkDiv`, `lfoAmt`, layer pan, morphs), or `opaque` (32-bit hashes and pattern masks).
7. **Overlay** from `curated.ts`, keyed by layer-free pattern: short label, region and group (via `sections.ts`), `status`, and `note` (the feasibility doc's reason). `status` follows the feasibility inventory: **yes** → `live`, **partly** → `unverified`, deferred in the MVP → `stored`, every field outside the synth region → `layout`.

`formatValue` returns the Stage 4's own display string when a label exists; else the integer with marker `raw` (shown as "not verified"), or `not decoded` when the table has that word for the value (e.g. octave shift ±3…6, pitch stick range 10…15). `toSi` uses `parseDisplay` on the label; `null` without a parseable label.

Clamping (`clampValue`): `Math.round`, then clamp to `min..max`; for `enc: 'raw'` clamp to `0..2^32-1` (as `Field.inRange` does). Every write goes through it, so the store never holds a value `Ns4Program.set` would refuse.

Option status: options can carry their own status (`oscBank` WAVE, `mode` samples → `layout` "not implemented"; `fltType` LPM → `unverified`).

`oscBank` change from the UI (`setOscBank`): if the current `oscCat` has no label in the new bank, set `oscCat` and `oscWave` to 0, the first row; if only `oscWave` has none, set it to 0. What the Stage 4 does on a bank change is unknown; loads keep the stored values.

Typing: the generator emits `NS4_KEYS` as a `const` array, so `Ns4Key` is a union of 955 literals; a test checks it against `NS4_LAYOUT.fields` order. Layer-free patterns use template literal types (`` `synth${SynthLayer}Sound.${SoundParam}` ``).

### 3.2 MVP controls

The synth panel edits the focused layer (`synth.layerFocusSyn_I`): one control set, rebound to layer A, B or C. Audio plays every enabled layer. Why all three layers rather than one: the keys are layer-parametric, so rebinding costs one `rebind(key)` per control; and imported programs often sound on B or C, which would be silent if only A rendered. Scene I only: `*_II` fields are stored and exported but have no control; an imported program with `common.layerScene` = II gets a note.

**Synth common (scene I)**

| key | kind | status | note |
| --- | --- | --- | --- |
| `common.sectionEnableSyn_I` | bool | live | synth section on |
| `synth.layerEnableSyn_I` | mask A/B/C | live | bit order from the converter, unverified on hardware |
| `synth.layerFocusSyn_I` | enum A/B/C | live | selects the layer the panel edits |
| `synth.layerLevelSyn{A,B,C}` | continuous dB (`378-3`) | live | |
| `synth.layerPanSyn{A,B,C}` | continuous raw −60..60 | unverified | no table, equal-power pan |
| `synth.multiLayerFlt`, `multiLayerArp`, `multiLayerLFO`, `kbdHoldEnableCommon` | bool | stored | Group and KB Hold not in the MVP sound |

**Per layer (focused)**

| group | live | unverified | stored (no sound in MVP) |
| --- | --- | --- | --- |
| Oscillator | `synth{L}.mode` (analog; samples option not implemented), `synth{L}Sound.oscBank` (ANALOG; FM-H, FM-I options unverified; WAVE not implemented), `oscCat`, `oscWave`, `oscTuneCoarse`, `oscTuneFine`, `oscEnvAtk`, `oscEnvDcy`, `oscEnvRls`, `oscEnvDst` | `oscCtrl`, `oscEnvAmt`, `oscEnvVel` | `smpDynamic`, `smpTimbre` |
| Filter | `fltEnable`, `fltType` (LPM option unverified), `fltFreq`, `fltKbdTrk`, `fltEnvAtk`, `fltEnvDcy`, `fltEnvRls` | `fltRes`, `fltDrive`, `fltEnvAmt`, `fltEnvVel` | – |
| Amp envelope | `ampEnvAtk`, `ampEnvDcy`, `ampEnvRls` | `ampEnvVel` | – |
| LFO | `lfoWave`, `lfoDst` | `lfoRateClkDiv`, `lfoAmt` | `lfoClkEnable` (no master clock in the MVP) |
| Vibrato | `synth{L}.vibMode` (WHL = CC1, A.T. = pressure, PED = CC11, MIDI only), `synth{L}Sound.vibRate` | `vibAmt`, `synth{L}.vibDly` (table vs manual conflict) | – |
| Voice | `synth{L}.voiceMode` (manual labels), `voicePrio` | `glideRate`, `oscUnison` | – |
| Keyboard | `synth{L}.octaveShift`, `pStickEnable`, `pitchStickRange`, `sustainEnable` | – | `kbZone` (layer plays the whole keyboard), `kbdHoldEnableLayer` |
| Arp/Gate | – | – | `arpRun`, `arpMode`, `arpDir`, `arpZigZag`, `arpKbdSync`, `arpRange`, `arpRateClkDiv`, `arpClkEnable`, `arpPtnEnable`, `arpPtnLen` |

Per layer: 30 live and 14 unverified controls (44 that change the sound), 15 stored. Common: 9 controls (mask counted once), 4 stored.

No control, preserved and in the report: `synth{L}.libName`, `smpId`, `smpNameHash` (sample name shown read-only when `SAMPLE_NAMES` knows it), `arpPtnAcc`, `arpPtnDur`, `arpPtnPan`, the three `synth.reserved_*` fields. Extern fields (15 per layer) belong to the Extern region, layer effects (32 per layer) to the Effects region: both layout-only. The 72 synth morph fields: decision 5 (default: read-only).

Proposed default for `stored` controls: editable, marked "not implemented (sound)", because the value still goes into the export and the report. The orchestrator can make them read-only instead.

## 4. Audio engine

### 4.1 Graph

```
per layer:  LFO (OscillatorNode or looped S/H buffer) ─► depth gains ─► voice targets
            vibrato OscillatorNode ─► per-voice depth gain (delay and wheel/pressure/pedal scaling) ─► osc detune
            layer bus GainNode (level) ─► StereoPannerNode (pan) ─► master
per voice:  sources ─► [drive WaveShaper] ─► filter (1–2 Biquads; LP+HP as parallel pair) ─► VCA Gain (amp env × velocity) ─► layer bus
            osc env and filter env: ConstantSourceNode with automated offset ─► amount gains ─► osc detune / filter detune / osc ctrl target
master:     GainNode (−12 dB headroom) ─► DynamicsCompressor as a safety limiter (internal, not a Stage 4 effect) ─► destination
```

- Pitch modulation sums on `OscillatorNode.detune` (cents): coarse, fine, octave shift, pitch bend, glide, vibrato, LFO, osc env. Filter modulation sums on `BiquadFilterNode.detune` (cents, 1200 per octave), so envelope and LFO depths in octaves stay linear.
- Sources by oscillator category, native nodes only: Pure sine, triangle, saw, square as `OscillatorNode` types, pulse 33 % and 10 % as `PeriodicWave`, white noise as a looped `AudioBuffer`; Sub Osc: main oscillator plus a sub one octave down, osc ctrl = sub level; Sync, Shape Sine: `PeriodicWave` computed from the synced or shaped cycle for the current osc ctrl, rebuilt on change (static timbre; envelope and LFO cannot sweep it, marked "coarse"); Shape: pulse width by the two-saw-and-`DelayNode` method, so `delayTime` can be modulated; Multi, Super: stacks of detuned saws or squares, osc ctrl = detune; Misc: pink and red noise buffers, Bell as FM; FM-H, FM-I: operator `OscillatorNode`s into carrier `frequency`, index = osc ctrl; the manual's algorithms A–E for the documented categories, the undecoded partial and pitch values flagged. Osc ctrl meanings follow M p.29–30; the curves are invented and marked unverified.
- Envelopes (Stage 4 has A, D, R; decay at maximum holds): attack `linearRampToValueAtTime(peak)`, decay `setTargetAtTime(0, tA, D/4.6)` (the table time is taken as the time to −40 dB), `inf` holds; release from the current value, computed with `envValueAt` (Firefox lacks `cancelAndHoldAtTime`), then `setTargetAtTime(0, tOff, R/4.6)`. The voice frees itself at the release end computed by `envValueAt` (below −80 dB); AudioParam values are not read back.
- Voice modes: poly (allocate, steal the oldest releasing voice, then the oldest held one); mono (one voice per layer, retrigger, priority last/low/high from `voicePrio`); legato (retarget without retrigger while keys overlap). Glide applies in mono and legato as a constant-rate `detune` ramp (duration = interval × rate).
- Unison `oscUnison` 0–3 → 1–4 detuned copies, spread in stereo. CPU budget: at most 8 oscillator nodes per voice; Super stacks shrink as unison grows.
- Polyphony cap: 46 voices (Stage 4 synth, feasibility 1b), counted over all layers. `MAX_VOICES` is one constant, so a lower cap for weak devices stays a one-line change.
- Changes: each pattern in `BINDINGS` is `live` (layer or active-voice AudioParams, 10 ms smoothing) or `next-note` (only `oscUnison` and stack sizes; waveforms switch live through `setPeriodicWave` or a 5 ms crossfade). A test requires a binding for every `live` and `unverified` descriptor.

### 4.2 Native nodes or AudioWorklet (decision 2)

| | native nodes first (recommended) | AudioWorklet engine from the start |
| --- | --- | --- |
| covers | static waves, FM, Sub, Super, Multi, PWM by delay, noise, biquads, WaveShaper drive, all envelopes and LFO targets except the ones below | everything, sample-accurate: hard sync sweeps, shape modulation, alias-free PWM, ladder (LP M) with resonance character |
| weak spots | Sync and Shape Sine static per osc ctrl value (no env or LFO sweep); LP M = two biquads plus soft clip; drive coarse | one processor renders all voices: more code, harder to debug; own TS declarations (no `@types/audioworklet`) |
| build, CSP | nothing new | `?worker&url` same-origin file; allowed by `script-src 'self'` |
| tests | mapping and allocator in Node; graph manual | DSP is plain TS, so it is unit-testable in Node |
| size | 2 tasks (T3, T4) | about 2 more tasks |

Recommendation: native first, the weak spots marked "coarse approximation"; an AudioWorklet for oscillators and the ladder filter as a follow-up once listening shows where it matters.

### 4.3 Values → sound

| field | rule | basis |
| --- | --- | --- |
| env attack, decay, release (osc, flt, amp) | table label → seconds; `inf` = hold | tables `568-8`…`601-5` |
| `fltFreq` | label Hz → `frequency`, capped at 0.45 × sample rate | `587-6` |
| `fltKbdTrk` | `detune += (note − 60) × 100 × k`, k = 0, ⅓, ⅔, 1 | `595-4` |
| `fltEnvAmt` | 0.0–10.0 → 0…8 octaves on `detune` | unverified |
| `fltRes` | raw → Q 0.5…20 (exponential); LP+HP: raw → HP cutoff 20 Hz…20 kHz | unverified (M p.31–32 describe LP+HP) |
| `fltDrive` | off/1/2/3 → tanh WaveShaper, gain 1/2/4/8 | unverified |
| `fltType` | LP12 one lowpass; LP24 two; LP M two plus soft clip; LP+HP lowpass ∥ highpass summed; BP, HP one biquad | M p.31–32 |
| `fltEnvVel`, `oscEnvVel` | on → env depth × (0.3 + 0.7 × velocity/127) | unverified |
| `ampEnvVel` | off/1/2/3 → velocity sensitivity 0, ⅓, ⅔, 1 | unverified |
| layer level | dB label → gain; `volume off` → 0 | `378-3` |
| layer pan | raw / 60 → `StereoPannerNode.pan` | unverified |
| coarse, fine, octave shift | semitones, cents, ±12 per octave step → detune | `567-8`, `567-1`, `414-7` |
| pitch stick | range label → up/down semitones; bend × range | `415-4` |
| `oscEnvAmt` | −10…10 → ±24 semitones (to pitch) or ±full osc ctrl range | unverified |
| `glideRate` | 0.0–10.0 → 0…500 ms per semitone, exponential | unverified |
| `lfoRateClkDiv` | raw → 0.03…60 Hz, exponential | unverified (no table; opennord `576-6` not ported) |
| `lfoAmt` | raw/127 → ±1200 cents (pitch), ±4 octaves (filter), ±full range (osc ctrl) | unverified |
| `lfoWave` | triangle, saw, inverted saw, square, S/H | `576-2` |
| `vibRate` | Hz label | `602-6` |
| `vibAmt` | 0.0–10.0 → ±0…50 cents | unverified |
| `vibDly` | seconds label → per-voice depth ramp | `453-5` (table vs manual conflict) |
| `oscUnison` | 0–3 → 1–4 copies, ±0, 6, 12, 20 cents | unverified |

### 4.4 Effects

Recommendation: no layer effects in the MVP. They are their own panel section, 16 of their 32 fields are approximations, and a credible reverb needs generated impulse responses. Synth FX values are stored, exported and shown in the Effects region as layout-only. Follow-up order: delay and reverb first.

### 4.5 Labelling the approximation

- A fixed line in the status strip and the footer: the sound is the browser's approximation, not the Stage 4 engine. README says the same.
- Control-level markers: `unverified` → "not verified" with the `note` as description; option-level markers for LP M and FM-H/FM-I; "coarse" in the display when a Sync or Shape Sine wave is selected and env or LFO targets osc ctrl.
- Layers that cannot sound (Wave type, Samples mode, Extern) are silent with a print-out note naming the layer (decision 4).

## 5. Formats

### 5.1 App preset JSON

```json
{
  "format": "nord-stage4-editor-preset",
  "schema": 1,
  "app": "nord editor 0.1.0",
  "layout": { "model": "Nord Stage 4", "fields": 955, "keysCrc32": "9c1e2a7b" },
  "name": "Warm Pad",
  "category": 17,
  "values": {
    "common.splitEnabled": 0,
    "common.splitEnabledLow": 0,
    "synthASound.fltFreq": 74,
    "synthASound.fltFreq.morphWheel": 0
  },
  "source": {
    "kind": "ns4p",
    "fileName": "Warm Pad.ns4p",
    "formatVersion": 313,
    "bytesBase64": "Q0JJTgAAAAFuczRwAAA…"
  }
}
```

(`values` is shortened here; a real file has all 955 keys in layout order, which makes the output deterministic. `keysCrc32` is the engine's `crc32` over the keys joined by `\n`. `source` is `null` without an imported file, or absent under decision 3 option a.)

Validation in `parsePreset`, each failure a `PresetError` with a short message for the display and the full one for the print-out:

| check | message |
| --- | --- |
| over 1 MB, or not JSON | `not a preset file: <reason>` |
| `format` missing or different | `not an editor preset` |
| `schema` not a positive integer | `preset schema missing` |
| `schema` above 1 | `made by a newer editor (schema N); this editor reads schema 1` |
| `layout.model` or `keysCrc32` differs and no migration covers it | `made for another Stage 4 layout` |
| key missing or unknown | `<key>: missing` / `<key>: unknown field` |
| value not an integer, or out of range | `<key>: 300 is outside 0..127` |
| `name` not a string, `category` not 0–46 | `name invalid` / `category invalid` |
| `source` bytes not base64 or not a valid `.ns4p` | `source program unreadable: <engine message>` |

Version policy: `schema` changes on any breaking change of the document or the layout key set. `MIGRATIONS[n]` turns schema n into n+1 and never drops a value silently; a layout that gains fields fills them with layout defaults and returns a note. Newer schemas are refused, never guessed. Unknown top-level keys are ignored (forward-compatible metadata); unknown value keys are refused.

`localStorage` (`formats/storage.ts`): keys `ns4-editor:v1:index` (slot ids, names, dates) and `ns4-editor:v1:slot:<id>` (the same preset JSON). Every access sits in try/catch; quota exceeded or blocked storage shows a status and never loses the working state. Download writes `<name>.json`; re-import goes through `parsePreset`. An autosaved working copy is a UI decision for the orchestrator.

### 5.2 .ns4p import

- `Ns4Program.fromBytes` (engine): CBIN, tag, CRC, format 3.07–3.13, block chain. Engine messages show verbatim, as in the converter.
- All 955 fields populate the store (`program.value(key)`), not only the synth ones, so export and report keep the organ, piano, FX and common settings.
- A value outside the layout range is clamped and listed in the notes (none expected; golden fixtures are all in range).
- Meta: name from the file name (the Stage 4 stores no name), category from the header.
- Notes for the print-out: format version, scene II active, sections on in scene I that the editor does not play (organ, piano), layers on Wave, Samples or Extern, arp on, non-zero morphs (count), split on.
- Decision 3 decides whether the original bytes are kept as `source`.

### 5.3 What stays lossless

Two levels:

1. **App state** (all 955 values, name, category, source): lossless through save, load, download and re-import in every option. AC10 tests this.
2. **The `.ns4p` bytes**: 621 body bits (9.4 %) sit outside every field. Only option b keeps them across edit, save and export.

Decision 3 options: **a** neutral template always, presets carry values only (reproducible, the converter's donor, but drops the imported file's unknown state, for example the undecoded arp pattern preset); **b** keep the original bytes (base64, about 1.2 KB) in memory and in the preset, and use them as export donor when the file is format 3.13, else the neutral template with a note (recommended: closest to what the instrument wrote, no engine change); **c** like b for every format 3.07–3.13, which needs an additive engine change so `verify` accepts the donor's version (ask first).

### 5.4 Experimental export

`exportExperimentalNs4p(snapshot)`, called only by the export button's click handler after a confirmation step:

1. Donor: option b → `new Ns4Program({ ...src.header, bank: 0, location: 0 }, src.body)` when `source.formatVersion === 313`; else `loadTemplate()` (neutral, cached as in `state.ts`).
2. `category` = snapshot category if 0–46, else `CATEGORY_NONE`.
3. `edits` = every key whose snapshot value differs from the donor.
4. `out = new Ns4Program({ ...donor.header, category }, donor.body)`; `out.set(key, value)` for each edit.
5. `data = out.toBytes()`; `verify(data, donor, edits, category)`. A `ConversionError` or `RangeError` becomes `ExportError('export failed verification: …')` and nothing downloads.
6. File name `<name>.ns4p`. The name stays clean because the Stage 4 shows the file name as the program name; "experimental, untested on hardware" goes on the button, the confirmation and the print-out, which also names the donor.

These are the same engine calls as `convertBytes`, so the export is checked the same way as converter output. The check proves structure and field values, not acceptance by the instrument.

### 5.5 Parameter report

Plain text, UTF-8, `<name> parameter report.txt`:

```
nord stage 4 parameter report, for reading only
This is not a program file. The Stage 4, Nord Sound Manager and this editor cannot import it.
program: Warm Pad · nord editor 0.1.0 · 2026-11-03
baseline: the editor's init program (Stage 4 layout defaults, synth on, layer A on)
[not verified] = no Stage 4 display table; the number is the stored step.

synth · layer a · filter
  freq                 1.2 kHz          init 32 kHz
  res                  64 [not verified]  init 0
synth · layer a · amp envelope
  attack               120 ms           init 3.0 ms

3 changed values
```

Lists every field that differs from the baseline, in panel order (`sections.ts`), then layout order, including layout-only sections and morphs. Labels and units come from `formatValue`. Baseline = `initProgram()`; that the Stage 4's own init matches it is unverified, and the report says what the baseline is.

## 6. UI structure

Structure only. Visual form, layout grid, marker styling and wording are for the orchestrator to settle in a new "Editor" section of `docs/web-design.md` before T2.

### Regions (feasibility section 4)

| region | Stage 4 area | status | content |
| --- | --- | --- | --- |
| header | – | live | wordmark and nav as on the converter; link back to the converter |
| status strip | Program section's panic | live | audio status and start, MIDI status and enable, panic, approximation line |
| display | synth OLED | live | program name (editable); last touched parameter: label, value, unit, range, status |
| file keys | – | live | preset save, load, download, import; .ns4p import; experimental export; report |
| program | Program (M p.38–45) | live (13.4) | layer scene, section keys, split, transpose, master clock (stored); morph assign, preset refs, Aux KB and output bus fields read-only behind "show values" |
| organ | Organ (M p.18–22) | live (13.2) | layer strip, models, drawbars, vibrato/percussion, levels, and the rotary fields as its group `rotary` |
| piano | Piano (M p.23–26) | live (13.3) | layer strip, type, model, touch, levels |
| synth | Synth (M p.27–37) | live | layer strip (enable A/B/C, focus, level, pan); groups osc, filter, amp, LFO, vibrato, voice, keyboard, arp |
| extern | Extern (M p.46–47) | layout | per-layer extern fields |
| effects | Layer Effects (M p.48–53) | layout | FX of organ, piano A/B, synth A/B/C, focus, globals |
| keyboard | – | live | virtual keyboard, octave readout, computer-key legend |
| print-out | – | live | import notes, validation errors, export result |
| footer | – | live | approximation, AGPL, not affiliated with Clavia or Nord |

Since section 13 (13.1, 13.6) the program, organ and piano regions are live and the rotary fields form the organ region's group `rotary`; there is no separate rotary region.

`sections.ts` assigns every layout key to exactly one group or to `HIDDEN`; a test checks that (AC3). Layout-only regions show their stored values as read-only readouts (useful after an import) with the region marked "not implemented"; readouts are not in the tab order.

### Control primitives (`ui/controls.ts`)

- `continuous`: a native `<input type="range">` (step 1 in stored steps) with `aria-valuetext` = formatted value plus unit; arrows ±1, PageUp/PageDown, Home/End are native. Whether it looks like a knob or a fader is the orchestrator's call.
- `enum`: native `<select>` or a radio group; options with status carry their marker in the label.
- `bool`: `<button aria-pressed>`.
- `mask`: three `bool` buttons (A, B, C).
- `opaque`, `layout`: readout only.
- Every control: visible label, value and unit, range (min and max formatted) in its description, status marker, `aria-describedby` to the note. Focus ring 2 px accent, offset 2 px, as in `web/`.

### States

`live` plain; `unverified` "not verified" marker plus the note; `stored` "not implemented (sound)", still editable (proposal, section 3.2); `layout` region badge "not implemented", readouts only. Non-zero morph amounts: an indicator on the parent control (decision 5). Values without a label: the number plus "not verified" (`raw`) or "not decoded".

### Focus order

Skip links (to program, to synth, to keyboard) → header → status strip (start audio, enable MIDI, panic) → name and file keys → program region (scene keys, section keys, split, transpose, master clock, "show values") → organ region (layer strip, drawbars, perc · vibrato, rotary, keyboard group) → piano region (layer strip, model, touch, keyboard group) → synth layer strip → oscillator → filter → amp → LFO → vibrato → voice → keyboard group → arp → keyboard region (one focusable element whose label explains the computer keys) → print-out. Section 13 added the program, organ and piano steps (13.1, 13.6). Polite live regions (`aria-live`): the display's state line, the status strip's announcements and the print-out lines. Computer keys play while focus is not in a text field or `<select>` and no Cmd/Ctrl/Alt is held; range inputs ignore letters, so the two coexist.

Computer keys use `KeyboardEvent.code` (physical position), so the piano shape holds on QWERTZ, where Y and Z swap labels. The legend shows real labels via `navigator.keyboard.getLayoutMap()` where it exists (Chromium) and US letters otherwise. Fixed velocity 100.

Virtual keyboard: Pointer Events (mouse, touch, pen in one path), `setPointerCapture` per pointer, velocity from the vertical position on the key, several pointers at once, `pointercancel` releases, `touch-action: none` on the keys.

### Narrow screens

Desktop first. Below a breakpoint the regions stack, layout-only regions collapse to their heading, synth groups wrap, and the keyboard shows about two octaves with horizontal scroll. Exact behaviour: orchestrator.

### UI decisions left to the orchestrator

Knob or fader; enum widget; marker look and wording; region grid and order; display content; keyboard size and range; autosave of the working copy; whether `stored` controls are editable; the export confirmation; a panic shortcut (Esc proposed); where the converter's link sits (`web/index.html`, one line).

## 7. Test plan

All new TS tests under `web/test/editor/`, picked up by `npm test` (`test/**/*.test.ts`). They import only pure modules (no DOM, no Web Audio).

| AC | test (web/test/editor/…) | asserts | manual |
| --- | --- | --- | --- |
| 1 | – | – | review: done (`docs/editor-feasibility.md`) |
| 2 | – | – | review of this file |
| 3 | `sections.test.ts` | every layout key in exactly one group or `HIDDEN`; regions program, organ, piano, synth, extern, effects, rotary exist; only synth is `live` | screenshots light and dark in the Browser pane (`npm run build && npm run preview`, `/nordconvert/editor`) |
| 4 | `descriptors.test.ts`, `units.test.ts`, `labels.test.ts`, `store.test.ts`, `mapping.test.ts`, `bindings.test.ts` | every MVP control has label, kind, range, default, unit or options; `clampValue` at min−1, max+1, fractions, `raw` encoding; every label of every table used by an MVP control parses; `ns4Label` equals Python's `labels-golden.json`; every `live`/`unverified` key has a binding; mapping is finite over the range and monotonic for freq, times, level | turn each MVP control and listen (checklist = section 3.2 table) |
| 5 | `pointer.test.ts` | velocity from y (top soft, bottom loud, clamped 1–127); two pointers hold two notes; up and cancel release; move across keys releases the old note | mouse; touch via `resize_window` mobile preset |
| 6 | `computer-keys.test.ts` | 16 codes → semitones; Z/X octave and limits; repeat, modifiers, text input and select ignored; keyup after an octave change releases the original note; `releaseAll` | play; legend in UI and README |
| 7 | `midi-parser.test.ts`, `midi-status.test.ts` | note on, note off, velocity 0 = off, CC64 ≥ 64 on, CC1, CC11, pressure, 14-bit bend centre, CC120/123 → panic, system and SysEx ignored; status texts for unsupported, denied (`NotAllowedError`, `SecurityError`), no inputs, connected, disconnect | Chrome with a device or the macOS IAC driver; Safari shows "not supported" |
| 8 | `voice-alloc.test.ts` | poly allocation; 47th voice steals; mono priority none/low/high; legato retarget; sustain defers release; `allNotesOff` after held, sustained and releasing voices → `activeCount` 0 | panic button; switch tab while holding keys |
| 9 | `audio-status.test.ts`, `envelope.test.ts` | reducer: idle → starting → running; suspended and interrupted → blocked; failed → error; unsupported; envelope values at attack, decay, hold, release | first key starts audio; status when blocked (Safari) |
| 10 | `preset.test.ts`, `storage.test.ts` | init, randomised and imported snapshots → JSON → parse deep-equal (source bytes included); a fake `Storage` save/load round trip; each validation failure of 5.1 gives its message; schema 2 refused | save, reload page, load; download and re-import |
| 11 | `ns4p-import.test.ts` | for `TEMPLATE_BYTES`, `golden.reference` and every public golden output (`expectedOutput`): store values equal `Ns4Program.value` for all 955 keys, all in range; a bad file gives the engine's message | open a golden output in the editor |
| 12 | `ns4p-export.test.ts` | from init and from an imported file with edits: export → `Ns4Program.fromBytes` → all fields equal the snapshot; uncovered bits equal the donor's; a snapshot with an out-of-range value (built without the store) fails with `ExportError` and returns no bytes; option b: unedited export keeps the source body byte for byte; a 3.07 file built in the test with `buildCbin` falls back to the neutral donor | export needs a click and a confirmation; labels say experimental |
| 13 | `report.test.ts` | fixed snapshot → text equals `web/test/editor/fixtures/report-expected.txt`; contains the not-a-program line; not JSON, not CBIN; `.txt` file name | – |
| E1 | – | `cd web && npm test && npm run typecheck && npm run build`; `python3 -I -m unittest discover -s tests -t .` (adds `tests/test_editor_tables.py`) | – |
| E2 | existing `parity.test.ts`, `engine.test.ts`, `state.test.ts` unchanged | – | `git diff -- web/src/main.ts web/index.html web/src/engine` shows only the link |
| E3 | `imports.test.ts` | module rules of section 1; no network APIs | `git diff --stat`, `package.json` and lockfile, `git status --short` (no `presets/`, `docs/analysis/`, `golden-local.json`) |
| E4 | `descriptors.test.ts` | every control has a non-empty label | `read_page` lists names; keyboard-only walk with the focus ring visible |
| E5 | – | – | `/code-review`, then sipgate-coding-pro; each finding fixed or refuted with evidence |

Also: `keys.test.ts` (`NS4_KEYS` equals `NS4_LAYOUT` order), `tokens.test.ts` (token block of `editor.css` equals `styles.css`), Python `tests/test_editor_tables.py` (fresh render equals the committed module and golden).

## 8. Implementation tasks

Every task ends with `cd web && npm test && npm run typecheck && npm run build` and the Python suite. Sizes: S < 150 lines, M 150–500, L 500–1,200, XL > 1,200 (code plus tests).

| # | goal | files | depends on | verification | size |
| --- | --- | --- | --- | --- | --- |
| T1 | Page, build and parameter model | `web/editor/index.html`, `web/vite.config.ts` (input, dev rewrite), `web/src/editor/editor.css` (tokens), `main.ts` (stub), `tools/gen_editor_tables.py`, `web/src/editor/generated/display-ns4.ts`, `web/test/editor/labels-golden.json`, `tests/test_editor_tables.py`, `model/*`, `package.json` script `gen:editor` | none (decision 3 only shapes `ProgramSnapshot.source`) | tests `keys`, `labels`, `units`, `descriptors`, `store`, `sections`, `imports`, `tokens`; `dist/editor/index.html` exists; `vite preview` serves `/nordconvert/editor` and `/nordconvert/editor/` | L |
| T2 | All regions on screen, synth controls bound to the store (no sound) | `ui/dom.ts`, `controls.ts`, `panel.ts`, `synth-panel.ts`, `display.ts`, `printout.ts`, `editor.css`; `docs/web-design.md` editor section (orchestrator's decisions) | T1, decision 1, orchestrator's visual spec | screenshots light and dark; keyboard walk; `read_page` names | L |
| T3 | Input and voice management | `input/*`, `audio/voice-alloc.ts`, `ui/keyboard-view.ts` | T1 | tests `computer-keys`, `pointer`, `voice-alloc`; keys light on screen | M |
| T4 | Audio engine on native nodes, audio start, panic, hide: first playable synth (checkpoint 2) | `audio/status.ts`, `host.ts`, `mapping.ts`, `envelope.ts`, `oscillators.ts`, `voice.ts`, `bindings.ts`, `engine.ts`, `ui/status-bar.ts` | T2, T3, decisions 2, 4 | tests `audio-status`, `envelope`, `mapping`, `bindings`; listening pass over section 3.2; 46 voices in Chrome's performance panel; Chrome, Firefox, Safari; screenshots both themes | XL |
| T5 | MIDI input | `midi/parser.ts`, `midi/access.ts`, status in `ui/status-bar.ts` | T4 | tests `midi-parser`, `midi-status`; Chrome with IAC; Safari status | S–M |
| T6 | App presets and .ns4p import | `formats/preset.ts`, `storage.ts`, `base64.ts`, `ns4p-import.ts`, `ui/file-bar.ts`, `ui/files.ts` | T2 (T4 for listening), decision 3 | tests `preset`, `storage`, `ns4p-import`; manual save, reload, load; open a golden output | M |
| T7 | Experimental export, report, converter link, README, docs | `formats/ns4p-export.ts`, `report.ts`, `ui/file-bar.ts`, `web/index.html` (one link), `README.md` (start, controls with key map, browsers, limits), `docs/web-design.md` | T6 | tests `ns4p-export`, `report`; E1–E5; preview deployment curl checks (section 0) | M |

Follow-ups, not MVP: AudioWorklet oscillators and ladder filter; layer effects (delay and reverb first); arp/gate with master clock; morph editing and playback; KB zones with split, KB Hold, Group; MIDI CC/NRPN control input (Appendix II); organ engine (additive drawbars).

## 9. Decisions for the user

1. **UI library.** ~60 synth controls on screen at a time (one layer), ~140 read-only readouts, updates per parameter.
   - **a. Plain TypeScript (recommended).** 0 KB, no approval or audit, like the converter; a small `h()` helper and control classes with `rebind`/`dispose`; per-key store subscriptions give fine-grained updates without diffing; all logic stays testable in Node.
   - b. Lit 3.3.3 (BSD-3-Clause, released May 2026, "about 5 KB" min+gz by its own account): light-DOM custom elements per control (`<ns4-knob>`), a `ReactiveController` bridging the store, no decorators (`erasableSyntaxOnly`, Node's type stripping); shadow DOM and `static styles` avoided for CSP and token reasons.
   - c. Preact 11.1.1 with @preact/signals 2.11.4 (MIT, both released Oct 2026, "3 kB" core by its own account, signals about 2 KB more): `.tsx` UI (`jsx: react-jsx`, `jsxImportSource: preact`), one signal per parameter; `.tsx` cannot run under `node --experimental-strip-types`, so UI files stay untested in Node (logic stays in `.ts`).
   For b or c: pin an exact version released at least two weeks before install, `npm audit`, and measure the built size.
2. **Audio engine.** a. Native Web Audio nodes in the MVP, Sync/Shape Sine/LP M/drive marked "coarse", AudioWorklet as a follow-up **(recommended)**; b. AudioWorklet voice engine from the start (about two extra tasks); c. native graph plus a small worklet only for sync and shape oscillators.
3. **Export donor and preset bytes.** a. Neutral template always, presets hold values only; b. keep the imported `.ns4p` bytes in memory and in the preset, use them as export donor for 3.13 files, neutral template otherwise **(recommended)**; c. as b for 3.07–3.13, with an additive engine change to `verify` (ask first).
4. **Oscillator scope.** a. Documented oscillators only (Analog 45 waves, FM-H/FM-I approximated); Wave type and Samples mode stay selectable values but are marked "not implemented" and leave that layer silent with a note **(recommended)**; b. Wave entries play a placeholder sound labelled "placeholder".
5. **Morphs.** a. Store, export and report all 72 synth morphs, show non-zero ones read-only on the parent control **(recommended)**; b. edit them and play them from MIDI CC1, channel pressure and CC11 as linear deltas, marked "not verified".

## 10. Risks

- **Unverified sound**: 14 MVP controls per layer have guessed curves; the overall sound will differ from a Stage 4. Mitigated by markers and the approximation line, not removable without hardware recordings.
- **Directory index on Vercel** unverified (section 0); fallback is an ask-first `vercel.json` rewrite. Local dev needs the small rewrite plugin, or `/nordconvert/editor` shows the converter.
- **Headers in production** come from the portfolio, not `web/vercel.json`. A future `midi=()` or stricter `script-src` there would break MIDI or a later worklet; check live headers after each release.
- **Display-table drift**: `display-ns4.ts` is a second generated copy of `_tables_ns4.py`; `tests/test_editor_tables.py` fails when they differ. Regenerating from a newer opennord must run both generators (`npm run gen` plus `gen:editor`).
- **Editor-side label port** of `labels.py` could diverge; the Python label golden guards it.
- **CPU**: 46 voices × unison × Super stacks on native nodes can overload phones; per-voice node budget and the single `MAX_VOICES` constant are the levers.
- **Browser gaps**: Safari has no Web MIDI; `cancelAndHoldAtTime` is not available everywhere (Firefox at last check), hence the own envelope math; iOS mutes Web Audio with the ringer switch unless `navigator.audioSession.type = 'playback'` is set where supported; iOS may need a second tap to unlock audio.
- **Export**: untested on hardware; `verify` proves structure only; option b carries unknown bits that may depend on decoded values the user changed; the file name becomes the program name.
- **Layer and scene semantics**: layer-enable bit order and scene handling come from the converter, unverified on hardware; MVP plays scene I only.
- **Keyboard layouts**: `code`-based keys match positions, not labels; legend falls back to US letters outside Chromium.
- **Storage**: `localStorage` may be blocked or full (private modes); presets must be downloadable regardless.
- **Brief deviation**: `web/editor/index.html` instead of `web/editor.html`; record the reason in the final report.
- **Trade dress**: descriptive use of "Nord Stage 4" only, own visual language from `docs/web-design.md`; reviewers check no Nord red, logo or panel imagery slips in.

## 11. Decisions (Thilko, 2026-11-03, checkpoint 1)

1. UI: plain TypeScript, no UI library (option a).
2. Audio: native Web Audio nodes in the MVP; Sync, Shape Sine, LP M and drive marked "coarse"; AudioWorklet is a follow-up (option a).
3. Export donor: keep the imported `.ns4p` bytes in memory and in the app preset, use them as donor for 3.13 files, neutral template otherwise (option b).
4. Oscillators: Wave type and Samples mode stay selectable and are exported, marked "not implemented"; that layer is silent with a note (option a).
5. Morphs: read-only; stored, exported, reported; non-zero morphs shown as an indicator on the parent control (option a).
6. Visual direction: the checkpoint-1 mockup, specified in `docs/web-design.md`, section "Editor (/nord)".
7. Stored-only controls (`stored` status) stay editable, marked "no sound in MVP". Panic shortcut: Esc. Autosave of the working copy to localStorage: yes, separate from named presets. Export asks for a confirmation that names it experimental and untested on hardware.

## 12. Status (2026-11-03, after T7)

What T1–T7 delivered:

- **T1** Page and parameter model: `web/editor/index.html`, the dev and preview rewrite in `web/vite.config.ts` (`/nordconvert/editor` without a trailing slash), `tools/gen_editor_tables.py` → `web/src/editor/generated/display-ns4.ts` and `web/test/editor/labels-golden.json` (`npm run gen:editor`, guarded by `tests/test_editor_tables.py`), `model/*`.
- **T2** All regions on screen with the synth controls bound to the store: `ui/dom.ts`, `controls.ts`, `control-model.ts`, `panel.ts`, `synth-panel.ts`, `display.ts`, `printout.ts`, `page.ts`; the "Editor" section of `docs/web-design.md`.
- **T3** Input and voice management: `input/*`, `audio/voice-alloc.ts`, `ui/keyboard-view.ts`.
- **T4** Native Web Audio engine, audio start, panic (also Esc), release on hide: `audio/*` (with `gate.ts` and `waveforms.ts`), `ui/status-bar.ts`.
- **T5** MIDI input: `midi/parser.ts`, `midi/access.ts`, the MIDI slot of the status strip.
- **T6** App presets, browser slots, autosaved working copy and .ns4p import: `formats/preset.ts`, `storage.ts`, `base64.ts`, `ns4p-import.ts`, `ui/files.ts`, `ui/file-bar.ts`.
- **T7** Experimental export (`formats/ns4p-export.ts`), parameter report (`formats/report.ts`), the keys `stage-4-programm (experimentell) ↓` (behind an inline confirmation in the files box) and `report ↓`, an optional `onLoad` callback on the file keys (after a preset load, an import or a .ns4p open; not after restoring the working copy), one link from the converter's source section, the README section "Editor".

Deviations from this plan:

- The page is `web/editor/index.html`, not `web/editor.html` as the brief says: Vite's directory index serves it at `/nordconvert/editor/`, and the rewrite covers `/nordconvert/editor`.
- File names: app presets download as `<program> · app-preset.json`, the report as `<program> · parameter-report.txt` (section 1 and 5.5 said `<name>.json` and `<name> parameter report.txt`); the export stays `<program>.ns4p`. A shared `safeFileBase` in `formats/preset.ts` replaces characters file systems refuse.
- `exportExperimentalNs4p` also returns the edit count; it throws `ExportError` (and returns no bytes) for a missing or non-integer value, a value outside its field, an unreadable source and any failure of `verify`. An unknown category is written as None with a note.
- `parameterReport` takes an optional `baselineName`; inside a region it lists the layer-free groups first, then all groups of layer a, b and c; fields without a control follow under "no control", in layout order. Markers: `[not verified]` (status unverified, or a value without a Stage 4 label) and `[not implemented]` (status stored or layout, or a value whose option is not implemented, such as samples mode or the Wave type).
- `readPreset` returns the migration notes next to the snapshot; `parsePreset` is the plain variant.
- The export confirmation is a line inside the files box (`confirm ↓` / `cancel`), not a native dialog.
- Still open: the preview deployment checks of section 0 and the reviews of E5. (`onLoad` is wired in `main.ts`: a load stops every note; the program, organ and piano work of section 13 is tracked in 13.10.)

## 13. Program, organ and piano (scope extension, 2026-11-03)

Scope (user, 2026-11-03): the program, organ and piano sections work end to end like the synth: controls bound to the store and audible in the browser; app preset, report and export already carry every field. Orchestrator decisions:

- **Piano:** a synthesized approximation per Stage 4 piano type and family, no Nord samples; all 295 piano names selectable; labelled approximation.
- **Organ:** additive approximations of B3, Vox, Farfisa, Pipe 1, Pipe 2 and B3 Bass with drawbars, percussion, vibrato/chorus and an approximated rotary speaker.
- **Effects:** the organ and piano layer effects (`organFx`, `pianoAFx`, `pianoBFx`) stay "not implemented", like the synth effects.
- **Program:** layer scene I/II (the scene selects which `*_I`/`*_II` switches and focus are edited and played); split points, xfade and every layer's `kbZone` applied to every section, the synth included; transpose; section enables. Master clock stored only; morph assignment and preset references read-only.

The brief's guardrails and sections 0 and 1 still apply: plain TypeScript, no new dependency, strict CSP, the module rules of `imports.test.ts`, no Nord trade dress; `web/src/engine/**`, `web/src/main.ts`, `web/src/state.ts`, `web/vercel.json` and private files stay untouched. "M p.N" is the manual (v1.6X, Edition N), "S" the specifications page ("120 Voice Polyphony" piano, "46 Voice polyphony" synth, no organ figure; checked 2026-11-03).

### 13.1 Statuses after this work, and rules that change

Statuses keep their meaning (section 3.1): `live` sounds with known units, `unverified` sounds with guessed units or behaviour, `stored` is edited and exported without sound, `layout` is read-only "not implemented". The regions `program`, `organ` and `piano` become live; the rotary fields join the organ region as its group `rotary` (docs/web-design.md); extern and effects stay `layout`.

Model rules B4 changes:

1. `descriptors.ts` takes the status from `curated.ts` for every field placed in a live region (today only `synth`) and throws when a field of a live region has none, unless its group's status is `stored` or `layout` (master clock; preset refs, aux kb, output), which it then inherits.
2. Scene twins: the `_II` keys stay in `HIDDEN` (no own control, no own placement). Their descriptors copy kind, options, status and note of the `_I` twin (label: the twin's label + ` · scene ii`); region and group stay null.
3. Controls follow the scene the way they follow the focused layer: `control.rebind(key)` accepts a key whose `sceneFree(patternOf(key))` equals the current one (`model/scene.ts`). Panels rebind their scene controls when `common.layerScene` changes, and their layer controls when the active scene's focus changes.
4. Audio: `bindingOf(key)` (synth, organ and piano tables) resolves a scene key through `sceneTwin` to its `_I` pattern; binding tables list `_I` keys only.

Router-owned keys matter only at the next note-on and no engine reacts to them: `common.layerScene`, the 18 scene keys (`SCENE_KEYS`), `common.split*`, `common.transpose*` and every `*.kbZone`. Each engine's binding table still lists the router-owned keys of its own region with an effect that does nothing (apply `next-note`), as the synth already does for `common.sectionEnableSyn_I`, so the coverage tests stay one rule.

Morphs (357 fields, decision 5) stay read-only in every section: stored, exported, reported, a dot on the parent control, not played.

### 13.2 Organ

#### Fields

`{X}` is organ layer `A` or `B`. Table ids are the Stage 4 display tables in `display-ns4.ts`.

| key | kind | range / labels | status | sound meaning (M) |
| --- | --- | --- | --- | --- |
| `common.sectionEnableOrg_{I,II}` | bool | off/on (084-5, 084-8) | live (router) | organ section on in the scene (p.18, 43) |
| `organ.layerEnableOrg_{I,II}` | mask | A = 1, B = 2 (raw 0..3, no table) | live (router) | layers on (p.18); bit order as the converter writes it, unverified |
| `organ.layerFocusOrg_{I,II}` | enum | A, B (raw 0..1) | live, no sound | the layer the panel edits (p.18) |
| `organ.layerLevelOrg{X}` | continuous | volume off … 0 dB (095-7) | live | layer gain (p.18) |
| `organ.orgPStickEnable` | bool | off/on (103-5) | live | the pitch stick bends the whole organ ±2 semitones (p.18) |
| `organ{X}.kbZone` | enum | zone strings by split configuration (dep 113-1) | live (router) | zones the layer plays (p.18, 39) |
| `organ{X}.octaveShift` | continuous | −6..6; ±1, ±2 labelled (113-5), ±3…6 "not decoded" | live | ±12 semitones per step (p.18) |
| `organ{X}.sustainEnable` | bool | off/on (114-1) | live | the sustain pedal holds the layer (p.18) |
| `organ{X}.model` | enum | B3, VOX, FARF, PIPE1, PIPE2, B3 BASS (114-2) | live | organ model (p.18–21) |
| `organ{X}.presetEnable` | bool | off/on (114-5) | stored | off = Drawbar Live: the Stage 4 plays its physical drawbars (p.19, 21); the editor always plays the stored ones |
| `organ{X}Drawbars.org_Preset_kDb1…9` | continuous | 0–8 (manual labels, no table) | live | drawbar n; meaning per model below (p.19–21) |
| `organ{X}VibPerc.org_Preset_kVibratoEnable` | bool | off/on (141-1) | live | vibrato/chorus on for the layer (p.19); Vox and Farf share one state for both layers on the Stage 4 (p.20, 21), the editor uses each layer's switch |
| `organ{X}VibPerc.org_Preset_kB3PercEnable` | bool | off/on (141-2) | live | B3 percussion (p.20); no effect on other models |
| `organ{X}VibPerc.org_Preset_kB3PercHarmonic` | bool | off/on (141-3); on = 3rd | live | 2nd or 3rd harmonic (p.20) |
| `organ{X}VibPerc.org_Preset_kB3PercSpeed` | bool | off/on (141-4); on = fast | unverified | decay slow or fast (p.20); times guessed |
| `organ{X}VibPerc.org_Preset_kB3PercLevel` | bool | off/on (141-5); on = soft | unverified | volume normal or soft (p.20); levels guessed |
| `organ.polyPercEnable` | bool | off/on (raw) | live | poly percussion: every stroke, not single-triggered (p.20) |
| `organ.vibratoTypeB3` | enum | V1 C1 V2 C2 V3 C3 (raw 0..5; the converter's order, `mapOrganVibrato`) | unverified | scanner type of B3 and B3 Bass (p.19) |
| `organ.vibratoTypeVox` | enum | V1 V2 V3 (raw 0..2; converter comment) | unverified | Vox vibrato (p.20) |
| `organ.vibratoTypeFarfisa` | enum | V1 V2 C2 C3 (raw 0..3; converter comment) | unverified | Farf vibrato/chorus (p.21) |
| `organ.effectsLeslieEnable` | bool | off/on (104-1) | live | the organ goes through the rotary speaker (p.53) |
| `organ.effectsLeslieSpeed` | bool | slow/fast (109-4) | unverified | rotor speed (p.53); speeds and ramps guessed |
| `organ.effectsLeslieStopMode` | bool | off/on (109-3) | live | with slow, the rotors stop (p.53) |
| `organ.leslieStopPreset` | enum | Free, Front Center, Front Left, Front Right, Back Left, Back Right, Back Center (108-5) | stored | stop angle (p.53); not applied |
| `organ.effectsLeslieDrv` | continuous | 0.0–10.0 (105-5) | unverified | rotary overdrive (p.53) |
| `organ.leslieMicDistance` | bool | raw; 0 normal, 1 close (assumed) | unverified | Close Mic (p.53) |
| `organ.leslieRotorAngle`, `organ.leslieHornAngle` | continuous | raw 0..127 | stored | stored rotor angles; not applied |
| `organ.auxKbdControl` | – | raw 0..3 | layout | Aux KB, read-only in the program region |
| 63 organ morphs | – | – | stored, hidden | levels, drawbars, rotary speed (decision 5) |
| `organFx.*` (32) | – | – | layout | organ effects, not implemented |

Drawbars per model (M p.19–21):

| model | db1 | db2 | db3 | db4 | db5 | db6 | db7 | db8 | db9 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| B3 | 16′ | 5⅓′ | 8′ | 4′ | 2⅔′ | 2′ | 1⅗′ | 1⅓′ | 1′ |
| PIPE1, PIPE2 | 16′ | 5⅓′ | 8′ | 4′ | 2⅔′ | 2′ | 1⅗′ | 1⅓′ | 1′ |
| B3 BASS | 16′ | 8′ | – | – | – | – | – | – | – |
| VOX | partial 1 | 2 | 3 | 4 | 5 | 6 | 7 | – | soft ↔ bright |
| FARF (value ≥ 5 = on) | Bass 16 | Strings 16 | Flute 8 | Oboe 8 | Trumpet 8 | Strings 8 | Flute 4 | Strings 4 | bright 2⅔′ |

- Pipe: "The pipe lengths available for both Pipe models correspond to those of the B3 model" (p.21).
- B3 BASS: "the two traditional B3 Bass 16′ and 8′ drawbars" (p.21); that they are db1 and db2 is assumed.
- VOX: "The seven drawbars to the left control the level of each partial"; the rightmost one "controls the mix between a filtered signal sounding soft and dark, and an unfiltered signal sounding bright" (p.20). Their footages are printed on the panel only; the engine uses 16′ 8′ 4′ 2′ 2⅔′ 1⅗′ 1′ (guess) and db8 does nothing.
- FARF: the drawbars are register switches; "Pulling a drawbar more than half way out will activate that register", LEDs 5–8 lit = on (p.20–21), hence on = value ≥ 5. Register names from the table on p.21.

#### Sound model (B1)

A voice is one key on one layer. Organs ignore velocity. Gate on with a ≈ 1 ms ramp and off with ≈ 5 ms (B3, B3 Bass, Vox, Farf); Pipe 1 attack 30 ms and release 120 ms; Pipe 2 attack 60 ms with a chiff and release 200 ms. Pitch = note + 12 × octave shift; the pitch stick (organ-wide) adds up to ±200 cents. With `organ{X}.sustainEnable` the pedal holds that layer's voices.

Per layer: generator → model shaping → vibrato/chorus when on → layer level → organ bus. Organ bus → rotary when `effectsLeslieEnable` is on, else straight → `out`. Both layers share the organ bus and the rotary.

Drawbar level for continuous drawbars: 0 is silent, v is 10^(−3·(8 − v)/20) (3 dB per step, the Hammond convention; unverified for the Stage 4). Loudness: one note with registration 888000000 at 0 dB layer level peaks at ≈ 0.5 on the organ bus; a full registration stays ≤ 1.0 per note; chords go to the master limiter.

**B3 (tonewheel model).**

- Tonewheel generator: 91 sine `OscillatorNode`s, wheel n at 440·2^((n − 46)/12) Hz (wheel 1 = C1, 32.7 Hz; wheel 91 ≈ 5.92 kHz; equal temperament, the real gear ratios differ by less than a cent). Created at the first B3 or B3 Bass note, shared by both layers, kept until dispose (stopping it after an idle time is B1's choice). The pitch stick reaches all 91 `detune`s through one `ConstantSourceNode`.
- Key m, drawbar n uses wheel m − 23 + [−12, +7, 0, +12, +19, +24, +28, +31, +36][n − 1] (the 8′ of MIDI 36 is wheel 13). Foldback: below 1 add 12, above 91 subtract 12, repeated (the B3 folds the top back; the bottom fold is an approximation). The fifths and the 1⅗′ are tempered wheels, as on the instrument, so they beat slightly against pure harmonics.
- Per voice: nine contact `GainNode`s from the wheels into the layer's nine drawbar buses (each a `GainNode` at its drawbar level, so a drawbar move is one param change per layer). Two keys on the same wheel add in phase, as on the instrument.
- Key click (p.20; level "Normal", since the click level is a Sound menu setting outside the program, p.58): a shared looped white-noise buffer → per voice band-pass 1.5–3 kHz with a burst 0 → 0.15 → 0 over ≈ 3 ms at key-down and ≈ 0.05 over 2 ms at key-up.
- Preamp "body" (p.19): per layer a gentle tanh `WaveShaper` (pre-gain 1.5) and a low-shelf +3 dB at 100 Hz. Coarse.
- Percussion (p.20), B3 only, with `kB3PercEnable`: one more contact per voice from the 2nd harmonic wheel (m − 23 + 12, the 4′) or with `kB3PercHarmonic` the 3rd (m − 23 + 19, the 2⅔′), through an envelope: peak 1.0, or 0.5 with `kB3PercLevel` (soft); exponential fall to −40 dB in 1.2 s, or 0.4 s with `kB3PercSpeed` (fast). Single-triggered: it sounds only when no key of that layer is held ("You have to release all keys to be able to play new notes with the percussion effect"); `organ.polyPercEnable` triggers it on every note. As on the original B3, percussion on mutes the layer's 1′ drawbar (db9); unverified for the Stage 4.
- Vibrato/chorus scanner (p.19), per layer when on: a `DelayNode` centred at 1 ms, its delay swept by a 6.9 Hz sine with peak deviation V1 0.12 ms, V2 0.25 ms, V3 0.45 ms (≈ 9, 19, 34 cents). Vibrato is the wet signal only; chorus C1–C3 mixes dry and wet 1:1 at the same depths. Type from `organ.vibratoTypeB3`.
- Not modelled: tonewheel crosstalk and leakage, the trigger point (Sound menu settings, p.58).

**B3 Bass (p.21).** The same tonewheel generator: db1 = 16′ (offset −12) and db2 = 8′ (offset 0) of the key; other drawbars do nothing; 5 ms attack, no click, no percussion; the B3 scanner applies when vibrato is on.

**Vox (p.20).** Per voice one `OscillatorNode` with a `PeriodicWave` on the 16′ grid: partial drawbar k at ratio r_k to the 16′ fundamental (16′ 1, 8′ 2, 4′ 4, 2′ 8, 2⅔′ 6, 1⅗′ 10, 1′ 16) adds a buzzy series (harmonic j of that footage at level_k / j, j ≤ 16); components above 0.45 × sample rate are dropped. A drawbar move rebuilds the wave of the sounding voices with `setPeriodicWave`, once per store batch. db9: per layer two parallel paths, low-pass 1.2 kHz (soft) at gain 1 − t and direct (bright) at gain t, t = db9 / 8. Vibrato V1 V2 V3: delay swept at 5.6 Hz with deviation 0.08, 0.16, 0.3 ms (guess; "The V3 setting is the one that is modeled after the original instrument", p.20).

**Farf (p.20–21).** Registers on or off (value ≥ 5). Per voice one `PeriodicWave` on the 16′ grid summing the active registers at their footage (16′ 1, 8′ 2, 4′ 4, 2⅔′ 6): Bass 16 soft (odd harmonics, 1/j²); Strings bright and thin (1/j^0.7, harmonics 1–2 at 0.3); Flute nearly sine (harmonic 2 at 0.15); Oboe reedy (1/j, harmonics 2–5 × 1.5); Trumpet brassy (1/j to j = 12); the 2⅔′ voice bright (1/j^0.8). Active registers sum at equal level, scaled by 1/√(active count). Vibrato/chorus V1 V2 C2 C3: delay swept at 6.2 Hz; V1 0.1 ms, V2 0.25 ms; C2 0.2 ms and C3 0.35 ms with dry + wet (guess; "The V1, V2 and the C3 settings are the ones that are modeled after the original instrument's", p.21).

**Pipe 1 and Pipe 2 (p.21).** Per voice one `OscillatorNode` per drawbar above 0 (up to nine) at the B3 footages, but pure ratios (pipes are not tonewheels), each through its drawbar gain. Pipe 1 (all-purpose flue): sine plus 10 % 2nd harmonic, attack 30 ms, release 120 ms. Pipe 2 (principal): harmonics 1/j^1.5 up to j = 8, attack 60 ms, a chiff at the start (noise band-passed at 3 × f, 30 ms, −20 dB), release 200 ms. Vibrato/chorus on a Pipe "switches to a model which is tuned with less precision" (p.21): every footage oscillator gets a fixed detune from a seeded table within ±6 cents; no modulation.

**Rotary speaker (p.53, 58).** Organ bus → drive → crossover 800 Hz → horn (high band) and drum (low band) → stereo → `out`.

- Drive (`effectsLeslieDrv`, label 0.0–10.0): tanh `WaveShaper` with pre-gain 1 + 0.9 × label and post-gain 1/√pre-gain; label 0 leaves the signal linear. Drive grows with the instrument level (p.53), which the pre-gain gives by itself.
- Two virtual microphones, left and right. Horn: per microphone a `DelayNode` at 2 ms ± 0.25 ms (close mic ± 0.35 ms) and amplitude modulation depth 0.3 (close 0.45). Drum: ± 0.1 ms, depth 0.15 (close 0.2). The microphones see the rotation 90° apart: each rotor has two `OscillatorNode`s (sine, and a cosine `PeriodicWave`) started together with the same frequency automation. AM: `GainNode.gain` at 1 − depth/2 plus the rotation × depth/2.
- Speeds (the Sound menu's "Normal" defaults, p.58; values of the classic speaker, unverified): horn 0.83 Hz slow, 6.7 Hz fast; drum 0.67 Hz slow, 5.7 Hz fast; `setTargetAtTime` with horn τ 0.3 s up and 0.4 s down, drum τ 1.5 s up and 2.0 s down. Stop mode with slow: target 0 Hz on the down ramps; the rotors stay where they stop ("Free"). `leslieStopPreset` and the stored angles are not applied.
- Horn/drum balance 50/50 (Sound menu default, p.58). Rotary off: the organ bus goes straight to `out`.
- Only the organ feeds the rotary. Piano and synth reach it through the Amp/EQ "To Rotary" switch (p.53), part of the layer effects (not implemented).

Not modelled: swell pedal (p.21), Drawbar Live, tonewheel modes, trigger point, organ layer effects.

#### Voices and changes

Full polyphony (M p.19; S has no organ figure): no stealing in normal play; a guard of 128 voices (note-layers, oldest released first) bounds runaway MIDI. Cost: B3 91 shared oscillators plus about ten gains per voice; Vox and Farf one oscillator per voice; Pipe up to nine.

Bindings (`audio/organ/bindings.ts`): drawbars, layer level, vibrato on and type, rotary on, speed, stop mode, drive and mic: live (10 ms smoothing; Vox and Farf waves rebuilt per batch). Model, percussion switches, poly percussion, octave shift, sustain switch: next note (a sounding voice keeps its model and pitch). Pitch stick: live. `presetEnable`, stop preset, angles: no binding (stored). Router-owned keys: no-op.

### 13.3 Piano

#### Fields

`{X}` is piano layer `A` or `B`.

| key | kind | range / labels | status | sound meaning (M) |
| --- | --- | --- | --- | --- |
| `common.sectionEnablePno_{I,II}` | bool | off/on (084-6, 085-1) | live (router) | piano section on in the scene (p.23, 43) |
| `piano.layerEnablePno_{I,II}` | mask | A = 1, B = 2 (raw 0..3) | live (router) | layers on (p.23); bit order as the converter, unverified |
| `piano.layerFocusPno_{I,II}` | enum | A, B (raw 0..1) | live, no sound | the layer the panel edits (p.23) |
| `piano.layerLevelPno{X}` | continuous | volume off … 0 dB (230-7) | live | layer gain (p.23) |
| `piano{X}.kbZone` | enum | zone strings (dep 243-1) | live (router) | zones (p.23, 39) |
| `piano{X}.octaveShift` | continuous | −6..6; ±1, ±2 labelled (243-5) | live | ±12 semitones per step (p.23) |
| `piano{X}.pStickEnable` | bool | off/on (244-1) | live | bends ±2 semitones (p.23) |
| `piano{X}.sustainEnable` | bool | off/on (244-2) | live | sustain pedal (p.23) |
| `piano{X}.bank` | enum | Grand, Upright, Electric, Clav, Digital, Misc (244-3) | live | piano type; its default family (p.24) |
| `piano{X}.nameHash` | model select | the 295 names of `model/pianos.ts` (32-bit hash) | live | the model: picks the family within the type (p.24) |
| `piano{X}.entry` | enum | slot 1/20 … 20/20 (244-6) | stored | model slot; set to 0 on a model change, as Nord Sound Manager writes it for a substituted piano (converter) |
| `piano{X}.variation` | enum | Clav type: A, B, C, D; other types: 1–4 (raw 0..3, no table) | unverified | Clav pickup model (p.24); no effect for other types |
| `piano{X}.acoustic` | mask | string res = 1, soft release = 2 (raw 0..3; assumed: the default 1 is string res on, as the converter assumes) | unverified | Acoustics: Soft Release, String Res (p.25) |
| `piano{X}.pedalNoise` | bool | off/on (249-7) | unverified | pedal noise (p.25) |
| `piano{X}.kbdTouch` | enum | heavy, med, light (249-8) | unverified | touch curve (p.25) |
| `piano{X}.dynComp` | enum | off, 1, 2, 3 (raw; manual) | unverified | dynamic compression (p.25) |
| `piano{X}.unison` | enum | off, 1, 2, 3 (raw; manual) | unverified | unison (p.26) |
| `piano{X}.eq` | enum | timbre by type, below (raw 0..7) | unverified | timbre (p.26) |
| `piano.auxKbdControl` | – | raw 0..3 | layout | Aux KB, read-only in the program region |
| `piano.effectsSectionModePno`, `piano.fxLayerFocusPno` | – | raw | layout | effects region |
| 6 piano morphs | – | – | stored, hidden | layer levels (decision 5) |
| `pianoAFx.*`, `pianoBFx.*` (64) | – | – | layout | piano effects, not implemented |

Timbre labels of `piano{X}.eq` (p.26) depend on the type (`piano{X}.bank`); the value order is guessed from the order of the manual's lists:

| type | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Electric | off | Soft | Mid | Bright | Dyno 1 | Dyno 2 | – | – |
| Clav | off | Soft | Treble | Soft+Treble | Brilliant | Soft+Brilliant | Treble+Brilliant | Soft+Treble+Brilliant |
| Grand, Upright, Digital, Misc | off | Soft | Mid | Bright | – | – | – | – |

The Clav values read as a 3-bit mask (1 Soft, 2 Treble, 4 Brilliant); the manual's list has exactly that order. "–": no label; stored, flat, shown as the number with "nv".

#### Model catalogue (`model/pianos.ts`, phase 1)

`PIANO_MODELS` lists the 295 hashes of the engine's `PIANO_NAMES` (read-only import; `imports.test.ts` now lets the model read `../engine/generated/tables-ns4.ts`). Each entry has `type`, `family`, `size` (Sml/Med/Lrg/XL from the last word, else null), `label` (runs of spaces collapsed) and `ordinal`/`count` for the 93 labels that several hashes share. No table gives a name's type: the name rules in `pianos.ts` follow p.24 (Grand: acoustic and electric grands; Electric: tine and reed pianos; Clav: clavinets and harpsichords; Digital: digital and layer pianos; Misc: the rest) and are unverified.

Counts: grand 105 (grand 84, fortepiano 12, electric-grand 9), upright 75, electric 70 (tine 60, reed 10), clav 15 (clavinet 2, harpsichord 13), digital 22 (fm 9, digital-acoustic 8, digital-electric 5), misc 8 (vibraphone 2, marimba 2, Rain Piano as upright 4).

`pianoFamily(bank, hash)` returns the model's family when its type equals the stored bank, else the bank's default (`DEFAULT_FAMILY`: grand, upright, tine, clavinet, fm, vibraphone), so an unknown or zero hash (the init program) still plays.

Model edits (B4, `model/actions.ts`): `setPianoModel(store, layer, hash)` writes `nameHash`, then `bank` = the model's type and `entry` = 0 as derived values, in one batch. `setPianoType(store, layer, bank)` writes `bank` and, when the stored model belongs to another type, `nameHash` = the first model of the new type in catalogue order and `entry` = 0 (derived). Loads keep the stored values.

#### Sound model (B2)

Common to every family:

- A voice is one note on one layer, at most 12 source nodes. Pitch = note + 12 × octave shift, plus the pitch stick (±200 cents) when on; A4 = 440 Hz.
- Velocity: x = (velocity / 127)^γ with γ = 1.6 heavy, 1.2 med, 0.85 light (heavy "facilitates playing softly", p.25). Level = 10^(−R(1 − x)/20), with dynamic range R = 40, 32, 24, 16 dB for dyn comp off, 1, 2, 3 (it "reduces the dynamic range … by raising its minimum sound level", while "the dynamic range in terms of timbre remains intact", p.25): brightness always uses the uncompressed x.
- Envelopes: exponential, as in `envelope.ts` (a time T is the time to −40 dB, τ = T / 4.6); a voice ends below −80 dB and frees itself.
- Release (key-up without pedal, or pedal-up): damper decay T_rel. Acoustic families have no dampers from MIDI 89 (F6) up: those notes keep their natural decay. Soft release (`acoustic` & 2): acoustic families T_rel × 3.5 ("a slightly longer and less pronounced release", p.25); electric families T_rel × 0.5 ("dampened significantly"); clavinet and harpsichord ignore it (p.25).
- The same note struck again on the same layer: the old voice fades in 30 ms, a new one starts.
- Unison (p.26): off/1/2/3 plays the voice as two copies detuned ±4, ±8, ±16 cents and panned −0.6/+0.6 (they replace the plain copy, so the cost doubles); it counts as one voice.
- Timbre (`eq`): per layer, filters after the voices, live. Grand/Upright/Digital/Misc set: Soft = high-shelf −6 dB @ 3 kHz + low-shelf +2 dB @ 200 Hz; Mid = low-shelf −4 dB @ 200 Hz + peaking +3 dB @ 1 kHz (Q 0.7) + high-shelf −4 dB @ 5 kHz; Bright = high-shelf +6 dB @ 3 kHz. Electric set: Soft = high-shelf −6 dB @ 2.5 kHz; Mid = peaking +5 dB @ 1.5 kHz; Bright = peaking +4 dB @ 1.5 kHz + high-shelf +4 dB @ 5 kHz; Dyno 1 = peaking +6 dB @ 2.5 kHz (Q 1.2) + high-shelf +3 dB @ 8 kHz; Dyno 2 = Dyno 1 + low-shelf +5 dB @ 120 Hz + peaking −3 dB @ 600 Hz. Clav mask: Soft = high-shelf −6 dB @ 2 kHz, Treble = high-shelf +5 dB @ 3 kHz, Brilliant = peaking +6 dB @ 5 kHz, combined. The set follows the type (bank), not the family.
- Pedal noise (p.25; on the Stage 4 only with a Nord Triple Pedal or Single Pedal 2; the editor plays it on every sustain event): per layer with `pedalNoise` on, at pedal-down a low-passed (600 Hz) noise thump of 60 ms, at pedal-up a band-passed (2 kHz) swish of 40 ms, both at −30 dB; acoustic and electric families only.
- String resonance (`acoustic` & 1; p.25; Med sizes in the middle range C3–C6 = MIDI 48–84, Lrg and XL on all keys, Sml and electric families not at all, p.24–25): while the pedal is down, voices also feed a per-layer send (−24 dB) into 12 feedback comb filters (`DelayNode` + `GainNode` 0.97, delays = periods of the 12 pitch classes in octave 3), low-passed at 4 kHz and mixed at −18 dB; the send fades out over 0.3 s at pedal-up. Coarse; resonance of held keys without the pedal is not modelled.
- Loudness: one note at velocity 100, touch med, layer 0 dB peaks at ≈ 0.5 on the layer output.

Family recipes (f0 = pitch frequency, m = MIDI note after octave shift; partials only below 0.45 × sample rate):

| family | sources | envelope (T = time to −40 dB) | extras |
| --- | --- | --- | --- |
| grand | partials n = 1…10 at n·f0·√(1 + B·n²); B = 3·10⁻⁴ up to m = 48, doubling every 18 semitones above; amplitude (1/n)^(1.6 − 0.8x); partials 1–2 doubled ±0.7 cents from m = 40 (three strings) | partial n: T₁/(1 + 0.35(n − 1)), T₁ = 12 s · 2^(−(m − 21)/22); two stages: −6 dB in the first 0.3 s (τ 0.15 s), then T | hammer: noise band-passed at 2·f0 (800–5000 Hz), 15 ms, level 0.15x; T_rel 0.55 s; damper thump at key-up (noise low-passed at 300 Hz, 40 ms, −34 dB) |
| upright | grand with B × 1.8, T₁ × 0.7, doubles ±1.5 cents (±8 cents when the name has "HonkyTonk"), low-pass 6 kHz | as grand | names with "Felt", "Mellow" or "Soft": hammer × 0.4, partial slope +0.4 (darker) |
| fortepiano | grand with at most 8 partials, B × 2, T₁ × 0.45 | as grand | hammer band-passed at 3 kHz; T_rel 0.9 s |
| electric-grand | grand with B × 3, T₁ × 0.5, slope +0.3 | as grand | peaking +4 dB @ 1.2 kHz (pickup); no string resonance |
| tine | two-operator FM: carrier sine at f0, modulator sine at f0, index from I₀ = 0.5 + 2.5x² falling to 0.2·I₀ (τ 0.4 s); bell: sine at 13.6·f0, level 0.15x, τ 0.12 s | T = 4 s · 2^(−(m − 48)/24); attack 2 ms | T_rel 0.25 s; tanh bark with pre-gain 1 + 2x³ |
| reed | `PeriodicWave` harmonics 1…8, odd 1/j, even 0.5/j; tanh shaper pre-gain 1 + 3x²; low-pass 3 kHz | T = 2.5 s · 2^(−(m − 48)/24) | T_rel 0.2 s |
| fm | tine with I₀ = 2 + 3x², bell ratio 14, T × 0.7, no bark | as tine | the DX and JD-800 electric pianos |
| digital-acoustic | grand with at most 6 partials, B = 0, no doubling, no hammer | as grand | low-pass 8 kHz; T_rel 0.6 s |
| digital-electric | tine with I₀ = 1.5, no bell, T × 0.8 | as tine | – |
| clavinet | `PeriodicWave` pulse 10 % (≤ 24 harmonics); resonant low-pass (Q 4) from 8·f0 + 4000x Hz to 2·f0 + 800 Hz (τ 0.15 s) | T = 1.8 s · 2^(−(m − 48)/24) | pickups by `variation` (unverified): A neck: low-pass 2 kHz; B bridge: high-pass 400 Hz; C both: none; D out of phase: high-pass at 2.2·f0; T_rel 0.08 s and a key-off thunk (noise low-passed at 500 Hz, 15 ms) |
| harpsichord | `PeriodicWave` 1/j^0.8 (≤ 32 harmonics) plus a second string +3 cents; body band-pass 1.5 kHz (Q 0.7); velocity ignored (x = 0.8) | T = 3 s · 2^(−(m − 48)/24) | T_rel 0.35 s and jack noise (band-pass 3 kHz, 10 ms, −26 dB) |
| vibraphone | partials 1, 3.98, 10.3 at 1, 0.3x, 0.08x | T₁ = 8 s · 2^(−(m − 60)/24); partials 2 and 3 at T₁/3 and T₁/8 | mallet: noise low-passed at 1.5 kHz, 8 ms, −26 dB; T_rel 0.7 s; no motor tremolo |
| marimba | partials 1, 3.93, 9.2 at 1, 0.25x, 0.05x | T₁ = 1.2 s · 2^(−(m − 60)/24); partial 2 at T₁/4 | mallet: noise band-passed at 800 Hz, 10 ms, 0.1x; key-up ignored (no dampers) |

Every number above is invented to sound plausible; none comes from Nord. The panel says so (the approximation marker and the region legend `piano · approximation (no nord samples)`).

#### Voices and changes

120 voices over both layers (S), stolen oldest releasing first, then oldest held (the synth allocator's order). Worst case ≈ 1,440 source nodes: above 48 sounding voices, new voices get half their partials (one constant, named by B2).

Bindings (`audio/piano/bindings.ts`): layer level, timbre and string resonance (the send): live. Type, model, variation, touch, dyn comp, unison, octave shift, sustain switch: next note. Soft release: read at key-up. Pedal noise: next pedal event. Pitch stick: live. `entry`: no binding (stored). Router-owned keys: no-op.

### 13.4 Program

#### Fields

| key | kind | range / labels | status | meaning (M) |
| --- | --- | --- | --- | --- |
| `common.layerScene` | enum | I, II (085-3) | live (router) | active layer scene (p.15, 43) |
| `common.pdlLayerSceneEnable` | bool | raw | stored | layer scene pedal (p.60) |
| `common.splitEnabled` | bool | off/on (050-1) | live (router) | split on; off = every layer plays every key (p.39) |
| `common.splitEnabledLow`, `…Mid`, `…High` | bool | off/on (050-2, 050-3, 050-4) | live (router) | split point on (p.39) |
| `common.splitPosLow`, `…Mid`, `…High` | enum | C2 F2 C3 F3 C4 F4 C5 F5 C6 F6 C7 (050-5, 051-1, 051-5) | live (router) | split note: MIDI 36 41 48 53 60 65 72 77 84 89 96 (C4 = 60); the split note belongs to the upper zone (assumed) |
| `common.splitWidthLow`, `…Mid`, `…High` | enum | none, ±6, ±12 semitones (052-1, 052-3, 052-5) | unverified (router) | xfade width (p.39); the curve is guessed |
| `common.transposeEnable` | bool | off/on (052-7) | live (router) | transpose on (p.40) |
| `common.transposeValue` | continuous | −6…+6 semitones (052-8) | live (router) | "always affect all Layers of a program" (p.40) |
| `common.masterClockRate` | continuous | raw 30…240 = BPM | stored | tempo (p.39–40); no sound, since arp, LFO sync and delay are not implemented |
| `common.masterClockKbdSync` | enum | off, on, soft (raw 0..2; manual p.40) | stored | KBS |
| `common.pdlTapEnable` | bool | raw | stored | pedal tap (p.40) |
| `common.orgPresetPos`, `pnoPresetPos`, `synPresetPos`, `*PresetLayerCnt*` | – | raw | layout, read-only | Preset Library references (p.41); the name hashes stay hidden |
| `common.auxKbdEnable`, `auxKbdVelCurve`, `{organ,piano,synth}.auxKbdControl` | – | raw | layout, read-only | Aux KB (p.44, 58): a second MIDI keyboard is not mapped |
| `common.audioRoutingBus*` (7) | – | raw | layout, read-only | output routing (p.59) |
| 357 morph fields | – | – | stored, hidden | morph assignment (p.38–39); decision 5 |

`common.fxEnable`, `fxSectionFocus` and the three `effects*Global` fields stay in the effects region (`layout`).

#### Layer scene

- `common.layerScene` selects the scene for all that follows: the router reads the active scene's section and layer switches at every note-on; the panels show and edit the active scene's switches and focus (rebinding as in 13.1).
- Only switches and focus exist per scene: "any specific Layer uses the same sound and settings for both Scenes, and … the Layer Scene configuration only determines whether the Layer or Section is turned On or Off" (p.43).
- A scene change does not cut sounding notes; they end at key-up, new notes follow the new scene. The same holds for section and layer switches. Unverified (the manual promises switching "instantly and seamlessly", p.43).
- The init program plays synth layer A in scene I; scene II keeps the layout defaults, piano layer A (`initProgram` switches off scene I only). Switching to scene II in a fresh editor therefore plays the piano.
- Switching a section on with an empty layer mask also switches on its focused layer (B4 action, derived), so a section that is on is never silent; switching off the last layer stays allowed, as for the synth today.
- docs/web-design.md shows split point keys but no key for `common.splitEnabled`. Proposal (B4 action, derived): a point key also sets `common.splitEnabled` to "any point on". Open for the orchestrator.
- The point keys show what plays: a point is lit only while split is on too (`splitPointOn`), so the init program (Mid on at C4, split off) shows every point off. Switching a point on while split is off also switches the other points off (derived), so one click on `mid` in a fresh editor splits at C4 and nothing else.

#### Split, zones and crossfade (router, pure)

1. Split off (`common.splitEnabled` = 0) or no split point on: every enabled layer plays every key at gain 1.
2. Boundaries are the enabled points sorted by note (ties: Low, Mid, High). Segment 0 lies below the first boundary, segment i above boundary i. Each segment has a nominal zone: segment 0 → zone 1; the segment above a point → zone 2 (Low), 3 (Mid) or 4 (High). The zone names go by rank: the k-th lowest enabled position takes the k-th enabled point in Low, Mid, High order, so zones rise with the keys even when stored positions are out of order (Low above Mid); each boundary keeps its own note and width. Whether the Stage 4 allows out-of-order positions is unknown.
3. A layer's zones: the label of its `kbZone` value in the split-dependent table (`ns4Label`; dep tables 113-1 organ, 243-1 piano, 414-3 synth; deps = the three split enables) is four characters, character z for zone z, `1` = plays, `o` = does not (`11oo` = zones 1 and 2). Zones that a disabled point merges carry the same character in every row of those tables, so the nominal zone of step 2 reads the right one. A value without a label (the layout allows 11, the tables stop at 10) plays every zone.
4. The layer plays the segments whose zone character is `1`. Consecutive played segments form a run. For key n the gain is the largest, over the runs, of fadeIn(n, the run's lower boundary) × fadeOut(n, its upper boundary); a missing boundary counts 1.
   - Width w = 0: fadeIn = 1 when n ≥ b, else 0; fadeOut = 1 when n < b, else 0.
   - w = 6 or 12: x = clamp((n − (b − w)) / (2w), 0, 1); fadeIn = sin(x·π/2), fadeOut = cos(x·π/2) (equal power, guessed). So the lower zone reaches w notes above the split and the upper zone w notes below it, as p.39 describes.
5. Hits at or below `XFADE_FLOOR` (0.001) are dropped.

Zones use the physical key; the transpose moves only the pitch (assumed).

#### Transpose and octave shift

Sounding note = key + (`transposeEnable` ? `transposeValue` : 0); a key whose sounding note falls outside 0..127 is not played. The router remembers key → sounding note for each held key, so its noteOff matches even after a transpose edit. Each engine applies its layers' octave shift (the synth in `pitchCents`, as today).

### 13.5 Router and section interface

`web/src/editor/audio/section.ts` (phase 1, frozen):

```ts
export const XFADE_FLOOR = 0.001;
export interface LayerHit<L extends string = string> { readonly layer: L; readonly gain: number }
export interface RoutedNoteOn<L extends string = string> {
  readonly type: 'noteOn'; readonly key: number; readonly note: number; readonly velocity: number;
  readonly layers: readonly LayerHit<L>[];
}
export interface RoutedNoteOff { readonly type: 'noteOff'; readonly key: number; readonly note: number }
export type SectionEvent<L extends string = string> =
  RoutedNoteOn<L> | RoutedNoteOff | Extract<PlayEvent, { type: 'sustain' | 'bend' | 'controller' }>;
export interface SectionContext { readonly ctx: BaseAudioContext; readonly values: ValueReader; readonly out: AudioNode }
export interface SectionEngine<S extends SectionId = SectionId> {
  readonly section: S;
  handle(e: SectionEvent<LayerOf<S>>): void;
  applyChanges(batch: readonly Change[]): void;
  panic(): void;
  reload(): void;
  readonly activeCount: number;
  dispose(): void;
}
export type SectionFactory<S extends SectionId = SectionId> = (c: SectionContext) => SectionEngine<S>;
export type SectionEngines = { readonly [S in SectionId]?: SectionEngine<S> };
export interface SectionRoute<S extends SectionId = SectionId> {
  readonly section: S; readonly layers: readonly LayerHit<LayerOf<S>>[];
}
export type AnySectionRoute = { [S in SectionId]: SectionRoute<S> }[SectionId];
export interface NoteRouting { readonly key: number; readonly note: number | null; readonly routes: readonly AnySectionRoute[] }
export type RouteNote = (values: ValueReader, key: number) => NoteRouting;
```

`SectionId`, `OrganLayer`, `PianoLayer` and `LayerOf<S>` come from `model/scene.ts` (re-exported here).

Every engine:

- names a note by `note` (the sounding note); a noteOff releases every voice of that note in the section, on whatever layers it started;
- scales each new voice by its `LayerHit.gain` once, at note-on, with a per-voice `GainNode`; later split edits do not move it;
- receives sustain, bend and controllers unchanged and applies each layer's sustain and pitch stick switches;
- ignores keys of other sections in `applyChanges`; a batch with origin `load` or `init` makes it call its own `reload()`;
- leaves `activeCount` at 0 when `panic()` returns; the nodes fade over ≈ 10 ms;
- never writes the store and never imports `ui/`, `formats/` or `midi/`.

`audio/router.ts` (B3) exports:

```ts
export const SPLIT_NOTES: readonly number[];   // [36, 41, 48, 53, 60, 65, 72, 77, 84, 89, 96]
export interface SplitBoundary { readonly point: 'Low' | 'Mid' | 'High'; readonly note: number; readonly width: 0 | 6 | 12 }
export function splitBoundaries(values: ValueReader): readonly SplitBoundary[]; // enabled points, sorted; [] when split is off
export function zoneMask(values: ValueReader, kbZoneKey: Ns4Key): number;      // bit z−1 = zone z; no label → 0b1111
export function zoneGain(boundaries: readonly SplitBoundary[], mask: number, key: number): number; // 13.4 steps 2–4
export function transposeSemitones(values: ValueReader): number;
export const routeNote: RouteNote;
export function isRouterKey(key: Ns4Key): boolean;   // the router-owned keys of 13.1
export class Router {
  constructor(values: ValueReader, engines: SectionEngines);
  handle(e: PlayEvent): void;
  applyChanges(batch: readonly Change[]): void;
  panic(): void;
  reload(): void;
  get activeCount(): number;
  dispose(): void;
}
```

Router behaviour:

- noteOn(key, velocity): `routeNote`; with note null or no routes nothing is sent and nothing remembered. If the key is already held, its noteOff goes out first; if another held key has the same sounding note (a transpose edit in between), that key's noteOff goes out first. Then one `RoutedNoteOn` per route to its engine, and key → { note, sections } is remembered.
- noteOff(key): a `RoutedNoteOff` with the remembered note to the remembered sections; the key is forgotten. Unknown keys: nothing.
- sustain, bend, controller: to every engine. panic: forget all keys, `panic()` on every engine.
- applyChanges(batch): to every engine; a load or init batch first forgets all held keys.
- reload(): forget held keys, `reload()` on every engine. activeCount: the engines' sum. dispose: every engine's dispose.
- No Web Audio: `router.test.ts` drives it with fake engines.

#### Synth engine adaptation (B3, `audio/engine.ts`)

1. `class SynthEngine implements SectionEngine<'synth'>` with `readonly section = 'synth'`.
2. Constructor `(ctx, values, allocator = new VoiceAllocator(), out?: AudioNode)`. With `out`, the layer pans connect to it and the engine builds no master and no limiter (`dispose` leaves the shared master alone). Without `out` it keeps today's behaviour, so existing tests run unchanged. Export `synthFactory: SectionFactory<'synth'> = (c) => new SynthEngine(c.ctx, c.values, undefined, c.out)`.
3. `handle(e)`: a `RoutedNoteOn` keeps the hits whose layer has no `silentReason`, calls `allocator.noteOn(e.note, e.velocity, hits.map((h) => voicing(values, h.layer)))`, and for each `start` command puts a per-voice `GainNode` at the hit's gain between the voice and the layer bus (`new Voice(ctx, { ...taps, bus: xfade }, …)`; disconnected in `onEnded` and on kill). A `RoutedNoteOff` calls `allocator.noteOff(e.note)`. Sustain, bend and controller as today. B3 may keep accepting a plain `PlayEvent` noteOn (every enabled layer at gain 1) for the existing tests.
4. `mapping.ts`: `enabledLayers(values)` returns `enabledLayers(values, 'synth')` of `model/scene.ts` (active scene); `silentLayers` follows. The engine no longer reads section or layer switches at note-on: the router chose the layers.
5. `bindings.ts`: `bindingOf` resolves scene keys through `sceneTwin`; add `synth{L}.kbZone` (router-owned, no-op, next note) because B4 makes it `live`; nothing for `common.layerScene` (program region).
6. Master: the headroom gain and limiter move to `audio/master.ts`: `export class MasterBus { constructor(ctx: BaseAudioContext); readonly input: AudioNode; dispose(): void }` (−12 dB, the same compressor settings), one per context, shared by the three engines.
7. A mono or legato retarget keeps the gain of the voice's first note.

#### main.ts wiring (B3)

```
audio running → master = new MasterBus(ctx); c = { ctx, values: store, out: master.input }
              → router = new Router(store, { organ: organFactory(c), piano: pianoFactory(c), synth: synthFactory(c) })
              → gate.flush() → router.handle
bus → merge → gate → router.handle (instead of engine.handle)
store.onChange → router.applyChanges(batch); coarse markers and silent-layer notes as today, with the
                 synth focus read through activeKey(store, 'synth.layerFocusSyn')
after mountSynthPanel: const regions = panel.mountRegions((key) => display.show(key))
dev handle __ns4Editor: router (and the synth engine for console checks)
```

`organFactory` (`audio/organ/engine.ts`) and `pianoFactory` (`audio/piano/engine.ts`) exist from phase 1 as silent stubs with these names; B1 and B2 replace the bodies.

### 13.6 UI and model (B4)

Visuals follow docs/web-design.md, "Editor: program, organ and piano regions". What the other builders rely on:

- `PanelApi.mountRegions(onTouch: OnTouch): RegionsApi` with `RegionsApi = { controls: readonly Bound[]; dispose(): void }` (a stub since phase 1): mounts the program, organ (with rotary) and piano controls; main.ts calls it once, after the synth panel.
- Panels read and write scene fields through `model/scene.ts` (`activeKey`, `focusedLayer`, `layerToggle`, `focusEntry`, `sectionEntry`), never through `_I` literals; `synth-panel.ts` and the synth layer toggle become scene-aware as well.
- Placement: every `_I` scene key stays in its section's region (`common.sectionEnableSyn_I` in synth, the organ and piano ones in organ and piano), because `bindings.test.ts` requires every synth binding to name a synth-region field. The program panel's section keys are extra controls bound to those keys, not a new placement.
- Actions (`model/actions.ts`): `setSectionEnabled(store, section, on)` (13.4), a section-aware `setLayerEnabled` (the synth calls keep working), `setPianoModel`, `setPianoType` (13.3), the split point rule of 13.4 if the orchestrator takes it.
- Curated labels for fields without a table, all from the tables above: organ and piano layer masks (A = 1, B = 2) and focus (A, B); drawbars 0–8 (continuous with manual labels, so the value itself carries no "nv"); `organ.vibratoTypeB3`, `…Vox`, `…Farfisa`; `organ.polyPercEnable`; `organ.leslieMicDistance` (normal, close); `piano{X}.variation`; `piano{X}.acoustic` (mask: string res 1, soft release 2); `dynComp` and `unison` (off, 1, 2, 3); `piano{X}.eq` by type (labels that depend on `piano{X}.bank`: a small extension of `Curated` and `optionsFor`, B4's design, with the bank in the descriptor's `deps` so the control refreshes); `common.masterClockKbdSync` (off, on, soft); the master clock rate shown as BPM.
- Every sound-affecting organ and piano control carries the approximation marker; region legends as the design says; "show values" stays only for read-only fields (preset refs, aux kb, output, extern, effects).
- `formats/ns4p-import.ts` notes: organ and piano play as approximations (no Nord samples); scene II plays when active; split plays with zones and crossfade (approximated); organ or piano layer effects switched on are listed as not implemented; the synth notes stay.
- `formats/report.ts` changes only if the region order changes. Markers follow the statuses, so `web/test/editor/fixtures/report-expected.txt` is regenerated on purpose.

### 13.7 Tests

Node test runner, erasable TypeScript, no DOM, no Web Audio. Engine tests use `web/test/editor/fake-audio.ts` (phase 1, shared and frozen): `FakeContext` with every node type this plan uses, connection and automation records, `advance(t)` firing `onended`, `installAudioGlobals()`. A test that needs more subclasses it in its own file.

| builder | tests | must cover |
| --- | --- | --- |
| B1 | new `organ*.test.ts` | drawbar level curve; tonewheel index with foldback; per-model drawbars (B3 Bass db1/db2, Farf ≥ 5, Vox db9 mix); percussion single trigger vs poly, harmonic, 1′ mute; scanner depth per type; rotary speed targets and stop; on the fake: note on/off frees, panic → 0, sustain, the 128 guard, a drawbar change reaches sounding voices; coverage: every `live`/`unverified` descriptor in region organ (or rotary) has an organ binding |
| B2 | new `piano*.test.ts` | touch curves monotonic, heavy < med < light at mid velocity; dyn comp raises the floor; timbre per type; every recipe finite for MIDI 21–108; release rules (no damper from 89, soft release, clav ignores it); unison copies; on the fake: 120-voice cap, re-strike, pedal, panic → 0; coverage as B1 for region piano |
| B3 | new `router*.test.ts`; keeps `engine.test.ts`, `bindings.test.ts`, `mapping.test.ts`, `gate.test.ts`, `voice-alloc.test.ts` green | zone masks from the labels for every split configuration; crossfade gains at b − w, b, b + w; runs across a disabled point; split off; transpose and noteOff after a transpose edit; colliding sounding notes; scene switch while holding; routing per section with fake engines; the synth's per-voice xfade gain; coverage: every `live`/`unverified` program-region descriptor passes `isRouterKey` |
| B4 | updates `sections`, `descriptors`, `controls`, `ns4p-import`, `report` tests and the report fixture; new `regions*.test.ts` | statuses as in 13.2–13.4; scene twins' descriptors; rebind across scenes; labels of every curated organ, piano and program field; the piano model options (295, by type); `setSectionEnabled`, `setPianoModel`, `setPianoType` |

Coverage tests run one way (live descriptors ⊆ bindings), so each builder's tests pass with or without the other builders' work.

Checks at the end of every task: `cd web && npm test && npm run typecheck && npm run build`; `python3 -I -m unittest discover -s tests -t .`.

### 13.8 Work split

Phase 1 wrote and froze `audio/section.ts`, `model/scene.ts`, `model/pianos.ts`, `web/test/editor/fake-audio.ts`, the tests `scene.test.ts`, `catalog.test.ts` and `fake-audio.test.ts`, and the engine-tables allowance in `imports.test.ts`. It also left three stubs whose bodies belong to builders: `audio/organ/engine.ts` (B1), `audio/piano/engine.ts` (B2) and `PanelApi.mountRegions` in `ui/panel.ts` (B4). A builder who needs a change to a frozen file asks the orchestrator.

| builder | owns (no other builder edits these files) |
| --- | --- |
| B1 organ engine | `web/src/editor/audio/organ/*` (replaces the stub body of `engine.ts`, keeps `OrganEngine` and `organFactory`); `web/test/editor/organ*.test.ts` |
| B2 piano engine | `web/src/editor/audio/piano/*` (replaces the stub body of `engine.ts`, keeps `PianoEngine` and `pianoFactory`); `web/test/editor/piano*.test.ts` |
| B3 program, router, synth integration, audio wiring | `web/src/editor/audio/router.ts`, `audio/master.ts` (new), `audio/engine.ts`, `audio/mapping.ts`, `audio/bindings.ts`, and only if needed `audio/voice.ts`, `audio/voice-alloc.ts`, `audio/gate.ts`; `web/src/editor/main.ts`; `web/test/editor/router*.test.ts`, `engine.test.ts`, `bindings.test.ts`, `mapping.test.ts`, `gate.test.ts`, `voice-alloc.test.ts` |
| B4 UI and model statuses | `web/src/editor/ui/*` (new `organ-panel.ts`, `piano-panel.ts`, `program-panel.ts`; `panel.ts` including the body of `mountRegions`, `synth-panel.ts`, `controls.ts`, `control-model.ts`, `display.ts`, `page.ts`), `web/src/editor/editor.css`, `model/curated.ts`, `model/sections.ts`, `model/descriptors.ts`, `model/actions.ts`, `formats/ns4p-import.ts`, `formats/report.ts` (only if needed); the tests `sections`, `descriptors`, `controls`, `ns4p-import`, `report` with `fixtures/report-expected.txt`, new `regions*.test.ts` |

Nobody changes `web/src/engine/**`, `web/src/main.ts`, `web/src/state.ts`, `web/vercel.json`, `package.json` or private files. B1, B2 and B4 need only phase 1; B3 compiles against the stubs and `mountRegions`. Builders can run in any order; the orchestrator merges and runs the checks once more.

### 13.9 Risks and open points

- Every organ and piano timbre is invented: the tables give names and switches, not sounds. Markers and region legends say so.
- Guessed orders and bits: organ and piano layer masks, `piano{X}.acoustic` bits, vibrato type orders (the converter's), timbre orders, Clav pickup = `variation`, Vox footages, B3 Bass drawbar positions, the split note in the upper zone, the type of each piano name.
- CPU: 91 tonewheels, a 120-voice piano and 46 synth voices can overload phones; the levers are the piano partial budget, lazy tonewheels and the existing caps.
- Scene and section switches while notes sound are assumed not to cut them.
- The model select writes `bank` and `entry` with the name; if Nord Sound Manager or the Stage 4 expect other entries, an exported file may show "Piano not found" (p.24). The export stays experimental.
- No key for `common.splitEnabled` in the design (13.4 proposal).
- Balance between sections is set by ear; the master limiter catches overs.

### 13.10 Status (2026-11-03, after the integration)

The four builders' parts form one working whole; `main.ts` wires them as in 13.5 with no further interface change.

- **B1 organ** (`audio/organ/*`): six models, drawbars, percussion, vibrato and chorus, rotary speaker, sustain, pitch stick, panic, the 128-voice guard; bindings for every live and unverified organ and rotary field, `organ{X}.kbZone` as a router no-op.
- **B2 piano** (`audio/piano/*`): 13 recipe families across the six types, touch, dyn comp, unison, timbre, string resonance, soft release, pedal noise, 120 voices with stealing; `piano{X}.kbZone` as a router no-op.
- **B3 router and wiring** (`audio/router.ts`, `audio/master.ts`, `audio/engine.ts`, `audio/mapping.ts`, `audio/bindings.ts`, `main.ts`): one `MasterBus` and one `Router` per context; the bus, panic (key, Esc, CC120/123, load, hide) and store changes reach every engine through the router. HeldNotes and the keyboard view are unchanged.
- **B4 UI and model**: program, organ (with rotary) and piano regions bound to the store, scene- and focus-aware rebinding, the `≈` marker on sound-shaping organ and piano controls; statuses as in 13.1–13.4 (program 10 live, 3 unverified; organ 41 live, 10 unverified; piano 17 live, 14 unverified), so every coverage test of 13.7 now bites.
- **Integration**: the dev handle `__ns4Editor` exposes `engines` (`organ`, `piano`, `synth`) next to `router` and `engine`; README "Editor" and the page's "how" and "limits" copy describe the three playable sections, no Nord samples.

Checks: `npm test` 413/413, `npm run typecheck` clean, `npm run build` OK, Python suite 113 OK. Browser (vite dev, Chrome-based pane, audio running at 48 kHz): organ alone in scene I → organ `activeCount` 1; piano alone → piano 1; low split at C4 with organ A on zone 1 and synth A on the upper zones → key 48 organ only, key 72 synth only, ±6 crossfade → key 60 both; init scene I plays the synth, scene II the piano; with all three sections sounding (organ 2, piano 3, synth 2) panic and Esc leave every engine at 0; no console errors, no sideways scroll at 1280 px.

Builder deviations kept (see their notes in the code): the organ router gain is the peak of each voice's gate instead of a separate gain node; tonewheels never stop once created; a sounding organ voice keeps its model; piano pedal noise only on layers on in the active scene; a key pressed again without its note off releases the earlier note first, even when the new press routes nowhere.

Open for the orchestrator:

- The split point keys also set `common.splitEnabled` to "any point on" (the 13.4 proposal, implemented by B4; reverting is one function in `model/actions.ts`).
- The init program has the mid split point on at C4 with the split off; nothing stops a user from setting the low (or high) point to the same note, and then the points coincide and a layer's zones 2 and 3 meet at one note. The router handles it as specified; whether the Stage 4 allows equal positions is unknown.
- `≈`, `⅓`, `⅔` and `⅗` fall back to a system font (not in the bundled subsets); several program and piano labels truncate at desktop width (`low po…`, `n…`).
- Every organ and piano timbre and every "guess" of 13.2–13.4 is still unheard by ear; balance between sections is unset.
