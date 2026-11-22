import { afterEach, describe, expect, it } from "vitest";
import { PageTranslator } from "../src/core/page-translator";
import type { TranslationProvider, TranslationRequest } from "../src/core/provider";

class FakeHtmlProvider implements TranslationProvider {
  requests: TranslationRequest[] = [];

  async translateHtml(request: TranslationRequest): Promise<string> {
    this.requests.push(request);
    const template = document.createElement("template");
    template.innerHTML = request.html;
    const walker = document.createTreeWalker(template.content, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node) {
      const text = node.textContent?.trim() ?? "";
      if (text && !/^__FLT_LINK_(?:START|END)_\d+__$/.test(text)) node.textContent = `译:${node.textContent}`;
      node = walker.nextNode();
    }
    const holder = document.createElement("div");
    holder.append(template.content.cloneNode(true));
    return holder.innerHTML;
  }
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("PageTranslator DOM preservation", () => {
  it("keeps original node identity, href and event listeners intact", async () => {
    document.body.innerHTML = `<p id="p">Read the <a id="link" href="/docs" target="_blank">documentation</a> now.</p>`;
    const paragraph = document.querySelector<HTMLElement>("#p")!;
    const link = document.querySelector<HTMLAnchorElement>("#link")!;
    const originalChildren = Array.from(paragraph.childNodes);
    let clicks = 0;
    link.addEventListener("click", (event) => { event.preventDefault(); clicks += 1; });

    const provider = new FakeHtmlProvider();
    const translator = new PageTranslator(document, provider);
    await translator.translateAll();

    expect(document.querySelector("#p")).toBe(paragraph);
    expect(document.querySelector("#link")).toBe(link);
    expect(Array.from(paragraph.childNodes)).toEqual(originalChildren);
    expect(link.getAttribute("href")).toBe("/docs");
    link.click();
    expect(clicks).toBe(1);

    const translatedLink = document.querySelector<HTMLAnchorElement>(".flt-translation a");
    expect(translatedLink?.getAttribute("href")).toBe("/docs");
    expect(translatedLink?.getAttribute("target")).toBe("_blank");
  });

  it("preserves inline formatting and restores code exactly", async () => {
    document.body.innerHTML = `<p>Use <strong>fast mode</strong> with <code>npm run build</code>.</p>`;
    const provider = new FakeHtmlProvider();
    const translator = new PageTranslator(document, provider);
    await translator.translateAll();

    const translated = document.querySelector<HTMLElement>(".flt-translation")!;
    expect(translated.querySelector("strong")?.textContent).toContain("译:");
    expect(translated.querySelector("code")?.textContent).toBe("npm run build");
    expect(provider.requests[0]?.html).toContain("__FLT_OPAQUE_0__");
  });

  it("keeps code language captions while translating neighboring prose", async () => {
    document.body.innerHTML = `<figure data-code-label="powershell"><figcaption><span>powershell</span><button>Copy code</button></figcaption><div><pre><code>Get-Location</code></pre></div></figure><p>Start the shell.</p>`;
    const figure = document.querySelector("figure")!;
    const source = figure.outerHTML;
    const provider = new FakeHtmlProvider();
    const translator = new PageTranslator(document, provider, { targetLanguage: "zh-Hans" });

    await translator.translateAll();

    expect(figure.outerHTML).toBe(source);
    expect(provider.requests.map(({ html }) => html)).toEqual(["Start the shell."]);
    translator.restore();
    expect(figure.outerHTML).toBe(source);
  });

  it("keeps a literal file path link while translating its neighboring prose and descriptive links", async () => {
    const href = "https://github.com/python/cpython/blob/main/Lib/async%69o/queues.py?plain=1#L55";
    document.body.innerHTML = `<p>Source code: <a id="file" href="${href}"><span>Lib/</span>asyncio/queues.py</a>. Read the <a id="guide" href="${href}">queue implementation</a>.</p>`;
    const before = document.body.innerHTML;
    const file = document.querySelector<HTMLAnchorElement>("#file")!;
    const originalChildren = [...file.childNodes];
    const requests: string[] = [];
    const provider: TranslationProvider = {
      prefersWholeSentenceHtml: async () => true,
      translateHtml: async ({ html }) => {
        requests.push(html);
        const { body } = new DOMParser().parseFromString(html, "text/html");
        for (const slot of body.querySelectorAll("[data-flt-text-id]")) {
          slot.textContent = slot.textContent!.replace("Source code", "源代码").replace("Read the", "阅读").replace("queue implementation", "队列实现");
        }
        return body.innerHTML;
      },
    };
    const translator = new PageTranslator(document, provider, { targetLanguage: "zh-Hans" });
    await translator.translateAll();

    const { body } = new DOMParser().parseFromString(requests[0]!, "text/html");
    expect(body.querySelector("code")?.textContent).toBe("__FLT_OPAQUE_0__");
    expect(requests[0]).not.toContain("asyncio/queues.py");
    expect(file.textContent).toBe("Lib/asyncio/queues.py");
    expect([...file.childNodes]).toEqual(originalChildren);
    expect(file.getAttribute("href")).toBe(href);
    expect(document.body.textContent).toContain("源代码");
    expect(document.querySelector("#guide")?.textContent).toBe("队列实现");

    translator.setDisplayMode("bilingual");
    expect(file.textContent).toBe("Lib/asyncio/queues.py");
    translator.restore();
    expect(document.body.innerHTML).toBe(before);
  });

  it("marks generated translations with the actual target language", async () => {
    document.body.innerHTML = `<p>Hello world.</p>`;
    const translator = new PageTranslator(document, new FakeHtmlProvider(), { targetLanguage: "es" });
    await translator.translateAll();

    expect(document.querySelector<HTMLElement>(".flt-translation")?.lang).toBe("es");
  });

  it("removes generated nodes and temporary anchor wrappers on restore", async () => {
    document.body.innerHTML = `<section><p id="p">Hello <a href="/docs">linked text</a>.</p></section>`;
    const before = document.querySelector("section")!.innerHTML;
    const paragraph = document.querySelector("#p");
    const translator = new PageTranslator(document, new FakeHtmlProvider());
    await translator.translateAll();
    expect(document.querySelector(".flt-translation")).not.toBeNull();
    expect(document.querySelector("[data-flt-source-text-wrapper]")).not.toBeNull();

    translator.restore();
    expect(document.querySelector("section")!.innerHTML).toBe(before);
    expect(document.querySelector("#p")).toBe(paragraph);
  });

  it("translates dynamically inserted content without recursively translating generated nodes", async () => {
    document.body.innerHTML = `<main id="main"><p>First paragraph.</p></main>`;
    const provider = new FakeHtmlProvider();
    const translator = new PageTranslator(document, provider);
    await translator.translateAll();
    translator.observe();

    const next = document.createElement("p");
    next.textContent = "Second paragraph.";
    document.querySelector("#main")!.append(next);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(next.nextElementSibling?.classList.contains("flt-translation")).toBe(true);
    expect(document.querySelectorAll(".flt-translation .flt-translation")).toHaveLength(0);
    expect(provider.requests.length).toBe(2);
    translator.restore();
  });

  it("does not translate form controls, scripts, preformatted code or CSS-hidden content", async () => {
    document.body.innerHTML = `<button>Click me</button><pre>const x = 1;</pre><div style="display:none"><h1>Hidden title</h1></div><p>Translate me.</p>`;
    const provider = new FakeHtmlProvider();
    const translator = new PageTranslator(document, provider);
    await translator.translateAll();

    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]?.html).toContain("Translate me.");
  });

  it("does not translate screen-reader-only headings hidden by clipping", async () => {
    document.head.innerHTML = `<style>
      .sr-only {
        position: absolute;
        width: 1px;
        height: 1px;
        padding: 0;
        margin: -1px;
        overflow: hidden;
        clip: rect(0, 0, 0, 0);
        white-space: nowrap;
        border: 0;
      }
    </style>`;
    document.body.innerHTML = `<h2 class="sr-only">Latest commit</h2><p>Visible repository description.</p>`;
    const provider = new FakeHtmlProvider();
    const translator = new PageTranslator(document, provider, { displayMode: "translation" });
    await translator.translateAll();

    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]?.html).toContain("Visible repository description.");
    expect(provider.requests[0]?.html).not.toContain("Latest commit");
    expect(document.querySelector("h2.sr-only")?.nextElementSibling?.classList.contains("flt-translation")).not.toBe(true);
  });

  it("does not retranslate link labels or gaps when main HTML preserves link transport", async () => {
    document.body.innerHTML = `<p>Read <a href="/docs">documentation</a> and <a href="/guide">guide</a> now.</p>`;
    const provider = new FakeHtmlProvider();
    const translator = new PageTranslator(document, provider);
    const paragraph = document.querySelector<HTMLElement>("p")!;
    await translator.translateRoot(paragraph);

    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]?.html).toContain(">documentation<");
    expect(provider.requests[0]?.html).toContain(">guide<");
    const links = Array.from(document.querySelectorAll<HTMLAnchorElement>(".flt-translation a"));
    expect(links.map((link) => link.getAttribute("href"))).toEqual(["/docs", "/guide"]);
    expect(links.map((link) => link.textContent)).toEqual(["译:documentation", "译:guide"]);
  });

  it("keeps translated words outside the clickable link when the engine absorbs them around intact boundaries", async () => {
    document.body.innerHTML = `<p>Read the <a href="/docs">documentation</a> now.</p>`;
    class AbsorbingProvider implements TranslationProvider {
      requests: TranslationRequest[] = [];
      async translateHtml(request: TranslationRequest): Promise<string> {
        this.requests.push(request);
        return `<a data-flt-link-id="0" href="https://pagelingo.invalid/__link/0">阅读 <code>__FLT_LINK_START_0__</code><strong>文档</strong><code>__FLT_LINK_END_0__</code> 现在</a>`;
      }
    }
    const provider = new AbsorbingProvider();
    const translator = new PageTranslator(document, provider);
    const paragraph = document.querySelector<HTMLElement>("p")!;
    await translator.translateRoot(paragraph);

    expect(provider.requests).toHaveLength(1);
    const translated = document.querySelector<HTMLElement>(".flt-translation")!;
    const link = translated.querySelector<HTMLAnchorElement>("a")!;
    expect(link.getAttribute("href")).toBe("/docs");
    expect(link.textContent).toBe("文档");
    expect(link.querySelector("strong")?.textContent).toBe("文档");
    expect(translated.textContent).toContain("阅读");
    expect(translated.textContent).toContain("现在");
  });

  it("falls back safely when link boundaries are damaged instead of keeping an expanded anchor", async () => {
    document.body.innerHTML = `<p>Read the <a href="/docs">documentation</a> now.</p>`;
    class DamagedBoundaryProvider implements TranslationProvider {
      requests: TranslationRequest[] = [];
      async translateHtml(request: TranslationRequest): Promise<string> {
        this.requests.push(request);
        if (request.html.includes("__FLT_LINK_START_0__")) {
          return `阅读<a data-flt-link-id="0" href="https://pagelingo.invalid/__link/0">文档现在</a>`;
        }
        if (request.html.trim() === "documentation") return "文档";
        if (request.html.trim() === "Read the") return "阅读";
        if (request.html.trim() === "now.") return "现在。";
        return request.html;
      }
    }
    const provider = new DamagedBoundaryProvider();
    const translator = new PageTranslator(document, provider);
    const paragraph = document.querySelector<HTMLElement>("p")!;
    await translator.translateRoot(paragraph);

    expect(provider.requests).toHaveLength(4);
    const translated = document.querySelector<HTMLElement>(".flt-translation")!;
    const link = translated.querySelector<HTMLAnchorElement>("a")!;
    expect(link.getAttribute("href")).toBe("/docs");
    expect(link.textContent).toBe("文档");
    expect(translated.textContent).toContain("现在");
  });

  it("restores links by translated label even when translation reorders link positions", async () => {
    document.body.innerHTML = `<p>Built by the <a href="https://openclaw.org">OpenClaw Foundation</a>. See the <a href="/gateway/telemetry">version check</a>.</p>`;
    class ReorderingProvider implements TranslationProvider {
      async translateHtml(request: TranslationRequest): Promise<string> {
        if (request.html === "OpenClaw Foundation") return "OpenClaw 基金会";
        if (request.html === "version check") return "版本检查";
        return `请参阅<a>版本检查</a>；由<a>OpenClaw 基金会</a>开发。`;
      }
    }

    const translator = new PageTranslator(document, new ReorderingProvider());
    await translator.translateAll();

    const links = Array.from(document.querySelectorAll<HTMLAnchorElement>(".flt-translation a"));
    expect(links.map((link) => [link.textContent, link.getAttribute("href")])).toEqual([
      ["版本检查", "/gateway/telemetry"],
      ["OpenClaw 基金会", "https://openclaw.org"],
    ]);
  });
});

describe("PageTranslator terminology safety", () => {
  const terminology = [
    { source: "Slack", target: "Slack", mode: "protect", origin: "builtin", aliases: [] },
    { source: "OpenAI", target: "OpenAI", mode: "protect", origin: "builtin", aliases: [] },
    { source: "Gateway", target: "网关", mode: "replace", origin: "builtin", aliases: ["网关"] },
  ];

  it("hard-preserves brand names before translation while keeping the sentence together", async () => {
    document.body.innerHTML = `<p id="p">Configure Slack notifications for OpenAI with Gateway settings.</p>`;
    class CorruptingProvider implements TranslationProvider {
      requests: TranslationRequest[] = [];
      async translateHtml(request: TranslationRequest): Promise<string> {
        this.requests.push(request);
        return request.html
          .replace("Configure ", "配置")
          .replace(" notifications for ", " 通知，供 ")
          .replace(" with ", "，使用 ")
          .replace(" settings.", " 设置。")
          .replaceAll("Slack", "松��")
          .replaceAll("OpenAI", "开放人工智能")
          .replaceAll("Gateway", "Gateway");
      }
    }
    const provider = new CorruptingProvider();
    const translator = new PageTranslator(document, provider, {
      displayMode: "translation",
      terminology,
    });
    await translator.translateAll();

    const translated = document.querySelector<HTMLElement>("#p + .flt-translation")!;
    expect(translated.textContent).toContain("Slack");
    expect(translated.textContent).toContain("OpenAI");
    expect(translated.textContent).toContain("网关");
    expect(translated.textContent).not.toContain("松��");
    expect(translated.textContent).not.toContain("开放人工智能");
    expect(provider.requests[0]?.terminology).toHaveLength(3);
    expect(provider.requests[0]?.terminology).toEqual(expect.arrayContaining([
      { source: "OpenAI", target: "OpenAI", mode: "protect" },
      { source: "Gateway", target: "网关", mode: "replace" },
      { source: "Slack", target: "Slack", mode: "protect" },
    ]));
    expect(provider.requests[0]?.html).toContain("data-flt-term-id");
    expect(provider.requests[0]?.html).toContain("Configure ");
  });

  it("matches protected proper names by exact case", async () => {
    document.body.innerHTML = `<p id="p">Signal carries a signal.</p>`;
    class CaseProvider implements TranslationProvider {
      async translateHtml(request: TranslationRequest): Promise<string> {
        return request.html
          .replaceAll("Signal", "错误品牌译名")
          .replaceAll("signal", "信号")
          .replaceAll("carries a", "传递一个");
      }
    }
    const translator = new PageTranslator(document, new CaseProvider(), {
      displayMode: "translation",
      terminology: [
        { source: "Signal", target: "Signal", mode: "protect", caseSensitive: true, origin: "builtin", aliases: [] },
      ],
    });
    await translator.translateAll();

    const translated = document.querySelector<HTMLElement>("#p + .flt-translation")!;
    expect(translated.textContent).toContain("Signal");
    expect(translated.textContent).toContain("信号");
    expect(translated.textContent).not.toContain("错误品牌译名");
  });

  it("hard-preserves brands inside standalone link labels", async () => {
    document.body.innerHTML = `<p>Open <a id="link" href="/slack">Slack settings</a>.</p>`;
    class LinkCorruptingProvider implements TranslationProvider {
      async translateHtml(request: TranslationRequest): Promise<string> {
        return request.html
          .replaceAll("Slack", "松��")
          .replaceAll("settings", "设置")
          .replaceAll("Open", "打开");
      }
    }
    const translator = new PageTranslator(document, new LinkCorruptingProvider(), {
      displayMode: "translation",
      terminology,
    });
    await translator.translateAll();

    const translatedLink = document.querySelector<HTMLAnchorElement>(".flt-translation a");
    expect(translatedLink?.textContent).toContain("Slack");
    expect(translatedLink?.textContent).toContain("设置");
    expect(translatedLink?.textContent).not.toContain("松��");
  });

  it("rejects HTML-entity replacement-character corruption without parsing it into visible text", async () => {
    document.body.innerHTML = `<p id="p">A normal sentence.</p>`;
    class BrokenEntityProvider implements TranslationProvider {
      async translateHtml(): Promise<string> {
        return "损坏的译文&#xfffd;";
      }
    }
    const paragraph = document.querySelector<HTMLElement>("#p")!;
    const translator = new PageTranslator(document, new BrokenEntityProvider(), { displayMode: "translation" });
    await translator.translateAll();

    expect(document.querySelector(".flt-translation")).toBeNull();
    expect(paragraph.classList.contains("flt-source-hidden")).toBe(false);
    expect(paragraph.textContent).toBe("A normal sentence.");
  });

  it("rejects replacement-character corruption instead of showing broken output", async () => {
    document.body.innerHTML = `<p id="p">A normal sentence.</p>`;
    class BrokenProvider implements TranslationProvider {
      async translateHtml(): Promise<string> {
        return "损坏的译文��";
      }
    }
    const paragraph = document.querySelector<HTMLElement>("#p")!;
    const translator = new PageTranslator(document, new BrokenProvider(), { displayMode: "translation" });
    await translator.translateAll();

    expect(document.querySelector(".flt-translation")).toBeNull();
    expect(paragraph.classList.contains("flt-source-hidden")).toBe(false);
    expect(paragraph.textContent).toBe("A normal sentence.");
  });
});

describe("PageTranslator display modes", () => {
  it("supports translation-only mode without replacing the original DOM", async () => {
    document.body.innerHTML = `<p id="p">Read the <a id="link" href="/docs">documentation</a>.</p>`;
    const paragraph = document.querySelector<HTMLElement>("#p")!;
    const sourceLink = document.querySelector<HTMLAnchorElement>("#link")!;
    let clicks = 0;
    sourceLink.addEventListener("click", (event) => { event.preventDefault(); clicks += 1; });

    const translator = new PageTranslator(document, new FakeHtmlProvider(), { displayMode: "translation" });
    await translator.translateAll();

    expect(document.querySelector("#p")).toBe(paragraph);
    expect(paragraph.classList.contains("flt-source-hidden")).toBe(true);
    const translatedLink = document.querySelector<HTMLAnchorElement>(".flt-translation a")!;
    expect(translatedLink.getAttribute("href")).toBe("/docs");
    translatedLink.click();
    expect(clicks).toBe(1);

    translator.setDisplayMode("bilingual");
    expect(paragraph.classList.contains("flt-source-hidden")).toBe(false);
    expect(document.querySelector("#link")).toBe(sourceLink);
  });

  it("keeps list structure while hiding list source text in translation-only mode", async () => {
    document.body.innerHTML = `<ul><li id="item">Install <strong>PageLingo</strong>.</li></ul>`;
    const item = document.querySelector<HTMLElement>("#item")!;
    const translator = new PageTranslator(document, new FakeHtmlProvider(), { displayMode: "translation" });
    await translator.translateAll();

    expect(item.classList.contains("flt-source-list-hidden")).toBe(true);
    expect(item.querySelector(":scope > .flt-translation")).not.toBeNull();

    translator.restore();
    expect(item.classList.contains("flt-source-content-hidden")).toBe(false);
    expect(item.querySelector(".flt-translation")).toBeNull();
  });

  it("keeps card anchors visible and translates only their text", async () => {
    document.body.innerHTML = `<a id="card" href="/start" style="display:block;border:1px solid;padding:20px"><span aria-hidden="true">★</span>Get Started</a>`;
    const card = document.querySelector<HTMLAnchorElement>("#card")!;
    const translator = new PageTranslator(document, new FakeHtmlProvider(), { displayMode: "translation" });
    await translator.translateAll();

    expect(card.classList.contains("flt-source-hidden")).toBe(false);
    expect(card.style.display).toBe("block");
    expect(card.querySelector(":scope > .flt-translation")?.textContent).toContain("译:Get Started");
    expect(card.textContent).toContain("译:Get Started");

    translator.restore();
    expect(card.textContent).toBe("★Get Started");
    expect(card.style.display).toBe("block");
  });

  it("keeps icons and hidden counters intact when translating a navigation label", async () => {
    document.body.innerHTML = `
      <nav>
        <ul>
          <li id="tab-item">
            <a id="tab" href="/repo" style="display:flex;gap:8px;white-space:nowrap">
              <svg id="icon" aria-hidden="true" viewBox="0 0 16 16"><path d="M1 1h14v14H1z"/></svg>
              <span data-content="Code">Code</span>
              <span id="counter" hidden>0</span>
            </a>
          </li>
        </ul>
      </nav>`;
    const provider = new FakeHtmlProvider();
    const translator = new PageTranslator(document, provider, { displayMode: "translation" });
    await translator.translateAll();

    const item = document.querySelector<HTMLElement>("#tab-item")!;
    const tab = document.querySelector<HTMLAnchorElement>("#tab")!;
    const icon = document.querySelector<SVGElement>("#icon")!;
    const counter = document.querySelector<HTMLElement>("#counter")!;
    const translated = tab.querySelector<HTMLElement>(".flt-translation");

    expect(item.classList.contains("flt-source-list-hidden")).toBe(false);
    expect(tab.style.display).toBe("flex");
    expect(icon.isConnected).toBe(true);
    expect(counter.hidden).toBe(true);
    expect(counter.textContent).toBe("0");
    expect(translated?.textContent).toContain("译:Code");
    expect(getComputedStyle(translated!).display).toBe("inline");
    expect(provider.requests.some((request) => request.html.includes(">0<") || request.html.trim() === "0")).toBe(false);
  });

  it("keeps a structured list container when link text and a badge translate separately", async () => {
    document.body.innerHTML = `<ul><li id="item"><a id="link" href="/issues"><span>Issues</span></a><span id="badge">New</span></li></ul>`;
    const translator = new PageTranslator(document, new FakeHtmlProvider(), { displayMode: "translation" });
    await translator.translateAll();

    const item = document.querySelector<HTMLElement>("#item")!;
    const link = document.querySelector<HTMLAnchorElement>("#link")!;
    expect(item.classList.contains("flt-source-list-hidden")).toBe(false);
    expect(link.isConnected).toBe(true);
    expect(link.querySelector(".flt-translation")?.textContent).toContain("译:Issues");
    expect(document.querySelector<HTMLElement>("#badge")?.nextElementSibling?.classList.contains("flt-translation")).toBe(true);
  });

  it("keeps a decorated list item's icon when its direct label is translated", async () => {
    document.body.innerHTML = `<ul><li id="item"><svg id="icon" aria-hidden="true" viewBox="0 0 16 16"></svg>Folder label</li></ul>`;
    const translator = new PageTranslator(document, new FakeHtmlProvider(), { displayMode: "translation" });
    await translator.translateAll();

    const item = document.querySelector<HTMLElement>("#item")!;
    const icon = document.querySelector<SVGElement>("#icon")!;
    expect(item.classList.contains("flt-source-list-hidden")).toBe(false);
    expect(icon.isConnected).toBe(true);
    expect(item.querySelector(":scope > [data-flt-source-text-wrapper] + .flt-translation")?.textContent).toContain("译:Folder label");
  });

  it("keeps a summary disclosure container intact", async () => {
    document.body.innerHTML = `<details open><summary id="summary">More details</summary><p>Body text.</p></details>`;
    const summary = document.querySelector<HTMLElement>("#summary")!;
    const translator = new PageTranslator(document, new FakeHtmlProvider(), { displayMode: "translation" });
    await translator.translateAll();

    expect(summary.classList.contains("flt-source-hidden")).toBe(false);
    expect(summary.querySelector("[data-flt-source-text-wrapper] + .flt-translation")?.textContent).toContain("译:More details");
    expect(summary.isConnected).toBe(true);
  });

  it("translates navigation and form button labels without replacing the controls", async () => {
    document.body.innerHTML = `<nav aria-label="Documentation"><ul><li id="entry">
      <button id="section" type="button" aria-expanded="false" aria-controls="guide"><span>Get started</span><svg aria-hidden="true"></svg></button>
      </li></ul><button id="submit" form="search">Run search</button><button id="search-action" form="search" type="button">Clear filters</button>
      </nav><form id="search"></form><button id="copy" type="button">Copy code</button>`;
    const section = document.querySelector<HTMLButtonElement>("#section")!;
    const label = section.querySelector("span")!;
    const text = label.firstChild;
    const icon = section.querySelector("svg");
    const original = document.body.innerHTML;
    const requests: string[] = [];
    const provider: TranslationProvider = {
      prefersWholeSentenceHtml: async () => true,
      translateHtml: async ({ html }) => {
        requests.push(html);
        return html.replace("Get started", "开始使用");
      },
    };
    section.addEventListener("click", () => section.setAttribute("aria-expanded", section.getAttribute("aria-expanded") === "true" ? "false" : "true"));
    const translator = new PageTranslator(document, provider, {targetLanguage: "zh-Hans"});
    await translator.translateAll();

    expect(requests).toEqual([
      '<span><span data-flt-text-id="0">Get started</span></span>',
      '<span data-flt-text-id="0">Run search</span>',
      '<span data-flt-text-id="0">Clear filters</span>',
      '<span data-flt-text-id="0">Copy code</span>',
    ]);
    expect(label.textContent).toBe("开始使用");
    expect(label.firstChild).toBe(text);
    expect(section.querySelector("svg")).toBe(icon);
    section.click();
    expect(section.getAttribute("aria-expanded")).toBe("true");

    translator.setDisplayMode("bilingual");
    expect(text?.textContent).toBe("Get started");
    expect(label.querySelector(".flt-translation")?.textContent).toBe("开始使用");
    expect(document.querySelectorAll("#entry button")).toHaveLength(1);
    section.click();
    expect(section.getAttribute("aria-expanded")).toBe("false");
    translator.restore();
    expect(document.body.innerHTML).toBe(original);
  });

  it("translates a panel revealed only by a tab's aria-selected state", async () => {
    document.body.innerHTML = `<style>#tabs[aria-selected="false"] ~ #panel {display:none}</style>
      <button id="tabs" role="tab" aria-controls="panel" aria-selected="false">Shortcuts</button>
      <section id="panel" role="tabpanel"><p>Choose a shortcut.</p></section>`;
    const tab = document.querySelector("#tabs")!;
    const para = document.querySelector("#panel p")!;
    const provider: TranslationProvider = {
      prefersWholeSentenceHtml: async () => true,
      translateHtml: async ({html}) => html.replace("Shortcuts", "快捷键").replace("Choose a shortcut.", "请选择快捷键。"),
    };
    const translator = new PageTranslator(document, provider, {targetLanguage: "zh-Hans"});
    await translator.translateAll(document.body, true);
    expect(para.textContent).toBe("Choose a shortcut.");
    tab.setAttribute("aria-selected", "true");
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(para.textContent).toBe("请选择快捷键。");
    translator.restore();
    expect(para.textContent).toBe("Choose a shortcut.");
  });

  it.each([false, true])("translates existing navigation links when the sidebar reveals them (fading: %s)", async (fading) => {
    document.body.innerHTML = `<aside><div id="panel" aria-hidden="true">
      <button type="button"><span>Get started</span></button><nav><a href="/guide">Read the guide</a></nav>
    </div></aside>`;
    const panel = document.querySelector<HTMLElement>("#panel")!;
    const link = panel.querySelector("a")!;
    const provider: TranslationProvider = {
      prefersWholeSentenceHtml: async () => true,
      translateHtml: async ({ html }) => html.replace("Get started", "开始使用").replace("Read the guide", "阅读指南"),
    };
    const translator = new PageTranslator(document, provider, {targetLanguage: "zh-Hans"});
    await translator.translateAll();
    translator.observe();
    expect(link.textContent).toBe("Read the guide");

    let finish = () => {};
    if (fading) {
      const opacityFinished = new Promise<void>(resolve => { finish = resolve; });
      Object.defineProperty(panel, "getAnimations", {
        value: () => [{transitionProperty: "opacity", finished: opacityFinished}],
      });
      panel.style.opacity = "0";
    }
    panel.setAttribute("aria-hidden", "false");
    if (fading) {
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(link.textContent).toBe("Read the guide");
      panel.style.opacity = "1";
      finish();
    }
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(link.textContent).toBe("阅读指南");
    expect(link.getAttribute("href")).toBe("/guide");
    expect(panel.querySelector("button")?.textContent).toBe("开始使用");
    translator.restore();
    expect(link.textContent).toBe("Read the guide");
  });

  it("keeps paragraph icons and form controls when translating nearby text", async () => {
    document.body.innerHTML = `
      <p id="status"><svg id="status-icon" aria-hidden="true"></svg>Status ready</p>
      <label id="choice"><input id="check" type="checkbox">Enable feature</label>`;
    const translator = new PageTranslator(document, new FakeHtmlProvider(), { displayMode: "translation" });
    await translator.translateAll();

    const status = document.querySelector<HTMLElement>("#status")!;
    const label = document.querySelector<HTMLElement>("#choice")!;
    expect(status.classList.contains("flt-source-hidden")).toBe(false);
    expect(document.querySelector("#status-icon")?.isConnected).toBe(true);
    expect(label.classList.contains("flt-source-hidden")).toBe(false);
    expect(document.querySelector("#check")?.isConnected).toBe(true);
    expect(status.querySelector(".flt-translation")?.textContent).toContain("译:Status ready");
    expect(label.querySelector(".flt-translation")?.textContent).toContain("译:Enable feature");
  });

  it("wraps dynamically inserted direct navigation text before translating it", async () => {
    document.body.innerHTML = `
      <nav><ul><li id="item"><a id="tab" href="/repo" style="display:flex">
        <svg id="icon" aria-hidden="true"></svg>
      </a></li></ul></nav>`;
    const translator = new PageTranslator(document, new FakeHtmlProvider(), { displayMode: "translation" });
    await translator.translateAll();
    translator.observe();

    const tab = document.querySelector<HTMLAnchorElement>("#tab")!;
    tab.append(document.createTextNode("Actions"));
    await new Promise((resolve) => setTimeout(resolve, 30));

    const item = document.querySelector<HTMLElement>("#item")!;
    expect(item.classList.contains("flt-source-list-hidden")).toBe(false);
    expect(document.querySelector("#icon")?.isConnected).toBe(true);
    expect(tab.querySelector("[data-flt-source-text-wrapper] + .flt-translation")?.textContent).toContain("译:Actions");
    translator.restore();
  });

  it("preserves explicit inline-flex display on translated fallback roots", async () => {
    document.body.innerHTML = `<div><span id="chip" style="display:inline-flex;white-space:nowrap">Compact label</span></div>`;
    const chip = document.querySelector<HTMLElement>("#chip")!;
    const translator = new PageTranslator(document, new FakeHtmlProvider(), { displayMode: "translation" });
    await translator.translateAll();

    const translated = chip.nextElementSibling as HTMLElement | null;
    expect(translated?.style.getPropertyValue("display")).toBe("inline-flex");
    expect(translated?.style.getPropertyValue("white-space")).toBe("nowrap");
  });

  it("keeps badges and CSS-only decorations while translating a heading label", async () => {
    document.body.innerHTML = `
      <h2 id="heading">
        <span id="css-icon" class="octicon-placeholder" aria-hidden="true"></span>
        Issues
        <span id="count" class="Counter">5</span>
      </h2>`;
    const provider = new FakeHtmlProvider();
    const translator = new PageTranslator(document, provider, { displayMode: "translation" });
    await translator.translateAll();

    const heading = document.querySelector<HTMLElement>("#heading")!;
    expect(heading.classList.contains("flt-source-hidden")).toBe(false);
    expect(document.querySelector("#css-icon")?.isConnected).toBe(true);
    expect(document.querySelector("#count")?.textContent).toBe("5");
    expect(heading.querySelector(".flt-translation")?.textContent).toContain("译:Issues");
    expect(provider.requests.some((request) => request.html.trim() === "5")).toBe(false);
  });

  it("preserves a decorated heading container so its divider remains visible", async () => {
    document.body.innerHTML = `<h2 id="heading" style="border-bottom:1px solid rgb(48,54,61);padding-bottom:8px">Governance</h2>`;
    const heading = document.querySelector<HTMLElement>("#heading")!;
    const translator = new PageTranslator(document, new FakeHtmlProvider(), { displayMode: "translation" });
    await translator.translateAll();

    expect(heading.classList.contains("flt-source-hidden")).toBe(false);
    expect(heading.style.borderBottomWidth).toBe("1px");
    expect(heading.querySelector("[data-flt-source-text-wrapper] + .flt-translation")?.textContent).toContain("译:Governance");
  });

  it("leaves dynamic relative-time fallback text out of translation", async () => {
    document.body.innerHTML = `
      <p id="updated">Updated <relative-time id="time" datetime="2026-09-22T10:00:00Z">Sep 22, 2026</relative-time></p>`;
    const provider = new FakeHtmlProvider();
    const translator = new PageTranslator(document, provider, { displayMode: "translation" });
    await translator.translateAll();

    const paragraph = document.querySelector<HTMLElement>("#updated")!;
    const time = document.querySelector<HTMLElement>("#time")!;
    expect(paragraph.classList.contains("flt-source-hidden")).toBe(false);
    expect(time.textContent).toBe("Sep 22, 2026");
    expect(time.querySelector("[data-flt-source-text-wrapper],.flt-translation")).toBeNull();
    expect(provider.requests.some((request) => request.html.includes("Sep 22, 2026"))).toBe(false);
    expect(paragraph.querySelector(".flt-translation")?.textContent).toContain("译:Updated");
  });

  it("does not serialize hidden descendant state into a visible translation", async () => {
    document.body.innerHTML = `<p id="p">Visible text <span hidden>Secret state</span></p>`;
    const provider = new FakeHtmlProvider();
    const translator = new PageTranslator(document, provider, { displayMode: "translation" });
    await translator.translateAll();

    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]?.html).toContain("Visible text");
    expect(provider.requests[0]?.html).not.toContain("Secret state");
    const translated = document.querySelector<HTMLElement>("#p .flt-translation, #p + .flt-translation");
    expect(translated).not.toBeNull();
    expect(translated?.textContent ?? "").not.toContain("Secret state");
  });

  it("preserves inline and nowrap layout for fallback text roots", async () => {
    document.body.innerHTML = `<div><span id="chip" style="white-space:nowrap">Short label</span><em> tail</em></div>`;
    const chip = document.querySelector<HTMLElement>("#chip")!;
    const translator = new PageTranslator(document, new FakeHtmlProvider(), { displayMode: "translation" });
    await translator.translateAll();

    const translated = chip.nextElementSibling as HTMLElement | null;
    expect(translated?.classList.contains("flt-translation")).toBe(true);
    expect(translated?.style.getPropertyValue("display")).toBe("inline");
    expect(translated?.style.getPropertyValue("white-space")).toBe("nowrap");
  });

  it("retranslates an existing hidden source root from restored DOM", async () => {
    document.body.innerHTML = `<p id="p">Hello <strong id="strong">world</strong>.</p>`;
    const provider = new FakeHtmlProvider();
    const translator = new PageTranslator(document, provider, { displayMode: "translation" });
    await translator.translateAll();
    translator.observe();

    const strong = document.querySelector<HTMLElement>("#strong")!;
    strong.firstChild!.textContent = "updated";
    await new Promise((resolve) => setTimeout(resolve, 30));

    const paragraph = document.querySelector<HTMLElement>("#p")!;
    const translated = paragraph.nextElementSibling as HTMLElement | null;
    expect(paragraph.classList.contains("flt-source-hidden")).toBe(true);
    expect(translated?.classList.contains("flt-translation")).toBe(true);
    expect(translated?.textContent).toContain("updated");
    expect(translated?.querySelector("strong")?.textContent).toContain("updated");
    translator.restore();
  });

  it("does not mount late translations after restore", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    class DelayedProvider implements TranslationProvider {
      async translateHtml(request: TranslationRequest): Promise<string> {
        await gate;
        return `译:${request.html}`;
      }
    }

    document.body.innerHTML = `<p>Delayed paragraph.</p>`;
    const translator = new PageTranslator(document, new DelayedProvider(), { displayMode: "translation" });
    const pending = translator.translateAll();
    translator.restore();
    release();
    await pending;

    expect(document.querySelectorAll("[data-flt-generated='translation']")).toHaveLength(0);
    expect(document.querySelectorAll("[data-flt-source-text-wrapper]")).toHaveLength(0);
    expect(document.querySelectorAll(".flt-source-hidden, .flt-source-content-hidden")).toHaveLength(0);
  });
});


describe("PageTranslator event-driven tooltips", () => {
  it("translates an aria-describedby tooltip only after the control is hovered", async () => {
    document.body.innerHTML = `<button id="trigger" aria-describedby="tip">Help</button><div id="tip" role="tooltip">Upgrade for long-running tasks</div>`;
    const provider = new FakeHtmlProvider();
    const translator = new PageTranslator(document, provider);
    translator.observeTooltips();

    expect(provider.requests).toHaveLength(0);
    document.querySelector("#trigger")!.dispatchEvent(new Event("pointerover", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(document.querySelector("#tip")?.textContent).toContain("译:");
    expect(provider.requests).toHaveLength(1);
    translator.restore();
    expect(document.querySelector("#tip")?.textContent).toBe("Upgrade for long-running tasks");
  });

  it("does not rewrite a persistent aria-describedby help paragraph", async () => {
    document.body.innerHTML = `<button id="trigger" aria-describedby="help">Help</button><p id="help">Persistent validation guidance</p>`;
    const provider = new FakeHtmlProvider();
    const translator = new PageTranslator(document, provider);
    translator.observeTooltips();

    document.querySelector("#trigger")!.dispatchEvent(new Event("pointerover", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(provider.requests).toHaveLength(0);
    expect(document.querySelector("#help")?.textContent).toBe("Persistent validation guidance");
    translator.restore();
  });

  it("rechecks only an explicitly referenced hidden tooltip after hover without observing style changes", async () => {
    document.body.innerHTML = `<button id="trigger" aria-describedby="tip">Help</button><div id="tip" role="tooltip" style="display:none">Hidden until hover</div>`;
    const provider = new FakeHtmlProvider();
    const translator = new PageTranslator(document, provider);
    translator.observeTooltips();

    document.querySelector("#trigger")!.dispatchEvent(new Event("pointerover", { bubbles: true }));
    const tip = document.querySelector<HTMLElement>("#tip")!;
    tip.style.display = "block";
    await new Promise((resolve) => setTimeout(resolve, 90));

    expect(tip.textContent).toContain("译:");
    expect(provider.requests).toHaveLength(1);
    translator.restore();
  });

  it("short-watches only child insertion after hover and translates a newly portaled tooltip", async () => {
    document.body.innerHTML = `<button id="trigger">Cowork</button>`;
    const provider = new FakeHtmlProvider();
    const translator = new PageTranslator(document, provider);
    translator.observeTooltips();

    document.querySelector("#trigger")!.dispatchEvent(new Event("pointerover", { bubbles: true }));
    const tip = document.createElement("div");
    tip.id = "late-tip";
    tip.setAttribute("role", "tooltip");
    tip.textContent = "Upgrade to use Cowork for long-running tasks";
    document.body.append(tip);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(tip.textContent).toContain("译:");
    expect(provider.requests).toHaveLength(1);
    translator.restore();
  });

  it("does not turn class/style churn into tooltip translation work", async () => {
    document.body.innerHTML = `<button id="trigger">Cowork</button><div id="surface">Surface</div>`;
    const provider = new FakeHtmlProvider();
    const translator = new PageTranslator(document, provider);
    translator.observeTooltips();

    const trigger = document.querySelector<HTMLElement>("#trigger")!;
    trigger.dispatchEvent(new Event("pointerover", { bubbles: true }));
    for (let index = 0; index < 1000; index += 1) {
      trigger.classList.toggle("pulse");
      trigger.style.setProperty("--pulse", String(index));
    }
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(provider.requests).toHaveLength(0);
    translator.restore();
  });

  it("skips interactive tooltip-like menus instead of rewriting their DOM", async () => {
    document.body.innerHTML = `<button id="trigger" aria-controls="menu">More</button><div id="menu" role="tooltip"><button>Dangerous action</button></div>`;
    const provider = new FakeHtmlProvider();
    const translator = new PageTranslator(document, provider);
    translator.observeTooltips();

    document.querySelector("#trigger")!.dispatchEvent(new Event("pointerover", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(provider.requests).toHaveLength(0);
    expect(document.querySelector("#menu")?.textContent).toBe("Dangerous action");
    translator.restore();
  });
  it("removes damaged link-boundary wrappers before positional opaque restoration", async () => {
    document.body.innerHTML =
      '<p id="p">Read <a href="/docs">documentation</a> with <code>npm run build</code>.</p>';

    class DamagedBoundaryOpaqueProvider implements TranslationProvider {
      requests: TranslationRequest[] = [];

      async translateHtml(request: TranslationRequest): Promise<string> {
        this.requests.push(request);
        if (request.html.includes("__FLT_LINK_START_0__")) {
          return '阅读 <code>__FLT_LINK_START_0__</code>文档，同时使用 <code>__FLT_OPAQUE_0__</code>。';
        }
        return "文档";
      }
    }

    const translator = new PageTranslator(document, new DamagedBoundaryOpaqueProvider());
    await translator.translateRoot(document.querySelector<HTMLElement>("#p")!);

    const translated = document.querySelector<HTMLElement>(".flt-translation")!;
    const codes = Array.from(translated.querySelectorAll("code"));
    expect(codes).toHaveLength(1);
    expect(codes[0]?.textContent).toBe("npm run build");
    expect(translated.textContent).not.toContain("__FLT_LINK_START_0__");
    expect(translated.textContent).not.toContain("__FLT_OPAQUE_0__");
  });

  it("prioritizes visible <main> content over sidebar and lazily translates off-screen roots via IntersectionObserver", async () => {
    document.body.innerHTML = `
      <aside><p id="side">Sidebar navigation item</p></aside>
      <main>
        <p id="hero">Main article heading paragraph</p>
        <p id="far">Far below the fold paragraph</p>
      </main>
    `;
    const side = document.querySelector<HTMLElement>("#side")!;
    const hero = document.querySelector<HTMLElement>("#hero")!;
    const far = document.querySelector<HTMLElement>("#far")!;
    const makeRect = (top: number): DOMRect => ({
      x: 0, y: top, top, bottom: top + 40, left: 0, right: 300, width: 300, height: 40,
      toJSON: () => ({}),
    });
    side.getBoundingClientRect = () => makeRect(20);
    hero.getBoundingClientRect = () => makeRect(80);
    far.getBoundingClientRect = () => makeRect(2400);
    Object.defineProperty(window, "innerHeight", { value: 900, configurable: true });
    Object.defineProperty(window, "innerWidth", { value: 1200, configurable: true });

    const observed = new Set<Element>();
    const ioState: { cb: ((entries: Array<{ target: Element; isIntersecting: boolean }>) => void) | null } = { cb: null };
    class FakeIntersectionObserver {
      constructor(cb: (entries: Array<{ target: Element; isIntersecting: boolean }>) => void) {
        ioState.cb = cb;
      }
      observe(target: Element) { observed.add(target); }
      unobserve(target: Element) { observed.delete(target); }
      disconnect() { observed.clear(); }
    }
    const prevIO = globalThis.IntersectionObserver;
    (globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = FakeIntersectionObserver;

    const order: string[] = [];
    const provider: TranslationProvider = {
      prefersWholeSentenceHtml: async () => true,
      prefersLazyOffscreen: async () => true,
      concurrentSegments: async () => 1,
      translateHtml: async (req) => {
        order.push(req.html);
        const body = new DOMParser().parseFromString(req.html, "text/html").body;
        for (const slot of body.querySelectorAll("[data-flt-text-id]")) {
          slot.textContent = `译:${slot.textContent}`;
        }
        return body.innerHTML;
      },
    };

    const translator = new PageTranslator(document, provider, { displayMode: "translation" });
    try {
      await translator.translateAll();
      // Main visible paragraph ran BEFORE sidebar, and far off-screen paragraph was deferred!
      expect(order).toHaveLength(2);
      expect(order[0]).toContain("Main article heading paragraph");
      expect(order[1]).toContain("Sidebar navigation item");
      expect(observed.has(far)).toBe(true);
      expect(far.textContent).toBe("Far below the fold paragraph");

      // Simulate scrolling near the deferred paragraph
      ioState.cb?.([{ target: far, isIntersecting: true }]);
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(order).toHaveLength(3);
      expect(order[2]).toContain("Far below the fold paragraph");
      expect(far.textContent).toBe("译:Far below the fold paragraph");
      expect(observed.has(far)).toBe(false);
    } finally {
      translator.restore();
      (globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = prevIO;
    }
    expect(observed.size).toBe(0);
    expect(hero.textContent).toBe("Main article heading paragraph");
    expect(far.textContent).toBe("Far below the fold paragraph");
  });

});

