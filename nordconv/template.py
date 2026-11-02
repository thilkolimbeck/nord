"""The donor program every output is patched into, made neutral first.

About a fifth of a Stage 4 body is not in any known layout, so a converter
cannot write a body from scratch: it patches a real program and keeps the
bytes nobody has decoded. The donor (templates/regressionTest.ns4p, MIT, from
ns4decode) is a working sound with its own settings, though: 418 known fields
away from their defaults and four sections switched on. Every known field is
therefore reset to its Stage 4 layout default and every scene I section and
layer is switched off, so nothing of the donor's sound reaches an output.
Scene II keeps the layout defaults, as Nord Sound Manager leaves it. The
undecoded bits stay as the donor has them, except three fields where three
Nord Sound Manager conversions (kept private) write a constant the donor lacks.
"""
from __future__ import annotations

from dataclasses import replace
from pathlib import Path
from typing import Union

from .bits import write_bits
from .cbin import NordFileError
from .layout import NS4_LAYOUT
from .program import Ns4Program

TEMPLATE_PATH = Path(__file__).resolve().parent.parent / 'templates' / 'regressionTest.ns4p'
TARGET_VERSION = 313
#: Program category "None" (opennord clavia/categories.ts).
CATEGORY_NONE = 17
#: Scene I switches that the layout defaults leave on, but a neutral program has off.
SWITCHES_OFF = tuple(k for k in NS4_LAYOUT.fields
                     if k.startswith(('common.sectionEnable', 'organ.layerEnable', 'piano.layerEnable',
                                      'synth.layerEnable')) and k.endswith('_I'))
#: Undecoded fields Nord Sound Manager always writes, as (block, first bit in the block, width, value):
#: 2 bits between vibMode and voiceMode of each synth layer, 3 bits between orgPStickEnable and
#: effectsLeslieEnable of the organ, 2 bits between oscTuneCoarse and oscEnvAtk of each synth sound.
UNDECODED_VALUES = (tuple((f'synth{x}', 67, 2, 1) for x in 'ABC') + (('organ', 69, 3, 5),)
                    + tuple((f'synth{x}Sound', 61, 2, 0) for x in 'ABC'))


def neutralise(donor: Ns4Program) -> Ns4Program:
    """A copy of `donor` with every known field at its default, scene I off, Nord Sound Manager's undecoded values."""
    if donor.format_version != TARGET_VERSION:
        raise NordFileError(f'template is format {donor.format_version / 100:.2f}, expected '
                            f'{TARGET_VERSION / 100:.2f}')
    header = replace(donor.header, bank=0, location=0, category=CATEGORY_NONE)
    body = bytearray(donor.body)
    blocks = {b.key: b for b in NS4_LAYOUT.blocks}
    for block, bit, width, value in UNDECODED_VALUES:
        write_bits(body, (blocks[block].offset + 1) * 8 + bit, width, value)
    neutral = Ns4Program(header, bytes(body))
    for key, f in NS4_LAYOUT.fields.items():
        neutral.set(key, f.default)
    for key in SWITCHES_OFF:
        neutral.set(key, 0)
    return neutral


def load_template(path: Union[str, Path] = TEMPLATE_PATH) -> Ns4Program:
    """Read and neutralise a donor program."""
    return neutralise(Ns4Program.from_file(path))
