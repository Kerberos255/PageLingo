import { afterEach, describe, expect, it } from "vitest";
import { PageTranslator } from "../src/core/page-translator";
import type { TranslationProvider, TranslationRequest } from "../src/core/provider";
import { richMarkerCandidateCount } from "../src/core/rich-segment-splitter";

class PreservingProvider implements TranslationProvider {
  requests: TranslationRequest[] = [];

  async translateHtml(request: TranslationRequest): Promise<string> {
    this.requests.push(request);
    const template = document.createElement("template");
    template.innerHTML = request.html;
    const walker = document.createTreeWalker(template.content, NodeFilter.SHOW_TEXT);
    let current = walker.nextNode();
    while (current) {
      const node = current as Text;
      const text = node.data.trim();
      if (
        text
        && !/^__FLT_(?:LINK_(?:START|END)_\d+|OPAQUE_\d+)__$/.test(text)
      ) {
        node.data = node.data.replace(text, "译:" + text);
      }
      current = walker.nextNode();
    }
    const holder = document.createElement("div");
    holder.append(template.content.cloneNode(true));
    return holder.innerHTML;
  }
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("PageTranslator marker budget splitter", () => {
  it("does not touch the common <=7-marker whole-root path", async () => {
    document.body.innerHTML =
      "<p id='root'>" +
      Array.from({ length: 7 }, (_, index) => "<strong>part " + index + "</strong>").join(" ") +
      "</p>";

    const provider = new PreservingProvider();
    const translator = new PageTranslator(document, provider);
    await translator.translateRoot(document.querySelector<HTMLElement>("#root")!);

    expect(provider.requests).toHaveLength(1);
    expect(richMarkerCandidateCount(provider.requests[0]!.html)).toBe(7);
    expect(document.querySelectorAll(".flt-translation strong")).toHaveLength(7);
  });

  it("splits only >=8-marker roots and keeps every request within the six-marker budget", async () => {
    document.body.innerHTML =
      "<p id='root'>" +
      Array.from({ length: 10 }, (_, index) => "<strong>part " + index + "</strong>").join(" ") +
      "</p>";

    const provider = new PreservingProvider();
    const translator = new PageTranslator(document, provider);
    await translator.translateRoot(document.querySelector<HTMLElement>("#root")!);

    expect(provider.requests.length).toBeGreaterThan(1);
    expect(provider.requests.every((request) => richMarkerCandidateCount(request.html) <= 6)).toBe(true);
    expect(document.querySelectorAll(".flt-translation strong")).toHaveLength(10);
    expect(document.querySelector(".flt-translation")?.textContent).toContain("译:part 9");
  });

  it("falls back to leaf text translation when a split chunk damages markup", async () => {
    class DamagingProvider implements TranslationProvider {
      requests: TranslationRequest[] = [];

      async translateHtml(request: TranslationRequest): Promise<string> {
        this.requests.push(request);
        if (/<(?:strong|em)\b/i.test(request.html)) {
          const template = document.createElement("template");
          template.innerHTML = request.html;
          return template.content.textContent ?? "";
        }
        return "译:" + request.html;
      }
    }

    document.body.innerHTML =
      "<p id='root'>" +
      Array.from({ length: 10 }, (_, index) =>
        index % 2 === 0
          ? "<strong>part " + index + "</strong>"
          : "<em>part " + index + "</em>"
      ).join(" ") +
      "</p>";

    const provider = new DamagingProvider();
    const translator = new PageTranslator(document, provider);
    await translator.translateRoot(document.querySelector<HTMLElement>("#root")!);

    const translated = document.querySelector<HTMLElement>(".flt-translation")!;
    expect(provider.requests.length).toBeGreaterThan(2);
    expect(translated.querySelectorAll("strong,em")).toHaveLength(10);
    expect(translated.textContent).toContain("译:part 0");
    expect(translated.textContent).toContain("译:part 9");
  });
  it("keeps external or paid engines on the original whole-root request", async () => {
    class ExternalLikeProvider extends PreservingProvider {
      async supportsStructuralSplitting(): Promise<boolean> {
        return false;
      }
    }

    document.body.innerHTML =
      "<p id='root'>" +
      Array.from({ length: 10 }, (_, index) => "<strong>part " + index + "</strong>").join(" ") +
      "</p>";

    const provider = new ExternalLikeProvider();
    const translator = new PageTranslator(document, provider);
    await translator.translateRoot(document.querySelector<HTMLElement>("#root")!);

    expect(provider.requests).toHaveLength(1);
    expect(richMarkerCandidateCount(provider.requests[0]!.html)).toBe(10);
    expect(document.querySelectorAll(".flt-translation strong")).toHaveLength(10);
  });

  it("uses leaf-safe translation when an oversized atomic anchor cannot be split", async () => {
    document.body.innerHTML =
      "<p id='root'>Read <a href='/docs'>" +
      Array.from({ length: 8 }, (_, index) => "<strong>part " + index + "</strong>").join(" ") +
      "</a> now.</p>";

    const provider = new PreservingProvider();
    const translator = new PageTranslator(document, provider);
    await translator.translateRoot(document.querySelector<HTMLElement>("#root")!);

    expect(provider.requests.length).toBeGreaterThan(1);
    expect(provider.requests.every((request) => richMarkerCandidateCount(request.html) <= 6)).toBe(true);
    const translated = document.querySelector<HTMLElement>(".flt-translation")!;
    expect(translated.querySelectorAll("a strong")).toHaveLength(8);
    expect(translated.querySelector("a")?.getAttribute("href")).toBe("/docs");
  });

  it("routes 5-marker nested local roots through leaf-safe translation", async () => {
    document.body.innerHTML =
      "<p id='root'>" +
      "<strong>alpha <em>beta</em></strong> " +
      "<span>gamma <b>delta</b></span> " +
      "<i>epsilon</i>" +
      "</p>";

    const provider = new PreservingProvider();
    const translator = new PageTranslator(document, provider);
    await translator.translateRoot(document.querySelector<HTMLElement>("#root")!);

    expect(provider.requests.length).toBeGreaterThan(1);
    expect(provider.requests.every((request) => richMarkerCandidateCount(request.html) === 0)).toBe(true);
    const translated = document.querySelector<HTMLElement>(".flt-translation")!;
    expect(translated.querySelectorAll("strong,em,span,b,i")).toHaveLength(5);
    expect(translated.textContent).toContain("译:alpha");
    expect(translated.textContent).toContain("译:epsilon");
  });

  it("routes 6-marker nested local roots through leaf-safe translation", async () => {
    document.body.innerHTML =
      "<p id='root'>" +
      "<strong>alpha <em>beta</em></strong> " +
      "<span>gamma <b>delta</b></span> " +
      "<i>epsilon</i><u>zeta</u>" +
      "</p>";

    const provider = new PreservingProvider();
    const translator = new PageTranslator(document, provider);
    await translator.translateRoot(document.querySelector<HTMLElement>("#root")!);

    expect(provider.requests.length).toBeGreaterThan(1);
    expect(provider.requests.every((request) => richMarkerCandidateCount(request.html) === 0)).toBe(true);
    expect(document.querySelectorAll(".flt-translation strong,.flt-translation em,.flt-translation span,.flt-translation b,.flt-translation i,.flt-translation u")).toHaveLength(6);
  });

  it("keeps a 7-marker nested local root on the whole-root path", async () => {
    document.body.innerHTML =
      "<p id='root'>" +
      "<strong>alpha <em>beta</em></strong> " +
      "<span>gamma <b>delta</b></span> " +
      "<i>epsilon</i><u>zeta</u><small>eta</small>" +
      "</p>";

    const provider = new PreservingProvider();
    const translator = new PageTranslator(document, provider);
    await translator.translateRoot(document.querySelector<HTMLElement>("#root")!);

    expect(provider.requests).toHaveLength(1);
    expect(richMarkerCandidateCount(provider.requests[0]!.html)).toBe(7);
  });

  it("keeps nested 10-marker roots on the bounded structural splitter path", async () => {
    document.body.innerHTML =
      "<p id='root'><strong>outer " +
      Array.from({ length: 9 }, (_, index) => "<em>part " + index + "</em>").join(" ") +
      "</strong></p>";

    const provider = new PreservingProvider();
    const translator = new PageTranslator(document, provider);
    await translator.translateRoot(document.querySelector<HTMLElement>("#root")!);

    expect(provider.requests.length).toBeGreaterThan(1);
    expect(provider.requests.every((request) => richMarkerCandidateCount(request.html) <= 6)).toBe(true);
    expect(provider.requests.some((request) => richMarkerCandidateCount(request.html) > 0)).toBe(true);
    expect(document.querySelectorAll(".flt-translation strong")).toHaveLength(1);
    expect(document.querySelectorAll(".flt-translation em")).toHaveLength(9);
  });

  it("keeps a 4-marker nested local root on the whole-root path", async () => {
    document.body.innerHTML =
      "<p id='root'><strong>alpha <em>beta</em></strong><span>gamma</span><i>delta</i></p>";

    const provider = new PreservingProvider();
    const translator = new PageTranslator(document, provider);
    await translator.translateRoot(document.querySelector<HTMLElement>("#root")!);

    expect(provider.requests).toHaveLength(1);
    expect(richMarkerCandidateCount(provider.requests[0]!.html)).toBe(4);
  });

  it("keeps risky nested roots whole for external engines", async () => {
    class ExternalLikeProvider extends PreservingProvider {
      async supportsStructuralSplitting(): Promise<boolean> {
        return false;
      }
    }

    document.body.innerHTML =
      "<p id='root'>" +
      "<strong>alpha <em>beta</em></strong> " +
      "<span>gamma <b>delta</b></span> " +
      "<i>epsilon</i>" +
      "</p>";

    const provider = new ExternalLikeProvider();
    const translator = new PageTranslator(document, provider);
    await translator.translateRoot(document.querySelector<HTMLElement>("#root")!);

    expect(provider.requests).toHaveLength(1);
    expect(richMarkerCandidateCount(provider.requests[0]!.html)).toBe(5);
  });

});
