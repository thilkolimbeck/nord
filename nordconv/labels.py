"""Display labels of Stage 4 fields, for conversion logs and checks.

The tables come from ns4decode through opennord (see _tables_ns4.py). They are
keyed by the field's raw bits as ns4decode reads them, which for the synth osc
knobs is only the field's low bits; a raw beyond that width has no label.
Lookup order follows opennord ns4/coverage.ts: exact value table, enum table,
then the dependency tables, whose label depends on other fields (keyboard
zones on the active split points, osc category and wave on the osc bank).
"""
from __future__ import annotations

from typing import Optional

from . import _tables_ns4 as t
from .program import Ns4Program


def ns4_label(program: Ns4Program, key: str) -> Optional[str]:
    """The Stage 4 display string of field `key`, or None when no table covers it."""
    raw = program.raw(key)
    if key in t.FIELD_VALUE_TABLE:
        table_id, width = t.FIELD_VALUE_TABLE[key]
        if raw < 1 << width and raw in t.VALUE_TABLES[table_id]:
            return t.VALUE_TABLES[table_id][raw]
    if key in t.FIELD_ENUM:
        enum, width = t.FIELD_ENUM[key]
        if raw < 1 << width and raw in t.ENUM_TABLES[enum]:
            return t.ENUM_TABLES[enum][raw]
    if key in t.FIELD_DEP:
        table_id, width, deps = t.FIELD_DEP[key]
        if raw < 1 << width:
            row = ':'.join(str(program.raw(d)) for d in deps) + f':{raw}'
            return t.DEP_TABLES[table_id].get(row)
    return None
