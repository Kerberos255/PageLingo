// Research only: source-selected samples and recorded inference on live public pages.
import {collectTranslationRoots} from "../../src/core/dom-policy";
import {serializeRichSegment, terminologyForText} from "../../src/core/rich-segment";
import {contextualTerminology, translationContextForUrl} from "../../src/core/translation-context";
import {PageTranslator} from "../../src/core/page-translator";
import {inferMtHtml} from "../../src/providers/pagelingo-mt/inference";
import type {TranslationRequest} from "../../src/core/provider";
import {qualityCallPlan, type RecordedQualityCompletion} from "./protocol";
import {naturalTranslationPrompt, prepareSemanticRewrite} from "./semantic-rewrite";
import {captureFrozenSource, compileFrozenProjection, type TargetSpan, type SourceAnnotation} from "./frozen-span-projection";

const formatSelector = "em,strong,b,i,mark,sub,sup,small,s,u,del,ins,abbr,cite,q";
const protectedSelector = "code,kbd,samp,var,[translate='no']";
const normalized = (s: string) => s.replace(/\s+/gu, " ").trim();
const nodeAttrs = (e: Element) => JSON.stringify([...e.attributes].map(a => [a.name, a.value]));
function sortedData(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedData);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, sortedData(v)]));
  return value;
}
const sameData = (a: unknown, b: unknown) => JSON.stringify(sortedData(a)) === JSON.stringify(sortedData(b));
export function liveRequest(root: HTMLElement, url: string) {
  const segment = serializeRichSegment(root, {fixedTextSlots: true});
  const context = translationContextForUrl(url);
  const request: TranslationRequest = {html: segment.html, sourceLanguage: "en", targetLanguage: "zh-Hans",
    terminology: terminologyForText(contextualTerminology(context), segment.fingerprint), ...(context ? {context} : {})};
  const calls = qualityCallPlan(request), semantic = prepareSemanticRewrite(request, segment.opaque);
  if (!calls.length) throw new Error("No production translation calls");
  return {segment, request, calls, semantic, natural: {messages: [{role: "user", content: naturalTranslationPrompt(semantic)}],
    grammar: null, max_tokens: Math.min(768, calls.reduce((n, c) => n + c.max_tokens, 0))}};
}
export function sourceLocator(root: Element): string {
  const parts: string[] = [];
  for (let e: Element | null = root; e; e = e.parentElement) {
    if (e.id && e.ownerDocument.querySelectorAll("#" + CSS.escape(e.id)).length === 1) {
      parts.unshift("#" + CSS.escape(e.id)); break;
    }
    const index = e.parentElement ? [...e.parentElement.children].indexOf(e) + 1 : 1;
    parts.unshift(e.tagName.toLowerCase() + ":nth-child(" + index + ")");
  }
  return parts.join(" > ");
}
function depth(root: Element): number {
  return Math.max(0, ...[...root.children].map(c => 1 + depth(c)));
}
function wordUnits(text: string, locale: string) {
  return [...new Intl.Segmenter(locale, {granularity: "word"}).segment(text)].filter(x => x.segment.trim())
    .map(x => ({text: x.segment, start: x.index, end: x.index + x.segment.length, lexical: x.isWordLike === true}));
}
type ProjectionCapture = {supported: true; source_text: string; source_words: ReturnType<typeof wordUnits>;
  annotations: Array<Omit<SourceAnnotation, "node">>} | {supported: false; reason: string};
export function captureComplexPage(siteId: string, selectors: string[], perSite = 3, doc: Document = document) {
  const selector = selectors.find(s => doc.querySelector(s)) ?? "body";
  const scope = doc.querySelector(selector)!;
  const roots = collectTranslationRoots(scope, {preserveInlineContext: true}) as HTMLElement[];
  const inventory = roots.map((root, index) => {
    const text = root.textContent ?? "", links = root.querySelectorAll("a").length;
    const code = root.querySelectorAll(protectedSelector).length, formats = root.querySelectorAll(formatSelector).length;
    const nesting = depth(root), tag = root.tagName, tableCell = Boolean(root.closest("td,th"));
    const eligible = normalized(text).length >= (tableCell ? 30 : 80) && normalized(text).length <= 900
      && (text.match(/[A-Za-z]+/gu)?.length ?? 0) >= (tableCell ? 5 : 12) && /[A-Za-z]/u.test(text)
      && !root.closest("nav,header,footer,aside,[role='navigation'],[role='contentinfo']")
      && Boolean(root.getClientRects().length) && (tableCell || links + code + formats > 0);
    const score = links * 4 + code * 2 + formats * 3 + nesting * 2
      + (["TD", "TH", "LI", "DT", "DD", "SUMMARY"].includes(tag) ? 8 : 0);
    return {index, tag, table_cell: tableCell, text_chars: text.length, normalized_chars: normalized(text).length, links, code, formats, depth: nesting, score, eligible};
  });
  const ranked = inventory.filter(x => x.eligible).sort((a, b) => b.score - a.score || a.index - b.index);
  const selected: Array<{index: number; bucket: string}> = [];
  const choose = (bucket: string, predicate: (x: typeof ranked[number]) => boolean) => {
    const c = ranked.find(x => !selected.some(s => s.index === x.index) && predicate(x));
    if (c && selected.length < perSite) selected.push({index: c.index, bucket});
  };
  choose("dense-links", x => x.links >= 2);
  choose("list-table-definition", x => ["TD", "TH", "LI", "DT", "DD", "SUMMARY"].includes(x.tag));
  choose("nested-format", x => x.formats > 0 || x.depth >= 3);
  while (selected.length < perSite) {const n = selected.length; choose("remaining-complexity", () => true); if (selected.length === n) break;}
  // Add a distinct table stratum after the initial source-only inventory exposed
  // a coverage gap. No translation has been generated when samples are selected.
  if (!selected.some(s => inventory[s.index]!.table_cell)) {
    const cell = ranked.find(x => x.table_cell);
    if (cell) selected.push({index: cell.index, bucket: "additional-table-cell"});
  }
  const cases = selected.map(({index, bucket}, ordinal) => {
    const root = roots[index]!, id = siteId + "-" + (ordinal + 1), stats = inventory[index]!;
    const base = {id, site_id: siteId, bucket, locator: sourceLocator(root), html: root.outerHTML,
      root_tag: root.tagName, raw_source_text: root.textContent ?? "", context_url: doc.location.href, stats,
      labels: [...root.querySelectorAll("a," + formatSelector)].map(n => ({tag: n.tagName, text: n.textContent, href: n.getAttribute("href")}))};
    try {
      const p = liveRequest(root, doc.location.href);
      let projection: ProjectionCapture;
      try {
        const frozen = captureFrozenSource(root);
        if (frozen.sourceText !== p.semantic.sourceText) throw new Error("Raw DOM text differs from natural production context (hidden/protected/spacing content)");
        projection = {supported: true, source_text: frozen.sourceText, source_words: wordUnits(frozen.sourceText, "en"),
          annotations: frozen.annotations.map(({node, ...a}) => a)};
      } catch (e) {projection = {supported: false, reason: String(e)};}
      return {...base, prepared: true as const, source_text: p.semantic.sourceText, fixed_source: p.semantic.fixed.source,
        fixed_calls: p.calls, natural: p.natural, projection};
    } catch (e) {return {...base, prepared: false as const, preparation_reason: String(e)};}
  });
  let overlaps = 0;
  for (let i = 0; i < roots.length; i++) for (let j = i + 1; j < roots.length; j++) {
    if (roots[i]!.contains(roots[j]!) || roots[j]!.contains(roots[i]!)) overlaps++;
  }
  return {site_id: siteId, url: doc.location.href, title: doc.title, scope_selector: selector,
    selection: {per_site: perSite, extra_table_stratum: true, rules: "Source-only: 80..900 normalized chars, >=12 English words, visible production root with markup; table cells allow 30 chars/5 words/plain text. Dense links, structural list/table/definition, nested formatting, then complexity; add one table cell if absent. No model output observed."},
    root_count: roots.length, overlapping_root_pairs: overlaps, eligible_count: ranked.length, inventory, cases};
}

function rootSnapshot(root: HTMLElement) {
  const nodes: Array<{node: Node; children: Node[]; attrs: string | null; text: string | null}> = [];
  const walk = (node: Node) => {nodes.push({node, children: [...node.childNodes], attrs: node instanceof Element ? nodeAttrs(node) : null,
    text: node.nodeType === Node.TEXT_NODE || node.nodeType === Node.COMMENT_NODE ? node.textContent : null}); [...node.childNodes].forEach(walk);};
  walk(root);
  const ancestors: Array<{node: Element; parent: Node | null; children: Node[]; attrs: string}> = [];
  for (let n = root.parentElement; n; n = n.parentElement) ancestors.push({node: n, parent: n.parentNode, children: [...n.childNodes], attrs: nodeAttrs(n)});
  const links = [...root.querySelectorAll("a")].map(node => ({node, attrs: nodeAttrs(node), onclick: (node as HTMLElement).onclick}));
  const code = [...root.querySelectorAll(protectedSelector)].map(node => ({node, html: node.outerHTML}));
  const before = root.outerHTML, parent = root.parentNode, rect = root.getBoundingClientRect();
  const dimensions = () => ({width: root.clientWidth, scroll_width: root.scrollWidth, horizontal_overflow: root.scrollWidth > root.clientWidth + 2,
    height: root.getBoundingClientRect().height});
  return {before, parent, dimensions_before: dimensions(), rect: {x: rect.x, y: rect.y, width: rect.width, height: rect.height}, dimensions,
    checks: (includeText = false) => ({
      original_structure_unchanged: root.isConnected && root.parentNode === parent && nodes.every(s => s.node.isConnected
        && (s.attrs === null || s.node instanceof Element && nodeAttrs(s.node) === s.attrs)
        && s.node.childNodes.length === s.children.length && s.children.every((c, i) => s.node.childNodes[i] === c)),
      ancestor_structure_unchanged: ancestors.every(s => s.node.isConnected && s.node.parentNode === s.parent && nodeAttrs(s.node) === s.attrs
        && s.node.childNodes.length === s.children.length && s.children.every((c, i) => s.node.childNodes[i] === c)),
      code_unchanged: code.every(s => s.node.isConnected && s.node.outerHTML === s.html),
      link_targets_and_handler_properties_unchanged: links.every(s => s.node.isConnected && nodeAttrs(s.node) === s.attrs && (s.node as HTMLElement).onclick === s.onclick),
      ...(includeText ? {source_text_nodes_unchanged: nodes.every(s => s.text === null || s.node.textContent === s.text)} : {})})};
}
export interface LiveReplayInput {
  id: string; locator: string; html: string; context_url: string; fixed_source: string;
  natural: {messages: {role: string; content: string}[]; grammar: null; max_tokens: number};
  fixed_calls: {messages: {role: string; content: string}[]; grammar: string; max_tokens: number}[];
  mode: "production" | "projection"; completions?: RecordedQualityCompletion[];
  target?: string; spans?: TargetSpan[]; alignment_status?: string; alignment_reason?: string;
}
export async function replayOnLiveRoot(input: LiveReplayInput, doc: Document = document) {
  const root = doc.querySelector(input.locator) as HTMLElement | null;
  if (!root || root.outerHTML !== input.html || doc.location.href !== input.context_url) {
    return {id: input.id, mode: input.mode, source_matches: false as const, displayed: false,
      reason: "Live source changed or locator/URL no longer matches; no write attempted",
      locator_found: Boolean(root), observed_url: doc.location.href, observed_html: root?.outerHTML ?? null};
  }
  const p = liveRequest(root, doc.location.href);
  if (!sameData(p.calls, input.fixed_calls) || !sameData(p.natural, input.natural)
    || p.semantic.fixed.source !== input.fixed_source) throw new Error("Live production request differs from recorded request: " + input.id);
  const snap = rootSnapshot(root);
  let displayed = false, reason: string | null = null, consumed = 0, restore = () => {}, frozenExact: boolean | null = null;
  let sentinel = 0;
  const eventType = "pagelingo-structure-sentinel", anchors = [...root.querySelectorAll("a")];
  const listener = () => {sentinel++;}; anchors.forEach(a => a.addEventListener(eventType, listener));
  const events: string[] = [], warn = console.warn; console.warn = (...args) => {events.push(args.map(String).join(" "));};
  try {
    try {
      if (input.mode === "production") {
        const translator = new PageTranslator(doc, {prefersWholeSentenceHtml: async () => true,
          translateHtml: async (request: TranslationRequest) => {
            const checked = await inferMtHtml(request, async options => {
              const call = input.fixed_calls[consumed], row = input.completions?.[consumed++];
              if (!call || !row || !sameData(options.messages, call.messages)
                || options.max_tokens !== call.max_tokens || options.grammar !== call.grammar) throw new Error("Recorded production request mismatch");
              return {choices: [{finish_reason: row.finish_reason, message: {content: row.text}}]};
            });
            if (!checked.accepted) throw new Error(checked.reason);
            return checked.html;
          }}, {displayMode: "translation", sourceLanguage: "en", targetLanguage: "zh-Hans", concurrency: 1});
        restore = () => translator.restore();
        await translator.translateRoot(root); displayed = translator.translatedCount === 1;
        if (displayed && consumed !== input.completions?.length) throw new Error("Unconsumed native completions");
      } else {
        if (input.alignment_status !== "projected") throw new Error(input.alignment_reason ?? "Alignment refused source");
        const compiled = compileFrozenProjection(captureFrozenSource(root), input.target!, input.spans!);
        restore = compiled.restore; compiled.apply(); displayed = true; frozenExact = root.textContent === input.target;
      }
    } catch (e) {reason = String(e);}
    anchors.forEach(a => a.dispatchEvent(new Event(eventType)));
    const result = {id: input.id, mode: input.mode, source_matches: true as const, request_matches: true, displayed, reason, consumed,
      translated_text: root.textContent, translated_html: root.outerHTML, frozen_target_exact: frozenExact,
      ...snap.checks(), nonnavigation_listener_sentinel_preserved: sentinel === anchors.length,
      rejected_source_untouched: displayed || root.outerHTML === snap.before,
      labels: [...root.querySelectorAll("a," + formatSelector)].map(n => ({tag: n.tagName, text: n.textContent, href: n.getAttribute("href")})),
      dimensions_before: snap.dimensions_before, dimensions_after: snap.dimensions(), events};
    restore();
    return {...result, restored_exact: root.outerHTML === snap.before, ...{restored_source_text_nodes: snap.checks(true).source_text_nodes_unchanged}};
  } finally {restore(); anchors.forEach(a => a.removeEventListener(eventType, listener)); console.warn = warn;}
}

// Post-fix check on the original public Python documentation, no model response
// is needed: protected declarations must never reach any translation provider.
export async function verifyLiveApiSignatures(inputs: Array<{id: string; locator: string; html: string; context_url: string}>, doc: Document = document) {
  const rows = [];
  for (const input of inputs) for (const wholeSentence of [true, false]) {
    const root = doc.querySelector(input.locator) as HTMLElement | null;
    if (!root || root.outerHTML !== input.html || doc.location.href !== input.context_url) {
      rows.push({id: input.id, whole_sentence: wholeSentence, source_matches: false}); continue;
    }
    const snap = rootSnapshot(root);
    const selected = collectTranslationRoots(root, {preserveInlineContext: wholeSentence});
    let calls = 0;
    const translator = new PageTranslator(doc, {prefersWholeSentenceHtml: async () => wholeSentence,
      translateHtml: async () => {calls++; throw new Error("Protected declaration reached provider");}}, {displayMode: "translation"});
    await translator.translateRoot(root);
    const inline = root.querySelector("em,span") as HTMLElement | null;
    if (inline) await translator.translateRoot(inline);
    translator.restore();
    const description = root.nextElementSibling;
    rows.push({id: input.id, whole_sentence: wholeSentence, source_matches: true, provider_calls: calls,
      selected_roots: selected.length, translated_count: translator.translatedCount, protected_original_exact: root.outerHTML === snap.before,
      ...snap.checks(true), adjacent_description_eligible: Boolean(description?.tagName === "DD"
        && collectTranslationRoots(description, {preserveInlineContext: true}).length)});
  }
  return rows;
}
