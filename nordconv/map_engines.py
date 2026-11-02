"""Mapping rules for one Stage 3 panel's organ, piano and synth.

Panel A becomes layer A and Panel B layer B of each Stage 4 section in scene
I (approved default). Each rule follows docs/phase1-mapping.md, as corrected
by later review: values copy where both models share a table, enums are
remapped by their labels, and every approximation is reported. Rules marked
NSM follow three Nord Sound Manager conversions (kept private).
"""
from __future__ import annotations

from typing import List, Tuple

from ._tables_ns3 import PIANO_TYPE, SYNTH_OSC
from ._tables_ns4 import PIANO_NAMES, SAMPLE_NAMES
from .keyboard import map_octave, map_zone
from .layout import NS4_LAYOUT
from .mapper import NONE_HASHES, Mapper
from .oscillators import DETUNE_UNISON, SUPER, map_oscillator

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
MORPHS = ('morphWheel', 'morphAfterTouch', 'morphCtrlPedal')
# NSM: Stage 3 name hashes are offset-encoded, Stage 4 = Stage 3 + 0x80000001 (mod 2^32), so the
# Stage 3 "none" 0x7FFFFFFF becomes 0 (one sample and two piano hashes decode exactly).
HASH_OFFSET = 0x80000001
# NSM replaces these pianos (observed pairs only): Royal Grand 3D XL's legacy hash -> its Stage 4 hash,
# HonkyTonkUpright Lrg -> Amber Upright XL.
PIANO_SUBSTITUTES = {0xD303B5F2: 0xE986F07A, 0xB54A2C61: 0x13198A21}
SAMPLE_MODE = 0  # Stage 4 synth layer mode: 0 samples, 1 analog
SUPER_OSC_CTRL = 36  # NSM writes it for every Super oscillator
KBD_TRACK_CUTOFF = 24  # NSM: two octaves of the shared cutoff table when key tracking is on
# NSM: the filter envelope when the filter Mod knob is at 0 (the mod env then drives no filter).
IDLE_FILTER_ENV = {'EnvDcy': 127, 'EnvRls': 127, 'EnvVel': 1}


def ns4_hash(ns3_hash: int) -> int:
    """The Stage 4 name hash for a Stage 3 one (NSM)."""
    return (ns3_hash + HASH_OFFSET) & 0xFFFFFFFF


def three_quarters(value: int) -> int:
    """NSM's resonance scale, trunc(x * 3 / 4), rounded toward zero for morph deltas (-45 -> -33)."""
    return value * 3 // 4 if value >= 0 else -(-value * 3 // 4)


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
    """Panel piano -> piano layer; the sound itself by its Stage 4 id when the Stage 4 knows it."""
    w = f'Panel {p} piano'
    m.copy(f'piano{p}.level', f'piano.layerLevelPno{p}', w)
    map_zone(m, f'piano{p}.kbZone', f'piano{p}.kbZone', w)
    map_octave(m, f'piano{p}.octaveShift', f'piano{p}.octaveShift', w)
    m.copy(f'piano{p}.pitchStickEnable', f'piano{p}.pStickEnable', w)
    m.copy(f'piano{p}.sustainEnable', f'piano{p}.sustainEnable', w)
    m.copy(f'piano{p}.bank', f'piano{p}.bank', w)
    _piano_sound(m, p, w)
    # Same bits on both models (soft release, string resonance; pedal noise), but the Stage 4
    # defaults are on: mapping default to default would switch them on for an all-default Stage 3 piano.
    m.copy(f'piano{p}.acoustic', f'piano{p}.acoustic', w)
    m.copy(f'piano{p}.pedalNoise', f'piano{p}.pedalNoise', w)
    m.copy(f'piano{p}.kbdTouch', f'piano{p}.kbdTouch', w)  # NSM; Stage 3 touch 3 is clamped to 2
    m.copy(f'piano{p}.eq', f'piano{p}.eq', w)


def _piano_sound(m: Mapper, p: str, w: str) -> None:
    """The piano's decoded hash: NSM's substitute, or the hash itself when the Stage 4 piano list has it."""
    name, entry, variation = f'piano{p}.nameHash', f'piano{p}.entry', f'piano{p}.variation'
    found = ns4_hash(m.v(name))
    if found in PIANO_SUBSTITUTES:
        target = PIANO_SUBSTITUTES[found]
        m.set(name, target)
        m.set(entry, 0)  # a Stage 3 library slot; NSM writes entry 0 for a substitute
        m.copy(variation, variation, w)
        changes: List[str] = []
        if PIANO_NAMES[target] != PIANO_NAMES[found]:
            changes.append(f'piano {PIANO_NAMES[found]} became {PIANO_NAMES[target]}')
        if not m.is_default(entry):
            changes.append(f'entry {m.v(entry)} became 0')
        if changes:
            m.warn(w, f'{", ".join(changes)}, as Nord Sound Manager converts it')
    elif found in PIANO_NAMES:
        m.set(name, found)
        m.copy(entry, entry, w)
        m.copy(variation, variation, w)
        m.warn(w, f'piano {PIANO_NAMES[found]} kept by its id; unverified: Nord Sound Manager may substitute '
                  'a different Stage 4 piano')
    else:
        bank = m.v(f'piano{p}.bank')
        kind = PIANO_TYPE[bank] if bank < len(PIANO_TYPE) else 'matching'
        m.drop(w, [name, entry, variation],
               f'the Stage 4 piano list has no piano with its id 0x{found:08X}; pick a {kind} piano on the Stage 4')


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
    sample = _oscillator(m, s, layer, snd, w)
    _filter(m, s, snd, w)
    for ns3, ns4 in (('ampEnvAtc', 'ampEnvAtk'), ('ampEnvDcy', 'ampEnvDcy'), ('ampEnvRls', 'ampEnvRls'),
                     ('ampEnvVel', 'ampEnvVel')):
        m.copy(f'{s}.{ns3}', f'{snd}.{ns4}', w)
    _modulation(m, s, snd, w)
    if sample:
        m.drop(w, [f'{s}.smpFastAtk'], 'the Stage 4 has no fast attack setting for samples')
    else:
        m.drop(w, [f'{s}.smpNameHash', f'{s}.smpFastAtk'],
               'only a Sample oscillator takes its sample to the Stage 4')


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


def _oscillator(m: Mapper, s: str, layer: str, snd: str, w: str) -> bool:
    """The analog oscillator, or (NSM) a Stage 4 sample layer for a Stage 3 Sample oscillator; True for the latter."""
    bank, wave = m.v(f'{s}.oscBank'), m.v(f'{s}.oscWave')
    conf, detune = m.v(f'{s}.oscConf'), m.v(f'{s}.dualOscDetune')
    kind = SYNTH_OSC[bank] if bank < len(SYNTH_OSC) else f'#{bank}'
    sample = m.v(f'{s}.smpNameHash')
    is_sample = kind == 'Sample' and sample not in NONE_HASHES
    choice = None if is_sample else map_oscillator(bank, wave, conf, detune)
    m.set(f'{snd}.oscBank', 0)
    if is_sample:
        found = ns4_hash(sample)
        m.set(f'{layer}.mode', SAMPLE_MODE)
        m.set(f'{layer}.smpNameHash', found)
        m.set(f'{layer}.smpId', 0)  # no slot; the Stage 4 finds the sample by its hash
        label = f' ({SAMPLE_NAMES[found]})' if found in SAMPLE_NAMES else ''
        m.warn(w, f'Sample oscillator became Stage 4 sample 0x{found:08X}{label}: the sample must be on the '
                  'Stage 4 (restore or relink it in Nord Sound Manager)')
    elif choice is None:
        m.warn(w, f'{kind} oscillator wave {wave} has no Stage 4 analog counterpart; '
                  'the Stage 4 default wave was kept, pick a sound on the Stage 4')
    else:
        m.set(f'{snd}.oscCat', choice.category)
        m.set(f'{snd}.oscWave', choice.wave)
        if choice.lossy:
            m.warn(w, f'oscillator not matched exactly: {choice.lossy}')
    if conf and not (choice and choice.uses_detune) and detune != DETUNE_UNISON:
        target = 'a Stage 4 sample layer has' if is_sample else 'the Stage 4 analog oscillators have'
        m.warn(w, f'osc 2 pitch {detune - DETUNE_UNISON:+d} semitones not converted: '
                  f'{target} no second-oscillator pitch')
    ctrl = f'{s}.oscCtrl'
    if choice is not None and choice.category == SUPER:
        m.set(f'{snd}.oscCtrl', SUPER_OSC_CTRL)
        if not m.is_default(ctrl) and m.v(ctrl) != SUPER_OSC_CTRL:
            m.warn(w, f'osc ctrl {m.v(ctrl)} became {SUPER_OSC_CTRL}, the value Nord Sound Manager writes for '
                      'every Super oscillator')
    else:
        m.copy(ctrl, f'{snd}.oscCtrl', w)
        if not m.is_default(ctrl) and is_sample:
            m.warn(w, f'osc ctrl {m.v(ctrl)} copied as is; unverified whether a Stage 4 sample layer uses it')
        elif not m.is_default(ctrl):
            m.warn(w, f'osc ctrl {m.v(ctrl)} copied as is; what it controls depends on the oscillator and '
                      'differs on the Stage 4')
    return is_sample


def _filter(m: Mapper, s: str, snd: str, w: str) -> None:
    """Filter type, cutoff and resonance, and the cutoff and resonance morphs (NSM scales)."""
    for key in ('fltType', 'fltKbdTrk', 'fltDrive'):
        m.copy(f'{s}.{key}', f'{snd}.{key}', w)
    cutoff = m.v(f'{s}.fltFreq')
    if m.v(f'{s}.fltKbdTrk') > 0:
        cutoff = min(SEVEN_BIT, cutoff + KBD_TRACK_CUTOFF)
    m.set(f'{snd}.fltFreq', cutoff)
    m.set(f'{snd}.fltRes', three_quarters(m.v(f'{s}.fltRes')))
    # Same field type on both models for every controller; NSM copies the pedal's cutoff delta and
    # scales its resonance delta like the resonance itself.
    for morph in MORPHS:
        m.set(f'{snd}.fltFreq.{morph}', m.bounded(f'{s}.fltFreq.{morph}', w))
        m.set(f'{snd}.fltRes.{morph}', three_quarters(m.bounded(f'{s}.fltRes.{morph}', w)))


def _modulation(m: Mapper, s: str, snd: str, w: str) -> None:
    """Mod env -> filter env (plus osc env when osc mod is on); filter LFO and negative osc mod -> the LFO.

    The Stage 3 filter Mod knob is Vel Amount left of centre and Mod Env Amount right of it
    (ns3-program-viewer ns3-synth-filter.js); only the osc Mod knob has the LFO on its left.
    With the filter Mod knob at 0, NSM writes a fixed filter envelope instead of the mod env.
    """
    flt_mod, osc_mod = m.bounded(f'{s}.fltMod', w), m.bounded(f'{s}.oscMod', w)
    for ns3, ns4 in ENV_STAGES:
        if flt_mod == 0 and ns4 in IDLE_FILTER_ENV:
            m.skip([f'{s}.{ns3}'])  # still copied to the osc env below when osc mod is on
            m.set(f'{snd}.flt{ns4}', IDLE_FILTER_ENV[ns4])
        else:
            m.copy(f'{s}.{ns3}', f'{snd}.flt{ns4}', w)
    if flt_mod > 0:
        m.set(f'{snd}.fltEnvAmt', flt_mod * SEVEN_BIT // MOD_RANGE)  # NSM: floor, not round
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
