"""Donor neutralisation: nothing of the donor's sound may reach an output."""
from __future__ import annotations

import unittest

from nordconv.bits import read_bits
from nordconv.convert import _uncovered_mask
from nordconv.layout import NS4_LAYOUT
from nordconv.program import Ns4Program
from nordconv.template import CATEGORY_NONE, SWITCHES_OFF, UNDECODED_VALUES, load_template
from tests.helpers import TEMPLATE, sha256


class Neutralise(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.before = sha256(TEMPLATE)
        cls.donor = Ns4Program.from_file(TEMPLATE)
        cls.neutral = load_template(TEMPLATE)

    def test_donor_has_a_sound_to_hide(self):
        """Guards the test itself: the donor really is far from neutral."""
        changed = [k for k, f in NS4_LAYOUT.fields.items() if self.donor.value(k) != f.default]
        self.assertGreater(len(changed), 400)

    def test_every_known_field_is_default_or_off(self):
        for key, f in NS4_LAYOUT.fields.items():
            want = 0 if key in SWITCHES_OFF else f.default
            with self.subTest(key=key):
                self.assertEqual(self.neutral.value(key), want)

    def test_scene_one_off_scene_two_at_the_stage_4_defaults(self):
        self.assertIn('synth.layerEnableSyn_I', SWITCHES_OFF)
        self.assertEqual(len(SWITCHES_OFF), 6)
        for key in ('common.sectionEnablePno_II', 'piano.layerEnablePno_II', 'organ.layerEnableOrg_II',
                    'synth.layerEnableSyn_II'):
            self.assertNotIn(key, SWITCHES_OFF)
            self.assertEqual(self.neutral.value(key), 1, key)

    def test_undecoded_bits_are_the_donors_except_nord_sound_managers_values(self):
        patched = bytearray(len(self.donor.body))
        blocks = {b.key: b for b in NS4_LAYOUT.blocks}
        for block, bit, width, value in UNDECODED_VALUES:
            start = (blocks[block].offset + 1) * 8 + bit
            self.assertEqual(read_bits(self.neutral.body, start, width), value, block)
            for n in range(start, start + width):
                patched[n >> 3] |= 0x80 >> (n & 7)
        mask = _uncovered_mask()
        self.assertEqual([m & p for m, p in zip(mask, patched)], list(patched), 'only undecoded bits are patched')
        for a, b, m, p in zip(self.neutral.body, self.donor.body, mask, patched):
            self.assertEqual(a & m & ~p, b & m & ~p)
        self.assertTrue(any(b & m for b, m in zip(self.donor.body, mask)), 'donor has undecoded bits set')

    def test_header_is_reset(self):
        h = self.neutral.header
        self.assertEqual((h.bank, h.location, h.category, h.version), (0, 0, CATEGORY_NONE, 313))

    def test_template_file_untouched(self):
        self.assertEqual(sha256(TEMPLATE), self.before)


if __name__ == '__main__':
    unittest.main()
