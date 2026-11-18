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
