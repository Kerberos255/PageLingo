import { afterEach, describe, expect, it, vi } from "vitest";
import { collectTranslationRoots } from "../src/core/dom-policy";
import { PageTranslator } from "../src/core/page-translator";
import type { TranslationRequest } from "../src/core/provider";

afterEach(() => {
  document.body.replaceChildren();
});

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 20));
}

describe("Shadow DOM, custom element, markdown code-sibling, and fade-in prose discovery", () => {
  it("translates and cleanly restores prose inside open Shadow DOM while skipping generated shadow hosts", async () => {
    const host = document.createElement("markdown-message");
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `<p id="msg">Capturing a headless screenshot of the layout.</p>`;

    const generatedHost = document.createElement("div");
    generatedHost.dataset.fltGenerated = "video-subtitle";
    const generatedShadow = generatedHost.attachShadow({ mode: "open" });
    generatedShadow.innerHTML = `<div class="pl-sub">Do not translate subtitle host.</div>`;

    const disabledHost = document.createElement("div");
    disabledHost.setAttribute("translate", "no");
    const disabledShadow = disabledHost.attachShadow({ mode: "open" });
    disabledShadow.innerHTML = `<p>Protected shadow content.</p>`;

    document.body.append(host, generatedHost, disabledHost);

    const provider = {
      prefersWholeSentenceHtml: async () => true,
      translateHtml: vi.fn(async (req: TranslationRequest) =>
        req.html
          .replace("Capturing a headless screenshot of the layout.", "正在截取布局的无头浏览器截图。")
          .replace("Dynamic shadow update.", "动态影子 DOM 更新。"),
      ),
    };

    const translator = new PageTranslator(document, provider, {
      sourceLanguage: "en",
      targetLanguage: "zh-Hans",
      displayMode: "bilingual",
    });

    await translator.translateAll(document.body, true);

    expect(provider.translateHtml).toHaveBeenCalledTimes(1);
    expect(shadow.querySelector('[data-flt-generated="translation"]')?.textContent).toBe("正在截取布局的无头浏览器截图。");
    expect(shadow.querySelector('style[data-flt-generated="style"]')).not.toBeNull();
    expect(generatedShadow.querySelector('[data-flt-generated="translation"]')).toBeNull();
    expect(disabledShadow.querySelector('[data-flt-generated="translation"]')).toBeNull();

    // Dynamic element inserted inside the open shadow root is also observed and translated.
    const lateP = document.createElement("p");
    lateP.textContent = "Dynamic shadow update.";
    shadow.append(lateP);
    await flushMicrotasks();

    expect(provider.translateHtml).toHaveBeenCalledTimes(2);
    expect(shadow.querySelectorAll('[data-flt-generated="translation"]')).toHaveLength(2);

    // Restoring removes generated translation nodes and shadow styles cleanly.
    translator.restore();
    expect(shadow.querySelector('[data-flt-generated="translation"]')).toBeNull();
    expect(shadow.querySelector('style[data-flt-generated="style"]')).toBeNull();
    expect(shadow.getElementById("msg")?.textContent).toBe("Capturing a headless screenshot of the layout.");
  });

  it("collects prose inside custom web component elements and Markdown divs with sibling <pre> blocks", () => {
    document.body.innerHTML = `
      <div class="turn">
        <button>Worked for 31s</button>
        <chat-prose>Capturing a headless screenshot.</chat-prose>
        <div class="markdown-body">
          <p>I'm running <code>npm run verify</code> now.</p>
          <pre><code>npm test</code></pre>
        </div>
        <div class="highlight">
          <div class="code-line"><span>const value = 1;</span></div>
          <pre><code>const value = 1;</code></pre>
        </div>
      </div>
    `;

    const roots = collectTranslationRoots(document.body, { preserveInlineContext: true });
    expect(roots).toContain(document.querySelector("chat-prose"));
    expect(roots).toContain(document.querySelector(".markdown-body > p"));
    expect(roots).not.toContain(document.querySelector(".code-line"));
  });

  it("translates dynamically inserted elements after CSS @keyframes opacity fade-in finishes", async () => {
    const provider = {
      prefersWholeSentenceHtml: async () => true,
      translateHtml: vi.fn(async (req: TranslationRequest) =>
        req.html.replace("Fade in assistant reply.", "渐显的助手回复。"),
      ),
    };

    const translator = new PageTranslator(document, provider, {
      sourceLanguage: "en",
      targetLanguage: "zh-Hans",
      displayMode: "translation",
    });
    await translator.translateAll(document.body, true);

    let resolveFade!: () => void;
    const finished = new Promise<void>((resolve) => { resolveFade = resolve; });

    const reply = document.createElement("p");
    reply.style.opacity = "0";
    reply.textContent = "Fade in assistant reply.";
    Object.defineProperty(reply, "getAnimations", {
      value: () => [{ playState: "running", finished }],
      configurable: true,
    });

    document.body.append(reply);
    await flushMicrotasks();
    // Still opacity: 0 during fade start, so not translated yet.
    expect(provider.translateHtml).toHaveBeenCalledTimes(0);

    // Animation finishes and element reaches opacity: 1 without any attribute mutation.
    reply.style.opacity = "1";
    resolveFade();
    await flushMicrotasks();

    expect(provider.translateHtml).toHaveBeenCalledTimes(1);
    expect(reply.textContent).toBe("渐显的助手回复。");
    translator.restore();
  });
});
