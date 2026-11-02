"""The README must match what the mapping and the package really do.

Each "Not converted" row names an example Stage 3 field. Every case starts
from an all-default program with the section switched on (so a report is a
warning, not a note about a switched-off section), adds the setting that
makes it a lost one, and expects a warning with the exact value. The same
program without that setting must not produce it, so a row cannot pass on a
warning that something else raised.
"""
from __future__ import annotations

import re
import unittest

from nordconv.mapping import map_program
from nordconv.program import Ns3Program
from tests.helpers import ROOT, needs_sample, ns3_variant

SYNTH_A = {'synthCommonA.enable': 1}
# Example field -> (the program with its section playing, the lost setting, the expected warning text).
CASES = {
    'synthCommonA.presetNameHash': (SYNTH_A, {'synthCommonA.presetNameHash': 0x12345678},
                                    'Panel A synth: presetNameHash=0x12345678'),
    'synthA.smpNameHash': (SYNTH_A, {'synthA.smpNameHash': 0x12345678}, 'Panel A synth: smpNameHash=0x12345678'),
    'pianoA.nameHash': ({'pianoA.enable': 1}, {'pianoA.nameHash': 0x12345678}, 'Panel A piano: nameHash=0x12345678'),
    'synthA.arpRange': (SYNTH_A, {'synthA.arpRange': 2}, 'arpRange=2'),
    'effectsA.ampBass': ({**SYNTH_A, 'effectsA.ampEnable': 1, 'effectsA.ampSrc': 2, 'effectsA.ampType': 4},
                         {'effectsA.ampBass': 20}, 'Panel A effects: ampBass=20'),
    'organPresetIIA.db1': ({'organA.enable': 1}, {'organPresetIIA.db1': 3}, 'Panel A organ: db1=3'),
    'effectsA.leslieEnable': ({**SYNTH_A, 'effectsA.leslieSrc': 2}, {'effectsA.leslieEnable': 1},
                              'Panel A effects: leslieEnable=1'),
    'effectsB.fx1Enable': ({'common.slotEnable': 3, 'organA.enable': 1, 'organB.enable': 1, 'effectsB.fx1Src': 0},
                           {'effectsB.fx1Enable': 1}, 'Panel B effects: fx1Enable=1'),
    'synthA.dualOscDetune': ({**SYNTH_A, 'synthA.oscConf': 3}, {'synthA.dualOscDetune': 19}, 'osc 2 pitch +7'),
    'synthA.fltMod': (SYNTH_A, {'synthA.fltMod': -30}, 'filter velocity amount 5.0'),
    'common.dualKbdEnable': ({}, {'common.dualKbdEnable': 1}, 'Common: dualKbdEnable=1'),
    'externA.enable': ({}, {'externA.enable': 1}, 'Panel A extern: enable=1'),
    'externA.kbZone': ({'externA.enable': 1}, {'externA.kbZone': 3}, 'Panel A extern: kbZone=3'),
    'mixerA.audioRouteProg': ({}, {'mixerA.audioRouteProg': 2}, 'Panel A mixer: audioRouteProg=2'),
    'synthA.fltLFOAmt.morphWheel': (SYNTH_A, {'synthA.fltLFOAmt.morphWheel': 30}, 'fltLFOAmt.morphWheel=+30'),
}


def warnings_for(changes: dict) -> tuple:
    return map_program(Ns3Program.from_bytes(ns3_variant(changes, all_default=True))).warnings


def readme_text() -> str:
    return (ROOT / 'README.md').read_text(encoding='utf-8')


def readme_fields() -> list:
    section = readme_text().split('### Not converted', 1)[1].split('###', 1)[0]
    return re.findall(r'^\|[^|]+\| `([^`]+)` \|', section, re.M)


class ReadmeTable(unittest.TestCase):
    def test_table_lists_exactly_the_checked_cases(self):
        self.assertEqual(sorted(readme_fields()), sorted(CASES))

    @needs_sample
    def test_every_row_is_reported_by_the_mapping(self):
        for key, (base, lost, needle) in CASES.items():
            with self.subTest(field=key):
                warnings = warnings_for({**base, **lost})
                self.assertTrue(any(needle in w for w in warnings), warnings)

    @needs_sample
    def test_no_row_passes_on_another_warning(self):
        for key, (base, _, needle) in CASES.items():
            with self.subTest(field=key):
                warnings = warnings_for(base)
                self.assertFalse(any(needle in w for w in warnings), warnings)

    @needs_sample
    def test_amp_bass_is_only_lost_in_filter_mode(self):
        base, lost, needle = CASES['effectsA.ampBass']
        self.assertFalse(any(needle in w for w in warnings_for({**base, **lost, 'effectsA.ampType': 1})))


class Disclaimer(unittest.TestCase):
    def test_readme_and_notice_disclaim_affiliation(self):
        for name in ('README.md', 'NOTICE'):
            with self.subTest(file=name):
                text = ' '.join((ROOT / name).read_text(encoding='utf-8').split())
                self.assertIn('not affiliated with, endorsed by, or supported by Clavia', text)


if __name__ == '__main__':
    unittest.main()
