# nord

A browser editor and synth for Nord Stage 4 programs:
https://www.thilkolimbeck.com/nord

It edits all 955 fields of a Stage 4 program (`.ns4p`) and plays the organ,
piano and synth sections with their layer effects and morphs through Web
Audio, entirely in the browser: files are never uploaded, and the page makes
no requests beyond its own static files. MIDI goes out only after you switch
it on, never as SysEx.
The sound is an approximation, not a Stage 4: no Nord samples and no
recordings of the instrument were used. The `.ns4p` export is experimental and
untested on hardware.

History: nord started as a Stage 3 → Stage 4 program converter
(`nord-convert`). Nord Sound Manager converts Stage 3 programs natively since
v9.10, so the converter was retired; its code is in the git history (up to
commit `babed27`).

## Run it

```sh
cd web
npm install
npm run dev          # then open http://localhost:5173/nord/
npm run build        # static site in web/dist/
npm run preview      # serve web/dist/, at http://localhost:4173/nord/
```

Vite and TypeScript, no UI framework, no runtime dependencies. Node 22.14 or
newer.

## Controls

- Every control works with the keyboard and shows its value, unit and range.
  "nv" marks a value that is not verified (no Stage 4 display table, or a
  guessed curve), "coarse" one the browser engine only approximates, "≈" an
  organ, piano or effects control whose sound is an approximation. A control
  that is stored and exported but not played carries a line that says why:
  "stored setting, no sound" (aux keyboard, output buses, rotary angles …),
  "pedal assignment, stored" or "stored setting, not sent" (the extern swell
  and volume pedals).
- Morphs: a control with morph amounts has a small `m` key after its label;
  its LED lights while an amount is set. Open, it shows the wheel, a.t. and
  ctrl ped amounts as signed faders with the value each source reaches
  ("→ 4.8 kHz"); the display shows start → end while you move one. Amounts
  are read as signed deltas in stored steps (assumed, nv).
- Controller strip, left of the keys: wheel, a.t. (springs back when let go)
  and ctrl ped, for morphs and the vibrato modes; on phones the `ctrl` key in
  the keyboard region shows the strip in place of the keys.
- Master clock: the `tap` key next to the tempo sets it from four taps or more
  (mouse, touch or keyboard).
- Virtual keyboard: mouse, touch and pen, several notes at once; velocity
  comes from where you press the key (top soft, bottom loud).
- Computer keyboard, by key position (so the shape holds on QWERTZ): A S D F
  G H J K L are the white keys C to D, W E T Y U O P the black keys, Z and X
  shift an octave down and up, Esc stops every note (panic). Keys play while
  focus is not in a text field or a select, and not with Cmd, Ctrl or Alt.
  Velocity is fixed.
- MIDI input, every channel: notes with velocity, sustain (CC64), pitch bend,
  and mod wheel, aftertouch and CC11 for the vibrato modes and morphs; CC120
  and CC123 stop every note. `enable midi` asks for the browser's permission
  (never SysEx). Chrome, Edge and Firefox support Web MIDI; Safari does not,
  and the status line and the extern · midi region say so.
- extern · midi region: `control in` lets incoming CC and NRPN of the
  manual's Appendix II move the controls (scaling assumed, nv; a layer
  controller addresses the focused layer). MIDI out needs an output port and
  one of `send to stage 4` (your edits as the documented CC or NRPN, after
  the focus controller; `send all` sends every documented controller of the
  program), `send notes` (on-screen and computer keyboards and the controller
  strip) and `extern out` (extern synth layers play their channel). These
  switches are off at every page load; the port and channels are kept on
  this device. The Stage 4 needs CTRL receive and CC & NRPN in its MIDI menu.
- Audio starts with the first click or key press, as browsers require; a
  blocked audio context shows in the status line. Switching tabs or leaving
  the window releases every note.

Browsers: a current Chrome, Edge, Firefox or Safari (desktop first; narrow
screens stack the regions). iOS mutes Web Audio while the ringer switch is
off.

## What plays

All of it as approximations:

- Program: layer scene I and II (the scene picks which section and layer
  switches and which focus are edited and played), section switches, split
  points with crossfade and every layer's keyboard zones (organ, piano and
  synth), transpose. The crossfade curve and whether the split note belongs
  to the upper zone are guesses.
- Organ, layers A and B: additive models of B3, Vox, Farfisa, Pipe 1, Pipe 2
  and B3 Bass with drawbars, percussion, vibrato and chorus, and an
  approximated rotary speaker.
- Piano, layers A and B: synthesized per Stage 4 piano type (Grand, Upright,
  Electric, Clav, Digital, Misc), with touch, dynamic compression, unison,
  timbre, string resonance, soft release and pedal noise approximated. All
  295 piano names can be picked; a name only selects a sound family, no
  Nord sample.
- Synth, layers A, B and C: analog oscillators, FM approximated, filter,
  three envelopes, LFO, vibrato, voice modes, unison, glide, 46 voices; the
  arpeggiator and gate (Arp, Poly and Gate modes, direction, zig zag, range,
  KB sync, pattern step count), KB hold with per-layer exclude, the filter,
  LFO and arpeggiator groups.
- Master clock: tempo, keyboard sync (off, on, soft) and tap tempo; the
  arpeggiators, synth LFOs and layer effects with Mst Clk follow it.
- Layer effects of every organ, piano and synth layer: Mod 1 (A-Pan, Trem,
  RM, A-Wah, Wah, Pump), Mod 2 (Phaser, Flanger, Chorus, Vibe, Ensemble,
  Spin), delay (ping pong, loop filter and effect, analog mode, Mst Clk),
  amp and EQ (Twin, JC, Small, LP and HP filter, To Rotary, drive, three
  bands), compressor and reverb (generated impulse responses, no Nord ones),
  with group and Global modes and Layer Effects on. The effects focus follows
  the layer keys.
- Morphs of every morphable field (levels, drawbars, rotary speed, synth,
  extern CC values and effects) from the controller strip or MIDI.
- Samples mode with your own audio: `files › samples` imports audio files
  (whatever the browser decodes: wav, aiff, mp3, ogg, flac), kept only in
  this browser (IndexedDB) and never uploaded; a layer in samples mode picks
  one with its root note and loop in the oscillator group, and sample dyn and
  bright act on it. App presets refer to own samples by content hash and
  embed the files only with `embed own samples` on.
- Extern synth layers play their MIDI channel (notes in their zones,
  program change, bank select, CC values, volume) while `extern out` is on.

Not playing, shown and stored: Nord samples, the Wave oscillator type and
the real pianos (Nord content), the arpeggiator patterns' content, the
arpeggiator driving an extern layer, and stored settings (aux keyboard and
output buses, pedal assignments, the organ's preset switch and rotary angles,
the piano slot). Preset Library references are read-only.

## Files

In the files box:

- **App preset** (`save`, `load`, `app-preset ↓`, `import`): the whole editor
  state as versioned JSON, lossless through save, load, download and
  re-import. It is for this editor only; the Stage 4 and Nord Sound Manager
  cannot open it. `save` keeps it in this browser; a working copy is also
  autosaved there. Each saved preset in the `load` list has a `delete` key
  that asks first. A download carries the layers' own sample references, and
  the sample files too with `embed own samples` on.
- **samples**: the own samples kept in this browser, with `import audio`, a
  `delete` key per sample (asks first) and the storage they use.
- **open .ns4p**: reads a Stage 4 program (format 3.07–3.13) with the strict
  reader in `web/src/ns4/`; all 955 fields fill the editor, and the print-out
  lists what the editor does not play.
- **Stage-4-Programm (experimentell)** (`stage-4-programm (experimentell) ↓`,
  after a confirmation): writes a `.ns4p` file named after the program (the
  Stage 4 shows the file name as the program name). It patches a donor, the
  opened program when it is format 3.13, the neutral template otherwise, and
  passes a verification (parsed again, every field compared, undecoded bits
  unchanged) before it downloads. That proves the structure, not that a
  Stage 4 accepts it: untested on hardware, so load it into a free slot.
- **report ↓**: a plain-text parameter report of every value that differs from
  the editor's init program, with section, layer, label, value and unit, and
  markers for values that are not verified or not implemented. It is for
  reading (for example to set a sound up by hand) and not a program file.

## Limits

- The sound is an approximation of the Stage 4, not its engine. No Nord
  samples, no Wave oscillators, no real pianos (see What plays). The layer
  effects, morph scaling, MIDI CC scaling and extern encodings are
  assumptions (nv); nothing of it is tested on a Stage 4.
- The AudioWorklet engine (band-limited Sync, Shape, Shape Sine, Multi and
  Super, the LP M ladder and drive) loads at audio start; until then, and in
  browsers without AudioWorklet, the native voice plays and marks those
  controls coarse.
- About a fifth of a Stage 4 file is not decoded, so the export keeps the
  donor's undecoded bits, which may depend on values you changed.
- The export is experimental and untested on hardware.
- Layer enable bits, scene handling and the organ and piano layer bits are
  assumptions, unverified on hardware, as are the curves and units marked nv.
- Arpeggiator: the free rate's BPM curve, the master clock divisions, the
  range curve and how KB sync and the master clock's keyboard sync combine
  are guesses (marked nv). The pattern content (accent, step length, pan) is
  not decoded, so a pattern plays every step alike; only its step count is
  used.

Plan and decisions: `docs/editor-plan.md`; what is known about the Stage 4:
`docs/editor-feasibility.md`; design spec: `docs/web-design.md`.

## Development

```sh
cd web
npm test             # unit tests of the editor and web/src/ns4
npm run typecheck    # tsc --noEmit, strict
npm run gen:editor   # regenerate the editor's tables, label golden and bundled template
OPENNORD=/path/to/opennord npm run gen   # regenerate the Stage 4 layout and tables, then gen:editor
cd ..
python3 -I -m unittest discover -s tests -t .   # the generated files equal a fresh render
```

- `web/src/editor/`: the editor (model, audio, MIDI, input, formats, UI).
- `web/src/ns4/`: the Stage 4 program code the editor builds on: the CBIN
  container, the layout, the strict reader and writer (`Ns4Program`), the
  neutral donor template (`templates/regressionTest.ns4p`, bundled as
  `generated/template-bytes.ts`) and the verify step of the export. No Node or
  DOM APIs.
- Generated files are committed, so building and testing need neither Python
  nor an opennord checkout. Python 3.9 or newer (standard library only) is
  used only by the generators in `tools/` and their check in `tests/`:
  `tools/gen_layouts.py` writes `web/src/ns4/generated/layout-ns4.ts`,
  `tables-ns4.ts` and the Python data in `tools/ns4data/` from an opennord
  checkout; `tools/gen_editor_tables.py` writes
  `web/src/editor/generated/display-ns4.ts`,
  `web/test/editor/labels-golden.json` and
  `web/src/ns4/generated/template-bytes.ts` from `tools/ns4data/` and
  `templates/`, without opennord.

## Deployment

The site is built for the base path `/nord/` (`base` in `web/vite.config.ts`).
Deploy the contents of `web/dist/` as static files under that path on any
static host; nothing runs on the server. The app version shown in presets and
reports comes from `web/package.json`.

The live copy at https://www.thilkolimbeck.com/nord is a Vercel project (root
directory `web`) that the portfolio proxies. `web/vercel.json` maps `/nord`
and `/nord/*` to the static files and gives the site its own security
headers, because a proxied response keeps only the upstream's headers: a
strict CSP (`default-src 'none'`, same-origin scripts, styles and fonts only,
no inline code), so the page cannot load code from or connect to any other
host.

## Licence and credits

AGPL-3.0-or-later (see `LICENSE`). The Stage 4 layout and display tables
derive from OpenNord (AGPL-3.0-or-later) and, through it, from ns4decode
(MIT); the donor template is ns4decode's regression fixture. Attribution and
the MIT notice are in `NOTICE`. The fonts are self-hosted under the SIL Open
Font License (`web/public/fonts/LICENSES/`).

Nord and Nord Stage are trademarks of Clavia DMI AB. This project is not
affiliated with, endorsed by, or supported by Clavia.
