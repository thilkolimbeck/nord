"""The editor's generated tables and label golden must equal a fresh render from nordconv.

web/src/editor/generated/display-ns4.ts is a second copy of nordconv/_tables_ns4.py, and
web/test/editor/labels-golden.json is what nordconv.labels.ns4_label says for every value of
every tabled field. When the Python tables change (a new opennord commit through
tools/gen_layouts.py), both must be regenerated with `npm run gen:editor`.
"""
from __future__ import annotations

import importlib.util
import json
import unittest

from nordconv import _tables_ns4 as t
from nordconv.layout import NS4_LAYOUT
from tests.helpers import ROOT

_spec = importlib.util.spec_from_file_location('gen_editor_tables', ROOT / 'tools' / 'gen_editor_tables.py')
gen = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(gen)


class EditorTables(unittest.TestCase):
    def test_committed_ts_module_equals_a_fresh_render(self):
        self.assertEqual(gen.TS_OUT.read_text(encoding='utf-8'), gen.render_ts(),
                         'stale: run npm run gen:editor')

    def test_committed_label_golden_equals_a_fresh_render(self):
        self.assertEqual(gen.GOLDEN_OUT.read_text(encoding='utf-8'), gen.render_golden(),
                         'stale: run npm run gen:editor')

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
