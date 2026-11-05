import {readFileSync} from "node:fs";
import {afterEach, describe, expect, it} from "vitest";
import {prepareSourceDiagnostic, replaySourceDiagnostic} from "../eval/mt-quality/source-diagnostic";
import {prepareQualityCase, qualityCallPlan, type QualityCase} from "../eval/mt-quality/protocol";
import {replaySourceFramesInBrowser} from "../eval/mt-quality/browser-source-diagnostic";

const old = JSON.parse(readFileSync("eval/mt-quality/cases.json", "utf8")).cases as QualityCase[];
const web = JSON.parse(readFileSync("eval/mt-quality/external/source-format-v8.json", "utf8")).cases;
afterEach(() => document.body.replaceChildren());

describe("source-only translation diagnostic", () => {
  it("uses identical production requests without needing aligned Chinese slots", () => {
    for (const sample of old) {
      const reference = prepareQualityCase(sample), source = prepareSourceDiagnostic(sample);
      expect(source.request).toEqual(reference.request);
      expect(source.calls).toEqual(qualityCallPlan(reference.request));
      reference.scope.remove(); source.scope.remove();
    }
  });
  it("keeps published meaning references out of inference and uses actual visible code in natural text", () => {
    for (const sample of web) {
      const a = prepareSourceDiagnostic(sample), b = prepareSourceDiagnostic({...sample, meaning_reference: "DO NOT LEAK THIS REFERENCE"});
      expect(a.calls).toEqual(b.calls); expect(a.natural).toEqual(b.natural);
      expect(JSON.stringify([a.calls, a.natural])).not.toContain(sample.meaning_reference);
      expect(a.natural.messages[0]!.content).not.toContain("__FLT_OPAQUE_");
      expect(a.semantic.sourceText).toBe(a.root.textContent);
      a.scope.remove(); b.scope.remove();
    }
  });
  it("replays actual production frames and keeps rejected output distinct from displayed translation", async () => {
    const sample = {...old.find(c => c.id === "h-client-only")!, context_url: document.location.href};
    const p = prepareQualityCase(sample); const text = p.target; p.scope.remove();
    const accepted = await replaySourceDiagnostic(sample, [{text, finish_reason: "stop"}]);
    expect(accepted.displayed).toBe(true);
    expect(accepted.original_structure_unchanged && accepted.code_unchanged && accepted.restored_exact).toBe(true);
    const limited = await replaySourceDiagnostic(sample, [{text, finish_reason: "length"}]);
    expect(limited.displayed).toBe(false); expect(limited.translated_text).toContain("Only the client");
    expect(limited.original_structure_unchanged && limited.restored_exact).toBe(true);
    await expect(replaySourceDiagnostic(sample, [])).rejects.toThrow(/differs/);
  });
  it("checks browser replay source identity and distinguishes replay from browser inference", async () => {
    const sample = {...old.find(c => c.id === "h-client-only")!, context_url: document.location.href};
    const q = prepareQualityCase(sample), p = prepareSourceDiagnostic(sample);
    const text = q.target, fixed_source = p.semantic.fixed.source; q.scope.remove(); p.scope.remove();
    const completions = [{text, finish_reason: "stop"}];
    const expected = await replaySourceDiagnostic(sample, completions);
    const input = {model: "recorded-fixture", variant: "production" as const, sample, fixed_source, completions, expected};
    const result = await replaySourceFramesInBrowser([input]);
    expect(result.new_wllama_inference).toBe(false);
    expect(result.results[0]?.node_replay_text_matches).toBe(true);
    expect(result.results[0]?.original_structure_unchanged).toBe(true);
    await expect(replaySourceFramesInBrowser([{...input, fixed_source: "different input"}])).rejects.toThrow(/differs/);
  });
});
