"""Mapping rules for one Stage 3 panel's organ, piano and synth.

Panel A becomes layer A and Panel B layer B of each Stage 4 section in scene
I (approved default). Each rule follows docs/phase1-mapping.md, as corrected
by later review: values copy where both models share a table, enums are
remapped by their labels, and every approximation is reported.
"""
from __future__ import annotations

from typing import List, Tuple

from ._tables_ns3 import PIANO_TYPE, SYNTH_OSC
from ._tables_ns4 import PIANO_NAMES
from .keyboard import map_octave, map_zone
from .layout import NS4_LAYOUT
from .mapper import Mapper
from .oscillators import DETUNE_UNISON, map_oscillator

DRAWBARS = tuple(f'db{n}' for n in range(1, 10))
VIB_PERC = (('vibratoEnable', 'org_Preset_kVibratoEnable'), ('b3PercEnable', 'org_Preset_kB3PercEnable'),
            ('b3PercHarmonic', 'org_Preset_kB3PercHarmonic'), ('b3PercSpeed', 'org_Preset_kB3PercSpeed'),
            ('b3PercLevel', 'org_Preset_kB3PercLevel'))

# Stage 3 Poly/Legato/Mono -> Stage 4 voiceMode, whose bit 0 is mono and bit 1 legato (ns4decode 416-6/416-7).
VOICE_MODE = {0: 0, 1: 2, 2: 1}
# Stage 3 vibrato Off/Delay 1-3/Wheel/After Touch -> Stage 4 none/DLY/WHL/A.T.
VIBRATO_OFF, VIBRATO_DELAY, VIBRATO_WHEEL, VIBRATO_AT = 0, 2, 3, 4
VIBRATO_MODE = {0: VIBRATO_OFF, 1: VIBRATO_DELAY, 2: VIBRATO_DELAY, 3: VIBRATO_DELAY, 4: VIBRATO_WHEEL,
                5: VIBRATO_AT}
LFO_OSC_CTRL, LFO_FILTER = 1, 3
MOD_RANGE = 60
SEVEN_BIT = 127
ENV_STAGES = (('modEnvAtc', 'EnvAtk'), ('modEnvDcy', 'EnvDcy'), ('modEnvRls', 'EnvRls'), ('modEnvVel', 'EnvVel'))


def map_organ(m: Mapper, p: str) -> None:
    """Panel organ -> organ layer: level, zone, model and the active drawbar preset."""
    w = f'Panel {p} organ'
    m.copy(f'organ{p}.level', f'organ.layerLevelOrg{p}', w)
    map_zone(m, f'organ{p}.kbZone', f'organ{p}.kbZone', w)
    map_octave(m, f'organ{p}.octaveShift', f'organ{p}.octaveShift', w)
    m.copy(f'organ{p}.sustainEnable', f'organ{p}.sustainEnable', w)
    m.copy(f'organ{p}.model', f'organ{p}.model', w)
    focus = m.v(f'organ{p}.presetFocus')
    active, idle = ('II', 'I') if focus & 1 else ('I', 'II')
    if focus > 1:
        m.warn(w, f'preset focus {focus} has an unknown meaning; preset {active} was converted')
    src = f'organPreset{active}{p}'
    for n, db in enumerate(DRAWBARS, 1):
        m.copy(f'{src}.{db}', f'organ{p}Drawbars.org_Preset_kDb{n}', w)
    for ns3, ns4 in VIB_PERC:
        m.copy(f'{src}.{ns3}', f'organ{p}VibPerc.{ns4}', w)
    idle_keys = [f'organPreset{idle}{p}.{k}' for k in DRAWBARS + tuple(a for a, _ in VIB_PERC)]
    m.drop(w, idle_keys, f'a Stage 4 organ layer holds one drawbar preset, and preset {active} is the active one')


def map_piano(m: Mapper, p: str) -> None:
    """Panel piano -> piano layer; the sound itself only when the Stage 4 knows its id."""
    w = f'Panel {p} piano'
    m.copy(f'piano{p}.level', f'piano.layerLevelPno{p}', w)
    map_zone(m, f'piano{p}.kbZone', f'piano{p}.kbZone', w)
    map_octave(m, f'piano{p}.octaveShift', f'piano{p}.octaveShift', w)
    m.copy(f'piano{p}.pitchStickEnable', f'piano{p}.pStickEnable', w)
    m.copy(f'piano{p}.sustainEnable', f'piano{p}.sustainEnable', w)
    m.copy(f'piano{p}.bank', f'piano{p}.bank', w)
    sound = (f'piano{p}.nameHash', f'piano{p}.entry', f'piano{p}.variation')
    if m.v(sound[0]) in PIANO_NAMES:
        for key in sound:
            m.copy(key, key, w)
    else:
        bank = m.v(f'piano{p}.bank')
        kind = PIANO_TYPE[bank] if bank < len(PIANO_TYPE) else 'matching'
        m.drop(w, sound, f'the Stage 4 has no piano with this id; pick a {kind} piano on the Stage 4')
    # Same bits on both models (soft release, string resonance; pedal noise), but the Stage 4
    # defaults are on: a guess() would switch them on for an all-default Stage 3 piano.
    m.copy(f'piano{p}.acoustic', f'piano{p}.acoustic', w)
    m.copy(f'piano{p}.pedalNoise', f'piano{p}.pedalNoise', w)
    m.guess(f'piano{p}.kbdTouch', f'piano{p}.kbdTouch', w)
    m.copy(f'piano{p}.eq', f'piano{p}.eq', w)


def map_synth(m: Mapper, p: str) -> None:
    """Panel synth -> synth layer: voice, arp, oscillator, filter, envelopes and LFO."""
    w = f'Panel {p} synth'
    c, s, layer, snd = f'synthCommon{p}', f'synth{p}', f'synth{p}', f'synth{p}Sound'
    m.copy(f'{c}.level', f'synth.layerLevelSyn{p}', w)
    map_zone(m, f'{c}.kbZone', f'{layer}.kbZone', w)
    map_octave(m, f'{c}.octaveShift', f'{layer}.octaveShift', w)
    m.copy(f'{c}.pitchStickEnable', f'{layer}.pStickEnable', w)
    m.copy(f'{c}.sustainEnable', f'{layer}.sustainEnable', w)
    m.drop(w, [f'{c}.presetPos', f'{c}.presetNameHash'] + [f'{c}.name{n}' for n in range(1, 9)],
           'Stage 3 synth presets are not part of the Stage 4 library; the sound is converted parameter by parameter')
    _voice(m, s, layer, w)
    _arp(m, s, layer, w)
    _oscillator(m, s, snd, w)
    for key in ('fltType', 'fltFreq', 'fltRes', 'fltKbdTrk', 'fltDrive'):
        m.copy(f'{s}.{key}', f'{snd}.{key}', w)
    for ns3, ns4 in (('ampEnvAtc', 'ampEnvAtk'), ('ampEnvDcy', 'ampEnvDcy'), ('ampEnvRls', 'ampEnvRls'),
                     ('ampEnvVel', 'ampEnvVel')):
        m.copy(f'{s}.{ns3}', f'{snd}.{ns4}', w)
    _modulation(m, s, snd, w)
    m.drop(w, [f'{s}.smpNameHash', f'{s}.smpFastAtk'],
           'Stage 3 samples have no known Stage 4 sample id; pick a sample on the Stage 4')


def _voice(m: Mapper, s: str, layer: str, w: str) -> None:
    mode = m.v(f'{s}.voiceMode')
    if mode in VOICE_MODE:
        m.set(f'{layer}.voiceMode', VOICE_MODE[mode])
    else:
        m.warn(w, f'voice mode {mode} is unknown, left at Poly')
    m.copy(f'{s}.glideRate', f'{layer}.glideRate', w)
    m.copy(f'{s}.unison', f'{layer}.oscUnison', w)
    vibrato = m.v(f'{s}.vibratoMode')
    m.set(f'{layer}.vibMode', VIBRATO_MODE.get(vibrato, VIBRATO_OFF))
    if VIBRATO_MODE.get(vibrato) == VIBRATO_DELAY:
        m.warn(w, f'vibrato Delay {vibrato} became DLY; its delay time is left at the Stage 4 default')
    elif vibrato not in VIBRATO_MODE:
        m.warn(w, f'vibrato mode {vibrato} is unknown, set to off')


def _arp(m: Mapper, s: str, layer: str, w: str) -> None:
    for key in ('arpRun', 'arpKbdSync', 'arpClkEnable', 'arpRateClkDiv'):
        m.copy(f'{s}.{key}', f'{layer}.{key}', w)
    m.copy(f'{s}.arpPattern', f'{layer}.arpDir', w)
    m.drop(w, [f'{s}.arpRange'], 'the Stage 4 arpeggiator range uses an unknown scale')


def _oscillator(m: Mapper, s: str, snd: str, w: str) -> None:
    bank, wave = m.v(f'{s}.oscBank'), m.v(f'{s}.oscWave')
    conf, detune = m.v(f'{s}.oscConf'), m.v(f'{s}.dualOscDetune')
    choice = map_oscillator(bank, wave, conf, detune)
    m.set(f'{snd}.oscBank', 0)
    if choice is None:
        kind = SYNTH_OSC[bank] if bank < len(SYNTH_OSC) else f'#{bank}'
        m.warn(w, f'{kind} oscillator wave {wave} has no Stage 4 analog counterpart; '
                  'the Stage 4 default wave was kept, pick a sound on the Stage 4')
    else:
        m.set(f'{snd}.oscCat', choice.category)
        m.set(f'{snd}.oscWave', choice.wave)
        if choice.lossy:
            m.warn(w, f'oscillator not matched exactly: {choice.lossy}')
    if conf and not (choice and choice.uses_detune) and detune != DETUNE_UNISON:
        m.warn(w, f'osc 2 pitch {detune - DETUNE_UNISON:+d} semitones not converted: '
                  'the Stage 4 analog oscillators have no second-oscillator pitch')
    ctrl = f'{s}.oscCtrl'
    m.copy(ctrl, f'{snd}.oscCtrl', w)
    if not m.is_default(ctrl):
        m.warn(w, f'osc ctrl {m.v(ctrl)} copied as is; what it controls depends on the oscillator and '
                  'differs on the Stage 4')


def _modulation(m: Mapper, s: str, snd: str, w: str) -> None:
    """Mod env -> filter env (plus osc env when osc mod is on); filter LFO and negative osc mod -> the LFO.

    The Stage 3 filter Mod knob is Vel Amount left of centre and Mod Env Amount right of it
    (ns3-program-viewer ns3-synth-filter.js); only the osc Mod knob has the LFO on its left.
    """
    for ns3, ns4 in ENV_STAGES:
        m.copy(f'{s}.{ns3}', f'{snd}.flt{ns4}', w)
    flt_mod, osc_mod = m.bounded(f'{s}.fltMod', w), m.bounded(f'{s}.oscMod', w)
    if flt_mod > 0:
        m.set(f'{snd}.fltEnvAmt', round(flt_mod * SEVEN_BIT / MOD_RANGE))
    elif flt_mod < 0:
        m.warn(w, f'filter velocity amount {-flt_mod * 10 / MOD_RANGE:.1f} (fltMod {flt_mod}) not converted: '
                  'the Stage 4 filter has no velocity amount, only a velocity switch for its envelope')
    if osc_mod > 0:
        # Both models scale the osc env amount -60..+60 (Stage 4 table 571-5: 60 = 10.0).
        m.set(f'{snd}.oscEnvAmt', osc_mod)
        for ns3, ns4 in ENV_STAGES:
            m.copy(f'{s}.{ns3}', f'{snd}.osc{ns4}', w)
    m.copy(f'{s}.lfoWave', f'{snd}.lfoWave', w)
    m.copy(f'{s}.lfoClkEnable', f'{snd}.lfoClkEnable', w)
    # Both models share the LFO rate tables to within one rounding step (opennord deps 576-6).
    m.copy(f'{s}.lfoRateClkDiv', f'{snd}.lfoRateClkDiv', w)
    wanted: List[Tuple[int, int, str]] = []
    lfo_amount = m.v(f'{s}.fltLFOAmt')
    if lfo_amount:
        wanted.append((LFO_FILTER, lfo_amount, f'filter LFO amount {lfo_amount}'))
    if osc_mod < 0:
        wanted.append((LFO_OSC_CTRL, round(-osc_mod * SEVEN_BIT / MOD_RANGE), f'osc mod {osc_mod} (LFO)'))
    if not wanted:
        return
    target, amount, what = wanted[0]
    m.set(f'{snd}.lfoDst', target)
    m.set(f'{snd}.lfoAmt', min(amount, NS4_LAYOUT.fields[f'{snd}.lfoAmt'].max))
    m.warn(w, f'{what} became Stage 4 LFO amount {amount}; the depth scale is unverified')
    for _, _, dropped in wanted[1:]:
        m.warn(w, f'{dropped} not converted: a Stage 4 synth layer has one LFO destination, used for {what}')
