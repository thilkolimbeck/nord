"""Donor neutralisation: nothing of the donor's sound may reach an output."""
from __future__ import annotations

import unittest

from nordconv.convert import _uncovered_mask
from nordconv.layout import NS4_LAYOUT
from nordconv.program import Ns4Program
from nordconv.template import CATEGORY_NONE, SWITCHES_OFF, load_template
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

    def test_all_sections_and_layers_off(self):
        self.assertIn('common.sectionEnablePno_II', SWITCHES_OFF)
        self.assertIn('synth.layerEnableSyn_I', SWITCHES_OFF)
        self.assertEqual(len(SWITCHES_OFF), 12)

    def test_undecoded_bits_are_the_donors(self):
        mask = _uncovered_mask()
        for a, b, m in zip(self.neutral.body, self.donor.body, mask):
            self.assertEqual(a & m, b & m)
        self.assertTrue(any(b & m for b, m in zip(self.donor.body, mask)), 'donor has undecoded bits set')

    def test_header_is_reset(self):
        h = self.neutral.header
        self.assertEqual((h.bank, h.location, h.category, h.version), (0, 0, CATEGORY_NONE, 313))

    def test_template_file_untouched(self):
        self.assertEqual(sha256(TEMPLATE), self.before)


if __name__ == '__main__':
    unittest.main()
