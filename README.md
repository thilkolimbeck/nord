# nord-convert

Converts Nord Stage 3 programs (`.ns3f`) to Nord Stage 4 programs (`.ns4p`).
Python 3.9 or newer, standard library only. Phase 1: programs only.

The conversion is a faithful parameter mapping, not a sound match: the two
instruments have different engines, and even Nord Sound Manager (v9.10+, which
also converts Stage 3 programs) says some settings cannot be mapped. Every
setting that is lost or approximated is reported, unless it sits at its
Stage 3 default.

## Usage

```sh
python3 convert.py "My Program.ns3f"                 # writes My Program.ns4p next to it
python3 convert.py "My Program.ns3f" out/            # into a directory
python3 convert.py "My Program.ns3f" other-name.ns4p
python3 convert.py stage3-backup/ converted/         # every .ns3f in a directory
python3 convert.py "stage3-backup/*Pad*.ns3f" converted/   # a glob (quote it)
```

Options: `--force` replaces existing outputs (they are never replaced
otherwise), `--template PATH` uses another donor `.ns4p`, `-q` prints errors
only, `-v` also reports settings in sections that are switched off (see
Warnings). A directory or glob only picks up `.ns3f` files. The program name
is the file name on both instruments, so the output keeps the input's name.

Exit status: 0 when every file converted, 1 when at least one failed (a batch
still converts the others), 2 for a usage error such as no matching input.

Safety:

- Inputs are only read. An output path that is the input is refused.
- Each output is built in memory, parsed again with the strict reader and
  compared field by field with the plan (and every undecoded bit with the
  template) before it is written, through a temporary file and an atomic
  rename. A file that fails this check is not written.
- Damaged inputs (bad checksum, broken block chain, wrong model) are refused.

## Warnings

Warnings go to stderr, one line per conversion rule or section that loses or
approximates something; one line can name several fields, for example:

```
WARNING: My Program.ns3f: Panel A effects: ampBass=20 not converted: in filter mode it is the dry/wet mix, which has no confirmed Stage 4 field
```

A setting at its Stage 3 default is never reported. An all-default program
converts without a single warning.
The mappings listed under "Copied without proof" (see Limitations) are never
reported, nor are the rules Nord Sound Manager confirms (see How it maps),
unless they lose something or depend on the Stage 4's library.

Settings of a section that is switched off in the source (an engine that is
off, an inactive panel, an effect unit that is off or whose source engine
does not play) still convert, so the sound is right when you switch the
section on, but their reports are hidden: the summary line counts them, and
`-v` prints them, marked "(switched off in the Stage 3 program)".

## How it maps

- **Panels to layers.** Panel A becomes layer A and Panel B layer B of the
  organ, piano and synth sections in scene I. A layer plays when its panel is
  active and the engine is on. Synth layer C stays off. Scene II keeps the
  Stage 4 defaults (piano layer A on), as Nord Sound Manager leaves it, with
  one deviation: its piano section stays off when piano A has no converted
  piano, so scene II never plays a piano the program does not name. When the
  Stage 3 piano A is off, scene II still plays it; that is reported.
- **Shared tables copy.** Envelope times, levels, effect amounts and the like
  use the same display tables on both models, so their values copy. Bipolar
  values are re-encoded (offset to two's complement).
- **Nord Sound Manager's rules.** Three Nord Sound Manager conversions (kept
  private) confirm these: filter cutoff +24 steps (two octaves) when key
  tracking is on; resonance × 3/4 and reverb amount × 7/8, rounded down (a
  negative resonance morph toward zero, seen once); cutoff and resonance
  pedal morphs with the same rules (wheel and aftertouch use the same fields,
  see Copied without proof); osc ctrl 36 on a Super oscillator; Saw + 4
  Detune → Pure Saw; delay tempo and rotor and horn angles (one program)
  copy; per-layer effects for piano and synth; the keyboard hold switch of
  synth layers A and B copies.
- **Keyboard zones.** Each zone becomes the Stage 4 value that plays the same
  zones under the active split points; among several, the one that also
  shows them with all three split points on, as Nord Sound Manager picks.
- **Name hashes.** The Stage 3 stores piano and sample ids offset-encoded:
  Stage 4 id = Stage 3 id + 0x80000001 (mod 2^32), so its "none" 0x7FFFFFFF
  becomes 0. A piano Nord Sound Manager is seen to replace gets its
  replacement (Royal Grand 3D XL's legacy id → its Stage 4 id, HonkyTonkUpright
  Lrg → Amber Upright XL, seen once; entry 0); another id the Stage 4 piano
  list knows is kept and reported. A Sample oscillator (one seen) becomes a
  Stage 4 sample layer with the same sample, reported, because the sample
  must be on the Stage 4.
- **Extern.** Each panel's bank, program and control pedal switch go to the
  synth layer of that panel, with the send-on-load switch of the selected
  parameter (CC, PC or Vol), as Nord Sound Manager copies them. The velocity
  curve, the wheel, aftertouch, swell and volume pedal switches and the CC
  value go along too (same names and ranges, see Copied without proof).
  Extern stays off on the layer and the MIDI channel is a Stage 4 setting, as
  Nord Sound Manager does; both are reported.
- **Enums by label.** Split notes (the Stage 4 adds C2 at the bottom), voice
  mode, filter types, effect types, amp types and reverb types are matched by
  name. "1" variants (Room 1, Chorus 1, ...) become the Stage 4 base type, "2"
  variants its variation.
- **Mod envelope.** The Stage 3 mod envelope becomes the filter envelope
  (filter mod +60 = amount 127, rounded down). With filter mod at 0 the filter
  envelope keeps the attack but gets decay and release 127 and velocity on, as
  Nord Sound Manager writes. When osc mod is positive the mod envelope is also copied to
  the osc envelope, with the same -60..+60 amount. The filter Mod knob is the
  velocity amount left of centre, which has no Stage 4 counterpart (see
  below); the osc Mod knob is the LFO amount left of centre.
- **LFO rate** copies: both models use the same rate tables, to within one
  rounding step, free-running and clock-synced.
- **Effects** follow their source: Effect 1/2, delay and amp go to the effects
  block of their source's layer (organ, piano A/B, synth A/B); compressor and
  reverb, which act on the whole Stage 3 panel, go to every block of the
  panel. The Stage 4 has one organ effects block: it takes Panel A's organ
  effects, or Panel B's when only Panel B's organ plays.
- **Header.** Category "unset" (0xFFFFFFFF) becomes 17 "None", real ids copy.
  Bank and location are 0 (place the program with Nord Sound Manager).
- **Template.** About a fifth of a Stage 4 file is not decoded, so outputs are
  patched into a donor program (`templates/regressionTest.ns4p`, MIT, from
  ns4decode). Before use every known field is reset to its Stage 4 default and
  every scene I section and layer is switched off, so nothing of the donor's
  sound leaks. Undecoded bits stay as the donor has them, except three small
  fields Nord Sound Manager always writes the same way (2 bits = 1 in each
  synth layer, 3 bits = 5 in the organ, 2 bits = 0 in each synth sound).

## Limitations

### Not converted (reported when not at default)

| Stage 3 setting | Field | Why |
|---|---|---|
| Synth preset reference | `synthCommonA.presetNameHash` | Stage 3 synth presets are not in the Stage 4 library; the sound itself converts parameter by parameter |
| Sample of an oscillator not on the Sample bank | `synthA.smpNameHash` | only a Sample oscillator takes its sample along (as a Stage 4 sample layer) |
| Piano sound unknown to the Stage 4 | `pianoA.nameHash` | the decoded id is not in the Stage 4 piano list |
| Arpeggiator range | `synthA.arpRange` | the Stage 4 range scale is unknown |
| Amp dry/wet in LP24/HP24 filter mode | `effectsA.ampBass` | no confirmed Stage 4 field |
| Inactive organ drawbar preset | `organPresetIIA.db1` | a Stage 4 organ layer holds one preset |
| Rotary on piano or synth | `effectsA.leslieEnable` | only the Stage 4 organ has a rotary |
| Second panel's organ effects | `effectsB.fx1Enable` | one Stage 4 organ effects block |
| Osc 2 pitch | `synthA.dualOscDetune` | the Stage 4 analog oscillators and sample layers have no second-oscillator pitch |
| Filter velocity amount (filter Mod left of centre) | `synthA.fltMod` | the Stage 4 filter has only a velocity switch for its envelope, no velocity amount |
| Dual keyboard | `common.dualKbdEnable` | the Stage 4 handles a second keyboard differently |
| Extern on/off and MIDI channel | `externA.enable` | the values go to the synth layer with extern off; switch it on there, set the channel on the Stage 4 |
| Extern zone, octave, pitch stick, sustain, volume value, CC number, unselected send-on-load switches | `externA.kbZone` | no Stage 4 extern setting; the CC number has another range (scale unverified); the Stage 4 has one send-on-load switch |
| Mixer audio routing | `mixerA.audioRouteProg` | different routing model |
| Morph assignments other than filter cutoff and resonance | `synthA.fltLFOAmt.morphWheel` | the Stage 4 morph encoding is not mapped yet |

### Approximated (converted, and reported)

- Oscillators: the hand table covers PURE (no configuration), SYNC (3 Sync),
  SHAPE (2 Shape: triangle, saw, square), Saw + 4 Detune → Pure Saw (as Nord
  Sound Manager converts it; the detuned second oscillator is lost),
  Saw + 8 MixSqr with osc 2 at Sub → Sub Square Saw, and the Super waves. Any
  other configuration becomes the Pure version of the base wave. Wave and
  Formant banks, and a Sample bank without a sample, keep the Stage 4 default
  wave.
- Osc ctrl is copied as is, though what it controls depends on the oscillator
  (on a sample layer it is unverified whether it is used); a Super oscillator
  gets 36, as Nord Sound Manager writes.
- Pianos: HonkyTonkUpright Lrg becomes Amber Upright XL, and a substituted
  piano gets entry 0, as Nord Sound Manager converts it. Any other piano the
  Stage 4 piano list knows keeps its id, though Nord Sound Manager may
  substitute a different one.
- A Sample oscillator refers to its sample by id: the sample must be on the
  Stage 4 (restore or relink it in Nord Sound Manager). Its fast attack is lost.
- Piano touch 3 becomes 2 (the Stage 4 has three settings).
- The filter LFO amount and a negative osc mod (LFO amount) go to the Stage 4
  LFO, which has one destination; the filter LFO wins, the osc mod is then
  reported as lost. Depth scaling is unverified, so the amount is reported.
- Piano layer detune (Off/1/2/3) becomes the same Unison level on both Stage 4
  piano layers: the Stage 3 detunes the two layers against each other, the
  Stage 4 detunes within each layer.
- Vibrato Delay 1-3 become DLY with the Stage 4 default delay time.
- Octave shifts beyond ±2 are clamped (the Stage 4 range).
- Amp type Clean has no model on the Stage 4; the EQ is kept with the model off.
- The organ vibrato/chorus selector (one on the Stage 3) sets all three Stage 4
  selectors: B3 in the same V1 C1 V2 C2 V3 C3 order, Vox and Farfisa by the
  labels the Stage 3 shows for them (a C position reads as the next V or C
  step). C3 has no Vox setting; it is reported when a Vox plays. Open
  difference: Nord Sound Manager keeps the Stage 4 defaults for Vox (V3) and
  Farfisa (V2) and sets only B3 (seen with V1 in all three conversions).
- Scene II plays piano layer A even when the Stage 3 piano A is off (the
  Stage 4 default, kept as Nord Sound Manager does).
- Zones that cannot be played with the active split points become the whole
  keyboard.
- Format 3.00 files: a free-running delay time stays on the old 0-127 scale.
- Unknown header categories become "None".

### Copied without proof

These copy directly; the reasoning is sound but no hardware or paired file
has confirmed it: glide, arpeggiator rate and direction, organ vibrato
position order, percussion switches, compressor amount, reverb Bright →
BRIGHT, Panel B focus → layer B focus, keyboard hold switched on, piano
touch other than 0 (only 0 was seen), piano soft release, string resonance
and pedal noise (the same bits on both models),
rotary speed and stop mode (the Stage 3 packs both into one field), the
filter cutoff and resonance morphs on wheel and aftertouch (the same fields
as the pedal's, which is confirmed), and the extern velocity curve, wheel,
aftertouch, swell and volume pedal switches and CC value (same names and
ranges). A sample
program pair (kept private) confirms the container, the block chain, the
panel-to-layer structure and about 30 values; its Stage 4 file was edited by
hand, so it is not ground truth for values. Three Nord Sound Manager
conversions (kept private) now confirm the rules listed under How it maps,
each seen at least twice or exact by arithmetic, except four seen once: the
HonkyTonkUpright Lrg substitute, the Sample oscillator layer, a negative
resonance morph rounded toward zero and the rotor and horn angles. Switching
the scene II piano off without a converted piano A is the converter's own
choice.

### Not read

The Dual-KB style while Dual KB is off.

## Development

```sh
python3 -m unittest discover -s tests
python3 -I -m unittest discover -s tests -t .   # isolated mode
```

Many tests build their inputs from a sample program pair that is kept private:
`presets/` (with its expected values in `presets/expected-mapping.json`),
`web/test/fixtures/presets/` and `web/test/golden/golden-local.json` are
gitignored. Without them, as in a fresh clone, those tests are skipped with
that reason; the rest still run.

`nordconv/_layout_*.py` and `nordconv/_tables_*.py` are generated from an
opennord checkout by `tools/gen_layouts.py` and kept in the repository, so the
converter needs no Node. Background: `docs/phase1-mapping.md`.

## Web engine (TypeScript)

`web/src/engine/` is a line-by-line TypeScript port of `nordconv` for the
browser: `convert(input, template, name?)` returns the `.ns4p` bytes, the
warnings and the notes, runs the same verification before it returns, and
throws `NordFormatError` with the Python message for a damaged input. The donor
template is bundled (`TEMPLATE_BYTES`), so the browser needs no fetch. The
engine uses no Node or DOM APIs. It needs Node 22.14 or newer for the tests.

```sh
cd web
npm install
npm test             # parity with Python on every fixture, plus engine unit tests
npm run typecheck    # tsc --noEmit, strict
OPENNORD=/path/to/opennord npm run gen   # regenerate tables, template and golden files
```

`npm run gen` runs `tools/gen_layouts.py`, which writes the Python modules and
`web/src/engine/generated/` from the same opennord sources, then
`tools/make_golden.py`, which writes the bundled template and
`web/test/golden/golden.json` from the Python converter. The fixtures in
`web/test/fixtures/ns3/` are the ns3-program-viewer test programs (GPL-3.0; see
the licence file next to them); `python3 -I tools/make_golden.py --viewer PATH`
copies them again from a viewer checkout. The golden file also holds damaged
and edge-case inputs built from one of them. When the private sample is
present, `make_golden.py` copies it to `web/test/fixtures/presets/` and writes
its expected results to `web/test/golden/golden-local.json` (both gitignored);
`golden.json` is the same either way. Python is the reference: after a change
to `nordconv`, regenerate the golden files and make the TypeScript port pass
again.

## Web app

`web/` also holds the browser page for the engine (Vite and TypeScript, no UI
framework, no runtime dependencies). It converts one file at a time, entirely
in the browser: the file is never uploaded, and the page makes no requests
beyond its own static files (fonts are self-hosted in `web/public/fonts/`).

```sh
cd web
npm install
npm run dev          # development server
npm run build        # static site in web/dist/
npm run preview      # serve web/dist/ locally
```

The site is built for the base path `/nordconvert/` (`base` in
`web/vite.config.ts`). Deploy the contents of `web/dist/` as static files under
that path on any static host; nothing runs on the server. The engine version in
the page comes from `web/package.json`. Design spec: `docs/web-design.md`.

The live copy at https://thilkolimbeck.com/nordconvert is a Vercel project
(root directory `web`) that the portfolio proxies. `web/vercel.json` gives
it its own security headers, because a proxied response keeps only the
upstream's headers: a strict CSP (`default-src 'none'`, same-origin scripts,
styles and fonts only, no inline code), so the page cannot load code from or
connect to any other host.

## Licence

AGPL-3.0-or-later (see `LICENSE`). The layouts and tables derive from
OpenNord (AGPL-3.0-or-later) and, through it, from ns4decode (MIT); the
template is ns4decode's regression fixture. Attribution and the MIT notice are
in `NOTICE`.

Nord and Nord Stage are trademarks of Clavia DMI AB. This project is not
affiliated with, endorsed by, or supported by Clavia.
