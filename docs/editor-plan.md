# Nord Stage 4 editor: architecture and implementation plan

For the brief `.claude/briefs/nord-stage4-editor-mvp.md` (approved 2026-11-03), based on `docs/editor-feasibility.md` (Phase 1). Status: plan, nothing built. Section 9 lists the five questions for the user; everything else is a proposal the orchestrator can change.

Notation: `{L}` is a synth layer `A`, `B` or `C`; `synth{L}Sound.fltFreq` means the three keys `synthASound.fltFreq`, `synthBSound.fltFreq`, `synthCSound.fltFreq`. "M p.N" is the manual page as cited in the feasibility doc.

## 0. Page, build and hosting

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
web/editor/index.html                 page shell: landmarks and empty region containers
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
tools/gen_editor_tables.py            Python, reads nordconv/_tables_ns4.py and nordconv/labels.py
tests/test_editor_tables.py           Python: the committed TS module and label golden equal a fresh render
```

### Dependencies (no cycles)

```
main.ts ─► ui ─► model, input, formats, audio (types, status), midi (status)
audio   ─► model, input/events
midi    ─► input/events
input   ─► model/keys (types only)
formats ─► model, ../engine
model   ─► generated, ../engine/layout.ts, ../engine/template.ts (read only)
```

Rules, enforced by `web/test/editor/imports.test.ts` (reads the sources, as `engine.test.ts` already does for the engine): nothing imports `ui/` or `main.ts`; `audio/` and `midi/` never import `ui/`, `formats/` or each other; `model/` and `formats/` import no DOM or Web Audio globals; no `node:` imports; no network APIs. The engine is used read-only: `index.ts` exports (`Ns4Program`, `loadTemplate`, `verify`, `ConversionError`, `NordFormatError`, `OUTPUT_SUFFIX`) plus direct imports of `NS4_LAYOUT` (`layout.ts`), `CATEGORY_NONE`, `TARGET_VERSION` (`template.ts`) and `crc32`, `buildCbin` (`cbin.ts`, tests only). No engine file changes. If only `index.ts` may be imported, re-exporting those names is the ask-first alternative.

### Public APIs

```ts
// model/keys.ts
export type Ns4Key = (typeof NS4_KEYS)[number];          // 955 literal keys, layout order (generated)
export type SynthLayer = 'A' | 'B' | 'C';
export function layerKey<P extends string>(layer: SynthLayer, pattern: P): Ns4Key; // 'synth{L}Sound.fltFreq'
export function isNs4Key(s: string): s is Ns4Key;

// model/labels.ts: port of nordconv/labels.py ns4_label
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
  "app": "nordconvert editor 0.1.0",
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
program: Warm Pad · nordconvert editor 0.1.0 · 2026-11-03
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
| program | Program (M p.38–45) | layout | layer scene, split, transpose, master clock, morph assign, preset refs, Aux KB and output bus fields |
| organ | Organ (M p.18–22) | layout | models, drawbars, vibrato/percussion, levels |
| piano | Piano (M p.23–26) | layout | type, model, touch, levels |
| synth | Synth (M p.27–37) | live | layer strip (enable A/B/C, focus, level, pan); groups osc, filter, amp, LFO, vibrato, voice, keyboard, arp |
| extern | Extern (M p.46–47) | layout | per-layer extern fields |
| effects | Layer Effects (M p.48–53) | layout | FX of organ, piano A/B, synth A/B/C, focus, globals |
| rotary | Rotary (M p.53) | layout | rotary fields from `organ.*` |
| keyboard | – | live | virtual keyboard, octave readout, computer-key legend |
| print-out | – | live | import notes, validation errors, export result |
| footer | – | live | approximation, AGPL, not affiliated with Clavia or Nord |

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

Skip links (to synth, to keyboard) → header → status strip (start audio, enable MIDI, panic) → name and file keys → synth layer strip → oscillator → filter → amp → LFO → vibrato → voice → keyboard group → arp → keyboard region (one focusable element whose label explains the computer keys) → print-out. Computer keys play while focus is not in a text field or `<select>` and no Cmd/Ctrl/Alt is held; range inputs ignore letters, so the two coexist.

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
6. Visual direction: the checkpoint-1 mockup, specified in `docs/web-design.md`, section "Editor (/nordconvert/editor)".
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
- Still open: wiring `onLoad` in `main.ts` (to stop notes on a load), the preview deployment checks of section 0, and the reviews of E5.
