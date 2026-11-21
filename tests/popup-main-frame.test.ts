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
