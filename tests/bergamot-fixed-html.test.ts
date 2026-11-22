import {afterEach, describe, expect, it} from "vitest";
import type {TranslationRequest} from "../src/core/provider";
import {PageTranslator} from "../src/core/page-translator";
import {restoreTerminologyHtml} from "../src/core/rich-segment";
import {restoreFixedHtmlTransport} from "../src/core/fixed-html-transport";
import {prepareBergamotFixedHtml, repairBergamotFixedHtml} from "../src/providers/bergamot/fixed-html";
import {prepareBergamotFixedRetry, prepareBergamotSlotFallback, restoreBergamotSentenceLines} from "../src/providers/bergamot/fixed-retry";

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

  it("protects multi-brand phrases like 'Claude and GPT models' via opaque code markers without transliteration or duplication", () => {
    const source = slot(0, `${term(0, "Claude")} and ${term(1, "GPT")} models`);
    const prepared = prepareBergamotFixedHtml(source);
    expect(prepared).toBe(slot(0, '<code data-flt-term-id="0">Claude</code> and <code data-flt-term-id="1">GPT</code> models'));
    // Real Bergamot outputs empty <code> placeholders at the exact target word-order positions.
    const bergamotOutput = slot(0, '<code data-flt-term-id="0"></code> 和 <code data-flt-term-id="1"></code> 模型');
    const repaired = repairBergamotFixedHtml(source, bergamotOutput, true);
    expect(restoreTerminologyHtml(document, repaired, ["Claude", "GPT"])).toBe(slot(0, "Claude 和 GPT 模型"));
  });

  it("also protects plain/OCR phrases without data-flt-text-id wrappers via opaque code markers", () => {
    const source = `${term(0, "Claude")} and ${term(1, "GPT")} models`;
    const prepared = prepareBergamotFixedHtml(source);
    expect(prepared).toBe('<code data-flt-term-id="0">Claude</code> and <code data-flt-term-id="1">GPT</code> models');
    const repaired = repairBergamotFixedHtml(source, '<code data-flt-term-id="0"></code> 和 <code data-flt-term-id="1"></code> 模型', true);
    expect(restoreTerminologyHtml(document, repaired, ["Claude", "GPT"])).toBe("Claude 和 GPT 模型");
  });

  it("retries misaligned empty multi-term spans that would otherwise produce 'ClaudeGPT克劳德和GPT模型'", () => {
    const source = slot(0, `${term(0, "Claude")} and ${term(1, "GPT")} models`);
    const duplicated = slot(0, `${term(0, "")}${term(1, "")}克劳德和GPT模型`);
    const retry = prepareBergamotFixedRetry(source, duplicated)!;
    expect(retry).toBeDefined();
    expect(retry.html).toBe(slot(0, '<code data-flt-term-id="0">Claude</code> and <code data-flt-term-id="1">GPT</code> models'));
    const recovered = retry.restore(slot(0, '<code data-flt-term-id="0"></code> 和 <code data-flt-term-id="1"></code> 模型'))!;
    expect(restoreTerminologyHtml(document, recovered, ["Claude", "GPT"])).toBe(slot(0, "Claude 和 GPT 模型"));
  });

  it("deduplicates adjacent and stacked empty term markers when exact brands already appear in the same scope", () => {
    const adjacent = `${term(0, "Claude")}和${term(1, "")}GPT模型`;
    expect(restoreTerminologyHtml(document, adjacent, ["Claude", "GPT"])).toBe("Claude和GPT模型");

    const stacked = `${term(0, "")}${term(1, "")}Claude 和 GPT 模型`;
    expect(restoreTerminologyHtml(document, stacked, ["Claude", "GPT"])).toBe("Claude 和 GPT 模型");

    const repeated = `${term(0, "")} 和 ${term(1, "")}OpenClaw`;
    expect(restoreTerminologyHtml(document, repeated, ["OpenClaw", "OpenClaw"])).toBe("OpenClaw 和 OpenClaw");
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
  it("recovers prose absorbed into a protected name in a standalone heading", () => {
    const name = term(0, "Antigravity");
    const opaque = '<code data-flt-term-id="0"></code>';
    const source = slot(0, `Welcome to ${name}`);
    const swallowed = slot(0, term(0, "欢迎来到反重力"));
    const retry = prepareBergamotFixedRetry(source, swallowed)!;

    expect(retry.html).toBe(slot(0, 'Welcome to <code data-flt-term-id="0">Antigravity</code>'));
    expect(retry.fallback).toBe(source);
    expect(retry.restore(slot(0, `欢迎${opaque}`))).toBe(slot(0, `欢迎${name}`));
    expect(retry.restore(slot(0, '欢迎<code data-flt-term-id="1"></code>'))).toBeUndefined();
    expect(retry.restore(slot(0, opaque))).toBeUndefined();
    expect(prepareBergamotFixedRetry(slot(0, name), swallowed)).toBeUndefined();
    expect(prepareBergamotFixedRetry(source, slot(0, `欢迎${name}`))).toBeUndefined();
  });

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

  it("falls back to safe per-slot translation when Bergamot collapses multi-slot dialogue or drops closing brackets", () => {
    // 1. Multi-slot dialogue where Bergamot leaves middle narrator slot empty
    const dialogueSource =
      `<i>${slot(0, "“So, Victor, what sex did you want the child to be?”")}</i>` +
      slot(1, " the doctor asks, ") +
      `<i>${slot(2, "“Given that grin, I bet you even have a name picked out.”")}</i>`;
    const dialogueBroken =
      `<i>${slot(0, "那么，维克多，你希望孩子是什么性别？")}</i>` +
      slot(1, "") +
      `<i>${slot(2, "医生问道：“看那笑容，我猜你连名字都选好了。”")}</i>`;

    const plan = prepareBergamotSlotFallback(
      dialogueSource,
      dialogueBroken,
      prepareBergamotFixedHtml,
      repairBergamotFixedHtml,
    )!;
    expect(plan).toBeDefined();
    expect(plan.slotPrepared).toHaveLength(3);
    const recoveredDialogue = plan.restore([
      slot(0, "“那么，维克多，你希望孩子是什么性别？”"),
      slot(0, "医生问道，"),
      slot(0, "“看那笑容，我猜你连名字都选好了。”"),
    ])!;
    expect(recoveredDialogue).toBeDefined();
    expect(restoreFixedHtmlTransport(dialogueSource, recoveredDialogue)).toBe(
      `<i>${slot(0, "“那么，维克多，你希望孩子是什么性别？”")}</i>` +
      slot(1, " 医生问道， ") +
      `<i>${slot(2, "“看那笑容，我猜你连名字都选好了。”")}</i>`,
    );

    // 2. Multi-sentence parenthetical where Bergamot drops the closing parenthesis
    const parenSource = `<i>${slot(0, "(This choice will affect your character. Ultimately, the choice remains with you.)")}</i>`;
    const parenBroken = `<i>${slot(0, "(这一选择将影响你的角色。最终，选择权仍在你手中。")}</i>`;
    const parenPlan = prepareBergamotSlotFallback(
      parenSource,
      parenBroken,
      prepareBergamotFixedHtml,
      repairBergamotFixedHtml,
    )!;
    expect(parenPlan).toBeDefined();
    // Enclosing parentheses are peeled before calling Bergamot and restored afterward
    expect(parenPlan.slotPrepared[0]).toBe(
      slot(0, "This choice will affect your character. Ultimately, the choice remains with you."),
    );
    const recoveredParen = parenPlan.restore([
      slot(0, "这一选择将影响你的角色。最终，选择权仍在你手中。"),
    ])!;
    expect(restoreFixedHtmlTransport(parenSource, recoveredParen)).toBe(
      `<i>${slot(0, "(这一选择将影响你的角色。最终，选择权仍在你手中。)")}</i>`,
    );

    // 3. Split parenthesis across fixed atom + bold + prose
    const splitParenSource =
      `<span data-flt-fixed="true">(</span><b>${slot(0, "Your character has been equipped!")}</b>` +
      slot(1, " As a result, your stats will fluctuate.)");
    const splitParenBroken =
      `<span data-flt-fixed="true"></span><b>${slot(0, "(你的角色已装备！)")}</b>` +
      slot(1, "因此，你的属性会波动。");
    const splitPlan = prepareBergamotSlotFallback(
      splitParenSource,
      splitParenBroken,
      prepareBergamotFixedHtml,
      repairBergamotFixedHtml,
    )!;
    expect(splitPlan).toBeDefined();
    // Unmatched trailing ')' on slot 1 is peeled and preserved
    expect(splitPlan.slotPrepared[1]).toBe(slot(0, "As a result, your stats will fluctuate."));
    const recoveredSplit = splitPlan.restore([
      slot(0, "你的角色已装备！"),
      slot(0, "因此，你的属性会波动。"),
    ])!;
    expect(restoreFixedHtmlTransport(splitParenSource, recoveredSplit)).toBe(
      `<span data-flt-fixed="true">(</span><b>${slot(0, "你的角色已装备！")}</b>` +
      slot(1, " 因此，你的属性会波动。)"),
    );
  });

  it("recovers Bergamot slot fallback when Bergamot spills trailing newline/punctuation outside the slot or omits an optional English article", () => {
    // 1. Plain slot with trailing newline/punctuation moved outside </span>
    const source =
      slot(0, "The core issue is isolated to ") +
      `<code>foo()</code>` +
      slot(1, " inside the ") +
      `<code>bar()</code>` +
      slot(2, " helper.\n");
    const brokenWhole =
      slot(0, "核心问题仅限于") +
      `<code>foo()</code>` +
      slot(1, "") +
      `<code>bar()</code>` +
      slot(2, "辅助函数。");

    const plan = prepareBergamotSlotFallback(
      source,
      brokenWhole,
      prepareBergamotFixedHtml,
      repairBergamotFixedHtml,
    )!;
    expect(plan).toBeDefined();
    expect(plan.slotPrepared).toHaveLength(3);

    // Slot 2 simulates Bergamot spilling "。\n" outside the closing </span>.
    const recovered = plan.restore([
      slot(0, "核心问题仅限于"),
      slot(0, "在其中"),
      `${slot(0, "辅助函数")}。\n`,
    ]);
    expect(recovered).toBeDefined();
    const restored = restoreFixedHtmlTransport(source, recovered!);
    expect(restored).toContain(slot(0, "核心问题仅限于 "));
    expect(restored).toContain("<code>foo()</code>");
    expect(restored).toContain(slot(2, " 辅助函数。\n"));

    // 2. Standalone optional English article ("the") translated as empty slot
    const articleSource =
      slot(0, "Check ") +
      `<code>foo</code>` +
      slot(1, " the ") +
      `<code>bar</code>` +
      slot(2, " config.");
    const articleBroken =
      slot(0, "检查") +
      `<code>foo</code>` +
      slot(1, "") +
      `<code>bar</code>` +
      slot(2, "");
    const articlePlan = prepareBergamotSlotFallback(
      articleSource,
      articleBroken,
      prepareBergamotFixedHtml,
      repairBergamotFixedHtml,
    )!;
    expect(articlePlan).toBeDefined();
    const articleRecovered = articlePlan.restore([
      slot(0, "检查"),
      slot(0, ""),
      slot(0, "配置。"),
    ]);
    expect(articleRecovered).toBe(
      slot(0, "检查 ") +
      `<code>foo</code>` +
      slot(1, " ") +
      `<code>bar</code>` +
      slot(2, " 配置。"),
    );
    expect(restoreFixedHtmlTransport(articleSource, articleRecovered!)).toContain("<code>foo</code>");

    const anchor = (linkId: number, slotId: number, label: string) =>
      `<a data-flt-link-id="${linkId}" href="https://pagelingo.invalid/__link/${linkId}"><code>__FLT_LINK_START_${linkId}__</code>${slot(slotId, label)}<code>__FLT_LINK_END_${linkId}__</code></a>`;

    // 3. Cross-slot unmatched trailing '(' (e.g. "... without a working auth path (<a>architecture</a>, <a>network model</a>).")
    const trailingOpenSource =
      slot(0, "The Gateway owns the ") +
      anchor(0, 1, "control-plane API") +
      slot(2, ". It refuses non-loopback binds without a working auth path (") +
      anchor(1, 3, "architecture") +
      `<span data-flt-fixed="true">, </span>` +
      anchor(2, 4, "network model") +
      `<span data-flt-fixed="true">).</span>`;
    const trailingOpenBroken =
      slot(0, "网关拥有") +
      anchor(0, 1, "控制平面 API") +
      slot(2, "。它拒绝没有有效身份验证路径的非环回绑定。") +
      anchor(1, 3, "架构") +
      `<span data-flt-fixed="true">, </span>` +
      anchor(2, 4, "网络模型") +
      `<span data-flt-fixed="true">).</span>`;
    const trailingOpenPlan = prepareBergamotSlotFallback(
      trailingOpenSource,
      trailingOpenBroken,
      prepareBergamotFixedHtml,
      repairBergamotFixedHtml,
    )!;
    expect(trailingOpenPlan).toBeDefined();
    expect(trailingOpenPlan.slotPrepared[2]).toBe(
      slot(0, ". It refuses non-loopback binds without a working auth path"),
    );
    const trailingOpenRecovered = trailingOpenPlan.restore([
      slot(0, "网关拥有"),
      slot(0, "控制平面 API"),
      slot(0, "。它拒绝没有有效身份验证路径的非环回绑定"),
      slot(0, "架构"),
      slot(0, "网络模型"),
    ])!;
    expect(trailingOpenRecovered).toBeDefined();
    expect(restoreFixedHtmlTransport(trailingOpenSource, trailingOpenRecovered)).toContain(
      "非环回绑定 (",
    );

    // 4. Mid-slot unmatched '(' and leading ')' followed by optional English article
    const midOpenSource =
      slot(0, "Container images default to an exposed bind (pair with auth - see the ") +
      anchor(0, 1, "exposure runbook") +
      slot(2, "). The ") +
      anchor(1, 3, "plugin") +
      slot(4, " handles it.");
    const midOpenBroken =
      slot(0, "容器镜像默认暴露绑定（与认证配对）——参见") +
      anchor(0, 1, "曝光手册") +
      slot(2, ")。") +
      anchor(1, 3, "插件") +
      slot(4, "处理它。");
    const midOpenPlan = prepareBergamotSlotFallback(
      midOpenSource,
      midOpenBroken,
      prepareBergamotFixedHtml,
      repairBergamotFixedHtml,
    )!;
    expect(midOpenPlan).toBeDefined();
    // Slot 0 splits into 2 balanced pieces around the unmatched '(', so total units = 6.
    expect(midOpenPlan.slotPrepared).toEqual([
      slot(0, "Container images default to an exposed bind"),
      slot(0, "pair with auth - see the"),
      slot(0, "exposure runbook"),
      slot(0, "The"),
      slot(0, "plugin"),
      slot(0, "handles it."),
    ]);
    const midOpenRecovered = midOpenPlan.restore([
      slot(0, "容器镜像默认暴露绑定"),
      slot(0, "与认证配对——参见"),
      slot(0, "曝光手册"),
      slot(0, ""),
      slot(0, "插件"),
      slot(0, "处理它。"),
    ])!;
    expect(midOpenRecovered).toBeDefined();
    const midOpenRestored = restoreFixedHtmlTransport(midOpenSource, midOpenRecovered);
    expect(midOpenRestored).toContain("容器镜像默认暴露绑定 (与认证配对——参见 ");
    expect(midOpenRestored).toContain("). ");
  });
});

