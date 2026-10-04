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
    expect(document.querySelector(".flt-translation")?.textContent).toContain("译:part 8");
  });

  it("preserves boundary text when a split text-only chunk translates empty", async () => {
    class EmptyPlainTextProvider extends PreservingProvider {
      async translateHtml(request: TranslationRequest): Promise<string> {
        if (!/<[a-z][\\s\\S]*>/i.test(request.html)) {
          this.requests.push(request);
          return "";
        }
        return super.translateHtml(request);
      }
    }

    document.body.innerHTML =
      "<p id='root'>prefix <strong>" +
      Array.from({ length: 9 }, (_, index) => "<em>part " + index + "</em>").join(" ") +
      "</strong> suffix</p>";

    const provider = new EmptyPlainTextProvider();
    const translator = new PageTranslator(document, provider);
    await translator.translateRoot(document.querySelector<HTMLElement>("#root")!);

    const translated = document.querySelector<HTMLElement>(".flt-translation")!;
    expect(translated.querySelectorAll("strong")).toHaveLength(1);
    expect(translated.querySelectorAll("em")).toHaveLength(9);
    expect(translated.textContent).toContain("prefix");
    expect(translated.textContent).toContain("suffix");
    expect(translated.textContent).toContain("part 8");
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

  it("uses a checked whole-root result for risky 5-marker nested roots when the provider accepts it", async () => {
    class CheckedProvider extends PreservingProvider {
      checkedRequests: TranslationRequest[] = [];

      async translateHtmlChecked(request: TranslationRequest) {
        this.checkedRequests.push(request);
        const html = await super.translateHtml(request);
        return { html, accepted: true };
      }
    }

    document.body.innerHTML =
      "<p id='root'>" +
      "<strong>alpha <em>beta</em></strong> " +
      "<span>gamma <b>delta</b></span> " +
      "<i>epsilon</i>" +
      "</p>";

    const provider = new CheckedProvider();
    const translator = new PageTranslator(document, provider);
    await translator.translateRoot(document.querySelector<HTMLElement>("#root")!);

    expect(provider.checkedRequests).toHaveLength(1);
    expect(richMarkerCandidateCount(provider.checkedRequests[0]!.html)).toBe(5);
    expect(provider.requests).toHaveLength(1);
    const translated = document.querySelector<HTMLElement>(".flt-translation")!;
    expect(translated.querySelectorAll("strong,em,span,b,i")).toHaveLength(5);
    expect(translated.textContent).toContain("译:alpha");
    expect(translated.textContent).toContain("译:epsilon");
  });

  it("falls back to a whole-root fallback provider when guarded nested translation is rejected", async () => {
    class RejectingCheckedProvider implements TranslationProvider {
      checkedRequests: TranslationRequest[] = [];
      regularRequests: TranslationRequest[] = [];

      async supportsStructuralSplitting(): Promise<boolean> {
        return true;
      }

      async translateHtmlChecked(request: TranslationRequest) {
        this.checkedRequests.push(request);
        return { html: request.html, accepted: false, reason: "quality_guard" };
      }

      async translateHtml(request: TranslationRequest): Promise<string> {
        this.regularRequests.push(request);
        throw new Error("regular primary path should not be used");
      }
    }

    document.body.innerHTML =
      "<p id='root'>" +
      "<strong>alpha <em>beta</em></strong> " +
      "<span>gamma <b>delta</b></span> " +
      "<i>epsilon</i>" +
      "</p>";

    const primary = new RejectingCheckedProvider();
    const fallback = new PreservingProvider();
    const translator = new PageTranslator(document, primary, { fallbackProvider: fallback });
    await translator.translateRoot(document.querySelector<HTMLElement>("#root")!);

    expect(primary.checkedRequests).toHaveLength(1);
    expect(primary.regularRequests).toHaveLength(0);
    expect(fallback.requests).toHaveLength(1);
    expect(richMarkerCandidateCount(fallback.requests[0]!.html)).toBe(5);
    const translated = document.querySelector<HTMLElement>(".flt-translation")!;
    expect(translated.querySelectorAll("strong,em,span,b,i")).toHaveLength(5);
    expect(translated.textContent).toContain("译:alpha");
  });

  it("independently rejects malformed checked complex chunks and uses the fallback provider", async () => {
    class MalformedCheckedProvider implements TranslationProvider {
      checkedRequests: TranslationRequest[] = [];
      regularRequests: TranslationRequest[] = [];

      async supportsStructuralSplitting(): Promise<boolean> {
        return true;
      }

      async translateHtmlChecked(request: TranslationRequest) {
        this.checkedRequests.push(request);
        const template = document.createElement("template");
        template.innerHTML = request.html;
        return {
          html: template.content.textContent ?? "",
          accepted: true,
        };
      }

      async translateHtml(request: TranslationRequest): Promise<string> {
        this.regularRequests.push(request);
        return request.html;
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

    const primary = new MalformedCheckedProvider();
    const fallback = new PreservingProvider();
    const translator = new PageTranslator(document, primary, { fallbackProvider: fallback });
    await translator.translateRoot(document.querySelector<HTMLElement>("#root")!);

    expect(primary.checkedRequests.length).toBeGreaterThan(1);
    expect(primary.regularRequests).toHaveLength(0);
    expect(fallback.requests.length).toBeGreaterThan(1);
    expect(fallback.requests.every((request) => richMarkerCandidateCount(request.html) <= 6)).toBe(true);

    const translated = document.querySelector<HTMLElement>(".flt-translation")!;
    expect(translated.querySelectorAll("strong,em")).toHaveLength(10);
    expect(translated.textContent).toContain("译:part 0");
    expect(translated.textContent).toContain("译:part 9");
  });


  it("rejects the historical OpenClaw whole-root template-garbage output and uses fallback", async () => {
    class HistoricalGarbageProvider implements TranslationProvider {
      checkedRequests: TranslationRequest[] = [];

      async supportsStructuralSplitting(): Promise<boolean> {
        return true;
      }

      async translateHtmlChecked(request: TranslationRequest) {
        this.checkedRequests.push(request);
        return {
          accepted: true,
          html:
            '通过 <code>__FLT_OPAQUE_0__</code> 检查您的节点版本。' +
            '<strong>Windows 用户：</strong> 本机 Windows 中心应用是最简单的桌面路径。' +
            'PowerShell 安装程序和 WSL2 Gateway 路径也受支持。请参阅 ' +
            '<a data-flt-link-id="0" href="https://pagelingo.invalid/__link/0">' +
            '<code>__FLT_LINK_START_0__</code><span>Windows</span><code>__FLT_LINK_END_0__</code></a>。' +
            '需要安装 Node？请参阅 ' +
            '<a data-flt-link-id="1" href="https://pagelingo.invalid/__link/1">' +
            '<code>__FLT_LINK_START_1__</code><span>Node 设置</span><code>__FLT_LINK_END_1__</code></a>。' +
            '（______）取消',
        };
      }

      async translateHtml(request: TranslationRequest): Promise<string> {
        return request.html;
      }
    }

    class ChineseFallbackProvider implements TranslationProvider {
      requests: TranslationRequest[] = [];

      async translateHtml(request: TranslationRequest): Promise<string> {
        this.requests.push(request);
        return request.html
          .replace("Check your Node version with", "使用以下命令检查 Node 版本：")
          .replace("Windows users:", "Windows 用户：")
          .replace(
            "the native Windows Hub app is the easiest desktop path. The PowerShell installer and WSL2 Gateway paths are also supported. See",
            "原生 Windows Hub 应用是最简单的桌面方案。PowerShell 安装程序和 WSL2 Gateway 方案也受支持。请参阅",
          )
          .replace("Need to install Node? See", "需要安装 Node？请参阅")
          .replace(">Windows<", ">Windows 页面<")
          .replace(">Node setup<", ">Node 安装说明<");
      }
    }

    document.body.innerHTML =
      '<p id="root">' +
      'Check your Node version with <code>node --version</code>. ' +
      '<strong>Windows users:</strong> the native Windows Hub app is the easiest desktop path. ' +
      'The PowerShell installer and WSL2 Gateway paths are also supported. ' +
      'See <a href="/windows"><span>Windows</span></a>. ' +
      'Need to install Node? See <a href="/node"><span>Node setup</span></a>.' +
      "</p>";

    const primary = new HistoricalGarbageProvider();
    const fallback = new ChineseFallbackProvider();
    const translator = new PageTranslator(document, primary, {
      targetLanguage: "zh-Hans",
      fallbackProvider: fallback,
    });

    await translator.translateRoot(document.querySelector<HTMLElement>("#root")!);

    expect(primary.checkedRequests).toHaveLength(1);
    expect(fallback.requests.length).toBeGreaterThanOrEqual(1);
    const translated = document.querySelector<HTMLElement>(".flt-translation")!;
    expect(translated.textContent).not.toContain("______");
    expect(translated.textContent).not.toContain("取消");
    expect(translated.textContent).toContain("Windows 用户");
    expect(translated.querySelectorAll("a")).toHaveLength(2);
  });

  it("rejects the historical GitHub nested slot-corruption attempt and uses whole-root fallback", async () => {
    class SlotCorruptingProvider implements TranslationProvider {
      checkedRequests: TranslationRequest[] = [];
      regularRequests: TranslationRequest[] = [];

      async supportsStructuralSplitting(): Promise<boolean> {
        return true;
      }

      async translateHtmlChecked(request: TranslationRequest) {
        this.checkedRequests.push(request);
        return {
          html: request.html,
          accepted: false,
          reason: "slot_mismatch",
        };
      }

      async translateHtml(request: TranslationRequest): Promise<string> {
        this.regularRequests.push(request);
        return request.html;
      }
    }

    class ChineseFallbackProvider implements TranslationProvider {
      requests: TranslationRequest[] = [];

      async translateHtml(request: TranslationRequest): Promise<string> {
        this.requests.push(request);
        return request.html
          .replace(
            "Tools run on the host for the main session unless you configure sandboxing. Read the",
            "除非配置沙箱，否则主会话的工具会在主机上运行。连接其他用户或远程开放 Gateway 前，请阅读",
          )
          .replace(">security guide<", ">安全指南<")
          .replace(">exposure runbook<", ">暴露运行手册<")
          .replace(">sandboxing guide<", ">沙箱指南<")
          .replace(
            "before connecting other users or exposing the Gateway remotely.",
            "。",
          );
      }
    }

    document.body.innerHTML =
      '<p id="root">' +
      'Tools run on the host for the main session unless you configure sandboxing. Read the ' +
      '<a href="/security"><span>security guide</span></a>, ' +
      '<a href="/exposure"><span>exposure runbook</span></a>, and ' +
      '<a href="/sandboxing"><span>sandboxing guide</span></a> ' +
      'before connecting other users or exposing the Gateway remotely.' +
      "</p>";

    const primary = new SlotCorruptingProvider();
    const fallback = new ChineseFallbackProvider();
    const translator = new PageTranslator(document, primary, {
      targetLanguage: "zh-Hans",
      fallbackProvider: fallback,
    });

    await translator.translateRoot(document.querySelector<HTMLElement>("#root")!);

    expect(primary.checkedRequests).toHaveLength(1);
    expect(primary.regularRequests).toHaveLength(0);
    expect(fallback.requests).toHaveLength(1);
    const translated = document.querySelector<HTMLElement>(".flt-translation")!;
    expect(translated.textContent).not.toMatch(/[\u3040-\u30ff]/u);
    expect(translated.textContent).toContain("安全指南");
    expect(translated.textContent).toContain("沙箱指南");
    expect(translated.querySelectorAll("a")).toHaveLength(3);
  });

});
