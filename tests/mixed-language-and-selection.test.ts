import { afterEach, describe, expect, it, vi } from "vitest";
import {
  detectForeignLanguageFromSample,
  extractForeignTextSample,
  fragmentAlreadyInTargetScript,
  guessLanguageFromScript,
} from "../src/shared/mixed-language";
import { sendAllVisibleFramesMessage } from "../src/shared/main-frame-message";
import {
  resolveSelectionLanguages,
  SelectionTranslatorController,
} from "../src/core/selection-popover";

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe("mixed-language webpage detection (webmail CN/EN)", () => {
  it("identifies short pure-Chinese UI buttons and Chinese prose as already in zh-Hans", () => {
    expect(fragmentAlreadyInTargetScript("删除", "zh-Hans")).toBe(true);
    expect(fragmentAlreadyInTargetScript("回复全部", "zh-Hans")).toBe(true);
    expect(fragmentAlreadyInTargetScript("收件箱", "zh-Hans")).toBe(true);
    expect(fragmentAlreadyInTargetScript("今天 (2 封)", "zh-Hans")).toBe(true);
    expect(fragmentAlreadyInTargetScript("Thanks for submitting your PageLingo add-on to addons.mozilla.org!", "zh-Hans")).toBe(false);
    expect(fragmentAlreadyInTargetScript("Mozilla Add-ons: PageLingo has been submitted", "zh-Hans")).toBe(false);
    // Japanese with kana must NOT be treated as Chinese
    expect(fragmentAlreadyInTargetScript("翻訳の設定を変更できます", "zh-Hans")).toBe(false);
  });

  it("extracts only foreign email prose from a Chinese-shell webmail DOM and detects English", async () => {
    document.documentElement.lang = "zh-CN";
    document.body.innerHTML = `
      <aside>
        <button>删除</button>
        <button>回复</button>
        <button>回复全部</button>
        <button>转发</button>
        <div>收件箱 · 共 1988 封</div>
        <div>今天 (2 封) · 昨天 14:05</div>
      </aside>
      <main>
        <h1>Mozilla Add-ons: PageLingo has been submitted to addons.mozilla.org!</h1>
        <p>Thanks for submitting your PageLingo add-on to addons.mozilla.org (AMO)! Upon approval, your add-on listing will appear on our website.</p>
        <p>Please note that your add-on can be subject to human review at any time.</p>
      </main>
    `;

    const sample = extractForeignTextSample(document, "zh-Hans");
    expect(sample).not.toContain("收件箱");
    expect(sample).not.toContain("回复全部");
    expect(sample).toContain("Thanks for submitting your PageLingo add-on");

    vi.stubGlobal("browser", {
      i18n: {
        detectLanguage: vi.fn(async () => ({
          isReliable: true,
          languages: [{ language: "en", percentage: 98 }],
        })),
      },
    });
    const detected = await detectForeignLanguageFromSample(sample, "zh-Hans");
    expect(detected).toBe("en");
  });

  it("guesses non-Latin scripts cleanly when browser.i18n.detectLanguage is unavailable", () => {
    expect(guessLanguageFromScript("안녕하세요, 번역 테스트입니다", "zh-Hans")).toBe("ko");
    expect(guessLanguageFromScript("Привет, это тест перевода", "zh-Hans")).toBe("ru");
    expect(guessLanguageFromScript("これは日本語のテストです", "zh-Hans")).toBe("ja");
    expect(guessLanguageFromScript("这是一段中文测试文本", "en")).toBe("zh-Hans");
  });
});

describe("multi-frame message broadcast", () => {
  it("broadcasts translate-page to frame 0 and visible text subframes while skipping hidden iframes", async () => {
    const sendMessage = vi.fn(async (_tabId: number, _msg: unknown, opts?: { frameId?: number }) => ({
      ok: true,
      count: opts?.frameId === 0 ? 2 : 5,
      failedCount: 0,
    }));
    vi.stubGlobal("browser", {
      scripting: {
        executeScript: vi.fn(async () => [
          { frameId: 0, result: { visible: true, hasText: true } },
          { frameId: 101, result: { visible: true, hasText: true } },
          { frameId: 102, result: { visible: false, hasText: true } },
          { frameId: 103, result: { visible: true, hasText: false } },
        ]),
      },
      tabs: { sendMessage },
    });

    const results = await sendAllVisibleFramesMessage<{ ok: boolean; count: number }>(9, { type: "translate-page" });
    expect(results.map((r) => r.frameId)).toEqual([0, 101]);
    expect(results.reduce((s, r) => s + (r.response?.count ?? 0), 0)).toBe(7);
  });
});

describe("selection translation popover", () => {
  it("auto-pivots target language when selected text is already Chinese", async () => {
    vi.stubGlobal("browser", {
      i18n: {
        detectLanguage: vi.fn(async () => ({
          isReliable: true,
          languages: [{ language: "zh-CN", percentage: 99 }],
        })),
      },
    });
    const pair = await resolveSelectionLanguages("这是一段需要翻成英文的句子", "zh-Hans");
    expect(pair).toEqual({ sourceLanguage: "zh-Hans", targetLanguage: "en" });
  });

  it("renders Shadow DOM popover, translates selected text, supports inline insert and Escape close", async () => {
    document.body.innerHTML = `<p id="p1">Please note that your add-on can be subject to human review.</p>`;
    const p1 = document.getElementById("p1")!;

    const sentRequests: Array<{ bypassCache: boolean | undefined }> = [];
    vi.stubGlobal("browser", {
      i18n: {
        detectLanguage: vi.fn(async () => ({
          isReliable: true,
          languages: [{ language: "en", percentage: 99 }],
        })),
      },
      storage: {
        local: {
          get: vi.fn(async () => ({ targetLanguage: "zh-Hans", glossaryCollections: [], builtinGlossaryEnabled: true })),
        },
      },
      runtime: {
        sendMessage: vi.fn(async (msg: { type: string; request?: { bypassCache?: boolean } }) => {
          if (msg.type === "translate-html") {
            sentRequests.push({ bypassCache: msg.request?.bypassCache });
            return { ok: true, html: msg.request?.bypassCache ? "请注意（重译）：您的附加组件随时可能接受人工审核。" : "请注意：您的附加组件随时可能接受人工审核。" };
          }
          return { ok: true };
        }),
      },
    });

    const controller = new SelectionTranslatorController(document);
    controller.attach();
    await controller.translateSelection("Please note that your add-on can be subject to human review.", {
      text: "Please note that your add-on can be subject to human review.",
      rect: { left: 40, top: 40, right: 320, bottom: 64, width: 280, height: 24 },
      containerElement: p1,
    });

    const host = document.querySelector<HTMLElement>('[data-pagelingo-selection-ui="true"]');
    expect(host).toBeTruthy();
    const shadow = host!.shadowRoot!;
    expect(shadow.querySelector(".pl-result")!.textContent).toBe("请注意：您的附加组件随时可能接受人工审核。");

    // Click inline insert -> mounts closable block with SVG × (no dirty text chars) and flips button to 移除插入
    const buttons = Array.from(shadow.querySelectorAll<HTMLButtonElement>(".pl-btn"));
    const insertBtn = buttons.find((b) => b.textContent === "就地插入")!;
    insertBtn.click();
    const inserted = p1.nextElementSibling as HTMLElement;
    expect(inserted?.getAttribute("data-pagelingo-selection-inline")).toBe("true");
    expect(inserted.textContent).toBe("请注意：您的附加组件随时可能接受人工审核。");
    const inlineCloseBtn = inserted.querySelector<HTMLButtonElement>('[data-pagelingo-selection-inline-close="true"]');
    expect(inlineCloseBtn).toBeTruthy();
    expect(inlineCloseBtn?.querySelector("svg")).toBeTruthy();
    expect(document.getElementById("pagelingo-selection-inline-style")).toBeTruthy();
    expect(insertBtn.textContent).toBe("移除插入");

    // Click retranslate (bypassCache) -> button offers 更新插入, clicking updates text in place
    const retryBtn = buttons.find((b) => b.textContent === "重译")!;
    retryBtn.click();
    await vi.waitFor(() => expect(shadow.querySelector(".pl-result")!.textContent).toContain("（重译）"));
    expect(sentRequests.at(-1)?.bypassCache).toBe(true);
    expect(insertBtn.textContent).toBe("更新插入");

    insertBtn.click();
    expect(inserted.textContent).toBe("请注意（重译）：您的附加组件随时可能接受人工审核。");
    expect(inserted.querySelector('[data-pagelingo-selection-inline-close="true"]')).toBe(inlineCloseBtn);
    expect(insertBtn.textContent).toBe("移除插入");

    // Clicking 移除插入 in popover removes the inserted block and resets button
    insertBtn.click();
    expect(document.querySelector('[data-pagelingo-selection-inline="true"]')).toBeNull();
    expect(insertBtn.textContent).toBe("就地插入");

    // Re-insert, then click the top-right × button on the inserted block itself (must not bubble)
    insertBtn.click();
    const reinserted = p1.nextElementSibling as HTMLElement;
    expect(reinserted?.getAttribute("data-pagelingo-selection-inline")).toBe("true");
    const outerClickSpy = vi.fn();
    document.body.addEventListener("click", outerClickSpy);
    reinserted.querySelector<HTMLButtonElement>('[data-pagelingo-selection-inline-close="true"]')!.click();
    document.body.removeEventListener("click", outerClickSpy);
    expect(document.querySelector('[data-pagelingo-selection-inline="true"]')).toBeNull();
    expect(outerClickSpy).not.toHaveBeenCalled();
    expect(insertBtn.textContent).toBe("就地插入");

    // Press Escape to close
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(document.querySelector('[data-pagelingo-selection-ui="true"]')).toBeNull();
    controller.destroy();
  });
});
