"""MSB-first bit fields, the encoding of every Nord program body.

A body is one big-endian bit string: bit 0 is the top bit of byte 0. Fields
cross byte boundaries freely, so they are read and written through the integer
of the bytes they span; a write touches only the field's own bits.
"""
from __future__ import annotations

from typing import Tuple


def _span(start: int, width: int, size: int) -> Tuple[int, int, int]:
    """First byte, last byte and right shift of a bit range, bounds-checked."""
    if width <= 0 or start < 0:
        raise ValueError(f'bad bit range: start {start}, width {width}')
    first, last = start >> 3, (start + width - 1) >> 3
    if last >= size:
        raise ValueError(f'bits {start}..{start + width - 1} run past the {size}-byte buffer')
    return first, last, (last + 1) * 8 - (start + width)


def read_bits(buf: bytes, start: int, width: int) -> int:
    """The unsigned value of `width` bits starting at bit `start`."""
    first, last, shift = _span(start, width, len(buf))
    return (int.from_bytes(buf[first:last + 1], 'big') >> shift) & ((1 << width) - 1)


def write_bits(buf: bytearray, start: int, width: int, value: int) -> None:
    """Store an unsigned `value` in `width` bits at bit `start`, keeping all other bits."""
    if not 0 <= value < 1 << width:
        raise ValueError(f'{value} does not fit in {width} unsigned bits')
    first, last, shift = _span(start, width, len(buf))
    mask = ((1 << width) - 1) << shift
    chunk = int.from_bytes(buf[first:last + 1], 'big')
    chunk = (chunk & ~mask) | (value << shift)
    buf[first:last + 1] = chunk.to_bytes(last - first + 1, 'big')
