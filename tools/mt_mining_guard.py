"""Preflight guards for training-only native mining; never infer semantic errors."""
import hashlib
import json


def validate_mining_plan(plan):
    if plan.get("protocol") != "fixed-training-error-mining-v1" or plan.get("grammar_applied") is not True or plan.get("heldout_sources_in_jobs") is not False:
        raise ValueError("Expected explicit training-only grammar mining plan")
    cases = {row["id"]: row for row in plan["cases"]}
    if not cases or len(cases) != len(plan["cases"]) or any(row.get("split") != "train" for row in cases.values()):
        raise ValueError("Reserved/repeated sources cannot be mined for optimization")
    seen = set()
    for job in plan["jobs"]:
        identity = job["case_id"]; request = job["request"]
        if identity not in cases or identity in seen or job.get("split") != "train" or job.get("family") != cases[identity]["family"]:
            raise ValueError("Training-source mining job identity changed")
        seen.add(identity)
        if not isinstance(request.get("grammar"), str) or not request["grammar"].strip(): raise ValueError("Mining requires the fixed production frame")
        if [m["role"] for m in request["messages"]] != ["user"] or not 1 <= request["max_tokens"] <= 768: raise ValueError("Unexpected mining request")
        digest = hashlib.sha256(json.dumps(request, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()
        if digest != job.get("request_sha256"): raise ValueError("Frozen mining request changed")
    if seen != set(cases): raise ValueError("Missing source mining jobs")
