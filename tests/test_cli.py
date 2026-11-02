"""The command line: single file, batch, safety rules and exit codes."""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from nordconv.cli import main
from nordconv.program import Ns4Program
from tests.helpers import NS3_SAMPLE, ROOT, TEMPLATE, needs_sample, sha256


@needs_sample
class Cli(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix='nordconv-test-'))
        self.addCleanup(shutil.rmtree, self.tmp)
        self.src = self.tmp / 'in' / 'Pad.ns3f'
        self.src.parent.mkdir()
        shutil.copyfile(NS3_SAMPLE, self.src)
        self.src_hash = sha256(self.src)

    def run_cli(self, *args: str) -> int:
        with self.assertLogs('nordconv', level='INFO') as logs:
            code = main(['--template', str(TEMPLATE), *args])
        self.log = '\n'.join(logs.output)
        return code

    def tearDown(self):
        self.assertEqual(sha256(self.src), self.src_hash, 'the input must never change')

    def test_single_file_to_default_output(self):
        self.assertEqual(self.run_cli(str(self.src)), 0)
        out = self.src.with_suffix('.ns4p')
        self.assertEqual(Ns4Program.from_file(out).format_version, 313)
        self.assertIn('WARNING', self.log)
        self.assertIn('converted', self.log)

    def test_output_into_directory(self):
        out_dir = self.tmp / 'out'
        self.assertEqual(self.run_cli(str(self.src), str(out_dir) + '/'), 0)
        self.assertTrue((out_dir / 'Pad.ns4p').is_file())

    def test_output_equal_to_input_is_refused(self):
        self.assertEqual(self.run_cli(str(self.src), str(self.src), '--force'), 1)
        self.assertIn('is the input file', self.log)

    def test_existing_output_needs_force(self):
        out = self.tmp / 'x.ns4p'
        out.write_bytes(b'keep')
        self.assertEqual(self.run_cli(str(self.src), str(out)), 1)
        self.assertEqual(out.read_bytes(), b'keep')
        self.assertEqual(self.run_cli(str(self.src), str(out), '--force'), 0)
        self.assertNotEqual(out.read_bytes(), b'keep')

    def test_batch_directory_keeps_going_after_a_bad_file(self):
        bad = self.src.parent / 'Broken.ns3f'
        bad.write_bytes(b'CBIN' + bytes(60))
        out_dir = self.tmp / 'out'
        self.assertEqual(self.run_cli(str(self.src.parent), str(out_dir)), 1)
        self.assertTrue((out_dir / 'Pad.ns4p').is_file())
        self.assertFalse((out_dir / 'Broken.ns4p').exists())
        self.assertIn('1 of 2 files converted', self.log)

    def test_batch_glob(self):
        out_dir = self.tmp / 'globbed'
        self.assertEqual(self.run_cli(str(self.src.parent / '*.ns3f'), str(out_dir)), 0)
        self.assertEqual([p.name for p in out_dir.iterdir()], ['Pad.ns4p'])

    def test_glob_skips_earlier_outputs_and_other_files(self):
        (self.src.parent / 'notes.txt').write_text('not a program')
        pattern = str(self.src.parent / '*')
        self.assertEqual(self.run_cli(pattern), 0)
        self.assertTrue(self.src.with_suffix('.ns4p').is_file())
        self.assertEqual(self.run_cli(pattern, '--force'), 0)  # Pad.ns4p now matches the glob too
        self.assertIn('1 of 1 files converted', self.log)

    def test_switched_off_sections_only_with_verbose(self):
        self.assertEqual(self.run_cli(str(self.src)), 0)
        self.assertNotIn('switched off in the Stage 3 program', self.log)
        self.assertIn('reports about switched-off sections hidden, see -v', self.log)
        self.assertEqual(self.run_cli(str(self.src), '--force', '-v'), 0)
        # The sample's piano A is off, so its zone report (its only one) is a note.
        self.assertTrue(any('Panel A piano: zones ' in line and 'set to the whole keyboard (switched off in the '
                            'Stage 3 program)' in line for line in self.log.splitlines()), self.log)

    def test_output_has_a_normal_file_mode(self):
        self.assertEqual(self.run_cli(str(self.src)), 0)
        umask = os.umask(0)
        os.umask(umask)
        self.assertEqual(self.src.with_suffix('.ns4p').stat().st_mode & 0o777, 0o666 & ~umask)

    def test_entry_point_runs_in_isolated_mode(self):
        out = self.tmp / 'iso.ns4p'
        done = subprocess.run([sys.executable, '-I', '-B', str(ROOT / 'convert.py'), str(self.src), str(out)],
                              capture_output=True, text=True, check=False)
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertTrue(out.is_file())

    def test_no_temporary_files_left_behind(self):
        out_dir = self.tmp / 'out'
        self.run_cli(str(self.src), str(out_dir) + '/')
        self.assertEqual(sorted(p.name for p in out_dir.iterdir()), ['Pad.ns4p'])


class Usage(unittest.TestCase):
    def test_no_match_is_a_usage_error(self):
        tmp = Path(tempfile.mkdtemp(prefix='nordconv-test-'))
        self.addCleanup(shutil.rmtree, tmp)
        with self.assertLogs('nordconv', level='ERROR'):
            code = main([str(tmp / 'none' / '*.ns3f')])
        self.assertEqual(code, 2)


if __name__ == '__main__':
    unittest.main()
