import { afterEach, describe, expect, it, vi } from "vitest";
import { collectTranslationRoots } from "../src/core/dom-policy";
import { PageTranslator } from "../src/core/page-translator";
import { contextualTerminology, translationContextForUrl } from "../src/core/translation-context";
import { terminologyForText } from "../src/core/rich-segment";
import type { TranslationRequest, TranslationTerminologyEntry } from "../src/core/provider";

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("Translation sentence context and atomic rendering", () => {
  it("recognizes versioned Django database documentation without treating commerce pages as SQL", () => {
    for (const url of [
      "https://docs.djangoproject.com/en/5.2/topics/db/transactions/",
      "https://docs.djangoproject.com/en/dev/topics/db/queries/",
      "https://docs.djangoproject.com/zh-hans/6.0/topics/db/",
    ]) {
      expect(translationContextForUrl(url)).toBe("sql");
    }
    for (const url of [
      "https://docs.djangoproject.com/en/5.2/topics/http/views/",
      "https://docs.djangoproject.com/en/5.2/topics/db-notes/",
      "https://docs.djangoproject.com.evil.example/en/5.2/topics/db/",
      "https://shop.example/transactions",
    ]) {
      expect(translationContextForUrl(url)).toBeUndefined();
    }
  });

  it("provides database transaction terminology with complete English word boundaries", () => {
    const terms = contextualTerminology("sql");
    expect(
      terminologyForText(terms, "A transaction contains multiple transactions.")
        .filter((t: TranslationTerminologyEntry) => t.target === "事务")
        .map((t: TranslationTerminologyEntry) => t.source),
    ).toEqual(["transactions", "transaction"]);
    expect(
      terminologyForText(terms, "Transactional behavior in TransactionTestCase.")
        .filter((t: TranslationTerminologyEntry) => t.target === "事务"),
    ).toEqual([]);
  });

  it("keeps user terminology authoritative and preserves original links and code on a Django page", async () => {
    vi.spyOn(document, "URL", "get").mockReturnValue("https://docs.djangoproject.com/en/5.2/topics/db/transactions/");
    document.body.innerHTML = '<p>Read <a href="/atomic">transaction</a> guidance with <code>transaction.atomic()</code>.</p>';
    const p = document.querySelector("p")!, link = p.querySelector("a")!, code = p.querySelector("code")!, before = p.outerHTML;
    const requests: TranslationRequest[] = [];
    const translator = new PageTranslator(document, {
      prefersWholeSentenceHtml: async () => true,
      translateHtml: async (request: TranslationRequest) => {
        requests.push(request);
        const body = new DOMParser().parseFromString(request.html, "text/html").body;
        for (const span of body.querySelectorAll("[data-flt-text-id]")) {
          span.textContent = span.textContent?.trim() === "transaction" ? "自定义事务" : "阅读说明";
        }
        return body.innerHTML;
      },
    }, { displayMode: "translation", terminology: [{ source: "transaction", target: "自定义事务", mode: "replace", origin: "user" }] });
    await translator.translateAll(p);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.context).toBe("sql");
    expect(requests[0]!.terminology?.filter(t => t.source === "transaction")).toEqual([
      { source: "transaction", target: "自定义事务", mode: "replace" },
    ]);
    expect(p.querySelector("a")).toBe(link);
    expect(link.getAttribute("href")).toBe("/atomic");
    expect(p.querySelector("code")).toBe(code);
    expect(code.textContent).toBe("transaction.atomic()");
    translator.restore();
    expect(p.outerHTML).toBe(before);
  });

  it("keeps a numeric linked HTTP code within its full sentence without modifying the source", () => {
    document.body.innerHTML = '<p>The response must include the headers of an equivalent <a href="/200"><code>200</code></a> response, such as:</p>';
    const before = document.body.innerHTML;
    const p = document.querySelector("p")!;
    expect(collectTranslationRoots(document.body, { preserveInlineContext: true })).toEqual([p]);
    expect(document.body.innerHTML).toBe(before);
  });

  it("deduplicates inline labels while retaining standalone navigation labels", () => {
    document.body.innerHTML = '<nav><a href="/home">Home</a></nav><p>Read the <a href="/guide">guide</a>.</p>';
    const roots = collectTranslationRoots(document.body, { preserveInlineContext: true });
    expect(roots).toHaveLength(2);
    expect(roots.filter((r) => (r as Element).tagName === "P")).toHaveLength(1);
  });

  it("collects toolbar context without wrapping or restyling the source", () => {
    document.body.innerHTML = '<p style="display:flex"><a href="/x">Open</a><svg></svg><span>Settings</span></p>';
    const before = document.body.innerHTML;
    expect(collectTranslationRoots(document.body, { preserveInlineContext: true })).toEqual([document.querySelector("p")]);
    expect(document.body.innerHTML).toBe(before);
  });

  it("mounts no child translations when a whole paragraph provider rejects", async () => {
    document.body.innerHTML = '<p>Read the <a href="/x">conditional</a> request and <a href="/y">HTTP caching</a> rules.</p>';
    const before = document.body.innerHTML;
    let requests = 0;
    const provider = {
      prefersWholeSentenceHtml: async () => true,
      translateHtml: async () => {
        requests++;
        throw new Error("Injected rejection");
      },
    };
    const translator = new PageTranslator(document, provider);
    await translator.translateAll();
    expect(requests).toBe(1);
    expect(document.querySelectorAll(".flt-translation")).toHaveLength(0);
    expect(document.body.innerHTML).toBe(before);
    translator.restore();
    expect(document.body.innerHTML).toBe(before);
  });

  it("keeps adjacent paragraph selectors intact and restores the original source container", async () => {
    document.body.innerHTML = '<section><p id="source">Translate this documentation paragraph.</p><p id="neighbor">Another paragraph.</p></section>';
    const before = document.body.innerHTML;
    const source = document.querySelector<HTMLElement>("#source")!;
    const neighbor = document.querySelector<HTMLElement>("#neighbor")!;
    const text = source.firstChild;
    const translator = new PageTranslator(document, {
      prefersWholeSentenceHtml: async () => true,
      translateHtml: async (request: TranslationRequest) => {
        const body = new DOMParser().parseFromString(request.html, "text/html").body;
        body.querySelector("[data-flt-text-id]")!.textContent = "翻译这个文档段落。";
        return body.innerHTML;
      },
    }, { displayMode: "translation" });
    await translator.translateAll(source);
    expect(source.textContent).toBe("翻译这个文档段落。");
    expect(source.firstChild).toBe(text);
    expect(source.querySelector(".flt-translation")).toBeNull();
    expect(neighbor.matches("p + p")).toBe(true);
    translator.setDisplayMode("bilingual");
    expect(source.querySelector("[data-flt-list-source-wrapper]")).toBeNull();
    translator.restore();
    expect(document.body.innerHTML).toBe(before);
  });

  it("passes domain-specific terminology only for the matching URL family", () => {
    expect(translationContextForUrl("https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Status/304")).toBe("http");
    expect(translationContextForUrl("https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/Heading_Elements")).toBeUndefined();
  });
});
