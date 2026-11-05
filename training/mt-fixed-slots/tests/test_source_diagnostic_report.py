import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("source_diagnostic_report", Path(__file__).resolve().parents[3] / "tools/mt-source-diagnostic-report.py")
report = importlib.util.module_from_spec(spec)
spec.loader.exec_module(report)


class ProtectedCodeOccurrenceCounts(unittest.TestCase):
    def test_overlapping_function_names_are_not_double_counted(self):
        code = ["Promise.all()", "Promise.allSettled()", "allSettled()"]
        text = "Promise.all()，再看Promise.allSettled()和allSettled()。"
        self.assertTrue(report.exact_protected_code_counts(text, code))
        self.assertFalse(report.exact_protected_code_counts(text + ' ["Promise.all()"]', code))

    def test_subwords_changes_and_extra_copies_are_distinguished(self):
        self.assertTrue(report.exact_protected_code_counts("离开with之后，autocommit为True", ["with", "autocommit", "True"]))
        self.assertFalse(report.exact_protected_code_counts("without", ["with"]))
        self.assertFalse(report.exact_protected_code_counts("自动提交为True", ["autocommit", "True"]))
        self.assertTrue(report.exact_protected_code_counts("没有 code 字符串", []))


if __name__ == "__main__": unittest.main()
