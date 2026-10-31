"""Stage 3 and Stage 4 programs: validated bodies decoded into named fields.

A body is a u32 big-endian format version followed by length-prefixed blocks
of MSB-first bit fields that end exactly at the end of the file (opennord
src/lib/clavia/block-chain.ts). Both classes refuse a body whose chain does not
match their layout, so every field read lands on the bits it names.

Ns4Program is also the writer. About a fifth of a Stage 4 body is not in any
known layout, so a new file is made by patching a donor program in place:
`set` re-encodes one field and leaves every other bit as it was, and
`to_bytes` re-checksums.
"""
from __future__ import annotations

import struct
from dataclasses import dataclass
from pathlib import Path
from typing import ClassVar, Dict, FrozenSet, Iterator, List, Tuple, Type, TypeVar, Union

from . import _tables_ns3
from .bits import read_bits, write_bits
from .cbin import FORMAT_NSM, CbinHeader, NordFileError, build_cbin, parse_cbin
from .layout import NS3_LAYOUT, NS4_LAYOUT, Field, Layout


@dataclass(frozen=True)
class FieldValue:
    """A decoded field: the stored bits, what they mean, and whether that is valid.

    `stored` is False for a field the body's format version does not hold yet;
    the instrument then loads the field's default, which `value` reports.
    """

    raw: int
    value: int
    in_range: bool
    stored: bool = True


def walk_block_chain(body: bytes) -> Tuple[int, List[Tuple[int, int]]]:
    """The format version and (offset, length) of each block; NordFileError if the chain is broken."""
    if len(body) < 5:
        raise NordFileError(f'body is {len(body)} bytes, too short for a format version and a block')
    version, = struct.unpack_from('>I', body, 0)
    blocks = []
    pos = 4
    while pos < len(body):
        length = body[pos]
        if pos + 1 + length > len(body):
            raise NordFileError(f'block {len(blocks) + 1} at body byte {pos} claims {length} bytes, '
                                f'only {len(body) - pos - 1} remain')
        blocks.append((pos, length))
        pos += 1 + length
    return version, blocks


def _check_chain(body: bytes, layout: Layout) -> int:
    """Validate `body` against `layout` and return its format version."""
    if len(body) != layout.body_bytes:
        raise NordFileError(f'{layout.model} body is {len(body)} bytes, expected {layout.body_bytes}')
    version, blocks = walk_block_chain(body)
    lo, hi = layout.version_range
    if not lo <= version <= hi:
        raise NordFileError(f'format version {version / 100:.2f} is outside the '
                            f'{lo / 100:.2f}-{hi / 100:.2f} range of the {layout.model} layout')
    expected = [(b.offset, b.length) for b in layout.blocks]
    if blocks != expected:
        raise NordFileError(f'block chain {blocks} does not match the {layout.model} layout {expected}')
    return version


P = TypeVar('P', bound='_Program')


class _Program:
    """Shared read side: header, validated body, field access, serialisation."""

    LAYOUT: ClassVar[Layout]
    TAG: ClassVar[str]

    def __init__(self, header: CbinHeader, body: bytes):
        self.format_version = _check_chain(body, self.LAYOUT)
        self.header = header
        self._body = bytearray(body)

    @classmethod
    def from_bytes(cls: Type[P], data: bytes) -> P:
        """Parse a whole file; NordFileError when it is not a valid program of this model."""
        parsed = parse_cbin(data, cls.TAG)
        return cls(parsed.header, parsed.body)

    @classmethod
    def from_file(cls: Type[P], path: Union[str, Path]) -> P:
        return cls.from_bytes(Path(path).read_bytes())

    @property
    def body(self) -> bytes:
        return bytes(self._body)

    def field(self, key: str) -> Field:
        try:
            return self.LAYOUT.fields[key]
        except KeyError:
            raise KeyError(f'{self.LAYOUT.model} has no field {key!r}') from None

    def keys(self) -> Iterator[str]:
        """Field keys in layout (bit) order."""
        return iter(self.LAYOUT.fields)

    def raw(self, key: str) -> int:
        f = self.field(key)
        return read_bits(self._body, f.body_bit, f.width)

    def get(self, key: str) -> FieldValue:
        f = self.field(key)
        raw = read_bits(self._body, f.body_bit, f.width)
        value = f.decode(raw)
        return FieldValue(raw, value, f.in_range(value))

    def value(self, key: str) -> int:
        return self.get(key).value

    def decode(self) -> Dict[str, FieldValue]:
        """Every layout field, by key."""
        return {key: self.get(key) for key in self.LAYOUT.fields}

    def to_bytes(self) -> bytes:
        """The file, in the header's own format type, with a fresh checksum."""
        if self.header.tag != self.TAG:
            raise NordFileError(f'header tag {self.header.tag!r} is not {self.TAG!r}')
        return build_cbin(self.header, bytes(self._body))


def _absent_before(version: int) -> FrozenSet[str]:
    """Stage 3 fields a body of `version` does not store (opennord ns3/decode.ts ADDED_IN)."""
    return frozenset(k for entry in _tables_ns3.ADDED_IN if version < entry['before'] for k in entry['keys'])


class Ns3Program(_Program):
    """A Stage 3 program (.ns3f), formatType 0 or 1, format 3.00-3.04. Read only.

    Value fix-ups the Stage 3 applies to 3.00-3.01 bodies on load (Dual-KB
    style, the 3.00 delay rate scale; opennord ns3/convert.ts) are not applied
    here: nordconv.source applies them before the mapping reads any value.
    """

    LAYOUT = NS3_LAYOUT
    TAG = 'ns3f'

    def __init__(self, header: CbinHeader, body: bytes):
        super().__init__(header, body)
        self._absent = _absent_before(self.format_version)

    def get(self, key: str) -> FieldValue:
        fv = super().get(key)
        if key in self._absent:
            return FieldValue(fv.raw, self.field(key).default, True, stored=False)
        return fv


class Ns4Program(_Program):
    """A Stage 4 program (.ns4p), formatType 1, format 3.07-3.13, editable in place."""

    LAYOUT = NS4_LAYOUT
    TAG = 'ns4p'

    def __init__(self, header: CbinHeader, body: bytes):
        if header.format_type != FORMAT_NSM:
            raise NordFileError(f'Stage 4 programs use CBIN formatType {FORMAT_NSM}, got {header.format_type}')
        super().__init__(header, body)

    def set(self, key: str, value: int) -> None:
        """Re-encode one field; ValueError when `value` is outside its range."""
        f = self.field(key)
        write_bits(self._body, f.body_bit, f.width, f.encode(value))

    def to_bytes(self) -> bytes:
        """The file with a fresh CRC-32; refuses a header that disagrees with the body."""
        if self.header.format_type != FORMAT_NSM:
            raise NordFileError(f'Stage 4 programs use CBIN formatType {FORMAT_NSM}')
        if self.header.version != self.format_version:
            raise NordFileError(f'header version {self.header.version} differs from body version '
                                f'{self.format_version}')
        return super().to_bytes()
