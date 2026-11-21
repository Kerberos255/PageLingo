import { afterEach, describe, expect, it, vi } from "vitest";
import {
  compactLinkTransportForLlm,
  expandLinkTransportFromLlm,
  resetThinkingModeCache,
  translateBatchWithExternalEngine,
  translateWithExternalEngine,
  validateTranslatedHtml,
} from "../src/providers/external-translation";
import { ExternalTranslationCache, externalTranslationCacheKey } from "../src/providers/external-translation-cache";
import { RuntimeMessageProvider } from "../src/providers/runtime-message-provider";
import type { TranslationEngineConfig } from "../src/shared/translation-engine-settings";

function makeConfig(overrides: Partial<TranslationEngineConfig> = {}): TranslationEngineConfig {
  return {
    id: "engine-test",
    name: "Test Engine",
    type: "opencode-go",
    enabled: true,
    baseUrl: "https://opencode.ai/zen/go/v1",
    apiKey: "test-key",
    model: "deepseek-v4.1-flash",
    region: "",
    prompt: "",
    headersJson: "",
    bodyJson: "",
    responsePath: "",
    disableThinking: true,
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  resetThinkingModeCache();
});

describe("external translation batching and LLM optimizations", () => {
  it("batches multiple HTML segments into one OpenCode Go request with static system prompt and compact link transport", async () => {
    const linkHtml = 'Read <a data-flt-link-id="0" href="https://pagelingo.invalid/__link/0"><code>__FLT_LINK_START_0__</code>OpenClaw docs<code>__FLT_LINK_END_0__</code></a> with <code>__FLT_OPAQUE_0__</code>.';
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(String(url)).toBe("https://opencode.ai/zen/go/v1/chat/completions");
      const headers = init?.headers as Record<string, string>;
      expect(headers["x-opencode-session"]).toBe("pagelingo");
      const body = JSON.parse(String(init?.body)) as {
        model: string;
        reasoning_effort?: string;
        messages: Array<{ role: string; content: string }>;
      };
      expect(body.reasoning_effort).toBe("none");
      // System prompt stays static (no dynamic terminology injected into system) for Prompt Cache affinity.
      expect(body.messages[0]?.role).toBe("system");
      expect(body.messages[0]?.content).not.toContain("OpenClaw");
      // User message carries terminology + compacted <a id="0"> link + numbered segments.
      expect(body.messages[1]?.content).toContain("KEEP EXACTLY, character-for-character: OpenClaw");
      expect(body.messages[1]?.content).toContain('<a id="0">OpenClaw docs</a>');
      expect(body.messages[1]?.content).not.toContain("pagelingo.invalid/__link");
      expect(body.messages[1]?.content).toContain("[[SEG_0]]");
      expect(body.messages[1]?.content).toContain("[[SEG_1]]");

      return new Response(JSON.stringify({
        choices: [{
          message: {
            content: [
              "[[SEG_0]]",
              "快速开始",
              "[[/SEG_0]]",
              "[[SEG_1]]",
              '使用 <code>__FLT_OPAQUE_0__</code> 阅读 <a id="0">OpenClaw 文档</a>。',
              "[[/SEG_1]]",
            ].join("\n"),
          },
        }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    const results = await translateBatchWithExternalEngine(makeConfig(), [
      { html: "Getting started", sourceLanguage: "en", targetLanguage: "zh-Hans" },
      {
        html: linkHtml,
        sourceLanguage: "en",
        targetLanguage: "zh-Hans",
        terminology: [{ source: "OpenClaw", target: "OpenClaw", mode: "protect" }],
      },
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(results[0]).toBe("快速开始");
    expect(results[1]).toBe(
      '使用 <code>__FLT_OPAQUE_0__</code> 阅读 <a data-flt-link-id="0" href="https://pagelingo.invalid/__link/0"><code>__FLT_LINK_START_0__</code>OpenClaw 文档<code>__FLT_LINK_END_0__</code></a>。',
    );
  });

  it("recovers only failed segments individually when one item in an LLM batch has invalid HTML", async () => {
    let callCount = 0;
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      callCount += 1;
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> };
      if (callCount === 1) {
        // Segment 0 and 2 are valid, segment 1 illegally turns <strong> into <em>.
        return new Response(JSON.stringify({
          choices: [{
            message: {
              content: "[[SEG_0]]\n第一段\n[[/SEG_0]]\n[[SEG_1]]\n<em>错误标签</em>\n[[/SEG_1]]\n[[SEG_2]]\n第三段\n[[/SEG_2]]",
            },
          }],
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      expect(body.messages[1]?.content).toBe("<strong>Bold</strong>");
      return new Response(JSON.stringify({
        choices: [{ message: { content: "<strong>加粗</strong>" } }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    const results = await translateBatchWithExternalEngine(makeConfig(), [
      { html: "First", sourceLanguage: "en", targetLanguage: "zh-Hans" },
      { html: "<strong>Bold</strong>", sourceLanguage: "en", targetLanguage: "zh-Hans" },
      { html: "Third", sourceLanguage: "en", targetLanguage: "zh-Hans" },
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(results).toEqual(["第一段", "<strong>加粗</strong>", "第三段"]);
  });

  it("downgrades reasoning_effort on HTTP 400 rejection and caches the accepted mode", async () => {
    const seenEfforts: Array<string | undefined> = [];
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { reasoning_effort?: string };
      seenEfforts.push(body.reasoning_effort);
      if (body.reasoning_effort === "none") {
        return new Response(JSON.stringify({
          error: { message: "Invalid reasoning_effort value 'none'; expected low, medium, or high." },
        }), { status: 400, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({
        choices: [{ message: { content: "你好" } }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    const cfg = makeConfig();
    await expect(translateWithExternalEngine(cfg, { html: "Hello", sourceLanguage: "en", targetLanguage: "zh-Hans" }))
      .resolves.toBe("你好");
    await expect(translateWithExternalEngine(cfg, { html: "Hi", sourceLanguage: "en", targetLanguage: "zh-Hans" }))
      .resolves.toBe("你好");

    expect(seenEfforts).toEqual(["none", "low", "low"]);
  });

  it("uses native batch array requests for Google, Microsoft, and DeepL", async () => {
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const target = String(url);
      const body = JSON.parse(String(init?.body));
      if (target.includes("translation.googleapis.com")) {
        expect(body.q).toEqual(["One", "Two"]);
        return new Response(JSON.stringify({
          data: { translations: [{ translatedText: "一" }, { translatedText: "二" }] },
        }), { status: 200 });
      }
      if (target.includes("microsofttranslator.com")) {
        expect(body).toEqual([{ Text: "One" }, { Text: "Two" }]);
        return new Response(JSON.stringify([
          { translations: [{ text: "一" }] },
          { translations: [{ text: "二" }] },
        ]), { status: 200 });
      }
      expect(body.text).toEqual(["One", "Two"]);
      return new Response(JSON.stringify({
        translations: [{ text: "一" }, { text: "二" }],
      }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const batch = [
      { html: "One", sourceLanguage: "en", targetLanguage: "zh-Hans" },
      { html: "Two", sourceLanguage: "en", targetLanguage: "zh-Hans" },
    ];
    expect(await translateBatchWithExternalEngine(makeConfig({ type: "google", baseUrl: "" }), batch)).toEqual(["一", "二"]);
    expect(await translateBatchWithExternalEngine(makeConfig({ type: "microsoft", baseUrl: "" }), batch)).toEqual(["一", "二"]);
    expect(await translateBatchWithExternalEngine(makeConfig({ type: "deepl", baseUrl: "" }), batch)).toEqual(["一", "二"]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("compacts and expands PageLingo sentinel links accurately even when reordered", () => {
    const source = 'Compare <a data-flt-link-id="0" href="https://pagelingo.invalid/__link/0"><code>__FLT_LINK_START_0__</code>Alpha<code>__FLT_LINK_END_0__</code></a> and <a data-flt-link-id="1" href="https://pagelingo.invalid/__link/1"><code>__FLT_LINK_START_1__</code>Beta<code>__FLT_LINK_END_1__</code></a>.';
    const compacted = compactLinkTransportForLlm(source);
    expect(compacted.html).toBe('Compare <a id="0">Alpha</a> and <a id="1">Beta</a>.');
    expect(compacted.compactedIds).toEqual(["0", "1"]);

    const reordered = '对比 <a id="1">贝塔</a> 和 <a id="0">阿尔法</a>。';
    const expanded = expandLinkTransportFromLlm(reordered, compacted.compactedIds);
    expect(validateTranslatedHtml(source, expanded)).toContain('data-flt-link-id="1"');
    expect(expanded).toContain('<code>__FLT_LINK_START_1__</code>贝塔<code>__FLT_LINK_END_1__</code>');
    expect(expanded).toContain('<code>__FLT_LINK_START_0__</code>阿尔法<code>__FLT_LINK_END_0__</code>');
  });

  it("allows balanced inline tag reordering while still rejecting altered or unbalanced tags", () => {
    expect(validateTranslatedHtml(
      "<strong>First</strong> and <em>second</em>",
      "<em>第二</em> 与 <strong>第一</strong>",
    )).toBe("<em>第二</em> 与 <strong>第一</strong>");

    expect(() => validateTranslatedHtml(
      "<strong>First</strong> and <em>second</em>",
      "<strong><em>交叉</strong></em>",
    )).toThrow(/HTML 结构/);
  });
});

describe("ExternalTranslationCache", () => {
  it("isolates cache entries by engine model, prompt, thinking mode, and terminology", async () => {
    const cache = new ExternalTranslationCache({ durable: false });
    const baseCfg = makeConfig();
    const otherModelCfg = makeConfig({ model: "qwen3.8-flash" });

    const k1 = externalTranslationCacheKey(baseCfg, "en", "zh-Hans", "Overview");
    const k2 = externalTranslationCacheKey(otherModelCfg, "en", "zh-Hans", "Overview");
    cache.set(k1, "概览");
    cache.set(k2, "总览");

    expect(await cache.get(k1)).toBe("概览");
    expect(await cache.get(k2)).toBe("总览");
  });

  it("tracks and clears in-flight deduplication promises", async () => {
    const cache = new ExternalTranslationCache({ durable: false });
    let resolve!: (value: string) => void;
    const p = new Promise<string>((r) => { resolve = r; });
    cache.trackInFlight("k", p);
    expect(cache.getInFlight("k")).toBe(p);
    resolve("完成");
    await p;
    await Promise.resolve();
    expect(cache.getInFlight("k")).toBeUndefined();
  });
});

describe("RuntimeMessageProvider execution profile chunking", () => {
  it("splits large batches by character budget and dispatches chunks concurrently", async () => {
    let activeBatches = 0;
    let peakActiveBatches = 0;
    const batchSizes: number[] = [];

    const sendMessage = vi.fn(async (message: any) => {
      if (message.type === "get-translation-engines") {
        return {
          ok: true,
          state: {
            structuralSplittingSafe: false,
            executionProfile: {
              isExternal: true,
              isLlm: true,
              supportsBatch: true,
              supportsPromptTerminology: true,
              recommendedConcurrency: 24,
              batchMaxItems: 2,
              batchMaxChars: 200,
              batchConcurrency: 3,
            },
          },
        };
      }
      if (message.type === "translate-html-batch") {
        batchSizes.push(message.requests.length);
        activeBatches += 1;
        peakActiveBatches = Math.max(peakActiveBatches, activeBatches);
        await new Promise((resolve) => setTimeout(resolve, 15));
        activeBatches -= 1;
        return { ok: true, htmls: message.requests.map((r: any) => `译:${r.html}`) };
      }
      throw new Error(`Unexpected message: ${message.type}`);
    });
    vi.stubGlobal("browser", { runtime: { sendMessage } });

    const provider = new RuntimeMessageProvider();
    const profile = await provider.getExecutionProfile();
    expect(profile.recommendedConcurrency).toBe(24);
    expect(await provider.supportsPromptTerminology()).toBe(true);

    const results = await Promise.all([
      provider.translateHtml({ html: "A1", sourceLanguage: "en", targetLanguage: "zh-Hans" }),
      provider.translateHtml({ html: "A2", sourceLanguage: "en", targetLanguage: "zh-Hans" }),
      provider.translateHtml({ html: "B1", sourceLanguage: "en", targetLanguage: "zh-Hans" }),
      provider.translateHtml({ html: "B2", sourceLanguage: "en", targetLanguage: "zh-Hans" }),
      provider.translateHtml({ html: "C1", sourceLanguage: "en", targetLanguage: "zh-Hans" }),
      provider.translateHtml({ html: "C2", sourceLanguage: "en", targetLanguage: "zh-Hans" }),
    ]);

    expect(results).toEqual(["译:A1", "译:A2", "译:B1", "译:B2", "译:C1", "译:C2"]);
    expect(batchSizes).toEqual([2, 2, 2]);
    expect(peakActiveBatches).toBeGreaterThanOrEqual(2);
  });
});
