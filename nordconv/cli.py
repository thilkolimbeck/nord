"""Command line: convert one .ns3f file, a directory of them, or a glob.

A batch keeps going when one file fails, so one damaged program does not stop
a library conversion; the exit status still reports the failure (1). Usage
errors exit with 2. Warnings go to the log, one line per parameter; reports
about sections that are switched off in the source appear only with -v.
"""
from __future__ import annotations

import argparse
import glob
import logging
import os
import sys
from pathlib import Path
from typing import List, Optional, Sequence, Tuple

from .cbin import NordFileError
from .convert import OUTPUT_SUFFIX, ConversionError, convert_file, default_output
from .template import TEMPLATE_PATH, load_template

log = logging.getLogger('nordconv')
INPUT_SUFFIX = '.ns3f'
GLOB_CHARS = frozenset('*?[')


def find_inputs(pattern: str) -> Tuple[List[Path], bool]:
    """The input files and whether this is a batch (a directory or a glob)."""
    path = Path(pattern)
    if path.is_dir():
        return sorted(p for p in path.iterdir() if _is_input(p)), True
    if GLOB_CHARS & set(pattern):
        # Same filter as a directory, so a glob that also matches earlier outputs still works.
        return sorted(p for p in map(Path, glob.glob(pattern)) if _is_input(p)), True
    return [path], False


def _is_input(path: Path) -> bool:
    return path.is_file() and path.suffix.lower() == INPUT_SUFFIX


def plan_outputs(inputs: Sequence[Path], output: Optional[str], batch: bool) -> List[Tuple[Path, Path]]:
    """Pair every input with its output path; ValueError when two inputs would share one."""
    out_dir: Optional[Path] = None
    if output and (batch or output.endswith(os.sep) or Path(output).is_dir()):
        out_dir = Path(output)
        out_dir.mkdir(parents=True, exist_ok=True)
    pairs = []
    for src in inputs:
        if out_dir is not None:
            dst = out_dir / (src.stem + OUTPUT_SUFFIX)
        else:
            dst = Path(output) if output else default_output(src)
        pairs.append((src, dst))
    targets = [dst.resolve() for _, dst in pairs]
    if len(set(targets)) != len(targets):
        raise ValueError('two inputs would be written to the same output file')
    return pairs


def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(
        prog='convert.py', description='Convert Nord Stage 3 programs (.ns3f) to Nord Stage 4 programs (.ns4p).')
    ap.add_argument('input', help='an .ns3f file, a directory of them, or a quoted glob such as "presets/*.ns3f"')
    ap.add_argument('output', nargs='?',
                    help='output file, or output directory for a batch (default: next to each input)')
    ap.add_argument('--force', action='store_true', help='replace existing output files')
    ap.add_argument('--template', type=Path, default=TEMPLATE_PATH,
                    help='donor .ns4p (neutralised before use; default: the bundled regressionTest.ns4p)')
    ap.add_argument('-q', '--quiet', action='store_true', help='print errors only, no warnings')
    ap.add_argument('-v', '--verbose', action='store_true',
                    help='also report settings in sections that are switched off in the source')
    return ap


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = build_parser().parse_args(argv)
    logging.basicConfig(level=logging.ERROR if args.quiet else logging.INFO, format='%(levelname)s: %(message)s',
                        stream=sys.stderr, force=True)
    inputs, batch = find_inputs(args.input)
    if not inputs:
        log.error('no %s files match %s', INPUT_SUFFIX, args.input)
        return 2
    try:
        pairs = plan_outputs(inputs, args.output, batch)
    except (OSError, ValueError) as exc:
        log.error('%s', exc)
        return 2
    try:
        template = load_template(args.template)
    except (OSError, NordFileError) as exc:
        log.error('template %s unusable: %s', args.template, exc)
        return 1
    failed = 0
    for src, dst in pairs:
        try:
            converted = convert_file(src, dst, template, overwrite=args.force)
        except (OSError, NordFileError, ConversionError) as exc:
            failed += 1
            log.error('%s: not converted: %s', src, exc)
            continue
        for warning in converted.warnings:
            log.warning('%s: %s', src.name, warning)
        if args.verbose:
            for note in converted.notes:
                log.info('%s: %s', src.name, note)
        hidden = '' if args.verbose or not converted.notes else \
            f'; {len(converted.notes)} reports about switched-off sections hidden, see -v'
        log.info('converted %s -> %s (%d warnings%s)', src, dst, len(converted.warnings), hidden)
    if batch:
        log.info('%d of %d files converted', len(pairs) - failed, len(pairs))
    return 1 if failed else 0
