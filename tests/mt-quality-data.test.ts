import {readFileSync} from "node:fs";
import {afterEach, describe, expect, it} from "vitest";
import {canonicalSource, checkContentProbes, prepareQualityCase, qualityCallPlan, replayQualityCase} from "../eval/mt-quality/protocol";
import type {QualityCase} from "../eval/mt-quality/protocol";
import {PageTranslator} from "../src/core/page-translator";

const evaluation = JSON.parse(readFileSync("eval/mt-quality/cases.json", "utf8")).cases as QualityCase[];
const seeds = JSON.parse(readFileSync("training/mt-fixed-slots/seed.json", "utf8")).cases as QualityCase[];
afterEach(() => document.body.replaceChildren());

describe("MT quality and training data contract", () => {
  it("round-trips every reference through the deployed mapper and restores original DOM", async () => {
    for (const sample of [...evaluation, ...seeds]) {
      const prepared = prepareQualityCase(sample);
      const before = prepared.scope.innerHTML;
      const nodes = Array.from(prepared.root.childNodes);
      const translator = new PageTranslator(document, {
        prefersWholeSentenceHtml: async () => true,
        translateHtml: async () => prepared.referenceHtml,
      }, {displayMode: "translation"});
      await translator.translateAll(prepared.scope);
      expect(translator.translatedCount, sample.id).toBe(1);
      expect(Array.from(prepared.root.childNodes), sample.id).toEqual(nodes);
      expect(checkContentProbes(sample, prepared.referenceHtml).every(p => p.passed), sample.id).toBe(true);
      translator.setDisplayMode("bilingual"); translator.setDisplayMode("translation"); translator.restore();
      expect(prepared.scope.innerHTML, sample.id).toBe(before);
      prepared.scope.remove();
    }
  });

  it("keeps English sources, inference prompts, template families and IDs separate across splits", () => {
    const ids = new Set(), sources = new Set(), prompts = new Set(), families = new Map();
    for (const sample of [...evaluation, ...seeds]) {
      const prepared = prepareQualityCase(sample);
      const source = canonicalSource(sample);
      const wire = prepared.prompt + "\0" + prepared.grammar;
      expect(ids.has(sample.id), sample.id).toBe(false); ids.add(sample.id);
      expect(sources.has(source), sample.id).toBe(false); sources.add(source);
      expect(prompts.has(wire), sample.id).toBe(false); prompts.add(wire);
      expect(families.get(sample.family) ?? sample.split, sample.id).toBe(sample.split);
      families.set(sample.family, sample.split);
      expect(["assistant_authored_needs_human_review", "human_reviewed"]).toContain(sample.review_status);
      prepared.scope.remove();
    }
    expect(evaluation.filter(c => c.split === "holdout")).toHaveLength(20);
    expect(evaluation.filter(c => c.split === "diagnostic")).toHaveLength(6);
    expect(seeds.filter(c => c.split === "train")).toHaveLength(52);
    expect(seeds.filter(c => c.split === "validation")).toHaveLength(8);
  });

  it("detects a grammatically valid expanded link label without treating shape as semantic accuracy", () => {
    const sample = evaluation.find(c => c.id === "h-guide-scope")!;
    const p = prepareQualityCase(sample);
    const body = new DOMParser().parseFromString(p.referenceHtml, "text/html").body;
    body.querySelector('[data-flt-text-id="1"]')!.textContent = "请阅读迁移指南，然后再重启服务";
    expect(checkContentProbes(sample, body.innerHTML).find(p => p.id === "guide-label")?.passed).toBe(false);
    expect(p.scope.textContent).toContain("Read the");
  });

  it("distinguishes partial negation from forbidding every request", () => {
    const sample = evaluation.find(c => c.id === "h-not-all")!;
    const p = prepareQualityCase(sample);
    const body = new DOMParser().parseFromString(p.referenceHtml, "text/html").body;
    body.querySelector('[data-flt-text-id="0"]')!.textContent = "所有请求都不能缓存。";
    expect(checkContentProbes(sample, body.innerHTML).every(p => p.passed)).toBe(false);
  });

  it("rejects truncated or incorrectly assigned references before data export", () => {
    const sample = evaluation.find(c => c.id === "h-guide-scope")!;
    expect(() => prepareQualityCase({...sample, reference_slots: ["整句译文"]})).toThrow(/one-to-one/);
    expect(() => prepareQualityCase({...sample, reference_slots: ["", "指南", "继续"]})).toThrow(/invalid text-slot/);
  });

  it("replays captured output through the production decoder, mapper and restore path", async () => {
    const sample = evaluation.find(c => c.id === "h-client-only")!;
    const p = prepareQualityCase(sample), target = p.target;
    expect(qualityCallPlan(p.request)).toHaveLength(1); p.scope.remove();
    const result = await replayQualityCase(sample, [{text: target, finish_reason: "stop"}]);
    expect(result.displayed).toBe(true);
    expect(result.original_structure_unchanged && result.code_unchanged && result.restored_exact).toBe(true);
    expect(result.label_issues).toEqual([]);
  });

  it("retains a complete paragraph when recorded generation hit its limit", async () => {
    const sample = evaluation.find(c => c.id === "h-client-only")!;
    const p = prepareQualityCase(sample), target = p.target; p.scope.remove();
    const result = await replayQualityCase(sample, [{text: target, finish_reason: "length"}]);
    expect(result.displayed).toBe(false);
    expect(result.translated_text).toContain("Only the client");
    expect(result.restored_exact).toBe(true);
  });

  it("retains the paragraph when an otherwise valid frame erases a meaningful link label", async () => {
    const sample = evaluation.find(c => c.id === "d-html-headings-05")!;
    // Actual v0.2.2 Q5/grammar output from the 2026-10-22 CPU run.
    const target = "⟦0⟧页面上请只使用一个⟦/0⟧⟪P0⟫⟦1⟧，并且不要跳过层级，逐层嵌套标题⟦/1⟧⟦2⟧。⟦/2⟧⟦3⟧。⟦/3⟧";
    const result = await replayQualityCase(sample, [{text: target, finish_reason: "stop"}]);
    expect(result.displayed).toBe(false);
    expect(result.reason).toContain("link/emphasis text");
    expect(result.translated_text).toContain("nest headings");
    expect(result.original_structure_unchanged && result.code_unchanged && result.restored_exact).toBe(true);
  });
});
