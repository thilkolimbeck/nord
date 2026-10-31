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
   - 03: link to the README's limitation tables in the public repo; one-paragraph summary (presets, pianos and samples by name, morphs, osc configurations without a Stage 4 counterpart).
   - 04: AGPL-3.0, link to the public GitHub repo, credits: opennord, ns4decode (MIT), ns3-program-viewer.
7. Footer legend line: `agpl-3.0 · source on github · not affiliated with clavia or nord`.

## Behaviour

- One file per conversion; no batch.
- No network requests after load except same-origin static assets; no analytics.
- Keyboard: the drop slot is reachable (label for the file input), keys are buttons, Enter/Space work.
- Motion: none beyond 150 ms colour transitions; respect `prefers-reduced-motion`.
