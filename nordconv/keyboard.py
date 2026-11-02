"""Keyboard zones and octave shifts, which both models encode differently.

A Stage 3 zone value names the zones it plays ("11oo") whatever split points
are on. A Stage 4 zone value means different zones depending on which split
points are on (ns4decode dependency tables 113-1, 243-1 and 414-3), so the
converter looks for the Stage 4 value that plays the same zones under the
split points it writes. Like Nord Sound Manager, it prefers the value that
also shows those zones with all three split points on. The Stage 4 octave
shift only goes to +/-2.
"""
from __future__ import annotations

from typing import Optional

from ._tables_ns3 import KB_ZONES
from ._tables_ns4 import DEP_TABLES, FIELD_DEP
from .layout import NS4_LAYOUT
from .mapper import Mapper, short

WHOLE_KEYBOARD = '1111'
#: The Stage 4 zone value that plays the whole keyboard under any split points (and its default).
WHOLE_KEYBOARD_VALUE = 5
OCTAVE_LIMIT = 2


def _zone_value(table_id: str, enables: str, max_value: int, label: str) -> Optional[int]:
    """The Stage 4 value that shows `label` under `enables`, or None.

    Among several, the one that shows it with all split points on too (as Nord Sound Manager
    picks, so the zones survive switching split points on), else the lowest.
    """
    table = DEP_TABLES[table_id]
    every = ':'.join('1' for _ in enables.split(':'))
    matches = [v for v in range(max_value + 1) if table.get(f'{enables}:{v}') == label]
    stable = [v for v in matches if table.get(f'{every}:{v}') == label]
    return (stable or matches or [None])[0]


def map_zone(m: Mapper, src: str, dst: str, where: str) -> None:
    """Write the Stage 4 zone value that plays the zones the Stage 3 value plays.

    The split point enables must already be among the edits: the answer depends on them.
    """
    value = m.v(src)
    table_id, _, deps = FIELD_DEP[dst]
    label = KB_ZONES[value] if 0 <= value < len(KB_ZONES) else None
    if label is None or label == WHOLE_KEYBOARD:
        if label is None:
            m.warn(where, f'{short(src)} {value} is not a known zone, set to the whole keyboard')
        m.set(dst, WHOLE_KEYBOARD_VALUE)
        return
    enables = ':'.join(str(m.edits[d]) for d in deps)
    target = _zone_value(table_id, enables, NS4_LAYOUT.fields[dst].max, label)
    if target is None:
        if m.v('common.splitEnable'):
            m.warn(where, f'zones {label} cannot be played with the active split points, '
                          'set to the whole keyboard')
        target = WHOLE_KEYBOARD_VALUE
    m.set(dst, target)


def map_octave(m: Mapper, src: str, dst: str, where: str) -> None:
    """Copy an octave shift, clamped to the Stage 4's +/-2."""
    value = m.v(src)
    clamped = max(-OCTAVE_LIMIT, min(OCTAVE_LIMIT, value))
    if clamped != value:
        m.warn(where, f'octave shift {value:+d} is beyond the Stage 4 range of +/-2, set to {clamped:+d}')
    m.set(dst, clamped)
