import { afterEach, describe, expect, it } from "vitest";
import { PageTranslator } from "../src/core/page-translator";
import { collectTranslationRoots } from "../src/core/dom-policy";
import type { TranslationRequest } from "../src/core/provider";

afterEach(() => document.body.replaceChildren());
function provider() {
  const requests: TranslationRequest[] = [];
  return {
    requests,
    prefersWholeSentenceHtml: async () => true,
    translateHtml: async (request: TranslationRequest) => {
      requests.push(request);
      const body = new DOMParser().parseFromString(request.html, "text/html").body;
      for (const slot of body.querySelectorAll("[data-flt-text-id]")) slot.textContent = `译文${slot.getAttribute("data-flt-text-id")}`;
      return body.innerHTML;
    },
  };
}

describe("Dynamic source ownership", () => {
  it("keeps an unchanged translated record before testing source-language eligibility", async () => {
    document.body.innerHTML = "<p>Hello <em>world</em>.</p>";
    const fake = provider(), observed: string[] = [];
    const translator = new PageTranslator(document, fake, {
      displayMode: "translation",
      shouldTranslateRoot: (root: HTMLElement) => {
        observed.push(root.textContent ?? "");
        return !/[\u3400-\u9fff]/u.test(root.textContent ?? "");
      },
    });
    await translator.translateAll();
    await translator.translateAll();
    expect(translator.translatedCount).toBe(1);
    expect(fake.requests).toHaveLength(1);
    expect(observed).toEqual(["Hello world."]);
    translator.restore();
    expect(document.querySelector("p")!.textContent).toBe("Hello world.");
  });
  it("restores owned source before evaluating a changed record without overwriting website edits", async () => {
    document.body.innerHTML = "<p>Hello <em>world</em>.</p>";
    const fake = provider(), observed: string[] = [];
    const translator = new PageTranslator(document, fake, {
      displayMode: "translation",
      shouldTranslateRoot: (root: HTMLElement) => {
        observed.push(root.textContent ?? "");
        return !/[\u3400-\u9fff]/u.test(root.textContent ?? "");
      },
    });
    await translator.translateAll();
    document.querySelector("em")!.firstChild!.textContent = "new website text";
    await translator.translateAll();
    expect(observed).toEqual(["Hello world.", "Hello new website text."]);
    expect(fake.requests).toHaveLength(2);
    translator.restore();
    expect(document.querySelector("p")!.textContent).toBe("Hello new website text.");
  });
  it("does not cycle translation and restoration when observing its own text writes", async () => {
    document.body.innerHTML = "<p>Hello world.</p>";
    const fake = provider(), translator = new PageTranslator(document, fake, {
      displayMode: "translation",
      shouldTranslateRoot: (root: HTMLElement) => !/[\u3400-\u9fff]/u.test(root.textContent ?? ""),
    });
    translator.observe();
    await translator.translateAll();
    await new Promise(resolve => setTimeout(resolve, 80));
    expect(fake.requests).toHaveLength(1);
    expect(translator.translatedCount).toBe(1);
    translator.restore();
    expect(document.querySelector("p")!.textContent).toBe("Hello world.");
  });
  it.each(["restore", "bilingual", "rescan"])("restores a translated Text node moved into a website wrapper: %s", async action => {
    document.body.innerHTML = '<p id="source">Hello <em>world</em>.</p>';
    const root = document.querySelector<HTMLElement>("p")!, fake = provider();
    const text = root.firstChild!, translator = new PageTranslator(document, fake, { displayMode: "translation" });
    await translator.translateAll();
    const wrapper = document.createElement("span");
    wrapper.className = "website-wrapper";
    root.insertBefore(wrapper, text);
    wrapper.append(text);
    if (action === "restore") translator.restore();
    else if (action === "bilingual") translator.setDisplayMode("bilingual");
    else await translator.translateAll();
    if (action !== "restore") translator.restore();
    expect(wrapper.firstChild).toBe(text);
    expect(text.textContent).toBe("Hello ");
    expect(root.innerHTML).toBe('<span class="website-wrapper">Hello </span><em>world</em>.');
  });
  it("restores the same owned Text object after a move to another paragraph", async () => {
    document.body.innerHTML = '<p id="from">Original text.</p><p id="to"></p>';
    const text = document.querySelector("#from")!.firstChild!, translator = new PageTranslator(document, provider(), { displayMode: "translation" });
    await translator.translateAll();
    document.querySelector("#to")!.append(text);
    translator.restore();
    expect(text.textContent).toBe("Original text.");
    expect(document.querySelector("#to")!.firstChild).toBe(text);
  });
  it("keeps website replacement text after reparenting the owned node", async () => {
    document.body.innerHTML = '<p id="from">Original text.</p><p id="to"></p>';
    const text = document.querySelector("#from")!.firstChild!, translator = new PageTranslator(document, provider(), { displayMode: "translation" });
    await translator.translateAll();
    document.querySelector("#to")!.append(text);
    text.textContent = "New website content.";
    translator.restore();
    expect(text.textContent).toBe("New website content.");
  });
  it.each([false, true])("restores source before a new root acquires a moved node, including moved subtrees: %s", async subtree => {
    document.body.innerHTML = '<p id="from"><em>Original text.</em></p><p id="to"></p>';
    const destination = document.querySelector("#to")!, moved = subtree ? document.querySelector("em")! : document.querySelector("em")!.firstChild!;
    const requests: string[] = [];
    const translator = new PageTranslator(document, {
      prefersWholeSentenceHtml: async () => true,
      translateHtml: async (request: TranslationRequest) => {
        requests.push(request.html);
        const body = new DOMParser().parseFromString(request.html, "text/html").body;
        for (const slot of body.querySelectorAll("[data-flt-text-id]")) slot.textContent = `第${requests.length}次译文`;
        return body.innerHTML;
      },
    }, { displayMode: "translation" });
    await translator.translateAll();
    destination.append(moved);
    await translator.translateAll(destination);
    expect(requests).toHaveLength(2);
    expect(requests[1]).toContain("Original text.");
    translator.restore();
    expect(destination.textContent).toBe("Original text.");
  });
  it.each(["translation", "bilingual"] as const)("uses one owner for a standalone link with nested and direct text: %s", async displayMode => {
    document.body.innerHTML = '<nav><a href="/guide"><span>Read</span> more</a></nav>';
    const anchor = document.querySelector("a")!, before = document.body.innerHTML;
    expect(collectTranslationRoots(document.body, { preserveInlineContext: true })).toEqual([anchor]);
    const fake = provider(), translator = new PageTranslator(document, fake, { displayMode });
    await translator.translateAll();
    expect(fake.requests).toHaveLength(1);
    expect(translator.translatedCount).toBe(1);
    expect(fake.requests[0]!.html).toContain("Read");
    expect(fake.requests[0]!.html).toContain(" more");
    translator.restore();
    expect(document.body.innerHTML).toBe(before);
  });
  it("hands an existing standalone link record to a new paragraph owner without translating Chinese as source", async () => {
    document.body.innerHTML = '<a href="/guide"><span>Read</span> more</a>';
    const anchor = document.querySelector("a")!, fake = provider(), translator = new PageTranslator(document, fake, { displayMode: "translation" });
    await translator.translateAll();
    const paragraph = document.createElement("p");
    document.body.append(paragraph);
    paragraph.append(anchor);
    await translator.translateAll(paragraph);
    expect(fake.requests).toHaveLength(2);
    expect(fake.requests[1]!.html).toContain("Read");
    expect(fake.requests[1]!.html).toContain(" more");
    expect(fake.requests[1]!.html).not.toContain("译文");
    expect(translator.translatedCount).toBe(1);
    translator.restore();
    expect(anchor.textContent).toBe("Read more");
  });
  it.each(["translation", "bilingual"] as const)("coalesces nested fallback spans into the selected outer owner: %s", async displayMode => {
    document.body.innerHTML = '<div><span id="owner"><span>Read</span> more</span><span id="next">Next page</span></div>';
    const owner = document.querySelector("#owner")!, next = document.querySelector("#next")!, before = document.body.innerHTML;
    expect(collectTranslationRoots(document.body, { preserveInlineContext: true })).toEqual([owner, next]);
    const fake = provider(), translator = new PageTranslator(document, fake, { displayMode, concurrency: 2 });
    await translator.translateAll();
    expect(fake.requests).toHaveLength(2);
    expect(translator.translatedCount).toBe(2);
    expect(fake.requests[0]!.html).toContain("Read");
    expect(fake.requests[0]!.html).toContain(" more");
    translator.restore();
    expect(document.body.innerHTML).toBe(before);
  });
  it.each(["translation", "bilingual"] as const)("coalesces deeper spans without removing an independent paragraph: %s", async displayMode => {
    document.body.innerHTML = '<div><span id="owner"><strong><span>Read</span> the</strong> guide</span><p>Independent paragraph.</p></div>';
    const owner = document.querySelector("#owner")!, paragraph = document.querySelector("p")!, before = document.body.innerHTML;
    expect(collectTranslationRoots(document.body, { preserveInlineContext: true })).toEqual([owner, paragraph]);
    const fake = provider(), translator = new PageTranslator(document, fake, { displayMode, concurrency: 2 });
    await translator.translateAll();
    expect(fake.requests).toHaveLength(2);
    expect(translator.translatedCount).toBe(2);
    expect(fake.requests[0]!.html).toContain("Read");
    expect(fake.requests[0]!.html).toContain(" guide");
    translator.restore();
    expect(document.body.innerHTML).toBe(before);
  });
});
