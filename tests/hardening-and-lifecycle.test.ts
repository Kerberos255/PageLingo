import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchBoundedBytes,
  readResponseBytesWithLimit,
  resolveSubtitleFetchPolicy,
} from "../src/shared/bounded-fetch";
import { BergamotClient, type BergamotSessionLike } from "../src/providers/bergamot/bergamot-client";
import type { BergamotModelAsset, TranslationRoute } from "../src/providers/bergamot/model-manifest";
import { ImageOcrWorkerClient, type OcrWorkerLike } from "../src/image-translation/background-service";
import type { ImageOcrBundle } from "../src/image-translation/ocr-cache";
import { DEFAULT_OCR_PROFILE } from "../src/image-translation/ocr-models";
import {
  DEFAULT_SETTINGS,
  SETTINGS_STORAGE_KEYS,
  invalidateSettingsCache,
  loadSettings,
  saveDisplayMode,
} from "../src/shared/settings";
import { PageTranslator } from "../src/core/page-translator";
import { canvasHasVisualInk } from "../src/reader/pdf-ink";
import {
  MAX_PDF_CANVAS_BUDGET_BYTES,
  MAX_RENDERED_PDF_CANVASES,
  canvasPixelBytes,
  isRectNearVerticalWindow,
  pickNextLazyPdfPage,
  selectPdfPagesToEvict,
  type LazyPdfPageState,
} from "../src/reader/pdf-lazy-render";
import { loadModelAsset } from "../src/providers/bergamot/model-cache";
import { fetchLatestPairs } from "../src/providers/bergamot/model-updates";
import { VideoSubtitleManager } from "../src/video-translation/video-subtitle-controller";

const EN_ZH_ROUTE: TranslationRoute = {
  kind: "direct",
  key: "en>zh-Hans",
  sourceLanguage: "en",
  targetLanguage: "zh-Hans",
  models: [],
};

function makeFakeOcrBundle(profileId = DEFAULT_OCR_PROFILE.id): ImageOcrBundle {
  return {
    profile: { ...DEFAULT_OCR_PROFILE, id: profileId },
    detectionModel: new Uint8Array([1, 2, 3, 4]).buffer,
    recognitionModel: new Uint8Array([5, 6, 7, 8]).buffer,
    dictionary: "a\nb\nc\n",
  };
}

class FakeOcrWorker implements OcrWorkerLike {
  terminated = false;
  messages: unknown[] = [];
  private messageListeners: Array<(event: MessageEvent<any>) => void> = [];
  private errorListeners: Array<(event: { message?: string }) => void> = [];
  onPostMessage?: (message: any, worker: FakeOcrWorker) => void;

  addEventListener(type: "message" | "error", listener: any): void {
    if (type === "message") this.messageListeners.push(listener);
    else this.errorListeners.push(listener);
  }

  postMessage(message: unknown): void {
    this.messages.push(message);
    this.onPostMessage?.(message, this);
  }

  emitMessage(data: unknown): void {
    for (const listener of this.messageListeners) {
      listener({ data } as MessageEvent);
    }
  }

  emitError(message: string): void {
    for (const listener of this.errorListeners) {
      listener({ message });
    }
  }

  terminate(): void {
    this.terminated = true;
  }
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  invalidateSettingsCache();
  delete (globalThis as { browser?: unknown }).browser;
});

describe("bounded fetch and subtitle credential policy", () => {
  it("enforces HTTPS + host allowlist + incognito isolation for subtitle fetch credentials", () => {
    expect(resolveSubtitleFetchPolicy("https://api.bilibili.com/x/player/wbi/v2", "include", false))
      .toEqual({ url: "https://api.bilibili.com/x/player/wbi/v2", credentials: "include" });

    expect(resolveSubtitleFetchPolicy("https://www.youtube.com/api/timedtext?v=abc", "include", false))
      .toEqual({ url: "https://www.youtube.com/api/timedtext?v=abc", credentials: "include" });

    // Private browsing must never attach normal-profile cookies from background script.
    expect(resolveSubtitleFetchPolicy("https://api.bilibili.com/x/player/wbi/v2", "include", true))
      .toEqual({ url: "https://api.bilibili.com/x/player/wbi/v2", credentials: "omit" });

    // Unknown HTTPS hosts default to omit even if caller asked for include.
    expect(resolveSubtitleFetchPolicy("https://cdn.example.com/captions.vtt", "include", false))
      .toEqual({ url: "https://cdn.example.com/captions.vtt", credentials: "omit" });

    // Omitted credentials field defaults safely to omit.
    expect(resolveSubtitleFetchPolicy("https://api.bilibili.com/x/player/wbi/v2", undefined, false))
      .toEqual({ url: "https://api.bilibili.com/x/player/wbi/v2", credentials: "omit" });

    // Loopback HTTP is permitted for local testing, always with credentials omitted.
    expect(resolveSubtitleFetchPolicy("http://127.0.0.1:8080/sub.vtt", "include", false))
      .toEqual({ url: "http://127.0.0.1:8080/sub.vtt", credentials: "omit" });

    // Non-loopback plain HTTP and non-HTTP schemes are rejected.
    expect(() => resolveSubtitleFetchPolicy("http://example.com/sub.vtt", "omit", false)).toThrow(/HTTPS/);
    expect(() => resolveSubtitleFetchPolicy("file:///etc/passwd", "omit", false)).toThrow(/HTTPS/);
  });

  it("aborts streaming reads immediately when exceeding maxBytes without consuming the rest of the stream", async () => {
    let pulled = 0;
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new Uint8Array(600));
      },
      cancel() {
        cancelled = true;
      },
    });
    const response = new Response(stream, { status: 200 });
    await expect(readResponseBytesWithLimit(response, 1000, "too big")).rejects.toThrow("too big");
    expect(cancelled).toBe(true);
    expect(pulled).toBeLessThanOrEqual(3);
  });

  it("rejects upfront on oversized Content-Length and aborts stalled fetches on timeout", async () => {
    const oversized = new Response(new Uint8Array(10), {
      status: 200,
      headers: { "content-length": "999999" },
    });
    await expect(readResponseBytesWithLimit(oversized, 1024, "too large")).rejects.toThrow("too large");

    let aborted = false;
    const stalledFetch = ((_url: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        aborted = true;
        reject(new DOMException("Aborted", "AbortError"));
      });
    })) as typeof fetch;

    await expect(fetchBoundedBytes("https://example.com/doc.pdf", {
      maxBytes: 1024,
      timeoutMs: 30,
      tooLargeMessage: "too large",
      timeoutMessage: "fetch timed out",
      httpErrorPrefix: "failed",
      fetchFn: stalledFetch,
    })).rejects.toThrow("fetch timed out");
    expect(aborted).toBe(true);
  });
});

describe("BergamotClient cache safety, incognito bypass, and idle worker eviction", () => {
  it("does not cache failed fallback items and retries them cleanly on the next request", async () => {
    let failSecond = true;
    const calls: string[][] = [];
    const session: BergamotSessionLike = {
      initialized: true,
      activeRequestCount: 0,
      async translateHtmlBatch(htmls: string[]) {
        calls.push([...htmls]);
        if (htmls.length > 1 && failSecond) {
          throw new Error("batch failed due to one malformed item");
        }
        return htmls.map((item) => {
          if (failSecond && item.includes("bad item")) {
            throw new Error("single item failed");
          }
          return `ZH:${item}`;
        });
      },
      performanceStats: () => ({ inferenceCount: calls.length, inferenceMilliseconds: 10, translatedInputs: calls.length }),
      resetPerformanceStats: () => {},
      terminate: () => {},
    };

    const client = new BergamotClient({
      idleTimeoutMs: 0,
      sessionFactory: () => session,
    });

    const first = await client.translateHtmlBatch(["good item", "bad item"], EN_ZH_ROUTE);
    expect(first).toEqual(["ZH:good item", "bad item"]);
    expect(client.cacheSize()).toBe(1);

    // Next attempt: "good item" comes from cache, while "bad item" was NOT cached and now succeeds.
    failSecond = false;
    const second = await client.translateHtmlBatch(["good item", "bad item"], EN_ZH_ROUTE);
    expect(second).toEqual(["ZH:good item", "ZH:bad item"]);
    expect(client.cacheSize()).toBe(2);
    expect(calls[calls.length - 1]).toEqual(["bad item"]);
  });

  it("bypasses both reading and writing cache when noCache (incognito) is set", async () => {
    let invokeCount = 0;
    const session: BergamotSessionLike = {
      initialized: true,
      activeRequestCount: 0,
      async translateHtmlBatch(htmls: string[]) {
        invokeCount += 1;
        return htmls.map((h) => `ZH:${invokeCount}:${h}`);
      },
      performanceStats: () => ({ inferenceCount: invokeCount, inferenceMilliseconds: 5, translatedInputs: invokeCount }),
      resetPerformanceStats: () => {},
      terminate: () => {},
    };
    const client = new BergamotClient({ idleTimeoutMs: 0, sessionFactory: () => session });

    // Normal tab caches result.
    expect(await client.translateHtml("secret page", EN_ZH_ROUTE)).toBe("ZH:1:secret page");
    expect(client.cacheSize()).toBe(1);

    // Private tab neither reads normal cache nor writes its own text to cache.
    expect(await client.translateHtml("secret page", EN_ZH_ROUTE, { noCache: true })).toBe("ZH:2:secret page");
    expect(await client.translateHtml("private only", EN_ZH_ROUTE, { noCache: true })).toBe("ZH:3:private only");
    expect(client.cacheSize()).toBe(1);
  });

  it("terminates idle worker sessions while preserving cumulative performance stats", async () => {
    vi.useFakeTimers();
    let terminatedCount = 0;
    const client = new BergamotClient({
      idleTimeoutMs: 1000,
      sessionFactory: () => ({
        initialized: true,
        activeRequestCount: 0,
        async translateHtmlBatch(htmls: string[]) {
          return htmls.map((h) => `ZH:${h}`);
        },
        performanceStats: () => ({ inferenceCount: 1, inferenceMilliseconds: 42, translatedInputs: 1 }),
        resetPerformanceStats: () => {},
        terminate: () => { terminatedCount += 1; },
      }),
    });

    await client.translateHtml("hello", EN_ZH_ROUTE);
    expect(client.activeSessionCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(terminatedCount).toBe(1);
    expect(client.activeSessionCount()).toBe(0);
    expect(client.performanceStats()).toEqual({
      inferenceCount: 1,
      inferenceMilliseconds: 42,
      translatedInputs: 1,
    });
  });
});

describe("ImageOcrWorkerClient concurrency, timeout isolation, and idle teardown", () => {
  it("serializes concurrent requests and resends models when the first request fails", async () => {
    const workers: FakeOcrWorker[] = [];
    const client = new ImageOcrWorkerClient({
      idleTimeoutMs: 0,
      createWorker: () => {
        const w = new FakeOcrWorker();
        workers.push(w);
        return w;
      },
    });
    const bundle = makeFakeOcrBundle();

    const p1 = client.recognize(10, 10, new ArrayBuffer(400), bundle, () => {});
    const p2 = client.recognize(10, 10, new ArrayBuffer(400), bundle, () => {});

    // Only task 1 should be sent to the worker while active.
    expect(workers.length).toBe(1);
    expect(workers[0]!.messages.length).toBe(1);
    const msg1 = workers[0]!.messages[0] as any;
    expect(msg1.detectionModel).toBeInstanceOf(ArrayBuffer);

    // Task 1 fails -> task 2 must still receive model buffers!
    workers[0]!.emitMessage({ type: "error", id: msg1.id, error: "init failed" });
    await expect(p1).rejects.toThrow("init failed");

    // Allow microtask queue drain for task 2.
    await new Promise((r) => setTimeout(r, 0));
    expect(workers[0]!.messages.length).toBe(2);
    const msg2 = workers[0]!.messages[1] as any;
    expect(msg2.detectionModel).toBeInstanceOf(ArrayBuffer);

    workers[0]!.emitMessage({ type: "result", id: msg2.id, regions: [{ text: "ok", confidence: 0.9, box: { x: 0, y: 0, width: 5, height: 5 } }] });
    const res2 = await p2;
    expect(res2[0]?.text).toBe("ok");

    // Task 3 with same profile reuses initialized worker without re-sending models.
    const p3 = client.recognize(10, 10, new ArrayBuffer(400), bundle, () => {});
    const msg3 = workers[0]!.messages[2] as any;
    expect(msg3.detectionModel).toBeUndefined();
    workers[0]!.emitMessage({ type: "result", id: msg3.id, regions: [] });
    expect(await p3).toEqual([]);
  });

  it("recovers queued tasks on a fresh worker after timeout and ignores stale worker events", async () => {
    vi.useFakeTimers();
    const workers: FakeOcrWorker[] = [];
    const client = new ImageOcrWorkerClient({
      recognizeTimeoutMs: 50,
      idleTimeoutMs: 200,
      createWorker: () => {
        const w = new FakeOcrWorker();
        workers.push(w);
        return w;
      },
    });
    const bundle = makeFakeOcrBundle();

    const p1 = client.recognize(10, 10, new ArrayBuffer(400), bundle, () => {});
    const p2 = client.recognize(10, 10, new ArrayBuffer(400), bundle, () => {});

    // Attach rejection handler before timer fires to avoid unhandled rejection.
    const p1Result = p1.catch((e: Error) => e.message);
    await vi.advanceTimersByTimeAsync(60);

    expect(await p1Result).toContain("超时");
    expect(workers[0]!.terminated).toBe(true);
    expect(workers.length).toBe(2);

    // Late error from terminated worker #0 must NOT kill worker #1!
    workers[0]!.emitError("stale crash");
    expect(workers[1]!.terminated).toBe(false);

    const msg2 = workers[1]!.messages[0] as any;
    expect(msg2.detectionModel).toBeInstanceOf(ArrayBuffer);
    workers[1]!.emitMessage({ type: "result", id: msg2.id, regions: [{ text: "fresh", confidence: 0.95, box: { x: 1, y: 1, width: 4, height: 4 } }] });
    const res2 = await p2;
    expect(res2[0]?.text).toBe("fresh");

    // Idle teardown kills worker #1 cleanly after idleTimeoutMs.
    expect(client.hasLiveWorker()).toBe(true);
    await vi.advanceTimersByTimeAsync(210);
    expect(workers[1]!.terminated).toBe(true);
    expect(client.hasLiveWorker()).toBe(false);
  });
});

describe("loadSettings targeted key reads and storage.onChanged cache", () => {
  it("reads only SETTINGS_STORAGE_KEYS, caches reads, returns isolated clones, and invalidates on local changes", async () => {
    const store: Record<string, unknown> = {
      displayMode: "bilingual",
      targetLanguage: "ja",
      hugeUnrelatedKey: "x".repeat(10000),
    };
    const getCalls: unknown[] = [];
    const changeListeners: Array<(changes: Record<string, unknown>, area: string) => void> = [];

    (globalThis as { browser?: unknown }).browser = {
      storage: {
        local: {
          async get(keys?: unknown) {
            getCalls.push(keys);
            const result: Record<string, unknown> = {};
            const list = Array.isArray(keys) ? keys : Object.keys(store);
            for (const key of list) {
              if (key in store) result[key] = store[key];
            }
            return result;
          },
          async set(patch: Record<string, unknown>) {
            Object.assign(store, patch);
          },
        },
        onChanged: {
          addListener(fn: (changes: Record<string, unknown>, area: string) => void) {
            changeListeners.push(fn);
          },
        },
      },
    };

    const s1 = await loadSettings();
    expect(getCalls.length).toBe(1);
    expect(getCalls[0]).toEqual([...SETTINGS_STORAGE_KEYS]);
    expect(s1.displayMode).toBe("bilingual");
    expect(s1.targetLanguage).toBe("ja");

    // Mutating returned object must not pollute cache.
    s1.neverTranslateSites.push("mutated.example");
    const s2 = await loadSettings();
    expect(getCalls.length).toBe(1);
    expect(s2.neverTranslateSites).toEqual([]);

    // Unrelated storage key change must NOT invalidate settings cache.
    for (const fn of changeListeners) fn({ hugeUnrelatedKey: { newValue: "updated" } }, "local");
    await loadSettings();
    expect(getCalls.length).toBe(1);

    // Relevant key change invalidates cache.
    store.targetLanguage = "zh-Hans";
    for (const fn of changeListeners) fn({ targetLanguage: { newValue: "zh-Hans" } }, "local");
    const s3 = await loadSettings();
    expect(getCalls.length).toBe(2);
    expect(s3.targetLanguage).toBe("zh-Hans");

    // Saving through saveDisplayMode invalidates cache immediately even without onChanged firing.
    await saveDisplayMode("translation");
    const s4 = await loadSettings();
    expect(getCalls.length).toBe(3);
    expect(s4.displayMode).toBe("translation");
  });
});

describe("PageTranslator detached DOM pruning and canvasHasVisualInk probe", () => {
  it("prunes detached records and disconnected shadow observers while preserving connected translations", async () => {
    document.body.innerHTML = `
      <main>
        <p id="keep">Keep this paragraph connected.</p>
        <p id="drop">Drop this paragraph after SPA navigation.</p>
      </main>
    `;
    const doc = document;
    const provider = {
      async translateHtml({ html }: { html: string }) {
        return `译:${html}`;
      },
    };
    const translator = new PageTranslator(doc, provider as any, { displayMode: "bilingual" });
    await translator.translateAll(doc.body);
    expect(translator.translatedCount).toBe(2);

    // Simulate SPA removing one paragraph.
    doc.getElementById("drop")!.remove();
    const pruned = translator.pruneDetachedEntries();
    expect(pruned).toBeGreaterThanOrEqual(1);
    expect(translator.translatedCount).toBe(1);

    // Connected paragraph still restores cleanly.
    translator.restore();
    expect(doc.querySelectorAll('[data-flt-generated="translation"]').length).toBe(0);
    expect(doc.getElementById("keep")!.textContent).toBe("Keep this paragraph connected.");
  });

  it("detects ink via 64x64 probe canvas without reading full source bitmap", () => {
    document.body.innerHTML = "";
    const doc = document;
    let sourceReadCalls = 0;
    const fakeSource = {
      width: 2400,
      height: 3200,
      ownerDocument: doc,
      getContext() {
        sourceReadCalls += 1;
        return null;
      },
    } as unknown as HTMLCanvasElement;

    const origCreate = doc.createElement.bind(doc);
    let drawBlank = true;
    vi.spyOn(doc, "createElement").mockImplementation(((tagName: string) => {
      const el = origCreate(tagName);
      if (tagName === "canvas") {
        (el as any).getContext = () => ({
          clearRect() {},
          fillRect() {},
          drawImage() {},
          fillStyle: "",
          getImageData(_x: number, _y: number, w: number, h: number) {
            const data = new Uint8ClampedArray(w * h * 4).fill(255);
            if (!drawBlank) {
              for (let i = 0; i < 10; i += 1) {
                const off = ((10 + i) * w + 10) * 4;
                data[off] = 20;
                data[off + 1] = 20;
                data[off + 2] = 20;
                data[off + 3] = 255;
              }
            }
            return { data };
          },
        });
      }
      return el;
    }) as typeof doc.createElement);

    expect(canvasHasVisualInk(fakeSource)).toBe(false);
    drawBlank = false;
    expect(canvasHasVisualInk(fakeSource)).toBe(true);
    expect(sourceReadCalls).toBe(0);
  });

  it("disconnects detached shadow-root observers during pruneDetachedEntries and deduplicates nested addedNodes", async () => {
    document.body.innerHTML = `<main id="root"></main>`;
    const doc = document;
    const translatedInputs: string[] = [];
    const provider = {
      async translateHtml({ html }: { html: string }) {
        translatedInputs.push(html);
        return `译:${html}`;
      },
    };
    const translator = new PageTranslator(doc, provider as any, { displayMode: "bilingual" });
    await translator.translateAll(doc.body);
    translator.observe();

    // Attach a custom shadow host and remove it after translating
    const host = doc.createElement("div");
    const shadow = host.attachShadow({ mode: "open" });
    const sp = doc.createElement("p");
    sp.textContent = "Shadow paragraph content inside component.";
    shadow.append(sp);
    doc.getElementById("root")!.append(host);
    await translator.translateAll(doc.body);
    expect(translator.translatedCount).toBe(1);

    // Detach shadow host and prune
    host.remove();
    const pruned = translator.pruneDetachedEntries();
    expect(pruned).toBeGreaterThanOrEqual(2);
    expect(translator.translatedCount).toBe(0);

    // Insert a nested container with child paragraphs -> verify no duplicate translation requests
    const beforeCount = translatedInputs.length;
    const container = doc.createElement("section");
    const p1 = doc.createElement("p");
    p1.textContent = "Unique dynamic nested paragraph alpha.";
    container.append(p1);
    doc.getElementById("root")!.append(container);
    await new Promise((r) => setTimeout(r, 80));
    expect(translatedInputs.filter((s) => s.includes("Unique dynamic nested paragraph alpha")).length).toBe(1);
    expect(translatedInputs.length).toBe(beforeCount + 1);

    translator.restore();
  });

  it("does not duplicate <pre> code blocks inside <li> in bilingual mode and mounts standalone <a> inside the original anchor", async () => {
    document.body.innerHTML = `
      <header style="display:flex">
        <a id="brand" class="btn" href="/" style="display:flex"><span>OpenClaw Docs</span></a>
        <a id="join" class="btn" href="/join" style="display:inline-flex"><svg></svg><span>Join community</span></a>
      </header>
      <main>
        <ul>
          <li id="step">Run the installer:<pre><code>npx openclaw@latest</code></pre></li>
        </ul>
      </main>
    `;
    const doc = document;
    const beforeHtml = doc.body.innerHTML;
    const provider = {
      prefersWholeSentenceHtml: async () => true,
      async translateHtml({ html }: { html: string }) {
        return html
          .replace("OpenClaw Docs", "OpenClaw 文档")
          .replace("Join community", "加入社区")
          .replace("Run the installer:", "运行安装程序：");
      },
    };
    const translator = new PageTranslator(doc, provider as any, { displayMode: "bilingual" });
    await translator.translateAll(doc.body);

    // <pre> must NOT be duplicated in bilingual mode!
    expect(doc.querySelectorAll("pre").length).toBe(1);
    expect(doc.querySelector("pre")!.textContent).toBe("npx openclaw@latest");

    // Standalone <a> links must NOT be cloned as extra flex siblings!
    expect(doc.querySelectorAll("a").length).toBe(2);
    expect(doc.querySelector("#brand .flt-translation")?.getAttribute("data-flt-control")).toBe("true");
    expect(doc.querySelector("#join .flt-translation")?.getAttribute("data-flt-control")).toBe("true");

    translator.restore();
    expect(doc.body.innerHTML).toBe(beforeHtml);
  });

  it("renders multi-line white-space: pre-wrap inline spans as block translations in bilingual mode", async () => {
    document.body.innerHTML = `
      <div class="mainTextContainer">
        <span id="story" style="display:inline;white-space:pre-wrap">First scene paragraph.\n\nSecond scene paragraph.</span>
      </div>
    `;
    const doc = document;
    const beforeHtml = doc.body.innerHTML;
    const provider = {
      prefersWholeSentenceHtml: async () => true,
      async translateHtml({ html }: { html: string }) {
        return html
          .replace("First scene paragraph.", "第一段剧情。")
          .replace("Second scene paragraph.", "第二段剧情。");
      },
    };
    const translator = new PageTranslator(doc, provider as any, { displayMode: "bilingual" });
    await translator.translateAll(doc.body);

    const translation = doc.querySelector<HTMLElement>(".flt-translation");
    expect(translation).not.toBeNull();
    expect(translation!.style.getPropertyValue("display")).toBe("block");

    translator.restore();
    expect(doc.body.innerHTML).toBe(beforeHtml);
  });

  it("restores detached translated nodes on prune so re-inserted SPA rows never stay stuck in translated text", async () => {
    document.body.innerHTML = `
      <ul id="list">
        <li id="row-1">First live row item.</li>
        <li id="row-2">Recycled virtualized row item.</li>
        <li id="row-3">Edited detached row item.</li>
      </ul>
      <input id="search" type="text" placeholder="Search items here" />
    `;
    const doc = document;
    const provider = {
      prefersWholeSentenceHtml: async () => true,
      async translateHtml({ html }: { html: string }) {
        return html
          .replace("First live row item.", "第一行列表内容。")
          .replace("Recycled virtualized row item.", "可复用的虚拟列表行。")
          .replace("Edited detached row item.", "待编辑的离屏列表行。")
          .replace("Search items here", "在此搜索项目");
      },
    };
    const translator = new PageTranslator(doc, provider as any, { displayMode: "translation" });
    await translator.translateAll(doc.body);

    const list = doc.getElementById("list")!;
    const row1 = doc.getElementById("row-1")!;
    const row2 = doc.getElementById("row-2")!;
    const row3 = doc.getElementById("row-3")!;
    const search = doc.getElementById("search")!;

    expect(row1.textContent).toBe("第一行列表内容。");
    expect(row2.textContent).toBe("可复用的虚拟列表行。");
    expect(row3.textContent).toBe("待编辑的离屏列表行。");
    expect(search.getAttribute("placeholder")).toBe("在此搜索项目");

    // Detach row-2, row-3, and search input; simulate SPA mutating detached row-3 text before prune.
    row2.remove();
    row3.remove();
    search.remove();
    row3.firstChild!.nodeValue = "Updated by SPA while detached.";

    const pruned = translator.pruneDetachedEntries();
    expect(pruned).toBeGreaterThanOrEqual(3);

    // Re-insert the exact same detached nodes without observer re-translation, then restore().
    list.append(row2, row3);
    doc.body.append(search);
    translator.restore();

    expect(row1.textContent).toBe("First live row item.");
    // Recycled row-2 MUST NOT remain stuck in Chinese!
    expect(row2.textContent).toBe("Recycled virtualized row item.");
    // SPA-updated row-3 preserves the site's own text!
    expect(row3.textContent).toBe("Updated by SPA while detached.");
    // Recycled search input placeholder MUST NOT remain stuck in Chinese!
    expect(search.getAttribute("placeholder")).toBe("Search items here");
  });

  it("clears display classes and nested translation nodes on detached #records elements during prune", async () => {
    document.body.innerHTML = `
      <ul id="list">
        <li id="rich-row">Open <a href="/docs">documentation</a> now.</li>
      </ul>
    `;
    const doc = document;
    const provider = {
      async translateHtml({ html }: { html: string }) {
        return html
          .replace("Open ", "打开")
          .replace("documentation", "文档")
          .replace(" now.", "。");
      },
    };
    const translator = new PageTranslator(doc, provider as any, { displayMode: "translation" });
    await translator.translateAll(doc.body);

    const list = doc.getElementById("list")!;
    const row = doc.getElementById("rich-row")!;
    expect(row.classList.contains("flt-source-list-hidden")).toBe(true);
    expect(row.querySelector('[data-flt-generated="translation"]')).not.toBeNull();

    row.remove();
    expect(translator.pruneDetachedEntries()).toBeGreaterThanOrEqual(1);

    // Re-inserted element has clean source DOM: no hidden class, no stale nested .flt-translation, no wrapper spans.
    list.append(row);
    expect(row.classList.contains("flt-source-list-hidden")).toBe(false);
    expect(row.querySelector('[data-flt-generated="translation"]')).toBeNull();
    expect(row.querySelector("[data-flt-source-text-wrapper]")).toBeNull();
    expect(row.textContent).toBe("Open documentation now.");

    translator.restore();
  });

  it("re-translates and cleanly restores a detached-pruned-reinserted row while observing", async () => {
    document.body.innerHTML = `<ul id="list"><li id="row">Dynamic virtual row.</li></ul>`;
    const doc = document;
    const provider = {
      prefersWholeSentenceHtml: async () => true,
      async translateHtml({ html }: { html: string }) {
        return html.replace("Dynamic virtual row.", "动态虚拟列表行。");
      },
    };
    const translator = new PageTranslator(doc, provider as any, { displayMode: "translation" });
    await translator.translateAll(doc.body);
    translator.observe();

    const list = doc.getElementById("list")!;
    const row = doc.getElementById("row")!;
    expect(row.textContent).toBe("动态虚拟列表行。");

    row.remove();
    translator.pruneDetachedEntries();
    expect(row.textContent).toBe("Dynamic virtual row.");

    list.append(row);
    await new Promise((r) => setTimeout(r, 80));
    expect(row.textContent).toBe("动态虚拟列表行。");

    translator.restore();
    expect(row.textContent).toBe("Dynamic virtual row.");
  });

  it("restores only display on hidden <a> links and preserves site-driven style, display, text, and placeholder updates", async () => {
    document.body.innerHTML = `
      <nav>
        <a id="styled-link" href="/docs" style="display: inline-flex; color: rgb(0, 0, 255);">Documentation</a>
        <a id="plain-link" href="/about">About us</a>
        <a id="colored-later-link" href="/blog">Engineering blog</a>
        <a id="detached-link" href="/pricing" style="color: rgb(10, 20, 30);">Pricing plans</a>
      </nav>
      <input id="filter" type="text" placeholder="Filter records" />
    `;
    const doc = document;
    const provider = {
      async translateHtml({ html }: { html: string }) {
        return html
          .replace("Documentation", "文档")
          .replace("About us", "关于我们")
          .replace("Engineering blog", "工程博客")
          .replace("Pricing plans", "价格方案")
          .replace("Filter records", "筛选记录");
      },
    };
    const translator = new PageTranslator(doc, provider as any, { displayMode: "translation" });

    const styledLink = doc.getElementById("styled-link") as HTMLAnchorElement;
    const plainLink = doc.getElementById("plain-link") as HTMLAnchorElement;
    const coloredLaterLink = doc.getElementById("colored-later-link") as HTMLAnchorElement;
    const detachedLink = doc.getElementById("detached-link") as HTMLAnchorElement;
    const filter = doc.getElementById("filter") as HTMLInputElement;

    await Promise.all([
      translator.translateRoot(styledLink),
      translator.translateRoot(plainLink),
      translator.translateRoot(coloredLaterLink),
      translator.translateRoot(detachedLink),
      translator.translateAll(filter.parentElement!),
    ]);

    expect(styledLink.style.getPropertyValue("display")).toBe("none");
    expect(styledLink.style.getPropertyPriority("display")).toBe("important");
    expect(plainLink.style.getPropertyValue("display")).toBe("none");
    expect(coloredLaterLink.style.getPropertyValue("display")).toBe("none");
    expect(detachedLink.style.getPropertyValue("display")).toBe("none");
    expect(filter.getAttribute("placeholder")).toBe("筛选记录");

    // Simulate website dynamically updating colors, opacity, display, and placeholder while translated.
    styledLink.style.color = "rgb(220, 38, 38)";
    styledLink.style.opacity = "0.6";
    plainLink.style.display = "block";
    coloredLaterLink.style.color = "rgb(1, 2, 3)";
    detachedLink.style.color = "rgb(16, 185, 129)";
    filter.setAttribute("placeholder", "Search updated by site");

    // Detach and prune detachedLink -> removes our display:none!important while keeping site's new green color.
    detachedLink.remove();
    translator.pruneDetachedEntries();
    expect(detachedLink.style.getPropertyValue("display")).toBe("");
    expect(detachedLink.style.color).toBe("rgb(16, 185, 129)");
    expect(detachedLink.hasAttribute("data-flt-source-link-hidden")).toBe(false);

    // Restore live document -> styledLink gets original display:inline-flex back AND keeps site's red color + opacity;
    // plainLink keeps site's display:block; coloredLaterLink loses display:none while keeping its newly added color;
    // filter keeps site's new placeholder.
    translator.restore();
    expect(styledLink.style.display).toBe("inline-flex");
    expect(styledLink.style.color).toBe("rgb(220, 38, 38)");
    expect(styledLink.style.opacity).toBe("0.6");
    expect(plainLink.style.display).toBe("block");
    expect(coloredLaterLink.style.getPropertyValue("display")).toBe("");
    expect(coloredLaterLink.style.color).toBe("rgb(1, 2, 3)");
    expect(filter.getAttribute("placeholder")).toBe("Search updated by site");

    // Also verify fixed-text mode preserves site-driven text updates on restore.
    doc.body.innerHTML = `<p id="live-copy">Original server status.</p>`;
    const fixedProvider = {
      prefersWholeSentenceHtml: () => true,
      async translateHtml({ html }: { html: string }) {
        return html.replace("Original server status.", "原始服务器状态。");
      },
    };
    const fixedTranslator = new PageTranslator(doc, fixedProvider as any, { displayMode: "translation" });
    await fixedTranslator.translateAll(doc.body);
    const liveCopy = doc.getElementById("live-copy")!;
    expect(liveCopy.textContent).toBe("原始服务器状态。");
    liveCopy.firstChild!.nodeValue = "Live updated server status.";
    fixedTranslator.restore();
    expect(liveCopy.textContent).toBe("Live updated server status.");
  });
});

describe("Lazy PDF viewport scheduling and bounded canvas eviction", () => {
  function makePage(pageNumber: number, overrides: Partial<LazyPdfPageState> = {}): LazyPdfPageState {
    return {
      pageNumber,
      baseRendered: false,
      isCanvasVisible: false,
      lastUsedSeq: pageNumber,
      needsSnapshotHydration: false,
      needsScanCheck: false,
      canvasBytes: 4 * 1024 * 1024,
      ...overrides,
    };
  }

  it("checks vertical proximity with preload margin and rejects zero-height containers", () => {
    const viewport = { top: 100, bottom: 900 };
    expect(isRectNearVerticalWindow({ top: 200, bottom: 800 }, viewport, 900)).toBe(true);
    expect(isRectNearVerticalWindow({ top: 1750, bottom: 2500 }, viewport, 900)).toBe(true);
    expect(isRectNearVerticalWindow({ top: 1850, bottom: 2600 }, viewport, 900)).toBe(false);
    expect(isRectNearVerticalWindow({ top: 200, bottom: 800 }, { top: 0, bottom: 0 }, 900)).toBe(false);
  });

  it("prioritizes urgent pages, then closest visible page, and drops fast-scrolled-past non-urgent pages", () => {
    const p2 = makePage(2, { isCanvasVisible: false });
    const p10 = makePage(10, { isCanvasVisible: true });
    const p11 = makePage(11, { isCanvasVisible: true });
    const p20 = makePage(20, { isCanvasVisible: false, needsSnapshotHydration: true });
    const p30 = makePage(30, { isCanvasVisible: false });

    const pending = new Set([p2, p10, p11, p20, p30]);
    const urgent = new Set([p30]);
    const centers = new Map([
      [p2, -2000],
      [p10, 800],
      [p11, 410],
      [p20, 4000],
      [p30, 8000],
    ]);

    // 1. Urgent page wins first, and stale p2 (scrolled past, non-urgent, no hydration) is pruned immediately.
    expect(pickNextLazyPdfPage(pending, urgent, 400, (p) => centers.get(p)!)).toBe(p30);
    expect(pending.has(p2)).toBe(false);

    pending.delete(p30);
    urgent.delete(p30);
    // 2. Visible page closest to viewport center (p11 at 410 vs p10 at 800) wins next.
    expect(pickNextLazyPdfPage(pending, urgent, 400, (p) => centers.get(p)!)).toBe(p11);

    pending.delete(p11);
    expect(pickNextLazyPdfPage(pending, urgent, 400, (p) => centers.get(p)!)).toBe(p10);

    pending.delete(p10);
    // 3. Page needing snapshot hydration runs as fallback.
    expect(pickNextLazyPdfPage(pending, urgent, 400, (p) => centers.get(p)!)).toBe(p20);
  });

  it("evicts farthest non-visible canvases by both count cap and total pixel-byte budget (including snapshots)", () => {
    expect(canvasPixelBytes({ width: 1000, height: 1500 })).toBe(6_000_000);
    expect(canvasPixelBytes({ width: 0, height: 100 })).toBe(0);

    const pages: LazyPdfPageState[] = [];
    for (let i = 1; i <= 15; i += 1) {
      pages.push(makePage(i, {
        baseRendered: i <= 13,
        isCanvasVisible: i >= 12 && i <= 13,
        lastUsedSeq: i,
        canvasBytes: 4 * 1024 * 1024,
      }));
    }

    // Count cap: 13 rendered - 10 max = 3 farthest pages evicted (pages 1, 2, 3), never visible pages 12..13.
    const countVictims = selectPdfPagesToEvict(pages, 13, { maxRendered: MAX_RENDERED_PDF_CANVASES, maxBytes: MAX_PDF_CANVAS_BUDGET_BYTES });
    expect(countVictims.map((p) => p.pageNumber)).toEqual([1, 2, 3]);
    expect(countVictims.some((p) => p.isCanvasVisible)).toBe(false);

    // Byte budget cap: 5 HiDPI overlay pages * 30 MiB = 150 MiB (+ 16 MiB right-pane snapshots = 166 MiB > 96 MiB).
    // Even though 5 <= 10 count cap, byte budget evicts farthest non-visible pages 1, 2, 3 (leaving visible 4 & 5 = 60 + 16 = 76 MiB).
    const heavyOverlayPages = [1, 2, 3, 4, 5].map((num) => makePage(num, {
      baseRendered: true,
      isCanvasVisible: num >= 4,
      lastUsedSeq: num,
      canvasBytes: 30 * 1024 * 1024,
    }));
    const byteVictims = selectPdfPagesToEvict(heavyOverlayPages, 5, {
      maxRendered: MAX_RENDERED_PDF_CANVASES,
      maxBytes: MAX_PDF_CANVAS_BUDGET_BYTES,
      snapshotBytes: 16 * 1024 * 1024,
    });
    expect(byteVictims.map((p) => p.pageNumber)).toEqual([1, 2, 3]);
    expect(byteVictims.some((p) => p.isCanvasVisible)).toBe(false);
  });
});

describe("Bergamot download dedup/timeout, VideoSubtitleManager DOM filtering, and legacy settings migration", () => {
  it("deduplicates concurrent model asset downloads, returns isolated ArrayBuffers, and aborts on timeout", async () => {
    const payload = new Uint8Array([10, 20, 30, 40, 50, 60, 70, 80]);
    const digest = await crypto.subtle.digest("SHA-256", payload);
    const sha256 = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
    const asset = {
      type: "vocab" as const,
      url: "https://models.example/vocab.bin",
      bytes: payload.byteLength,
      sha256,
      alignment: 64 as const,
      compression: "none" as unknown as "zstd",
    } satisfies BergamotModelAsset;

    const cacheStore = new Map<string, Response>();
    (globalThis as { caches?: unknown }).caches = {
      async open() {
        return {
          async match(url: string) { return cacheStore.get(url)?.clone(); },
          async put(url: string, res: Response) { cacheStore.set(url, res); },
          async delete(url: string) { cacheStore.delete(url); },
        };
      },
    };

    let fetchCalls = 0;
    let releaseFetch!: () => void;
    const gate = new Promise<void>((resolve) => { releaseFetch = resolve; });
    vi.spyOn(globalThis, "fetch").mockImplementation((async () => {
      fetchCalls += 1;
      await gate;
      return new Response(payload.slice(), { status: 200 });
    }) as typeof fetch);

    const p1 = loadModelAsset(asset, 5000);
    const p2 = loadModelAsset(asset, 5000);
    await new Promise((r) => setTimeout(r, 10));
    releaseFetch();
    const [buf1, buf2] = await Promise.all([p1, p2]);

    expect(fetchCalls).toBe(1);
    expect(buf1).not.toBe(buf2);
    expect(new Uint8Array(buf1)).toEqual(payload);
    expect(new Uint8Array(buf2)).toEqual(payload);

    // Stalled model asset times out cleanly.
    const slowAsset: BergamotModelAsset = { ...asset, url: "https://models.example/slow-vocab.bin" };
    vi.spyOn(globalThis, "fetch").mockImplementation(((_url: unknown, init?: RequestInit) => new Promise<Response>((_res, rej) => {
      init?.signal?.addEventListener("abort", () => rej(new DOMException("Aborted", "AbortError")));
    })) as typeof fetch);
    await expect(loadModelAsset(slowAsset, 30)).rejects.toThrow(/timed out/);

    // Stalled metadata fetch in fetchLatestPairs also times out cleanly.
    await expect(fetchLatestPairs(["en->zh-Hans"], 30)).rejects.toThrow(/timed out/);
    delete (globalThis as { caches?: unknown }).caches;
  });

  it("ignores non-video and PageLingo-generated DOM churn in VideoSubtitleManager MutationObserver", async () => {
    document.body.innerHTML = `<main id="article"><p>Plain webpage with no video.</p></main>`;
    const querySpy = vi.spyOn(document, "querySelectorAll");
    const manager = new VideoSubtitleManager({
      doc: document,
      platformFn: () => "html5",
      loadSettingsFn: async () => ({
        ...DEFAULT_SETTINGS,
        videoSubtitle: {
          ...DEFAULT_SETTINGS.videoSubtitle,
          enabled: true,
        },
      }),
    });

    await manager.start();
    const callsAfterStart = querySpy.mock.calls.filter(([sel]) => sel === "video").length;
    expect(callsAfterStart).toBe(1);

    // Insert non-video prose and PageLingo-generated translation nodes -> must NOT trigger video rescans!
    const main = document.getElementById("article")!;
    const p = document.createElement("p");
    p.textContent = "Dynamic paragraph with no video.";
    const trans = document.createElement("span");
    trans.dataset.fltGenerated = "translation";
    trans.textContent = "译文节点";
    main.append(p, trans);

    await new Promise((r) => setTimeout(r, 240));
    const callsAfterNonVideoChurn = querySpy.mock.calls.filter(([sel]) => sel === "video").length;
    expect(callsAfterNonVideoChurn).toBe(1);

    // Inserting a real <video> element DOES trigger a scan.
    const video = document.createElement("video");
    main.append(video);
    await new Promise((r) => setTimeout(r, 240));
    const callsAfterVideoInsert = querySpy.mock.calls.filter(([sel]) => sel === "video").length;
    expect(callsAfterVideoInsert).toBeGreaterThanOrEqual(2);

    manager.dispose();
  });

  it("migrates legacy terminologyText and excludedSites in loadSettings without exposing terminologyText at runtime", async () => {
    invalidateSettingsCache();
    const store: Record<string, unknown> = {
      excludedSites: ["Legacy.Example"],
      terminologyText: "OpenClaw => 开放爪\nPageLingo = 译页",
    };
    const prevBrowser = (globalThis as { browser?: unknown }).browser;
    (globalThis as { browser?: unknown }).browser = {
      storage: {
        local: {
          async get(keys?: unknown) {
            const list = Array.isArray(keys) ? keys : Object.keys(store);
            const result: Record<string, unknown> = {};
            for (const key of list) if (key in store) result[key] = store[key];
            return result;
          },
          async set(patch: Record<string, unknown>) {
            Object.assign(store, patch);
          },
        },
        onChanged: { addListener() {} },
      },
    };

    try {
      const settings = await loadSettings();
      expect(settings.neverTranslateSites).toEqual(["legacy.example"]);
      expect(settings.glossaryCollections.length).toBe(1);
      expect(settings.glossaryCollections[0]!.entries).toEqual([
        { source: "OpenClaw", target: "开放爪", mode: "replace", caseSensitive: false },
        { source: "PageLingo", target: "译页", mode: "replace", caseSensitive: false },
      ]);
      expect("terminologyText" in settings).toBe(false);
    } finally {
      invalidateSettingsCache();
      (globalThis as { browser?: unknown }).browser = prevBrowser;
    }
  });
});


