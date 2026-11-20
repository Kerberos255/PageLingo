import {afterEach, describe, expect, it} from "vitest";
import type {TranslationRequest} from "../src/core/provider";
import {PageTranslator} from "../src/core/page-translator";
import {restoreTerminologyHtml} from "../src/core/rich-segment";
import {restoreFixedHtmlTransport} from "../src/core/fixed-html-transport";
import {prepareBergamotFixedHtml, repairBergamotFixedHtml} from "../src/providers/bergamot/fixed-html";
import {prepareBergamotFixedRetry, restoreBergamotSentenceLines} from "../src/providers/bergamot/fixed-retry";

const slot = (id: number, contents: string) => `<span data-flt-text-id="${id}">${contents}</span>`;
const term = (id: number, contents: string) => `<span data-flt-term-id="${id}">${contents}</span>`;
const label = (title: string, description: string) => `<strong>${slot(0, title)}</strong>${slot(1, description)}`;

afterEach(() => document.body.replaceChildren());

describe("Bergamot fixed HTML", () => {
  it.each([
    [slot(0, `Use ${term(0, "OpenClaw")} from your chat app.`),
      slot(0, `${term(0, "使用聊天应用中的")} OpenClaw。`), "使用聊天应用中的 OpenClaw。"],
    [slot(0, `What is ${term(0, "OpenClaw")}?`),
      slot(0, `${term(0, "")}什么是OpenClaw?`), "什么是OpenClaw?"],
  ])("keeps translated prose when its protected name already occupies the same slot", (source, result, expected) => {
    const repaired = repairBergamotFixedHtml(source, result);
    expect(restoreTerminologyHtml(document, repaired, ["OpenClaw"])).toBe(slot(0, expected));
  });

  it("keeps term separators when the engine splits multiword names across term markers", () => {
    const source = slot(0, `${term(0, "Discord")}, ${term(1, "Google Chat")}, ${term(2, "iMessage")}`);
    const result = slot(0, `${term(0, "")}${term(1, "Discord、Google ")}${term(2, "")}Chat、iMessage`);
    expect(repairBergamotFixedHtml(source, result)).toBe(slot(0, "Discord、Google Chat、iMessage"));
  });

  it.each([
    slot(0, term(0, "微软")),
    slot(0, `${term(0, "")}Microsoft Microsoft`),
    slot(0, term(1, "Microsoft")),
    slot(1, term(0, "Microsoft")),
  ])("retains the existing protection when a name is changed, repeated or moved", result => {
    expect(repairBergamotFixedHtml(slot(0, term(0, "Microsoft")), result)).toBe(result);
  });

  it("returns the model's label to the existing bold node and restores the list exactly", async () => {
    document.body.innerHTML = '<ul><li><strong>Self-hosted</strong>: runs on your hardware, your rules</li></ul>';
    const list = document.querySelector("ul")!, item = list.firstElementChild!, bold = item.firstElementChild!;
    const titleText = bold.firstChild, descriptionText = bold.nextSibling;
    const before = list.outerHTML;
    const provider = {prefersWholeSentenceHtml: async () => true, translateHtml: async (request: TranslationRequest) =>
      repairBergamotFixedHtml(request.html, label("", "自托管:运行在您的硬件和规则上"))};
    const translator = new PageTranslator(document, provider, {sourceLanguage: "en", targetLanguage: "zh-Hans", displayMode: "translation"});

    await translator.translateAll();
    expect(translator.failedCount).toBe(0);
    expect(bold.textContent).toBe("自托管");
    expect(descriptionText?.textContent).toBe(":运行在您的硬件和规则上");
    expect(item.firstElementChild).toBe(bold);
    expect(bold.firstChild).toBe(titleText);
    expect(bold.nextSibling).toBe(descriptionText);
    translator.setDisplayMode("bilingual");
    expect(bold.textContent).toBe("Self-hosted");
    expect(item.querySelector('[data-flt-generated="translation"] strong')?.textContent).toBe("自托管");
    translator.restore();
    expect(list.outerHTML).toBe(before);
  });

  it("keeps a protected license name next to a recovered heading", () => {
    const source = label("Open source", `: ${term(0, "MIT")} licensed, community-driven`);
    const opaque = '<code data-flt-term-id="0">MIT</code>';
    expect(prepareBergamotFixedHtml(source)).toBe(label("Open source", `: ${opaque} licensed, community-driven`));
    const received = label("", '开源:<code data-flt-term-id="0"></code>持牌、社区驱动');
    const repaired = repairBergamotFixedHtml(source, received, true);
    expect(restoreTerminologyHtml(document, repaired, ["MIT"])).toBe(label("开源", ":MIT持牌、社区驱动"));
    const changed = received.replace('data-flt-term-id="0"', 'data-flt-term-id="1"');
    expect(() => repairBergamotFixedHtml(source, changed, true)).toThrow(/缺少受保护术语/u);
  });

  it.each([
    [label("Self-hosted", " runs on your hardware"), label("", "自托管:使用你的硬件")],
    [label("Self-hosted", ": runs on your hardware"), label("", "自托管。你可以使用:硬件")],
    [label("Self-hosted", ": runs on your hardware"), label("自托管", ":使用你的硬件")],
  ])("retains the original validation path outside the clear label shape", (source, result) => {
    expect(repairBergamotFixedHtml(source, result)).toBe(result);
  });
});

describe("Bergamot inline-phrase retry", () => {
  it("restores each sentence to its original sibling span after Bergamot merges independent lines", () => {
    const lines = (first: string, last: string) => `<span>${slot(0, first)}</span><span>${slot(1, last)}</span>`;
    const source = lines("The AI that really does things.", "Any OS. Any Platform. The lobster way. 🦞");
    const initial = lines("", "真正能做事情的人工智能。任何操作系统。任何平台。龙虾的方式。🦞");
    expect(restoreBergamotSentenceLines(source, initial)).toBe(
      lines("真正能做事情的人工智能。", "任何操作系统。任何平台。龙虾的方式。🦞"),
    );
    expect(restoreBergamotSentenceLines(source, initial.replace("任何平台。", ""))).toBeUndefined();
    expect(restoreBergamotSentenceLines(source, initial.replace("🦞", ""))).toBeUndefined();
    expect(restoreBergamotSentenceLines(source, initial.replace('<span><span data-flt-text-id="0">', '<span class="changed"><span data-flt-text-id="0">'))).toBeUndefined();
    expect(restoreBergamotSentenceLines(source.replace("does things.", "does things"), initial)).toBeUndefined();
  });

  it("reassembles swallowed bold phrases around an unchanged code atom", () => {
    const command = "<code>__FLT_OPAQUE_0__</code>";
    const html = (values: string[], code = command) => slot(0, values[0]!) + `<strong>${slot(1, values[1]!)}</strong>`
      + slot(2, values[2]!) + `<strong>${slot(3, values[3]!)}</strong>` + slot(4, values[4]!) + code + slot(5, values[5]!);
    const source = html(["Choose ", "Quick start", " or ", "Custom setup", ". Run ", " to begin."]);
    const initial = html(["", "", "", "", "选择快速开始或自定义设置。", "开始。"], "<code></code>");
    const retry = prepareBergamotFixedRetry(source, initial)!;
    expect(retry.html).toBe(`Choose «Quick start» or «Custom setup». Run ${command} to begin.`);
    expect(retry.restore("选择“快速开始”。运行<code></code>即可开始。")).toBeUndefined();
    expect(retry.restore("选择“快速开始”或“自定义设置”。运行<code>WRONG</code>即可开始。")).toBeUndefined();

    const translated = retry.restore("选择“快速开始”或“自定义设置”。运行<code></code>即可开始。")!;
    expect(restoreFixedHtmlTransport(source, translated)).toBe(
      html(["选择 ", "快速开始", " 或 ", "自定义设置", "。运行 ", " 即可开始。"]),
    );
    expect(prepareBergamotFixedRetry(source, translated)).toBeUndefined();
  });

  it("keeps a link label and every protected name when recovering unbalanced prose", () => {
    const link = (value: string) => '<a data-flt-link-id="0" href="https://pagelingo.invalid/__link/0">'
      + `<code>__FLT_LINK_START_0__</code>${slot(1, value)}<code>__FLT_LINK_END_0__</code></a>`;
    const source = slot(0, `Install dependencies if needed,\nthen proceed. Tools (${term(0, "npm")},\n${term(1, "Docker")}) are listed on the `) + link("Install") + slot(2, " page.");
    const initial = slot(0, "工具（npm、Docker 位于") + link("安装") + slot(2, "页面。");
    const retry = prepareBergamotFixedRetry(source, initial)!;
    expect(retry.html).toBe("Install dependencies if needed,\nthen proceed. Tools (npm, Docker) are listed on the «Install» page.");
    expect(retry.restore("工具（Docker）列于“Install”页面。")).toBeUndefined();
    expect(retry.restore("工具（npm、Docker 列于“Install”页面。")).toBeUndefined();
    expect(retry.restore("工具（Docker、npm）列于“Install”页面。")).toBe(
      slot(0, `工具（${term(1, "Docker")}、${term(0, "npm")}）列于`) + link("安装") + slot(2, "页面。"),
    );
  });
});
