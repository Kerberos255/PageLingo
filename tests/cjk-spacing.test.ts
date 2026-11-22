import {afterEach, describe, expect, it} from "vitest";
import {serializeRichSegment} from "../src/core/rich-segment";
import {applyFixedTextRecord, clearFixedTextRecord, prepareFixedTextRecord} from "../src/core/fixed-text-render";

afterEach(() => document.body.replaceChildren());
function prepare(source: string, translations: string[], language = "zh-Hans") {
  document.body.innerHTML = source;
  const root = document.body.firstElementChild as HTMLElement, before = root.outerHTML;
  const segment = serializeRichSegment(root, {fixedTextSlots: true});
  expect(segment.textSlots!.length).toBe(translations.length);
  const wire = new DOMParser().parseFromString(segment.html, "text/html").body;
  [...wire.querySelectorAll("[data-flt-text-id]")].forEach((node, i) => node.textContent = translations[i]!);
  const record = prepareFixedTextRecord(root, segment.textSlots!, wire.innerHTML, language);
  expect(root.outerHTML).toBe(before);
  return {root, before, record};
}

describe("Chinese prose spacing without changing ownership", () => {
  it("removes English padding between Chinese words and before a closing punctuation mark", () => {
    const {root, before, record} = prepare('<p>Read the <a href="/guide">guide</a> before continuing.</p>', ["继续之前，请阅读 ", "指南", " 。"]);
    const nodes = [...root.childNodes], link = root.querySelector("a")!, click = () => {}; link.onclick = click;
    expect(applyFixedTextRecord(root, record, "translation", "zh-Hans")).toBe(true);
    expect(root.textContent).toBe("继续之前，请阅读指南。");
    expect([...root.childNodes]).toEqual(nodes); expect(root.querySelector("a")).toBe(link); expect(link.onclick).toBe(click);
    link.onclick = null; link.removeAttribute("onclick"); clearFixedTextRecord(record); expect(root.outerHTML).toBe(before);
  });

  it("keeps Latin identifiers readable while leaving added padding outside the link", () => {
    const {root, before, record} = prepare('<p>Use <a href="/api">API</a> docs.</p>', ["参阅", "API", "文档。"]);
    applyFixedTextRecord(root, record, "translation", "zh-Hans");
    expect(root.textContent).toBe("参阅 API 文档。"); expect(root.querySelector("a")!.textContent).toBe("API");
    clearFixedTextRecord(record); expect(root.outerHTML).toBe(before);
  });

  it("normalizes adjacent Chinese emphasis spans without moving words", () => {
    const {root, record} = prepare('<p>Read <strong>this</strong> manual.</p>', ["阅读 ", "此 ", "手册。"]);
    applyFixedTextRecord(root, record, "translation", "zh-Hans");
    expect(root.textContent).toBe("阅读此手册。"); expect(root.querySelector("strong")!.textContent).toBe("此");
  });

  it("preserves intentional spacing inside a model-authored text slot", () => {
    const {root, record} = prepare('<p>Heaven earth human.</p>', ["天 地 人。"]);
    applyFixedTextRecord(root, record, "translation", "zh-Hans"); expect(root.textContent).toBe("天 地 人。");
  });

  it("retains code, nonbreaking spaces and source-owned separators", () => {
    const code = prepare('<p>Run <code>npm test</code> first.</p>', ["运行 ", " 后再继续。"]);
    applyFixedTextRecord(code.root, code.record, "translation", "zh-Hans");
    expect(code.root.innerHTML).toBe('运行 <code>npm test</code> 后再继续。');
    const nbsp = prepare('<p>Read&nbsp;<a>guide</a> now.</p>', ["阅读\u00a0", "指南", "后继续。"]);
    applyFixedTextRecord(nbsp.root, nbsp.record, "translation", "zh-Hans"); expect(nbsp.root.textContent).toBe("阅读\u00a0指南后继续。");
    const fixed = prepare('<p>Read <em>this</em> <strong>guide</strong> now.</p>', ["阅读", "此", "指南", "。"]);
    applyFixedTextRecord(fixed.root, fixed.record, "translation", "zh-Hans"); expect(fixed.root.textContent).toBe("阅读此 指南。");
  });

  it.each(["pre", "pre-wrap", "pre-line", "break-spaces"])("preserves preformatted whitespace: %s", whiteSpace => {
    const {root, record} = prepare(`<p style="white-space:${whiteSpace}">Read <em>this</em> now.</p>`, ["阅读  ", "此", " 。"]);
    applyFixedTextRecord(root, record, "translation", "zh-Hans"); expect(root.textContent).toBe("阅读  此 。");
  });

  it.each(['<br>', '<img src="/diagram.svg" alt="diagram">', '<svg><path d="M0 0"/></svg>', '<code></code>', '<span aria-hidden="true"></span>'])("does not cross a layout/empty atom: %s", atom => {
    const {root, record} = prepare(`<p>Read ${atom}<em>guide</em>.</p>`, ["阅读 ", "指南"]);
    applyFixedTextRecord(root, record, "translation", "zh-Hans"); expect(root.textContent).toBe("阅读 指南.");
  });

  it("preserves spaces at a block boundary and rechecks a newly introduced block", () => {
    const block = prepare('<p>Read <em style="display:block">guide</em>.</p>', ["阅读 ", "指南"]);
    applyFixedTextRecord(block.root, block.record, "translation", "zh-Hans"); expect(block.root.textContent).toBe("阅读 指南.");
    const dynamic = prepare('<p>Read <em>guide</em>.</p>', ["阅读 ", "指南"]);
    dynamic.root.querySelector("em")!.style.display = "block";
    const before = dynamic.root.innerHTML;
    expect(applyFixedTextRecord(dynamic.root, dynamic.record, "translation", "zh-Hans")).toBe(false);
    expect(dynamic.root.innerHTML).toBe(before);
  });

  it("rechecks the live CSS before writing spacing-normalized text", () => {
    const {root, record} = prepare('<p>Read <em>this</em> now.</p>', ["阅读 ", "此", " 。"]);
    const before = root.innerHTML; root.style.whiteSpace = "pre-wrap";
    expect(applyFixedTextRecord(root, record, "translation", "zh-Hans")).toBe(false); expect(root.innerHTML).toBe(before);
  });

  it("keeps other target languages and repeated display-mode toggles stable", () => {
    const en = prepare('<p>Read <a>guide</a> now.</p>', ["Read ", "指南", " now ."], "en");
    applyFixedTextRecord(en.root, en.record, "translation", "en"); expect(en.root.textContent).toBe("Read 指南 now .");
    const zh = prepare('<p>Read <a>guide</a> now.</p>', ["现在阅读 ", "指南", " 。"]);
    for (const mode of ["translation", "bilingual", "translation"] as const) expect(applyFixedTextRecord(zh.root, zh.record, mode, "zh-Hans")).toBe(true);
    expect(zh.root.textContent).toBe("现在阅读指南。"); clearFixedTextRecord(zh.record); expect(zh.root.outerHTML).toBe(zh.before);
  });
});
