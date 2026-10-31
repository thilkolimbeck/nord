"""Stage 3 oscillator (bank, wave, configuration) -> Stage 4 analog oscillator.

The two synth engines are built differently: the Stage 3 combines a base
wave with a configuration (a second oscillator, sync, shape, FM ...), the
Stage 4 offers fixed analog categories and waves. There is no published
correspondence, so this table is hand-made from the waves' names, plus two
configurations (Saw + "8 MixSqr" with the second oscillator one octave down ->
SUB OSC / Sub Square Saw; Saw + "4 Detune" -> MULTI / Multi Saw) that a sample
program pair (kept private) confirms. Anything else falls back to the PURE
version of the base wave and is reported, because a close-enough wave beats a
silent default.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

from ._tables_ns3 import OSC_CLASSIC_WAVE, OSC_CONFIG, OSC_SUPER_WAVE, SYNTH_OSC

# Stage 4 analog categories (oscCat under oscBank 0, ns4decode table 561-8).
PURE, SUB_OSC, SYNC, SHAPE, MULTI, SUPER = 0, 1, 2, 3, 5, 6
#: dualOscDetune value meaning "second oscillator one octave down" (Sub).
DETUNE_SUB = 0
DETUNE_UNISON = 12

# Classic waves 0-5 (Sine .. Pulse 10) have PURE and SYNC waves of the same name and order.
_NAMED_WAVES = 6
_SHAPE_WAVE = {'Triangle': 0, 'Saw': 1, 'Square': 2}
_E_WAVE_BASE = {'ESaw': 'Saw', 'ESquare': 'Square'}
_SUPER_EXACT = {'Super Wave Saw': 0, 'Super Wave Square': 1, 'Super Wave Organ': 2}
_SUPER_CLOSE = {'Super Wave Saw 2': 0, 'Super Wave Square 2': 1, 'Super Wave Bright': 3,
                'Super Wave Bright 2': 3, 'Super Wave Strings': 0}


@dataclass(frozen=True)
class OscChoice:
    """A Stage 4 analog oscillator, and why it is only an approximation (None when exact)."""

    category: int
    wave: int
    lossy: Optional[str] = None
    uses_detune: bool = False


def _label(table: list, index: int) -> str:
    return table[index] if 0 <= index < len(table) else f'#{index}'


def map_oscillator(bank: int, wave: int, conf: int, detune: int) -> Optional[OscChoice]:
    """The Stage 4 oscillator for a Stage 3 one, or None when no analog wave comes close."""
    kind = _label(SYNTH_OSC, bank)
    if kind == 'Classic':
        return _classic(_label(OSC_CLASSIC_WAVE, wave), wave, _label(OSC_CONFIG, conf), detune)
    if kind == 'Super':
        name = _label(OSC_SUPER_WAVE, wave)
        if name in _SUPER_EXACT:
            return OscChoice(SUPER, _SUPER_EXACT[name])
        if name in _SUPER_CLOSE:
            return OscChoice(SUPER, _SUPER_CLOSE[name], f'{name} approximated by the closest Stage 4 super wave')
    return None


def _classic(name: str, index: int, conf: str, detune: int) -> OscChoice:
    base = _E_WAVE_BASE.get(name, name)
    if conf == '8 MixSqr' and name == 'Saw' and detune == DETUNE_SUB:
        return OscChoice(SUB_OSC, 0, uses_detune=True)
    if conf == '4 Detune' and name == 'Saw':
        return OscChoice(MULTI, 0)
    if conf == '3 Sync' and index < _NAMED_WAVES:
        return OscChoice(SYNC, index)
    if conf == '2 Shape' and name in _SHAPE_WAVE:
        return OscChoice(SHAPE, _SHAPE_WAVE[name])
    known = base in OSC_CLASSIC_WAVE[:_NAMED_WAVES]
    pure = OSC_CLASSIC_WAVE.index(base) if known else 2
    if conf == 'None' and known and name == base:
        return OscChoice(PURE, pure)
    reasons = []
    if name != base or not known:
        reasons.append(f'wave {name} has no Stage 4 counterpart')
    if conf != 'None':
        reasons.append(f'configuration {conf} has no known Stage 4 counterpart')
    return OscChoice(PURE, pure, '; '.join(reasons) + f', so it became Pure {OSC_CLASSIC_WAVE[pure]}')
