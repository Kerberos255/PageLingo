"""Summarize completed paired CPU runs without treating keyword probes as accuracy."""
import argparse
import hashlib
import json
from pathlib import Path
import statistics

ROOT = Path(__file__).resolve().parents[1]
LABELS = ["base", "pagelingo-mt-v0.2.2"]
parser = argparse.ArgumentParser()
parser.add_argument("--results", type=Path, required=True)
parser.add_argument("--out", type=Path, required=True)
args = parser.parse_args()


def load(name):
    value = json.loads((args.results / name).read_text())
    if not value.get("finished_utc"):
        raise ValueError("Incomplete run: " + name)
    return value


def digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True).encode()).hexdigest()


def inputs(case):
    return {"request": case["request"], "completions": [
        {key: c[key] for key in ["prompt", "grammar", "budget"]} for c in case["completions"]]}


def compact(case):
    return {key: value for key, value in case.items() if key not in ["request", "source_text", "completions"]} | {
        "completions": [{key: value for key, value in c.items() if key not in ["prompt", "grammar"]}
                        for c in case["completions"]]}


runs = load("runs.json")
fixed = {label: load(label + "-fixed.json") for label in LABELS}
plain = {label: load(label + "-plain.json") for label in LABELS}
if fixed[LABELS[0]]["settings"] != fixed[LABELS[1]]["settings"]:
    raise ValueError("Sampling settings differ")
expected = {c["id"]: c for c in json.loads((ROOT / "eval/mt-quality/cases.json").read_text())["cases"]}
for mode in [fixed, plain]:
    left, right = [mode[label]["cases"] for label in LABELS]
    if [c["id"] for c in left] != [c["id"] for c in right]:
        raise ValueError("Paired case IDs differ")
    for a, b in zip(left, right):
        if a.get("error") or b.get("error") or not a["completions"] or not b["completions"]:
            raise ValueError("Harness error or missing completion")
        if inputs(a) != inputs(b) or a["source_text"] != b["source_text"]:
            raise ValueError("Unequal actual model inputs: " + a["id"])
if set(expected) != {c["id"] for c in fixed[LABELS[0]]["cases"]}:
    raise ValueError("Evaluation corpus IDs differ")

report = {"schema_version": 1, "run_started_utc": runs["created_utc"], "run_finished_utc": runs["finished_utc"],
    "evaluated_production_commit": "8386e33a3d2d7c2d3ced6ca42a76ee9ad61c58d0",
    "scope": "26 paired fixed-slot cases and 6 paired plain diagnostics; native CPU, not a new Firefox run",
    "limitations": ["Assistant-authored references/probes, no independent human review or semantic accuracy score",
        "20 holdout examples are disjoint from the new seed; unknown original MT training data may overlap",
        "Six diagnostics were selected from previous failures and are not an unbiased test set",
        "Keyword/slot probes can reject acceptable synonyms or harmless movement outside links",
        "DOM identity checks do not prove that translated link/emphasis text retains its meaning",
        "Timings include warm filesystem cache and concurrent validation; not a cold-load or browser performance comparison"],
    "paired_actual_prompts_grammars_budgets_identical": True,
    "settings": fixed[LABELS[0]]["settings"], "models": {}, "cases": [], "plain_diagnostics": [], "raw_file_sha256": {}}
for file in ["runs.json"] + [label + "-" + mode + ".json" for label in LABELS for mode in ["fixed", "plain"]]:
    report["raw_file_sha256"][file] = hashlib.sha256((args.results / file).read_bytes()).hexdigest()
for label in LABELS:
    run = next(r for r in runs["runs"] if r["model"] == label)
    cs = fixed[label]["cases"]
    summary = {}
    for split in ["holdout", "diagnostic"]:
        selected = [c for c in cs if c["split"] == split]
        summary[split] = {"cases": len(selected), "displayed": sum(c["displayed"] for c in selected),
            "retained_original": sum(not c["displayed"] for c in selected),
            "all_declared_probes_passed": sum(c["all_content_probes_passed"] for c in selected)}
    calls = [call for c in cs for call in c["completions"]]
    report["models"][label] = {key: run[key] for key in ["bytes", "sha256", "ready_wall_s", "final_process_status"]} | {
        "server_arguments": run["command"][3:], "summary": summary,
        "all_26_dom_code_restore_checks_passed": all(c[k] for c in cs for k in ["original_structure_unchanged", "code_unchanged", "restored_exact"]),
        "dom_code_restore_cases_passed": sum(all(c[k] for k in ["original_structure_unchanged", "code_unchanged", "restored_exact"]) for c in cs),
        "fixed_ttft_median_s": statistics.median(c["ttft_s"] for c in calls),
        "fixed_generation_median_tokens_s": statistics.median(c["timings"]["predicted_per_second"] for c in calls),
        "fixed_stop_types": {kind: sum(c["stop_type"] == kind for c in calls) for kind in sorted({c["stop_type"] for c in calls})}}
for a, b in zip(*[fixed[label]["cases"] for label in LABELS]):
    source = expected[a["id"]]
    report["cases"].append({"id": a["id"], "split": a["split"], "category": a["category"],
        "source_html": source["html"], "source_text": a["source_text"], "reference_slots": source["reference_slots"],
        "reference_status": source["review_status"], "origin": source["origin"], "paired_input_sha256": digest(inputs(a)),
        **{label: compact(c) for label, c in zip(LABELS, [a, b])}})
for a, b in zip(*[plain[label]["cases"] for label in LABELS]):
    report["plain_diagnostics"].append({"id": a["id"], "source_text": a["source_text"],
        "paired_input_sha256": digest(inputs(a)), **{label: compact(c) for label, c in zip(LABELS, [a, b])}})
args.out.parent.mkdir(parents=True, exist_ok=True)
args.out.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")

lines = ["# PageLingo MT paired CPU evaluation", "", f"Run: {report['run_started_utc']} → {report['run_finished_utc']}", "",
    "Both models received identical actual prompts, grammars, token budgets and sampling settings. Both use Q5_K_M.", "",
    "Probe counts below are keyword/slot checks, **not translation accuracy**. References have not been independently reviewed.", "",
    "| Model | Holdout displayed | Holdout all probes | Diagnostic displayed | Diagnostic all probes | DOM/code/restore |",
    "| --- | --- | --- | --- | --- | --- |"]
for label, model in report["models"].items():
    h, d = [model["summary"][s] for s in ["holdout", "diagnostic"]]
    lines.append(f"| {label} | {h['displayed']}/{h['cases']} | {h['all_declared_probes_passed']}/{h['cases']} | {d['displayed']}/{d['cases']} | {d['all_declared_probes_passed']}/{d['cases']} | {model['dom_code_restore_cases_passed']}/{h['cases'] + d['cases']} |")
lines += ["", "## Limits", ""] + ["- " + s for s in report["limitations"]] + ["", "## Every fixed-slot result", ""]
for c in report["cases"]:
    lines += [f"### {c['id']}", "", c["source_text"], ""]
    for label in LABELS:
        row = c[label]
        failed = [p["id"] for p in row.get("content_probes") or [] if not p["passed"]]
        status = "displayed" if row["displayed"] else "retained original: " + row["checked"]["reason"]
        lines += [f"**{label}** — {status}; failed probes: {', '.join(failed) or 'none evaluated/failed'}", "", row["translated_text"], ""]
lines += ["## Plain diagnostic controls", "", "These outputs have no slot mapping and cannot be inserted into the original DOM by this protocol.", ""]
for c in report["plain_diagnostics"]:
    lines += [f"### {c['id']}", ""]
    for label in LABELS:
        lines += [f"**{label}**", "", c[label]["raw_plain_text"], ""]
args.out.with_suffix(".md").write_text("\n".join(lines))
print(json.dumps({"out": str(args.out), "fixed_pairs": len(report["cases"]), "plain_pairs": len(report["plain_diagnostics"])}))
