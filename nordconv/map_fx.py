"""Mapping rules for one Stage 3 panel's effects section.

The Stage 3 has one effects section per panel. Effect 1, Effect 2, Delay,
Amp/EQ and the rotary each act on one source engine (organ, piano or synth);
compressor and reverb act on the whole panel. The Stage 4 has an effects block
per layer (pianoAFx, synthBFx, ...) plus a single block for the organ section.
So each source-bound effect goes to the block of its source's layer, and
compressor and reverb go to every block of the panel. The organ block can
only serve one panel; the converter gives it to the panel whose organ plays.

Type tables pair labels: "1" variants become the Stage 4 base type and "2"
variants its variation (approved default, applied to every effect type).

Every unit converts, but reports about a unit that is off, or whose source
engine does not play, are notes rather than warnings (Mapper.section).
"""
from __future__ import annotations

from typing import Dict, List, Optional, Sequence

from .mapper import Mapper

SRC_ORGAN, SRC_PIANO, SRC_SYNTH = 0, 1, 2
# Panning, Tremolo, Ring Mod, Wah-Wah, Auto-Wah 1, Auto-Wah 2 -> A-PAN, TREM, RM, WAH, A-WAH, A-WAH variation
FX1_TYPE = {0: 0, 1: 2, 2: 4, 3: 8, 4: 6, 5: 7}
# Phaser 1, Phaser 2, Flanger, Vibe, Chorus 1, Chorus 2 -> PHAS, PHAS var., FLANG, VIBE, CHOR, CHOR var.
FX2_TYPE = {0: 0, 1: 1, 2: 2, 3: 6, 4: 4, 5: 5}
# Clean, Twin, JC, Small, LP24, HP24 -> off (EQ only), TWIN, JC, SMALL, LP FILTER, HP FILTER
AMP_TYPE = {0: 0, 1: 1, 2: 3, 3: 5, 4: 8, 5: 9}
AMP_CLEAN = 0
AMP_FILTERS = {4, 5}
# Room 1, Room 2, Stage 1, Stage 2, Hall 1, Hall 2 -> ROOM, ROOM var., STAGE, STAGE var., HALL, HALL var.
REVERB_TYPE = {0: 4, 1: 5, 2: 6, 3: 7, 4: 8, 5: 9}
REVERB_BRIGHT = 2
# common.leslieSpeed packs the speed (bit 1: fast) and the inverted stop mode (bit 0: 1 = stop mode off):
# 0 = slow + stop mode ("Stop"), 1 = slow, 2 = fast + stop mode, 3 = fast (ns3-program-viewer
# ns3-fx-rotary-speaker.js; viewer fixtures stopMode.enabled true = 2, false = 3).
ROTARY_FAST_BIT, ROTARY_STOP_OFF_BIT = 2, 1

FX1_KEYS = ('fx1Enable', 'fx1Type', 'fx1ClkEnable', 'fx1RateClkDiv', 'fx1Amt')
FX2_KEYS = ('fx2Enable', 'fx2Type', 'fx2Rate', 'fx2Amt')
DELAY_KEYS = ('dlyEnable', 'dlyClkEnable', 'dlyRateClkDiv', 'dlyMix', 'dlyPingPong', 'dlyFltType',
              'dlyFeedback', 'dlyMode')
AMP_KEYS = ('ampEnable', 'ampType', 'ampTreble', 'ampMid', 'ampBass', 'ampMidFreq', 'ampDrive')


def organ_fx_owner(organ_plays: Dict[str, bool]) -> str:
    """The panel whose effects feed the Stage 4 organ block: Panel A, unless only Panel B's organ plays."""
    return 'B' if organ_plays['B'] and not organ_plays['A'] else 'A'


def map_rotary(m: Mapper) -> None:
    """Program-wide rotary speed and drive -> the Stage 4 organ section's rotary."""
    w = 'Common'
    speed = m.v('common.leslieSpeed')
    m.set('organ.effectsLeslieStopMode', int(not speed & ROTARY_STOP_OFF_BIT))
    m.set('organ.effectsLeslieSpeed', int(bool(speed & ROTARY_FAST_BIT)))
    m.copy('common.leslieDrv', 'organ.effectsLeslieDrv', w)


def map_effects(m: Mapper, p: str, owner: str, both_organs_play: bool, plays: Dict[int, bool]) -> None:
    """One panel's effects -> the Stage 4 blocks of that panel's layers.

    `plays` says, per source (SRC_ORGAN, SRC_PIANO, SRC_SYNTH), whether that engine of this panel plays.
    """
    e, w = f'effects{p}', f'Panel {p} effects'

    def on(enable_key: str, src_key: Optional[str] = None) -> bool:
        """Whether a unit is heard: switched on, and its source engine (or any engine) plays."""
        source_plays = plays.get(m.v(f'{e}.{src_key}'), False) if src_key else any(plays.values())
        return bool(m.v(f'{e}.{enable_key}')) and source_plays

    blocks: Dict[int, Optional[str]] = {SRC_ORGAN: 'organFx' if owner == p else None,
                                        SRC_PIANO: f'piano{p}Fx', SRC_SYNTH: f'synth{p}Fx'}
    lost = f'the Stage 4 organ has one effects block, which Panel {owner} uses'

    def route(src_key: str, keys: Sequence[str]) -> Optional[str]:
        src = m.v(f'{e}.{src_key}')
        block = blocks.get(src)
        if block is None:
            m.drop(w, [f'{e}.{k}' for k in keys], lost if src == SRC_ORGAN else f'{src_key} {src} is unknown')
        return block

    with m.section(on('leslieEnable', 'leslieSrc')):
        _rotary(m, e, w, owner == p, lost)
    with m.section(on('fx1Enable', 'fx1Src')):
        block = route('fx1Src', FX1_KEYS)
        if block:
            _typed(m, e, block, w, FX1_KEYS, FX1_TYPE)
    with m.section(on('fx2Enable', 'fx2Src')):
        block = route('fx2Src', FX2_KEYS)
        if block:
            _typed(m, e, block, w, FX2_KEYS, FX2_TYPE)
    with m.section(on('dlyEnable', 'dlySrc')):
        block = route('dlySrc', DELAY_KEYS)
        if block:
            _delay(m, e, block, w)
    with m.section(on('ampEnable', 'ampSrc')):
        block = route('ampSrc', AMP_KEYS)
        if block:
            _amp(m, e, block, w)
    with m.section(on('rvbEnable')):
        reverb_type = _lookup(m, f'{e}.rvbType', REVERB_TYPE, w)
    reverb_color = REVERB_BRIGHT if m.v(f'{e}.rvbBright') else 0
    panel_blocks: List[str] = [b for b in blocks.values() if b]
    for block in panel_blocks:
        for keys in (('cmpEnable', 'cmpAmt', 'cmpResponse'), ('rvbEnable', 'rvbAmt')):
            with m.section(on(keys[0])):
                for key in keys:
                    m.copy(f'{e}.{key}', f'{block}.{key}', w)
        m.set(f'{block}.rvbType', reverb_type)
        m.set(f'{block}.rvbColor', reverb_color)
    if owner != p and both_organs_play:
        m.drop(w, [f'{e}.cmpEnable', f'{e}.rvbEnable'], f'not applied to the organ: {lost}')


def _lookup(m: Mapper, key: str, table: Dict[int, int], w: str) -> int:
    value = m.v(key)
    if value not in table:
        m.warn(w, f'{key.split(".", 1)[1]} {value} is unknown, set to the first Stage 4 type')
        return 0
    return table[value]


def _typed(m: Mapper, e: str, block: str, w: str, keys: Sequence[str], types: Dict[int, int]) -> None:
    """Effect 1 or 2: on/off, rate and amount copy; the type goes through its label table."""
    type_key = keys[1]
    m.set(f'{block}.{type_key}', _lookup(m, f'{e}.{type_key}', types, w))
    for key in keys:
        if key != type_key:
            m.copy(f'{e}.{key}', f'{block}.{key}', w)


def _delay(m: Mapper, e: str, block: str, w: str) -> None:
    for ns3, ns4 in (('dlyEnable', 'dlyEnable'), ('dlyClkEnable', 'dlyClkEnable'), ('dlyMix', 'dlyMix'),
                     ('dlyPingPong', 'dlyFbkPingPong'), ('dlyFltType', 'dlyFbkFilt'),
                     ('dlyFeedback', 'dlyFbkAmt'), ('dlyMode', 'dlyMode')):
        m.copy(f'{e}.{ns3}', f'{block}.{ns4}', w)
    # The tempo field has different defaults on the two models (8192 vs 11008): the scale differs.
    m.guess(f'{e}.dlyRateClkDiv', f'{block}.dlyRateClkDiv', w)


def _amp(m: Mapper, e: str, block: str, w: str) -> None:
    amp_type = m.v(f'{e}.ampType')
    m.set(f'{block}.ampTypeNew', _lookup(m, f'{e}.ampType', AMP_TYPE, w))
    if amp_type == AMP_CLEAN and m.v(f'{e}.ampEnable'):
        m.warn(w, 'amp type Clean has no Stage 4 model; the EQ is kept with the amp model off')
    for key in ('ampEnable', 'ampTreble', 'ampMid', 'ampMidFreq', 'ampDrive'):
        m.copy(f'{e}.{key}', f'{block}.{key}', w)
    if amp_type in AMP_FILTERS:
        m.drop(w, [f'{e}.ampBass'], 'in filter mode it is the dry/wet mix, which has no confirmed Stage 4 field')
    else:
        m.copy(f'{e}.ampBass', f'{block}.ampBass', w)


def _rotary(m: Mapper, e: str, w: str, owns_organ: bool, lost: str) -> None:
    """The Stage 4 rotary belongs to the organ section, so only an organ-sourced rotary converts."""
    keys = [f'{e}.leslieEnable']
    if m.v(f'{e}.leslieSrc') != SRC_ORGAN:
        m.drop(w, keys, 'a rotary on piano or synth has no Stage 4 counterpart (only the organ has one)')
        if owns_organ:
            m.set('organ.effectsLeslieEnable', 0)
    elif owns_organ:
        m.copy(keys[0], 'organ.effectsLeslieEnable', w)
    else:
        m.drop(w, keys, lost)
