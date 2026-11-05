import {afterEach, describe, expect, it} from "vitest";
import {captureFrozenSource, compileFrozenProjection, replayFrozenProjection} from "../eval/mt-quality/frozen-span-projection";
import {frozenProjectionFixtures} from "../eval/mt-quality/frozen-projection-fixtures";
afterEach(() => document.body.replaceChildren());
const root = (html: string) => {document.body.innerHTML = html; return document.body.firstElementChild as HTMLElement;};

describe("research frozen-target projection keeps structure before coverage", () => {
  it.each(frozenProjectionFixtures)("checks structure fixture $id", async row => {
    const r = await replayFrozenProjection(row, row.target, row.spans);
    expect(r.displayed).toBe(row.displayed);
    expect(r.original_structure_unchanged && r.code_unchanged && r.original_link_listeners_preserved && r.surrounding_text_unchanged && r.restored_exact).toBe(true);
    if (!row.displayed) expect(r.rejected_source_untouched).toBe(true);
  });
  it("redistributes ordinary words around the same emphasized node without rewriting the target", async () => {
    const target = "记录下一个样本后，再校准传感器。", at = target.indexOf("后");
    const result = await replayFrozenProjection({id: "after", html: "<p>Calibrate the sensor <em>after</em> recording the next sample.</p>"}, target, [{id: "s0", start: at, end: at + 1}]);
    expect(result.displayed && result.frozen_target_exact && result.original_structure_unchanged && result.restored_exact).toBe(true);
    expect(result.labels[0]?.target).toBe("后");
  });
  it("preserves original link identity, attributes, listeners and nested code", async () => {
    const html = '<p>Call <a href="/api" title="API" class="ref"><code>x()</code></a> now.</p>';
    const target = "调用 x()。", start = target.indexOf("x()");
    const spans = [{id: "s0", start, end: start + 3}, {id: "s1", start, end: start + 3}];
    const result = await replayFrozenProjection({id: "code-link", html}, target, spans);
    expect(result.displayed && result.original_link_listeners_preserved && result.code_unchanged && result.restored_exact).toBe(true);
  });
  it("rejects reordered immutable nodes and modified code before writing any text", () => {
    const p = root('<p>Return <code>token</code> before calling <code>close()</code>.</p>'), s = captureFrozenSource(p), before = p.outerHTML;
    const t = "调用 close() 之前返回 token。";
    expect(() => compileFrozenProjection(s, t, [{id: "s0", start: t.indexOf("token"), end: t.indexOf("token") + 5},
      {id: "s1", start: t.indexOf("close()"), end: t.indexOf("close()") + 7}])).toThrow(/reordered/);
    expect(() => compileFrozenProjection(s, "返回 key，关闭 close()。", [{id: "s0", start: 3, end: 6}, {id: "s1", start: 10, end: 17}])).toThrow();
    expect(p.outerHTML).toBe(before);
  });
  it("rejects crossing or unnested scope and missing/duplicate identities", () => {
    const p = root('<p>Read <a href="/a"><em>the guide</em></a> now.</p>'), s = captureFrozenSource(p), before = p.outerHTML;
    for (const spans of [[], [{id: "s0", start: 0, end: 2}, {id: "s0", start: 0, end: 1}],
      [{id: "s0", start: 1, end: 3}, {id: "s1", start: 0, end: 2}], [{id: "other", start: 0, end: 2}]]) {
      expect(() => compileFrozenProjection(s, "请读指南。", spans)).toThrow(); expect(p.outerHTML).toBe(before);
    }
  });
  it("refuses missing text carriers and unsupported structural children instead of adding DOM", () => {
    const p = root('<p><code>x</code> works.</p>'), s = captureFrozenSource(p), before = p.outerHTML;
    expect(() => compileFrozenProjection(s, "调用x。", [{id: "s0", start: 2, end: 3}])).toThrow(/no source node/);
    expect(p.outerHTML).toBe(before);
    expect(() => captureFrozenSource(root('<p>Read<br>this.</p>'))).toThrow(/unsupported/);
  });
  it("does not split surrogate pairs or treat frozen model text as HTML", () => {
    const p = root('<p>Read <em>this</em> now.</p>'), s = captureFrozenSource(p);
    expect(() => compileFrozenProjection(s, "看😀。", [{id: "s0", start: 2, end: 3}])).toThrow(/UTF-16/);
    const plain = root('<p>Source text.</p>'), text = '中文 <img src=x onerror="alert(1)"> 字符';
    const c = compileFrozenProjection(captureFrozenSource(plain), text, []); c.apply();
    expect(plain.textContent).toBe(text); expect(plain.querySelector("img")).toBeNull(); c.restore();
  });
  it("detects website changes both before compilation and between compilation/application", () => {
    const p = root('<p>Original text.</p>'), s = captureFrozenSource(p), compiled = compileFrozenProjection(s, "译文。", []);
    p.setAttribute("data-site", "new");
    expect(() => compiled.apply()).toThrow(/source changed/); expect(p.textContent).toBe("Original text.");
    expect(() => compileFrozenProjection(s, "译文。", [])).toThrow(/source changed/);
  });
  it("retains a later website text edit during restore", () => {
    const p = root('<p>Original text.</p>'), s = captureFrozenSource(p), compiled = compileFrozenProjection(s, "译文。", []);
    compiled.apply(); p.firstChild!.textContent = "Website update"; compiled.restore();
    expect(p.textContent).toBe("Website update");
  });
  it("rejects a root reparented by the website before application", () => {
    const p = root('<p>Original text.</p>'), s = captureFrozenSource(p), c = compileFrozenProjection(s, "译文。", []);
    const other = document.createElement("section"); document.body.append(other); other.append(p);
    expect(() => c.apply()).toThrow(/source changed/); expect(p.textContent).toBe("Original text.");
  });
  it("removes fixture DOM if source capture rejects unsupported layout", async () => {
    await expect(replayFrozenProjection({id: "unsupported", html: '<p>Read<br>this.</p>'}, "读这个。", [])).rejects.toThrow(/unsupported/);
    expect(document.body.childNodes.length).toBe(0);
  });
  it("can omit an untranslated English article while preserving its original Text object", () => {
    const p = root('<p>A <code>Connection</code> object.</p>'), node = p.firstChild, s = captureFrozenSource(p);
    const c = compileFrozenProjection(s, "Connection 对象。", [{id: "s0", start: 0, end: 10}]); c.apply();
    expect(p.firstChild).toBe(node); expect(node!.textContent).toBe(""); c.restore(); expect(node!.textContent).toBe("A ");
  });
});
