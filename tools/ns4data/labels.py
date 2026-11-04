"""Display labels of Stage 4 fields: the reference the editor's label port is tested against.

The tables come from ns4decode through opennord (see _tables_ns4.py). They are
keyed by the field's raw bits as ns4decode reads them, which for the synth osc
knobs is only the field's low bits; a raw beyond that width has no label.
Lookup order follows opennord ns4/coverage.ts: exact value table, enum table,
then the dependency tables, whose label depends on other fields (keyboard
zones on the active split points, osc category and wave on the osc bank).
"""
from __future__ import annotations

from typing import Callable, Optional

from . import _tables_ns4 as t


def ns4_label(key: str, raw: Callable[[str], int]) -> Optional[str]:
    """The Stage 4 display string of field `key`, or None when no table covers it.

    `raw(k)` gives the stored bits of field `k`: of `key` itself and, for a dependency
    table, of the fields its label depends on.
    """
    bits = raw(key)
    if key in t.FIELD_VALUE_TABLE:
        table_id, width = t.FIELD_VALUE_TABLE[key]
        if bits < 1 << width and bits in t.VALUE_TABLES[table_id]:
            return t.VALUE_TABLES[table_id][bits]
    if key in t.FIELD_ENUM:
        enum, width = t.FIELD_ENUM[key]
        if bits < 1 << width and bits in t.ENUM_TABLES[enum]:
            return t.ENUM_TABLES[enum][bits]
    if key in t.FIELD_DEP:
        table_id, width, deps = t.FIELD_DEP[key]
        if bits < 1 << width:
            row = ':'.join(str(raw(d)) for d in deps) + f':{bits}'
            return t.DEP_TABLES[table_id].get(row)
    return None
