import {afterEach, describe, expect, it} from "vitest";
import {correctiveCases, assertCorrectiveReference} from "../training/mt-fixed-slots/corrective-v5.mjs";
import {prepareQualityCase} from "../eval/mt-quality/protocol";
import {prepareSemanticRewrite, semanticFixedPrompt} from "../eval/mt-quality/semantic-rewrite";
afterEach(() => document.body.replaceChildren());
describe("fixed-only corrective supervision", () => {
  it("decodes every complete reference with original code and role ownership", () => {
    for (const sample of correctiveCases()) {
      assertCorrectiveReference(sample);
      const p = prepareQualityCase(sample), encoded = prepareSemanticRewrite(p.request, p.segment.opaque);
      expect(encoded.textRoles.length).toBe(sample.reference_slots.length);
      expect(semanticFixedPrompt(encoded)).not.toBe(p.prompt);
      expect(semanticFixedPrompt(encoded)).not.toContain("中文草稿");
      for (const part of encoded.protectedContext.filter(part => part.kind === "code")) expect(sample.natural_reference).toContain(part.text);
      p.scope.remove();
    }
  });
  it("catches a lost action before a final immutable code-only link", () => {
    const sample = correctiveCases().find(s => s.id === "v5-train-batch-descriptors-0")!;
    sample.reference_slots[0] = "批次初始化器会处理各行，所用的对象是";
    expect(() => assertCorrectiveReference(sample)).toThrow(/Missing declared/);
  });
  it("rejects a reversed temporal label even though a normal frame can parse it", () => {
    const sample = correctiveCases().find(s => s.id === "v5-train-certificate-attestations-0-before")!;
    sample.reference_slots[2] = "晚于";
    expect(() => prepareQualityCase(sample)).not.toThrow();
    expect(() => assertCorrectiveReference(sample)).toThrow(/Missing declared/);
  });
  it("rejects shrinking an action link to its noun or changing passing into binding", () => {
    const action = correctiveCases().find(s => s.id === "v5-train-transfer-retries-0")!;
    action.reference_slots[1] = "待处理转账";
    expect(() => assertCorrectiveReference(action)).toThrow(/Missing declared/);
    const bound = correctiveCases().find(s => s.id === "v5-train-parser-handoff-bound-0")!;
    bound.reference_slots[1] = "方法绑定到";
    expect(() => assertCorrectiveReference(bound)).toThrow(/Missing declared/);
  });
  it("keeps source families disjoint across the bounded train/validation/holdout sets", () => {
    const families = new Map<string, string>(), counts = {train: 0, validation: 0, holdout: 0};
    for (const sample of correctiveCases()) {
      expect(["train", "validation", "holdout"]).toContain(sample.split);
      if (families.has(sample.family)) expect(families.get(sample.family)).toBe(sample.split);
      families.set(sample.family, sample.split);
      counts[sample.split as keyof typeof counts]++;
    }
    expect(counts).toEqual({train: 64, validation: 8, holdout: 8});
  });
});
