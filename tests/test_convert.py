"""Whole-file conversion: the output is valid, verified, and never a broken file."""
from __future__ import annotations

import random
import struct
import unittest
import zlib
from dataclasses import replace

from nordconv.cbin import NordFileError
from nordconv.convert import ConversionError, _uncovered_mask, convert_bytes, ns4_category, verify
from nordconv.layout import NS3_LAYOUT, NS4_LAYOUT
from nordconv.program import Ns4Program
from nordconv.template import load_template
from tests.helpers import NS3_SAMPLE, NS4_SAMPLE, TEMPLATE, needs_sample, ns3_raw_variant, ns3_variant


@needs_sample
class Sample(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.template = load_template(TEMPLATE)
        cls.result = convert_bytes(NS3_SAMPLE.read_bytes(), cls.template)
        cls.out = Ns4Program.from_bytes(cls.result.data)

    def test_structure_matches_the_stage_4_sample(self):
        reference = NS4_SAMPLE.read_bytes()
        self.assertEqual(len(self.result.data), len(reference))
        self.assertEqual(self.result.data[:0x0C], reference[:0x0C])  # magic, formatType, tag
        self.assertEqual(self.result.data[0x14:0x18], reference[0x14:0x18])  # version 313
        self.assertEqual(self.result.data[0x2C:0x30], reference[0x2C:0x30])  # body version
        self.assertEqual(Ns4Program.from_bytes(reference).body[4:5], self.out.body[4:5])  # first block length

    def test_header_policy(self):
        h = self.out.header
        self.assertEqual((h.bank, h.location, h.category, h.version, h.format_type), (0, 0, 17, 313, 1))

    def test_every_edit_reads_back(self):
        for key, value in self.result.edits.items():
            self.assertEqual(self.out.value(key), value, key)

    def test_layers_not_mapped_stay_neutral(self):
        for key in ('synthCSound.fltType', 'synthCFx.rvbEnable', 'synthC.smpNameHash', 'synth.layerEnableSyn_II'):
            self.assertEqual(self.out.value(key), self.template.value(key), key)

    def test_conversion_is_deterministic(self):
        self.assertEqual(convert_bytes(NS3_SAMPLE.read_bytes(), self.template).data, self.result.data)

    def test_verify_catches_a_changed_field(self):
        tampered = Ns4Program.from_bytes(self.result.data)
        tampered.set('synthASound.fltFreq', 99)
        with self.assertRaisesRegex(ConversionError, 'fltFreq'):
            verify(tampered.to_bytes(), self.template, self.result.edits, 17)

    def test_verify_catches_a_changed_undecoded_bit(self):
        data = bytearray(self.result.data)
        mask = _uncovered_mask()
        structure = {0, 1, 2, 3} | {b.offset for b in NS4_LAYOUT.blocks}  # version, length prefixes
        pos = next(i for i, m in enumerate(mask) if m and i not in structure)
        data[0x2C + pos] ^= mask[pos] & -mask[pos]  # flip the lowest undecoded bit of that byte
        struct.pack_into('<I', data, 0x18, zlib.crc32(bytes(data[0x2C:])))
        with self.assertRaisesRegex(ConversionError, 'undecoded'):
            verify(bytes(data), self.template, self.result.edits, 17)

    def test_verify_catches_a_bad_checksum(self):
        data = bytearray(self.result.data)
        data[-1] ^= 0xFF
        with self.assertRaisesRegex(ConversionError, 'CRC'):
            verify(bytes(data), self.template, self.result.edits, 17)

    def test_verify_catches_a_wrong_header(self):
        bad = Ns4Program(replace(self.out.header, location=5), self.out.body)
        with self.assertRaisesRegex(ConversionError, 'header'):
            verify(bad.to_bytes(), self.template, self.result.edits, 17)


class Inputs(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.template = load_template(TEMPLATE)

    def test_categories(self):
        self.assertEqual(ns4_category(0xFFFFFFFF), (17, ''))
        self.assertEqual(ns4_category(8), (8, ''))
        category, warning = ns4_category(99)
        self.assertEqual(category, 17)
        self.assertIn('99', warning)

    @needs_sample
    def test_real_category_copies(self):
        data = bytearray(ns3_variant({}))
        struct.pack_into('<I', data, 0x10, 8)  # header only: the CRC covers the body
        out = Ns4Program.from_bytes(convert_bytes(bytes(data), self.template).data)
        self.assertEqual(out.header.category, 8)

    @needs_sample
    def test_damaged_input_is_refused(self):
        data = bytearray(NS3_SAMPLE.read_bytes())
        data[0x40] ^= 0xFF
        with self.assertRaises(NordFileError):
            convert_bytes(bytes(data), self.template)

    @needs_sample
    def test_stage_4_input_is_refused(self):
        with self.assertRaises(NordFileError):
            convert_bytes(NS4_SAMPLE.read_bytes(), self.template)

    @needs_sample
    def test_all_default_program_converts_cleanly(self):
        result = convert_bytes(ns3_variant({}, all_default=True), self.template)
        self.assertEqual(result.warnings, ())



@needs_sample
class Fuzz(unittest.TestCase):
    """Any bit pattern a valid Stage 3 container can hold converts or is refused; nothing crashes."""

    def test_random_field_values(self):
        template = load_template(TEMPLATE)
        rng = random.Random(20261031)
        fields = list(NS3_LAYOUT.fields.values())
        for round_ in range(150):
            raw = {f.key: rng.randrange(1 << f.width) for f in fields}
            data = ns3_raw_variant(raw)
            with self.subTest(round=round_):
                result = convert_bytes(data, template)
                self.assertEqual(len(result.data), 868)


if __name__ == '__main__':
    unittest.main()
