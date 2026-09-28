import { afterEach, describe, expect, it, vi } from "vitest";

import { RuntimeMessageProvider } from "../src/providers/runtime-message-provider";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("RuntimeMessageProvider batching", () => {
  it("coalesces same-route requests from one microtask into one runtime batch", async () => {
    const sendMessage = vi.fn(async (message: any) => {
      if (message.type === "translate-html-batch") {
        return { ok: true, htmls: message.requests.map((request: any) => `译:${request.html}`) };
      }
      throw new Error(`Unexpected message: ${message.type}`);
    });
    vi.stubGlobal("browser", { runtime: { sendMessage } });

    const provider = new RuntimeMessageProvider();
    const first = provider.translateHtml({ html: "one", sourceLanguage: "en", targetLanguage: "zh-Hans" });
    const second = provider.translateHtml({ html: "two", sourceLanguage: "en", targetLanguage: "zh-Hans" });
    const third = provider.translateHtml({ html: "three", sourceLanguage: "en", targetLanguage: "zh-Hans" });

    await expect(Promise.all([first, second, third])).resolves.toEqual(["译:one", "译:two", "译:three"]);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0]?.[0]).toMatchObject({
      type: "translate-html-batch",
      requests: [
        { html: "one", sourceLanguage: "en", targetLanguage: "zh-Hans" },
        { html: "two", sourceLanguage: "en", targetLanguage: "zh-Hans" },
        { html: "three", sourceLanguage: "en", targetLanguage: "zh-Hans" },
      ],
    });
  });

  it("keeps different language routes out of the same batch", async () => {
    const sendMessage = vi.fn(async (message: any) => ({
      ok: true,
      html: `译:${message.request.html}`,
    }));
    vi.stubGlobal("browser", { runtime: { sendMessage } });

    const provider = new RuntimeMessageProvider();
    const first = provider.translateHtml({ html: "one", sourceLanguage: "en", targetLanguage: "zh-Hans" });
    const second = provider.translateHtml({ html: "two", sourceLanguage: "en", targetLanguage: "de" });

    await expect(Promise.all([first, second])).resolves.toEqual(["译:one", "译:two"]);
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage.mock.calls.every((call) => call[0].type === "translate-html")).toBe(true);
  });

  it("falls back to the existing single-request path when batching is unsupported", async () => {
    const sendMessage = vi.fn(async (message: any) => {
      if (message.type === "translate-html-batch") {
        return { ok: false, batchUnsupported: true, error: "local-only" };
      }
      return { ok: true, html: `译:${message.request.html}` };
    });
    vi.stubGlobal("browser", { runtime: { sendMessage } });

    const provider = new RuntimeMessageProvider();
    const first = provider.translateHtml({ html: "one", sourceLanguage: "en", targetLanguage: "zh-Hans" });
    const second = provider.translateHtml({ html: "two", sourceLanguage: "en", targetLanguage: "zh-Hans" });

    await expect(Promise.all([first, second])).resolves.toEqual(["译:one", "译:two"]);
    expect(sendMessage).toHaveBeenCalledTimes(3);
    expect(sendMessage.mock.calls[0]?.[0].type).toBe("translate-html-batch");
    expect(sendMessage.mock.calls.slice(1).every((call) => call[0].type === "translate-html")).toBe(true);
  });
});
