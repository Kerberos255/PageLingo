import {afterEach, expect, it, vi} from "vitest";

afterEach(() => {vi.unstubAllGlobals(); document.body.replaceChildren(); vi.resetModules();});

it("keeps language detection, translation count and restore tied to the main document when an iframe can answer first", async () => {
  document.body.innerHTML = '<div id="status"></div><div id="detected-language"></div><button id="translate">translate</button><button id="restore">restore</button><select id="source-language"></select><select id="target-language"></select><input id="site-auto" type="checkbox"><small id="site-auto-hint"></small>';
  let tabUrl = "https://example.org/article";
  const sendMessage = vi.fn(async (_tab: number, message: {type: string}, options?: {frameId?: number}) => {
    const main = options?.frameId === 0;
    if (message.type === "get-page-language") return {ok: true, language: {effectiveLanguage: main ? "en" : "zh-Hans"}};
    if (message.type === "translate-page") return {ok: true, count: main ? 7 : 0, failedCount: main ? 2 : 0};
    return {ok: main};
  });
  vi.stubGlobal("browser", {
    tabs: {query: vi.fn(async () => [{id: 42, url: tabUrl}]), sendMessage},
    storage: {local: {get: vi.fn(async () => ({targetLanguage: "zh-Hans", glossaryCollections: []})), set: vi.fn(async () => {})}, onChanged: {addListener: vi.fn()}},
    runtime: {sendMessage: vi.fn(async (message: {type: string}) => message.type === "get-language-catalog"
      ? {ok: true, catalog: {sourceLanguages: [{code: "en", label: "English"}], targetLanguages: [{code: "zh-Hans", label: "中文"}]}}
      : {ok: true, supported: true})},
  });
  await import("../src/popup");
  await vi.waitFor(() => expect(document.querySelector("#detected-language")!.textContent).toMatch(/英语|English/u));
  document.querySelector<HTMLButtonElement>("#translate")!.click();
  await vi.waitFor(() => expect(document.querySelector("#status")!.textContent).toBe("已翻译 7 个段落；2 个未完成，已保留原文"));
  document.querySelector<HTMLButtonElement>("#restore")!.click();
  await vi.waitFor(() => expect(document.querySelector("#status")!.textContent).toBe("已恢复原文"));
  expect(sendMessage.mock.calls.map(([, message]) => message.type)).toEqual(["get-page-language", "translate-page", "restore-page"]);
  expect(sendMessage.mock.calls.every(([, , options]) => options?.frameId === 0)).toBe(true);
  expect(document.querySelector("#site-auto-hint")!.textContent).toBe("example.org");
  tabUrl = "moz-extension://example-extension/settings.html";
  document.querySelector("#source-language")!.dispatchEvent(new Event("change"));
  await vi.waitFor(() => expect(document.querySelector<HTMLInputElement>("#site-auto")!.disabled).toBe(true));
  expect(document.querySelector("#site-auto-hint")!.textContent).toBe("");
});

it("switches active translation engine from the popup without auto-retranslating an already translated page", async () => {
  document.body.innerHTML = '<div id="status"></div><div id="detected-language"></div><button id="translate">translate</button><button id="restore">restore</button><select id="source-language"></select><select id="target-language"></select><select id="active-engine"></select><input id="site-auto" type="checkbox"><small id="site-auto-hint"></small>';
  const engineState = {
    activeEngineId: "firefox-local",
    engines: [
      { id: "engine-openai", name: "OpenAI", enabled: true, hasApiKey: true },
      { id: "engine-disabled", name: "Disabled", enabled: false, hasApiKey: false },
    ],
  };
  const requestConsent = vi.fn(async () => true);
  const sendTabMessage = vi.fn(async (_tab: number, message: { type: string }) => {
    if (message.type === "get-page-language") return { ok: true, language: { effectiveLanguage: "en" } };
    if (message.type === "get-context-menu-state") return { ok: true, pageTranslated: true };
    return { ok: true };
  });
  const sendRuntime = vi.fn(async (message: { type: string; id?: string }) => {
    if (message.type === "get-language-catalog") {
      return { ok: true, catalog: { sourceLanguages: [{ code: "en", label: "English" }], targetLanguages: [{ code: "zh-Hans", label: "简体中文" }] } };
    }
    if (message.type === "get-translation-engines") return { ok: true, state: { ...engineState } };
    if (message.type === "set-active-translation-engine" && message.id) {
      engineState.activeEngineId = message.id;
      return { ok: true, state: { ...engineState } };
    }
    return { ok: true, supported: true };
  });
  vi.stubGlobal("browser", {
    tabs: { query: vi.fn(async () => [{ id: 7, url: "https://docs.openclaw.ai/" }]), sendMessage: sendTabMessage },
    storage: { local: { get: vi.fn(async () => ({ targetLanguage: "zh-Hans", glossaryCollections: [] })), set: vi.fn(async () => {}) }, onChanged: { addListener: vi.fn() } },
    runtime: { sendMessage: sendRuntime },
    permissions: { request: requestConsent, contains: vi.fn(async () => true) },
  });

  await import("../src/popup");
  const select = document.querySelector<HTMLSelectElement>("#active-engine")!;
  await vi.waitFor(() => expect(Array.from(select.options).map((o) => o.textContent)).toEqual([
    "Firefox 本地翻译",
    "微软翻译",
    "Google 翻译",
    "OpenAI",
  ]));

  select.value = "builtin-microsoft-free";
  select.dispatchEvent(new Event("change"));
  await vi.waitFor(() => expect(document.querySelector("#status")!.textContent).toBe("已切换到 微软翻译，可点击「翻译本页」重新翻译"));
  expect(requestConsent).toHaveBeenCalledWith({ data_collection: ["websiteContent"] });
  expect(sendTabMessage.mock.calls.some(([, m]) => m.type === "translate-page")).toBe(false);
});

it("translates multi-line text inside the popup card, supports auto-pivot, swap, copy, clear, and Enter shortcut", async () => {
  document.body.innerHTML = `
    <div id="status"></div>
    <div id="detected-language"></div>
    <button id="translate">translate</button>
    <button id="restore">restore</button>
    <select id="source-language"></select>
    <select id="target-language"></select>
    <select id="active-engine"></select>
    <input id="site-auto" type="checkbox">
    <small id="site-auto-hint"></small>
    <select id="text-source-language"></select>
    <button id="text-swap-language" type="button">⇄</button>
    <select id="text-target-language"></select>
    <textarea id="text-translate-input"></textarea>
    <span id="text-translate-meta"></span>
    <button id="text-translate-clear" type="button" hidden>清空</button>
    <button id="text-translate-submit" type="button">翻译 ↵</button>
    <div id="text-translate-result-wrap" hidden>
      <div id="text-translate-result"></div>
      <span id="text-translate-result-lang"></span>
      <button id="text-translate-copy" type="button">复制</button>
    </div>
  `;

  const translatedRequests: Array<{ sourceLanguage: string; targetLanguage: string; html: string }> = [];
  const writeText = vi.fn(async () => {});
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });

  const sendRuntime = vi.fn(async (message: {
    type: string;
    request?: { sourceLanguage: string; targetLanguage: string; html: string };
    requests?: Array<{ sourceLanguage: string; targetLanguage: string; html: string }>;
  }) => {
    if (message.type === "get-language-catalog") {
      return {
        ok: true,
        catalog: {
          sourceLanguages: [{ code: "en", label: "English" }, { code: "zh-Hans", label: "简体中文" }],
          targetLanguages: [{ code: "zh-Hans", label: "简体中文" }, { code: "en", label: "English" }],
        },
      };
    }
    if (message.type === "get-translation-engines") {
      return { ok: true, state: { activeEngineId: "firefox-local", engines: [], batchSize: 16 } };
    }
    if (message.type === "can-translate") return { ok: true, supported: true };
    if (message.type === "translate-html-batch" && message.requests) {
      translatedRequests.push(...message.requests);
      return {
        ok: true,
        htmls: message.requests.map((req) => `[${req.sourceLanguage}->${req.targetLanguage}] ${req.html}`),
      };
    }
    if (message.type === "translate-html" && message.request) {
      translatedRequests.push(message.request);
      return {
        ok: true,
        html: `[${message.request.sourceLanguage}->${message.request.targetLanguage}] ${message.request.html}`,
      };
    }
    return { ok: true };
  });

  vi.stubGlobal("browser", {
    tabs: { query: vi.fn(async () => [{ id: 1, url: "https://example.org/" }]), sendMessage: vi.fn(async () => ({ ok: true, language: { effectiveLanguage: "en" } })) },
    storage: { local: { get: vi.fn(async () => ({ targetLanguage: "zh-Hans", glossaryCollections: [], builtinGlossaryEnabled: true })), set: vi.fn(async () => {}) }, onChanged: { addListener: vi.fn() } },
    runtime: { sendMessage: sendRuntime },
    i18n: {
      detectLanguage: vi.fn(async (sample: string) => ({
        isReliable: true,
        languages: [{ language: /\p{Script=Han}/u.test(sample) ? "zh-CN" : "en", percentage: 100 }],
      })),
    },
  });

  await import("../src/popup");
  const input = document.querySelector<HTMLTextAreaElement>("#text-translate-input")!;
  const submit = document.querySelector<HTMLButtonElement>("#text-translate-submit")!;
  const resultWrap = document.querySelector<HTMLElement>("#text-translate-result-wrap")!;
  const resultEl = document.querySelector<HTMLElement>("#text-translate-result")!;
  const resultLang = document.querySelector<HTMLElement>("#text-translate-result-lang")!;
  const clearBtn = document.querySelector<HTMLButtonElement>("#text-translate-clear")!;
  const copyBtn = document.querySelector<HTMLButtonElement>("#text-translate-copy")!;
  const swapBtn = document.querySelector<HTMLButtonElement>("#text-swap-language")!;
  const textSrc = document.querySelector<HTMLSelectElement>("#text-source-language")!;
  const textTgt = document.querySelector<HTMLSelectElement>("#text-target-language")!;

  await vi.waitFor(() => expect(textTgt.value).toBe("zh-Hans"));

  // Multi-line input translated in a single batch preserving empty line.
  input.value = "Hello world\n\nSecond line";
  input.dispatchEvent(new Event("input"));
  expect(clearBtn.hidden).toBe(false);

  // Shift+Enter should NOT trigger translation.
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, cancelable: true }));
  expect(resultWrap.hidden).toBe(true);

  // Plain Enter triggers translation.
  const enterEvent = new KeyboardEvent("keydown", { key: "Enter", cancelable: true });
  input.dispatchEvent(enterEvent);
  expect(enterEvent.defaultPrevented).toBe(true);

  await vi.waitFor(() => expect(resultWrap.hidden).toBe(false));
  expect(resultEl.textContent).toBe("[en->zh-Hans] Hello world\n\n[en->zh-Hans] Second line");
  expect(resultLang.textContent).toBe("English → 简体中文");

  // Copy button writes result to clipboard.
  copyBtn.click();
  await vi.waitFor(() => expect(copyBtn.textContent).toBe("已复制"));
  expect(writeText).toHaveBeenCalledWith("[en->zh-Hans] Hello world\n\n[en->zh-Hans] Second line");

  // Auto-pivot: entering Chinese while source=auto and target=zh-Hans translates to English.
  input.value = "你好世界";
  input.dispatchEvent(new Event("input"));
  submit.click();
  await vi.waitFor(() => expect(resultEl.textContent).toBe("[zh-Hans->en] 你好世界"));
  expect(resultLang.textContent).toBe("简体中文 → English");

  // Swap switches auto+zh-Hans to explicit language pair.
  swapBtn.click();
  expect(textSrc.value).toBe("zh-Hans");
  expect(textTgt.value).toBe("en");

  // Clear resets input and hides result.
  clearBtn.click();
  expect(input.value).toBe("");
  expect(resultWrap.hidden).toBe(true);
  expect(clearBtn.hidden).toBe(true);
});

it("switches primary button to forced retranslate when page is already translated and reverts to cached mode after restore", async () => {
  document.body.innerHTML = '<div id="status"></div><div id="detected-language"></div><button id="translate">翻译本页</button><button id="restore">显示原文</button><select id="source-language"></select><select id="target-language"></select><input id="site-auto" type="checkbox"><small id="site-auto-hint"></small>';
  const sentMessages: Array<{ type: string; bypassCache?: boolean }> = [];
  const sendMessage = vi.fn(async (_tab: number, message: { type: string; bypassCache?: boolean }) => {
    sentMessages.push(message);
    if (message.type === "get-page-language") {
      return { ok: true, pageTranslated: true, language: { effectiveLanguage: "en" } };
    }
    if (message.type === "translate-page") return { ok: true, count: 5, failedCount: 0 };
    return { ok: true };
  });
  vi.stubGlobal("browser", {
    tabs: { query: vi.fn(async () => [{ id: 9, url: "https://example.org/" }]), sendMessage },
    storage: { local: { get: vi.fn(async () => ({ targetLanguage: "zh-Hans", glossaryCollections: [] })), set: vi.fn(async () => {}) }, onChanged: { addListener: vi.fn() } },
    runtime: {
      sendMessage: vi.fn(async (msg: { type: string }) => msg.type === "get-language-catalog"
        ? { ok: true, catalog: { sourceLanguages: [{ code: "en", label: "English" }], targetLanguages: [{ code: "zh-Hans", label: "简体中文" }] } }
        : { ok: true, supported: true }),
    },
  });

  await import("../src/popup");
  const translateBtn = document.querySelector<HTMLButtonElement>("#translate")!;
  const restoreBtn = document.querySelector<HTMLButtonElement>("#restore")!;
  await vi.waitFor(() => expect(translateBtn.textContent).toBe("重新翻译"));

  // Clicking on an already-translated page sends bypassCache: true.
  translateBtn.click();
  await vi.waitFor(() => expect(document.querySelector("#status")!.textContent).toBe("已重新翻译 5 个段落"));
  expect(sentMessages.at(-1)).toMatchObject({ type: "translate-page", bypassCache: true });

  // Restoring reverts the primary button back to cached '翻译本页'.
  restoreBtn.click();
  await vi.waitFor(() => expect(translateBtn.textContent).toBe("翻译本页"));

  translateBtn.click();
  await vi.waitFor(() => expect(document.querySelector("#status")!.textContent).toBe("已翻译 5 个段落"));
  expect(sentMessages.at(-1)?.bypassCache).toBeUndefined();
});
