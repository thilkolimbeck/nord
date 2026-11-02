"""Shared test inputs: the sample pair, read only, and Stage 3 files built from it.

The sample program pair is private: presets/ is gitignored, so a public checkout
has neither file. The tests that need it are marked @needs_sample and skip with a
clear reason there; locally the pair is the first .ns3f in presets/stage3 and the
first .ns4p in presets/stage4 (sorted by name). Expected values that describe the
sample's sound live next to it, in presets/expected-mapping.json (@needs_expected).

The samples are never written. Variants are made in memory by re-encoding fields
of the sample body and re-sealing the container, which also gives the tests an
all-default Stage 3 program to check "silent at default". All-default inputs can
also start from PUBLIC_BASE, a tracked viewer fixture, and then run in a public checkout.
"""
from __future__ import annotations

import hashlib
import json
import unittest
from dataclasses import replace
from pathlib import Path
from typing import Any, Dict, Mapping, Optional

from nordconv.bits import write_bits
from nordconv.cbin import build_cbin, parse_cbin
from nordconv.layout import NS3_LAYOUT

ROOT = Path(__file__).resolve().parent.parent
TEMPLATE = ROOT / 'templates' / 'regressionTest.ns4p'
PRIVATE = ROOT / 'presets'


def _first(folder: Path, pattern: str) -> Optional[Path]:
    files = sorted(folder.glob(pattern)) if folder.is_dir() else []
    return files[0] if files else None


NS3_SAMPLE = _first(PRIVATE / 'stage3', '*.ns3f')
#: A public viewer fixture (format 3.04, like the sample) for all-default inputs that need no private file.
PUBLIC_BASE = ROOT / 'web' / 'test' / 'fixtures' / 'ns3' / 'global' / 'panelB.output.main.value eq 1-2.ns3f'
NS4_SAMPLE = _first(PRIVATE / 'stage4', '*.ns4p')
SAMPLE_EXPECTED = PRIVATE / 'expected-mapping.json'
SAMPLE_SKIP = ('needs the private sample program pair in presets/stage3 and presets/stage4 '
               '(gitignored, not in the public repository)')
needs_sample = unittest.skipUnless(NS3_SAMPLE is not None and NS4_SAMPLE is not None, SAMPLE_SKIP)
needs_expected = unittest.skipUnless(SAMPLE_EXPECTED.is_file(),
                                     'needs presets/expected-mapping.json, the private sample\'s expected values '
                                     '(gitignored, not in the public repository)')


def sample_expected() -> Dict[str, Any]:
    """The private expected values for the sample (only call it under @needs_expected)."""
    return json.loads(SAMPLE_EXPECTED.read_text(encoding='utf-8'))


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def ns3_variant(changes: Mapping[str, int], all_default: bool = False, version: Optional[int] = None,
                base: Optional[Path] = None) -> bytes:
    """The Stage 3 sample, or `base`, (or an all-default program) with `changes` applied, as file bytes."""
    parsed = parse_cbin((base or NS3_SAMPLE).read_bytes(), 'ns3f')
    body = bytearray(parsed.body)
    fields = NS3_LAYOUT.fields
    values = {k: f.default for k, f in fields.items()} if all_default else {}
    values.update(changes)
    for key, value in values.items():
        f = fields[key]
        write_bits(body, f.body_bit, f.width, f.encode(value))
    header = parsed.header
    if version is not None:
        body[0:4] = version.to_bytes(4, 'big')
        header = replace(header, version=version)
    return build_cbin(header, bytes(body))


def ns3_raw_variant(raw: Mapping[str, int]) -> bytes:
    """The Stage 3 sample with raw bit patterns written into fields, valid or not."""
    parsed = parse_cbin(NS3_SAMPLE.read_bytes(), 'ns3f')
    body = bytearray(parsed.body)
    for key, value in raw.items():
        f = NS3_LAYOUT.fields[key]
        write_bits(body, f.body_bit, f.width, value)
    return build_cbin(parsed.header, bytes(body))
