import {afterEach, describe, expect, it} from "vitest";
import {preferenceCases, assertPreferenceReference} from "../training/mt-fixed-slots/preference-v6.mjs";
import {prepareQualityCase, qualityCallPlan, replayQualityCase} from "../eval/mt-quality/protocol";
afterEach(() => document.body.replaceChildren());
describe("format-valid semantic preference contrasts", () => {
  it("decodes both alternatives with identical prompts and fixed/protected frames", () => {
    const families = new Map<string, string>(), counts = {train: 0, validation: 0, holdout: 0};
    for (const sample of preferenceCases()) {
      assertPreferenceReference(sample);
      const chosen = prepareQualityCase(sample), rejected = prepareQualityCase({...sample, reference_slots: sample.rejected_slots});
      expect(chosen.prompt).toBe(rejected.prompt); expect(chosen.target).not.toBe(rejected.target);
      expect(chosen.target.match(/⟦\/?\d+⟧|⟪P\d+⟫/gu)).toEqual(rejected.target.match(/⟦\/?\d+⟧|⟪P\d+⟫/gu));
      expect(qualityCallPlan(chosen.request)).toHaveLength(1);
      if (families.has(sample.family)) expect(families.get(sample.family)).toBe(sample.split);
      families.set(sample.family, sample.split); counts[sample.split as keyof typeof counts]++;
      chosen.scope.remove(); rejected.scope.remove();
    }
    expect(counts).toEqual({train: 96, validation: 16, holdout: 16});
  });
  it("shows why parsing cannot reject a legal before/after meaning reversal", async () => {
    const sample = preferenceCases().find(s => s.id === "v6-holdout-temporal-segment-before-code")!;
    const p = prepareQualityCase({...sample, reference_slots: sample.rejected_slots}); const text = p.target; p.scope.remove();
    expect(text).toContain("晚于");
    const result = await replayQualityCase(sample, [{text, finish_reason: "stop"}]);
    expect(result.displayed).toBe(true); expect(result.original_structure_unchanged).toBe(true);
    expect(result.code_unchanged).toBe(true); expect(result.restored_exact).toBe(true);
  });
  it("rejects silently replacing a chosen reference with its negative", () => {
    const sample = preferenceCases()[0]!; sample.reference_slots = [...sample.rejected_slots];
    expect(() => assertPreferenceReference(sample)).toThrow(/semantic contrast/);
  });
  it("balances both temporal and positive/negative directions within each split", () => {
    for (const split of ["train", "validation", "holdout"]) {
      const rows = preferenceCases().filter(s => s.split === split);
      const before = rows.filter(s => s.id.includes("-temporal-") && s.id.includes("-before-")).length;
      expect(rows.filter(s => s.id.includes("-temporal-") && s.id.includes("-after-")).length).toBe(before);
      expect(rows.filter(s => s.id.endsWith("-require")).length).toBe(rows.filter(s => s.id.endsWith("-forbid")).length);
      expect(rows.filter(s => s.id.endsWith("-pass-bound")).length).toBe(rows.filter(s => s.id.endsWith("-bind")).length);
    }
  });
});
