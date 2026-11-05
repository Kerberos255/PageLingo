import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("source_diagnostic_guard", Path(__file__).resolve().parents[3] / "tools/mt-source-diagnostic-guard.py")
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)


class SourceDiagnosticGuard(unittest.TestCase):
    def plan(self):
        jobs = []
        for variant, grammar in [("natural-visible", None), ("production-fixed:0", 'root ::= "frame"')]:
            request = {"messages": [{"role": "user", "content": "English source"}], "max_tokens": 64, "grammar": grammar}
            jobs.append({"case_id": "source", "variant": variant, "request": request,
                         "request_sha256": hashlib.sha256(json.dumps(request, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()})
        return {"protocol": "source-format-diagnostic-v8", "evaluation_only": True, "optimizer_inputs_approved": False,
                "cases": [{"id": "source", "split": "diagnostic", "fixed_calls": 1}], "jobs": jobs}

    def test_changed_inputs_missing_conditions_and_optimization_are_rejected(self):
        guard.validate_source_diagnostic(self.plan())
        for mutation in ["input", "missing", "duplicate", "train", "approved", "natural_grammar", "fixed_grammar"]:
            bad = copy.deepcopy(self.plan())
            if mutation == "input": bad["jobs"][0]["request"]["messages"][0]["content"] = "changed"
            if mutation == "missing": bad["jobs"].pop()
            if mutation == "duplicate": bad["jobs"].append(bad["jobs"][0])
            if mutation == "train": bad["cases"][0]["split"] = "train"
            if mutation == "approved": bad["optimizer_inputs_approved"] = True
            if mutation == "natural_grammar": bad["jobs"][0]["request"]["grammar"] = "frame"
            if mutation == "fixed_grammar": bad["jobs"][1]["request"]["grammar"] = None
            with self.subTest(mutation=mutation), self.assertRaises(ValueError): guard.validate_source_diagnostic(bad)


if __name__ == "__main__": unittest.main()
