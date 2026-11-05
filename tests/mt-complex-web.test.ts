import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {captureComplexPage, liveRequest, replayOnLiveRoot, sourceLocator, type LiveReplayInput} from "../eval/mt-quality/complex-web";

beforeEach(() => {
  document.body.innerHTML = "";
  window.history.replaceState(null, "", "/docs");
});
afterEach(() => {document.body.innerHTML = ""; vi.restoreAllMocks();});
async function checked(i: LiveReplayInput) {
  const result = await replayOnLiveRoot(i);
  if (!result.source_matches) throw new Error("Unexpected fixture source mismatch");
  return result;
}
function input(html: string): LiveReplayInput {
  document.body.innerHTML = html;
  const root = document.body.firstElementChild as HTMLElement, p = liveRequest(root, document.location.href);
  return {id: "live-root", locator: "body > :first-child", html: root.outerHTML, context_url: document.location.href,
    fixed_source: p.semantic.fixed.source, fixed_calls: p.calls, natural: p.natural,
    mode: "projection", alignment_status: "projected", target: "先阅读指南，然后保存。", spans: [{id: "s0", start: 3, end: 5}]};
}
describe("live complex-page recorded-output guards", () => {
  it("preserves the actual link object, target, handler and exact restoration", async () => {
    const i = input('<p>Read the <a href="/guide" target="_blank" rel="noreferrer">guide</a> before saving.</p>');
    const a = document.querySelector("a")!, callback = () => {};
    a.onclick = callback;
    const before = document.body.innerHTML, r = await checked(i);
    expect(r.displayed).toBe(true); expect(r.frozen_target_exact).toBe(true);
    expect(r.original_structure_unchanged).toBe(true); expect(r.ancestor_structure_unchanged).toBe(true);
    expect(r.link_targets_and_handler_properties_unchanged).toBe(true);
    expect(r.nonnavigation_listener_sentinel_preserved).toBe(true);
    expect(document.querySelector("a")).toBe(a); expect(a.onclick).toBe(callback);
    expect(document.body.innerHTML).toBe(before); expect(r.restored_exact).toBe(true);
  });
  it("refuses a changed source before any write", async () => {
    const i = input('<p>Read the <a href="/guide">guide</a> before saving.</p>');
    document.querySelector("a")!.setAttribute("href", "/new-guide");
    const before = document.body.innerHTML, r = await replayOnLiveRoot(i);
    expect(r.source_matches).toBe(false); expect(r.displayed).toBe(false); expect(document.body.innerHTML).toBe(before);
  });
  it("refuses a changed live URL", async () => {
    const i = input('<p>Read the <a href="/guide">guide</a> before saving.</p>');
    window.history.replaceState(null, "", "/other-doc");
    expect((await replayOnLiveRoot(i)).source_matches).toBe(false);
  });
  it("rejects recorded requests that differ from production", async () => {
    const i = input('<p>Read the <a href="/guide">guide</a> before saving.</p>');
    i.fixed_calls = structuredClone(i.fixed_calls); i.fixed_calls[0]!.max_tokens++;
    await expect(replayOnLiveRoot(i)).rejects.toThrow("Live production request differs");
  });
  it("accepts identical request data after WebDriver reorders JSON object fields", async () => {
    const i = input('<p>Read the <a href="/guide">guide</a> before saving.</p>');
    const reordered = (v: any): any => Array.isArray(v) ? v.map(reordered) : v && typeof v === "object"
      ? Object.fromEntries(Object.keys(v).sort().map(k => [k, reordered(v[k])])) : v;
    const r = await checked(reordered(i));
    expect(r.displayed).toBe(true); expect(r.request_matches).toBe(true); expect(r.restored_exact).toBe(true);
  });
  it("keeps the source intact when alignment refuses an otherwise valid translation", async () => {
    const i = input('<p>Read the <a href="/guide">guide</a> before saving.</p>');
    i.alignment_status = "rejected"; i.alignment_reason = "full source content-word coverage unavailable";
    const before = document.body.innerHTML, r = await checked(i);
    expect(r.displayed).toBe(false); expect(r.rejected_source_untouched).toBe(true); expect(r.restored_exact).toBe(true);
    expect(document.body.innerHTML).toBe(before);
  });
  it("uses the production EOS refusal and preserves the full paragraph", async () => {
    const i = input('<p>Read the <a href="/guide">guide</a> before saving.</p>');
    i.mode = "production"; i.completions = [{text: "truncated", finish_reason: "length"}];
    const r = await checked(i);
    expect(r.displayed).toBe(false); expect(r.consumed).toBe(1); expect(r.rejected_source_untouched).toBe(true);
    expect(r.restored_source_text_nodes).toBe(true);
  });
  it("replays a real table-cell root without inserting or moving original nodes", async () => {
    document.body.innerHTML = '<table><tbody><tr><td>Read the <a href="/guide">guide</a> before saving.</td></tr></tbody></table>';
    const root = document.querySelector("td")!, p = liveRequest(root, document.location.href), table = document.querySelector("table");
    const r = await checked({id: "cell", locator: "td", html: root.outerHTML, context_url: document.location.href,
      fixed_source: p.semantic.fixed.source, fixed_calls: p.calls, natural: p.natural, mode: "projection", alignment_status: "projected",
      target: "先阅读指南，然后保存。", spans: [{id: "s0", start: 3, end: 5}]});
    expect(r.displayed).toBe(true); expect(r.ancestor_structure_unchanged).toBe(true);
    expect(document.querySelector("table")).toBe(table); expect(document.querySelector("td")).toBe(root); expect(r.restored_exact).toBe(true);
  });
  it("inventories overlapping structural roots and refuses flattening a nested list", () => {
    document.body.innerHTML = '<main><ul><li>Before you close the dialog, check the following <strong>documentation</strong> and keyboard interaction requirements.<ol><li>Use the Escape key to close this dialog and return focus safely to the previous control.</li></ol></li></ul></main>';
    vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([{}] as unknown as DOMRectList);
    const r = captureComplexPage("nested", ["main"]);
    expect(r.overlapping_root_pairs).toBeGreaterThan(0);
    const c = r.cases.find(c => c.prepared && !c.projection.supported);
    expect(c?.prepared && !c.projection.supported && c.projection.reason).toContain("unsupported inline element: OL");
  });
  it("includes a short plain table cell as a separate source-only stratum", () => {
    document.body.innerHTML = '<main><table><tbody><tr><td>All containers have stopped and at least one has failed.</td></tr></tbody></table></main>';
    vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([{}] as unknown as DOMRectList);
    const r = captureComplexPage("table", ["main"]);
    expect(r.cases).toHaveLength(1); expect(r.cases[0]?.stats.table_cell).toBe(true);
    expect(r.cases[0]?.prepared).toBe(true); expect(r.selection.extra_table_stratum).toBe(true);
    expect(sourceLocator(document.querySelector("td")!)).toContain("td:nth-child(1)");
  });
});
