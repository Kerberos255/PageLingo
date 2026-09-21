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
      if (node.textContent?.trim()) node.textContent = `译:${node.textContent}`;
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

    expect(item.classList.contains("flt-source-content-hidden")).toBe(true);
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
