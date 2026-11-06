import {afterEach, describe, expect, it} from "vitest";
import {captureOwnedWebCases, inspectOwnedWebCase} from "../eval/mt-quality/browser-owned-projection";
import {captureOwnedSource, ownedSourceContract} from "../eval/mt-quality/owned-projection";
import {liveRequest} from "../eval/mt-quality/complex-web";

afterEach(() => document.body.replaceChildren());
function input(html = '<p>Read this ordinary paragraph.</p>') {
  document.body.innerHTML = html;
  const root = document.querySelector("p,li") as HTMLElement, source = captureOwnedSource(root), p = liveRequest(root, document.location.href);
  const item: Parameters<typeof inspectOwnedWebCase>[0] = {id: "recorded", site_id: "fixture", model: "recorded-model", locator: "p,li",
    context_url: document.location.href, natural_request: p.natural, html: root.outerHTML, source_contract: ownedSourceContract(source),
    candidate: {text: "阅读此段。", finish_reason: "stop"}, alignment_status: "projected", spans: []};
  return {item, root};
}
describe("owned live-page admission", () => {
  it("previews an actual proposal without writing source DOM", () => {
    const {item, root} = input(), before = root.outerHTML, node = root.firstChild;
    const result = inspectOwnedWebCase(item, "preview");
    expect(result).toMatchObject({status: "mechanically_compilable", source_untouched: true, displayed: false});
    expect(root.outerHTML).toBe(before); expect(root.firstChild).toBe(node);
  });
  it("does not admit a mechanically valid proposal with no scope review", () => {
    const {item, root} = input(), before = root.outerHTML;
    expect(inspectOwnedWebCase(item, "commit")).toMatchObject({status: "scope_rejected", displayed: false, rejected_source_untouched: true});
    expect(root.outerHTML).toBe(before);
  });
  it("writes only a confirmed exact proposal and restores all source nodes", () => {
    const {item, root} = input(), before = root.outerHTML, preview = inspectOwnedWebCase(item, "preview");
    if (!("proposal_key" in preview)) throw new Error("Fixture preview failed");
    item.review = {decision: "confirmed", reviewer: "assistant", proposal_key: preview.proposal_key};
    expect(inspectOwnedWebCase(item, "commit")).toMatchObject({displayed: true, owned_target_exact: true, non_owned_text_unchanged: true,
      original_structure_unchanged: true, ancestors_unchanged: true, restored_exact: true});
    expect(root.outerHTML).toBe(before);
  });
  it("does not reuse a review when its frozen target changed", () => {
    const {item, root} = input(), before = root.outerHTML, preview = inspectOwnedWebCase(item, "preview");
    if (!("proposal_key" in preview)) throw new Error("Fixture preview failed");
    item.review = {decision: "confirmed", reviewer: "assistant", proposal_key: preview.proposal_key};
    item.candidate.text = "另一份译文。";
    expect(inspectOwnedWebCase(item, "commit")).toMatchObject({status: "scope_rejected", rejected_source_untouched: true});
    expect(root.outerHTML).toBe(before);
  });
  it("recaptures independent child text edits instead of overwriting them with an old frame", () => {
    const {item, root} = input('<ul><li>Choose one:<ul><li>Old independent child.</li></ul></li></ul>');
    item.candidate.text = "请选择其一：";
    const source = captureOwnedSource(root); item.spans = source.annotations.map(a => ({id: a.id, start: 0, end: item.candidate.text.length}));
    const preview = inspectOwnedWebCase(item, "preview"); if (!("proposal_key" in preview)) throw new Error("Fixture preview failed");
    item.review = {decision: "confirmed", reviewer: "assistant", proposal_key: preview.proposal_key};
    root.querySelector("li")!.firstChild!.textContent = "Latest website child text";
    const before = root.outerHTML;
    expect(inspectOwnedWebCase(item, "commit")).toMatchObject({displayed: true, source_version_refreshed: true, non_owned_text_unchanged: true, restored_exact: true});
    expect(root.outerHTML).toBe(before);
  });
  it("does not use a cached translation after owned source text changed", () => {
    const {item, root} = input(); root.firstChild!.textContent = "New owned English input."; const before = root.outerHTML;
    expect(inspectOwnedWebCase(item, "commit")).toMatchObject({status: "source_contract_changed", displayed: false, rejected_source_untouched: true});
    expect(root.outerHTML).toBe(before);
  });
  it("keeps a website's new link target and refuses the old reviewed source contract", () => {
    const {item, root} = input('<p>Read <a href="/old">the guide</a> now.</p>');
    root.querySelector("a")!.setAttribute("href", "/latest"); const before = root.outerHTML;
    expect(inspectOwnedWebCase(item, "commit")).toMatchObject({status: "source_contract_changed", displayed: false});
    expect(root.outerHTML).toBe(before);
  });
  it("captures request parity and explicitly skips protected API declarations", () => {
    const {item, root} = input(), p = liveRequest(root, document.location.href);
    expect(captureOwnedWebCases([{...item, captured_fixed_calls: p.calls}])[0]).toMatchObject({status: "supported",
      cached_natural_request_matches: true, cached_production_calls_match: true, wire_unchanged_by_trace: true});
    document.body.innerHTML = '<dl><dt class="sig">task(name=None)</dt></dl>';
    expect(captureOwnedWebCases([{...item, locator: "dt"}])[0]).toMatchObject({status: "protected_api"});
  });
});
