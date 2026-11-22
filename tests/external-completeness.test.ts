import {readFileSync} from "node:fs";
import {afterEach, describe, expect, it, vi} from "vitest";
import {translateWithExternalEngine} from "../src/providers/external-translation";
import {assessTranslationQuality} from "../src/core/translation-quality";
import {PageTranslator} from "../src/core/page-translator";
import type {TranslationRequest} from "../src/core/provider";
import type {TranslationEngineConfig} from "../src/shared/translation-engine-settings";

const engine: TranslationEngineConfig = {
  id: "completeness", name: "Completeness test", type: "openai-compatible", enabled: true,
  baseUrl: "https://example.invalid/v1", apiKey: "fixture-key", model: "fixture-model",
  region: "", prompt: "", headersJson: "", bodyJson: "", responsePath: "",
};
const fixture = JSON.parse(readFileSync("tests/fixtures/opencode-incomplete-agent-clause.json", "utf8"));
const request = {html: "Hello <strong>world</strong>", sourceLanguage: "en", targetLanguage: "zh-Hans"};
const respond = (body: unknown) => vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body))));
afterEach(() => {vi.unstubAllGlobals(); document.body.replaceChildren();});

describe("external generation completeness", () => {
  it.each(["length", "content_filter", "tool_calls", "function_call", null])("refuses %s even when the returned HTML is closed and nonempty", async finish_reason => {
    respond({choices: [{finish_reason, message: {content: "你好 <strong>世界</strong>"}}]});
    await expect(translateWithExternalEngine(engine, request)).rejects.toThrow(/未完整结束/);
  });

  it("refuses an explicit model refusal even if content is also present", async () => {
    respond({choices: [{finish_reason: "stop", message: {refusal: "fixture refusal", content: "你好 <strong>世界</strong>"}}]});
    await expect(translateWithExternalEngine(engine, request)).rejects.toThrow(/拒绝生成/);
  });

  it.each(["MAX_TOKENS", "SAFETY", "RECITATION"])("checks Gemini's %s status before accepting text", async finishReason => {
    respond({candidates: [{finishReason, content: {parts: [{text: "你好 <strong>世界</strong>"}]}}]});
    await expect(translateWithExternalEngine({...engine, type: "gemini"}, request)).rejects.toThrow(/未完整结束/);
  });

  it("accepts normal completion and legacy services without completion metadata", async () => {
    for (const metadata of [{finish_reason: "stop"}, {}]) {
      respond({choices: [{...metadata, message: {content: "你好 <strong>世界</strong>"}}]});
      await expect(translateWithExternalEngine(engine, request)).resolves.toBe("你好 <strong>世界</strong>");
    }
    respond({candidates: [{finishReason: "STOP", content: {parts: [{text: "你好 <strong>世界</strong>"}]}}]});
    await expect(translateWithExternalEngine({...engine, type: "gemini"}, request)).resolves.toBe("你好 <strong>世界</strong>");
  });

  it("rejects the actual recorded LongCat omission after its HTML passes the template contract", async () => {
    respond(fixture.response);
    await expect(translateWithExternalEngine(engine, {...request, html: fixture.source_html})).rejects.toThrow(/句子可能不完整/);
  });

  it("rejects a severe omission while allowing protected code and technical names", async () => {
    const source = "The application requires an active network connection to validate credentials and download the latest configuration before starting the translation service.";
    respond({choices: [{finish_reason: "stop", message: {content: "需要网络。"}}]});
    await expect(translateWithExternalEngine(engine, {...request, html: source})).rejects.toThrow(/内容明显过少/);
    const code = "long_identifier_for_the_protected_library_name";
    respond({choices: [{finish_reason: "stop", message: {content: `<code>${code}</code> 你好`}}]});
    await expect(translateWithExternalEngine(engine, {...request, html: `<code>${code}</code> Hello`})).resolves.toContain(code);
    respond({choices: [{finish_reason: "stop", message: {content: "Shadow DOM 允许将隐藏的 DOM 树附加到常规 DOM 树中的元素上，这个 shadow DOM 树以 shadow root 开始。"}}]});
    await expect(translateWithExternalEngine(engine, {...request, html: "Shadow DOM allows hidden DOM trees to be attached to regular DOM elements. This shadow DOM tree starts with a shadow root."})).resolves.toContain("shadow root");
  });

  it("retains the original nodes and counts no success when a structurally valid response omits a predicate", async () => {
    document.body.innerHTML = '<p id="source">The plugin was provided by <a href="/acme">Acme</a>, and requires two libraries.</p>';
    const root = document.querySelector("p")!, before = root.innerHTML, children = [...root.childNodes], link = root.querySelector("a")!;
    const listener = vi.fn(); link.addEventListener("completeness-probe", listener);
    vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      const html = body.messages[1].content.replace("The plugin was provided by ", "该插件由 ").replace(", and requires two libraries.", "，并且需要两个库。");
      return new Response(JSON.stringify({choices: [{finish_reason: "stop", message: {content: html}}]}));
    }));
    const translator = new PageTranslator(document, {
      prefersWholeSentenceHtml: async () => true,
      translateHtml: (request: TranslationRequest) => translateWithExternalEngine(engine, request),
    }, {displayMode: "translation"});
    await translator.translateAll(document.body);
    expect(translator.translatedCount).toBe(0);
    expect(translator.failedCount).toBe(1);
    expect(translator.firstFailure).toContain("句子可能不完整");
    expect(root.innerHTML).toBe(before);
    expect([...root.childNodes]).toEqual(children);
    expect(root.querySelector("a")).toBe(link);
    link.dispatchEvent(new Event("completeness-probe")); expect(listener).toHaveBeenCalledOnce();
    translator.restore(); expect(root.innerHTML).toBe(before);
    expect(translator.failedCount).toBe(0);
  });
});

describe("conservative predicate omission signal", () => {
  const sourceText = "The plugin was provided by Acme, and requires two libraries.";
  const quality = (translatedText: string, source = sourceText) => assessTranslationQuality({sourceText: source, translatedText, sourceLanguage: "en", targetLanguage: "zh-Hans"});

  it("detects the same grammatical failure on a different name without requiring a reference wording", () => {
    expect(quality("该插件由 Acme，并且需要两个库。").reasons).toContain("incomplete_agent_clause");
    for (const text of ["该插件由 Acme 提供，并且需要两个库。", "Acme 提供了该插件，它需要两个库。", "该插件由 Acme 公司提供，需要两个库。"])
      expect(quality(text).accepted, text).toBe(true);
  });

  it("does not turn an ordinary Latin list into a passive-predicate rule", () => {
    expect(quality("支持 Acme，并且支持 Example。", "Acme and Example are supported.").incompleteAgentClause).toBe(false);
    expect(quality("路径经由 Acme，并且经过 Example。", "The route passes through Acme and Example.").incompleteAgentClause).toBe(false);
  });

  it("allows coordinated names with a shared Chinese predicate", () => {
    expect(quality("本手册由 Alice，并且 Bob 共同编写。", "The manual was written by Alice and Bob.").incompleteAgentClause).toBe(false);
  });

  it("allows proper-noun/brand lists translated to Chinese while rejecting untranslated English prose", async () => {
    const brandListSource =
      '<span data-flt-text-id="0"><span data-flt-term-id="0">Discord</span>, <span data-flt-term-id="1">Feishu</span>, ' +
      '<span data-flt-term-id="2">iMessage</span>, <span data-flt-term-id="3">Matrix</span>, <span data-flt-term-id="4">Microsoft Teams</span>, ' +
      '<span data-flt-term-id="5">Signal</span>, <span data-flt-term-id="6">Slack</span>, <span data-flt-term-id="7">Telegram</span>, ' +
      '<span data-flt-term-id="8">WhatsApp</span>, Zalo, and more.</span>';
    const brandListTranslated =
      '<span data-flt-text-id="0"><span data-flt-term-id="0">Discord</span>、<span data-flt-term-id="1">Feishu</span>、' +
      '<span data-flt-term-id="2">iMessage</span>、<span data-flt-term-id="3">Matrix</span>、<span data-flt-term-id="4">Microsoft Teams</span>、' +
      '<span data-flt-term-id="5">Signal</span>、<span data-flt-term-id="6">Slack</span>、<span data-flt-term-id="7">Telegram</span>、' +
      '<span data-flt-term-id="8">WhatsApp</span>、Zalo 等。</span>';
    respond({choices: [{finish_reason: "stop", message: {content: brandListTranslated}}]});
    await expect(translateWithExternalEngine(engine, {...request, html: brandListSource})).resolves.toContain("Zalo 等。");

    // Unprotected unlisted proper-noun list still passes when non-brand prose is translated.
    expect(quality("Podman、OpenShell、Hermes、Zalo 等。", "Podman, OpenShell, Hermes, Zalo, and more.").accepted).toBe(true);
    // Genuine untranslated English prose is still rejected.
    expect(quality(
      "The gateway owns channel connections and refuses non-loopback binds without auth.",
      "The gateway owns channel connections and refuses non-loopback binds without auth.",
    ).reasons).toContain("target_language_mismatch");
  });

  it("collapses mid-sentence HTML source line wraps in non-preformatted paragraphs while restoring exact source text", async () => {
    document.body.innerHTML = '<p id="wrapped">This installs on Linux and\nWSL2 (with a per-user\nfallback item).</p>';
    const root = document.querySelector("p")!;
    const original = root.textContent!;
    const seenHtml: string[] = [];
    const translator = new PageTranslator(document, {
      prefersWholeSentenceHtml: async () => true,
      translateHtml: async (req: TranslationRequest) => {
        seenHtml.push(req.html);
        return req.html.replace("This installs on Linux and WSL2 (with a per-user fallback item).", "这会安装在 Linux 和 WSL2 上（带每用户回退项）。");
      },
    }, {displayMode: "translation"});

    await translator.translateAll(document.body);
    expect(seenHtml).toEqual(['<span data-flt-text-id="0">This installs on Linux and WSL2 (with a per-user fallback item).</span>']);
    expect(root.textContent).toBe("这会安装在 Linux 和 WSL2 上（带每用户回退项）。");
    translator.restore();
    expect(root.textContent).toBe(original);
  });
});
