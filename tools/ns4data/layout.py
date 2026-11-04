"""Typed views of the generated Stage 4 layout, and the raw <-> value rules of a field.

The generated module stores plain tuples so it imports fast; this module turns
them into frozen dataclasses once. Encoding rules follow opennord
src/lib/clavia/block-chain.ts (fieldValue / fieldRaw).
"""
from __future__ import annotations

from dataclasses import dataclass
from types import MappingProxyType, ModuleType
from typing import Mapping, Tuple

from . import _layout_ns4


@dataclass(frozen=True)
class Block:
    """A length-prefixed block; `offset` is the body byte of its length prefix."""

    key: str
    name: str
    offset: int
    length: int


@dataclass(frozen=True)
class Field:
    """One bit field. `body_bit` is its first bit counted from body byte 0."""

    key: str
    name: str
    block: int
    bit: int
    width: int
    min: int
    max: int
    default: int
    enc: str
    confidence: str
    body_bit: int

    def decode(self, raw: int) -> int:
        """The value a raw bit pattern stands for."""
        if self.enc == 'offset':
            return raw + self.min
        if self.enc == 'twos' and raw >= 1 << (self.width - 1):
            return raw - (1 << self.width)
        return raw

    def in_range(self, value: int) -> bool:
        """Whether the instrument accepts `value` (it resets others to default on load).

        Name hashes (`raw`) are opaque unsigned words, so any pattern is valid.
        """
        if self.enc == 'raw':
            return 0 <= value < 1 << self.width
        return self.min <= value <= self.max

    def encode(self, value: int) -> int:
        """The raw bits for `value`; ValueError when the value is out of range."""
        if isinstance(value, bool) or not isinstance(value, int):
            raise TypeError(f'{self.key}: value must be an int, got {value!r}')
        if not self.in_range(value):
            raise ValueError(f'{self.key}: {value} is outside {self.min}..{self.max}')
        if self.enc == 'offset':
            raw = value - self.min
        elif self.enc == 'twos' and value < 0:
            raw = value + (1 << self.width)
        else:
            raw = value
        if not 0 <= raw < 1 << self.width:
            raise ValueError(f'{self.key}: {value} does not fit the {self.width}-bit field')
        return raw


@dataclass(frozen=True)
class Layout:
    """A model's program body: expected versions, blocks and fields by key."""

    model: str
    version_range: Tuple[int, int]
    body_bytes: int
    blocks: Tuple[Block, ...]
    fields: Mapping[str, Field]


def _load(module: ModuleType) -> Layout:
    blocks = tuple(Block(*b) for b in module.BLOCKS)
    fields = {}
    for key, name, block, bit, width, lo, hi, default, enc, confidence in module.FIELDS:
        body_bit = (blocks[block].offset + 1) * 8 + bit
        fields[key] = Field(key, name, block, bit, width, lo, hi, default, enc, confidence, body_bit)
    return Layout(module.MODEL, tuple(module.VERSION_RANGE), module.BODY_BYTES, blocks, MappingProxyType(fields))


NS4_LAYOUT = _load(_layout_ns4)
