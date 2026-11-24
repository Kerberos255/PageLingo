import { afterEach, describe, expect, it, vi } from "vitest";
import { initializeImageTranslation } from "../src/image-translation/background-service";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("top-level context menu invariants", () => {
  it("keeps page, selection, and image contexts at a single top-level item and cleans up legacy segment retranslate", async () => {
    const created: Array<{ id?: string; title?: string; contexts?: string[]; targetUrlPatterns?: string[] }> = [];
    const removed: string[] = [];
    const updated: Array<{ id: string; props: Record<string, unknown> }> = [];
    let onShownHandler: ((info: Record<string, unknown>, tab?: { id?: number }) => void) | null = null;
    const refresh = vi.fn(async () => undefined);
    const sendMessage = vi.fn()
      .mockResolvedValueOnce({ pageTranslated: true })
      .mockResolvedValueOnce({ pageTranslated: false })
      .mockRejectedValueOnce(new Error("Receiving end does not exist"));

    vi.stubGlobal("browser", {
      storage: {
        local: {
          get: vi.fn(async () => ({ imageTranslationEnabled: true })),
        },
        onChanged: {
          addListener: vi.fn(),
        },
      },
      runtime: {
        onInstalled: { addListener: vi.fn() },
        onStartup: { addListener: vi.fn() },
        getURL: vi.fn((path: string) => `moz-extension://test/${path}`),
      },
      tabs: {
        sendMessage,
        create: vi.fn(async () => undefined),
      },
      contextMenus: {
        remove: vi.fn(async (id: string) => {
          removed.push(id);
        }),
        create: vi.fn((props: { id?: string; title?: string; contexts?: string[]; targetUrlPatterns?: string[] }) => {
          created.push(props);
        }),
        update: vi.fn(async (id: string, props: Record<string, unknown>) => {
          updated.push({ id, props });
        }),
        refresh,
        onClicked: { addListener: vi.fn() },
        onShown: {
          addListener: vi.fn((fn: (info: Record<string, unknown>, tab?: { id?: number }) => void) => {
            onShownHandler = fn;
          }),
        },
      },
    });

    initializeImageTranslation();
    await vi.waitFor(() => expect(created.length).toBe(4));

    expect(removed).toContain("pagelingo-retranslate-segment");
    expect(created.some((item) => item.id === "pagelingo-retranslate-segment")).toBe(false);

    const forContext = (ctx: string) =>
      created.filter((item) => item.contexts?.includes(ctx) && !item.targetUrlPatterns);
    expect(forContext("page").map((item) => item.id)).toEqual(["pagelingo-translate-page"]);
    expect(forContext("selection").map((item) => item.id)).toEqual(["pagelingo-translate-selection"]);
    expect(forContext("image").map((item) => item.id)).toEqual(["pagelingo-translate-image"]);
    expect(forContext("link").map((item) => item.id)).toEqual(["pagelingo-translate-page"]);

    expect(onShownHandler).toBeTypeOf("function");

    onShownHandler!({ frameId: 0 }, { id: 10 });
    await vi.waitFor(() => expect(updated).toContainEqual({
      id: "pagelingo-translate-page",
      props: { title: "PageLingo · 显示原文" },
    }));

    onShownHandler!({ frameId: 0 }, { id: 11 });
    await vi.waitFor(() => expect(updated).toContainEqual({
      id: "pagelingo-translate-page",
      props: { title: "PageLingo · 翻译文字" },
    }));

    updated.length = 0;
    onShownHandler!({ frameId: 0 }, { id: 12 });
    await vi.waitFor(() => expect(updated).toContainEqual({
      id: "pagelingo-translate-page",
      props: { title: "PageLingo · 翻译文字" },
    }));
  });
});
