# Web app design spec (/nord)

Direction, tokens and type approved by Thilko on 2026-10-31 (second mockup, made for the Stage 3 → Stage 4 converter page); the editor on 2026-11-03 (checkpoint-1 mockup). The converter page was retired when the repository became nord (2026-11-04); its layout spec is in the git history (commit `babed27`). This file is the design source of truth for `web/`. The Style Guide of the portfolio does NOT apply.

## Direction

- No chrome (2026-11-04): the page opens straight into the instrument. The only texts and links are one small legend line at the foot of the panel (cues from teenage.engineering and nothing.tech: small mono labels, hairlines, flat).
- The instrument: a wide vintage-synth panel. Flat colour blocks only.
- Not kitsch: every control-looking element works. No photoreal textures (wood, brushed metal, screws), no scanlines, no CRT glow, no shadows or gradients, no decorative knobs.
- Never: Nord logos, Nord red panel colour or trade dress; teenage.engineering or Nothing logos, proprietary typefaces (NDot etc.), product imagery.

## Tokens

Every colour is a CSS custom property in the token block of `web/src/editor/editor.css`, defined once per theme (light first, dark in `@media (prefers-color-scheme: dark)`); components use only these properties (`test/editor/tokens.test.ts` checks that both themes define the same tokens and that no other rule hard-codes a colour). The theme follows `prefers-color-scheme`, without a toggle; the panel switches too. Dark is the look approved on 2026-11-03.

| Token | Light | Dark |
|---|---|---|
| page | `#f1f1ee` | `#0f0f0e` |
| text / text-muted | `#141414` / `#55554f` | `#ecece7` / `#a6a6a0` |
| legend (page) | `#6b6b66` | `#8a8a84` |
| hairline | `#d6d6d0` | `#2c2c2a` |
| panel | `#f1f1ee`, 1px `#d6d6d0` border | `#1b1b1b`, 1px `#2c2c2a` border |
| panel hairline (region borders; regions have no fill) | `#d6d6d0` | `#343434` |
| panel text / panel text 2 | `#141414` / `#3a3a36` | `#e9e9e4` / `#cfcfc9` |
| legend on panel | `#6b6b66` (4.73:1 on panel) | `#8a8a84` |
| display bg | `#e7e7e1`, 1px `#d0d0c9` | `#0c0c0c`, 1px `#2e2e2e` |
| accent (fills: LEDs, fader fill, held keys, morph dot) | `#ff6a1a` | `#ff6a1a` |
| accent text (display, badges, pressed-key border, alert outline, link hover) | `#b04000` (4.73:1 on display bg, 5.2:1 on panel) | `#ff6a1a` |
| accent dim (display 2nd line, `nv`/`coarse`/`≈` markers) | `#8a4a14` (5.5:1 on display bg, 6.0:1 on panel) | `#b0581f` |
| focus ring | `#b04000` | `#ff6a1a` |
| key (button), 1px border; hover border | `#ffffff`, `#c9c9c2`; `#8f8f88` | `#262626`, `#333333`; `#555555` |
| segment off (LED off, fader track) | `#dcdcd5` | `#2d2d2d` |
| on accent (label on a lit lamp key) | `#141414` | `#141414` |
| fader thumb | `#141414` | `#e9e9e4` |
| keyboard white keys | `#ffffff`, 1px `#c9c9c2` | `#e9e9e4` |
| keyboard black keys | `#262626` | `#262626`, 1px `#333333` |
| paper (print-out), text, legend | `#fbfbf9`, 1px `#d6d6d0`, `#141414`, `#6b6b66` | `#1a1a18`, 1px `#2c2c2a`, `#d6d6d0`, `#8a8a84` |

The accent `#ff6a1a` reaches only 2.5:1 on the light panel, so in light every accent used as text, outline or focus ring is accent text `#b04000`; fills stay `#ff6a1a`. Native controls follow the theme (`color-scheme: light dark` on the root, the panel included). Accent is the only hue; error state uses accent + the word "error", never a second red.

## Type (all OFL, self-hosted woff2 in `web/public/fonts/`, latin subset)

- Funnel Sans 400/500: headline (24px/500, line-height 1.2, max 32ch) and body copy (13–16px).
- IBM Plex Mono 400/500: legends 11px (+0.03em tracking, lowercase), print-out 12px/1.75.
- Doto 600/800: the display only (line 1: 24px/800; lines 2–3: 14px/600).
- Legends and labels are lowercase. Sentence case in copy.

## Behaviour

- No network requests after load except same-origin static assets; no analytics.
- Keyboard: every control is reachable and works with the keyboard; keys are real `<button>`s (Enter/Space) with a focus-visible ring 2px accent, offset 2px; disabled keys stay dark at reduced opacity of their label only.
- Switches (2026-11-04, Thilko's pick of three): every key with a pressed state is a lamp key, a flat unlit key in segment off with no border and no LED that lights up as a whole in accent with on-accent text when on. Action keys (files, oct, tap, panic, start audio) keep the white key, so the look tells a switch from an action. In forced-colors mode the lamp key gets a ButtonText border and a Highlight fill when on.
- Values never move the layout (2026-11-04): every control reserves its longest possible value text and markers (`--value-ch`, `--marks-ch`), value cells never wrap, and the rows of a group share columns through subgrid. The display shows "off" for a layer level of "volume off" and "N semi" for "N semitones"; screen readers get the full label.
- Keyboard region: the white keys and the controller faders are both 96px and start and end on the same lines; the controller values sit above and the captions below, on one line each.
- Motion: none beyond 150 ms colour transitions; respect `prefers-reduced-motion` (transitions drop to 0).

## Editor (/nord)

Approved by Thilko on 2026-11-03 (checkpoint-1 mockup). Same tokens, fonts and rules as above.

### Layout

Revised 2026-11-04: no chrome. No header, no sections, no separate footer; the skip links (`skip to program`, `skip to synth`, `skip to keyboard`) stay, visually hidden until focused, and the page has a visually hidden `h1`.

Desktop (≥ 760px): body margin 0, page padding 20px (plus the safe-area insets, `viewport-fit=cover`), no max width: the panel uses the full width and the regions keep their grids.

1. One instrument panel (`panel` token, 1px panel border, radius 14px, padding 16px) holding, top to bottom:
   - **legend row** (panel hairline below): left `st-4 editor · sound programming · audio is an approximation`; right the status strip: `audio` with a 6px LED (accent = running, segment-off = idle, accent-text outline + word `blocked`/`error` otherwise) and a `start audio` key while not running; `midi` LED + short status (`connected: <name>` · `no inputs` · `permission denied` · `not supported in this browser` · `enable midi` key); `panic` key (also Esc).
   - **row 1** (grid `1.6fr 1fr`): the **display** (display tokens; line 1 program name, Doto 24px/800, accent text, editable via a visually plain text input; line 2 last touched parameter `layer · label · value unit · min–max` in accent-dim Doto 14px; line 3 state: `live` / `not verified` / `edited N` / import info) and the **file keys** box (legend `files`): keys `save`, `load`, `app-preset ↓` (download), `import` (app preset), `open .ns4p`, `stage-4-programm (experimentell) ↓`, `report ↓`. Keys use the `key` token, radius 7px, an 11px mono label, height 28px, padding 0 10px.
   - **row 2**: `program`, full width.
   - **row 3** (grid two equal columns): `organ`, `piano`.
   - **row 4**: the `synth` region, full width.
   - **row 5** (grid two equal columns): `extern`, `layer effects`.
   - **row 6**: the `keyboard` region, full width, with the octave keys `oct −` `oct +` at the right of its legend line (they step the computer keys' octave, which the virtual keys follow; at a limit the key is `aria-disabled` and its label fades).
   - **print-out** (paper, radius 6px, compact strip): numbered lines `001  <message>` in mono, messages verbatim, shortened only by CSS wrapping: import notes, validation errors, export results; idle line "nothing printed yet". Collapsed it shows only its last line; with more than one line its legend is a toggle `print-out (n)` (`print-out · error (n)` for errors) that opens all lines. A new error opens it by itself. Every print is announced politely in full.
   - **colophon**: one legend line (11px mono, legend colour): `approximation of the nord stage 4 · not affiliated with clavia or nord · about · source · agpl-3.0`. `source` links to https://github.com/thilkolimbeck/nord; `about` is a `<details>`/`<summary>` that opens in place (on its own row) to short paragraphs in the same small style: how it works, limits (approximation, what is not implemented, export experimental and untested on hardware, browser support) and source (AGPL-3.0, credits: opennord, ns4decode (MIT)).

Narrow screens (< 760px; checked at 375×812 and 390×844):

- Page padding 12px (plus safe areas); the panel has no frame (no border, radius, padding or fill, 2026-11-04), so the regions use the full width inside the page gutter.
- One column, in this order: display and files, synth, organ, piano, program, extern and layer effects (legend + badge only), keyboard, print-out, colophon. `ui/panel.ts` reorders the DOM on the breakpoint (matchMedia), so the tab order follows the screen.
- The keyboard region sticks to the bottom of the viewport (`position: sticky; bottom: 0`, panel background, safe-area padding below); its legend line is cut with an ellipsis so the octave keys stay on the same line; about 1.5 octaves (11 white keys) are visible, the rest scrolls inside the region. `scroll-padding-bottom` keeps focused controls clear of it.
- The page never scrolls sideways (`scrollWidth === clientWidth`); wide content scrolls inside its region (keyboard, drawbars).

Touch (< 760px, or any `pointer: coarse` device such as a phone in landscape or a tablet): keys, selects, toggles and text buttons are at least 44×44px; faders keep their 6px track inside a 44px tall hit area; drawbars are 44px wide and scroll sideways inside the organ region when they do not fit. On iOS Safari only, selects use 16px text so the page does not zoom into them.

### Regions

- Region box: 1px panel-hairline border, radius 8px, padding 10px; legend (11px mono lowercase, legend colour) top-left.
- **Layout-only regions** (program, organ, piano, extern, effects, rotary): legend followed by a badge `not implemented` (11px mono, accent text, 1px accent border, radius 4px, padding 0 4px). Content: read-only readouts of the stored values (label + formatted value, 11px mono, legend colour), at most a few lines; collapsed to legend + badge + first line until expanded with a `show values` text button. Readouts are not in the tab order.
- **Synth region**: a layer strip on top: legend `synth`, layer keys `a` `b` `c` (key style; a 6px LED shows the layer enable, the focused layer has a 1px accent border; click focuses, a separate small `on/off` toggle per layer sets enable), then `level` and `pan` faders of the focused layer. Below, groups in a grid `repeat(4, minmax(0,1fr))`, gap 16px: `oscillator`, `filter`, `amp env`, `lfo · vibrato`; second row `voice`, `keyboard`, `osc env`, `arp`. Group legend 11px mono.

### Controls

- **Fader** (every continuous parameter): grid `64px 1fr 64px`: label (11px mono, panel text), native `<input type="range">` styled as a 6px track (`segment off`) with the filled part in accent and a 12×12px square thumb in panel text colour (radius 2px); value + unit right-aligned (11px mono). Focus: 2px accent ring, offset 2px, on the thumb/track. Hover: none beyond 150ms colour change.
- **Enum**: native `<select>` styled flat: transparent background, 1px panel-hairline border, radius 4px, 11px mono, panel text; options keep the Stage 4 labels; options that are not implemented end with ` · not implemented`, unverified ones with ` · nv`.
- **Bool**: small key (height 22px) with a 6px LED, `aria-pressed`.
- **Status markers**: `not verified` → value text in accent-dim plus the suffix `nv` and a description `not verified: <note>` via `aria-describedby`; `stored` → the value plus the field's stored line in legend colour (`stored setting, no sound` by default; `pedal assignment, stored` for the pedal switches, `samples mode only · not implemented (no nord samples)` for the sample options); `coarse` (approximated by the native engine) → suffix `coarse` in accent-dim. Never a second hue.
- **Morph indicator** (non-zero morph on a control): a 4px accent dot after the label, with `aria-label` "morph: wheel +40" etc.; read-only.

### Keyboard region

- Legend: `keyboard · <low>–<high> · keys a s d f g h j k l · w e t y u o p · z/x octave` (show real key labels where the browser reports them).
- Keys: 3 octaves on desktop (C3–C6 default, shifting with octave), keyboard white and black key tokens (see Tokens), white keys with bottom radius 4px; a held key turns accent (both white and black). Height 96px white, 60px black. Velocity from the vertical position (top soft, bottom loud). Octave keys `oct −` `oct +` in the legend line.
- Narrow screens (< 760px): regions stack in one column; layout-only regions show legend + badge only; synth groups 2 per row; the keyboard sticks to the bottom of the viewport and shows about 1.5 octaves with horizontal scroll inside the region (the page itself never scrolls sideways).

### Rules carried over

No shadows, gradients (the fader fill is a hard stop, not a gradient), textures or decorative knobs; every control-looking element works; no Nord logo, Nord red, Nord typefaces or product images; theme follows `prefers-color-scheme`, the panel included; motion only 150ms colour transitions, respecting `prefers-reduced-motion`.

### Editor: program, organ and piano regions (2026-11-03, live)

Same primitives as the synth region (fader, enum select, bool key, mask, status markers); the `not implemented` badge goes away for a live region, the "show values" toggle stays only for fields that remain read-only.

- **Layout change:** row 2 becomes `program` full width (one line of controls), row 3 `organ` and `piano` side by side (grid `1fr 1fr`), row 4 `synth` full width, then extern/effects and keyboard as before.
- **program:** layer scene keys `I` `II` (key style, the active one with a 1px accent border; switching the scene changes which `*_I`/`*_II` enables every region edits and plays); section keys `organ` `piano` `synth` with LEDs (section on/off in the active scene); split: three bool keys `low` `mid` `high` with LEDs plus a position select each (C2–C7 labels) and an `xfade` select; `transpose` fader (semitones); `master clock` fader (BPM, live) followed by a `tap` key (key style without LED, 2026-11-04: four taps or more set the tempo), the clock's `kb sync` select and the `tap pedal` switch (stored, `pedal assignment, stored`); morph assignment and preset references as read-only readouts behind "show values".
- **organ:** layer keys `a` `b` (enable LED + focus border, as the synth layer strip), `model` select, `level`; nine **drawbars** as vertical faders side by side (each a native range input drawn vertically via `writing-mode: vertical-lr` (no `direction: rtl`, which would put 0 at the bottom), 0 at top–8 at bottom as on a real drawbar, labels 16' 5⅓' 8' 4' 2⅔' 2' 1⅗' 1⅓' 1' under them, value 0–8 above, track `segment off`, fill accent); a group `perc · vibrato`: percussion on, 3rd/2nd (harmonic), fast, soft (bool keys), vibrato/chorus on + type select; a group `rotary`: speed slow/fast key, stop mode, drive and other rotary fields as faders/selects. Model-specific sets (Vox/Farf/Pipe drawbar labels) follow the manual's labels where the layout has them.
- **piano:** layer keys `a` `b` (as above), `type` select (Grand, Upright, Electric, Clav, Digital, Misc), `model` select listing the 295 piano names (grouped by type where the table allows) with the suffix ` · approximation`, `level`, `kb touch` select, `dyn comp`, `soft release`, `string res`, `pedal noise`, `timbre`, `unison`, clav settings where the layout has them; every sound-affecting control carries the status marker `approximation` (accent-dim suffix `≈`), never a claim to be the Nord sample.
- Region legends: `organ · approximation`, `piano · approximation (no nord samples)`.
