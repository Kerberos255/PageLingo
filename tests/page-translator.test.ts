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

  it("removes only generated translation nodes on restore", async () => {
    document.body.innerHTML = `<section><p id="p">Hello <em>world</em>.</p></section>`;
    const before = document.querySelector("section")!.innerHTML;
    const paragraph = document.querySelector("#p");
    const translator = new PageTranslator(document, new FakeHtmlProvider());
    await translator.translateAll();
    expect(document.querySelector(".flt-translation")).not.toBeNull();

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
  });

  it("does not translate form controls, scripts or preformatted code blocks", async () => {
    document.body.innerHTML = `<button>Click me</button><pre>const x = 1;</pre><p>Translate me.</p>`;
    const provider = new FakeHtmlProvider();
    const translator = new PageTranslator(document, provider);
    await translator.translateAll();

    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]?.html).toContain("Translate me.");
  });
});
