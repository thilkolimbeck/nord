# Web app design spec (/nordconvert)

Approved by Thilko on 2026-10-31 (second mockup). This file is the design source of truth for `web/`. The Style Guide of the portfolio does NOT apply.

## Direction

- Modern parts (header, intro, sections 02–04, footer): cues from teenage.engineering and nothing.tech. Off-white page, small mono labels, numbered sections, lots of air, hairlines, flat.
- The converter: a wide vintage-synth instrument strip. Flat colour blocks only.
- Not kitsch: every control-looking element works. No photoreal textures (wood, brushed metal, screws), no scanlines, no CRT glow, no shadows or gradients, no decorative knobs.
- Never: Nord logos, Nord red panel colour or trade dress; teenage.engineering or Nothing logos, proprietary typefaces (NDot etc.), product imagery.

## Tokens

| Token | Light | Dark |
|---|---|---|
| page | `#f1f1ee` | `#0f0f0e` |
| text | `#141414` | `#ecece7` |
| text-muted | `#55554f` | `#a6a6a0` |
| legend (labels) | `#6b6b66` on page; `#8a8a84` on panel | `#8a8a84` |
| hairline | `#d6d6d0` | `#2c2c2a` |
| panel | `#1b1b1b` (both themes) | `#1b1b1b`, plus 1px `#2c2c2a` border |
| panel hairline | `#343434` | `#343434` |
| panel text | `#e9e9e4` / `#cfcfc9` | same |
| display bg | `#0c0c0c`, 1px `#2e2e2e` | same |
| accent (signal orange) | `#ff6a1a` | `#ff6a1a` |
| accent dim (display 2nd line) | `#b0581f` | `#b0581f` |
| key | `#262626`, 1px `#333` | same |
| segment off | `#2d2d2d` | same |
| paper (print-out) | `#fbfbf9`, 1px `#d6d6d0` | `#1a1a18`, 1px `#2c2c2a`, text `#d6d6d0` |

Theme follows `prefers-color-scheme`. Accent is the only hue; error state uses accent + the word "error" + a filled error segment row, never a second red.

## Type (all OFL, self-hosted woff2 in `web/public/fonts/`, latin subset)

- Funnel Sans 400/500: headline (24px/500, line-height 1.2, max 32ch) and body copy (13–16px).
- IBM Plex Mono 400/500: legends 11px (+0.03em tracking, lowercase), print-out 12px/1.75, header wordmark 13px.
- Doto 600/800: the display only (line 1: 24px/800; lines 2–3: 14px/600).
- Legends and labels are lowercase. Sentence case in copy.

## Layout (top to bottom)

1. Header row, hairline below: wordmark `st3 → st4` + muted `program converter` left; nav right: `01 convert  02 how  03 limits  04 source` (in-page anchors).
2. Headline: "Turn a Nord Stage 3 program into a Stage 4 program. In your browser."
3. Sub line (text-muted, 13px): "Your file never leaves this page. Not yet tested on a real Stage 4: load results into a free slot." (hardware note; keep until the Gab test passes)
4. Instrument strip (`#1b1b1b`, radius 14px):
   - top legend row, panel hairline below: left `st-34  program converter`, right `engine <version> · stage 3 3.00–3.04 → stage 4 3.13`.
   - four sections in a grid `1.1fr 2fr 1fr auto`, each with a legend on top, separated by panel hairlines:
     - **program in**: dashed 1px `#555` drop slot, text "drop .ns3f / or choose" (choose = the visually-hidden `<input type=file accept=".ns3f">`'s label). Drag-over: border turns accent. Dropping more than one file: no conversion, display shows the error "one file at a time".
     - **display**: line 1 program name from the file name (uppercase in Doto, truncated with an ellipsis); line 2 `ns3f <ver> → ns4p 3.13`; line 3 state: `insert program` (idle) · `ready · press convert` · `panel a+b → layers a+b · ok` (which panels/layers come from the conversion) · `error · <short reason>`. The full error message from the engine goes to the print-out.
     - **result**: three rows of 6 segments with label + count: `warn` (segments lit `#e9e9e4`, one per warning, capped at 6, count shown), `notes` (switched-off notes), `error` (accent, all 6 lit on error).
     - **keys** 2×2, 58px squares, radius 9px, each with a 6px status LED top-left and a lowercase label bottom-left:
       - `convert` (accent fill; enabled once a file is loaded; LED lit when a file is ready),
       - `save` (downloads `<name>.ns4p`; LED accent when an output exists),
       - `clear` (resets to idle),
       - `notes` (toggles the switched-off notes in the print-out; LED lit while shown).
       Keys are real `<button>`s with focus-visible ring 2px accent, offset 2px; disabled keys stay dark at reduced opacity of their label only.
5. Print-out (paper), attached under the strip (inset 22px each side, no top border, bottom radius 6px): legend line `print-out · N warnings · M notes on switched-off parts` (the notes part is a button that toggles like the notes key); numbered lines `001  <message>` in mono. Show the engine's messages verbatim (they may be shortened only by CSS wrapping). Idle state: one line "nothing printed yet".
6. Sections `02 how it works`, `03 limits`, `04 source`: modern style, numbered mono heading, short copy:
   - 02: runs locally in the browser; both panels convert (panel A → layers A, panel B → layers B in scene I); values go through Stage 4's own tables; a donor template fills what's unknown.
   - 03: link to the README's limitation tables in the public repo; one-paragraph summary (synth presets not in the Stage 4 library, pianos and samples by id when the Stage 4 has them, most morphs, osc configurations without a Stage 4 counterpart).
   - 04: AGPL-3.0, link to the public GitHub repo, credits: opennord, ns4decode (MIT), ns3-program-viewer.
7. Footer legend line: `agpl-3.0 · source on github · not affiliated with clavia or nord`.

## Behaviour

- One file per conversion; no batch.
- No network requests after load except same-origin static assets; no analytics.
- Keyboard: the drop slot is reachable (label for the file input), keys are buttons, Enter/Space work.
- Motion: none beyond 150 ms colour transitions; respect `prefers-reduced-motion`.

## Editor (/nordconvert/editor)

Approved by Thilko on 2026-11-03 (checkpoint-1 mockup). Same tokens, fonts and rules as above; the editor is a sibling of the converter.

### Layout (desktop, max width 1200px, 24px page gutter)

1. Header row as on the converter: wordmark `st-4 → editor` + muted `sound programming`; nav right: `converter` (link to `/nordconvert/`), `how`, `limits`, `source`.
2. One instrument panel (`panel` token, radius 14px, padding 16px) holding, top to bottom:
   - **legend row** (panel hairline below): left `st-4 editor · sound programming · audio is an approximation`; right the status strip: `audio` with a 6px LED (accent = running, segment-off = idle, accent outline + word `blocked`/`error` otherwise) and a `start audio` key while not running; `midi` LED + short status (`connected: <name>` · `no inputs` · `permission denied` · `not supported in this browser` · `enable midi` key); `panic` key (also Esc).
   - **row 1** (grid `1.6fr 1fr`): the **display** (display tokens; line 1 program name, Doto 24px/800, accent, editable via a visually plain text input; line 2 last touched parameter `layer · label · value unit · min–max` in accent-dim Doto 14px; line 3 state: `live` / `not verified` / `edited N` / import info) and the **file keys** box (legend `files`): keys `save`, `load`, `app-preset ↓` (download), `import` (app preset), `open .ns4p`, `stage-4-programm (experimentell) ↓`, `report ↓`. Keys use the converter's key style (`key` token, radius 7px, 11px mono label), smaller than the converter's 58px squares: height 28px, padding 0 10px.
   - **row 2** (grid three equal columns): `program`, `organ`, `piano` regions.
   - **row 3**: the `synth` region, full width.
   - **row 4** (grid two equal columns): `extern`, `layer effects · rotary`.
   - **row 5**: the `keyboard` region, full width.
3. Print-out (paper) attached under the panel as on the converter: import notes, validation errors, export results; idle line "nothing printed yet".
4. Sections `how`, `limits`, `source` below, modern style as on the converter (limits: approximation, what is not implemented, export experimental and untested on hardware, browser support).
5. Footer legend line: `agpl-3.0 · source on github · not affiliated with clavia or nord`.

### Regions

- Region box: 1px panel-hairline border, radius 8px, padding 10px; legend (11px mono lowercase, legend colour) top-left.
- **Layout-only regions** (program, organ, piano, extern, effects, rotary): legend followed by a badge `not implemented` (11px mono, accent text, 1px accent border, radius 4px, padding 0 4px). Content: read-only readouts of the stored values (label + formatted value, 11px mono, legend colour), at most a few lines; collapsed to legend + badge + first line until expanded with a `show values` text button. Readouts are not in the tab order.
- **Synth region**: a layer strip on top: legend `synth`, layer keys `a` `b` `c` (key style; a 6px LED shows the layer enable, the focused layer has a 1px accent border; click focuses, a separate small `on/off` toggle per layer sets enable), then `level` and `pan` faders of the focused layer. Below, groups in a grid `repeat(4, minmax(0,1fr))`, gap 16px: `oscillator`, `filter`, `amp env`, `lfo · vibrato`; second row `voice`, `keyboard`, `osc env`, `arp` (arp stored-only). Group legend 11px mono.

### Controls

- **Fader** (every continuous parameter): grid `64px 1fr 64px`: label (11px mono, panel text), native `<input type="range">` styled as a 6px track (`segment off`) with the filled part in accent and a 12×12px square thumb in panel text colour (radius 2px); value + unit right-aligned (11px mono). Focus: 2px accent ring, offset 2px, on the thumb/track. Hover: none beyond 150ms colour change.
- **Enum**: native `<select>` styled flat: transparent background, 1px panel-hairline border, radius 4px, 11px mono, panel text; options keep the Stage 4 labels; options that are not implemented end with ` · not implemented`, unverified ones with ` · nv`.
- **Bool**: small key (height 22px) with a 6px LED, `aria-pressed`.
- **Status markers**: `not verified` → value text in accent-dim plus the suffix `nv` and a description `not verified: <note>` via `aria-describedby`; `stored` → the value plus the line `no sound in MVP` in legend colour; `coarse` (approximated by the native engine) → suffix `coarse` in accent-dim. Never a second hue.
- **Morph indicator** (non-zero morph on a control): a 4px accent dot after the label, with `aria-label` "morph: wheel +40" etc.; read-only.

### Keyboard region

- Legend: `keyboard · <low>–<high> · keys a s d f g h j k l · w e t y u o p · z/x octave` (show real key labels where the browser reports them).
- Keys: 3 octaves on desktop (C3–C6 default, shifting with octave), white keys panel-text colour `#e9e9e4` with bottom radius 4px, black keys `#262626` with 1px `#333`; a held key turns accent (both white and black). Height 96px white, 60px black. Velocity from the vertical position (top soft, bottom loud).
- Narrow screens (< 760px): regions stack in one column; layout-only regions show legend + badge only; synth groups 2 per row; keyboard shows 2 octaves with horizontal scroll inside the region (the page itself never scrolls sideways).

### Rules carried over

No shadows, gradients (the fader fill is a hard stop, not a gradient), textures or decorative knobs; every control-looking element works; no Nord logo, Nord red, Nord typefaces or product images; theme follows `prefers-color-scheme` (the panel is dark in both themes); motion only 150ms colour transitions, respecting `prefers-reduced-motion`.

### Editor: program, organ and piano regions (2026-11-03, live)

Same primitives as the synth region (fader, enum select, bool key, mask, status markers); the `not implemented` badge goes away for a live region, the "show values" toggle stays only for fields that remain read-only.

- **Layout change:** row 2 becomes `program` full width (one line of controls), row 3 `organ` and `piano` side by side (grid `1fr 1fr`), row 4 `synth` full width, then extern/effects and keyboard as before.
- **program:** layer scene keys `I` `II` (key style, the active one with a 1px accent border; switching the scene changes which `*_I`/`*_II` enables every region edits and plays); section keys `organ` `piano` `synth` with LEDs (section on/off in the active scene); split: three bool keys `low` `mid` `high` with LEDs plus a position select each (C2–C7 labels) and an `xfade` select; `transpose` fader (semitones); `master clock` fader (BPM, stored, `no sound in MVP`); morph assignment and preset references as read-only readouts behind "show values".
- **organ:** layer keys `a` `b` (enable LED + focus border, as the synth layer strip), `model` select, `level`; nine **drawbars** as vertical faders side by side (each a native range input drawn vertically via `writing-mode: vertical-lr` (no `direction: rtl`, which would put 0 at the bottom), 0 at top–8 at bottom as on a real drawbar, labels 16' 5⅓' 8' 4' 2⅔' 2' 1⅗' 1⅓' 1' under them, value 0–8 above, track `segment off`, fill accent); a group `perc · vibrato`: percussion on, 3rd/2nd (harmonic), fast, soft (bool keys), vibrato/chorus on + type select; a group `rotary`: speed slow/fast key, stop mode, drive and other rotary fields as faders/selects. Model-specific sets (Vox/Farf/Pipe drawbar labels) follow the manual's labels where the layout has them.
- **piano:** layer keys `a` `b` (as above), `type` select (Grand, Upright, Electric, Clav, Digital, Misc), `model` select listing the 295 piano names (grouped by type where the table allows) with the suffix ` · approximation`, `level`, `kb touch` select, `dyn comp`, `soft release`, `string res`, `pedal noise`, `timbre`, `unison`, clav settings where the layout has them; every sound-affecting control carries the status marker `approximation` (accent-dim suffix `≈`), never a claim to be the Nord sample.
- Region legends: `organ · approximation`, `piano · approximation (no nord samples)`.
