import {afterEach, describe, expect, it, vi} from "vitest";
// This tests source selection and DOM references, not the exporter bundler.
vi.mock("esbuild", () => ({build: vi.fn()}));
import {trainingMiningCases} from "../tools/mt-mining-plan.mjs";
import {preferenceCases} from "../training/mt-fixed-slots/preference-v6.mjs";
import {correctiveCases} from "../training/mt-fixed-slots/corrective-v5.mjs";
import {prepareQualityCase, canonicalSource} from "../eval/mt-quality/protocol";
afterEach(() => document.body.replaceChildren());
describe("training-source hard-negative mining", () => {
  it("mines only bounded existing training sources and never promotes heldout failures", () => {
    const rows=trainingMiningCases(), known=new Map([...preferenceCases(),...correctiveCases()].map(c=>[c.id,c]));
    const reserved=new Set([...known.values()].filter(c=>c.split!=="train").map(c=>canonicalSource(c)));
    expect(rows).toHaveLength(76);expect(new Set(rows.map(r=>r.id)).size).toBe(rows.length);
    for(const row of rows){expect(row.split).toBe("train");expect(known.get(row.id)?.split).toBe("train");expect(reserved.has(canonicalSource(row))).toBe(false);}
  });
  it("keeps usable complete references for every selected source", () => {
    for(const sample of trainingMiningCases()){
      const p=prepareQualityCase(sample);expect(p.grammar).toBeTruthy();expect(p.target).toContain("⟦0⟧");p.scope.remove();
    }
  });
});
