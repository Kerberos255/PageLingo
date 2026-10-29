import copy
import importlib.util
from pathlib import Path
import sys
import unittest

HERE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HERE))
from evaluate_gpu import request_hash
from evaluate_semantic import validate_plan, materialize_rewrite
from semantic_workflow import verify_candidates


class SemanticEvaluationGuards(unittest.TestCase):
    def plan(self):
        first = {"key": "natural/test", "case_id": "test", "split": "holdout", "mode": "natural",
            "request": {"messages": [{"role": "user", "content": "source"}], "max_tokens": 48}, "production_grammar": None}
        second = {"key": "rewrite/test", "case_id": "test", "split": "holdout", "mode": "rewrite", "draft_from_key": first["key"],
            "request_template": {"prefix": "prefix", "suffix": "suffix", "max_tokens": 48}, "production_grammar": "root ::= text"}
        for row in [first, second]:
            row["request_sha256"] = request_hash(row.get("request", row.get("request_template")))
        return {"protocol": "BF16-semantic-multitask-v4", "grammar_applied": False,
                "cases": [{"id": "test", "split": "holdout"}], "jobs": [first, second]}

    def test_rewrite_cannot_use_another_case_or_incomplete_draft(self):
        plan = self.plan(); validate_plan(plan)
        for mutation in ["missing", "other-source"]:
            bad = copy.deepcopy(plan)
            if mutation == "missing": bad["jobs"][1]["draft_from_key"] = "missing"
            else: bad["cases"].append({"id": "other", "split": "holdout"}); bad["jobs"][1]["case_id"] = "other"
            with self.assertRaises(ValueError): validate_plan(bad)
        for record in [None, {"executed": True, "finish_reason": "length", "text": "partial"}]:
            with self.assertRaises(ValueError): materialize_rewrite(plan["jobs"][1], {"natural/test": record})
        request, digest = materialize_rewrite(plan["jobs"][1], {"natural/test": {"executed": True, "finish_reason": "stop", "text": '中文\n"draft"'}})
        self.assertEqual(request["messages"][0]["content"], 'prefix"中文\\n\\"draft\\""suffix')
        self.assertEqual(len(digest), 64)

    def test_train_splits_and_changed_inputs_are_rejected(self):
        for key in ["source", "training"]:
            bad = self.plan()
            if key == "source": bad["jobs"][0]["request"]["messages"][0]["content"] = "changed"
            else: bad["cases"][0]["split"] = "train"
            with self.assertRaises(ValueError): validate_plan(bad)

    def test_candidates_cannot_silently_change_data_order_or_optimizer(self):
        import json
        configs = {"ce_v4": json.loads((HERE / "config-semantic-ce-v4.json").read_text()),
                   "marker025_v4": json.loads((HERE / "config-semantic-marker025-v4.json").read_text())}
        verify_candidates(configs)
        for field, value in [("seed", 43), ("learning_rate", .1), ("candidate_max_steps", 64), ("initialization", "resume_verified_adapter")]:
            bad = copy.deepcopy(configs); bad["marker025_v4"][field] = value
            with self.assertRaises(ValueError): verify_candidates(bad)


if __name__ == "__main__": unittest.main()
