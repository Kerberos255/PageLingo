"""Evaluation-only source/format jobs. Never supply a reference as a target."""
import hashlib
import json


def validate_source_diagnostic(plan):
    if plan.get("protocol") != "source-format-diagnostic-v8" or plan.get("evaluation_only") is not True or plan.get("optimizer_inputs_approved") is not False:
        raise ValueError("Expected evaluation-only diagnostic")
    cases = {row["id"]: row for row in plan["cases"]}
    if not cases or len(cases) != len(plan["cases"]) or any(row.get("split") != "diagnostic" for row in cases.values()):
        raise ValueError("Repeated or non-diagnostic sources")
    expected = {(row["id"], "natural-visible") for row in cases.values()}
    for row in cases.values():
        if not isinstance(row.get("fixed_calls"), int) or row["fixed_calls"] < 1:
            raise ValueError("Missing production calls")
        expected.update((row["id"], "production-fixed:" + str(i)) for i in range(row["fixed_calls"]))
        if row.get("context_check") is True:
            if row["fixed_calls"] != 1:
                raise ValueError("Context probe requires one complete frame")
            expected.add((row["id"], "context-fixed"))
    seen = set()
    for job in plan["jobs"]:
        key = (job["case_id"], job["variant"])
        if key not in expected or key in seen:
            raise ValueError("Unexpected or repeated diagnostic job")
        seen.add(key)
        request = job["request"]
        if set(request) != {"messages", "max_tokens", "grammar"} or [m["role"] for m in request["messages"]] != ["user"] or not 1 <= request["max_tokens"] <= 768:
            raise ValueError("Unexpected diagnostic request")
        if key[1] == "natural-visible":
            if request["grammar"] is not None:
                raise ValueError("Natural translation must be unconstrained")
        elif not isinstance(request["grammar"], str) or not request["grammar"].strip():
            raise ValueError("Fixed translation must use production grammar")
        digest = hashlib.sha256(json.dumps(request, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()
        if digest != job.get("request_sha256"):
            raise ValueError("Frozen request changed")
    if seen != expected:
        raise ValueError("Missing diagnostic jobs")
