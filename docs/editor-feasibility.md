# Nord Stage 4 editor: feasibility (Phase 1)

Research for the brief `.claude/briefs/nord-stage4-editor-mvp.md`, 2026-11-03. Primary source: the official Nord Stage 4 User Manual, English, v1.6X Edition N (OS 1.6x); page numbers below are its PDF pages. Repository facts come from the decoded layout this repo already ships (then `nordconv/_layout_ns4.py` and `nordconv/_tables_ns4.py`, now `tools/ns4data/`, mirrored in `web/src/ns4/generated/`). Nothing here has been tested on a Stage 4.

> **Pivot to nord (2026-11-04).** The Stage 3 → Stage 4 converter is retired (Nord Sound Manager converts Stage 3 programs natively since v9.10) and the editor is the whole site, served at https://www.thilkolimbeck.com/nord (Vite base `/nord/`) from `web/index.html`. Paths moved: `web/editor/index.html` → `web/index.html`; `web/src/engine/` → `web/src/ns4/` (Stage 4 code only; `verify` from `convert.ts` is now `verify.ts`); `nordconv/_layout_ns4.py`, `_tables_ns4.py` and `labels.py` → `tools/ns4data/`. What this document says about the converter (its page `web/index.html`, `web/src/main.ts`, `web/src/state.ts`, `web/src/styles.css`, the `nordconv` package, `docs/phase1-mapping.md`, the `/nordconvert` URLs and the dev rewrite, `web/test/golden/golden.json`, `parity.test.ts`, `engine.test.ts`, `state.test.ts`) is historical; those files are in the git history up to commit `babed27`. The .ns4p import and export tests now read a generated corpus (`web/test/editor/corpus.ts`) instead of the converter's golden outputs, and `tokens.test.ts` checks `editor.css` alone.

Status values: **verified** (an official document or the repo states it), **approximated** (buildable, but the behaviour is our own guess), **unclear** (no source settles it), **not possible** (blocked by format, protocol, rights or scope).

Source codes used in the tables: **M** manual v1.6X Ed. N (page), **S** specifications page, **P** product page, **D** downloads page, **NSM** Nord Sound Manager page, **LIB** Nord sound-library pages, **W1** caniuse, **W2** MDN, **W3** Chrome developer blog, **R** this repository (file), **B** the brief. Full URLs in section 2.

## 0. Key findings

1. The manual's Appendix II (M p.68–69) is an official CC/NRPN list: about 95 entries on plain CCs (bank select, pedals, nine drawbars included) and 49 on NRPN (CC99 MSB, CC98 LSB, CC6 = 0, CC38 value); the synth section has 39 CC and 21 NRPN entries. It is identical in Editions L (OS 1.4x) and N (OS 1.6x). It gives no value scaling, no NRPN value tables for enums, and no rule for which synth layer a CC addresses. Panel CC/NRPN send/receive is Off by default (M p.62).
2. SysEx is not mentioned anywhere in the 76-page manual; there is no MIDI implementation chart and no program dump or request protocol. Transfer of programs runs only through Nord Sound Manager over its own USB protocol (M p.64).
3. A whole program cannot be sent over MIDI: many stored settings (osc env amount, filter on/off, KB zones, split points, morphs, arp patterns, extern settings) have no documented controller. The `.ns4p` file is the only complete carrier.
4. Web MIDI: Chrome 43+, Edge 79+, Opera 30+, Firefox 108+, Chrome Android 156+; Safari (macOS and iOS) has none. Chrome 124+ and Firefox ask for permission for any MIDI access.
5. The layout holds 955 fields per program: 598 parameters and 357 morph amounts. 404 parameters have a display table (units, labels). 621 of 6,592 body bits (9.4 %) lie outside every field and the block framing, so export must patch a donor file.
6. Synth inventory (one layer plus the synth common block, 132 parameter fields): the MVP engine can drive 65 directly (**yes**), 41 approximately (**partly**: no display table, or behaviour only described in words), 26 not (**no**). 24 of the 26 are out of MVP scope by design (15 extern, 5 sample-only, 3 reserved, 1 aux keyboard); only 2 sound fields (arp pattern duration and pan bit fields) are undecoded. The 72 synth morph fields are **partly** (stored, applied as linear deltas, semantics unverified).
7. Stage 4 oscillator naming differs from the brief's list: modes are Samples, Analog and Extern; Analog has four types, Analog (Pure, Sub Osc, Sync, Shape, Shape Sine, Multi, Super, Misc), FM-H, FM-I and Wave. "Classic" and "Formant" are Stage 3 terms with no Stage 4 counterpart.
8. Nord sample and piano licence terms were not found on nordkeyboards.com; the libraries are "free to all Nord users" and include "exclusively licenced" Mellotron/Chamberlin material. Status: unclear; the editor must not load or bundle them (already a non-goal).

## 1. Feasibility matrix

### 1a. Visual and functional replica of the panel

| area | feature | status | source | limitation | alternative |
| --- | --- | --- | --- | --- | --- |
| a. panel | Sections: Organ (layers A/B), Piano (layers A/B), Synth (layers A/B/C, OLED display), Program section, Layer Effects (own set per piano and synth layer, one shared set for both organ layers), Rotary Speaker, Extern as a synth layer mode | verified | M p.7, 9, 48; S; R `_layout_ns4.py` (24 blocks) | – | – |
| a. panel | Layer Scenes I/II, section on/off, layer on/off and focus | verified | M p.15, 43; R `common.sectionEnable*_I/_II`, `*.layerEnable*`, `*.layerFocus*` | layer-enable bit order comes from the converter, not from hardware | – |
| a. panel | Synth controls and display pages: Waveform (Type/Cat/Wave or Cat/Sample dials), Osc Ctrl, Pitch/Smp, three envelopes, Filter Type/KBD Trk/Drive, LFO, Voice, Arp/Gate with 5-page menu, Vibrato menu, KB Hold, Group, Sound Init | verified | M p.27–37 | OLED rendering and dial behaviour not documented | own display in the existing design language |
| a. panel | Ranges, units, defaults per control | verified for 404 of 598 parameter fields; unclear for 194 | R `_tables_ns4.py` (FIELD_VALUE_TABLE, FIELD_DEP); M | no display table for e.g. `fltRes`, `lfoRateClkDiv`, `lfoAmt`, `arpRateClkDiv`, `dlyRateClkDiv`, `fx1RateClkDiv`, `voiceMode`, `oscUnison`, `ampEnvVel`, `fltDrive`, layer pan | raw value, or the manual's step names (drive off/1/2/3), marked "not verified" |
| a. panel | Morph assignment (wheel, aftertouch, control pedal) | verified (destinations); approximated (meaning of the stored value) | M p.38; R 357 `*.morph*` fields | morph value assumed to be a signed delta in raw steps; the layout has morphs for `oscEnvAmt`, `fltEnvAmt`, `arpRange`, `fx2Rate` that the manual's destination list omits | edit as a signed delta, marked "not verified" |
| a. panel | Organ panel: models B3, Vox, Farf, Pipe 1, Pipe 2, B3 Bass; 9 drawbars; percussion; vibrato/chorus; Drawbar Live; rotary | verified (names) | M p.18–22, 53; R organ blocks | MVP: layout only; no layout key found for Drawbar Live | – |
| a. panel | Piano panel: type, model, variation, KB Touch, Dyn Comp, Acoustics, Soft Release, String Res, Pedal Noise, Timbre, Unison, Clav settings | verified (names); unclear (key mapping of Soft Release, String Res, Timbre) | M p.23–26; R `pianoA.*` (`acoustic`, `eq` unconfirmed) | MVP: layout only; 295 piano names known | – |
| a. panel | Preset Library (organ 2×64, piano 2×64, synth 8×64) | verified (exists); not possible (content) | M p.41; S | presets are Nord content; a program stores only position, name hash and layer count (`common.*Preset*`) | app presets in the editor |
| a. panel | Program memory (8 banks × 8 pages × 8, 8 Live programs), Store, Organize | verified | M p.40–45; S | bank and location live in the file header; the writer uses bank 0, location 0 | not modelled; Nord Sound Manager places the file |
| a. panel | Menus System, Sound, Aux KB, Output, Pedal, MIDI, Extern | verified (pages) | M p.57–63 | a program holds panel settings plus the Aux KB and Extern menus (M p.38); the other menus are instrument settings; per-program output bus = `common.audioRoutingBus*` | see section 4.2 |
| a. panel | Nord visual identity (red panel, logo, artwork, typeface) | not possible | M p.2; R `docs/web-design.md`; B non-goals | trademark and trade dress | own instrument-panel language (signal orange, Doto display, mono legends) |

### 1b. Own browser sound generation

| area | feature | status | source | limitation | alternative |
| --- | --- | --- | --- | --- | --- |
| b. sound | Analog type: Pure (7 waves), Sub Osc (3), Sync (9), Shape (5), Shape Sine (7), Multi (6), Super (5), Misc (3: pink, red noise, bell) | approximated | M p.29–30; R dep tables `561-8`, `562-4` (45 waves named) | Osc Ctrl effect described only in words; sync, shape, PWM, Super need sample-accurate DSP | AudioWorklet oscillators (band-limited); native OscillatorNode/PeriodicWave for static Pure waves |
| b. sound | "Classic", "Formant" oscillators | not possible (not on Stage 4) | M p.28–30 | Stage 3 terms | use Stage 4 types |
| b. sound | FM-H / FM-I algorithms A–E (2-, 3- and 4-operator, ratios P:1, P:1:1, P:3:1, two pairs) | approximated; unclear (raw values) | M p.30; R `561-8`, `562-4` | repo names FM categories A–H; FM-H partials not decoded (only "0.5"); manual: partials 0.5–24, pitch −12…+48 | build the 5 documented algorithms; undecoded raw values flagged |
| b. sound | Wave type (digital waveforms) | not possible (replica) | M p.30; R (5 of 128 Wave categories named) | proprietary waveforms | placeholder wavetable marked "not verified" |
| b. sound | Samples mode (Nord Sample Library 4, 1 GB) | not possible | M p.28; D (`.nsmp4`); B non-goal | proprietary samples, licence unclear | own audio import as a follow-up |
| b. sound | Filters LP12, LP24, LP M (transistor ladder), LP+HP (12 dB parallel, Res sets HP cutoff), BP and HP (12 dB); KBD Trk off/⅓/⅔/1; Drive off/1/2/3 | approximated | M p.9, 31–32; R `587-3`, `587-6` (14 Hz–32 kHz), `595-4`; S | resonance curve, self-oscillation, drive and ladder character unknown; spec page says "LP+BP", manual and layout say LP+HP | BiquadFilterNode (cascaded for 24 dB); ladder and drive in an AudioWorklet |
| b. sound | Envelopes (osc, filter, amp): attack, decay, release; decay at max = sustain; velocity | verified (times); approximated (curves, velocity depth) | M p.33–34; R ms tables `568-8`…`601-5` | segment shapes unknown; amp velocity has 4 steps of unknown depth | exponential AudioParam ramps |
| b. sound | LFO: triangle, saw, inverted saw, square, S/H; target osc ctrl, pitch or filter; Mst Clk sync | approximated | M p.34; R `576-2`, `575-8` | rate (Hz) and amount tables not in the repo (opennord dependency table `576-6` not ported) | plausible curve marked "not verified"; port `576-6` later (generator change, ask first) |
| b. sound | Arp/Gate: Arp, Poly, Gate; direction; zigzag; range/env; KB sync; Mst Clk; patterns 2–16 steps with accent, pan, gate edits | approximated; unclear (rate, range, patterns) | M p.35–36; R `synthA.arp*` | rate→BPM and range scale undecoded (README: range scale unknown); no field for the pattern preset; 32-bit pattern fields not decoded | lookahead scheduler; patterns shown as "not verified" |
| b. sound | Voice: poly, mono, legato; Lo/Hi priority; constant-rate glide; Unison 1–3; synth polyphony 46 voices | approximated | M p.35; S; R `voiceMode`, `voicePrio`, `glideRate`, `oscUnison` | glide time and unison detune unknown | voice manager capped at 46 |
| b. sound | Vibrato On/Dly/Whl/A.T./Ped; rate 2–8 Hz; amount 0–10; delay time | approximated; unclear (delay) | M p.37; R `416-1`, `602-6`, `603-5`, `453-5` | delay table 0.1–3.0 s in 30 steps, manual names only 0.2/0.7/1.2/2.0 s; depth units unknown | use the table, flag the conflict |
| b. sound | Layer effects: Mod 1 (A-Pan, Trem, RM, A-Wah, Wah, Pump), Mod 2 (Phaser, Flanger, Vibe, Chorus, Ensemble, Spin), Delay (ping-pong, feedback filter LP/HP/BP, analog mode, feedback effects), Amp Sim/EQ (Twin, JC, Small, LP24/HP24, drive, EQ 100 Hz / 200 Hz–8 kHz / 4 kHz ±15 dB), Compressor (fast), Reverb (Spring, Booth, Room, Stage, Hall, Cathedral; variation/chorale; dark/bright) | approximated | M p.48–53; S; R `synthAFx.*` | Nord impulse responses, amp/cabinet models and rate curves unknown; no confirmed field for amp-filter cutoff/resonance/dry-wet | Web Audio delay, all-pass, convolver with generated IRs, DynamicsCompressor |
| b. sound | Rotary speaker | not in MVP | M p.53 | belongs to the organ path | follow-up |
| b. sound | Organ engine (B3 tonewheels, Vox, Farfisa, pipes, B3 Bass) | not in MVP; approximated later | M p.18–22; B | – | additive drawbar model as a follow-up |
| b. sound | Piano engine (Nord Piano Library, 2 GB) | not possible (replica) | S; D (`.npno`) | proprietary sampled pianos | none in MVP |
| b. sound | Morph sources wheel, aftertouch, control pedal | approximated | M p.38 | depth semantics unverified | MIDI CC1, channel pressure, CC11, on-screen controls |
| b. sound | Platform: Web Audio and AudioWorklet under the site CSP | verified | R `web/vercel.json` (`script-src 'self'`) | worklet module must be a same-origin file (no `blob:`); AudioContext starts only after a user gesture | – |

### 1c. Controlling a connected Stage 4 (Web MIDI)

| area | feature | status | source | limitation | alternative |
| --- | --- | --- | --- | --- | --- |
| c. control | Note on/off, velocity (release velocity sent, ignored on input), pitch bend, aftertouch (channel pressure) | verified | M p.56 | organ ignores incoming velocity | – |
| c. control | Pedals: CC64 sustain, CC66 sostenuto, CC67 soft, CC11 control pedal, CC4 organ swell; CC7 volume | verified | M p.56, 68 | – | – |
| c. control | Panel parameters via CC (~95 entries) and NRPN (49) on the Global channel; synth: 39 CC, 21 NRPN | verified (list) | M p.62, 68–69 | MIDI menu: CTRL default Off, Type default "CC & NRPN"; no value scaling; no NRPN value tables (e.g. Filter Type 3:51, Waveform 3:2, Sample 3:4:x:x); layer addressing (focus vs layer channel) not documented | use only documented numbers; check scaling on hardware first |
| c. control | Complete program over CC/NRPN | not possible | M p.68–69 | no controller for osc env amount, filter on/off, KB zones, split points, morphs, arp patterns, pitch stick range, sample options, extern settings | `.ns4p` via Nord Sound Manager |
| c. control | Program change with bank select: Programs MSB 0 / LSB 0–3; Live MSB 1; Synth presets MSB 2 / LSB 0–3; Piano presets MSB 3; Organ presets MSB 4 | verified | M p.56, 62 | PC send/receive set in the MIDI menu | – |
| c. control | SysEx (dump, request, identity) | not possible (undocumented) | M (no mention); NSM | Nord Sound Manager uses an undocumented USB protocol | none; Nord Sound Manager |
| c. control | MIDI clock input (master clock follows external clock) | verified | M p.40, 55 | – | the editor may follow incoming clock later (not MVP) |
| c. control | Web MIDI support: Chrome 43+, Edge 79+, Opera 30+, Firefox 108+, Chrome Android 156+; Safari macOS/iOS none (third-party extension only) | verified | W1, W3 | permission prompt for all MIDI access (Chrome 124+, Firefox); secure context only; SysEx needs a separate grant | clear status text; on-screen and computer keyboard work everywhere |
| c. control | `midi` Permissions-Policy on the deployed site | verified (repo); unclear (proxy) | R `web/vercel.json`; W2 | the header does not list `midi`, so the default (same origin) applies; the portfolio proxy's response headers were not checked | check the live response in Phase 2 |
| c. control | Sending to the instrument (CC, NRPN, PC) | not in scope | B ("never send data to hardware") | – | parameter report for manual entry |
| c. control | USB MIDI on Windows without the Nord driver | unclear | M p.64; S | class compliance not stated | 5-pin DIN through an interface |

### 1d. Import and export of hardware-compatible files

| area | feature | status | source | limitation | alternative |
| --- | --- | --- | --- | --- | --- |
| d. files | `.ns4p` container: 44-byte CBIN header, CRC-32, body = u32 version + 24 length-prefixed blocks, 824 bytes | verified (decoded) | R `docs/phase1-mapping.md` (historical), `nordconv/cbin.py`, `nordconv/program.py` (now `web/src/ns4/cbin.ts`, `program.ts`) | – | – |
| d. files | Field map: 955 fields (598 parameters, 357 morphs), all "high" confidence in the source | verified (decoded) | R `_layout_ns4.py` (opennord ed66f7f, Stage 4 OS 1.66 registry) | 621 of 6,592 body bits (9.4 %) unknown; 99 of 824 bytes hold an unknown bit (brief and README quote 16–20 % / "a fifth" from earlier byte estimates) | writer keeps unknown bits from a donor |
| d. files | Import `.ns4p` (formats 3.07–3.13) | verified (parser) | R `Ns4Program.fromBytes`; `web/test/golden/golden.json` (584 public outputs, historical; now the corpus of `web/test/editor/corpus.ts`); `templates/regressionTest.ns4p` | golden files were converter outputs, not hardware saves; formats above 3.13 refused | clear error with the version found |
| d. files | Export `.ns4p` (experimental) | unclear (no hardware test) | R `Ns4Program.set`, `toBytes`, `verify()`; B | `verify()` proves re-parse, field values and untouched unknown bits, not acceptance by the instrument; 3 Nord Sound Manager conversions confirm 94 % of non-default fields (B); `verify()` expects header bank 0, location 0 | label "experimental, untested on hardware"; parameter report as fallback |
| d. files | Export donor | approximated | R `templates/regressionTest.ns4p` (MIT), `neutralise()` | unknown bits come from the donor: neutral template or the imported file | open question 2 |
| d. files | Program name | verified | R `docs/phase1-mapping.md` (historical) | name is the file name, not stored in the file | export file name = program name |
| d. files | Transfer to the instrument | verified (Nord Sound Manager only) | M p.64; NSM | the browser cannot write to the instrument | user drops the file into Nord Sound Manager |
| d. files | Samples `.nsmp4` (Nord Sound Manager converts `.nsmp3` and user `.nsmp`) | not possible (format undecoded) | D; NSM; M p.65 (Nord Sample Editor 4 builds samples from WAV/AIFF) | proprietary | Nord Sample Editor 4 |
| d. files | Pianos `.npno` | not possible (format undecoded) | D | proprietary | – |
| d. files | Preset files (organ, piano, synth preset downloads) | unclear | D (zips; extensions not stated) | format not examined | app presets |
| d. files | Instrument backup `.ns4b` | not in scope | D | – | – |
| d. files | App preset (own versioned JSON) | verified (feasible) | B | – | schema with all field values; open question 3 |

### 1e. Asset rights

| area | feature | status | source | limitation | alternative |
| --- | --- | --- | --- | --- | --- |
| e. rights | Nord factory samples and pianos | unclear (no licence text found) | LIB ("available for free to all Nord users"; Mellotron/Chamberlin "exclusively licenced") | third-party content inside; no published redistribution terms | never load, bundle or extract (non-goal) |
| e. rights | Factory programs and presets (downloads) | unclear | D | no licence stated | do not bundle; users import their own files |
| e. rights | Nord logo | not possible | M p.2 ("The Nord logo is a trademark of Clavia DMI AB") | trademark | no logo |
| e. rights | "Nord", "Nord Stage" names | verified (descriptive use only) | R README disclaimer | trademarks of Clavia DMI AB | name the target instrument, with "not affiliated" note |
| e. rights | Panel graphics, product photos, manual illustrations | not possible | M p.2 ("Copyright © Clavia DMI AB"); site footer "All rights reserved" | Clavia copyright | own drawings |
| e. rights | Panel typeface | unclear (not identified) | – | – | self-hosted OFL fonts already in `web/public/fonts/` |
| e. rights | Parameter names and value labels | verified (descriptive use) | M; R tables | do not copy manual prose | own short labels |
| e. rights | Repo data: layouts and tables (opennord AGPL-3.0, ns4decode MIT), donor template (MIT) | verified | R `NOTICE`, `LICENSE` | AGPL-3.0 applies to the editor | keep `NOTICE` |

## 2. Sources

Official (Clavia DMI AB, nordkeyboards.com):

- M: Nord Stage 4 User Manual, English, v1.6X Edition N (OS 1.6x, PDF created 2025-11-26): https://www.nordkeyboards.com/wt/documents/951/Nord%20Stage%204%20User%20Manual%20v1.6X-Edition-N.pdf. Cross-checked against v1.4X Edition L (https://www.nordkeyboards.com/wt/documents/744/Nord%20Stage%204%20User%20Manual%20v1.4X%20Edition%20L.pdf): Appendix II is identical; Edition N adds the Pitch and Fine Tune section (±24 semitones, ±50 cents, p.28) and reverb placement in Global mode.
- P: product page: https://www.nordkeyboards.com/products/nord-stage-4
- S: specifications: https://www.nordkeyboards.com/products/nord-stage-4/specifications/
- D: downloads (OS 1.66, factory restore `.ns4b`, piano banks `.npno`, sample banks `.nsmp4`, program and preset zips): https://www.nordkeyboards.com/products/nord-stage-4/downloads/
- NSM: Nord Sound Manager (supports Stage 4 v0.90+, converts Stage 3 programs to `.ns4p`, converts `.nsmp3` and `.nsmp` samples): https://www.nordkeyboards.com/software/nord-sound-manager
- LIB: About Nord Sound Libraries: https://www.nordkeyboards.com/sounds/how-to-get-sounds-to-your-product; Sample Library: https://www.nordkeyboards.com/sounds/sample-library

Web platform:

- W1: https://caniuse.com/midi
- W2: https://developer.mozilla.org/en-US/docs/Web/API/Web_MIDI_API
- W3: https://developer.chrome.com/blog/web-midi-permission-prompt

Repository (at the time; see the pivot note above): `nordconv/_layout_ns4.py`, `nordconv/_tables_ns4.py` (generated from opennord ed66f7f; now `tools/ns4data/`), `nordconv/program.py`, `nordconv/map_engines.py`, `web/src/engine/convert.ts` (`verify`; now `web/src/ns4/verify.ts`), `web/src/engine/index.ts` (now `web/src/ns4/index.ts`), `web/vercel.json`, `README.md`, `docs/phase1-mapping.md`, `NOTICE`.

Not used: norduserforum.com (behind a Cloudflare bot check, not accessed). No licence or EULA text for Nord sounds was found on nordkeyboards.com. No forum claim is relied on.

## 3. Synth parameter inventory

Derived from `_layout_ns4.py` and `_tables_ns4.py`. One layer is listed (A); layers B and C have the same fields in blocks `synthB`/`synthBSound`/`synthBFx` and `synthC`/`synthCSound`/`synthCFx`. "bits · range" is the stored width and the value range; "default" is the layout default (display label in brackets); the table column gives the display table id (ns4decode port id), its name and its end points. Morph fields are summarised after the tables. MVP: **yes** = drives the sound directly with known units; **partly** = drives the sound, but units or behaviour are our guess; **no** = not used by the MVP sound engine (still stored and round-tripped).

### 3.1 Counts

| block | parameter fields | morph fields | with display table |
| --- | --- | --- | --- |
| `synthA` (layer: voice, keyboard, arp, vibrato delay, extern, sample ref) | 44 | 12 | 21 |
| `synthASound` (osc, filter, envelopes, LFO, vibrato) | 36 | 21 | 31 |
| `synthAFx` (layer effects) | 32 | 30 | 29 |
| `synth` (section common: levels, pan, groups, focus) | 20 | 9 | 5 |
| **one layer + common** | **132** | **72** | **86** |
| all three layers + common | 356 | 198 | 248 |

| group | yes | partly | no |
| --- | --- | --- | --- |
| Oscillator | 7 | 6 | 5 |
| Filter | 6 | 5 | 0 |
| Amp envelope | 3 | 1 | 0 |
| LFO and vibrato | 4 | 5 | 0 |
| Arpeggiator | 5 | 6 | 2 |
| Voice and keyboard | 8 | 2 | 0 |
| Extern | 0 | 0 | 15 |
| Effects | 16 | 16 | 0 |
| Synth common | 16 | 0 | 4 |
| **total** | **65** | **41** | **26** |

### 3.2 Fields (layer A and synth common)

#### Oscillator

| key | bits · range | default | display table (raw → label) | MVP | note |
| --- | --- | --- | --- | --- | --- |
| `synthA.mode` | 1 · 0..1 | 1 (analog) | `408-1` samples/analog: 0=samples; 1=analog | partly | analog yes; samples mode needs Nord samples (non-goal) |
| `synthA.libName` | 1 · 0..1 | 0 | – | no | sample library ref, opaque |
| `synthA.smpId` | 16 · 0..16383 | 0 | – | no | sample slot, opaque |
| `synthA.smpNameHash` | 32 · hash | 0 | – | no | sample id; name only if in SAMPLE_NAMES (90 known) |
| `synthASound.oscBank` | 4 · 0..3 | 0 (1 (ANALOG)) | `561-3` analog type (knob 1): 0=1 (ANALOG); 1=2 (FM-H); 2=3 (FM-I); 3=4 (WAVE) | partly | ANALOG yes; FM-H/FM-I partly; WAVE no (proprietary wavetables) |
| `synthASound.oscCat` | 6 · 0..7 | 0 | `561-8` analog cat (knob 2) (depends on oscBank) | partly | analog 8 categories; FM table A–H vs manual A–E; WAVE 5 of 128 named |
| `synthASound.oscWave` | 7 · 0..127 | 2 | `562-4` analog wave/partial (knob 3) (depends on oscBank, oscCat) | partly | 45 analog waves named and documented; FM partial/pitch partly; WAVE no |
| `synthASound.oscCtrl` | 7 · 0..127 | 0 (0.0) | `563-2` osc ctrl: 0=0.0 … 127=10.0 (128 steps) | partly | meaning per category documented, curves unknown; morphs: wheel, AT, pedal |
| `synthASound.oscTuneCoarse` | 6 · -24..24 | 0 (+ 0 semi) | `567-8` pitch coarse: -24=-24 semi … 24=+24 semi (49 steps) | yes | ±24 semitones (manual 1.6x) |
| `synthASound.oscTuneFine` | 7 · -50..50 | 0 (+ 0 cent) | `567-1` pitch fine: -50=-50 cent … 50=+50 cent (101 steps) | yes | ±50 cent (manual 1.6x) |
| `synthASound.oscEnvAtk` | 7 · 0..127 | 0 (0.5 ms) | `568-8` osc env attack: 0=0.5 ms … 127=45 s (128 steps) | yes | ms table |
| `synthASound.oscEnvDcy` | 7 · 0..127 | 59 (1.05 s) | `569-7` osc env decay: 0=3.0 ms … 127=inf (128 steps) | yes | 127 = inf (sustain) |
| `synthASound.oscEnvRls` | 7 · 0..127 | 0 (3.0 ms) | `570-6` osc env release: 0=3.0 ms … 127=45 s (128 steps) | yes | ms table |
| `synthASound.oscEnvAmt` | 7 · -60..60 | 0 (0.0) | `571-5` osc env amt: -60=-10.0 … 60=10.0 (121 steps) | partly | bipolar; depth in semitones / osc ctrl units unknown; morphs: wheel, AT, pedal |
| `synthASound.oscEnvDst` | 1 · 0..1 | 0 (off) | `575-4` osc env-to-pitch on/off: 0=off; 1=on | yes | osc ctrl or pitch |
| `synthASound.oscEnvVel` | 1 · 0..1 | 0 (off) | `575-5` osc env velocity on/off: 0=off; 1=on | yes | on/off; depth curve unknown |
| `synthASound.smpDynamic` | 2 · 0..3 | 0 (NATURAL) | `575-6` sample options: 0=NATURAL; 1=NO DYN; 2=NO DYN & FAST ATK; 3=FAST ATK | no | sample option |
| `synthASound.smpTimbre` | 1 · 0..1 | 0 (off) | `604-3` sample bright on/off: 0=off; 1=on | no | sample Bright |

#### Filter

| key | bits · range | default | display table (raw → label) | MVP | note |
| --- | --- | --- | --- | --- | --- |
| `synthASound.fltEnable` | 1 · 0..1 | 1 (on) | `602-5` filter on/off: 0=off; 1=on | yes | bypass |
| `synthASound.fltType` | 3 · 0..5 | 1 (LP24) | `587-3` filter type: 0=LP12; 1=LP24; 2=LPM; 3=LPHP; 4=BP; 5=HP | partly | LP12/LP24/HP/BP/LP+HP with native biquads; LPM (ladder) approximated |
| `synthASound.fltFreq` | 7 · 0..127 | 127 (32 kHz) | `587-6` filter freq: 0=14 Hz … 127=32 kHz (128 steps) | yes | Hz table, clamp at Nyquist; morphs: wheel, AT, pedal |
| `synthASound.fltRes` | 7 · 0..127 | 0 | – | partly | no table; Q curve and self-oscillation invented; LP+HP: HP cutoff; morphs: wheel, AT, pedal |
| `synthASound.fltKbdTrk` | 2 · 0..3 | 2 (2/3) | `595-4` filter track: 0=off; 1=1/3; 2=2/3; 3=3/3 | yes | off, 1/3, 2/3, 1:1 |
| `synthASound.fltDrive` | 2 · 0..3 | 0 | – | partly | off/1/2/3 (manual); no table; waveshaper guess |
| `synthASound.fltEnvAmt` | 7 · 0..127 | 0 (0.0) | `595-8` filter env amt: 0=0.0 … 127=10.0 (128 steps) | partly | table 0.0–10.0; depth in octaves unknown; morphs: wheel, AT, pedal |
| `synthASound.fltEnvAtk` | 7 · 0..127 | 0 (0.5 ms) | `599-7` filter env attack: 0=0.5 ms … 127=45 s (128 steps) | yes | ms table |
| `synthASound.fltEnvDcy` | 7 · 0..127 | 67 (1.82 s) | `600-6` filter env decay: 0=3.0 ms … 127=inf (128 steps) | yes | 127 = inf |
| `synthASound.fltEnvRls` | 7 · 0..127 | 0 (3.0 ms) | `601-5` filter env release: 0=3.0 ms … 127=45 s (128 steps) | yes | ms table |
| `synthASound.fltEnvVel` | 1 · 0..1 | 0 (off) | `602-4` filter velocity on/off: 0=off; 1=on | partly | on/off; depth unknown |

#### Amp envelope

| key | bits · range | default | display table (raw → label) | MVP | note |
| --- | --- | --- | --- | --- | --- |
| `synthASound.ampEnvAtk` | 7 · 0..127 | 10 (3.0 ms) | `584-4` amp env attack: 0=0.5 ms … 127=45 s (128 steps) | yes | ms table |
| `synthASound.ampEnvDcy` | 7 · 0..127 | 127 (inf) | `585-3` amp env decay: 0=3.0 ms … 127=inf (128 steps) | yes | 127 = inf (sustain) |
| `synthASound.ampEnvRls` | 7 · 0..127 | 0 (3.0 ms) | `586-2` amp env release: 0=3.0 ms … 127=45 s (128 steps) | yes | ms table |
| `synthASound.ampEnvVel` | 2 · 0..3 | 0 | – | partly | manual: 4 settings (off + 3); curve unknown; no table |

#### LFO and vibrato

| key | bits · range | default | display table (raw → label) | MVP | note |
| --- | --- | --- | --- | --- | --- |
| `synthASound.lfoWave` | 3 · 0..4 | 0 (triangle) | `576-2` LFO shape: 0=triangle; 1=saw; 2=inv saw; 3=square; 4=S/H | yes | 5 shapes |
| `synthASound.lfoDst` | 2 · 0..3 | 0 (nothing) | `575-8` LFO target: 0=nothing; 1=OSC CTRL; 2=PITCH; 3=FILTER | yes | off/osc ctrl/pitch/filter |
| `synthASound.lfoRateClkDiv` | 7 · 0..127 | 64 | – | partly | no table in repo (opennord dep 576-6 not ported); Hz curve unknown; morphs: wheel, AT, pedal |
| `synthASound.lfoClkEnable` | 1 · 0..1 | 0 (off) | `576-5` LFO mst clk on/off: 0=off; 1=on | partly | subdivision list not in repo |
| `synthASound.lfoAmt` | 7 · 0..127 | 32 | – | partly | no table; depth units unknown; morphs: wheel, AT, pedal |
| `synthA.vibMode` | 3 · 0..5 | 0 (none) | `416-1` vibrato mode: 0=none; 1=ON; 2=DLY; 3=WHL; 4=A.T.; 5=PED | yes | ON/DLY/WHL/A.T./PED (PED: no pedal in MVP) |
| `synthASound.vibRate` | 7 · 0..127 | 74 (5.4 Hz) | `602-6` vibrato rate: 0=2.0 Hz … 127=8.0 Hz (128 steps) | yes | 2.0–8.0 Hz |
| `synthASound.vibAmt` | 6 · 0..50 | 25 (5.0) | `603-5` vibrato amount: 0=0.0 … 50=10.0 (51 steps) | partly | 0–10 (manual); depth in cents unknown |
| `synthA.vibDly` | 7 · 1..30 | 7 (0.7 sec) | `453-5` vibrato delay: 1=0.1 sec … 30=3.0 sec (30 steps) | partly | table 0.1–3.0 s in 0.1 s steps; manual lists only 0.2/0.7/1.2/2.0 s |

#### Arpeggiator

| key | bits · range | default | display table (raw → label) | MVP | note |
| --- | --- | --- | --- | --- | --- |
| `synthA.arpRun` | 1 · 0..1 | 0 (off) | `423-8` arpeggiator run on/off: 0=off; 1=on | yes |  |
| `synthA.arpMode` | 2 · 0..2 | 0 (Arp) | `424-1` arpeggiator mode: 0=Arp; 1=Poly; 2=Gate | yes | Arp/Poly/Gate |
| `synthA.arpDir` | 2 · 0..3 | 0 (UP) | `428-4` arp direction: 0=UP; 1=DOWN; 2=UP/DOWN; 3=RANDOM | yes |  |
| `synthA.arpZigZag` | 1 · 0..1 | 0 (off) | `428-6` arp zigzag on/off: 0=off; 1=on | yes |  |
| `synthA.arpKbdSync` | 1 · 0..1 | 0 (off) | `424-4` KB sync on/off: 0=off; 1=on | yes |  |
| `synthA.arpRange` | 7 · 0..127 | 0 (0.0) | `424-5` arp range/env: 0=0.0 … 127=10.0 (128 steps) | partly | manual: 0–4 octaves incl. in-between steps; table 0.0–10.0, scale unknown (README); Gate: env hardness; morphs: wheel, AT, pedal |
| `synthA.arpRateClkDiv` | 7 · 0..127 | 54 | – | partly | no table; BPM mapping unknown; morphs: wheel, AT, pedal |
| `synthA.arpClkEnable` | 1 · 0..1 | 0 (off) | `428-7` arp MST CLK on/off: 0=off; 1=on | partly | subdivision list not in repo |
| `synthA.arpPtnEnable` | 1 · 0..1 | 0 (off) | `424-3` arp pattern on/off: 0=off; 1=on | partly | pattern presets not in layout |
| `synthA.arpPtnLen` | 4 · 1..15 | 7 (8) | `432-7` arp pattern length: 1=2 … 15=16 (15 steps) | partly | 2–16 steps (manual agrees); pattern content partly decoded |
| `synthA.arpPtnAcc` | 32 · -2147483648..2147483647 | 0 | – | partly | 32-bit step mask; bit order unverified |
| `synthA.arpPtnDur` | 32 · -2147483648..2147483647 | 0 | – | no | 32-bit, step/gate encoding unknown |
| `synthA.arpPtnPan` | 32 · -2147483648..2147483647 | 0 | – | no | 32-bit, L/C/R encoding unknown |

#### Voice and keyboard

| key | bits · range | default | display table (raw → label) | MVP | note |
| --- | --- | --- | --- | --- | --- |
| `synthA.voiceMode` | 2 · 0..2 | 0 | – | yes | 0 poly, 1 mono, 2 legato (bit 0 mono, bit 1 legato); no table |
| `synthA.voicePrio` | 2 · 0..2 | 0 (no priority) | `416-8` voice priority: 0=no priority; 1=LO; 2=HI | yes | none/LO/HI, mono/legato only |
| `synthA.glideRate` | 7 · 0..127 | 0 (0.0) | `417-2` glide: 0=0.0 … 127=10.0 (128 steps) | partly | constant-rate glide; table 0.0–10.0 has no time unit |
| `synthA.oscUnison` | 2 · 0..3 | 0 | – | partly | 0–3; detune/voice count unknown |
| `synthA.kbZone` | 4 · 0..11 | 5 | `414-3` KB zones (depends on splitEnabledLow, splitEnabledMid, splitEnabledHigh) | yes | zone mask via split points (dep table 414-3) |
| `synthA.octaveShift` | 4 · -6..6 | 0 | `414-7` octave shift: -2=-2; -1=-1; 1=+1; 2=+2 | yes | table labels only ±2; layout allows ±6 |
| `synthA.pStickEnable` | 1 · 0..1 | 1 (on) | `415-3` pstick on/off: 0=off; 1=on | yes | pitch bend on/off |
| `synthA.pitchStickRange` | 4 · 0..9 | 1 (+/- 2) | `415-4` pstick rng: 0=+/- 1; 1=+/- 2; 2=+/- 3; 3=+/- 4; 4=+/- 5; 5=+/- 7; 6=+/- 10; 7=+/- 12; 8=+2 / -12; 9=+2 / -24 | yes | semitone ranges labelled |
| `synthA.sustainEnable` | 1 · 0..1 | 1 (on) | `415-8` susped on/off: 0=off; 1=on | yes | CC64 / sustain |
| `synthA.kbdHoldEnableLayer` | 1 · 0..1 | 1 (include) | `423-7` KB hold: 0=exclude; 1=include | yes | include/exclude from KB Hold |

#### Extern (per synth layer)

| key | bits · range | default | display table (raw → label) | MVP | note |
| --- | --- | --- | --- | --- | --- |
| `synthA.externEnable` | 1 · 0..1 | 0 (off) | `418-1` extern on/off: 0=off; 1=on | no | MIDI out not in MVP; stored only |
| `synthA.externVelCurve` | 2 · 0..2 | 1 | – | no | extern |
| `synthA.externModWheelEnable` | 1 · 0..1 | 1 | – | no | extern |
| `synthA.externAftertouchEnable` | 1 · 0..1 | 1 | – | no | extern |
| `synthA.externCtrlPedalEnable` | 1 · 0..1 | 1 | – | no | extern |
| `synthA.externSwellPedalEnable` | 1 · 0..1 | 1 | – | no | extern |
| `synthA.externVolPedalEnable` | 1 · 0..1 | 1 | – | no | extern |
| `synthA.externCCNumber1` | 7 · 0..120 | 3 | – | no | extern; manual range 0–119 |
| `synthA.externCCValue1` | 7 · 0..127 | 0 | – | no | extern; morphs: wheel, AT, pedal |
| `synthA.externCCNumber2` | 7 · 0..120 | 3 | – | no | extern |
| `synthA.externCCValue2` | 7 · 0..127 | 0 | – | no | extern; morphs: wheel, AT, pedal |
| `synthA.externSendOnLoad` | 1 · 0..1 | 0 | – | no | extern |
| `synthA.externBCValue_MSB` | 8 · 0..128 | 0 | – | no | extern |
| `synthA.externBCValue_LSB` | 8 · 0..128 | 0 | – | no | extern |
| `synthA.externPCValue` | 7 · 0..127 | 0 | – | no | extern |

#### Effects (synthAFx)

| key | bits · range | default | display table (raw → label) | MVP | note |
| --- | --- | --- | --- | --- | --- |
| `synthAFx.fx1Enable` | 1 · 0..1 | 0 (off) | `705-1` FX mod 1 on/off: 0=off; 1=on | yes |  |
| `synthAFx.fx1ClkEnable` | 1 · 0..1 | 0 (off) | `705-2` FX mod 1 MST CLK on/off: 0=off; 1=on | partly | subdivisions unknown |
| `synthAFx.fx1RateClkDiv` | 7 · 0..127 | 64 | – | partly | no table; rate curve unknown; morphs: wheel, AT, pedal |
| `synthAFx.fx1Amt` | 7 · 0..127 | 64 (5.0) | `709-2` FX mod 1 amount: 0=0.0 … 127=10.0 (128 steps) | partly | table 0.0–10.0; morphs: wheel, AT, pedal |
| `synthAFx.fx1Type` | 4 · 0..11 | 0 (A-PAN) | `713-1` FX mod 1 mode: 0=A-PAN; 1=A-PAN variation; 2=TREM; 3=TREM variation; 4=RM; 5=RM variation; 6=A-WAH; 7=A-WAH variation; 8=WAH; 9=WAH variation; 10=PUMP; 11=PUMP variation | partly | A-Pan, Trem, RM simple; A-Wah, Wah, Pump approximated; PED variants need pedal |
| `synthAFx.fx2Enable` | 1 · 0..1 | 0 (off) | `713-5` FX mod 2 on/off: 0=off; 1=on | yes |  |
| `synthAFx.fx2Rate` | 7 · 0..127 | 64 (5.0) | `713-6` FX mod 2 rate: 0=0.0 … 127=10.0 (128 steps) | partly | table 0.0–10.0, Hz unknown; morphs: wheel, AT, pedal |
| `synthAFx.fx2Amt` | 7 · 0..127 | 64 (5.0) | `717-5` FX mod 2 amount: 0=0.0 … 127=10.0 (128 steps) | partly | table 0.0–10.0; morphs: wheel, AT, pedal |
| `synthAFx.fx2Type` | 4 · 0..11 | 0 (PHAS) | `721-4` FX mod 2 mode: 0=PHAS; 1=PHAS variation; 2=FLANG; 3=FLANG variation; 4=CHOR; 5=CHOR variation; 6=VIBE; 7=VIBE variation; 8=ENS; 9=ENS variation; 10=SPIN; 11=SPIN variation | partly | phaser/flanger/chorus/vibe/ensemble/spin approximated with delays and all-pass |
| `synthAFx.ampEnable` | 1 · 0..1 | 0 (off) | `721-8` FX amp sim/EQ on/off: 0=off; 1=on | yes |  |
| `synthAFx.ampTreble` | 7 · -60..60 | 0 (+0.0 dB) | `722-1` FX amp sim/EQ treb: -60=-15.0 dB … 60=+15.0 dB (121 steps) | yes | 4 kHz shelf, ±15 dB (manual) |
| `synthAFx.ampMid` | 7 · -60..60 | 0 | – | yes | peaking, ±15 dB; no table (same scale assumed) |
| `synthAFx.ampBass` | 7 · -60..60 | 0 (+0.0 dB) | `723-7` FX amp sim/EQ bass: -60=-15.0 dB … 60=+15.0 dB (121 steps) | yes | 100 Hz shelf, ±15 dB |
| `synthAFx.ampMidFreq` | 7 · 0..127 | 64 (999 Hz) | `724-6` FX amp sim/EQ freq: 0=200 Hz … 127=8.0 kHz (128 steps) | yes | 200 Hz–8 kHz; morphs: wheel, AT, pedal |
| `synthAFx.ampDrive` | 7 · 0..127 | 0 (0.0) | `728-5` FX amp sim/EQ drive: 0=0.0 … 127=10.0 (128 steps) | partly | tube-style waveshaper guess; morphs: wheel, AT, pedal |
| `synthAFx.cmpEnable` | 1 · 0..1 | 0 (off) | `732-8` FX comp on/off: 0=off; 1=on | yes |  |
| `synthAFx.cmpAmt` | 7 · 0..127 | 95 (7.4) | `733-1` FX comp amount: 0=0.0 … 127=10.0 (128 steps) | partly | DynamicsCompressor mapping invented |
| `synthAFx.cmpResponse` | 1 · 0..1 | 0 (normal) | `733-8` FX comp response: 0=normal; 1=fast | partly | fast = shorter release |
| `synthAFx.dlyEnable` | 1 · 0..1 | 0 (off) | `734-1` FX delay on/off: 0=off; 1=on | yes |  |
| `synthAFx.dlyClkEnable` | 1 · 0..1 | 0 (off) | `734-2` FX delay tempo MST CLK on/off: 0=off; 1=on | partly | subdivisions 1/2–1/32 incl. S/T/D (manual), raw mapping unknown |
| `synthAFx.dlyRateClkDiv` | 14 · 0..16383 | 11008 | – | partly | 14-bit, no table; time curve unknown; morphs: wheel, AT, pedal |
| `synthAFx.dlyMix` | 7 · 0..127 | 64 (5.0) | `741-6` FX delay mix: 0=0.0 … 127=10.0 (128 steps) | yes | dry/wet; morphs: wheel, AT, pedal |
| `synthAFx.dlyMode` | 1 · 0..1 | 0 (normal) | `745-5` FX delay normal/analog: 0=normal; 1=analog | partly | analog: pitch-on-change + drive, approximated |
| `synthAFx.dlyFbkPingPong` | 1 · 0..1 | 0 (off) | `745-6` FX delay ping pong on/off: 0=off; 1=on | yes |  |
| `synthAFx.dlyFbkFilt` | 2 · 0..3 | 0 (none) | `745-7` FX delay filter type: 0=none; 1=LP; 2=HP; 3=BP | yes | LP/HP/BP in feedback |
| `synthAFx.dlyFbkAmt` | 7 · 0..127 | 64 (5.0) | `746-1` FX delay feedback: 0=0.0 … 127=10.0 (128 steps) | yes | feedback; morphs: wheel, AT, pedal |
| `synthAFx.dlyFbFxType` | 4 · 0..11 | 0 (none) | `749-8` FX delay effects: 0=none; 1=none; 2=ENS; 3=ENS variation; 4=VIBE; 5=VIBE variation; 6=CHOR; 7=CHOR variation; 8=FLAM; 9=FLAM variation; 10=SPACE; 11=SPACE variation | partly | ENS/VIBE/CHOR/FLAM/SPACE in feedback, approximated |
| `synthAFx.rvbEnable` | 1 · 0..1 | 0 (off) | `750-4` FX reverb on/off: 0=off; 1=on | yes |  |
| `synthAFx.rvbAmt` | 7 · 0..127 | 38 (2.9) | `750-5` FX reverb amount: 0=0.0 … 127=10.0 (128 steps) | yes | dry/wet; morphs: wheel, AT, pedal |
| `synthAFx.rvbColor` | 2 · 0..2 | 0 (none) | `754-4` FX reverb dark/bright: 0=none; 1=DARK; 2=BRIGHT | yes | dark/bright EQ |
| `synthAFx.rvbType` | 4 · 0..11 | 6 (STAGE) | `754-6` FX reverb type: 0=SPRING; 1=SPRING variation; 2=BOOTH; 3=BOOTH variation; 4=ROOM; 5=ROOM variation; 6=STAGE; 7=STAGE variation; 8=HALL; 9=HALL variation; 10=CATH; 11=CATH variation | partly | 6 types + variation via generated impulse responses, not Nord IRs |
| `synthAFx.ampTypeNew` | 4 · 0..9 | 0 (off) | `755-6` FX amp sim/EQ mode: 0=off; 1=TWIN; 2=TWIN variation; 3=JC; 4=JC variation; 5=SMALL; 6=SMALL variation; 7=TO ROTARY; 8=LP FILTER; 9=HP FILTER | partly | Twin/JC/Small cab EQ guesses; LP/HP 24 filter partly (no confirmed freq/res/dry-wet field); To Rotary no (rotary not in MVP) |

#### Synth section common (synth.*)

| key | bits · range | default | display table (raw → label) | MVP | note |
| --- | --- | --- | --- | --- | --- |
| `synth.layerFocusSyn_I` | 2 · 0..2 | 0 | – | yes | UI focus (0–2 = A–C) |
| `synth.layerEnableSyn_I` | 3 · 0..7 | 1 | – | yes | layer on/off mask A/B/C (bit order from converter, unverified on hardware) |
| `synth.layerFocusSyn_II` | 2 · 0..2 | 0 | – | yes | UI focus, scene II |
| `synth.layerEnableSyn_II` | 3 · 0..7 | 1 | – | yes | scene II mask |
| `synth.layerLevelSynA` | 7 · 0..127 | 127 (0.0 dB) | `378-3` volume: 0=volume off … 127=0.0 dB (128 steps) | yes | gain from dB table; morphs: wheel, AT, pedal |
| `synth.layerLevelSynB` | 7 · 0..127 | 127 (0.0 dB) | `378-3` volume: 0=volume off … 127=0.0 dB (128 steps) | yes | gain from dB table; morphs: wheel, AT, pedal |
| `synth.layerLevelSynC` | 7 · 0..127 | 127 (0.0 dB) | `378-3` volume: 0=volume off … 127=0.0 dB (128 steps) | yes | gain from dB table; morphs: wheel, AT, pedal |
| `synth.layerPanSynA` | 7 · -60..60 | 0 | – | yes | pan law unknown, equal-power assumed |
| `synth.reserved_was_pan_a_morph` | 24 · 0..0 | 0 | – | no | reserved bits, pass through |
| `synth.layerPanSynB` | 7 · -60..60 | 0 | – | yes | as A |
| `synth.reserved_was_pan_b_morph` | 24 · 0..0 | 0 | – | no | reserved |
| `synth.layerPanSynC` | 7 · -60..60 | 0 | – | yes | as A |
| `synth.reserved_was_pan_c_morph` | 24 · 0..0 | 0 | – | no | reserved |
| `synth.multiLayerFlt` | 1 · 0..1 | 0 | – | yes | filter Group: UI keeps layers in sync |
| `synth.multiLayerArp` | 1 · 0..1 | 0 (off) | `401-6` synth arp group on/off: 0=off; 1=on | yes | arp Group |
| `synth.multiLayerLFO` | 1 · 0..1 | 0 | – | yes | LFO Group; phase sync approximated |
| `synth.kbdHoldEnableCommon` | 1 · 0..1 | 0 (off) | `401-8` synth KB hold on/off: 0=off; 1=on | yes | KB Hold |
| `synth.auxKbdControl` | 3 · 0..7 | 0 | – | no | Aux KB not in MVP |
| `synth.effectsSectionModeSyn` | 1 · 0..1 | 1 | – | yes | FX Group mode (UI) |
| `synth.fxLayerFocusSyn` | 2 · 0..2 | 0 | – | yes | UI focus |

### 3.3 Morph fields (synth)

24 parameters carry three morph amounts each (`.morphWheel`, `.morphAfterTouch`, `.morphCtrlPedal`), 72 fields per layer plus common: `synth.layerLevelSyn{A,B,C}`; `synthASound.oscCtrl`, `oscEnvAmt`, `lfoRateClkDiv`, `lfoAmt`, `fltFreq`, `fltRes`, `fltEnvAmt`; `synthA.arpRange`, `arpRateClkDiv`, `externCCValue1`, `externCCValue2`; `synthAFx.fx1RateClkDiv`, `fx1Amt`, `fx2Rate`, `fx2Amt`, `ampMidFreq`, `ampDrive`, `dlyRateClkDiv`, `dlyMix`, `dlyFbkAmt`, `rvbAmt`. Range −127…+127 (offset encoding); osc env amount −120…+120; delay tempo −16383…+16383. MVP: **partly** (store, edit as signed delta, apply linearly from wheel, aftertouch and control pedal; scaling unverified). The converter maps only cutoff and resonance morphs, and of those only the pedal morph is confirmed by Nord Sound Manager (README).

### 3.4 Official MIDI controllers for synth fields

From M p.68–69, matched by name. Applies to the Global channel; target layer and value scaling are not documented.

| manual parameter | CC / NRPN | layout key |
| --- | --- | --- |
| Synth A/B/C Level | 43 / 37 / 39 | `synth.layerLevelSyn{A,B,C}` |
| Synth A/B/C Pan | 40 / 41 / 36 | `synth.layerPanSyn{A,B,C}` |
| Synth Section Enable Scene I / II | 42 / 5 | `common.sectionEnableSyn_I/_II` |
| Synth Layers Enable Scene I / II | 61 / 75 | `synth.layerEnableSyn_I/_II` |
| Synth Layers Focus Scene I / II | 115 / 119 | `synth.layerFocusSyn_I/_II` |
| Synth Octave Shift | 44 | `synthA.octaveShift` |
| Synth Waveform | 3:2 | `synthASound.oscBank/oscCat/oscWave` (encoding unclear) |
| Synth Sample Cat/Sample | 3:4:x:x | `synthA.smpId` / `smpNameHash` (encoding unclear) |
| Synth Sample Bright | 3:8 | `synthASound.smpTimbre` |
| Synth Osc Ctrl | 56 | `synthASound.oscCtrl` |
| Synth Osc Pitch Course / Fine | 55 / 47 | `synthASound.oscTuneCoarse` / `oscTuneFine` |
| Synth Osc Envelope Attack / Decay / Release | 52 / 53 / 57 | `synthASound.oscEnvAtk/Dcy/Rls` |
| Synth Osc Envelope To Pitch / Velocity | 3:33 / 3:32 | `synthASound.oscEnvDst` / `oscEnvVel` |
| Synth Filter Freq / Resonance | 59 / 60 | `synthASound.fltFreq` / `fltRes` |
| Synth Filter Drive / KBD Track / Type | 3:49 / 3:50 / 3:51 | `synthASound.fltDrive` / `fltKbdTrk` / `fltType` |
| Synth Filter Group | 25 | `synth.multiLayerFlt` |
| Synth Filter Envelope Attack / Decay / Release / Amount | 49 / 50 / 51 / 73 | `synthASound.fltEnvAtk/Dcy/Rls/Amt` |
| Synth Filter Envelope Velocity | 3:64 | `synthASound.fltEnvVel` |
| Synth Amp Envelope Attack / Decay / Release | 68 / 69 / 71 | `synthASound.ampEnvAtk/Dcy/Rls` |
| Synth Amp Envelope Velocity | 3:56 | `synthASound.ampEnvVel` |
| Synth LFO Rate / Amount | 79 / 54 | `synthASound.lfoRateClkDiv` / `lfoAmt` |
| Synth LFO Waveform / Destination | 3:80 / 3:81 | `synthASound.lfoWave` / `lfoDst` |
| Synth Voice Mode / Priority / Unison | 3:16 / 3:17 / 3:18 | `synthA.voiceMode` / `voicePrio` / `oscUnison` |
| Synth Glide Rate | 48 | `synthA.glideRate` |
| Synth Arp/Gate Run / Rate / Range | 77 / 74 / 76 | `synthA.arpRun` / `arpRateClkDiv` / `arpRange` |
| Synth Arp/Gate Mode / Pattern On / Direction / ZigZag | 3:72 / 3:73 / 3:74 / 3:75 | `synthA.arpMode` / `arpPtnEnable` / `arpDir` / `arpZigZag` |
| Synth Vibrato Mode / Dly Time | 3:19 / 3:20 | `synthA.vibMode` / `vibDly` |
| Synth Vibrato Amount / Rate | 45 / 46 | `synthASound.vibAmt` / `vibRate` |
| Synth Vibrato Pedal | 15 | – (performance control) |
| Mod 1 Enable / Type / Amount / Rate / Pump Pedal | 2:64 / 2:65 / 85 / 86 / 87 | `synthAFx.fx1Enable` / `fx1Type` / `fx1Amt` / `fx1RateClkDiv` / – |
| Mod 2 Enable / Type / Amount / Rate | 2:72 / 2:73 / 89 / 90 | `synthAFx.fx2Enable` / `fx2Type` / `fx2Amt` / `fx2Rate` |
| Delay Enable / Dry Wet / Tempo / Feedback | 2:88 / 93 / 94 / 95 | `synthAFx.dlyEnable` / `dlyMix` / `dlyRateClkDiv` / `dlyFbkAmt` |
| Delay Analog / Ping-pong / Filter Type / Global | 2:89 / 2:91 / 2:92 / 29 | `synthAFx.dlyMode` / `dlyFbkPingPong` / `dlyFbkFilt` / `common.effectsDlyGlobal` |
| Amp/EQ Enable / Type / Drive / Bass / Mid / Treble / Mid Frequency | 2:80 / 2:81 / 101 / 102 / 103 / 104 / 107 | `synthAFx.ampEnable` / `ampTypeNew` / `ampDrive` / `ampBass` / `ampMid` / `ampTreble` / `ampMidFreq` |
| Reverb Enable / Bright / Amount / Type / Global | 2:104 / 2:106 / 113 / 2:105 / 30 | `synthAFx.rvbEnable` / `rvbColor` / `rvbAmt` / `rvbType` / `common.effectsRvbGlobal` |
| Compressor Enable / Amount / Fast / Global | 2:96 / 117 / 2:97 / 28 | `synthAFx.cmpEnable` / `cmpAmt` / `cmpResponse` / `common.effectsCmpGlobal` |

Synth fields without any documented controller: `oscEnvAmt`, `fltEnable`, `lfoClkEnable`, `arpClkEnable`, `arpKbdSync`, `arpPtnLen/Acc/Dur/Pan`, `kbZone`, `pStickEnable`, `pitchStickRange`, `sustainEnable`, `kbdHoldEnable*`, `smpDynamic`, `mode`, all `extern*`, `multiLayerArp/LFO`, `effectsSectionModeSyn`, `fx1ClkEnable`, `dlyClkEnable`, `dlyFbFxType`, and all morphs.

### 3.5 Other sections (counts for the layout)

| area | blocks | parameter fields | morph fields | with display table | notes |
| --- | --- | --- | --- | --- | --- |
| Common / program | `common` | 51 | 0 | 23 | split 10, transpose 2, master clock 2 (tempo 30–240 BPM, KB sync; no table), section enables 6, layer scene 1, FX on + 3 global flags, FX focus 1, preset references 14 (positions, name hashes, layer counts), aux KB 2, output bus routing 7 (no table), pedal tap and layer-scene pedal 2 |
| Keyboard / split (subset of the rows above and below) | part of `common` + each layer | 12 in `common` + `kbZone` and `octaveShift` in 7 layers | 0 | all 12 common fields; `kbZone` via split-dependent table `113-1`/`243-1`/`414-3`; `octaveShift` labels ±2 | split points C2–C7 (11 positions), xFade none/±6/±12 |
| Organ | `organ`, `organA/B`, `organA/BDrawbars`, `organA/BVibPerc` | 58 | 63 | 28 | models B3/VOX/FARF/PIPE1/PIPE2/B3 BASS labelled; drawbars 0–8 unlabelled (self-evident); vibrato type B3/Vox/Farfisa, rotor/horn angles, mic distance, poly perc unlabelled; rotary settings live in `organ` |
| Piano | `piano`, `pianoA/B` | 37 | 6 | 18 | type Grand/Upright/Electric/Clav/Digital/Misc, model slot, touch, pedal noise labelled; `variation`, `acoustic`, `unison`, `dynComp`, `eq` unlabelled; 295 piano names by hash |
| Effects, organ and piano | `organFx`, `pianoAFx`, `pianoBFx` | 3 × 32 = 96 | 3 × 30 = 90 | 3 × 29 = 87 | same 32 fields as `synthAFx` (counted under synth); unlabelled in each: `fx1RateClkDiv`, `ampMid`, `dlyRateClkDiv` |
| Synth (3 layers incl. their effects + common) | see 3.1 | 356 | 198 | 248 | – |
| **total** | 24 blocks | **598** (incl. 3 reserved fields) | **357** | **404** | 955 fields |

## 4. Panel structure

### 4.1 Sections and controls (manual names → layout keys)

| panel area | controls (M) | layout keys |
| --- | --- | --- |
| Program (M p.38–45) | Layer Scene I/II | `common.layerScene`, `common.section*_I/_II` |
| | Split On/Set: Low/Mid/High points, xFade | `common.splitEnabled*`, `splitPos*`, `splitWidth*` |
| | Mst Clk Tap/Set, KBS (off/on/soft), Pedal Tap | `common.masterClockRate`, `masterClockKbdSync`, `pdlTapEnable` |
| | Transp On/Set (±6) | `common.transposeEnable`, `transposeValue` |
| | Morph Assign Wheel / A.T. / CtrlPed | `*.morphWheel`, `*.morphAfterTouch`, `*.morphCtrlPedal` |
| | Preset Library Organ / Piano / Synth | `common.orgPreset*`, `pnoPreset*`, `synPreset*` |
| | Program dial, Store, Store As, Live Mode, Prog View, Solo, Undo, Section Edit, Layer Init, Panic | – (operations, not program data) |
| Organ (M p.18–22) | On, layer A/B, level faders, FX focus | `common.sectionEnableOrg_*`, `organ.layerEnableOrg_*`, `layerFocusOrg_*`, `layerLevelOrgA/B` |
| | Octave Shift, KB Zone, Sustped, PStick | `organA.octaveShift`, `kbZone`, `sustainEnable`, `organ.orgPStickEnable` |
| | Model B3 / Vox / Farf / Pipe 1 / Pipe 2 / B3 Bass, Preset | `organA.model`, `presetEnable` |
| | Drawbars 1–9 (Drawbar Live) | `organADrawbars.org_Preset_kDb1…9` (Drawbar Live: no key found) |
| | Vibrato/Chorus on and type, Percussion on / 3rd / fast / soft, Poly perc | `organAVibPerc.*`, `organ.vibratoTypeB3/Vox/Farfisa`, `organ.polyPercEnable` |
| Rotary (M p.53) | Organ, Slow/Stop–Fast, Stop Mode, Angle, Drive, Close Mic | `organ.effectsLeslieEnable`, `effectsLeslieSpeed`, `effectsLeslieStopMode`, `leslieStopPreset`, `effectsLeslieDrv`, `leslieMicDistance` |
| Piano (M p.23–26) | On, layer A/B, levels, FX focus, Group | `common.sectionEnablePno_*`, `piano.layerEnablePno_*`, `layerLevelPnoA/B`, `effectsSectionModePno`, `fxLayerFocusPno` |
| | Octave Shift, KB Zone, Sustped, PStick | `pianoA.octaveShift`, `kbZone`, `sustainEnable`, `pStickEnable` |
| | Type, model, variation | `pianoA.bank`, `entry`, `variation`, `nameHash` |
| | KB Touch, Dyn Comp, Unison, Pedal Noise, Timbre, Acoustics, Soft Release, String Res | `pianoA.kbdTouch`, `dynComp`, `unison`, `pedalNoise`; `eq` and `acoustic` probable but unconfirmed; Soft Release and String Res: no key confirmed |
| Synth (M p.27–37) | On, layer A/B/C, levels, pan, FX focus, Group | `common.sectionEnableSyn_*`, `synth.*` |
| | Mode Samples / Analog / Extern | `synthA.mode`, `synthA.externEnable` |
| | Octave Shift, KB Zone, Sustped, PStick/Rng | `synthA.octaveShift`, `kbZone`, `sustainEnable`, `pStickEnable`, `pitchStickRange` |
| | Oscillators: Waveform (Type/Cat/Wave; Cat/Sample), Osc Ctrl, Pitch/Smp (pitch, fine, sample options), Env To Pitch, Envelope A/D/R, Velocity, Env Amt, Bright, Sound Init | `synthASound.osc*`, `smpDynamic`, `smpTimbre`; `synthA.smpId`, `smpNameHash`, `libName` |
| | Filter: Type / KBD Trk / Drive, Freq, Res, Env Amt, Envelope A/D/R, Velocity, Group, on/off | `synthASound.flt*`, `synth.multiLayerFlt` |
| | Amp: Envelope A/D/R, Velocity | `synthASound.ampEnv*` |
| | LFO: Rate/Time (Mst Clk), Mod Amt, Waveform, destination, Group | `synthASound.lfo*`, `synth.multiLayerLFO` |
| | Voice: Mono, Legato, Lo/Hi, Glide, Unison | `synthA.voiceMode`, `voicePrio`, `glideRate`, `oscUnison` |
| | Arp/Gate: Run, KB Sync, Arp/Poly/Gate, Pattern, Rate/Time (Mst Clk), Range/Env, Menu, Group | `synthA.arp*`, `synth.multiLayerArp` |
| | Vibrato: selector, Menu (Rate, Amount, Dly Time) | `synthA.vibMode`, `vibDly`, `synthASound.vibRate`, `vibAmt` |
| | KB Hold, Exclude | `synth.kbdHoldEnableCommon`, `synthA.kbdHoldEnableLayer` |
| Extern (M p.46–47, 63) | Program dial, CC#1/#2 value dials, Send On Load | `synthA.extern*` |
| Layer Effects (M p.48–53) | Effects On (all), FX Focus, Group, Global (delay, compressor, reverb) | `common.fxEnable`, `common.effects*Global`, `common.fxSectionFocus`, `*.effectsSectionMode*` |
| | Mod 1, Mod 2, Delay, Amp Sim/EQ, Compressor, Reverb | `{organ,pianoA,pianoB,synthA,synthB,synthC}Fx.*` |

### 4.2 Menus

| menu (access) | pages (M) | in the program file? |
| --- | --- | --- |
| System (Shift + Program 1), M p.57 | 1 Memory Protect, 2 Global Transpose, 3 Fine Tune, 4 LED Intensity, 5 Reset All Settings, 6 Version and model info | no (instrument setting) |
| Sound (Shift + Program 2), M p.58 | 1 Program Levels, 2 Piano Pedal Noise Level, 3 Piano String Res Level, 4 Organ Keyboard Trigger Point, 5 B3 Tonewheel Mode, 6 B3 Click Level, 7 Rotary Bass/Horn Level, 8 Rotor Speed, 9 Rotor Acceleration, 10 Horn Speed, 11 Horn Acceleration | no, except Program Levels, which rescales the stored layer levels |
| Aux KB (Shift + Program 4), M p.44, 58 | 1 Aux Keyboard Enable, 2 Aux Keyboard Layers, 3 Keyboard Curve | yes: `common.auxKbdEnable`, `auxKbdVelCurve`, `organ/piano/synth.auxKbdControl` |
| Output (Shift + Program 5), M p.59 | 1 Output Routing Mode, 2 Output Bus Channels (per program), 3–5 Organ/Rotary, Piano, Synth bus, 6 Overview | per-program bus: `common.audioRoutingBus*`; routing mode: unclear |
| Pedal (Shift + Program 6), M p.60 | 1 Control Pedal, 2 Swell Pedal, 3 Sustain Pedal, 4 Triple Pedal Function, 5 Rotor Pedal, 6 Foot Switch, 7 Overview | no (pedal tap and layer-scene pedal switches are `common.pdl*`) |
| MIDI (Shift + Program 7), M p.61–62 | 1 Local Control, 2 Global / Aux KB channel, 3 Organ, 4 Piano, 5 Synth channel, 6 Extern channel, 7 Control / NRPN / Device mode, 8 Program Change mode, 9 Transpose MIDI At, 10 Overview | no (extern channels stated as global) |
| Extern (Shift + Program 8), M p.63 | 1 Echo Global To Extern Ch, 2 Keyboard Velocity, 3–5 Bank Select / Program Change, 6–7 CC#1/#2, 8–12 Device MIDI, 13 Send On Load (each A/B/C) | yes: `synthA.extern*`; page 1 mapping unclear |
| Synth display menus, M p.28–37 | Waveform; Pitch/Smp; Filter Type; Envelopes; LFO Waveform; Arpeggiator (5 pages: direction/zigzag, pattern preset/length, edit, accent, pan); Vibrato (rate, amount, delay time) | yes (see section 3) |

## 5. Open points

1. **CC/NRPN value scaling and layer addressing.** Unclear how 0–127 maps to each parameter, what the NRPN data values of enums are (Filter Type 3:51, Waveform 3:2, Sample 3:4:x:x), and whether a synth CC on the Global channel targets the focused layer. Settled by: a Nord MIDI implementation document (none published) or a capture with the Stage 4 sending CC & NRPN.
2. **SysEx.** Not documented; no dump or request protocol. Settled only by Nord. Treat as not available.
3. **Missing display tables.** `fltRes`, `lfoRateClkDiv`, `lfoAmt`, `arpRateClkDiv`, `dlyRateClkDiv`, `fx1RateClkDiv`, `voiceMode`, `oscUnison`, `ampEnvVel`, `fltDrive`, `ampMid`, layer pan, master clock subdivisions. opennord has a dependency table for the LFO rate (`576-6`) that the generator does not port (generator change = engine data change, ask first). Others need hardware readings.
4. **Conflicts between manual and tables.** Vibrato delay (manual 4 values, table 30 steps); filter list on the specifications page ("LP+BP") vs manual and layout (LP+HP); FM categories (manual A–E, table A–H); FM-H partial and FM-I pitch raw mappings.
5. **Undecoded synth content.** Wave type waveforms and most of its category names; arp pattern preset index (no field found) and the 32-bit pattern fields; piano Soft Release / String Res / Timbre keys; organ Drawbar Live.
6. **Morph semantics.** Whether a morph amount is a delta in raw steps and how it scales; whether the layout's extra morphs (osc/filter env amount, arp range, Mod 2 rate) are reachable on the panel.
7. **Export acceptance.** No hardware test yet; `verify()` checks structure only. Settled by loading an exported file through Nord Sound Manager into a free slot (the pending hardware test).
8. **Asset licences.** No published licence for Nord samples, pianos, factory programs or presets. Settled by Clavia support. The MVP does not depend on it.
9. **Deployment details** (historical; since the pivot `web/vercel.json` rewrites `/nord` and `/nord/:path*`). `web/vercel.json` rewrites `/nordconvert/:path*` to `/:path*`; serving `editor.html` at `/nordconvert/editor` may need a rewrite entry, and the portfolio proxy's matcher and headers (CSP, Permissions-Policy) were not checked. Changes to `vercel.json` headers, the proxy or the portfolio are ask-first.
10. **Windows USB MIDI.** Whether the Stage 4 is class compliant without the Nord driver is not stated.

### Candidate questions for the user (architecture or scope)

1. **AudioWorklet in the MVP?** Sync, Shape, PWM, Super waves, the LP M ladder and filter drive need sample-level DSP. Native nodes alone cover static waves and biquad filters only. Build the synth voice as an AudioWorklet from the start, or ship native nodes first and mark those waves and filters "coarse approximation"?
2. **Export donor.** Export from an imported `.ns4p` by patching that file (keeps its 9.4 % unknown bits, closest to what the instrument wrote; `verify()` then needs the header reset to bank 0 / location 0 or a small engine change), or always patch the neutral bundled template (reproducible, drops unknown state)?
3. **Lossless app presets.** Should an app preset carry the original `.ns4p` bytes (base64) next to the decoded values, so import → edit → export keeps every unknown bit, or only the 955 decoded values (portable and readable, but not byte-lossless)?
4. **Oscillator scope.** Offer only the documented oscillators (Analog type, 45 waves; FM-H/FM-I algorithms A–E) and show Wave type and Samples as "not implemented", or also make Wave entries selectable with a placeholder sound?
5. **Morphs in the MVP.** Implement morph editing and playback (wheel, aftertouch, control pedal; 72 synth fields with unverified scaling), or store and display them read-only in the MVP?
