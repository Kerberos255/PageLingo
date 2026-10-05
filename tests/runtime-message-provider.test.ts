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
  it("retries individually when a supported batch fails for one problematic input", async () => {
    const sendMessage = vi.fn(async (message: any) => {
      if (message.type === "translate-html-batch") {
        return { ok: false, error: "one input rejected" };
      }
      if (message.type === "translate-html") {
        if (message.request.html === "bad") return { ok: false, error: "bad root" };
        return { ok: true, html: `译:${message.request.html}` };
      }
      throw new Error(`Unexpected message: ${message.type}`);
    });
    vi.stubGlobal("browser", { runtime: { sendMessage } });

    const provider = new RuntimeMessageProvider();
    const goodA = provider.translateHtml({ html: "good-a", sourceLanguage: "en", targetLanguage: "zh-Hans" });
    const bad = provider.translateHtml({ html: "bad", sourceLanguage: "en", targetLanguage: "zh-Hans" });
    const goodB = provider.translateHtml({ html: "good-b", sourceLanguage: "en", targetLanguage: "zh-Hans" });

    await expect(goodA).resolves.toBe("译:good-a");
    await expect(bad).rejects.toThrow("bad root");
    await expect(goodB).resolves.toBe("译:good-b");
    expect(sendMessage.mock.calls[0]?.[0].type).toBe("translate-html-batch");
    expect(sendMessage.mock.calls.slice(1).filter((call) => call[0].type === "translate-html")).toHaveLength(3);
  });


  it("holds an extension view while a long single translation is pending", async () => {
    let finish: ((value: unknown) => void) | null = null;
    const sendMessage = vi.fn((message: any) => {
      if (message.type !== "translate-html") throw new Error(`Unexpected message: ${message.type}`);
      return new Promise((resolve) => { finish = resolve; });
    });
    vi.stubGlobal("browser", {
      runtime: {
        sendMessage,
        getURL: (path: string) => `moz-extension://pagelingo-test/${path}`,
      },
    });

    const provider = new RuntimeMessageProvider();
    const pending = provider.translateHtml({ html: "one", sourceLanguage: "en", targetLanguage: "zh-Hans" });
    await new Promise((resolve) => queueMicrotask(resolve));

    const frame = document.querySelector<HTMLIFrameElement>('iframe[src*="mt-keepalive.html"]');
    expect(frame).not.toBeNull();

    finish?.({ ok: true, html: "译:one" });
    await expect(pending).resolves.toBe("译:one");
    expect(document.querySelector('iframe[src*="mt-keepalive.html"]')).toBeNull();
  });

  it("reports structural splitting only for engines marked safe by the background", async () => {
    const sendMessage = vi.fn(async () => ({
      ok: true,
      state: { structuralSplittingSafe: false },
    }));
    vi.stubGlobal("browser", { runtime: { sendMessage } });

    const provider = new RuntimeMessageProvider();
    await expect(provider.supportsStructuralSplitting()).resolves.toBe(false);
    expect(sendMessage).toHaveBeenCalledWith({ type: "get-translation-engines" });
  });

});
