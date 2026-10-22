import type {TranslationRequest} from "../../core/provider";
import {encodeFixedMtText, fixedMtMaxTokens, fixedMtPrompt} from "./fixed-text";

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
    if (item.node.parentNode === body) boundaries.push({node: item.node, offset: end - item.start});
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
