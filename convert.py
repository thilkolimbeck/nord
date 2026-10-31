#!/usr/bin/env python3
"""Convert Nord Stage 3 programs (.ns3f) to Nord Stage 4 programs (.ns4p).

Usage: python3 convert.py <input.ns3f | directory | "glob"> [output] [--force]

nord-convert, Copyright (C) 2026 Thilko Limbeck. AGPL-3.0-or-later; see LICENSE and NOTICE.
"""
import sys
from pathlib import Path

# Isolated mode (python3 -I), recommended for reading untrusted files, leaves the
# script's directory off sys.path; add it back so the bundled package is found.
sys.path.insert(0, str(Path(__file__).resolve().parent))

from nordconv.cli import main  # noqa: E402

if __name__ == '__main__':
    sys.exit(main())
