import { afterEach, describe, expect, it, vi } from "vitest";
import { collectTranslationRoots, collectTranslationRootsAsync } from "../src/core/dom-policy";
import { PageTranslator } from "../src/core/page-translator";
import { freezeNavigationLayout, restoreNavigationLayout } from "../src/core/navigation-layout";
import { sourceTextSample } from "../src/shared/source-text-sample";
import type { TranslationProvider } from "../src/core/provider";

function flushAsync(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 25));
}

describe("Large-page performance invariants", () => {
  afterEach(() => {
    restoreNavigationLayout();
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("skips closed <details> bodies during collection and translates them lazily when opened", async () => {
    document.body.innerHTML = `
      <main>
        <h1>Release Notes</h1>
        <details id="big-section">
          <summary><span>Web chat and dashboard</span><svg aria-hidden="true"></svg></summary>
          <div class="oc-accordion-content">
            <p id="hidden-p1">Fixes prompt recall skipping older messages.</p>
            <p id="hidden-p2">Fixes audio transcripts appearing blank.</p>
          </div>
        </details>
      </main>
    `;

    const syncRoots = collectTranslationRoots(document.body, { preserveInlineContext: true });
    const asyncRoots = await collectTranslationRootsAsync(document.body, { preserveInlineContext: true });
    const hiddenP1 = document.getElementById("hidden-p1")!;
    const hiddenP2 = document.getElementById("hidden-p2")!;
    const summary = document.querySelector("summary")!;

    expect(syncRoots).toContain(summary);
    expect(syncRoots).not.toContain(hiddenP1);
    expect(syncRoots).not.toContain(hiddenP2);
    expect(asyncRoots).toEqual(syncRoots);

    const translatedInputs: string[] = [];
    const provider: TranslationProvider = {
      prefersWholeSentenceHtml: async () => true,
      prefersLazyOffscreen: async () => true,
      translateHtml: async ({ html }) => {
        translatedInputs.push(html);
        return html
          .replace("Release Notes", "发布说明")
          .replace("Web chat and dashboard", "网页聊天与仪表盘")
          .replace("Fixes prompt recall skipping older messages.", "修复提示词回溯跳过旧消息的问题。")
          .replace("Fixes audio transcripts appearing blank.", "修复音频转写显示为空白的问题。");
      },
    };

    const translator = new PageTranslator(document, provider, {
      sourceLanguage: "en",
      targetLanguage: "zh-Hans",
      displayMode: "translation",
    });
    await translator.translateAll(document.body, true);

    expect(document.querySelector("h1")?.textContent).toBe("发布说明");
    expect(summary.textContent).toContain("网页聊天与仪表盘");
    // Closed <details> body paragraphs must NOT be translated before opening.
    expect(hiddenP1.textContent).toBe("Fixes prompt recall skipping older messages.");
    expect(hiddenP2.textContent).toBe("Fixes audio transcripts appearing blank.");

    // Opening the <details> translates its newly revealed paragraphs.
    const details = document.getElementById("big-section") as HTMLDetailsElement;
    details.open = true;
    details.dispatchEvent(new Event("toggle"));
    await flushAsync();

    expect(hiddenP1.textContent).toBe("修复提示词回溯跳过旧消息的问题。");
    expect(hiddenP2.textContent).toBe("修复音频转写显示为空白的问题。");

    translator.restore();
    expect(hiddenP1.textContent).toBe("Fixes prompt recall skipping older messages.");
  });

  it("never calls getAnimations() on display:none, [hidden], svg[aria-hidden], or closed <details> elements", async () => {
    document.body.innerHTML = `
      <main>
        <p>Visible intro paragraph.</p>
        <svg id="icon" aria-hidden="true"><path d="M0 0"></path></svg>
        <div id="attr-hidden" hidden><p>Attr hidden text.</p></div>
        <div id="css-hidden" style="display: none"><p>Display none text.</p></div>
        <details id="closed-det">
          <summary>Section</summary>
          <div id="closed-body"><p>Inside closed details.</p></div>
        </details>
        <p id="fade-target" style="opacity: 0">Fading paragraph.</p>
      </main>
    `;

    const calledOn: string[] = [];
    for (const id of ["icon", "attr-hidden", "css-hidden", "closed-body", "fade-target"]) {
      const el = document.getElementById(id)!;
      Object.defineProperty(el, "getAnimations", {
        configurable: true,
        value: () => {
          calledOn.push(id);
          return [];
        },
      });
    }

    const provider: TranslationProvider = {
      prefersWholeSentenceHtml: async () => true,
      translateHtml: async ({ html }) => html.replace("Visible intro paragraph.", "可见介绍段落。"),
    };
    const translator = new PageTranslator(document, provider, {
      sourceLanguage: "en",
      targetLanguage: "zh-Hans",
      displayMode: "translation",
    });
    await translator.translateAll(document.body, false);

    expect(calledOn).toEqual(["fade-target"]);
    translator.restore();
  });

  it("batches bilingual commit and setDisplayMode style reads before DOM mutations (zero read/write thrashing)", async () => {
    document.body.innerHTML = `
      <main>
        <p id="p1" style="font-size: 16px; color: rgb(20, 30, 40)">Hello <a href="/a">world</a> today.</p>
        <p id="p2" style="font-size: 18px; color: rgb(30, 40, 50)">Second <a href="/b">paragraph</a> here.</p>
        <p id="p3" style="font-size: 20px; color: rgb(40, 50, 60)">Third <a href="/c">sentence</a> now.</p>
      </main>
    `;

    const pendingBatch: Array<{ html: string; resolve: (value: string) => void }> = [];
    const provider: TranslationProvider = {
      prefersWholeSentenceHtml: async () => true,
      concurrentSegments: async () => 8,
      translateHtml: ({ html }) => new Promise((resolve) => {
        pendingBatch.push({ html, resolve });
      }),
    };

    const translator = new PageTranslator(document, provider, {
      sourceLanguage: "en",
      targetLanguage: "zh-Hans",
      displayMode: "bilingual",
    });

    const events: string[] = [];
    const origGCS = window.getComputedStyle.bind(window);
    const origAppend = Element.prototype.append;
    let recordEvents = false;

    vi.spyOn(window, "getComputedStyle").mockImplementation((el, pseudo) => {
      if (recordEvents) events.push("read");
      return origGCS(el, pseudo);
    });
    vi.spyOn(Element.prototype, "append").mockImplementation(function (this: Element, ...nodes: (Node | string)[]) {
      if (recordEvents && nodes.some((n) => n instanceof Element && n.classList.contains("flt-translation"))) {
        events.push("write");
      }
      return origAppend.apply(this, nodes);
    });

    const done = translator.translateAll(document.body, false);
    await flushAsync();
    expect(pendingBatch.length).toBe(3);

    // Resolve all 3 roots simultaneously like RuntimeMessageProvider.#flushChunk().
    recordEvents = true;
    for (const item of pendingBatch) {
      item.resolve(
        item.html
          .replace("Hello ", "你好 ")
          .replace("world", "世界")
          .replace(" today.", " 今天。")
          .replace("Second ", "第二 ")
          .replace("paragraph", "段落")
          .replace(" here.", " 在这里。")
          .replace("Third ", "第三 ")
          .replace("sentence", "句子")
          .replace(" now.", " 现在。"),
      );
    }
    await done;
    recordEvents = false;

    const firstWriteIdx = events.indexOf("write");
    const lastReadIdx = events.lastIndexOf("read");
    expect(firstWriteIdx).toBeGreaterThan(0);
    expect(lastReadIdx).toBeLessThan(firstWriteIdx);
    expect(document.querySelectorAll(".flt-translation").length).toBe(3);

    // Also verify switching bilingual -> translation -> bilingual does zero reads after writes.
    events.length = 0;
    recordEvents = true;
    translator.setDisplayMode("translation");
    recordEvents = false;
    expect(document.querySelectorAll(".flt-translation").length).toBe(0);

    events.length = 0;
    recordEvents = true;
    translator.setDisplayMode("bilingual");
    recordEvents = false;
    const modeFirstWrite = events.indexOf("write");
    const modeLastRead = events.lastIndexOf("read");
    expect(modeFirstWrite).toBeGreaterThan(0);
    expect(modeLastRead).toBeLessThan(modeFirstWrite);
    expect(document.querySelectorAll(".flt-translation").length).toBe(3);

    translator.restore();
  });

  it("freezeNavigationLayout batches reads before writes and skips closed <details> and vertical sidebars", () => {
    document.body.innerHTML = `
      <nav id="top-nav" style="display: flex; flex-direction: row;">
        <a id="top-a" href="/a">Docs</a>
        <a id="top-b" href="/b">API</a>
      </nav>
      <nav id="side-nav" style="display: flex; flex-direction: column;">
        <a id="side-a" href="/s1">Sidebar 1</a>
        <details>
          <summary>More</summary>
          <a id="closed-a" href="/s2">Hidden link</a>
        </details>
      </nav>
    `;

    const order: string[] = [];
    for (const id of ["top-a", "top-b", "side-a", "closed-a"]) {
      const el = document.getElementById(id)!;
      vi.spyOn(el, "getBoundingClientRect").mockImplementation(() => {
        order.push(`read:${id}`);
        return { width: 80, height: 24, top: 0, left: 0, right: 80, bottom: 24, x: 0, y: 0, toJSON() {} } as DOMRect;
      });
    }
    const origSetProp = CSSStyleDeclaration.prototype.setProperty;
    vi.spyOn(CSSStyleDeclaration.prototype, "setProperty").mockImplementation(function (
      this: CSSStyleDeclaration,
      prop: string,
      value: string | null,
      priority?: string,
    ) {
      if (prop === "min-inline-size") order.push("write");
      return origSetProp.call(this, prop, value, priority);
    });

    freezeNavigationLayout();

    // Vertical sidebar and closed <details> links must never trigger getBoundingClientRect().
    expect(order).not.toContain("read:side-a");
    expect(order).not.toContain("read:closed-a");
    // All reads must happen strictly before the first inline style write.
    const firstWrite = order.indexOf("write");
    const lastRead = order.map((e, i) => (e.startsWith("read:") ? i : -1)).reduce((a, b) => Math.max(a, b), -1);
    expect(firstWrite).toBeGreaterThan(0);
    expect(lastRead).toBeLessThan(firstWrite);
  });

  it("sourceTextSample skips closed <details>, code blocks, and hidden regions", () => {
    document.body.innerHTML = `
      <main>
        <p>Visible release summary.</p>
        <pre><code>const ignoredCode = true;</code></pre>
        <details>
          <summary>Visible summary title</summary>
          <p>Hidden accordion body that should be skipped.</p>
        </details>
      </main>
    `;

    const sample = sourceTextSample(document, 4096);
    expect(sample).toContain("Visible release summary.");
    expect(sample).toContain("Visible summary title");
    expect(sample).not.toContain("ignoredCode");
    expect(sample).not.toContain("Hidden accordion body");
  });
});
