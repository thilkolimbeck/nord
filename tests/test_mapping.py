"""The Phase 1 mapping rules.

SampleExpected checks the private sample program against its expected values
in presets/expected-mapping.json (gitignored, next to the sample pair): the
faithful mapping from a private cross-check, not the hand-edited Stage 4 file,
so those values are the contract. The other tests build their inputs from the
sample (see tests/helpers.py); all of them skip in a public checkout.
"""
from __future__ import annotations

import unittest
from typing import Dict

from nordconv.cbin import NordFileError
from nordconv.layout import NS3_LAYOUT
from nordconv.mapping import MappingResult, map_program
from nordconv.program import Ns3Program
from nordconv.source import effective_values
from tests.helpers import NS3_SAMPLE, needs_expected, needs_sample, ns3_variant, sample_expected


def mapped(changes: Dict[str, int] = None, all_default: bool = False, version: int = None) -> MappingResult:
    return map_program(Ns3Program.from_bytes(ns3_variant(changes or {}, all_default, version)))


def warned(result: MappingResult, *needles: str) -> bool:
    return any(all(n in w for n in needles) for w in result.warnings)


@needs_sample
class SampleExpected(unittest.TestCase):
    """The sample's conversion: every expected value of the private cross-check, and its reports."""

    @classmethod
    def setUpClass(cls):
        cls.result = map_program(Ns3Program.from_file(NS3_SAMPLE))
        cls.e = cls.result.edits

    @needs_expected
    def test_expected_edits(self):
        for group, table in sample_expected()['edits'].items():
            for key, want in table.items():
                with self.subTest(group=group, key=key):
                    self.assertEqual(self.e.get(key), want)

    @needs_expected
    def test_expected_absent_edits(self):
        for key, why in sample_expected()['absent'].items():
            with self.subTest(key=key):
                self.assertNotIn(key, self.e, why)

    @needs_expected
    def test_expected_reports(self):
        expected, r = sample_expected(), self.result
        for needles in expected['warnings']:
            with self.subTest(warning=needles):
                self.assertTrue(warned(r, *needles), r.warnings)
        for needles in expected['notes']:
            with self.subTest(note=needles):
                self.assertTrue(any(all(n in note for n in needles) for note in r.notes), r.notes)
        for needles in expected['not_warned']:
            with self.subTest(not_warned=needles):
                self.assertFalse(warned(r, *needles), r.warnings)

    def test_scene_two_stays_at_the_template(self):
        for key in ('common.sectionEnableSyn_II', 'synth.layerEnableSyn_II', 'common.layerScene'):
            self.assertNotIn(key, self.e, 'scene II stays at the neutral template')

    def test_every_field_has_a_rule(self):
        self.assertEqual(self.result.unhandled, ())


@needs_sample
class Defaults(unittest.TestCase):
    """An all-default Stage 3 program converts without a single warning."""

    def test_silent_at_default(self):
        result = mapped(all_default=True)
        self.assertEqual(result.warnings, ())
        self.assertEqual(result.unhandled, ())

    def test_unverified_scales_map_default_to_default(self):
        e = mapped(all_default=True).edits
        self.assertEqual(e['pianoAFx.dlyRateClkDiv'], 11008)  # Stage 3 default 8192, source Piano
        self.assertEqual(e['pianoA.kbdTouch'], 1)

    def test_shared_scales_copy_the_default_too(self):
        e = mapped(all_default=True).edits
        self.assertEqual(e['synthASound.lfoRateClkDiv'], 0)  # 0.03 Hz on both, not the Stage 4 default 4.1 Hz
        # String resonance and pedal noise stay off (the Stage 4 defaults are on).
        self.assertEqual((e['pianoA.acoustic'], e['pianoA.pedalNoise']), (0, 0))
        self.assertEqual((e['pianoB.acoustic'], e['pianoB.pedalNoise']), (0, 0))

    def test_default_zone_is_whole_keyboard(self):
        e = mapped(all_default=True).edits
        self.assertEqual((e['organA.kbZone'], e['pianoB.kbZone'], e['synthA.kbZone']), (5, 5, 5))


@needs_sample
class Rules(unittest.TestCase):
    def test_panel_b_only(self):
        e = mapped({'common.slotEnable': 2}).edits
        self.assertEqual(e['synth.layerEnableSyn_I'], 2)

    def test_engine_off_in_an_active_panel_stays_off(self):
        e = mapped({'synthCommonB.enable': 0}).edits
        self.assertEqual(e['synth.layerEnableSyn_I'], 1)

    def test_reverb_variants(self):
        for ns3, ns4 in ((0, 4), (1, 5), (2, 6), (3, 7), (4, 8), (5, 9)):
            with self.subTest(ns3=ns3):
                self.assertEqual(mapped({'effectsB.rvbType': ns3}).edits['synthBFx.rvbType'], ns4)

    def test_effect_types(self):
        e = mapped({'effectsA.fx1Enable': 1, 'effectsA.fx1Src': 2, 'effectsA.fx1Type': 5,
                    'effectsB.fx2Type': 5}).edits
        self.assertEqual(e['synthAFx.fx1Type'], 7)  # Auto-Wah 2 -> A-WAH variation
        self.assertEqual(e['synthBFx.fx2Type'], 5)  # Chorus 2 -> CHOR variation

    def test_effect_routed_by_source(self):
        e = mapped({'effectsB.fx2Src': 1}).edits
        self.assertEqual(e['pianoBFx.fx2Type'], 6)
        self.assertNotIn('synthBFx.fx2Type', e)

    def test_amp_types(self):
        for ns3, ns4 in ((0, 0), (1, 1), (2, 3), (3, 5), (4, 8), (5, 9)):
            with self.subTest(ns3=ns3):
                self.assertEqual(mapped({'effectsA.ampType': ns3}).edits['synthAFx.ampTypeNew'], ns4)
        self.assertTrue(warned(mapped({'effectsA.ampType': 0}), 'Clean'))

    def test_eq_bands_are_re_encoded_by_value(self):
        e = mapped({'effectsA.ampType': 1, 'effectsA.ampBass': -25, 'effectsA.ampTreble': 7}).edits
        self.assertEqual((e['synthAFx.ampBass'], e['synthAFx.ampTreble']), (-25, 7))

    def test_voice_modes(self):
        for ns3, ns4 in ((0, 0), (1, 2), (2, 1)):
            with self.subTest(ns3=ns3):
                self.assertEqual(mapped({'synthA.voiceMode': ns3}).edits['synthA.voiceMode'], ns4)

    def test_octave_clamped_and_reported(self):
        r = mapped({'synthCommonA.octaveShift': 4})
        self.assertEqual(r.edits['synthA.octaveShift'], 2)
        self.assertTrue(warned(r, 'octave shift +4'))

    def test_lossy_parameters_warn_only_when_not_default(self):
        self.assertTrue(warned(mapped({'synthA.arpRange': 2}), 'arpRange=2'))
        self.assertFalse(warned(mapped({'synthA.arpRange': 0}), 'arpRange'))
        self.assertTrue(warned(mapped({'pianoA.enable': 1, 'pianoA.kbdTouch': 2}), 'kbdTouch 2', 'unverified'))

    def test_lfo_rate_copies(self):
        r = mapped({'synthA.lfoRateClkDiv': 30, 'synthA.fltLFOAmt': 127}, all_default=True)
        self.assertEqual(r.edits['synthASound.lfoRateClkDiv'], 30)
        self.assertFalse(warned(r, 'lfoRateClkDiv'))

    def test_piano_switches_copy(self):
        for changes, want in (({'pianoA.acoustic': 1}, (1, 0)), ({'pianoA.acoustic': 2}, (2, 0)),
                              ({'pianoA.pedalNoise': 1}, (0, 1))):
            with self.subTest(changes=changes):
                r = mapped({'pianoA.enable': 1, **changes}, all_default=True)
                self.assertEqual((r.edits['pianoA.acoustic'], r.edits['pianoA.pedalNoise']), want)
                self.assertEqual(r.warnings, ())

    def test_rotary_speed_and_stop_mode(self):
        # leslieSpeed: bit 1 fast, bit 0 stop mode off (viewer fixtures: stop mode on = 2, off = 3).
        for speed, want in ((0, (1, 0)), (1, (0, 0)), (2, (1, 1)), (3, (0, 1))):
            with self.subTest(speed=speed):
                e = mapped({'common.leslieSpeed': speed}).edits
                self.assertEqual((e['organ.effectsLeslieStopMode'], e['organ.effectsLeslieSpeed']), want)

    def test_organ_vibrato_for_every_model(self):
        for ns3, vox, farfisa in ((0, 0, 0), (2, 1, 1), (3, 2, 2), (4, 2, 3), (5, None, 3)):
            with self.subTest(ns3=ns3):
                r = mapped({'organA.enable': 1, 'organA.model': 1, 'common.orgVibratoType': ns3}, all_default=True)
                self.assertEqual(r.edits['organ.vibratoTypeB3'], ns3)
                self.assertEqual(r.edits.get('organ.vibratoTypeVox'), vox)
                self.assertEqual(r.edits['organ.vibratoTypeFarfisa'], farfisa)
                self.assertEqual(warned(r, 'no Vox setting'), vox is None)

    def test_layer_detune_becomes_piano_unison(self):
        r = mapped({'pianoA.enable': 1, 'common.layerDetune': 2}, all_default=True)
        self.assertEqual((r.edits['pianoA.unison'], r.edits['pianoB.unison']), (2, 2))
        self.assertTrue(warned(r, 'layer detune 2', 'approximated'))
        silent = mapped({'common.layerDetune': 2}, all_default=True)  # no piano plays
        self.assertEqual(silent.warnings, ())
        self.assertTrue(any('layer detune 2' in n for n in silent.notes))

    def test_reports_follow_section_activity(self):
        off = mapped({'externA.midiCh': 5, 'effectsA.dlyRateClkDiv': 4000}, all_default=True)
        self.assertEqual(off.warnings, ())
        self.assertTrue(any('midiCh=5' in n for n in off.notes))
        self.assertTrue(any('dlyRateClkDiv 4000' in n for n in off.notes))
        on = mapped({'externA.enable': 1, 'externA.midiCh': 5, 'pianoA.enable': 1, 'effectsA.dlyEnable': 1,
                     'effectsA.dlyRateClkDiv': 4000}, all_default=True)
        self.assertTrue(warned(on, 'midiCh=5'))
        self.assertTrue(warned(on, 'dlyRateClkDiv 4000'))
        inactive_panel = mapped({'common.slotEnable': 1, 'synthCommonB.enable': 1, 'synthA.arpRange': 0,
                                 'synthB.arpRange': 2}, all_default=True)
        self.assertFalse(warned(inactive_panel, 'arpRange'))
        self.assertTrue(any('arpRange=2' in n for n in inactive_panel.notes))

    def test_unknown_oscillator_configuration_falls_back_and_warns(self):
        r = mapped({'synthA.oscConf': 12, 'synthA.dualOscDetune': 12})
        self.assertEqual((r.edits['synthASound.oscCat'], r.edits['synthASound.oscWave']), (0, 2))
        self.assertTrue(warned(r, '12 FM1'))

    def test_wave_bank_is_reported(self):
        self.assertTrue(warned(mapped({'synthA.oscBank': 1}), 'Wave oscillator'))

    def test_negative_mods_and_filter_lfo_share_one_lfo(self):
        r = mapped({'synthA.fltLFOAmt': 50, 'synthA.oscMod': -30})
        self.assertEqual((r.edits['synthASound.lfoDst'], r.edits['synthASound.lfoAmt']), (3, 50))
        self.assertTrue(warned(r, 'osc mod -30', 'one LFO destination'))

    def test_negative_filter_mod_is_velocity_not_lfo(self):
        # Viewer fixture velAmount 10.0 decodes to fltMod -60 (with fltLFOAmt 64).
        r = mapped({'synthCommonA.enable': 1, 'synthA.fltMod': -60}, all_default=True)
        self.assertNotIn('synthASound.lfoDst', r.edits)
        self.assertNotIn('synthASound.lfoAmt', r.edits)
        self.assertNotIn('synthASound.fltEnvAmt', r.edits)
        self.assertEqual(r.edits['synthASound.fltEnvVel'], 0)  # still the mod env's own velocity switch
        self.assertTrue(warned(r, 'filter velocity amount 10.0', 'not converted'))
        r = mapped({'synthCommonA.enable': 1, 'synthA.fltMod': -60, 'synthA.fltLFOAmt': 64}, all_default=True)
        self.assertEqual((r.edits['synthASound.lfoDst'], r.edits['synthASound.lfoAmt']), (3, 64))
        self.assertFalse(warned(r, 'one LFO destination'))

    def test_filter_lfo_amount_is_reported(self):
        r = mapped({'synthCommonA.enable': 1, 'synthA.fltLFOAmt': 50}, all_default=True)
        self.assertEqual((r.edits['synthASound.lfoDst'], r.edits['synthASound.lfoAmt']), (3, 50))
        self.assertTrue(warned(r, 'filter LFO amount 50', 'unverified'))

    def test_organ_active_preset_and_ownership(self):
        r = mapped({'organA.enable': 1, 'organB.enable': 1, 'organA.presetFocus': 1, 'organPresetIIA.db1': 3,
                    'organPresetIA.db1': 2,
                    'effectsB.fx1Enable': 1, 'effectsB.fx1Src': 0, 'effectsA.leslieEnable': 1})
        e = r.edits
        self.assertEqual(e['organ.layerEnableOrg_I'], 3)
        self.assertEqual(e['organADrawbars.org_Preset_kDb1'], 3)
        self.assertEqual(e['organ.effectsLeslieEnable'], 1)
        self.assertTrue(warned(r, 'Panel B effects', 'fx1Enable=1', 'Panel A uses'))
        self.assertTrue(warned(r, 'Panel A organ', 'preset II is the active one'))

    def test_organ_block_goes_to_panel_b_when_only_its_organ_plays(self):
        e = mapped({'organB.enable': 1, 'effectsB.fx1Enable': 1, 'effectsB.fx1Src': 0}).edits
        self.assertEqual(e['organFx.fx1Enable'], 1)
        self.assertEqual(e['organFx.rvbType'], 6)  # Panel B reverb Stage 1

    def test_piano_sound_kept_when_the_stage_4_knows_it(self):
        e = mapped({'pianoA.nameHash': 1209279823, 'pianoA.entry': 3}).edits
        self.assertEqual((e['pianoA.nameHash'], e['pianoA.entry']), (1209279823, 3))

    def test_morphs_are_reported(self):
        self.assertTrue(warned(mapped({'synthA.fltFreq.morphWheel': 40}), 'Panel A synth', 'fltFreq.morphWheel=+40'))

    def test_category_independent_header_left_to_converter(self):
        self.assertNotIn('header', ' '.join(mapped().edits))


MORPHS = ('morphWheel', 'morphAfterTouch', 'morphCtrlPedal')
OS300_NO_MORPH = 127 - 16383


def os300(changes: Dict[str, int]) -> bytes:
    """A format 3.00 file: delay rates on the 0-127 scale and morph deltas stored as delta + 127."""
    values = {f'effects{p}.dlyRateClkDiv{"." + m if m else ""}': OS300_NO_MORPH if m else 0
              for p in 'AB' for m in ('',) + MORPHS}
    values.update(changes)
    return ns3_variant(values, version=300)


class FormatFixups(unittest.TestCase):
    @needs_sample
    def test_dual_kb_style_below_302(self):
        values, _ = effective_values(Ns3Program.from_bytes(ns3_variant({'common.dualKbdStyle': 0}, version=301)))
        self.assertEqual(values['common.dualKbdStyle'], 1)

    @needs_sample
    def test_os300_clock_synced_delay_rate(self):
        data = os300({'effectsA.dlyClkEnable': 1, 'effectsB.dlyClkEnable': 1, 'effectsA.dlyRateClkDiv': 64,
                      'effectsA.dlyRateClkDiv.morphWheel': OS300_NO_MORPH + 10})
        values, notes = effective_values(Ns3Program.from_bytes(data))
        self.assertEqual(values['effectsA.dlyRateClkDiv'], 8192)
        self.assertEqual(values['effectsA.dlyRateClkDiv.morphWheel'], 74 * 128 - 8192)
        self.assertEqual(values['effectsA.dlyRateClkDiv.morphAfterTouch'], 0)
        self.assertEqual(notes, [])

    @needs_sample
    def test_os300_free_running_delay_rate_is_reported(self):
        data = os300({'effectsB.dlyRateClkDiv': 40})
        values, notes = effective_values(Ns3Program.from_bytes(data))
        self.assertTrue(any('3.00 scale' in n for n in notes))
        for p in 'AB':  # unassigned morphs are re-zeroed, not left at the raw -16256
            for m in MORPHS:
                self.assertEqual(values[f'effects{p}.dlyRateClkDiv.{m}'], 0)
        result = map_program(Ns3Program.from_bytes(data))
        self.assertFalse([w for w in result.warnings + result.notes if 'dlyRateClkDiv.morph' in w])

    @needs_sample
    def test_os300_rate_the_stage_3_refuses(self):
        data = os300({'effectsA.dlyRateClkDiv': 200})
        with self.assertRaises(NordFileError):
            effective_values(Ns3Program.from_bytes(data))

    def test_layout_covers_every_field_once(self):
        self.assertEqual(len(set(NS3_LAYOUT.fields)), len(NS3_LAYOUT.fields))


if __name__ == '__main__':
    unittest.main()
