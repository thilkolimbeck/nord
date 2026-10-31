"""One Stage 3 file in, one verified Stage 4 file out.

The rule is "never write a broken file": the output is built in memory,
parsed again with the strict reader, and compared field by field with what
the mapping asked for and with the neutral template, and only then written,
through a temporary file and an atomic rename. An input file is only ever
read, and an output path that is the input is refused.
"""
from __future__ import annotations

import os
import tempfile
from dataclasses import dataclass, replace
from functools import lru_cache
from pathlib import Path
from typing import Dict, Tuple, Union

from .cbin import HEADER_BYTES, NordFileError
from .layout import NS4_LAYOUT
from .mapping import map_program
from .program import Ns3Program, Ns4Program
from .template import CATEGORY_NONE, TARGET_VERSION

OUTPUT_SUFFIX = '.ns4p'
#: Stage 3 "no category" sentinel; real ids share the Stage 4 table (opennord clavia/categories.ts).
CATEGORY_UNSET = 0xFFFFFFFF
CATEGORY_MAX = 46


class ConversionError(Exception):
    """The output failed its own verification, or the paths are unsafe."""


@dataclass(frozen=True)
class Converted:
    """A finished conversion: the file's bytes, the field edits, the warnings, and the notes
    (reports about sections that are switched off in the source)."""

    data: bytes
    edits: Dict[str, int]
    warnings: Tuple[str, ...]
    notes: Tuple[str, ...] = ()


def ns4_category(ns3_category: int) -> Tuple[int, str]:
    """The Stage 4 header category, and a warning when the Stage 3 id had to be replaced."""
    if ns3_category == CATEGORY_UNSET:
        return CATEGORY_NONE, ''
    if 0 <= ns3_category <= CATEGORY_MAX:
        return ns3_category, ''
    return CATEGORY_NONE, f'Header: category {ns3_category} is not a known id, set to None'


def convert_bytes(ns3_data: bytes, template: Ns4Program) -> Converted:
    """Convert a whole .ns3f file; NordFileError for a bad input, ConversionError for a bad output."""
    source = Ns3Program.from_bytes(ns3_data)
    result = map_program(source)
    category, category_warning = ns4_category(source.header.category)
    out = Ns4Program(replace(template.header, category=category), template.body)
    for key, value in result.edits.items():
        out.set(key, value)
    data = out.to_bytes()
    verify(data, template, result.edits, category)
    warnings = result.warnings + ((category_warning,) if category_warning else ())
    return Converted(data, result.edits, warnings, result.notes)


@lru_cache(maxsize=1)
def _uncovered_mask() -> bytes:
    """A body-sized mask with a 1 bit for every bit no layout field covers."""
    covered = bytearray(NS4_LAYOUT.body_bytes)
    for f in NS4_LAYOUT.fields.values():
        for bit in range(f.body_bit, f.body_bit + f.width):
            covered[bit >> 3] |= 0x80 >> (bit & 7)
    return bytes(~b & 0xFF for b in covered)


def verify(data: bytes, template: Ns4Program, edits: Dict[str, int], category: int) -> None:
    """Re-read an output and check it against the plan; ConversionError on any difference."""
    expected_size = HEADER_BYTES + NS4_LAYOUT.body_bytes
    if len(data) != expected_size:
        raise ConversionError(f'output is {len(data)} bytes, expected {expected_size}')
    try:
        back = Ns4Program.from_bytes(data)  # magic, tag, formatType, CRC, block chain, body size
    except NordFileError as exc:
        raise ConversionError(f'output does not parse: {exc}') from exc
    header = back.header
    if (header.version, back.format_version) != (TARGET_VERSION, TARGET_VERSION):
        raise ConversionError(f'output versions {header.version}/{back.format_version}, expected {TARGET_VERSION}')
    if (header.bank, header.location, header.category) != (0, 0, category):
        raise ConversionError(f'output header {header} differs from bank 0, location 0, category {category}')
    for key in NS4_LAYOUT.fields:
        want = edits[key] if key in edits else template.value(key)
        if back.value(key) != want:
            raise ConversionError(f'{key} reads back {back.value(key)}, expected {want}')
    mask = _uncovered_mask()
    if any((a ^ b) & m for a, b, m in zip(back.body, template.body, mask)):
        raise ConversionError('undecoded template bits changed')


def default_output(input_path: Path) -> Path:
    """The output next to the input, named after it (the program name is the filename)."""
    return input_path.with_suffix(OUTPUT_SUFFIX)


def _umask() -> int:
    current = os.umask(0)
    os.umask(current)
    return current


def write_atomic(path: Path, data: bytes, input_path: Path, overwrite: bool) -> None:
    """Write `data` to `path` via a temporary file and rename; refuse to touch the input."""
    if path.resolve() == input_path.resolve() or (path.exists() and os.path.samefile(path, input_path)):
        raise ConversionError(f'output {path} is the input file')
    if path.exists() and not overwrite:
        raise ConversionError(f'output {path} exists (use --force to replace it)')
    fd, tmp = tempfile.mkstemp(prefix=f'.{path.name}.', suffix='.tmp', dir=path.parent)
    try:
        os.fchmod(fd, 0o666 & ~_umask())  # mkstemp creates 0600; give it a normal file's mode
        with os.fdopen(fd, 'wb') as fh:
            fh.write(data)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, path)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise


def convert_file(input_path: Union[str, Path], output_path: Union[str, Path], template: Ns4Program,
                 overwrite: bool = False) -> Converted:
    """Convert one file on disk; the input is read once and never written."""
    src, dst = Path(input_path), Path(output_path)
    converted = convert_bytes(src.read_bytes(), template)
    write_atomic(dst, converted.data, src, overwrite)
    return converted
