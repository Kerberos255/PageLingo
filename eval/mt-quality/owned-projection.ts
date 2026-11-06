// Research only. The production serializer, not root.textContent, owns the input.
import {serializeRichSegment, type RichSegment, type SerializedSourcePart, type SerializedSourceTrace} from "../../src/core/rich-segment";
import {applyFixedTextRecord, clearFixedTextRecord, prepareFixedTextRecord, type SourceTextSlot} from "../../src/core/fixed-text-render";
import {assessTranslationQuality, isOptionalEnglishArticle} from "../../src/core/translation-quality";
import {isProtectedApiSignature} from "../../src/core/dom-policy";
import {classifyProsePunctuation, prosePunctuationPattern, closeLabelColon, type ProsePunctuation} from "../../src/core/prose-punctuation";
import {prepareSemanticRewrite} from "./semantic-rewrite";
import type {TargetSpan} from "./frozen-span-projection";

interface Snapshot {node: Node; children: Node[]; attributes: string | null; text: string | null}
export interface OwnedAnnotation {
  id: string; tag: string; start: number; end: number; text: string; parent: string | null;
  immutable: boolean; kind: "format" | "block" | "flow" | "readonly";
  anchor_kind?: "opaque" | "literal" | "prose-punctuation"; full_parent?: boolean; punctuation?: ProsePunctuation;
}
interface Part {
  kind: "text" | "group" | "readonly" | "boundary" | "punctuation";
  node?: Node; source: string; start: number; end: number; owned: boolean;
  annotation?: OwnedAnnotation; children?: Part[]; hard: boolean;
}
interface TraceStamp {node: Node; kind: string; detail: string}
export interface OwnedSource {
  root: HTMLElement; url: string; sourceText: string; parts: Part[]; annotations: OwnedAnnotation[];
  slots: SourceTextSlot[]; segment: RichSegment; trace: SerializedSourceTrace;
  snapshot: Snapshot[]; ancestors: Snapshot[]; stamp: TraceStamp[]; rootParent: Node | null;
  punctuationPolicy: "strict" | "prose-v1";
}
export interface FrozenCandidate {text: string; finish_reason: string}
const attributes = (n: Node) => n.nodeType === Node.ELEMENT_NODE
  ? JSON.stringify([...(n as Element).attributes].map(a => [a.name, a.value])) : null;
function snapshot(root: Node): Snapshot[] {
  const list: Snapshot[] = [];
  const walk = (node: Node) => {list.push({node, children: [...node.childNodes], attributes: attributes(node),
    text: node.nodeType === Node.TEXT_NODE || node.nodeType === Node.COMMENT_NODE ? node.textContent : null}); [...node.childNodes].forEach(walk);};
  walk(root); return list;
}
function structurallyCurrent(source: OwnedSource) {
  return source.root.isConnected && source.root.parentNode === source.rootParent && [...source.snapshot, ...source.ancestors].every(s =>
    s.node.isConnected && attributes(s.node) === s.attributes && s.node.childNodes.length === s.children.length
    && s.children.every((n, i) => s.node.childNodes[i] === n));
}
function traceStamp(parts: SerializedSourcePart[]): TraceStamp[] {
  const out: TraceStamp[] = [];
  const walk = (p: SerializedSourcePart) => {
    const detail = p.kind === "text" ? JSON.stringify([p.source, p.slotId, p.editableContext])
      : p.kind === "opaque" ? p.source : p.kind === "boundary" ? p.reason
        : JSON.stringify([p.tagName, p.inline, p.fallbackText ?? null]);
    out.push({node: p.node, kind: p.kind, detail});
    if (p.kind === "element") p.children.forEach(walk);
  };
  parts.forEach(walk); return out;
}
function sameTrace(a: TraceStamp[], b: TraceStamp[]) {
  return a.length === b.length && a.every((x, i) => x.node === b[i]!.node && x.kind === b[i]!.kind && x.detail === b[i]!.detail);
}
function declaredNoTranslate(node: Text) {
  for (let p = node.parentElement; p; p = p.parentElement) {
    const value = p.getAttribute("translate")?.toLowerCase();
    if (value === "no") return true;
    if (value === "yes" || value === "") return false;
  }
  return false;
}
const punctuationWhitespaceAllowed = (node: Text) => !["pre", "pre-wrap", "break-spaces"].includes(
  node.ownerDocument.defaultView!.getComputedStyle(node.parentElement!).whiteSpace);
function traceText(parts: SerializedSourcePart[]): string {
  return parts.map(p => p.kind === "text" || p.kind === "opaque" ? p.source
    : p.kind === "boundary" ? "" : p.fallbackText ?? traceText(p.children)).join("");
}
export function captureOwnedSource(root: HTMLElement, {punctuationPolicy = "strict"}: {punctuationPolicy?: "strict" | "prose-v1"} = {}): OwnedSource {
  if (!root.isConnected || isProtectedApiSignature(root)) throw new Error("Owned projection source detached or protected API declaration");
  const before = snapshot(root), ancestors: Snapshot[] = [];
  for (let n = root.parentElement; n; n = n.parentElement) ancestors.push({node: n, children: [...n.childNodes], attributes: attributes(n), text: null});
  const segment = serializeRichSegment(root, {fixedTextSlots: true, captureOwnership: true});
  const slots = [...segment.textSlots!], productionSlotCount = slots.length, trace = segment.sourceTrace!;
  if (!slots.length) throw new Error("Owned projection has no production-owned text");
  if (slots.some(s => declaredNoTranslate(s.node))) throw new Error("Owned projection refuses an explicit no-translate source slot");
  const raw = traceText(trace.parts), lo = trace.trimStart, hi = raw.length - trace.trimEnd;
  if (lo > hi) throw new Error("Owned projection invalid trim mapping");
  const clip = (value: string, offset: number) => value.slice(Math.max(0, lo - offset), Math.max(0, Math.min(value.length, hi - offset)));
  let cursor = 0;
  const build = (t: SerializedSourcePart): Part => {
    const start = Math.max(0, Math.min(hi, cursor) - lo);
    if (t.kind === "boundary") return {kind: "boundary", node: t.node, source: "", start, end: start, owned: false, hard: true};
    if (t.kind === "text" || t.kind === "opaque" || t.fallbackText !== undefined) {
      const value = t.kind === "element" ? t.fallbackText! : t.source;
      const source = clip(value, cursor); cursor += value.length;
      const owned = t.kind === "text" && t.slotId !== null;
      const punctuation = punctuationPolicy === "prose-v1" && t.kind === "text" && !owned && t.editableContext
        && !declaredNoTranslate(t.node) && !t.node.parentElement!.closest("a") && source === value
        && punctuationWhitespaceAllowed(t.node)
        ? classifyProsePunctuation(source, raw.slice(lo, lo + start), raw.slice(cursor, hi)) : null;
      if (owned && source !== value) throw new Error("Owned text was unexpectedly trimmed by transport");
      const part: Part = {kind: owned ? "text" : punctuation ? "punctuation" : source ? "readonly" : "boundary", node: t.node,
        source, start, end: start + source.length, owned: owned || Boolean(punctuation), hard: t.kind === "element"};
      if (punctuation) slots.push({id: slots.length, node: t.node as Text, parent: t.node.parentNode!, source: value});
      if (part.kind === "readonly" || part.kind === "punctuation") part.annotation = {id: "", tag: t.node.nodeType === Node.TEXT_NODE ? "#TEXT" : (t.node as Element).tagName,
        start, end: start + source.length, text: source, parent: null, immutable: true, kind: "readonly",
        anchor_kind: punctuation ? "prose-punctuation" : t.kind === "opaque" ? "opaque" : "literal", ...(punctuation ? {punctuation} : {})};
      return part;
    }
    const children = t.children.map(build), source = children.map(c => c.source).join("");
    const hasOwned = children.some(c => c.owned);
    if (!hasOwned) {
      if (!source) return {kind: "boundary", node: t.node, source: "", start, end: start, owned: false, hard: true};
      const opaque = children.some(c => c.annotation?.anchor_kind === "opaque");
      return {kind: "readonly", node: t.node, source, start, end: start + source.length, owned: false, hard: !t.inline,
        annotation: {id: "", tag: t.tagName, start, end: start + source.length, text: source, parent: null,
          immutable: true, kind: "readonly", anchor_kind: opaque ? "opaque" : "literal"}};
    }
    return {kind: "group", node: t.node, source, start, end: start + source.length, owned: true, hard: !t.inline,
      children, annotation: {id: "", tag: t.tagName, start, end: start + source.length, text: source, parent: null,
        immutable: false, kind: t.inline ? "format" : "block"}};
  };
  const parts = trace.parts.map(build);
  if (cursor !== raw.length) throw new Error("Owned trace coverage mismatch");
  const wrapFlows = (children: Part[], start: number, end: number): Part[] => {
    for (const c of children) if (c.children) c.children = wrapFlows(c.children, c.start, c.end);
    if (!children.some(c => c.hard)) return children;
    const out: Part[] = []; let run: Part[] = [];
    const flush = () => {
      if (!run.length) return;
      const value = run.map(c => c.source).join("");
      if (!value) out.push(...run);
      else {
        const a = run[0]!.start, z = run[run.length - 1]!.end;
        const ownsText = run.some(c => c.owned);
        if (!ownsText) out.push({kind: "readonly", source: value, start: a, end: z, owned: false, hard: false,
          annotation: {id: "", tag: "FLOW_LITERAL", start: a, end: z, text: value, parent: null, immutable: true, kind: "readonly", anchor_kind: "literal"}});
        else out.push({kind: "group", source: value, start: a, end: z, owned: true, hard: false, children: run,
          annotation: {id: "", tag: "FLOW", start: a, end: z, text: value, parent: null, immutable: false, kind: "flow", full_parent: a === start && z === end}});
      }
      run = [];
    };
    for (const c of children) {if (c.hard) {flush(); out.push(c);} else run.push(c);}
    flush(); return out;
  };
  const grouped = wrapFlows(parts, 0, hi - lo), annotations: OwnedAnnotation[] = [], owners: Text[] = [];
  const number = (p: Part, parent: string | null) => {
    if (p.kind === "text") owners.push(p.node as Text);
    if (p.annotation) {p.annotation.id = "o" + annotations.length; p.annotation.parent = parent; annotations.push(p.annotation);}
    p.children?.forEach(c => number(c, p.annotation?.id ?? parent));
  };
  grouped.forEach(p => number(p, null));
  if (owners.length !== productionSlotCount || owners.some((n, i) => n !== slots[i]!.node)) throw new Error("Trace and production text ownership differ");
  const sourceText = raw.slice(lo, hi);
  const semantic = prepareSemanticRewrite({html: segment.html, sourceLanguage: "en", targetLanguage: "zh-Hans"}, segment.opaque);
  if (sourceText !== semantic.sourceText) throw new Error("Owned source differs from actual natural translation input");
  const source: OwnedSource = {root, url: root.ownerDocument.URL, sourceText, parts: grouped, annotations, slots, segment, trace,
    snapshot: before, ancestors, stamp: traceStamp(trace.parts), rootParent: root.parentNode, punctuationPolicy};
  if (!structurallyCurrent(source)) throw new Error("Owned source changed during capture");
  return source;
}
function sourceCurrent(source: OwnedSource) {
  if (source.root.ownerDocument.URL !== source.url || !structurallyCurrent(source) || source.slots.some(s => s.node.data !== s.source || s.node.parentNode !== s.parent)) return false;
  if (source.slots.slice(source.segment.textSlots!.length).some(s => !punctuationWhitespaceAllowed(s.node))) return false;
  const now = serializeRichSegment(source.root, {fixedTextSlots: true, captureOwnership: true});
  return now.html === source.segment.html && sameTrace(source.stamp, traceStamp(now.sourceTrace!.parts));
}
const validBoundary = (text: string, i: number) => Number.isSafeInteger(i) && i >= 0 && i <= text.length
  && !(i > 0 && i < text.length && /[\uD800-\uDBFF]/u.test(text[i - 1]!) && /[\uDC00-\uDFFF]/u.test(text[i]!));
const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
export function immutableOwnedSpans(source: Pick<OwnedSource, "annotations">, target: string): TargetSpan[] {
  const atoms = source.annotations.filter(a => a.immutable);
  const candidates = atoms.map(a => {
    const pattern = a.anchor_kind === "prose-punctuation" ? prosePunctuationPattern(a.punctuation!)
      : a.anchor_kind === "opaque" ? "(?<![A-Za-z0-9_$])" + escapeRegex(a.text) + "(?![A-Za-z0-9_$])" : escapeRegex(a.text);
    return [...target.matchAll(new RegExp(pattern, "gu"))].map(m => ({id: a.id, start: m.index, end: m.index + m[0].length}));
  });
  const memo = new Map<string, number>();
  const count = (i: number, end: number): number => {
    if (i === atoms.length) return 1;
    const key = i + ":" + end; if (memo.has(key)) return memo.get(key)!;
    let n = 0;
    for (const s of candidates[i]!) if (s.start >= end) {n = Math.min(2, n + count(i + 1, s.end)); if (n === 2) break;}
    memo.set(key, n); return n;
  };
  if (count(0, 0) !== 1) throw new Error("Owned immutable anchors missing, reordered or ambiguous");
  const spans: TargetSpan[] = []; let end = 0;
  for (let i = 0; i < atoms.length; i++) {
    const s = candidates[i]!.find(s => s.start >= end && count(i + 1, s.end) > 0)!;
    spans.push(s); end = s.end;
  }
  return spans;
}
function masked(text: string, ranges: TargetSpan[]) {
  let value = "", end = 0;
  for (const [i, r] of [...ranges].sort((a, b) => a.start - b.start).entries()) {value += text.slice(end, r.start) + `⟪P${i}⟫`; end = r.end;}
  return value + text.slice(end);
}
export function assessOwnedCandidate(source: Pick<OwnedSource, "sourceText" | "annotations">, candidate: FrozenCandidate) {
  if (candidate.finish_reason !== "stop") throw new Error("Owned frozen candidate did not reach EOS");
  if (!candidate.text.trim()) throw new Error("Owned frozen candidate is empty");
  const immutable = immutableOwnedSpans(source, candidate.text);
  const quality = assessTranslationQuality({sourceText: masked(source.sourceText, source.annotations.filter(a => a.immutable)),
    translatedText: masked(candidate.text, immutable), sourceLanguage: "en", targetLanguage: "zh-Hans"});
  if (!quality.accepted) throw new Error("Owned frozen candidate: " + quality.reasons.join(", "));
  return {immutable, quality};
}

function sortedData(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedData);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(k => [k, sortedData((value as Record<string, unknown>)[k])]));
  return value;
}
export const canonicalOwnedData = (value: unknown) => JSON.stringify(sortedData(value));
export function ownedSourceContract(source: OwnedSource) {
  const roles: Array<{id: string; attributes: string | null}> = [], boundaries: Array<{tag: string; start: number; end: number}> = [];
  const walk = (p: Part) => {
    if (p.annotation) roles.push({id: p.annotation.id, attributes: p.node ? attributes(p.node) : null});
    if (p.kind === "boundary" && p.node) boundaries.push({tag: p.node.nodeType === Node.ELEMENT_NODE ? (p.node as Element).tagName : "#TEXT", start: p.start, end: p.end});
    p.children?.forEach(walk);
  };
  source.parts.forEach(walk);
  return {url: source.url, root_tag: source.root.tagName, root_attributes: attributes(source.root),
    source_text: source.sourceText, wire_html: source.segment.html, punctuation_policy: source.punctuationPolicy, annotations: source.annotations,
    owned_slots: source.slots.map(s => ({id: s.id, source: s.source})), roles, boundaries};
}
export function ownedProposalKey(source: OwnedSource, candidate: FrozenCandidate, spans: TargetSpan[]) {
  const byId = new Map(spans.map(s => [s.id, s]));
  return canonicalOwnedData({source: ownedSourceContract(source), candidate,
    spans: source.annotations.map(a => byId.get(a.id) ?? null)});
}
export interface OwnedScopeReview {decision: "confirmed" | "wrong" | "uncertain" | "unreviewed"; reviewer: "assistant" | "human"; proposal_key: string}
// An explicit research review is bound to the actual proposal. It is not an
// automatic semantic validator or a production approval workflow.
export function applyReviewedOwnedProjection(source: OwnedSource, candidate: FrozenCandidate, spans: TargetSpan[], review: OwnedScopeReview) {
  if (review.decision !== "confirmed" || review.proposal_key !== ownedProposalKey(source, candidate, spans)) {
    throw new Error("Owned projection scope unreviewed, incorrect or changed");
  }
  const compiled = compileOwnedProjection(source, candidate, spans); compiled.apply(); return compiled;
}
export function compileOwnedProjection(source: OwnedSource, candidate: FrozenCandidate, spans: TargetSpan[]) {
  if (!sourceCurrent(source)) throw new Error("Owned projection source changed before compilation");
  const checked = assessOwnedCandidate(source, candidate), target = candidate.text;
  const byId = new Map<string, TargetSpan>(), edits = new Map<Text, string>();
  for (const s of spans) {
    if (byId.has(s.id) || !source.annotations.some(a => a.id === s.id)) throw new Error("Owned duplicate or unknown annotation");
    if (!validBoundary(target, s.start) || !validBoundary(target, s.end) || s.start >= s.end) throw new Error("Owned invalid UTF-16 span");
    byId.set(s.id, {...s});
  }
  if (byId.size !== source.annotations.length) throw new Error("Owned missing annotation");
  for (const s of checked.immutable) {
    const got = byId.get(s.id)!;
    if (got.start !== s.start || got.end !== s.end) throw new Error("Owned immutable span differs from unique source anchor");
  }
  if (source.punctuationPolicy === "prose-v1") for (const a of source.annotations) {
    if (a.kind !== "format" || a.immutable) continue;
    const s = byId.get(a.id)!;
    const closed = closeLabelColon(a.text, target, s.start, s.end);
    if (closed.end !== s.end) throw new Error("Format label colon is outside its scope");
  }
  const distribute = (nodes: Text[], text: string) => {
    if (!nodes.length) {if (text) throw new Error("Owned target has no production text carrier"); return;}
    if (nodes.length > 1) {
      if (nodes.map(n => n.data).join("") !== text) throw new Error("Owned ambiguous adjacent text nodes");
      nodes.forEach(n => edits.set(n, n.data)); return;
    }
    const n = nodes[0]!;
    if (!text.trim() && text !== n.data && !isOptionalEnglishArticle(n.data)) throw new Error("Owned would empty a nonoptional source slot");
    edits.set(n, text);
  };
  const assign = (children: Part[], start: number, end: number) => {
    let cursor = start, pending: Text[] = [];
    for (const p of children) {
      if (p.kind === "boundary") continue;
      if (p.kind === "text") {pending.push(p.node as Text); continue;}
      const s = byId.get(p.annotation!.id)!;
      if (s.start < cursor || s.end > end) throw new Error("Owned reordered, crossing or unnested scope");
      distribute(pending, target.slice(cursor, s.start)); pending = [];
      if (p.kind === "punctuation") edits.set(p.node as Text, target.slice(s.start, s.end));
      if (p.kind === "group") assign(p.children!, s.start, s.end);
      cursor = s.end;
    }
    distribute(pending, target.slice(cursor, end));
  };
  assign(source.parts, 0, target.length);
  const logical = (parts: Part[], actual: boolean): string => parts.map(p => p.kind === "text" || p.kind === "punctuation"
    ? actual ? (p.node as Text).data : edits.get(p.node as Text) ?? (p.node as Text).data
    : p.kind === "group" ? logical(p.children!, actual) : p.source).join("");
  if (logical(source.parts, false) !== target) throw new Error("Owned compiler rewrote frozen target");
  const holder = source.root.ownerDocument.createElement("div"), slots: SourceTextSlot[] = [];
  for (const slot of source.slots) {
    const text = edits.get(slot.node); if (text === undefined || text === slot.source) continue;
    const id = slots.length, span = holder.ownerDocument.createElement("span");
    span.setAttribute("data-flt-text-id", String(id)); span.textContent = text; holder.append(span); slots.push({...slot, id});
  }
  const record = prepareFixedTextRecord(source.root, slots, holder.innerHTML);
  const assignments = source.annotations.map(a => {const s = byId.get(a.id)!; return {...a, target: target.slice(s.start, s.end)};});
  return {target, record, assignments, quality: checked.quality, readOwnedText: () => logical(source.parts, true), apply: () => {
    if (!sourceCurrent(source)) throw new Error("Owned projection source changed before application");
    const before = snapshot(source.root), owned = new Set(source.slots.map(s => s.node as Node));
    try {
      if (!applyFixedTextRecord(source.root, record, "translation", "zh-Hans")) throw new Error("Owned renderer refused source ownership");
      if (!structurallyCurrent(source) || logical(source.parts, true) !== target
        || before.some(s => s.text !== null && !owned.has(s.node) && s.node.textContent !== s.text)) throw new Error("Owned renderer invariant failed");
    } catch (error) {clearFixedTextRecord(record); throw error;}
  }, restore: () => clearFixedTextRecord(record)};
}
