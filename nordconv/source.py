"""Stage 3 values as the instrument loads them, after its format fix-ups.

A 3.00-3.03 body keeps the 3.04 layout, but the Stage 3 changes a few values
when it loads one (opennord src/lib/ns3/convert.ts). The mapping must start
from those loaded values, or an old file would convert differently from what
its owner hears:

- below 3.02, Dual-KB style 0 becomes 1;
- below 3.03/3.04, fields the body does not store yet load as their defaults
  (Ns3Program.get already does this);
- in 3.00, the delay rate was a 0-127 value. Synced to the master clock it
  becomes N(x) = 16383 for 127, else 128 x, and each morph delta becomes
  N(rate + delta) - N(rate). Free-running, the firmware uses a curve nobody
  has extracted, so the value stays on the 3.00 scale and is reported (its
  morph deltas are only re-zeroed, so an unassigned morph reads 0). A rate
  above 127, or a morph target in 128-16383, makes the Stage 3 refuse the
  program, so the converter refuses it too.
"""
from __future__ import annotations

from typing import Dict, List, Tuple

from .cbin import NordFileError
from .program import Ns3Program

DELAY_MAX = 16383
MORPHS = ('morphWheel', 'morphAfterTouch', 'morphCtrlPedal')
#: What a 3.00 morph delta of 0 decodes to in the 15-bit delta field (raw 127 - 16383).
OS300_DELTA_ZERO = 127 - DELAY_MAX


def _os300_rate(x: int) -> int:
    """The 3.04 delay rate the firmware derives from a clock-synced 3.00 rate or morph target."""
    return DELAY_MAX if x == 127 else 128 * x


def effective_values(program: Ns3Program) -> Tuple[Dict[str, int], List[str]]:
    """Every field's loaded value, plus notes about values that could not be brought up to date."""
    values = {key: program.value(key) for key in program.keys()}
    notes: List[str] = []
    version = program.format_version
    if version < 302 and values['common.dualKbdStyle'] == 0:
        values['common.dualKbdStyle'] = 1
    if version == 300:
        for panel in ('A', 'B'):
            _fix_os300_delay(values, panel, notes)
    return values, notes


def _fix_os300_delay(values: Dict[str, int], panel: str, notes: List[str]) -> None:
    key = f'effects{panel}.dlyRateClkDiv'
    rate = values[key]
    if rate > 127:
        raise NordFileError(f'Panel {panel} delay rate {rate} is invalid for format 3.00; '
                            'the Stage 3 itself refuses this program')
    deltas = {m: values[f'{key}.{m}'] - OS300_DELTA_ZERO for m in MORPHS}
    if any(128 <= rate + delta <= DELAY_MAX for delta in deltas.values()):
        raise NordFileError(f'Panel {panel} delay rate morph is invalid for format 3.00; '
                            'the Stage 3 itself refuses this program')
    if values[f'effects{panel}.dlyClkEnable'] != 1:
        for morph, delta in deltas.items():  # re-zeroed as convert.ts does; the rate itself stays as is
            values[f'{key}.{morph}'] = delta
        notes.append(f'Panel {panel} effects: delay rate {rate} is on the format 3.00 scale (0-127), '
                     'which has no known conversion; it is passed on unconverted')
        return
    values[key] = _os300_rate(rate)
    for morph, delta in deltas.items():
        moved = _os300_rate(rate + delta) - values[key] if delta else 0
        values[f'{key}.{morph}'] = max(-DELAY_MAX, min(DELAY_MAX, moved))
