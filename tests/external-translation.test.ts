import { afterEach, describe, expect, it, vi } from "vitest";
import { translateWithExternalEngine, validateTranslatedHtml } from "../src/providers/external-translation";
import type { TranslationEngineConfig } from "../src/shared/translation-engine-settings";

function config(overrides: Partial<TranslationEngineConfig> = {}): TranslationEngineConfig {
  return {
    id: "engine-test",
    name: "Test",
    type: "custom-rest",
    enabled: true,
    baseUrl: "https://example.invalid/translate",
    apiKey: "test-key",
    model: "test-model",
    region: "",
    prompt: "",
    headersJson: '{"Authorization":"Bearer {{apiKey}}"}',
    bodyJson: '{"q":"{{html}}","source":"{{source}}","target":"{{target}}"}',
    responsePath: "data.translatedText",
    ...overrides,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("external translation HTML safety", () => {
  it("accepts translations that preserve the HTML skeleton and opaque placeholders", () => {
    expect(validateTranslatedHtml("Hello <strong>world</strong><code>__FLT_OPAQUE_0__</code>", "你好 <strong>世界</strong><code>__FLT_OPAQUE_0__</code>"))
      .toBe("你好 <strong>世界</strong><code>__FLT_OPAQUE_0__</code>");
  });

  it("rejects changed tag structure", () => {
    expect(() => validateTranslatedHtml("Hello <strong>world</strong>", "你好 <em>世界</em>"))
      .toThrow(/HTML 结构/);
  });

  it("rejects changed opaque placeholders", () => {
    expect(() => validateTranslatedHtml("<code>__FLT_OPAQUE_0__</code>", "<code>translated</code>"))
      .toThrow(/代码占位符/);
  });

  it("sends declarative custom REST templates and reads the configured response path", async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      const body = JSON.parse(String(init?.body)) as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer test-key");
      expect(body).toEqual({ q: "Hello <strong>world</strong>", source: "en", target: "zh-Hans" });
      return new Response(JSON.stringify({ data: { translatedText: "你好 <strong>世界</strong>" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const html = await translateWithExternalEngine(config(), {
      html: "Hello <strong>world</strong>",
      sourceLanguage: "en",
      targetLanguage: "zh-Hans",
    });
    expect(html).toBe("你好 <strong>世界</strong>");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("uses OpenRouter's current title header and strips a markdown fence", async () => {
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(String(url)).toBe("https://openrouter.ai/api/v1/chat/completions");
      const headers = init?.headers as Record<string, string>;
      expect(headers["X-OpenRouter-Title"]).toBe("PageLingo");
      expect(headers["X-Title"]).toBeUndefined();
      const body = JSON.parse(String(init?.body)) as { model: string; messages: Array<{ role: string; content: string }>; temperature: number };
      expect(body.model).toBe("openrouter/free");
      expect(body.temperature).toBe(0);
      expect(body.messages[0]?.content).toContain("KEEP EXACTLY, character-for-character: Slack");
      expect(body.messages[0]?.content).toContain("PREFERRED TRANSLATION: Gateway => 网关");
      return new Response(JSON.stringify({ choices: [{ message: { content: "```html\n你好 <strong>世界</strong>\n```" } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const html = await translateWithExternalEngine(config({
      type: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      model: "openrouter/free",
      headersJson: "",
      bodyJson: "",
      responsePath: "",
    }), {
      html: "Hello <strong>world</strong>",
      sourceLanguage: "en",
      targetLanguage: "zh-Hans",
      terminology: [
        { source: "Slack", target: "Slack", mode: "protect" },
        { source: "Gateway", target: "网关", mode: "replace" },
      ],
    });
    expect(html).toBe("你好 <strong>世界</strong>");
  });

  it("sends Microsoft Translator HTML requests with key and optional region", async () => {
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const endpoint = new URL(String(url));
      expect(endpoint.origin + endpoint.pathname).toBe("https://api.cognitive.microsofttranslator.com/translate");
      expect(endpoint.searchParams.get("api-version")).toBe("3.0");
      expect(endpoint.searchParams.get("from")).toBe("en");
      expect(endpoint.searchParams.get("to")).toBe("zh-Hans");
      expect(endpoint.searchParams.get("textType")).toBe("html");
      const headers = init?.headers as Record<string, string>;
      expect(headers["Ocp-Apim-Subscription-Key"]).toBe("test-key");
      expect(headers["Ocp-Apim-Subscription-Region"]).toBe("westus");
      expect(JSON.parse(String(init?.body))).toEqual([{ Text: "Hello <strong>world</strong>" }]);
      return new Response(JSON.stringify([{ translations: [{ text: "你好 <strong>世界</strong>" }] }]), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const html = await translateWithExternalEngine(config({
      type: "microsoft",
      baseUrl: "https://api.cognitive.microsofttranslator.com",
      region: "westus",
      headersJson: "",
      bodyJson: "",
      responsePath: "",
    }), {
      html: "Hello <strong>world</strong>",
      sourceLanguage: "en",
      targetLanguage: "zh-Hans",
    });
    expect(html).toBe("你好 <strong>世界</strong>");
  });

  it("uses DeepL Free host selection and HTML translation semantics", async () => {
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(String(url)).toBe("https://api-free.deepl.com/v2/translate");
      const headers = init?.headers as Record<string, string>;
      expect(headers.Authorization).toBe("DeepL-Auth-Key test-key:fx");
      const body = JSON.parse(String(init?.body)) as {
        text: string[];
        source_lang: string;
        target_lang: string;
        tag_handling: string;
      };
      expect(body).toEqual({
        text: ["Hello <strong>world</strong>"],
        source_lang: "EN",
        target_lang: "ZH-HANS",
        tag_handling: "html",
      });
      return new Response(JSON.stringify({ translations: [{ detected_source_language: "EN", text: "你好 <strong>世界</strong>" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const html = await translateWithExternalEngine(config({
      type: "deepl",
      baseUrl: "https://api.deepl.com/v2",
      apiKey: "test-key:fx",
      headersJson: "",
      bodyJson: "",
      responsePath: "",
    }), {
      html: "Hello <strong>world</strong>",
      sourceLanguage: "en",
      targetLanguage: "zh-Hans",
    });
    expect(html).toBe("你好 <strong>世界</strong>");
  });

  it("sends Google Cloud Translation API keys in x-goog-api-key instead of the URL", async () => {
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(String(url)).toBe("https://translation.googleapis.com/language/translate/v2");
      const headers = init?.headers as Record<string, string>;
      expect(headers["x-goog-api-key"]).toBe("test-key");
      const body = JSON.parse(String(init?.body)) as { q: string; source: string; target: string; format: string };
      expect(body).toEqual({
        q: "Hello <strong>world</strong>",
        source: "en",
        target: "zh-CN",
        format: "html",
      });
      return new Response(JSON.stringify({ data: { translations: [{ translatedText: "你好 <strong>世界</strong>" }] } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const html = await translateWithExternalEngine(config({
      type: "google",
      baseUrl: "https://translation.googleapis.com/language/translate/v2",
      headersJson: "",
      bodyJson: "",
      responsePath: "",
    }), {
      html: "Hello <strong>world</strong>",
      sourceLanguage: "en",
      targetLanguage: "zh-Hans",
    });
    expect(html).toBe("你好 <strong>世界</strong>");
  });

  it("models DeepL through custom REST templates", async () => {
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(String(url)).toBe("https://api.deepl.com/v2/translate");
      const headers = init?.headers as Record<string, string>;
      expect(headers.Authorization).toBe("DeepL-Auth-Key test-key");
      expect(JSON.parse(String(init?.body))).toEqual({
        text: ["Hello <strong>world</strong>"],
        source_lang: "EN",
        target_lang: "ZH-HANS",
        tag_handling: "html",
      });
      return new Response(JSON.stringify({ translations: [{ text: "你好 <strong>世界</strong>" }] }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const html = await translateWithExternalEngine(config({
      type: "custom-rest",
      baseUrl: "https://api.deepl.com/v2/translate",
      headersJson: '{"Authorization":"DeepL-Auth-Key {{apiKey}}"}',
      bodyJson: '{"text":["{{html}}"],"source_lang":"EN","target_lang":"ZH-HANS","tag_handling":"html"}',
      responsePath: "translations.0.text",
    }), {
      html: "Hello <strong>world</strong>",
      sourceLanguage: "en",
      targetLanguage: "zh-Hans",
    });
    expect(html).toBe("你好 <strong>世界</strong>");
  });

  it("models Microsoft Translator through custom REST with a top-level JSON array body", async () => {
    const endpoint = "https://api.cognitive.microsofttranslator.com/translate?api-version=3.0&from=en&to=zh-Hans&textType=html";
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(String(url)).toBe(endpoint);
      const headers = init?.headers as Record<string, string>;
      expect(headers["Ocp-Apim-Subscription-Key"]).toBe("test-key");
      expect(JSON.parse(String(init?.body))).toEqual([{ Text: "Hello <strong>world</strong>" }]);
      return new Response(JSON.stringify([{ translations: [{ text: "你好 <strong>世界</strong>" }] }]), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const html = await translateWithExternalEngine(config({
      type: "custom-rest",
      baseUrl: endpoint,
      headersJson: '{"Ocp-Apim-Subscription-Key":"{{apiKey}}"}',
      bodyJson: '[{"Text":"{{html}}"}]',
      responsePath: "0.translations.0.text",
    }), {
      html: "Hello <strong>world</strong>",
      sourceLanguage: "en",
      targetLanguage: "zh-Hans",
    });
    expect(html).toBe("你好 <strong>世界</strong>");
  });

  it("models Google Cloud Translation through custom REST templates", async () => {
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(String(url)).toBe("https://translation.googleapis.com/language/translate/v2");
      const headers = init?.headers as Record<string, string>;
      expect(headers["x-goog-api-key"]).toBe("test-key");
      expect(JSON.parse(String(init?.body))).toEqual({
        q: "Hello <strong>world</strong>",
        source: "en",
        target: "zh-CN",
        format: "html",
      });
      return new Response(JSON.stringify({ data: { translations: [{ translatedText: "你好 <strong>世界</strong>" }] } }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const html = await translateWithExternalEngine(config({
      type: "custom-rest",
      baseUrl: "https://translation.googleapis.com/language/translate/v2",
      headersJson: '{"x-goog-api-key":"{{apiKey}}"}',
      bodyJson: '{"q":"{{html}}","source":"en","target":"zh-CN","format":"html"}',
      responsePath: "data.translations.0.translatedText",
    }), {
      html: "Hello <strong>world</strong>",
      sourceLanguage: "en",
      targetLanguage: "zh-Hans",
    });
    expect(html).toBe("你好 <strong>世界</strong>");
  });

  it("exposes terminology to custom REST templates without forcing an API shape", async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { glossary: string; q: string };
      expect(body.glossary).toContain("Slack = Slack");
      expect(body.glossary).toContain("Gateway = 网关");
      return new Response(JSON.stringify({ data: { translatedText: "Slack 使用网关" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const html = await translateWithExternalEngine(config({
      bodyJson: '{"q":"{{html}}","glossary":"{{terminology}}"}',
    }), {
      html: "Slack uses Gateway",
      sourceLanguage: "en",
      targetLanguage: "zh-Hans",
      terminology: [
        { source: "Slack", target: "Slack", mode: "protect" },
        { source: "Gateway", target: "网关", mode: "replace" },
      ],
    });
    expect(html).toBe("Slack 使用网关");
  });

  it("rejects plaintext remote endpoints but allows loopback HTTP", async () => {
    await expect(translateWithExternalEngine(config({
      type: "libretranslate",
      baseUrl: "http://example.com",
    }), {
      html: "Hello",
      sourceLanguage: "en",
      targetLanguage: "zh-Hans",
    })).rejects.toThrow(/HTTPS/);

    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ translatedText: "你好" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const html = await translateWithExternalEngine(config({
      type: "libretranslate",
      baseUrl: "http://127.0.0.1:5000",
    }), {
      html: "Hello",
      sourceLanguage: "en",
      targetLanguage: "zh-Hans",
    });
    expect(html).toBe("你好");

    const ipv6Html = await translateWithExternalEngine(config({
      type: "libretranslate",
      baseUrl: "http://[::1]:5000",
    }), {
      html: "Hello",
      sourceLanguage: "en",
      targetLanguage: "zh-Hans",
    });
    expect(ipv6Html).toBe("你好");
  });

  it("maps Traditional Chinese to LibreTranslate's zt language code", async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { source: string; target: string };
      expect(body.source).toBe("en");
      expect(body.target).toBe("zt");
      return new Response(JSON.stringify({ translatedText: "你好 <strong>世界</strong>" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const html = await translateWithExternalEngine(config({
      type: "libretranslate",
      baseUrl: "https://libretranslate.com",
      headersJson: "",
      bodyJson: "",
      responsePath: "",
    }), {
      html: "Hello <strong>world</strong>",
      sourceLanguage: "en",
      targetLanguage: "zh-Hant",
    });
    expect(html).toBe("你好 <strong>世界</strong>");
  });
});
