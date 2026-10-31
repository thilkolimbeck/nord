"""The container and bit-field layer: strict parsing, exact round trips."""
from __future__ import annotations

import struct
import unittest
import zlib

from nordconv.bits import read_bits, write_bits
from nordconv.cbin import NordFileError, parse_cbin
from nordconv.program import Ns3Program, Ns4Program
from tests.helpers import NS3_SAMPLE, NS4_SAMPLE, TEMPLATE, needs_sample


def reseal(data: bytearray) -> bytes:
    """Fix the CRC-32 after a deliberate body edit."""
    struct.pack_into('<I', data, 0x18, zlib.crc32(bytes(data[0x2C:])))
    return bytes(data)


class RoundTrip(unittest.TestCase):
    def test_template_rebuilds_byte_for_byte(self):
        data = TEMPLATE.read_bytes()
        self.assertEqual(Ns4Program.from_bytes(data).to_bytes(), data)

    @needs_sample
    def test_samples_rebuild_byte_for_byte(self):
        for cls, path in ((Ns3Program, NS3_SAMPLE), (Ns4Program, NS4_SAMPLE)):
            with self.subTest(model=cls.__name__):
                data = path.read_bytes()
                self.assertEqual(cls.from_bytes(data).to_bytes(), data)

    def test_bits_write_only_their_range(self):
        buf = bytearray(b'\xff\x00\xff')
        write_bits(buf, 6, 5, 0b10101)
        self.assertEqual(read_bits(buf, 6, 5), 0b10101)
        self.assertEqual(buf[0] & 0xFC, 0xFC)
        self.assertEqual(buf[2] & 0x7F, 0x7F)


@needs_sample
class Rejection(unittest.TestCase):
    def test_crc_mismatch(self):
        data = bytearray(NS3_SAMPLE.read_bytes())
        data[100] ^= 0x01
        with self.assertRaisesRegex(NordFileError, 'CRC'):
            Ns3Program.from_bytes(bytes(data))

    def test_truncated_file(self):
        data = NS4_SAMPLE.read_bytes()
        for cut in (0, 10, 43, 500, len(data) - 1):
            with self.subTest(cut=cut), self.assertRaises(NordFileError):
                Ns4Program.from_bytes(data[:cut])

    def test_wrong_model(self):
        with self.assertRaisesRegex(NordFileError, 'tag'):
            Ns3Program.from_bytes(NS4_SAMPLE.read_bytes())

    def test_broken_block_chain_with_valid_crc(self):
        data = bytearray(NS4_SAMPLE.read_bytes())
        data[0x2C + 4] += 1  # first block length prefix
        with self.assertRaises(NordFileError):
            Ns4Program.from_bytes(reseal(data))

    def test_bad_magic(self):
        data = bytearray(NS3_SAMPLE.read_bytes())
        data[0:4] = b'XBIN'
        with self.assertRaisesRegex(NordFileError, 'magic'):
            parse_cbin(bytes(data), 'ns3f')

    def test_every_checked_byte_flip_is_rejected(self):
        """Magic, format type, tag, CRC and every body byte are protected; a flip there never passes."""
        data = NS3_SAMPLE.read_bytes()
        checked = list(range(0x00, 0x0C)) + list(range(0x18, 0x1C)) + list(range(0x2C, len(data)))
        for pos in checked:
            corrupt = bytearray(data)
            corrupt[pos] ^= 0x5A
            with self.subTest(pos=pos), self.assertRaises(NordFileError):
                Ns3Program.from_bytes(bytes(corrupt))


if __name__ == '__main__':
    unittest.main()
