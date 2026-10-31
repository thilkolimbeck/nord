"""The donor program every output is patched into, made neutral first.

About a fifth of a Stage 4 body is not in any known layout, so a converter
cannot write a body from scratch: it patches a real program and keeps the
bytes nobody has decoded. The donor (templates/regressionTest.ns4p, MIT, from
ns4decode) is a working sound with its own settings, though: 418 known fields
away from their defaults and four sections switched on. Every known field is
therefore reset to its Stage 4 layout default and every section and layer is
switched off, so nothing of the donor's sound reaches an output. Only the
undecoded bits stay as the donor has them.
"""
from __future__ import annotations

from dataclasses import replace
from pathlib import Path
from typing import Union

from .cbin import NordFileError
from .layout import NS4_LAYOUT
from .program import Ns4Program

TEMPLATE_PATH = Path(__file__).resolve().parent.parent / 'templates' / 'regressionTest.ns4p'
TARGET_VERSION = 313
#: Program category "None" (opennord clavia/categories.ts).
CATEGORY_NONE = 17
#: Switches that the layout defaults leave on, but a neutral program has off.
SWITCHES_OFF = tuple(k for k in NS4_LAYOUT.fields
                     if k.startswith(('common.sectionEnable', 'organ.layerEnable', 'piano.layerEnable',
                                      'synth.layerEnable')))


def neutralise(donor: Ns4Program) -> Ns4Program:
    """A copy of `donor` with every known field at its default, all sections and layers off."""
    if donor.format_version != TARGET_VERSION:
        raise NordFileError(f'template is format {donor.format_version / 100:.2f}, expected '
                            f'{TARGET_VERSION / 100:.2f}')
    header = replace(donor.header, bank=0, location=0, category=CATEGORY_NONE)
    neutral = Ns4Program(header, donor.body)
    for key, f in NS4_LAYOUT.fields.items():
        neutral.set(key, f.default)
    for key in SWITCHES_OFF:
        neutral.set(key, 0)
    return neutral


def load_template(path: Union[str, Path] = TEMPLATE_PATH) -> Ns4Program:
    """Read and neutralise a donor program."""
    return neutralise(Ns4Program.from_file(path))
