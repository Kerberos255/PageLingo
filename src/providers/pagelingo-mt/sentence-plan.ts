import type {TranslationRequest} from "../../core/provider";
import {encodeFixedMtText, fixedMtMaxTokens, fixedMtPrompt} from "./fixed-text";
import {richHtmlStructureCompatible} from "../../core/rich-segment-splitter";

export const MT_CONTEXT_TOKENS = 3072;

function fits(html: string, request: TranslationRequest): boolean {
  try {
    const encoded = encodeFixedMtText(html);
    const prompt = fixedMtPrompt(encoded, request);
    // This GGUF uses a byte-level GPT-2 tokenizer. UTF-8 bytes upper-bound input
    // tokens; reserve eight additional tokens for the Hunyuan role template.
    return new TextEncoder().encode(prompt).length + fixedMtMaxTokens(encoded) + 8 <= MT_CONTEXT_TOKENS;
  } catch {
    return false;
  }
}

export function planMtSentences(request: TranslationRequest): string[] {
  if (fits(request.html, request)) return [request.html];
  const body = new DOMParser().parseFromString(request.html, "text/html").body;
  const text = body.textContent ?? "";
  const nodes: Array<{node: Text; start: number; end: number}> = [];
  const walker = body.ownerDocument.createTreeWalker(body, NodeFilter.SHOW_TEXT);
  let node: Node | null; let offset = 0;
  while ((node = walker.nextNode())) {
    const value = node.textContent ?? "";
    nodes.push({node: node as Text, start: offset, end: offset + value.length}); offset += value.length;
  }
  const boundaries: Array<{node: Node; offset: number}> = [];
  // ICU treats source line breaks as sentence ends; keep offsets while removing them.
  const sentenceText = text.replace(/\s/g, " ");
  for (const segment of new Intl.Segmenter("en", {granularity: "sentence"}).segment(sentenceText)) {
    const end = segment.index + segment.segment.length;
    if (end >= text.length) continue;
    const item = nodes.find(entry => end > entry.start && end <= entry.end);
    if (!item) continue;
    if (item.node.parentNode === body || item.node.parentElement?.matches("span[data-flt-text-id]")) {
      boundaries.push({node: item.node, offset: end - item.start});
    }
    else if (end === item.end) {
      let top: Node = item.node;
      while (top.parentNode && top.parentNode !== body) top = top.parentNode;
      const following = nodes.some(entry => entry.start >= end && top.contains(entry.node));
      if (!following) boundaries.push({node: body, offset: Array.from(body.childNodes).indexOf(top as ChildNode) + 1});
    }
  }
  boundaries.push({node: body, offset: body.childNodes.length});
  const pieces: string[] = [];
  let previous = {node: body as Node, offset: 0};
  for (const boundary of boundaries) {
    const range = body.ownerDocument.createRange();
    range.setStart(previous.node, previous.offset); range.setEnd(boundary.node, boundary.offset);
    const holder = body.ownerDocument.createElement("div"); holder.append(range.cloneContents());
    // cloneContents omits the common ancestor itself. A range wholly inside
    // one Text node would otherwise lose its transport span (and inline scope).
    let ancestor: Node | null = range.commonAncestorContainer;
    if (ancestor.nodeType === Node.TEXT_NODE) ancestor = ancestor.parentNode;
    while (ancestor && ancestor !== body) {
      const wrapper = ancestor.cloneNode(false);
      for (const child of Array.from(holder.childNodes)) wrapper.appendChild(child);
      holder.replaceChildren(wrapper);
      ancestor = ancestor.parentNode;
    }
    if (holder.innerHTML) pieces.push(holder.innerHTML);
    previous = boundary;
  }
  const packed: string[] = []; let current = "";
  for (const piece of pieces) {
    if (!fits(piece, request)) throw new Error("A complete sentence exceeds the MT context/format budget; original paragraph retained");
    if (current && !fits(current + piece, request)) {packed.push(current); current = "";}
    current += piece;
  }
  if (current) packed.push(current);
  if (!packed.length) throw new Error("No complete MT sentence fits the budget");
  return packed;
}

/** Range splitting may clone transport spans around parts of the same Text node.
 * Reassemble their text into the original transport template before the renderer
 * maps it back to the one live Text object. Generated markup is never adopted. */
export function assembleMtSentences(html: string, units: string[], translations: string[]): string {
  if (units.length !== translations.length) throw new Error("MT incomplete sentence assembly");
  if (units.length === 1) return translations[0]!;
  const parse = (value: string) => new DOMParser().parseFromString(value, "text/html").body;
  const body = parse(html);
  const originals = Array.from(body.querySelectorAll("[data-flt-text-id]"));
  if (!originals.length) return translations.join("");
  const ids = originals.map(element => element.getAttribute("data-flt-text-id")!);
  if (new Set(ids).size !== ids.length || originals.some(element => element.tagName !== "SPAN" || element.childElementCount)) {
    throw new Error("MT invalid source text-slot template");
  }
  const walker = body.ownerDocument.createTreeWalker(body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (/\p{L}/u.test(node.textContent ?? "") && !node.parentElement?.closest("[data-flt-text-id],code,kbd,samp,var,[data-flt-fixed],[data-flt-term-id]")) {
      throw new Error("MT cannot assemble mixed wrapped and unwrapped source text");
    }
  }
  const sources = new Map(ids.map(id => [id, ""])), targets = new Map(ids.map(id => [id, ""]));
  const seen: string[] = [];
  let coveredText = "";
  for (const [index, unit] of units.entries()) {
    const translated = translations[index]!;
    if (!richHtmlStructureCompatible(unit, translated)) throw new Error("MT sentence changed rich structure");
    const source = parse(unit), target = parse(translated);
    coveredText += source.textContent ?? "";
    const from = Array.from(source.querySelectorAll("[data-flt-text-id]"));
    const to = Array.from(target.querySelectorAll("[data-flt-text-id]"));
    if (from.length !== to.length) throw new Error("MT partial text-slot count mismatch");
    for (const [slotIndex, slot] of from.entries()) {
      const id = slot.getAttribute("data-flt-text-id")!, value = to[slotIndex]!;
      if (!sources.has(id) || value.getAttribute("data-flt-text-id") !== id || slot.tagName !== "SPAN"
          || value.tagName !== "SPAN" || slot.childElementCount || value.childElementCount) {
        throw new Error("MT partial text-slot identity changed");
      }
      if (seen[seen.length - 1] !== id) seen.push(id);
      sources.set(id, sources.get(id)! + (slot.textContent ?? ""));
      targets.set(id, targets.get(id)! + (value.textContent ?? ""));
    }
  }
  if (coveredText !== body.textContent) throw new Error("MT incomplete source sentence text coverage");
  if (seen.length !== ids.length || seen.some((id, index) => id !== ids[index])) throw new Error("MT reordered source sentence slots");
  if (originals.some(element => sources.get(element.getAttribute("data-flt-text-id")!) !== element.textContent)) {
    throw new Error("MT incomplete source sentence slot coverage");
  }
  for (const element of originals) element.textContent = targets.get(element.getAttribute("data-flt-text-id")!)!;
  return body.innerHTML;
}
