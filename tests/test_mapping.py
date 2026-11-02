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
from nordconv.map_engines import ns4_hash
from nordconv.mapping import MappingResult, map_program
from nordconv.program import Ns3Program
from nordconv.source import effective_values
from tests.helpers import NS3_SAMPLE, PUBLIC_BASE, needs_expected, needs_sample, ns3_variant, sample_expected


def mapped(changes: Dict[str, int] = None, all_default: bool = False, version: int = None) -> MappingResult:
    return map_program(Ns3Program.from_bytes(ns3_variant(changes or {}, all_default, version)))


def nsm_mapped(changes: Dict[str, int] = None) -> MappingResult:
    """An all-default program built on the public base fixture, so the test runs in a public checkout."""
    return map_program(Ns3Program.from_bytes(ns3_variant(changes or {}, all_default=True, base=PUBLIC_BASE)))


def warned(result: MappingResult, *needles: str) -> bool:
    return any(all(n in w for n in needles) for w in result.warnings)


def stage3_hash(ns4_hash: int) -> int:
    """The Stage 3 encoding of a Stage 4 name hash (the inverse of map_engines.ns4_hash)."""
    return (ns4_hash - 0x80000001) & 0xFFFFFFFF


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
        for key in ('common.sectionEnableSyn_II', 'synth.layerEnableSyn_II', 'common.sectionEnablePno_II',
                    'common.layerScene'):
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

    def test_delay_tempo_and_piano_touch_copy_the_default_too(self):
        e = mapped(all_default=True).edits
        self.assertEqual(e['pianoAFx.dlyRateClkDiv'], 8192)  # Stage 3 default, source Piano; Stage 4 default 11008
        self.assertEqual(e['pianoA.kbdTouch'], 0)  # Stage 4 default 1

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
        self.assertFalse(warned(mapped({'pianoA.enable': 1, 'pianoA.kbdTouch': 2}), 'kbdTouch'))
        r = mapped({'pianoA.enable': 1, 'pianoA.kbdTouch': 3})
        self.assertEqual(r.edits['pianoA.kbdTouch'], 2)
        self.assertTrue(warned(r, 'kbdTouch 3', 'set to 2'))

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
        off = mapped({'externA.midiCh': 5, 'effectsA.ampType': 4, 'effectsA.ampBass': 20}, all_default=True)
        self.assertEqual(off.warnings, ())
        self.assertTrue(any('midiCh=5' in n for n in off.notes))
        self.assertTrue(any('ampBass=20' in n for n in off.notes))
        on = mapped({'externA.enable': 1, 'externA.midiCh': 5, 'pianoA.enable': 1, 'effectsA.ampEnable': 1,
                     'effectsA.ampType': 4, 'effectsA.ampBass': 20}, all_default=True)
        self.assertTrue(warned(on, 'midiCh=5'))
        self.assertTrue(warned(on, 'ampBass=20'))
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
        r = mapped({'pianoA.enable': 1, 'pianoA.nameHash': stage3_hash(1209279823), 'pianoA.entry': 3})
        self.assertEqual((r.edits['pianoA.nameHash'], r.edits['pianoA.entry']), (1209279823, 3))
        self.assertTrue(warned(r, 'Panel A piano', 'may substitute a different Stage 4 piano'))

    def test_morphs_are_reported(self):
        r = mapped({'synthA.fltLFOAmt.morphWheel': 40})
        self.assertTrue(warned(r, 'Panel A synth', 'fltLFOAmt.morphWheel=+40'))

    def test_category_independent_header_left_to_converter(self):
        self.assertNotIn('header', ' '.join(mapped().edits))


SYNTH_A, SYNTH_B = {'synthCommonA.enable': 1}, {'common.slotEnable': 3, 'synthCommonB.enable': 1}


class NordSoundManagerRules(unittest.TestCase):
    """Rules that three Nord Sound Manager conversions (kept private) confirm, on synthetic inputs."""

    def test_name_hashes_are_offset_encoded(self):
        self.assertEqual(ns4_hash(0x7FFFFFFF), 0)  # the Stage 3 "none"
        self.assertEqual(ns4_hash(0xE2691536), 0x62691537)
        self.assertEqual(stage3_hash(0x62691537), 0xE2691536)

    def test_piano_substitutes(self):
        r = nsm_mapped({'pianoA.enable': 1, 'pianoA.bank': 1, 'pianoA.entry': 3, 'pianoA.nameHash': 0x354A2C60})
        self.assertEqual((r.edits['pianoA.nameHash'], r.edits['pianoA.entry'], r.edits['pianoA.bank']),
                         (0x13198A21, 0, 1))
        self.assertTrue(warned(r, 'HonkyTonkUpright Lrg became Amber Upright XL, entry 3 became 0'))
        r = nsm_mapped({'pianoA.enable': 1, 'pianoA.nameHash': 0x5303B5F1})
        self.assertEqual(r.edits['pianoA.nameHash'], 0xE986F07A)  # same name, the Stage 4 hash
        self.assertEqual(r.warnings, ())
        r = nsm_mapped({'pianoA.enable': 1, 'pianoA.nameHash': 0x5303B5F1, 'pianoA.entry': 3})
        self.assertEqual(r.edits['pianoA.entry'], 0)
        self.assertEqual(r.warnings, ('Panel A piano: entry 3 became 0, as Nord Sound Manager converts it',))

    def test_unknown_or_empty_piano(self):
        r = nsm_mapped({'pianoA.enable': 1, 'pianoA.nameHash': 0x12345678})
        self.assertNotIn('pianoA.nameHash', r.edits)
        self.assertTrue(warned(r, 'nameHash=0x12345678', 'no piano with its id 0x92345679'))
        r = nsm_mapped({'pianoA.enable': 1, 'pianoA.nameHash': 0x7FFFFFFF})
        self.assertNotIn('pianoA.nameHash', r.edits)
        self.assertEqual(r.warnings, ())

    def test_sample_oscillator_becomes_a_sample_layer(self):
        r = nsm_mapped({**SYNTH_A, 'synthA.oscBank': 4, 'synthA.smpNameHash': 0xE2691536, 'synthA.smpFastAtk': 1})
        self.assertEqual((r.edits['synthA.mode'], r.edits['synthA.smpNameHash'], r.edits['synthA.smpId']),
                         (0, 0x62691537, 0))
        self.assertTrue(warned(r, 'sample 0x62691537', 'must be on the Stage 4'))
        self.assertTrue(warned(r, 'smpFastAtk=1', 'no fast attack'))
        self.assertFalse(warned(r, 'smpNameHash'))
        self.assertFalse(warned(r, 'analog counterpart'))

    def test_sample_layer_warnings_name_the_sample_and_skip_analog_text(self):
        r = nsm_mapped({**SYNTH_A, 'synthA.oscBank': 4, 'synthA.smpNameHash': stage3_hash(3062954),
                        'synthA.oscConf': 4, 'synthA.dualOscDetune': 0, 'synthA.oscCtrl': 5})
        self.assertEqual(r.edits['synthA.smpNameHash'], 3062954)
        self.assertTrue(warned(r, 'sample 0x002EBCAA (Harjedalspipa_ST 4.1): the sample must be on the Stage 4'))
        self.assertTrue(warned(r, 'osc 2 pitch -12', 'a Stage 4 sample layer has no second-oscillator pitch'))
        self.assertTrue(warned(r, 'osc ctrl 5 copied as is; unverified whether a Stage 4 sample layer uses it'))
        self.assertFalse(warned(r, 'analog'))

    def test_sample_bank_without_a_sample_stays_analog(self):
        r = nsm_mapped({**SYNTH_A, 'synthA.oscBank': 4, 'synthA.smpNameHash': 0x7FFFFFFF})
        self.assertNotIn('synthA.mode', r.edits)
        self.assertTrue(warned(r, 'Sample oscillator wave 0', 'analog counterpart'))
        r = nsm_mapped({**SYNTH_A, 'synthA.smpNameHash': 0xE2691536})  # Classic bank
        self.assertNotIn('synthA.smpNameHash', r.edits)
        self.assertTrue(warned(r, 'smpNameHash=0xE2691536', 'only a Sample oscillator'))

    def test_cutoff_opens_two_octaves_with_key_tracking(self):
        for track, cutoff, want in ((3, 54, 78), (1, 1, 25), (2, 120, 127), (0, 54, 54)):
            with self.subTest(track=track, cutoff=cutoff):
                e = nsm_mapped({'synthA.fltKbdTrk': track, 'synthA.fltFreq': cutoff}).edits
                self.assertEqual(e['synthASound.fltFreq'], want)

    def test_resonance_is_three_quarters(self):
        for res, want in ((87, 65), (82, 61), (41, 30), (127, 95), (0, 0)):
            with self.subTest(res=res):
                self.assertEqual(nsm_mapped({'synthA.fltRes': res}).edits['synthASound.fltRes'], want)

    def test_filter_morphs_convert(self):
        r = nsm_mapped({**SYNTH_B, 'synthB.fltFreq.morphCtrlPedal': 46, 'synthB.fltRes.morphCtrlPedal': -45,
                    'synthB.fltFreq.morphWheel': -20, 'synthB.fltRes.morphAfterTouch': 45,
                    'synthB.fltKbdTrk': 1})
        e = r.edits
        self.assertEqual((e['synthBSound.fltFreq.morphCtrlPedal'], e['synthBSound.fltRes.morphCtrlPedal']), (46, -33))
        self.assertEqual((e['synthBSound.fltFreq.morphWheel'], e['synthBSound.fltRes.morphAfterTouch']), (-20, 33))
        self.assertEqual(r.warnings, ())

    def test_reverb_amount_is_seven_eighths(self):
        for amount, want in ((22, 19), (27, 23), (46, 40), (64, 56), (127, 111)):
            with self.subTest(amount=amount):
                e = nsm_mapped({'effectsB.rvbAmt': amount}).edits
                self.assertEqual((e['synthBFx.rvbAmt'], e['pianoBFx.rvbAmt']), (want, want))

    def test_super_oscillator_ctrl_is_fixed(self):
        r = nsm_mapped({**SYNTH_B, 'synthB.oscBank': 3, 'synthB.oscCtrl': 16})
        self.assertEqual((r.edits['synthBSound.oscCat'], r.edits['synthBSound.oscCtrl']), (6, 36))
        self.assertTrue(warned(r, 'osc ctrl 16 became 36'))
        r = nsm_mapped({**SYNTH_B, 'synthB.oscBank': 3})
        self.assertEqual(r.edits['synthBSound.oscCtrl'], 36)
        self.assertEqual(r.warnings, ())
        self.assertEqual(nsm_mapped({'synthB.oscCtrl': 16}).edits['synthBSound.oscCtrl'], 16)

    def test_filter_env_amount_rounds_down(self):
        for mod, want in ((14, 29), (23, 48), (47, 99), (60, 127)):
            with self.subTest(mod=mod):
                e = nsm_mapped({'synthA.fltMod': mod}).edits
                self.assertEqual(e['synthASound.fltEnvAmt'], want)

    def test_filter_mod_zero_writes_an_idle_filter_env(self):
        changes = {'synthA.modEnvAtc': 10, 'synthA.modEnvDcy': 30, 'synthA.modEnvRls': 40}
        e = nsm_mapped(changes).edits
        self.assertEqual([e[f'synthASound.fltEnv{k}'] for k in ('Atk', 'Dcy', 'Rls', 'Vel')], [10, 127, 127, 1])
        self.assertNotIn('synthASound.fltEnvAmt', e)
        e = nsm_mapped({**changes, 'synthA.fltMod': 30}).edits
        self.assertEqual([e[f'synthASound.fltEnv{k}'] for k in ('Atk', 'Dcy', 'Rls', 'Vel')], [10, 30, 40, 0])

    def test_saw_with_detune_becomes_pure_saw(self):
        r = nsm_mapped({**SYNTH_A, 'synthA.oscWave': 2, 'synthA.oscConf': 4, 'synthA.dualOscDetune': 0,
                    'synthA.oscCtrl': 10})
        e = r.edits
        self.assertEqual((e['synthASound.oscCat'], e['synthASound.oscWave'], e['synthASound.oscCtrl']), (0, 2, 10))
        self.assertTrue(warned(r, '4 Detune became Pure Saw'))
        self.assertTrue(warned(r, 'osc 2 pitch -12'))

    def test_other_hand_table_entries_are_unchanged(self):
        for (wave, conf, detune), want in (((2, 8, 0), (1, 0)), ((2, 3, 12), (2, 2)), ((1, 2, 12), (3, 0)),
                                           ((2, 0, 12), (0, 2))):
            with self.subTest(wave=wave, conf=conf):
                e = nsm_mapped({'synthA.oscWave': wave, 'synthA.oscConf': conf, 'synthA.dualOscDetune': detune}).edits
                self.assertEqual((e['synthASound.oscCat'], e['synthASound.oscWave']), want)

    def test_effects_are_per_layer_even_when_nothing_plays(self):
        e = nsm_mapped({'common.slotEnable': 1, 'synthCommonA.enable': 0}).edits
        self.assertEqual((e['piano.effectsSectionModePno'], e['synth.effectsSectionModeSyn']), (0, 0))

    def test_keyboard_hold_layer_switches_always_copy(self):
        e = nsm_mapped().edits
        self.assertEqual((e['synthA.kbdHoldEnableLayer'], e['synthB.kbdHoldEnableLayer']), (0, 0))
        self.assertNotIn('synth.kbdHoldEnableCommon', e)
        self.assertNotIn('synthC.kbdHoldEnableLayer', e)
        e = nsm_mapped({'synthA.kbdHold': 1}).edits
        self.assertEqual((e['synthA.kbdHoldEnableLayer'], e['synthB.kbdHoldEnableLayer'],
                          e['synth.kbdHoldEnableCommon']), (1, 0, 1))

    def test_zones_prefer_the_value_that_keeps_them_with_every_split_point(self):
        mid = {'common.splitEnable': 1, 'common.splitLowEnable': 0, 'common.splitMidEnable': 1}
        mid_high = {**mid, 'common.splitHighEnable': 1}
        # Stage 3 zones: 2 = oo1o, 3 = ooo1, 4 = 11oo, 6 = oo11.
        for splits, zone, want in ((mid, 4, 2), (mid, 6, 8), (mid_high, 2, 9), (mid_high, 3, 10), (mid_high, 4, 0)):
            with self.subTest(splits=sorted(splits), zone=zone):
                e = nsm_mapped({**splits, 'synthCommonA.kbZone': zone, 'pianoA.kbZone': zone}).edits
                self.assertEqual((e['synthA.kbZone'], e['pianoA.kbZone']), (want, want))

    def test_scene_two_piano_warns_when_the_stage_3_piano_is_off(self):
        r = nsm_mapped({'common.slotEnable': 1, 'pianoA.enable': 0, 'pianoA.nameHash': 0x354A2C60})
        self.assertNotIn('common.sectionEnablePno_II', r.edits)
        self.assertTrue(warned(r, 'Scene II: piano layer A (Amber Upright XL) plays',
                               'piano of Stage 3 Panel A, which is off'))
        self.assertTrue(any('HonkyTonkUpright Lrg became Amber Upright XL' in n for n in r.notes))
        r = nsm_mapped({'common.slotEnable': 1, 'pianoA.enable': 1, 'pianoA.nameHash': 0x354A2C60})
        self.assertFalse(warned(r, 'Scene II'))

    def test_scene_two_piano_only_with_a_converted_piano(self):
        self.assertEqual(nsm_mapped().edits['common.sectionEnablePno_II'], 0)
        e = nsm_mapped({'pianoA.nameHash': 0x5303B5F1}).edits
        self.assertNotIn('common.sectionEnablePno_II', e)  # the Stage 4 default (on) stays
        for key in ('organ.layerEnableOrg_II', 'synth.layerEnableSyn_II', 'piano.layerEnablePno_II'):
            self.assertNotIn(key, e)

    def test_extern_values_go_to_the_synth_layer(self):
        r = nsm_mapped({'common.slotEnable': 3, 'externB.enable': 1, 'externB.midiCh': 10, 'externB.bcValue_LSB': 1,
                    'externB.bcValue_MSB': 1, 'externB.pcValue': 83, 'externB.sendOnLoadPC': 1,
                    'externB.ctrlPedalEnable': 0})
        e = r.edits
        self.assertEqual((e['synthB.externBCValue_LSB'], e['synthB.externBCValue_MSB'], e['synthB.externPCValue'],
                          e['synthB.externCtrlPedalEnable'], e['synthB.externSendOnLoad']), (1, 1, 83, 0, 0))
        self.assertNotIn('synthB.externEnable', e)
        self.assertTrue(warned(r, 'Panel B extern: enable=1, midiCh=10', 'switched on on the layer'))
        self.assertTrue(warned(r, 'sendOnLoadPC=1', 'one send-on-load switch'))
        r = nsm_mapped({'externA.enable': 1, 'externA.paramSelect': 1, 'externA.sendOnLoadPC': 1})
        self.assertEqual(r.edits['synthA.externSendOnLoad'], 1)
        self.assertFalse(warned(r, 'sendOnLoadPC'))
        r = nsm_mapped({'externA.enable': 1, 'externA.paramSelect': 0, 'externA.ccNumber': 20,
                        'externA.ccValue': 9, 'externA.sendOnLoadCC': 1})
        self.assertEqual((r.edits['synthA.externCCValue1'], r.edits['synthA.externSendOnLoad']), (9, 1))
        self.assertNotIn('synthA.externCCNumber1', r.edits)
        self.assertTrue(warned(r, 'ccNumber=20 not converted', 'scale unverified'))
        self.assertFalse(warned(r, 'ccValue'))

    def test_rotor_angles_copy(self):
        e = nsm_mapped({'common.leslieRotorAngle': 48, 'common.leslieHornAngle': 85}).edits
        self.assertEqual((e['organ.leslieRotorAngle'], e['organ.leslieHornAngle']), (48, 85))


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
