# Nord Stage 3 → Stage 4 converter: Phase 1 mapping

Sample: a sample program pair (kept private), one `.ns3f` (592 B) and one `.ns4p` (868 B). Both files were only read, never changed.
Legend: **[V]** checked by decoding the sample bytes, **[R]** read in reference code only, **[I]** inference.

The detailed evidence (file:line citations, full field dumps of the pair) is kept private with the sample pair.

## 1. Headline findings

1. **Both formats are fully framed and checksummed, so we can write a valid file.** [V] Each has a 44-byte CBIN header, then a body of 19 (NS3) or 24 (NS4) length-prefixed blocks of MSB-first bit fields. The checksum is `zlib.crc32(file[0x2C:])`, stored LE at 0x18. Rebuilding both samples from their parsed fields reproduces them byte for byte.
2. **Every NS3 bit decodes. NS4 does not:** the public map covers about 80–84 % of the 824 body bytes, and the rest is unknown. A writer therefore has to *patch a donor `.ns4p`*, not serialise one from scratch. This is how opennord works, and it means the unknown bytes come from the template.
3. **The sample's `.ns4p` is a reworked version of its `.ns3f`, not a mechanical conversion.** [V] The structure matches (Panel A → layer A, Panel B → layer B), but many values were changed by hand on the Stage 4. **So it confirms the structure, not the value mapping.** The converter shouldn't be tuned to reproduce it.
4. **Nord Sound Manager v9.10+ (Mar 2025) converts NS3 → NS4 officially** and writes a conversion log. Nord's own page says some NS3 oscillator configurations "can not be mapped".
5. **Prior art:** opennord (AGPL-3) has an NS3 → NS4 migrator. It converts **only Panel A** and skips morphs, arp and rotary. Its tests use synthetic files only, and its docs say the output "hasn't been compared by ear on a real Stage 4".

## 2. Format summary

| | Stage 3 `.ns3f` | Stage 4 `.ns4p` |
|---|---|---|
| Encoding | binary, CBIN container | binary, CBIN container |
| Header 0x00–0x2B | `CBIN`, u32 LE 1, tag, u16 bank, u16 location, u32 category, u32 version×100, u32 CRC-32, 16 × 0 | same layout |
| Version | 304 (3.04) | 313 (3.13) |
| Body | u32 BE version + 19 blocks, 548 B | u32 BE version + 24 blocks, 824 B |
| Field encoding | MSB-first bit fields; bipolar = `offset` | MSB-first; bipolar = two's complement |
| Program name | **filename only** (not in the file) | filename only |
| Structure | 2 panels (A/B) × organ, piano, synth, extern + per-panel FX routed by source | 2 scenes × organ (2 layers), piano (3 layers), synth (3 layers), extern; FX per section/layer |
| Morphs | 7-bit deltas | different width/encoding |

Display tables (ms, Hz, dB) are **identical** between models at every point checked, so most continuous parameters copy by value. Bipolar ones must be re-encoded (offset → two's complement), never bit-copied.

## 3. Mapping table

**mapped** = same meaning, copy the value · **transformed** = deterministic rule · **lossy** = approximation, logged · **unmappable** = no or unknown NS4 counterpart, logged and left at the template value.

| NS3 | NS4 | Status | Rule / note |
|---|---|---|---|
| Header magic, version, CRC | same | transformed | tag `ns4p`, 313 in header and body, CRC last |
| Header category | category | transformed | real id copies; `0xFFFFFFFF` (unset) → 17 "None" **(confirm)** |
| Header bank/location | bank/location | transformed | grids differ (16×25 vs 8×64) **(policy?)** |
| Split on/off, points, widths | common.split* | mapped | position NS4 = NS3 + 1 (one point checked) |
| Panel enable A/B/A&B | scene I layer enables | transformed | Panel A → layer A, Panel B → layer B; scene II stays at template |
| Engine kbZone | layer kbZone | transformed | same zone meaning via NS4 split-dependency table |
| Synth level, unison, filter freq/drive/kbd-track/type, amp env A/D/R, reverb amount, fx rate/amount | same | mapped | copy (shared tables; filter type order identical) |
| Voice mode | voiceMode | transformed | enum remap (Mono checked) |
| Filter mod (±60) | filter env amount / – | transformed / unmappable | `+v → round(v·127/60)`; negative is the **velocity** amount (ns3-program-viewer ns3-synth-filter.js), not the LFO: no NS4 counterpart, warn *(corrected after review, 31 Oct 2026)* |
| Osc mod (±60) | osc env amount / LFO→osc | transformed | same scale rule |
| Mod env A/D/R/vel | filter env (and osc env if osc mod ≠ 0) | transformed | **opennord uses osc env only; the sample pair uses the filter env (confirm)** |
| Classic wave + config + detune | osc bank/category/wave | **lossy** | hand table; 2 known points (MixSqr+Sub saw → Sub Square Saw; Detune saw → Multi Saw); unknown configs → warn |
| Osc ctrl | oscCtrl | **lossy** | meaning depends on config; copy + warn or leave |
| Wave/Formant/Super/Sample osc | oscBank / sample | lossy / unmappable | banks differ; samples need a catalog |
| LFO wave/rate/clock | lfo* | mapped | rate tables equal to within one rounding step (opennord deps 576-6); copy, defaults included *(corrected after review, 31 Oct 2026)* |
| Arpeggiator | arp* | transformed [I] | unverified |
| Synth preset name/hash | synPreset* | **unmappable** | NS3 preset hash validity on NS4 unknown → 0 + warn |
| Piano type | piano type | mapped [R] | same enum |
| Piano / sample sound (name hash) | nameHash / smpId | **lossy** | keep hash if Stage 4 has the item, else warn; no NS3→NS4 catalog yet |
| Organ model, drawbars, perc, vibrato | organ fields | mapped / transformed [R] | inactive drawbar preset (I/II) → organ layer B? |
| Rotary (speed/drive) | rotary | transformed [I] | opennord skips it |
| Rotor/horn angles | – | skip | runtime snapshot, not a setting |
| FX per panel + source | per-section, per-layer FX block | transformed | route by source and panel → layer |
| FX1 / FX2 type | fx1/fx2Type | transformed | label table (Vibe → VIBE, Chorus → CHOR, …); variants 1/2 unverified |
| Amp type Clean/Twin/JC/Small/LP24/HP24 | ampTypeNew | transformed | 1→1, 2→3, 3→5, 4→8, 5→9; **Clean has no NS4 type** |
| Amp EQ treble/mid/bass/midFreq | same | transformed | re-encode offset → two's complement |
| Amp dry/wet (bass knob in filter mode) | ? | **unmappable** | no confirmed NS4 field |
| Compressor | cmp* | mapped [R] | |
| Delay | dly* | transformed | tempo encoding differs (defaults 8192 vs 11008), unverified |
| Reverb type (Room/Stage/Hall 1/2) | rvbType | transformed | **X1 → base or variation? sample is inconsistent** |
| Reverb bright | rvbColor | transformed [I] | |
| Morphs (wheel/AT/pedal) | morph fields | transformed [I] | encodings differ; opennord skips; unverified |
| Extern | per-layer extern | transformed [I] | unverified |
| Dual keyboard, audio routing | – / routing bus | unmappable / lossy [I] | |
| NS4-only (scene II, layer C, vibrato delay, aux kbd, unknown bytes) | – | template | taken from the donor `.ns4p`, never zeroed |

## 4. Proposed implementation, pending your answers

- `convert.py <input> [output]`, plus directory or glob batch mode. Python 3 stdlib only. Inputs are never written.
- The parser reads NS3 fields into named values. Mapping rules (as in the table above) produce NS4 edits, which patch a **neutral donor template**. The writer then fixes the CRC.
- Every lossy or unmappable parameter that is **non-default in the source** gets a warning. Parameters at default stay silent.
- Round trip: the output is re-parsed and the tool checks magic, tag, version (both places), CRC, size 868, a block chain ending at 824, and that every written field reads back as the intended value.
- The README covers limitations and unmapped parameters.
- Validation: decode both samples, compare our output with your `.ns4p` structurally, and print a parameter diff as an information report, not a pass/fail.

## 5. Open questions

1. **How was the sample's `.ns4p` made**: by hand on the Stage 4, or NSM conversion plus edits? If you have NSM ≥ 9.10, an **unedited** NSM conversion of the same `.ns3f` and its log would be real ground truth. A few more such pairs would make it much better.
2. **Fidelity:** is a faithful parameter mapping with warnings ("close enough") OK, or do you need audio fidelity? Exact fidelity isn't achievable: the engines differ and NSM itself can't do it.
3. **Scope:** programs only (`.ns3f` → `.ns4p`)? Performances don't exist as a file type on the Stage 3. Samples (`.nsmp`) and pianos are libraries, not converted data, so I'd leave them out.
4. **Both panels:** may Panel A → layers A and Panel B → layers B in scene I, as your file does? (opennord drops Panel B.)
5. **Mod env:** map it to the filter env, the osc env, or both, depending on what the mod amounts target?
6. **Reverb Room/Stage/Hall 1:** base type or variation?
7. **Donor template:** your `.ns4p` after resetting its leftovers, or opennord's MIT `regressionTest.ns4p`? An init program saved from your Stage 4 would be cleanest.
8. **Header:** should category `0xFFFFFFFF` → 17 "None"? Bank/location: 0/0, keep the NS3 numbers, or a CLI option?
9. **Licence and home:** private use, AGPL (lets me port opennord's offset tables directly), or permissive (then I'd rebuild from MIT ns4decode facts plus the viewer's test files, which is slower)? And where should the repo live? The brief's `presets/stage3`/`presets/stage4` folders don't exist yet. I'd create a new `~/git/nord-convert` instead of using the portfolio repo.
10. **Value given NSM exists:** what should this tool add? Offline/batch use, a transparent per-parameter log, or simply your own tool?
