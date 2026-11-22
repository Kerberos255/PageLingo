import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  compactLlmTransportHtml,
  expandLlmTransportHtml,
  externalBatchSize,
  parseLlmBatchResponse,
  resetExternalTranslationStateForTests,
  translateExternalBatch,
  translateWithExternalEngine,
} from "../src/providers/external-translation";
import {
  ExternalTranslationCache,
  externalTranslationCacheKey,
} from "../src/providers/external-translation-cache";
import {
  BUILTIN_GOOGLE_ENGINE_ID,
  BUILTIN_MICROSOFT_ENGINE_ID,
  LOCAL_TRANSLATION_ENGINE_ID,
  builtinFreeEngineConfig,
  loadTranslationEngineState,
  setActiveTranslationEngine,
  type RuntimeExternalEngineConfig,
  type TranslationEngineConfig,
} from "../src/shared/translation-engine-settings";
import { PageTranslator } from "../src/core/page-translator";
import type { TranslationRequest } from "../src/core/provider";
import { protectTerminologyHtml, restoreTerminologyHtml } from "../src/core/rich-segment";

function llmConfig(overrides: Partial<TranslationEngineConfig> = {}): TranslationEngineConfig {
  return {
    id: "engine-opencode",
    name: "OpenCode Go",
    type: "opencode-go",
    enabled: true,
    baseUrl: "https://opencode.ai/inference/go/openai/v1",
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

beforeEach(() => {
  resetExternalTranslationStateForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe("built-in free Microsoft (Edge) and Google Translate engines", () => {
  it("loads and switches built-in free engines and falls back gracefully from removed legacy engine IDs", async () => {
    const store: Record<string, unknown> = { activeTranslationEngineId: "pagelingo-mt", translationEngines: [] };
    vi.stubGlobal("browser", {
      storage: {
        local: {
          get: vi.fn(async () => ({ ...store })),
          set: vi.fn(async (values: Record<string, unknown>) => { Object.assign(store, values); }),
        },
      },
    });

    // Legacy pagelingo-mt falls back cleanly to Firefox local engine
    expect((await loadTranslationEngineState()).activeEngineId).toBe(LOCAL_TRANSLATION_ENGINE_ID);

    // Switching to built-in free Microsoft and Google works without user-configured entries
    expect((await setActiveTranslationEngine(BUILTIN_MICROSOFT_ENGINE_ID)).activeEngineId).toBe(BUILTIN_MICROSOFT_ENGINE_ID);
    expect((await loadTranslationEngineState()).activeEngineId).toBe(BUILTIN_MICROSOFT_ENGINE_ID);
    expect((await setActiveTranslationEngine(BUILTIN_GOOGLE_ENGINE_ID)).activeEngineId).toBe(BUILTIN_GOOGLE_ENGINE_ID);
    expect((await loadTranslationEngineState()).activeEngineId).toBe(BUILTIN_GOOGLE_ENGINE_ID);
  });

  it("translates via Edge translatetext with string-array body, template/brand preservation, and 429 retry", async () => {
    let calls = 0;
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      calls += 1;
      const target = String(url);
      expect(target).toContain("https://edge.microsoft.com/translate/translatetext?");
      const parsed = new URL(target);
      expect(parsed.searchParams.get("to")).toBe("zh-Hans");
      expect(parsed.searchParams.get("isEnterpriseClient")).toBe("false");
      const headers = init?.headers as Record<string, string>;
      expect(headers.Authorization).toBeUndefined();
      if (calls === 1) {
        return new Response("Too Many Requests", { status: 429, headers: { "retry-after": "0" } });
      }
      const items = JSON.parse(String(init?.body)) as string[];
      expect(Array.isArray(items)).toBe(true);
      // Whole sentence containing protected terms is sent intact (not fragmented into "and" + "models").
      const map: Record<string, string> = {
        Hello: "你好",
        World: "世界",
        "Claude and GPT models": "Claude 和 GPT 模型",
      };
      return Response.json(items.map((text) => ({
        detectedLanguage: { language: "en", score: 1 },
        translations: [{ text: map[text] ?? text, to: "zh-Hans" }],
      })));
    });
    vi.stubGlobal("fetch", fetchMock);

    const msFree = builtinFreeEngineConfig(BUILTIN_MICROSOFT_ENGINE_ID)!;
    expect(msFree.name).toBe("微软翻译");
    expect(externalBatchSize(msFree)).toBe(20);

    const batch = await translateExternalBatch(msFree, [
      { html: '<span data-flt-text-id="0">Hello</span>', sourceLanguage: "auto", targetLanguage: "zh-Hans" },
      { html: '<span data-flt-text-id="0"><span data-flt-term-id="0">Claude</span> and <span data-flt-term-id="1">GPT</span> models</span>', sourceLanguage: "auto", targetLanguage: "zh-Hans" },
    ]);
    expect(batch).toEqual([
      '<span data-flt-text-id="0">你好</span>',
      '<span data-flt-text-id="0"><span data-flt-term-id="0">Claude</span> 和 <span data-flt-term-id="1">GPT</span> 模型</span>',
    ]);
    expect(restoreTerminologyHtml(document, batch[1]!, ["Claude", "GPT"])).toBe('<span data-flt-text-id="0">Claude 和 GPT 模型</span>');
    expect(calls).toBe(2);

    const single = await translateWithExternalEngine(msFree, {
      html: '<span data-flt-text-id="0">World</span>',
      sourceLanguage: "en",
      targetLanguage: "zh-Hans",
    });
    expect(single).toBe('<span data-flt-text-id="0">世界</span>');
  });

  it("supports native Anthropic Messages API, model discovery, and OpenAI / DashScope defaults", async () => {
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const target = String(url);
      if (target === "https://api.anthropic.com/v1/messages") {
        const headers = init?.headers as Record<string, string>;
        expect(headers["x-api-key"]).toBe("ant-key");
        expect(headers["anthropic-version"]).toBe("2023-06-01");
        const body = JSON.parse(String(init?.body)) as { system: string; messages: Array<{ content: string }> };
        expect(body.system).toContain("[[SEG_N]]");
        expect(body.messages[0]!.content).toContain("[[SEG_0]]");
        return Response.json({
          stop_reason: "end_turn",
          content: [{ type: "text", text: '[[SEG_0]]\n<span data-flt-text-id="0">你好</span>\n[[/SEG_0]]\n[[SEG_1]]\n<span data-flt-text-id="0">世界</span>\n[[/SEG_1]]' }],
        });
      }
      if (target === "https://api.anthropic.com/v1/models") {
        return Response.json({
          data: [{ id: "claude-haiku-4-5", display_name: "Claude Haiku 4.5" }],
        });
      }
      if (target === "https://api.openai.com/v1/chat/completions") {
        return Response.json({ choices: [{ finish_reason: "stop", message: { content: '<span data-flt-text-id="0">你好 GPT</span>' } }] });
      }
      throw new Error(`Unexpected URL: ${target}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const claude = llmConfig({ type: "anthropic", baseUrl: "", apiKey: "ant-key", model: "claude-haiku-4-5" });
    expect(externalBatchSize(claude)).toBe(12);
    const batch = await translateExternalBatch(claude, [
      { html: '<span data-flt-text-id="0">Hello</span>', sourceLanguage: "en", targetLanguage: "zh-Hans" },
      { html: '<span data-flt-text-id="0">World</span>', sourceLanguage: "en", targetLanguage: "zh-Hans" },
    ]);
    expect(batch).toEqual(['<span data-flt-text-id="0">你好</span>', '<span data-flt-text-id="0">世界</span>']);

    const { listExternalTranslationModels } = await import("../src/providers/external-translation");
    const models = await listExternalTranslationModels(claude);
    expect(models).toEqual([{ id: "claude-haiku-4-5", name: "Claude Haiku 4.5", ownedBy: "anthropic" }]);

    const openai = llmConfig({ type: "openai", baseUrl: "", apiKey: "sk-test", model: "gpt-4.1-mini" });
    await expect(translateWithExternalEngine(openai, {
      html: '<span data-flt-text-id="0">Hello GPT</span>',
      sourceLanguage: "en",
      targetLanguage: "zh-Hans",
    })).resolves.toBe('<span data-flt-text-id="0">你好 GPT</span>');
  });

  it("batches Google Free as whole-sentence compact HTML via translate_a/t while preserving slots, links, code, and protected terms", async () => {
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const target = String(url);
      expect(target).toContain("https://translate.googleapis.com/translate_a/t?client=dict-chrome-ex");
      const params = new URLSearchParams(String(init?.body));
      const queries = params.getAll("q");
      expect(queries).toEqual([
        '<span class="notranslate" data-pl-t="0">Claude</span> and <span class="notranslate" data-pl-t="1">GPT</span> models',
        'Use <a data-pl-el="0">the guide</a> with <span class="notranslate" data-pl-a="0">__FLT_OPAQUE_0__</span>',
      ]);
      return Response.json([
        ['<span class="notranslate" data-pl-t="0">Claude</span> 和 <span class="notranslate" data-pl-t="1">GPT</span> 模型', "en"],
        ['使用 <a data-pl-el="0">指南</a> 搭配 <span class="notranslate" data-pl-a="0">__FLT_OPAQUE_0__</span>', "en"],
      ]);
    });
    vi.stubGlobal("fetch", fetchMock);

    const googleFree = builtinFreeEngineConfig(BUILTIN_GOOGLE_ENGINE_ID)!;
    const req1 = {
      html: '<span data-flt-text-id="0"><span data-flt-term-id="0">Claude</span> and <span data-flt-term-id="1">GPT</span> models</span>',
      sourceLanguage: "auto",
      targetLanguage: "zh-Hans",
    };
    const req2 = {
      html: '<span data-flt-text-id="0">Use </span><a data-flt-link-id="0" href="https://pagelingo.invalid/__link/0"><code>__FLT_LINK_START_0__</code><span data-flt-text-id="1">the guide</span><code>__FLT_LINK_END_0__</code></a><span data-flt-text-id="2"> with </span><code>__FLT_OPAQUE_0__</code>',
      sourceLanguage: "auto",
      targetLanguage: "zh-Hans",
    };

    const results = await translateExternalBatch(googleFree, [req1, req2]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(results[0]).toBe('<span data-flt-text-id="0"><span data-flt-term-id="0">Claude</span> 和 <span data-flt-term-id="1">GPT</span> 模型</span>');
    expect(restoreTerminologyHtml(document, results[0]!, ["Claude", "GPT"])).toBe('<span data-flt-text-id="0">Claude 和 GPT 模型</span>');
    expect(results[1]).toContain('<span data-flt-text-id="1">指南</span>');
    expect(results[1]).toContain("<code>__FLT_OPAQUE_0__</code>");
  });

  it("falls back per paragraph to plain-text slots when Google reorders inline tags", async () => {
    let callCount = 0;
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      callCount += 1;
      const target = String(url);
      expect(target).toContain("https://translate.googleapis.com/translate_a/t?client=dict-chrome-ex");
      const params = new URLSearchParams(String(init?.body));
      const queries = params.getAll("q");
      if (callCount === 1) {
        // Simulate Google reordering <a> after <code>.
        return Response.json([
          ['在生产中运行 <span class="notranslate" data-pl-a="0">__FLT_OPAQUE_0__</span> 之前，请阅读 <a data-pl-el="0">安装指南</a>。', "en"],
        ]);
      }
      const map: Record<string, string> = {
        "Read": "阅读",
        "the guide": "指南",
        "before running": "在运行之前",
      };
      return Response.json(queries.map((q) => [map[q] ?? q, "en"]));
    });
    vi.stubGlobal("fetch", fetchMock);

    const googleFree = builtinFreeEngineConfig(BUILTIN_GOOGLE_ENGINE_ID)!;
    const html = await translateWithExternalEngine(googleFree, {
      html: '<span data-flt-text-id="0">Read </span><a data-flt-link-id="0" href="https://pagelingo.invalid/__link/0"><code>__FLT_LINK_START_0__</code><span data-flt-text-id="1">the guide</span><code>__FLT_LINK_END_0__</code></a><span data-flt-text-id="2"> before running </span><code>__FLT_OPAQUE_0__</code>',
      sourceLanguage: "en",
      targetLanguage: "zh-Hans",
    });
    expect(callCount).toBe(2);
    expect(html).toContain('<span data-flt-text-id="1">指南</span>');
    expect(html).toContain("<code>__FLT_OPAQUE_0__</code>");
  });

  it("retries Google Free on HTTP 429 and falls back to translate_a/single when translate_a/t returns unexpected format", async () => {
    let calls = 0;
    const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
      calls += 1;
      const target = String(url);
      if (calls === 1) {
        return new Response("Too Many Requests", { status: 429, headers: { "retry-after": "0" } });
      }
      if (target.includes("/translate_a/t")) {
        return new Response(JSON.stringify({ unexpected: true }), { status: 200 });
      }
      expect(target).toContain("https://translate.googleapis.com/translate_a/single?client=gtx");
      return Response.json([[["你好世界", "Hello world"]]]);
    });
    vi.stubGlobal("fetch", fetchMock);

    const googleFree = builtinFreeEngineConfig(BUILTIN_GOOGLE_ENGINE_ID)!;
    const html = await translateWithExternalEngine(googleFree, {
      html: '<span data-flt-text-id="0">Hello world</span>',
      sourceLanguage: "en",
      targetLanguage: "zh-Hans",
    });
    expect(html).toBe('<span data-flt-text-id="0">你好世界</span>');
    expect(calls).toBe(3);
  });
});

describe("LLM fast mode, compact batching, and persistent cache", () => {
  it("compacts and expands link transport losslessly", () => {
    const full = '<span data-flt-text-id="0">Read </span><a data-flt-link-id="0" href="https://pagelingo.invalid/__link/0"><code>__FLT_LINK_START_0__</code><span data-flt-text-id="1">the guide</span><code>__FLT_LINK_END_0__</code></a>';
    const compact = compactLlmTransportHtml(full);
    expect(compact).toBe('<span data-flt-text-id="0">Read </span><a data-l="0"><span data-flt-text-id="1">the guide</span></a>');
    expect(compact.length).toBeLessThan(full.length - 80);
    expect(expandLlmTransportHtml(compact)).toBe(full);
  });

  it("uses static system prompt and [[SEG_N]] batching while handling partial failure cleanly", async () => {
    const systems: string[] = [];
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        reasoning_effort?: string;
        messages: Array<{ role: string; content: string }>;
      };
      expect(body.reasoning_effort).toBe("none");
      systems.push(body.messages[0]!.content);
      expect(body.messages[1]!.content).toContain("[[SEG_0]]");
      expect(body.messages[1]!.content).toContain('<a data-l="0">');
      const reply = [
        '[[SEG_0]]\n<span data-flt-text-id="0">阅读 </span><a data-l="0"><span data-flt-text-id="1">指南</span></a>\n[[/SEG_0]]',
        '[[SEG_1]]\n<em><span data-flt-text-id="0">结构被破坏</span></em>\n[[/SEG_1]]',
      ].join("\n");
      return Response.json({ choices: [{ finish_reason: "stop", message: { content: reply } }] });
    });
    vi.stubGlobal("fetch", fetchMock);

    const engine = llmConfig();
    const first = '<span data-flt-text-id="0">Read </span><a data-flt-link-id="0" href="https://pagelingo.invalid/__link/0"><code>__FLT_LINK_START_0__</code><span data-flt-text-id="1">the guide</span><code>__FLT_LINK_END_0__</code></a>';
    const second = '<strong><span data-flt-text-id="0">Complete setup</span></strong>';
    const result = await translateExternalBatch(engine, [
      { html: first, sourceLanguage: "en", targetLanguage: "zh-Hans", terminology: [{ source: "OpenClaw", target: "OpenClaw", mode: "protect" }] },
      { html: second, sourceLanguage: "en", targetLanguage: "zh-Hans" },
    ]);
    expect(result[0]).toBe('<span data-flt-text-id="0">阅读 </span><a data-flt-link-id="0" href="https://pagelingo.invalid/__link/0"><code>__FLT_LINK_START_0__</code><span data-flt-text-id="1">指南</span><code>__FLT_LINK_END_0__</code></a>');
    expect(result[1]).toBeNull();
    // Terminology stays out of the static system prompt to preserve prompt cache prefix
    expect(systems[0]).not.toContain("OpenClaw");
  });

  it("downgrades reasoning_effort from none -> low -> omit on HTTP 400 reasoning errors and caches the working mode", async () => {
    const efforts: Array<string | undefined> = [];
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { reasoning_effort?: string };
      efforts.push(body.reasoning_effort);
      if (body.reasoning_effort === "none") {
        return new Response(JSON.stringify({ error: { message: "Unsupported reasoning_effort value: none" } }), { status: 400 });
      }
      return Response.json({ choices: [{ finish_reason: "stop", message: { content: "你好" } }] });
    });
    vi.stubGlobal("fetch", fetchMock);

    const engine = llmConfig({ model: "custom-reasoning-model" });
    await expect(translateWithExternalEngine(engine, { html: "Hello", sourceLanguage: "en", targetLanguage: "zh-Hans" })).resolves.toBe("你好");
    await expect(translateWithExternalEngine(engine, { html: "Hello", sourceLanguage: "en", targetLanguage: "zh-Hans" })).resolves.toBe("你好");
    expect(efforts).toEqual(["none", "low", "low"]);
  });

  it("sends Gemini thinkingBudget: 0 when disableThinking is enabled and falls back on unsupported error", async () => {
    let calls = 0;
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      calls += 1;
      const body = JSON.parse(String(init?.body)) as { generationConfig?: { thinkingConfig?: { thinkingBudget: number } } };
      if (calls === 1) {
        expect(body.generationConfig?.thinkingConfig?.thinkingBudget).toBe(0);
        return new Response(JSON.stringify({ error: { message: "Unknown field thinkingConfig" } }), { status: 400 });
      }
      expect(body.generationConfig).toBeUndefined();
      return Response.json({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: "你好" }] } }] });
    });
    vi.stubGlobal("fetch", fetchMock);

    const gemini = llmConfig({ type: "gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta", model: "gemini-legacy" });
    await expect(translateWithExternalEngine(gemini, { html: "Hello", sourceLanguage: "en", targetLanguage: "zh-Hans" })).resolves.toBe("你好");
    expect(calls).toBe(2);
  });

  it("handles protected brand terms inside fixed text slots through external HTML engines without rejecting or duplicating", async () => {
    document.body.innerHTML = "<p>Claude and GPT models</p>";
    const p = document.querySelector("p")!;
    const engine = llmConfig();
    vi.stubGlobal("fetch", vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> };
      const source = body.messages[1]!.content;
      expect(source).toContain('translate="no"');
      const translated = source.replace(" and ", " 和 ").replace(" models", " 模型");
      return Response.json({ choices: [{ finish_reason: "stop", message: { content: translated } }] });
    }));

    const translator = new PageTranslator(document, {
      prefersWholeSentenceHtml: async () => true,
      translateHtml: (req: TranslationRequest) => translateWithExternalEngine(engine, req),
    }, {
      displayMode: "translation",
      sourceLanguage: "en",
      targetLanguage: "zh-Hans",
      terminology: [
        { source: "Claude", target: "Claude", mode: "protect", caseSensitive: true, origin: "builtin" },
        { source: "GPT", target: "GPT", mode: "protect", caseSensitive: true, origin: "builtin" },
      ],
    });
    await translator.translateAll(p);
    expect(translator.failedCount).toBe(0);
    expect(p.textContent).toBe("Claude 和 GPT 模型");
    translator.restore();
    expect(p.textContent).toBe("Claude and GPT models");
  });

  it("handles external HTML engines that emit empty term spans alongside already-preserved brands without failing validation or duplicating", async () => {
    document.body.innerHTML = "<p>Claude and GPT models</p>";
    const p = document.querySelector("p")!;
    const engine = llmConfig();
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      choices: [{
        finish_reason: "stop",
        message: {
          content: '<span data-flt-text-id="0"><span data-flt-term-id="0" translate="no" class="notranslate"></span><span data-flt-term-id="1" translate="no" class="notranslate"></span>Claude 和 GPT 模型</span>',
        },
      }],
    })));

    const translator = new PageTranslator(document, {
      prefersWholeSentenceHtml: async () => true,
      translateHtml: (req: TranslationRequest) => translateWithExternalEngine(engine, req),
    }, {
      displayMode: "translation",
      sourceLanguage: "en",
      targetLanguage: "zh-Hans",
      terminology: [
        { source: "Claude", target: "Claude", mode: "protect", caseSensitive: true, origin: "builtin" },
        { source: "GPT", target: "GPT", mode: "protect", caseSensitive: true, origin: "builtin" },
      ],
    });
    await translator.translateAll(p);
    expect(translator.failedCount).toBe(0);
    expect(p.textContent).toBe("Claude 和 GPT 模型");
    translator.restore();
    expect(p.textContent).toBe("Claude and GPT models");
  });

  it("evicts LRU entries and separates cache keys by engine, thinking mode, and terminology", async () => {
    const cache = new ExternalTranslationCache({ maxMemoryEntries: 2, durable: false });
    const a: RuntimeExternalEngineConfig = llmConfig({ disableThinking: true });
    const b: RuntimeExternalEngineConfig = llmConfig({ disableThinking: false });
    const k1 = externalTranslationCacheKey(a, "en", "zh-Hans", "Hello");
    const k2 = externalTranslationCacheKey(b, "en", "zh-Hans", "Hello");
    const k3 = externalTranslationCacheKey(a, "en", "zh-Hans", "World");
    expect(k1).not.toBe(k2);

    cache.set(k1, "你好1");
    cache.set(k2, "你好2");
    expect(await cache.get(k1)).toBe("你好1"); // refresh k1
    cache.set(k3, "世界"); // evicts k2
    expect(await cache.get(k2)).toBeUndefined();
    expect(await cache.get(k1)).toBe("你好1");
    expect(await cache.get(k3)).toBe("世界");

    expect(parseLlmBatchResponse('[{"id":0,"html":"A"}]', 1)).toEqual(["A"]);
    const protectedFrag = protectTerminologyHtml(document, "Claude and GPT", [
      { source: "Claude", target: "Claude", mode: "protect", caseSensitive: true },
      { source: "GPT", target: "GPT", mode: "protect", caseSensitive: true },
    ]);
    expect(protectedFrag.replacements).toEqual(["Claude", "GPT"]);
  });
});
