import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("frozen_align", Path(__file__).resolve().parents[3] / "tools/mt-frozen-align.py")
align = importlib.util.module_from_spec(spec)
spec.loader.exec_module(align)


class FrozenProjectionRules(unittest.TestCase):
    def test_immutable_content_needs_one_ordered_assignment(self):
        a = [{'id': 'a', 'immutable': True, 'text': 'token'}, {'id': 'b', 'immutable': True, 'text': 'close()'}]
        self.assertEqual(align.readonly_spans(a, '返回 token，再 close()。'), {'a': (3, 8), 'b': (11, 18)})
        for text in ['先 close() 再 token', 'token token close()', 'token 然后关闭']:
            with self.subTest(text=text), self.assertRaises(ValueError): align.readonly_spans(a, text)

    def test_offsets_use_dom_utf16_instead_of_python_codepoint_count(self):
        self.assertEqual(align.u16('甲😀乙', 2), 3)

    def test_one_spurious_outside_link_does_not_expand_scope(self):
        words_s = [{'text': 'click', 'start': 0, 'end': 5, 'lexical': True}, {'text': 'Guide', 'start': 6, 'end': 11, 'lexical': True}]
        words_t = [{'text': '点', 'start': 0, 'end': 1, 'lexical': True}, {'text': '指南', 'start': 1, 'end': 3, 'lexical': True}, {'text': '继续', 'start': 3, 'end': 5, 'lexical': True}]
        case = {'source_words': words_s, 'target_words': words_t, 'frozen_target': '点指南继续',
                'annotations': [{'id': 's0', 'start': 6, 'end': 11, 'text': 'Guide', 'parent': None, 'immutable': False}]}
        spans, _ = align.project(case, [(0, 0, .9), (1, 1, .9), (0, 2, .7)], .55)
        self.assertEqual(spans, [{'id': 's0', 'start': 1, 'end': 3}])
        with self.assertRaises(ValueError): align.project(case, [(0, 0, .9)], .55)

    def test_partial_source_word_cannot_silently_drop_the_missing_part(self):
        case = {'source_words': [{'text': 'unstable', 'start': 0, 'end': 8, 'lexical': True}],
                'target_words': [{'text': '不稳定', 'start': 0, 'end': 3, 'lexical': True}], 'frozen_target': '不稳定',
                'annotations': [{'id': 's0', 'start': 0, 'end': 2, 'text': 'un', 'parent': None, 'immutable': False}]}
        with self.assertRaises(ValueError): align.project(case, [(0, 0, .9)], .55)


if __name__ == '__main__': unittest.main()
