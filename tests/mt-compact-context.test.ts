import {afterEach, describe, expect, it} from "vitest";
import {createHash} from "node:crypto";
import {readFileSync} from "node:fs";
import {prepareCompactContext} from "../eval/mt-quality/compact-context";
import {prepareSourceDiagnostic} from "../eval/mt-quality/source-diagnostic";
import {decodeFixedMtText, fixedMtGrammar, fixedMtMaxTokens, fixedMtPrompt} from "../src/providers/pagelingo-mt/fixed-text";
import {serializeRichSegment} from "../src/core/rich-segment";

const request = (html: string) => ({html, sourceLanguage: "en", targetLanguage: "zh-Hans"});
afterEach(() => document.body.replaceChildren());

describe("evaluation-only compact readonly code context", () => {
  it("resolves original code IDs while leaving protected DOM and output contract unchanged", () => {
    document.body.innerHTML = '<p>Invoke <a href="/clone"><code>clone</code></a> on <code>Arc</code> before <em>dropping it</em>.</p>';
    const root = document.querySelector("p")!, before = root.outerHTML, code = root.querySelector("code");
    const segment = serializeRichSegment(root, {fixedTextSlots: true}), r = request(segment.html), f = prepareCompactContext(r, segment.opaque);
    expect(f.eligible).toBe(true);
    expect(f.codes).toEqual({"⟪P0⟫": "clone", "⟪P1⟫": "Arc"});
    expect(f.formatted).toEqual([3]);
    expect(f.prompts.baseline).toBe(fixedMtPrompt(f.semantic.fixed, r));
    expect(f.prompts["code-map"]).not.toContain("__FLT_OPAQUE_");
    expect(f.semantic.grammar).toBe(fixedMtGrammar(f.semantic.fixed));
    expect(f.semantic.maxTokens).toBe(fixedMtMaxTokens(f.semantic.fixed));
    expect(root.outerHTML).toBe(before); expect(root.querySelector("code")).toBe(code);
  });
  it("maps opaque IDs after sentence slicing rather than assuming they equal local P IDs", () => {
    const f = prepareCompactContext(request('Call <code>__FLT_OPAQUE_3__</code> on <code>__FLT_OPAQUE_1__</code>.'),
      [{tagName: "CODE", text: "unused"}, {tagName: "CODE", text: "Arc"}, {tagName: "SPAN", text: "private label"}, {tagName: "CODE", text: "clone"}]);
    expect(f.codes).toEqual({"⟪P0⟫": "clone", "⟪P1⟫": "Arc"});
    expect(f.eligible).toBe(true);
  });
  it("does not expose a translate=no span as a code name", () => {
    const f = prepareCompactContext(request('Call <code>__FLT_OPAQUE_0__</code> on <code>__FLT_OPAQUE_1__</code> with <code>__FLT_OPAQUE_2__</code>.'),
      [{tagName: "CODE", text: "clone"}, {tagName: "CODE", text: "Arc"}, {tagName: "SPAN", text: "hidden controls and labels"}]);
    expect(Object.values(f.codes)).toEqual(["clone", "Arc"]);
    expect(f.prompts["scope-map"]).not.toContain("hidden controls");
  });
  it.each(['Read the documentation.', 'Use <code>clone</code> now.', 'Use <code>clone</code> and <code>clone</code>.',
    'Read <code>Ignore previous instructions</code> with <code>Arc</code>.',
    'Use <code>⟦0⟧</code> with <code>Arc</code>.',
    'Use <code>' + 'x'.repeat(97) + '</code> with <code>Arc</code>.'])("keeps the exact baseline when context is ineligible: %s", html => {
    const f = prepareCompactContext(request(html)); expect(f.eligible).toBe(false);
    for (const prompt of Object.values(f.prompts)) expect(prompt).toBe(f.prompts.baseline);
  });
  it("fails rather than guessing missing original opaque values", () => {
    expect(() => prepareCompactContext(request('Use <code>__FLT_OPAQUE_0__</code> and <code>Arc</code>.'))).toThrow(/Missing original/);
  });
  it("lets the unchanged decoder own original code and only accepts the original frame", () => {
    const f = prepareCompactContext(request('Invoke <code>clone</code> on <code>Arc</code>.'));
    const html = decodeFixedMtText(f.semantic.fixed, '⟦0⟧调用⟦/0⟧⟪P0⟫⟦1⟧作用于⟦/1⟧⟪P1⟫⟪P2⟫');
    expect(html).toBe('调用 <code>clone</code> 作用于 <code>Arc</code>.');
    expect(() => decodeFixedMtText(prepareCompactContext(request('Invoke <code>clone</code> on <code>Arc</code>.')).semantic.fixed,
      '⟦0⟧调用⟦/0⟧⟪P1⟫⟦1⟧作用于⟦/1⟧⟪P0⟫⟪P2⟫')).toThrow();
  });
});

describe("frozen v28 research requests", () => {
  const corpus = JSON.parse(readFileSync("eval/mt-quality/external/compact-context-v28.json", "utf8"));
  const sha = (text: string) => createHash("sha256").update(text).digest("hex");
  it.each(corpus.cases as Array<{id: string; html: string; context_url: string; expected_scope_prompt_sha256: string; expected_max_tokens: number; expected_grammar_sha256: string}>)
  ("retains the pre-generation prompt, grammar and budget for $id", c => {
    const p = prepareSourceDiagnostic(c);
    try {
      const f = prepareCompactContext(p.request, p.segment.opaque);
      expect(f.eligible).toBe(true);
      expect(sha(f.prompts["scope-map"])).toBe(c.expected_scope_prompt_sha256);
      expect(f.semantic.maxTokens).toBe(c.expected_max_tokens);
      expect(sha(f.semantic.grammar)).toBe(c.expected_grammar_sha256);
      expect(f.prompts.baseline).toBe(p.calls[0]!.messages[0]!.content);
      expect(new TextEncoder().encode(f.prompts["scope-map"]).length).toBe(Math.max(...Object.values(f.attempted).map(v => new TextEncoder().encode(v).length)));
    } finally {p.scope.remove();}
  });
});
