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
      const body = JSON.parse(String(init?.body)) as { model: string };
      expect(body.model).toBe("openrouter/free");
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
    });
    expect(html).toBe("你好 <strong>世界</strong>");
  });

  it("sends Google Cloud Translation API keys in x-goog-api-key instead of the URL", async () => {
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(String(url)).toBe("https://translation.googleapis.com/language/translate/v2");
      const headers = init?.headers as Record<string, string>;
      expect(headers["x-goog-api-key"]).toBe("test-key");
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
