import {afterEach, describe, expect, it} from "vitest";
import {replayAlignmentInBrowser} from "../eval/mt-quality/browser-alignment";
import type {QualityCase} from "../eval/mt-quality/protocol";
import {runBrowserStructureRegressions} from "../eval/mt-quality/browser-structure";

afterEach(() => document.body.replaceChildren());
const sample: QualityCase = {id: "browser-alignment-test", split: "diagnostic", family: "browser-alignment-test", category: "formatting",
  html: '<p>Read <a href="/guide">the guide</a> using <code>cancel()</code>.</p>', context_url: "https://example.com/",
  origin: {kind: "authored"}, reference_slots: ["阅读", "指南", "并使用"], probes: [], review_status: "assistant_authored_needs_human_review"};

describe("browser replay driver", () => {
  it("checks all browser structure scenarios with the same source driver", async () => {
    const result = await runBrowserStructureRegressions();
    expect(result.rows).toHaveLength(8); expect(result.rows.every(row => row.passed)).toBe(true);
  });
  it("exercises independent phrases through real rendering, click listeners and exact restoration", async () => {
    const row = await replayAlignmentInBrowser(sample, [
      {case_id: sample.id, variant: "draft", text: "阅读指南并使用⟪P0⟫⟪P1⟫", finish_reason: "stop"},
      {case_id: sample.id, variant: "phrase_0", text: "指南", finish_reason: "stop"},
    ], "phrase_alignment");
    expect(row.displayed).toBe(true);
    expect(row.labels[0]!.target).toBe("指南");
    expect(row.serialized_source_matches && row.link_listener_preserved && row.original_structure_unchanged && row.code_unchanged && row.restored_exact).toBe(true);
  });
  it("retains the whole original paragraph for unassigned words after protected punctuation", async () => {
    const row = await replayAlignmentInBrowser(sample, [
      {case_id: sample.id, variant: "sentence_free", text: "阅读⟦0⟧指南⟦/0⟧并使用⟪P0⟫⟪P1⟫然后关闭", finish_reason: "stop"},
    ], "sentence_free");
    expect(row.displayed).toBe(false);
    expect(row.reason).toMatch(/unassigned/);
    expect(row.translated_text).toBe("Read the guide using cancel().");
    expect(row.original_structure_unchanged && row.code_unchanged && row.restored_exact).toBe(true);
  });
});
