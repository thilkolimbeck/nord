"""The CBIN container shared by Nord program files.

Layout (opennord src/lib/clavia/cbin.ts, checked on a sample program pair):

    0x00 b"CBIN"  0x04 u32 LE formatType  0x08 4-char tag  0x0C u16 LE bank
    0x0E u16 LE location  0x10 u32 LE category  0x14 u32 LE version x100

formatType 1 (NSM era) then has the CRC-32 (zlib) of bytes [0x2C:] at 0x18,
16 zero bytes, and the body from 0x2C to the end. formatType 0 (legacy, seen
on a few Stage 3 files) has the body from 0x18 and closes with a 2-byte LE
CRC-16/CCITT-FALSE over everything before it. The program name is not stored:
it is the filename.

The parser is strict on purpose: a converter that writes files for an
instrument must not guess about a damaged input.
"""
from __future__ import annotations

import struct
import zlib
from dataclasses import dataclass

MAGIC = b'CBIN'
FORMAT_LEGACY = 0
FORMAT_NSM = 1
HEADER_BYTES = 0x2C
LEGACY_BODY_OFFSET = 0x18
LEGACY_TRAILER_BYTES = 2
CRC_OFFSET = 0x18


class NordFileError(ValueError):
    """A file is not a valid Nord program of the expected kind."""


@dataclass(frozen=True)
class CbinHeader:
    """The header fields that carry meaning (CRC and reserved words are derived)."""

    format_type: int
    tag: str
    bank: int
    location: int
    category: int
    version: int


@dataclass(frozen=True)
class CbinFile:
    """A parsed container: header plus the instrument's record (the body)."""

    header: CbinHeader
    body: bytes


def crc16_ccitt_false(data: bytes) -> int:
    """CRC-16/CCITT-FALSE (poly 0x1021, init 0xFFFF): the legacy trailer checksum."""
    crc = 0xFFFF
    for byte in data:
        crc ^= byte << 8
        for _ in range(8):
            crc = ((crc << 1) ^ 0x1021) & 0xFFFF if crc & 0x8000 else (crc << 1) & 0xFFFF
    return crc


def parse_cbin(data: bytes, expected_tag: str) -> CbinFile:
    """Parse and verify a CBIN file; raise NordFileError on any inconsistency."""
    if len(data) < LEGACY_BODY_OFFSET:
        raise NordFileError(f'file is {len(data)} bytes, too short for a CBIN header')
    if data[:4] != MAGIC:
        raise NordFileError(f'bad magic {data[:4]!r}, expected {MAGIC!r}')
    format_type, = struct.unpack_from('<I', data, 0x04)
    tag = data[0x08:0x0C].rstrip(b'\x00 ').decode('latin-1')
    if tag != expected_tag:
        raise NordFileError(f'file type tag is {tag!r}, expected {expected_tag!r}')
    bank, location, category, version = struct.unpack_from('<HHII', data, 0x0C)
    header = CbinHeader(format_type, tag, bank, location, category, version)
    if format_type == FORMAT_NSM:
        if len(data) < HEADER_BYTES:
            raise NordFileError(f'file is {len(data)} bytes, too short for the 44-byte NSM-era header')
        stored, = struct.unpack_from('<I', data, CRC_OFFSET)
        computed = zlib.crc32(data[HEADER_BYTES:])
        if stored != computed:
            raise NordFileError(f'CRC-32 mismatch: stored 0x{stored:08x}, computed 0x{computed:08x}')
        return CbinFile(header, bytes(data[HEADER_BYTES:]))
    if format_type == FORMAT_LEGACY:
        if len(data) < LEGACY_BODY_OFFSET + LEGACY_TRAILER_BYTES:
            raise NordFileError(f'file is {len(data)} bytes, too short for a legacy CBIN file')
        stored, = struct.unpack_from('<H', data, len(data) - LEGACY_TRAILER_BYTES)
        computed = crc16_ccitt_false(data[:-LEGACY_TRAILER_BYTES])
        if stored != computed:
            raise NordFileError(f'CRC-16 trailer mismatch: stored 0x{stored:04x}, computed 0x{computed:04x}')
        return CbinFile(header, bytes(data[LEGACY_BODY_OFFSET:-LEGACY_TRAILER_BYTES]))
    raise NordFileError(f'unsupported CBIN formatType {format_type} (Nord Sound Manager reads 0 and 1)')


def build_cbin(header: CbinHeader, body: bytes) -> bytes:
    """Serialise a container in the header's own format type, checksum last."""
    tag = header.tag.encode('latin-1')
    if len(tag) > 4:
        raise ValueError(f'tag {header.tag!r} is longer than 4 characters')
    fixed = MAGIC + struct.pack('<I4sHHII', header.format_type, tag.ljust(4, b'\x00'),
                                header.bank, header.location, header.category, header.version)
    if header.format_type == FORMAT_NSM:
        return fixed + struct.pack('<I', zlib.crc32(body)) + bytes(16) + body
    if header.format_type == FORMAT_LEGACY:
        unsealed = fixed + body
        return unsealed + struct.pack('<H', crc16_ccitt_false(unsealed))
    raise ValueError(f'cannot write CBIN formatType {header.format_type}')
