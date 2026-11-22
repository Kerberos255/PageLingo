import {afterEach, describe, expect, it, vi} from "vitest";
import {collectTranslationRoots, isProtectedApiSignature} from "../src/core/dom-policy";
import {PageTranslator} from "../src/core/page-translator";

const declaration = '<dt class="sig sig-object py" id="asyncio.create_task"><span class="sig-prename descclassname">asyncio.</span><span class="sig-name descname">create_task</span><span class="sig-paren">(</span><em class="sig-param">coro</em>, *, <em class="sig-param">name=None</em>, <em class="sig-param">**kwargs</em><span class="sig-paren">)</span><a class="headerlink" href="#asyncio.create_task">¶</a></dt>';
afterEach(() => {document.body.innerHTML = ""; vi.restoreAllMocks();});
describe.each([true, false])("API declaration preservation (whole sentence: %s)", wholeSentence => {
  it("excludes the entire declaration without inserting anchor or text wrappers", () => {
    document.body.innerHTML = '<dl>' + declaration + '<dd>Returns a newly scheduled task.</dd></dl>';
    const root = document.querySelector("dt")!, before = root.outerHTML, nodes = [...root.childNodes];
    const roots = collectTranslationRoots(document.body, {preserveInlineContext: wholeSentence});
    expect(roots).not.toContain(root); expect(roots).toContain(document.querySelector("dd"));
    expect(root.outerHTML).toBe(before); expect([...root.childNodes]).toEqual(nodes);
    expect(root.querySelector("[data-flt-source-text-wrapper]")).toBeNull();
  });
  it("skips direct requests for both the declaration and an inline descendant", async () => {
    document.body.innerHTML = '<dl>' + declaration + '</dl>';
    const before = document.body.innerHTML, provider = {prefersWholeSentenceHtml: async () => wholeSentence,
      translateHtml: vi.fn(async () => {throw new Error("Protected API must not reach a provider");})};
    const translator = new PageTranslator(document, provider, {displayMode: "translation"});
    await translator.translateRoot(document.querySelector("dt")!);
    await translator.translateRoot(document.querySelector("em")!);
    expect(provider.translateHtml).not.toHaveBeenCalled(); expect(translator.translatedCount).toBe(0);
    expect(document.body.innerHTML).toBe(before);
  });
  it("still translates the adjacent description and restores the source exactly", async () => {
    document.body.innerHTML = '<dl>' + declaration + '<dd>Returns a newly scheduled task.</dd></dl>';
    const before = document.body.innerHTML, root = document.querySelector("dt")!, apiBefore = root.outerHTML;
    const provider = {prefersWholeSentenceHtml: async () => wholeSentence,
      translateHtml: vi.fn(async ({html}: {html: string}) => html.replace("Returns a newly scheduled task.", "返回新调度的任务。"))};
    const translator = new PageTranslator(document, provider, {displayMode: "translation"});
    await translator.translateAll();
    expect(provider.translateHtml).toHaveBeenCalledTimes(1);
    expect(provider.translateHtml.mock.calls[0]![0].html).not.toContain("create_task");
    expect(document.querySelector("dt")).toBe(root); expect(root.outerHTML).toBe(apiBefore);
    translator.restore(); expect(document.body.innerHTML).toBe(before);
  });
  it("ignores a dynamically inserted declaration through the observer path", async () => {
    const provider = {prefersWholeSentenceHtml: async () => wholeSentence, translateHtml: vi.fn(async () => "不应调用")};
    const translator = new PageTranslator(document, provider, {displayMode: "translation"});
    await translator.translateAll(); translator.observe();
    const dl = document.createElement("dl"); dl.innerHTML = declaration; document.body.append(dl);
    const before = dl.innerHTML;
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(provider.translateHtml).not.toHaveBeenCalled(); expect(dl.innerHTML).toBe(before);
    translator.restore();
  });
});
it("does not classify ordinary definition terms or generic sig spans as declarations", () => {
  document.body.innerHTML = '<dl><dt>Definition of a normal English term.</dt><dd>Its ordinary explanation.</dd></dl><p><span class="sig">A normal prose signature example.</span></p>';
  const dt = document.querySelector("dt")!, span = document.querySelector("span")!;
  expect(isProtectedApiSignature(dt)).toBe(false); expect(isProtectedApiSignature(span)).toBe(false);
  expect(collectTranslationRoots(document.body, {preserveInlineContext: true})).toContain(dt);
});
