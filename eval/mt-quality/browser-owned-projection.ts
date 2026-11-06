import {liveRequest} from "./complex-web";
import {captureOwnedSource, ownedSourceContract, canonicalOwnedData, compileOwnedProjection, ownedProposalKey,
  applyReviewedOwnedProjection, type FrozenCandidate, type OwnedScopeReview} from "./owned-projection";
import {isProtectedApiSignature} from "../../src/core/dom-policy";
import {serializeRichSegment, type SerializedSourcePart} from "../../src/core/rich-segment";
import type {TargetSpan} from "./frozen-span-projection";

interface ParentCase {id: string; site_id: string; locator: string; context_url: string; natural_request: unknown; captured_fixed_calls?: unknown; punctuation_policy?: "strict" | "prose-v1"; whitespace_policy?: "literal" | "collapse-v1"; allocation_policy?: "fixed" | "prose-gaps-v1"}
interface InputCase extends ParentCase {
  model: string; source_contract: unknown; html: string; candidate: FrozenCandidate;
  alignment_status: string; alignment_reason?: string; spans: TargetSpan[]; review?: OwnedScopeReview;
}
const attrs = (e: Element) => JSON.stringify([...e.attributes].map(a => [a.name, a.value]));
const words = (text: string, language: string) => [...new Intl.Segmenter(language, {granularity: "word"}).segment(text)]
  .filter(x => x.segment.trim()).map(x => ({text: x.segment, start: x.index, end: x.index + x.segment.length, lexical: x.isWordLike === true}));
function boundarySummary(parts: SerializedSourcePart[]): unknown[] {
  return parts.flatMap(p => p.kind === "boundary" ? [{tag: p.node.tagName, reason: p.reason,
    display: p.node.ownerDocument.defaultView!.getComputedStyle(p.node).display, visibility: p.node.ownerDocument.defaultView!.getComputedStyle(p.node).visibility,
    sample: p.node.textContent?.slice(0, 100)}] : p.kind === "element" ? boundarySummary(p.children) : []);
}
export function captureOwnedWebCases(cases: ParentCase[]) {
  return cases.map(c => {
    const root = document.querySelector(c.locator) as HTMLElement | null;
    if (!root) return {id: c.id, status: "missing_source", reason: "Live locator no longer exists"};
    if (isProtectedApiSignature(root)) return {id: c.id, status: "protected_api", html: root.outerHTML};
    try {
      const p = liveRequest(root, document.location.href), source = captureOwnedSource(root, {punctuationPolicy: c.punctuation_policy ?? "strict", whitespacePolicy: c.whitespace_policy ?? "literal", allocationPolicy: c.allocation_policy ?? "fixed"});
      const plain = serializeRichSegment(root, {fixedTextSlots: true});
      if (plain.html !== source.segment.html) throw new Error("Ownership trace changed production wire HTML");
      const source_contract = ownedSourceContract(source);
      return {id: c.id, site_id: c.site_id, status: "supported", url: document.location.href, locator: c.locator,
        html: root.outerHTML, source_text: source.sourceText, source_words: words(source.sourceText, "en"), punctuation_policy: source.punctuationPolicy, whitespace_policy: source.whitespacePolicy, allocation_policy: source.allocationPolicy,
        source_contract, natural_request: p.natural, annotations: source.annotations,
        cached_natural_request_matches: c.context_url === document.location.href && canonicalOwnedData(p.natural) === canonicalOwnedData(c.natural_request),
        cached_production_calls_match: canonicalOwnedData(p.calls) === canonicalOwnedData(c.captured_fixed_calls),
        wire_unchanged_by_trace: true, owned_slots: source.slots.length,
        trace_boundaries: boundarySummary(source.trace.parts)};
    } catch (e) {
      if (e instanceof TypeError || e instanceof ReferenceError) throw e;
      return {id: c.id, status: "source_rejected", reason: String(e), html: root.outerHTML};
    }
  });
}
export function inspectOwnedWebCase(input: InputCase, mode: "preview" | "commit") {
  const root = document.querySelector(input.locator) as HTMLElement | null;
  const base = {id: input.id, site_id: input.site_id, model: input.model, mode};
  if (!root || document.location.href !== input.context_url) return {...base, status: "source_changed", displayed: false, reason: "Locator or URL changed"};
  const before = root.outerHTML;
  try {
    const p = liveRequest(root, document.location.href), source = captureOwnedSource(root, {punctuationPolicy: input.punctuation_policy ?? "strict", whitespacePolicy: input.whitespace_policy ?? "literal", allocationPolicy: input.allocation_policy ?? "fixed"});
    if (canonicalOwnedData(p.natural) !== canonicalOwnedData(input.natural_request)
      || canonicalOwnedData(ownedSourceContract(source)) !== canonicalOwnedData(input.source_contract)) {
      return {...base, status: "source_contract_changed", displayed: false, rejected_source_untouched: root.outerHTML === before,
        reason: "Recaptured source does not match frozen request/ownership contract"};
    }
    const refreshed = before !== input.html;
    if (input.alignment_status !== "projected") return {...base, status: "alignment_or_candidate_rejected", displayed: false,
      source_version_refreshed: refreshed, rejected_source_untouched: root.outerHTML === before, reason: input.alignment_reason};
    const compiled = compileOwnedProjection(source, input.candidate, input.spans), proposal_key = ownedProposalKey(source, input.candidate, input.spans);
    if (mode === "preview") return {...base, status: "mechanically_compilable", displayed: false, source_version_refreshed: refreshed,
      source_untouched: root.outerHTML === before, proposal_key, assignments: compiled.assignments,
      planned_owned_target_exact: true, target: input.candidate.text};
    if (!input.review || input.review.decision !== "confirmed" || input.review.proposal_key !== proposal_key) {
      return {...base, status: "scope_rejected", displayed: false, source_version_refreshed: refreshed,
        rejected_source_untouched: root.outerHTML === before, reason: "Scope not confirmed for this exact proposal"};
    }
    const nodes = source.snapshot, owned = new Set(source.slots.map(s => s.node as Node));
    const links = [...root.querySelectorAll("a")].map(node => ({node, attrs: attrs(node), handler: node.onclick}));
    const codes = [...root.querySelectorAll("code,kbd,samp,var")].map(node => ({node, html: node.outerHTML}));
    let sentinels = 0;
    const eventType = "pagelingo-owned-preservation", listener = () => {sentinels++;};
    links.forEach(x => x.node.addEventListener(eventType, listener));
    try {
      const applied = applyReviewedOwnedProjection(source, input.candidate, input.spans, input.review);
      try {
        links.forEach(x => x.node.dispatchEvent(new Event(eventType)));
        const result = {...base, status: "displayed_after_scope_review", displayed: true, source_version_refreshed: refreshed,
          owned_target_exact: applied.readOwnedText() === input.candidate.text, translated_text: root.textContent,
          original_structure_unchanged: nodes.every(s => s.node.isConnected && s.node.childNodes.length === s.children.length
            && s.children.every((n, i) => s.node.childNodes[i] === n) && (s.attributes === null || attrs(s.node as Element) === s.attributes)),
          ancestors_unchanged: source.ancestors.every(s => s.node.isConnected && s.node.childNodes.length === s.children.length
            && s.children.every((n, i) => s.node.childNodes[i] === n) && attrs(s.node as Element) === s.attributes),
          non_owned_text_unchanged: nodes.every(s => s.text === null || owned.has(s.node) || s.node.textContent === s.text),
          code_unchanged: codes.every(x => x.node.outerHTML === x.html),
          links_and_handler_properties_unchanged: links.every(x => x.node.isConnected && attrs(x.node) === x.attrs && x.node.onclick === x.handler),
          nonnavigation_listeners_preserved: sentinels === links.length, assignments: applied.assignments};
        applied.restore(); return {...result, restored_exact: root.outerHTML === before};
      } finally {applied.restore();}
    } finally {links.forEach(x => x.node.removeEventListener(eventType, listener));}
  } catch (e) {
    if (e instanceof TypeError || e instanceof ReferenceError) throw e;
    return {...base, status: "compiler_rejected", displayed: false, reason: String(e), rejected_source_untouched: root.outerHTML === before};
  }
}
