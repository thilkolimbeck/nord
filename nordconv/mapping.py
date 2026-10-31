"""Stage 3 program -> Stage 4 field edits: the approved Phase 1 mapping.

Source: docs/phase1-mapping.md (approved, with the user's "use defaults"
answers), as corrected by a later cross-check of both formats (kept private
with the sample program pair). The decisions that shape this module:

- both panels convert: Panel A -> layer A, Panel B -> layer B of each section
  in scene I; scene II and layer C stay at the neutral template;
- the mapping is faithful where both models share a table and reports every
  lossy or unmappable parameter that is not at its Stage 3 default;
- the result is a set of edits for a neutral donor (template.py), never a
  whole body, because a fifth of the Stage 4 body is not decoded;
- every section converts, playing or not, but reports about an engine, panel
  or effect unit that is off in the source are notes, not warnings.

Any Stage 3 field no rule reads is swept up at the end and reported if it is
not at its default, so a gap in the rules can lose a setting but never hide it.
"""
from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass
from typing import Callable, Dict, List, Tuple

from ._tables_ns3 import SPLIT_NOTE
from ._tables_ns4 import FIELD_VALUE_TABLE, VALUE_TABLES
from .layout import NS3_LAYOUT
from .map_engines import map_organ, map_piano, map_synth
from .map_fx import SRC_ORGAN, SRC_PIANO, SRC_SYNTH, map_effects, map_rotary, organ_fx_owner
from .mapper import Mapper, short
from .program import Ns3Program
from .source import effective_values

PANELS = ('A', 'B')
SPLIT_POINTS = ('Low', 'Mid', 'High')
# NS3 slotEnable: 1 = A, 2 = B, 3 = A & B.
PANEL_BITS = {'A': 1, 'B': 2}
# NS4 layer enable masks: bit 0 = layer A, bit 1 = layer B (3 = A + B).
LAYER_BITS = {'A': 1, 'B': 2}
SECTIONS = (  # (Stage 3 engine enable key, Stage 4 layer mask, Stage 4 scene I section enable)
    ('organ{p}.enable', 'organ.layerEnableOrg_I', 'common.sectionEnableOrg_I'),
    ('piano{p}.enable', 'piano.layerEnablePno_I', 'common.sectionEnablePno_I'),
    ('synthCommon{p}.enable', 'synth.layerEnableSyn_I', 'common.sectionEnableSyn_I'),
)
FOCUS_KEYS = ('organ.layerFocusOrg_I', 'piano.layerFocusPno_I', 'synth.layerFocusSyn_I')
# Per-layer effects (0) rather than one block for the section (1, the default): the two
# Stage 3 panels have their own effects, and a sample program pair (kept private) runs
# synth A and B with different effects in mode 0.
PER_LAYER_FX = {'piano.layerEnablePno_I': 'piano.effectsSectionModePno',
                'synth.layerEnableSyn_I': 'synth.effectsSectionModeSyn'}
SNAPSHOTS = ('common.leslieRotorAngle', 'common.leslieHornAngle')
B3, VOX, FARFISA = 0, 1, 2
# The Stage 3 has one vibrato/chorus selector (V1 C1 V2 C2 V3 C3) for every organ model; a Vox or
# Farfisa reads it as its own labels (ns3-program-viewer ns3-organ.js). The Stage 4 keeps one
# setting per model: Vox V1/V2/V3 = 0/1/2 and Farfisa V1/V2/C2/C3 = 0/1/2/3 (ns4decode 110-3).
VOX_VIBRATO = {0: 0, 1: 1, 2: 1, 3: 2, 4: 2}  # V1, C1->V2, V2, C2->V3, V3
FARFISA_VIBRATO = {0: 0, 1: 1, 2: 1, 3: 2, 4: 3, 5: 3}  # V1, C1->V2, V2, C2, V3->C3, C3


@dataclass(frozen=True)
class MappingResult:
    """The Stage 4 edits for one program, the warnings, and fields no rule handled."""

    edits: Dict[str, int]
    warnings: Tuple[str, ...]
    unhandled: Tuple[str, ...]
    notes: Tuple[str, ...] = ()  # reports about sections that are off in the source


def map_program(program: Ns3Program) -> MappingResult:
    """Map every Stage 3 field to Stage 4 edits and warnings."""
    values, notes = effective_values(program)
    m = Mapper(values)
    m.warnings.extend(notes)
    slots = m.v('common.slotEnable')
    active = {p: bool(slots & PANEL_BITS[p]) for p in PANELS}
    plays = {(engine, p): bool(m.v(engine.format(p=p))) and active[p] for engine, _, _ in SECTIONS for p in PANELS}
    organ, piano, synth = (engine for engine, _, _ in SECTIONS)
    _map_common(m)
    with m.section(any(plays[(piano, p)] for p in PANELS)):
        _map_layer_detune(m)
    _map_sections(m, plays)
    organ_plays = {p: plays[(organ, p)] for p in PANELS}
    owner = organ_fx_owner(organ_plays)
    with m.section(any(organ_plays.values())):
        _map_organ_vibrato(m, organ_plays)
        map_rotary(m)
    for p in PANELS:
        with m.section(plays[(organ, p)]):
            map_organ(m, p)
        with m.section(plays[(piano, p)]):
            map_piano(m, p)
        with m.section(plays[(synth, p)]):
            map_synth(m, p)
        sources = {SRC_ORGAN: plays[(organ, p)], SRC_PIANO: plays[(piano, p)], SRC_SYNTH: plays[(synth, p)]}
        with m.section(active[p]):
            map_effects(m, p, owner, all(organ_plays.values()), sources)
        _map_extern_and_mixer(m, p, active[p])
    _map_kbd_hold(m)
    heard = _activity(m.values, plays, active)
    _drop_morphs(m, heard)
    unhandled = tuple(k for k in NS3_LAYOUT.fields if k not in m.read)
    for key in unhandled:
        with m.section(heard(key)):
            m.drop(_where(key), [key], 'no conversion rule covers it')
    return MappingResult(dict(m.edits), tuple(m.warnings), unhandled, tuple(m.notes))


def _activity(values: Dict[str, int], plays: Dict[Tuple[str, str], bool],
              active: Dict[str, bool]) -> Callable[[str], bool]:
    """Whether the section a Stage 3 field belongs to is heard, for reports outside a rule's own section."""
    engines = {'organ': SECTIONS[0][0], 'organPresetI': SECTIONS[0][0], 'organPresetII': SECTIONS[0][0],
               'piano': SECTIONS[1][0], 'synth': SECTIONS[2][0], 'synthCommon': SECTIONS[2][0]}
    by_source = {SRC_ORGAN: SECTIONS[0][0], SRC_PIANO: SECTIONS[1][0], SRC_SYNTH: SECTIONS[2][0]}
    units = (('fx1', 'fx1Src'), ('fx2', 'fx2Src'), ('dly', 'dlySrc'), ('amp', 'ampSrc'), ('leslie', 'leslieSrc'),
             ('cmp', None), ('rvb', None))

    def heard(key: str) -> bool:
        block, name = key.split('.', 2)[:2]
        if block == 'common':
            return True
        panel, base = block[-1], block[:-1]
        if not active.get(panel, False):
            return False
        if base in engines:
            return plays[(engines[base], panel)]
        if base == 'extern':
            return bool(values[f'extern{panel}.enable'])
        if base == 'effects':
            for unit, src in units:
                if name.startswith(unit):
                    on = bool(values.get(f'{block}.{unit}Enable', 1))
                    if src is None:
                        return on and any(plays[(e, panel)] for e in by_source.values())
                    engine = by_source.get(values[f'{block}.{src}'])
                    return on and engine is not None and plays[(engine, panel)]
        return True

    return heard


def _ns4_split_position(ns3_pos: int) -> int:
    """Stage 4 split position with the same note (Stage 4 adds C2 below the Stage 3's lowest F2)."""
    table = VALUE_TABLES[FIELD_VALUE_TABLE['common.splitPosLow'][0]]
    by_label = {label: raw for raw, label in table.items()}
    return by_label[SPLIT_NOTE[ns3_pos]]


def _map_common(m: Mapper) -> None:
    w = 'Common'
    m.copy('common.splitEnable', 'common.splitEnabled', w)
    for point in SPLIT_POINTS:
        m.copy(f'common.split{point}Enable', f'common.splitEnabled{point}', w)
        m.copy(f'common.split{point}Width', f'common.splitWidth{point}', w)
        pos = m.v(f'common.split{point}Pos')
        if 0 <= pos < len(SPLIT_NOTE):
            m.set(f'common.splitPos{point}', _ns4_split_position(pos))
        else:
            m.warn(w, f'split{point}Pos {pos} is not a known split note, left at the Stage 4 default')
    m.copy('common.transposeEnable', 'common.transposeEnable', w)
    m.copy('common.transposeValue', 'common.transposeValue', w)
    m.copy('common.masterClockRate', 'common.masterClockRate', w)
    for p in PANELS:
        m.copy('common.pitchStickRange', f'synth{p}.pitchStickRange', w)
    m.copy('common.orgPStickEnable', 'organ.orgPStickEnable', w)
    if m.v('common.dualKbdEnable'):
        m.drop(w, ['common.dualKbdEnable', 'common.dualKbdStyle'],
               'the Stage 4 handles a second keyboard differently; set it up on the instrument')
    else:
        m.skip(['common.dualKbdStyle'])  # only matters while Dual KB is on
    m.skip(SNAPSHOTS)  # rotor positions at save time, not settings (opennord ns4/firmware-params.ts)
    if m.v('common.slotFocus'):
        for key in FOCUS_KEYS:
            m.set(key, 1)


def _map_sections(m: Mapper, plays: Dict[Tuple[str, str], bool]) -> None:
    """Scene I layer and section switches; everything else stays off (neutral template)."""
    for engine, mask_key, section_key in SECTIONS:
        mask = sum(LAYER_BITS[p] for p in PANELS if plays[(engine, p)])
        m.set(mask_key, mask)
        m.set(section_key, int(mask > 0))
        if mask and mask_key in PER_LAYER_FX:
            m.set(PER_LAYER_FX[mask_key], 0)


def _map_layer_detune(m: Mapper) -> None:
    """Stage 3 piano Layer Detune (Off/1/2/3, one setting for both panels) -> each Stage 4 piano layer's Unison."""
    key = 'common.layerDetune'
    for p in PANELS:
        m.copy(key, f'piano{p}.unison', 'Common')
    if not m.is_default(key):
        m.warn('Common', f'piano layer detune {m.v(key)} became piano Unison {m.v(key)} on both piano layers: '
                         'approximated, the Stage 3 detunes the layers against each other and the Stage 4 '
                         'detunes within each layer')


def _map_organ_vibrato(m: Mapper, organ_plays: Dict[str, bool]) -> None:
    """The program-wide vibrato/chorus selector -> the Stage 4 B3, Vox and Farfisa selectors."""
    key = 'common.orgVibratoType'
    m.copy(key, 'organ.vibratoTypeB3', 'Common')  # same V1 C1 V2 C2 V3 C3 order
    value = m.v(key)
    for model, table, dst in ((VOX, VOX_VIBRATO, 'organ.vibratoTypeVox'),
                              (FARFISA, FARFISA_VIBRATO, 'organ.vibratoTypeFarfisa')):
        if value in table:
            m.set(dst, table[value])
        elif any(organ_plays[p] and m.v(f'organ{p}.model') == model for p in PANELS):
            m.warn('Common', f'orgVibratoType {value} has no {("Vox", "Farfisa")[model - 1]} setting; '
                             'the Stage 4 default was kept')


def _map_kbd_hold(m: Mapper) -> None:
    """Stage 3 hold per panel -> Stage 4 hold for the section plus a per-layer include switch."""
    holds = {p: m.v(f'synth{p}.kbdHold') for p in PANELS}
    if any(holds.values()):
        m.set('synth.kbdHoldEnableCommon', 1)
        for p in PANELS:
            m.set(f'synth{p}.kbdHoldEnableLayer', holds[p])


def _map_extern_and_mixer(m: Mapper, p: str, active: bool) -> None:
    extern = [k for k in NS3_LAYOUT.fields if k.startswith(f'extern{p}.') and '.morph' not in k]
    with m.section(active and bool(m.v(f'extern{p}.enable'))):
        m.drop(f'Panel {p} extern', extern,
               'Phase 1 does not convert the extern section (it lives in the Stage 4 synth layers)')
    mixer = [k for k in NS3_LAYOUT.fields if k.startswith(f'mixer{p}.')]
    with m.section(active):
        m.drop(f'Panel {p} mixer', mixer, 'the Stage 4 audio routing works differently')


def _drop_morphs(m: Mapper, heard: Callable[[str], bool]) -> None:
    """Morph assignments: both models have them, but the Stage 4 encoding is not mapped yet."""
    groups: Dict[Tuple[str, bool], List[str]] = defaultdict(list)
    for key in NS3_LAYOUT.fields:
        if '.morph' in key:
            groups[(_where(key), heard(key))].append(key)
    for (where, on), keys in groups.items():
        changed = [f'{short(k)}={m.v(k):+d}' for k in keys if not m.is_default(k)]
        if changed:
            with m.section(on):
                m.warn(where, f'morphs {", ".join(changed)} not converted: the Stage 4 morph encoding '
                              'is not mapped yet')


def _where(key: str) -> str:
    """A readable section name for a Stage 3 field key."""
    block = key.split('.', 1)[0]
    if block == 'common':
        return 'Common'
    panel, base = block[-1], block[:-1]
    names = {'synthCommon': 'synth', 'organPresetI': 'organ', 'organPresetII': 'organ'}
    return f'Panel {panel} {names.get(base, base)}'
