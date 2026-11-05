"""Summarize completed source/format runs and explicit assistant audits."""
import argparse
import hashlib
import html
import json
from pathlib import Path
import re
import statistics
from collections import Counter

ARMS = ["base_hymt_q5", "old_r16_q5", "qwen3_4b_q5"]
VERDICTS = {"faithful", "minor_issue", "semantic_error", "uncertain", "not_displayed", "incomplete"}


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def read(path):
    return json.loads(path.read_text())


def exact_protected_code_counts(text, code):
    if not code:
        return True
    # Prefer the longest complete code string. allSettled() is contained in
    # Promise.allSettled(); with must not be counted inside the word without.
    alternatives = "|".join(re.escape(value) for value in sorted(set(code), key=len, reverse=True))
    matches = re.findall(r"(?<![A-Za-z0-9_$])(?:" + alternatives + r")(?![A-Za-z0-9_$])", text)
    return Counter(matches) == Counter(code)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, required=True)
    args = parser.parse_args()
    root = args.root
    plan = read(root / "plan-final.json")
    audit = read(root / "audit.json")
    assert audit["independent_human_review"] is False
    assert audit["plan_sha256"] == digest(root / "plan-final.json")
    summary = {"protocol": plan["protocol"], "plan_sha256": audit["plan_sha256"],
               "environment": read(root / "environment.json"), "evaluation_only": True,
               "training_executed": False, "optimizer_inputs_approved": False,
               "limitations": plan["limitations"], "models": {}, "audit": audit,
               "rubric_sha256": digest(root / "meaning-rubric-before-review.json")}
    comparisons = {c["id"]: {"case": c, "models": {}} for c in plan["cases"]}
    for arm in ARMS:
        run_file = root / arm / "run.json"
        replay_file = root / arm / "replay.json"
        run, replay = read(run_file), read(replay_file)
        assert run.get("finished_utc") and run["plan_sha256"] == summary["plan_sha256"]
        assert replay["run_sha256"] == digest(run_file) and replay["plan_sha256"] == run["plan_sha256"]
        assert len(run["generations"]) == len(plan["jobs"]) and len(replay["results"]) == len(plan["cases"])
        audited = {r["id"]: r for r in audit["models"][arm]}
        assert len(audited) == len(plan["cases"])
        scores = {}
        for row in replay["results"]:
            grade = audited.pop(row["id"])
            for mode in ["natural", "production"] + (["context"] if "context_research" in row else []):
                assert grade[mode]["verdict"] in VERDICTS and grade[mode]["reason"]
                if mode == "production" and not row["production"]["displayed"]:
                    assert grade[mode]["verdict"] == "not_displayed"
            comparisons[row["id"]]["models"][arm] = {"output": row, "audit": grade,
                "native_outputs": [{key: g[key] for key in ["variant", "text", "finish_reason", "request_sha256"]}
                                   for g in run["generations"] if g["case_id"] == row["id"]]}
        assert not audited
        for group in ["fresh_web_excerpt", "known_training_control"]:
            rows = [r for r in replay["results"] if r["group"] == group]
            grades = [comparisons[r["id"]]["models"][arm]["audit"] for r in rows]
            exact_code = 0
            for row in rows:
                code = comparisons[row["id"]]["case"]["protected_code"]
                exact_code += exact_protected_code_counts(row["natural"]["text"], code)
            scores[group] = {"cases": len(rows), "semantic_verdicts": {
                mode: {verdict: sum(g[mode]["verdict"] == verdict for g in grades) for verdict in sorted(VERDICTS)}
                for mode in ["natural", "production"]},
                "production_displayed": sum(r["production"]["displayed"] for r in rows),
                "assistant_audited_production_scope_errors": sum(g["production"].get("scope_error", False) for g in grades),
                "natural_code_occurrences_preserved": sum(r["natural"]["protected_code_occurrences_preserved"] for r in rows),
                "natural_code_exact_occurrence_counts": exact_code,
                "structure_code_restore_passed": sum(r["production"]["original_structure_unchanged"] and r["production"]["code_unchanged"] and r["production"]["restored_exact"] for r in rows)}
        metrics = {}
        for variant in ["natural-visible", "production-fixed:0", "context-fixed"]:
            rows = [r for r in run["generations"] if r["variant"] == variant]
            metrics[variant] = {"generations": len(rows), "eos": sum(r["stop_type"] == "eos" for r in rows),
                "first_nonempty_stream_fragment_median_s": statistics.median(r["first_token_s"] for r in rows if r["first_token_s"] is not None),
                "server_decode_tokens_per_second_median": statistics.median(r["timings"]["predicted_per_second"] for r in rows),
                "generation_wall_sum_s": sum(r["wall_s"] for r in rows),
                "input_tokens_sum": sum(r["input_tokens"] for r in rows),
                "output_tokens_sum": sum(r["timings"]["predicted_n"] for r in rows)}
        summary["models"][arm] = {"identity": run["model"], "run_sha256": digest(run_file),
            "replay_sha256": digest(replay_file), "ready_wall_s_warm_file_cache": run["ready_wall_s"],
            "process_peak": run["proc_status"], "scores": scores, "metrics": metrics}
    precision_file = root / "old_r16_bf16_controls/run.json"
    if precision_file.exists():
        precision, precision_plan = read(precision_file), read(root / "plan-bf16-controls.json")
        decoded = read(root / "old_r16_bf16_controls/replay.json")
        assert precision.get("finished_utc") and precision["plan_sha256"] == digest(root / "plan-bf16-controls.json")
        assert precision_plan["parent_plan_sha256"] == summary["plan_sha256"]
        assert decoded["run_sha256"] == digest(precision_file)
        q5 = read(root / "old_r16_q5/run.json")
        baseline = {(g["case_id"], g["variant"]): g for g in q5["generations"]}
        assert len(precision["generations"]) == len(precision_plan["jobs"]) == 4
        for job, row in zip(precision_plan["jobs"], precision["generations"]):
            assert (row["case_id"], row["variant"], row["request_sha256"]) == (job["case_id"], job["variant"], job["request_sha256"])
            other = baseline[(row["case_id"], row["variant"])]
            assert all(row[k] == other[k] for k in ["request_sha256", "actual_prompt_sha256", "input_token_ids_sha256"])
        summary["bf16_precision_control"] = {"identity": precision["model"], "run_sha256": digest(precision_file),
            "plan_sha256": precision["plan_sha256"], "input_requests_and_tokens_equal_to_q5": True,
            "ready_wall_s_warm_file_cache": precision["ready_wall_s"], "process_peak": precision["proc_status"],
            "generations": precision["generations"], "replay": decoded["results"], "audit": read(root / "bf16-audit.json")}
    if (root / "reference-likelihood.json").exists():
        probe = read(root / "reference-likelihood.json")
        for original, expected in probe["input_hashes"].items():
            snapshot = probe.get("input_snapshot_aliases", {}).get(original, original)
            assert digest(Path(snapshot)) == expected, "Changed likelihood input snapshot"
        summary["reference_likelihood_probe"] = probe
    if (root / "firefox/result.json").exists():
        browser = read(root / "firefox/result.json")
        assert browser["plan_sha256"] == summary["plan_sha256"] and browser["new_wllama_inference"] is False
        summary["firefox_recorded_frame_replay"] = {"sha256": digest(root / "firefox/result.json"),
            "browser_version": browser["browser_version"], "records": len(browser["results"]), "new_wllama_inference": False,
            "checks": {key: sum(row[key] for row in browser["results"]) for key in ["native_serialized_source_matches",
                "node_replay_text_matches", "node_replay_display_matches", "original_structure_unchanged", "code_unchanged", "restored_exact"]}}
    summary["comparisons"] = list(comparisons.values())
    (root / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n")
    esc = lambda text: html.escape(str(text))
    parts = ['<!doctype html><meta charset="utf-8"><title>PageLingo v8 actual source/format diagnostic</title>',
             '<style>body{font:16px/1.6 system-ui;max-width:1500px;margin:auto;padding:24px}table{border-collapse:collapse;width:100%;table-layout:fixed}th,td{border:1px solid #bbb;padding:12px;vertical-align:top;overflow-wrap:anywhere}pre{white-space:pre-wrap}details{margin:24px 0}small{color:#555}</style>',
             '<h1>PageLingo v8：原文、自然翻译与固定槽实际输出</h1>',
             '<p>12 条新网页与 4 条旧训练题分组。公开中文仅作意思参考；以下语义判定由助手审核，未经独立人工盲审。context 为研究提示，未启用到扩展。</p>']
    for comparison in comparisons.values():
        case = comparison["case"]
        parts += [f'<details open><summary>{esc(case["id"])} · {esc(case["group"])}</summary>',
                  f'<p><a href="{esc(case["context_url"])}">英文来源</a></p><pre>{esc(case["source_text"])}</pre>']
        if case["meaning_reference"]:
            parts += [f'<p>公开中文意思参考：</p><pre>{esc(case["meaning_reference"])}</pre>']
        parts += ['<table><tr><th>模型</th><th>自然翻译</th><th>生产固定槽</th><th>补充上下文研究</th></tr>']
        for arm, item in comparison["models"].items():
            row, grade = item["output"], item["audit"]
            parts += [f'<tr><th>{esc(arm)}</th>']
            for key, output in [("natural", row["natural"]["text"]), ("production", row["production"]["translated_text"]),
                                ("context", row.get("context_research", {}).get("replay", {}).get("translated_text"))]:
                g = grade.get(key)
                if g is None:
                    parts += ['<td>—</td>']
                    continue
                cell = f'<td><pre>{esc(output)}</pre><b>{esc(g["verdict"])}</b><p>{esc(g["reason"])}</p><small>{esc(g.get("format_notes", ""))}</small>'
                if g["verdict"] == "not_displayed":
                    variant = "context-fixed" if key == "context" else "production-fixed:0"
                    raw = next(o["text"] for o in item["native_outputs"] if o["variant"] == variant)
                    cell += f'<details><summary>校验已保留原文；展开模型原始输出</summary><pre>{esc(raw)}</pre></details>'
                parts += [cell + '</td>']
            parts += ['</tr>']
        parts += ['</table></details>']
    if "bf16_precision_control" in summary:
        parts += ['<h2>旧 r16 BF16 精度复核（2 条旧训练控制题）</h2><p>与 Q5 的实际请求、prompt 和输入 token SHA 相同。没有新训练。</p><table><tr><th>ID</th><th>自然翻译</th><th>固定槽</th></tr>']
        for row in summary["bf16_precision_control"]["replay"]:
            parts += [f'<tr><td>{esc(row["id"])}</td><td><pre>{esc(row["natural"]["text"])}</pre></td><td><pre>{esc(row["production"]["translated_text"])}</pre></td></tr>']
        parts += ['</table>']
    if "reference_likelihood_probe" in summary:
        parts += ['<h2>同一原始 BF16 权重下的三个 nonce 目标</h2><p>旧固定正例、Q5 实际错误与 BF16 实际正确输出分别计分；不是训练或独立质量认证。</p><table><tr><th>目标</th><th>整序列 log probability</th><th>内容平均 log probability</th><th>实际文字</th></tr>']
        for row in summary["reference_likelihood_probe"]["rows"]:
            parts += [f'<tr><td>{esc(row["name"])}</td><td>{row["sequence_logp"]:.6f}</td><td>{row["content_mean_logp"]:.6f}</td><td><pre>{esc(row["text"])}</pre></td></tr>']
        parts += ['</table>']
    (root / "comparison.html").write_text("\n".join(parts))
    print(json.dumps({arm: summary["models"][arm]["scores"] for arm in ARMS}, ensure_ascii=False))


if __name__ == "__main__":
    main()
