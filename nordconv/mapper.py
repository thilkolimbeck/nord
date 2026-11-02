"""The bookkeeping every mapping rule goes through.

The Phase 1 contract is "faithful where we can, a warning wherever we cannot":
every lossy or unmappable Stage 3 parameter that is not at its default must be
reported, and nothing may be dropped silently. Routing every read through
`Mapper.v` records which Stage 3 fields a rule looked at, so the converter can
sweep up any field no rule handled, and the tests can prove that none is left.
Routing every write through `Mapper.set` validates the value against the
Stage 4 layout at once, so a rule bug fails here, not on the instrument.
"""
from __future__ import annotations

from contextlib import contextmanager
from dataclasses import dataclass, field
from typing import Dict, Iterable, Iterator, List, Mapping, Set

from .layout import NS3_LAYOUT, NS4_LAYOUT, Field

#: Appended to a note, so a line about a switched-off section stays traceable.
OFF_SUFFIX = ' (switched off in the Stage 3 program)'

#: Name-hash values that mean "no sound/preset selected". The layouts give 0 as
#: the default, but the Stage 3 writes 0x7FFFFFFF for an empty slot.
NONE_HASHES = frozenset({0, 0x7FFFFFFF})


def short(key: str) -> str:
    """The parameter part of a field key ("synthA.fltFreq" -> "fltFreq"), for messages."""
    return key.split('.', 1)[1] if '.' in key else key


@dataclass
class Mapper:
    """Collects Stage 4 edits and warnings for one Stage 3 program.

    Values convert whether their section plays or not, so the sound is right
    when the user switches it on. But a report about an engine or effect that
    is off in the source would bury the ones that matter, so while a rule runs
    inside `section(False)` its reports go to `notes`, not `warnings`.
    """

    values: Mapping[str, int]
    edits: Dict[str, int] = field(default_factory=dict)
    warnings: List[str] = field(default_factory=list)
    notes: List[str] = field(default_factory=list)
    read: Set[str] = field(default_factory=set)
    active: bool = True

    @contextmanager
    def section(self, active: bool) -> Iterator[None]:
        """Run rules for a section that plays (reports are warnings) or not (reports are notes)."""
        outer = self.active
        self.active = outer and active
        try:
            yield
        finally:
            self.active = outer

    # ---- reading the source

    def v(self, key: str) -> int:
        """A Stage 3 value; marks the field as handled."""
        self.read.add(key)
        return self.values[key]

    def bounded(self, key: str, where: str) -> int:
        """A Stage 3 value clamped to its documented range, for rules that compute with it."""
        f = NS3_LAYOUT.fields[key]
        value = self.v(key)
        if f.min <= value <= f.max:
            return value
        clamped = min(max(value, f.min), f.max)
        self.warn(where, f'{short(key)} {value} is outside the Stage 3 range {f.min}..{f.max}, read as {clamped}')
        return clamped

    def is_default(self, key: str) -> bool:
        """Whether a Stage 3 field holds its default (an empty name hash counts as default)."""
        f = NS3_LAYOUT.fields[key]
        value = self.v(key)
        if f.enc == 'raw':
            return value in NONE_HASHES
        return value == f.default

    def skip(self, keys: Iterable[str]) -> None:
        """Mark fields as deliberately not converted (state snapshots, not settings)."""
        self.read.update(keys)

    # ---- writing the target

    def set(self, key: str, value: int) -> None:
        """Record a Stage 4 edit; ValueError for an out-of-range value, AssertionError for a clash."""
        NS4_LAYOUT.fields[key].encode(value)
        previous = self.edits.get(key)
        if previous is not None and previous != value:
            raise AssertionError(f'mapping writes {key} twice: {previous} then {value}')
        self.edits[key] = value

    def warn(self, where: str, text: str) -> None:
        if self.active:
            self.warnings.append(f'{where}: {text}')
        else:
            self.notes.append(f'{where}: {text}{OFF_SUFFIX}')

    def copy(self, src: str, dst: str, where: str) -> None:
        """Value copy for parameters with the same meaning and scale; clamps and warns if out of range."""
        value = self.v(src)
        target = NS4_LAYOUT.fields[dst]
        if not target.in_range(value):
            clamped = min(max(value, target.min), target.max)
            self.warn(where, f'{short(src)} {value} is outside the Stage 4 range '
                             f'{target.min}..{target.max}, set to {clamped}')
            value = clamped
        self.set(dst, value)

    def drop(self, where: str, keys: Iterable[str], reason: str) -> None:
        """Report fields with no Stage 4 counterpart: one warning naming every non-default one."""
        changed = [f'{short(k)}={self._show(k)}' for k in keys if not self.is_default(k)]
        if changed:
            self.warn(where, f'{", ".join(changed)} not converted: {reason}')

    def _show(self, key: str) -> str:
        f: Field = NS3_LAYOUT.fields[key]
        value = self.values[key]
        return f'0x{value:08X}' if f.enc == 'raw' else str(value)
