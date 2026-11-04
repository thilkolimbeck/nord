"""The editor's generated files must equal a fresh render from tools/ns4data and templates/.

web/src/editor/generated/display-ns4.ts is a second copy of tools/ns4data/_tables_ns4.py,
web/test/editor/labels-golden.json is what ns4data.labels.ns4_label says for every value of
every tabled field, and web/src/ns4/generated/template-bytes.ts is templates/regressionTest.ns4p
as base64. When the Python tables change (a new opennord commit through tools/gen_layouts.py)
or the template does, all three must be regenerated with `npm run gen:editor`.
"""
from __future__ import annotations

import base64
import importlib.util
import json
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

_spec = importlib.util.spec_from_file_location('gen_editor_tables', ROOT / 'tools' / 'gen_editor_tables.py')
gen = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(gen)
t = gen.t
NS4_LAYOUT = gen.NS4_LAYOUT


class EditorTables(unittest.TestCase):
    def test_committed_ts_module_equals_a_fresh_render(self):
        self.assertEqual(gen.TS_OUT.read_text(encoding='utf-8'), gen.render_ts(),
                         'stale: run npm run gen:editor')

    def test_committed_label_golden_equals_a_fresh_render(self):
        self.assertEqual(gen.GOLDEN_OUT.read_text(encoding='utf-8'), gen.render_golden(),
                         'stale: run npm run gen:editor')

    def test_committed_template_bytes_equal_a_fresh_render(self):
        text = gen.TEMPLATE_OUT.read_text(encoding='utf-8')
        self.assertEqual(text, gen.render_template_ts(), 'stale: run npm run gen:editor')
        encoded = ''.join(re.findall(r"^  '([A-Za-z0-9+/=]+)'", text, re.M))
        self.assertEqual(base64.b64decode(encoded), gen.TEMPLATE.read_bytes())

    def test_golden_covers_every_tabled_field_over_its_whole_range(self):
        fields = json.loads(gen.GOLDEN_OUT.read_text(encoding='utf-8'))['fields']
        covered = set(t.FIELD_VALUE_TABLE) | set(t.FIELD_ENUM) | set(t.FIELD_DEP)
        self.assertEqual(set(fields), covered)
        for key, entry in fields.items():
            f = NS4_LAYOUT.fields[key]
            lists = list(entry['rows'].values()) if 'rows' in entry else [entry['labels']]
            for labels in lists:
                self.assertEqual(len(labels), f.max - f.min + 1, key)
        self.assertTrue(any(label for entry in fields.values() for label in entry.get('labels', [])))

    def test_ts_module_lists_every_layout_key_in_order(self):
        text = gen.TS_OUT.read_text(encoding='utf-8')
        start = text.index('export const NS4_KEYS = [')
        end = text.index('] as const;', start)
        keys = [json.loads(line.strip().rstrip(',')) for line in text[start:end].splitlines()[1:]]
        self.assertEqual(keys, list(NS4_LAYOUT.fields))


if __name__ == '__main__':
    unittest.main()
