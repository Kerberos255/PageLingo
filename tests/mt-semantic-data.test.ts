import {afterEach, describe, expect, it} from "vitest";
import {semanticCases, assertDeclaredSlotContracts} from "../training/mt-fixed-slots/semantic-v4.mjs";
import {prepareQualityCase} from "../eval/mt-quality/protocol";
import {prepareSemanticRewrite, semanticFixedPrompt, naturalTranslationPrompt} from "../eval/mt-quality/semantic-rewrite";
afterEach(() => document.body.replaceChildren());
describe("paired semantic curriculum", () => {
  it("maps each reference through production decoding and exposes complete role metadata", () => {
    for (const sample of semanticCases()) {
      assertDeclaredSlotContracts(sample);
      const p = prepareQualityCase(sample), encoded = prepareSemanticRewrite(p.request, p.segment.opaque);
      expect(encoded.textRoles).toHaveLength(sample.reference_slots.length);
      expect(naturalTranslationPrompt(encoded)).not.toContain("__FLT_");
      expect(semanticFixedPrompt(encoded, sample.natural_reference)).toContain(encoded.fixed.source);
      for (const part of encoded.protectedContext.filter(part => part.kind === "code")) expect(sample.natural_reference).toContain(part.text);
      p.scope.remove();
    }
  });
  it("rejects lost actions and linked action-scope shrinkage even when a frame still parses", () => {
    const samples = semanticCases();
    const tail = samples.find(sample => sample.id.endsWith("code-tail-actions-workers"))!;
    tail.reference_slots[0] = "这个示例会管理两个工作线程，使用的是";
    expect(() => assertDeclaredSlotContracts(tail)).toThrow(/Required action/);
    const label = samples.find(sample => sample.id.endsWith("linked-action-extent-refresh"))!;
    label.reference_slots[1] = "访问令牌";
    expect(() => assertDeclaredSlotContracts(label)).toThrow(/Required action/);
  });
  it("keeps all paired task views and contrastive drafts in the original split", () => {
    const family = new Map<string, string>(), ids = new Set<string>();
    for (const sample of semanticCases()) {
      expect(ids.has(sample.id)).toBe(false); ids.add(sample.id);
      if (family.has(sample.family)) expect(family.get(sample.family)).toBe(sample.split);
      family.set(sample.family, sample.split);
      if (sample.contrastive_draft) {
        expect(sample.split).toBe("train"); expect(sample.contrastive_draft).not.toBe(sample.natural_reference);
      }
    }
    expect(semanticCases().filter(sample => sample.split === "holdout")).toHaveLength(8);
  });
});
