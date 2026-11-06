import importlib.util
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[3]
def module(name, file):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'tools' / file)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value

align = module('owned_align_test', 'mt-frozen-align.py')
owned = module('owned_policy_test', 'mt_owned_projection.py')


class OwnedProjectionRules(unittest.TestCase):
    def test_literal_whitespace_and_punctuation_are_exact_anchors(self):
        annotations = [{'id': 'space', 'immutable': True, 'text': ' ', 'anchor_kind': 'literal'},
                       {'id': 'code', 'immutable': True, 'text': 'x()', 'anchor_kind': 'opaque'},
                       {'id': 'period', 'immutable': True, 'text': '.', 'anchor_kind': 'literal'}]
        self.assertEqual(owned.readonly_owned(annotations, '调用 x().'), {'space': (2, 3), 'code': (3, 6), 'period': (6, 7)})
        with self.assertRaises(ValueError): owned.readonly_owned(annotations, '调用 x()。')

    def test_repeated_anchors_need_one_ordered_assignment(self):
        annotations = [{'id': 'a', 'immutable': True, 'text': 'x()', 'anchor_kind': 'opaque'},
                       {'id': 'b', 'immutable': True, 'text': 'y()', 'anchor_kind': 'opaque'}]
        self.assertEqual(owned.readonly_owned(annotations, 'x() y()'), {'a': (0, 3), 'b': (4, 7)})
        for text in ['x() x() y()', 'y() x()', 'proxy() y()']:
            with self.subTest(text=text), self.assertRaises(ValueError): owned.readonly_owned(annotations, text)

    def test_complete_parent_flow_inherits_only_its_existing_scope(self):
        case = {'source_text': 'Choose one:', 'frozen_target': '请选择其一：', 'source_words': [], 'target_words': [],
                'annotations': [{'id': 'f0', 'kind': 'flow', 'full_parent': True, 'immutable': False,
                                 'parent': None, 'start': 0, 'end': 11, 'text': 'Choose one:'}]}
        spans, diagnostics = align.project(case, [], .55, readonly_resolver=owned.readonly_owned, inherit_full_parent_flows=True)
        self.assertEqual(spans, [{'id': 'f0', 'start': 0, 'end': 6}])
        self.assertEqual(diagnostics, [])
        case['annotations'][0]['end'] = 10
        with self.assertRaises(ValueError): align.project(case, [], .55, readonly_resolver=owned.readonly_owned, inherit_full_parent_flows=True)

    def test_partial_flow_cannot_claim_the_entire_translation(self):
        case = {'source_text': 'Before after', 'frozen_target': '前后', 'source_words': [], 'target_words': [],
                'annotations': [{'id': 'f0', 'kind': 'flow', 'full_parent': False, 'immutable': False,
                                 'parent': None, 'start': 0, 'end': 6, 'text': 'Before'}]}
        with self.assertRaises(ValueError): align.project(case, [], .55, readonly_resolver=owned.readonly_owned, inherit_full_parent_flows=True)


if __name__ == '__main__': unittest.main()
