import {afterEach, describe, expect, it} from "vitest";
import {decodeFixedMtText, encodeFixedMtText} from "../src/providers/pagelingo-mt/fixed-text";
import {inferMtHtml} from "../src/providers/pagelingo-mt/inference";
import {PageTranslator} from "../src/core/page-translator";
import type {TranslationRequest} from "../src/core/provider";
import {assertMtOutputSafety} from "../src/providers/pagelingo-mt/output-safety";
import actual from "./fixtures/mt-output-safety-v25.json";

afterEach(() => document.body.replaceChildren());

describe("MT protocol echoes and misplaced passages", () => {
  it.each(actual.cases)("rejects actual $id before any detached source mutation", async sample => {
    const encoded = encodeFixedMtText(sample.html), before = encoded.body.innerHTML;
    expect(() => decodeFixedMtText(encoded, sample.text)).toThrow(sample.expected_rejection);
    expect(encoded.body.innerHTML).toBe(before);
    const result = await inferMtHtml({html: sample.html, sourceLanguage: "en", targetLanguage: "zh-Hans"},
      async () => ({choices: [{finish_reason: sample.finish_reason, message: {content: sample.text}}]}));
    expect(result.accepted).toBe(false);
    expect(result.html).toBe(sample.html);
  });

  it("retains original DOM, link listeners, emphasis and code when a passage is rejected", async () => {
    const sample = actual.cases[0]!;
    document.body.innerHTML = sample.original_html;
    const root = document.body.firstElementChild as HTMLElement, before = root.outerHTML;
    const nodes = [root, ...root.querySelectorAll("*")].map(node => ({node, children: [...node.childNodes]}));
    const link = root.querySelector("a")!; let clicks = 0;
    link.addEventListener("click", event => {event.preventDefault(); clicks++;});
    const translator = new PageTranslator(document, {prefersWholeSentenceHtml: async () => true, translateHtml: async (request: TranslationRequest) => {
      const result = await inferMtHtml(request, async () => ({choices: [{finish_reason: "stop", message: {content: sample.text}}]}));
      if (!result.accepted) throw new Error(result.reason);
      return result.html;
    }}, {sourceLanguage: "en", targetLanguage: "zh-Hans", displayMode: "translation"});
    await translator.translateAll(root);
    expect(translator.translatedCount).toBe(0);
    expect(translator.failedCount).toBe(1);
    expect(root.outerHTML).toBe(before);
    for (const {node, children} of nodes) expect([...node.childNodes]).toEqual(children);
    link.dispatchEvent(new MouseEvent("click", {cancelable: true})); expect(clicks).toBe(1);
    translator.restore(); expect(root.outerHTML).toBe(before);
  });

  it("rejects protocol echoes on a different source and across text slots", () => {
    const encoded = encodeFixedMtText('Check <code>pending()</code> before retrying.');
    expect(() => decodeFixedMtText(encoded, '⟦0⟧每个编号对是固定文本节点。⟦/0⟧⟪P0⟫⟦1⟧只输出带标记的译文，不要添加解释。⟦/1⟧'))
      .toThrow(/protocol instructions/);
  });

  it("permits real documentation translating the protocol itself", () => {
    const source = "Each numbered pair is a fixed text node. Copy protected tokens and output only the translation.";
    expect(decodeFixedMtText(encodeFixedMtText(source), '⟦0⟧每个编号对是固定文本节点。复制受保护的标记，只输出译文。⟦/0⟧'))
      .toContain("每个编号对");
    expect(decodeFixedMtText(encodeFixedMtText("Hard constraints: Translate the following text."),
      '⟦0⟧【约束要求】将以下文本翻译为简体中文。⟦/0⟧')).toContain("约束要求");
  });

  it("permits ordinary instructions, constraints, fixed labels and protected tokens in prose", () => {
    for (const [source, target] of [
      ["Do not add markup to this field.", "不要添加 HTML 标签。"],
      ["Copy protected tokens into the next request.", "将受保护的标记复制到下一个请求。"],
      ["Check the constraints before translating.", "翻译之前检查约束要求。"],
      ["Output only the translation.", "只输出译文。"],
    ] as const) expect(decodeFixedMtText(encodeFixedMtText(source), `⟦0⟧${target}⟦/0⟧`)).toBe(target);
  });

  it("catches a short connective swallowing the same two-sentence passage as another slot", () => {
    const paragraph = "该操作创建一个事务并获取数据库锁。只有事务提交后，其他客户端才能看到完整的更新结果。";
    expect(() => assertMtOutputSafety([{source: "belongs to"}, {source: "This operation opens a transaction and acquires the database lock. Other clients can only see the complete updates after the transaction commits."}], [paragraph, paragraph]))
      .toThrow(/repeated a whole passage/);
  });

  it("allows source repetition, short repeated labels and equivalent long source passages", () => {
    const paragraph = "该操作创建一个事务并获取数据库锁。只有事务提交后，其他客户端才能看到完整的更新结果。";
    const longSource = "The operation starts a transaction and locks the database. Other clients see the full updates only after commit.";
    expect(() => assertMtOutputSafety([{source: longSource}, {source: longSource}], [paragraph, paragraph])).not.toThrow();
    expect(() => assertMtOutputSafety([{source: longSource}, {source: "A transaction is opened and the database is locked by this operation. Updates become visible to other clients after commit."}], [paragraph, paragraph])).not.toThrow();
    expect(() => assertMtOutputSafety([{source: "Warning"}, {source: "Caution"}], ["警告", "警告"])).not.toThrow();
  });
});

describe("standalone obligation ownership", () => {
  it.each(["必须", "务必", "须得", "需要", "应当", "一定要", "不得不", "强制", "must"])("allows an obligation paraphrase: %s", value => {
    const encoded = encodeFixedMtText('Errors <em>must</em> be handled.');
    expect(decodeFixedMtText(encoded, `⟦0⟧错误⟦/0⟧⟦1⟧${value}⟦/1⟧⟦2⟧得到处理。⟦/2⟧`)).toContain(`<em>${value}</em>`);
  });
  it("does not classify a longer label or a proper name as a standalone operator", () => {
    expect(decodeFixedMtText(encodeFixedMtText('Read <a>must-read stories</a>.'), '⟦0⟧阅读⟦/0⟧⟦1⟧推荐故事⟦/1⟧⟪P0⟫')).toContain("推荐故事");
    expect(decodeFixedMtText(encodeFixedMtText('Visit <a>Must</a>.'), '⟦0⟧访问⟦/0⟧⟦1⟧穆斯特⟦/1⟧⟪P0⟫')).toContain("穆斯特");
  });
});
