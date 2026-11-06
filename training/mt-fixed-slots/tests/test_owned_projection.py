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
    def test_whole_sentence_format_closes_its_adjacent_period_without_consuming_words(self):
        case = {'source_text':'Read this paragraph. Then save.','frozen_target':'阅读此段。然后保存。',
                'source_words':[{'text':'Read','start':0,'end':4,'lexical':True}],
                'target_words':[{'text':'阅读此段','start':0,'end':4,'lexical':True}],
                'annotations':[{'id':'s','kind':'format','immutable':False,'parent':None,'start':0,'end':20,'text':'Read this paragraph.'}]}
        spans,notes=align.project(case,[(0,0,.9)],.55,close_sentence_punctuation=True)
        self.assertEqual(spans,[{'id':'s','start':0,'end':5}]);self.assertEqual(notes[-1]['rule'],'include_immediately_adjacent_source_sentence_punctuation')

    def test_collapsible_terminal_punctuation_accepts_ascii_line_whitespace_only(self):
        annotations = [{'id': 'period', 'immutable': True, 'text': '.\n', 'anchor_kind': 'prose-punctuation',
                        'punctuation': {'symbol': '.', 'alternatives': ['.', '。'], 'terminal': True, 'collapsibleWhitespace': True}}]
        self.assertEqual(owned.readonly_owned(annotations, '翻译。\n'), {'period': (2, 4)})
        with self.assertRaises(ValueError): owned.readonly_owned(annotations, '翻译。 ')

    def test_typed_terminal_punctuation_does_not_match_a_code_dot_or_earlier_sentence(self):
        annotations = [{'id': 'code', 'immutable': True, 'text': 'x.y()', 'anchor_kind': 'opaque'},
                       {'id': 'period', 'immutable': True, 'text': '.', 'anchor_kind': 'prose-punctuation',
                        'punctuation': {'symbol': '.', 'alternatives': ['.', '。'], 'terminal': True}}]
        self.assertEqual(owned.readonly_owned(annotations, '先阅读。调用x.y()。'), {'code': (6, 11), 'period': (11, 12)})
        for text in ['调用x.y()', '调用x.y()！', '调用x.y()。\n']:
            with self.subTest(text=text), self.assertRaises(ValueError): owned.readonly_owned(annotations, text)

    def test_colon_closure_includes_only_the_immediately_adjacent_delimiter(self):
        case = {'source_text': 'Caution: Read on.', 'frozen_target': '小心：继续读。',
                'source_words': [{'text': 'Caution', 'start': 0, 'end': 7, 'lexical': True}],
                'target_words': [{'text': '小心', 'start': 0, 'end': 2, 'lexical': True}],
                'annotations': [{'id': 'strong', 'kind': 'format', 'immutable': False, 'parent': None, 'start': 0, 'end': 8, 'text': 'Caution:'}]}
        spans, diagnostics = align.project(case, [(0, 0, .9)], .55, close_label_colons=True)
        self.assertEqual(spans, [{'id': 'strong', 'start': 0, 'end': 3}])
        self.assertEqual(diagnostics[-1]['rule'], 'include_immediately_adjacent_source_label_colon')
        case['frozen_target'] = '小心操作：继续读。'
        with self.assertRaises(ValueError): align.project(case, [(0, 0, .9)], .55, close_label_colons=True)

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
