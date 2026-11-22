// @ts-nocheck
import { parseHtmlBody } from "../shared/html-parser";

const LINK_BOUNDARY_RE = /^__FLT_LINK_(?:START|END)_\d+__$/;
const OPAQUE_RE = /^__FLT_OPAQUE_(\d+)__$/;
const ATOMIC_TAGS = new Set(["A", "CODE", "KBD", "SAMP", "VAR", "BR", "WBR"]);

export class RichSegmentBudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RichSegmentBudgetError";
  }
}

function escapeHtmlText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function parseBody(html: string): HTMLElement {
  return parseHtmlBody(html);
}

function isLinkBoundaryElement(element: Element): boolean {
  return ["CODE", "KBD", "SAMP", "VAR"].includes(element.tagName)
    && LINK_BOUNDARY_RE.test((element.textContent ?? "").trim());
}

function isMarkerCandidate(element: Element): boolean {
  return !isLinkBoundaryElement(element);
}

function structuralCountNode(node: Node): number {
  if (!(node instanceof Element)) return 0;
  let count = isMarkerCandidate(node) ? 1 : 0;
  for (const child of Array.from(node.children)) count += structuralCountNode(child);
  return count;
}

export function richMarkerCandidateCount(html: string): number {
  const body = parseBody(html);
  let count = 0;
  for (const child of Array.from(body.children)) count += structuralCountNode(child);
  return count;
}

function structuralMaxDepthNode(node: Node, parentDepth = 0): number {
  if (!(node instanceof Element)) return parentDepth;
  const depth = parentDepth + (isMarkerCandidate(node) ? 1 : 0);
  let maxDepth = depth;
  for (const child of Array.from(node.children)) {
    maxDepth = Math.max(maxDepth, structuralMaxDepthNode(child, depth));
  }
  return maxDepth;
}

export function richMarkerCandidateMaxDepth(html: string): number {
  const body = parseBody(html);
  let maxDepth = 0;
  for (const child of Array.from(body.children)) {
    maxDepth = Math.max(maxDepth, structuralMaxDepthNode(child, 0));
  }
  return maxDepth;
}

function serializeNode(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return escapeHtmlText(node.textContent ?? "");
  if (node instanceof Element) return node.outerHTML;
  return "";
}

function setElementHtml(element: Element, innerHtml: string): void {
  const parsed = parseBody(innerHtml);
  const owner = element.ownerDocument;
  const imported = Array.from(parsed.childNodes, (child) => owner.importNode(child, true));
  element.replaceChildren(...imported);
}

function wrapElement(element: Element, innerHtml: string): string {
  const clone = element.cloneNode(false) as Element;
  setElementHtml(clone, innerHtml);
  return clone.outerHTML;
}

function packPieces(pieces: string[], budget: number): string[] {
  const packed: string[] = [];
  let current = "";
  let currentCount = 0;

  for (const piece of pieces) {
    const pieceCount = richMarkerCandidateCount(piece);
    if (current && currentCount + pieceCount > budget) {
      packed.push(current);
      current = "";
      currentCount = 0;
    }
    current += piece;
    currentCount += pieceCount;
  }
  if (current) packed.push(current);
  return packed;
}

function explodeNode(node: Node, budget: number): string[] {
  if (!(node instanceof Element)) return [serializeNode(node)];

  const count = structuralCountNode(node);
  if (count <= budget) return [node.outerHTML];
  if (ATOMIC_TAGS.has(node.tagName)) {
    throw new RichSegmentBudgetError(
      `Cannot safely split oversized atomic <${node.tagName.toLowerCase()}> with ${count} markers (budget ${budget})`,
    );
  }

  const ownCount = isMarkerCandidate(node) ? 1 : 0;
  const childBudget = Math.max(1, budget - ownCount);
  const childPieces: string[] = [];
  for (const child of Array.from(node.childNodes)) {
    childPieces.push(...explodeNode(child, childBudget));
  }

  return packPieces(childPieces, childBudget).map((inner) => wrapElement(node, inner));
}

export function splitRichHtmlByStructureBudget(html: string, budget = 6): string[] {
  if (!html.trim()) return [];
  const body = parseBody(html);
  const pieces: string[] = [];
  for (const child of Array.from(body.childNodes)) pieces.push(...explodeNode(child, budget));
  const chunks = packPieces(pieces, budget).filter((chunk) => chunk.trim());
  const oversized = chunks.find((chunk) => richMarkerCandidateCount(chunk) > budget);
  if (oversized) {
    throw new RichSegmentBudgetError(
      `Structural chunk exceeds marker budget ${budget}: ${richMarkerCandidateCount(oversized)}`,
    );
  }
  return chunks;
}

export async function translateRichHtmlByStructureBudgetPreservingWrappers(
  html: string,
  budget: number,
  translateChunk: (chunk: string) => Promise<string>,
  translateLeaf: (leaf: string) => Promise<string>,
): Promise<string> {
  if (!html.trim()) return "";

  const body = parseBody(html);

  async function translateNode(node: Node): Promise<string> {
    if (!(node instanceof Element)) return serializeNode(node);

    const count = structuralCountNode(node);
    if (count <= budget) return translateChunk(node.outerHTML);
    if (ATOMIC_TAGS.has(node.tagName)) return translateLeaf(node.outerHTML);

    const clone = node.cloneNode(false) as Element;
    setElementHtml(clone, await translateChildren(Array.from(node.childNodes)));
    return clone.outerHTML;
  }

  async function translateChildren(nodes: Node[]): Promise<string> {
    const tasks: Array<Promise<string>> = [];
    let pending = "";
    let pendingCount = 0;

    const flush = () => {
      if (!pending) return;
      const chunk = pending;
      pending = "";
      pendingCount = 0;
      tasks.push(chunk.trim() ? translateChunk(chunk) : Promise.resolve(chunk));
    };

    for (const node of nodes) {
      const serialized = serializeNode(node);
      const count = node instanceof Element ? structuralCountNode(node) : 0;

      if (node instanceof Element && count > budget) {
        flush();
        tasks.push(translateNode(node));
        continue;
      }

      if (pending && pendingCount + count > budget) flush();
      pending += serialized;
      pendingCount += count;
    }

    flush();
    return (await Promise.all(tasks)).join("");
  }

  return translateChildren(Array.from(body.childNodes));
}

function transportLinkIdentity(anchor: Element): string {
  const dataId = anchor.getAttribute("data-flt-link-id");
  if (dataId && /^\d+$/.test(dataId)) return dataId;
  const href = anchor.getAttribute("href") ?? "";
  return href.match(/^https:\/\/pagelingo\.invalid\/__link\/(\d+)$/)?.[1] ?? "?";
}

function elementIdentity(element: Element): string {
  if (element.tagName === "A") return "A#" + transportLinkIdentity(element);
  if (["CODE", "KBD", "SAMP", "VAR"].includes(element.tagName)) {
    const text = (element.textContent ?? "").trim();
    const opaque = text.match(OPAQUE_RE);
    if (opaque) return element.tagName + "#OPAQUE_" + opaque[1];
  }
  if (element.tagName === "SPAN") {
    const termId = element.getAttribute("data-flt-term-id");
    if (termId && /^\d+$/.test(termId)) return "SPAN#TERM_" + termId;
  }
  return element.tagName;
}

function structureSignatures(html: string): string[] {
  const body = parseBody(html);
  const signatures: string[] = [];

  const walk = (element: Element, parentPath: string[]) => {
    if (isLinkBoundaryElement(element)) return;
    const identity = elementIdentity(element);
    const path = [...parentPath, identity];
    signatures.push(path.join("/"));
    for (const child of Array.from(element.children)) walk(child, path);
  };

  for (const child of Array.from(body.children)) walk(child, []);
  return signatures.sort();
}

export function richHtmlStructureCompatible(sourceHtml: string, translatedHtml: string): boolean {
  const source = structureSignatures(sourceHtml);
  const translated = structureSignatures(translatedHtml);
  return source.length === translated.length
    && source.every((value, index) => value === translated[index]);
}

export async function translateRichHtmlTextNodesSafely(
  html: string,
  translateText: (text: string) => Promise<string>,
): Promise<string> {
  const body = parseBody(html);
  const nodes: Text[] = [];
  const walker = body.ownerDocument.createTreeWalker(body, NodeFilter.SHOW_TEXT);
  let current = walker.nextNode();
  while (current) {
    const node = current as Text;
    const parent = node.parentElement;
    const raw = node.data;
    if (
      raw.trim()
      && /\p{L}/u.test(raw)
      && !LINK_BOUNDARY_RE.test(raw.trim())
      && !parent?.closest("code,kbd,samp,var,[data-flt-term-id]")
    ) {
      nodes.push(node);
    }
    current = walker.nextNode();
  }

  const translations = await Promise.all(nodes.map(async (node) => {
    const raw = node.data;
    const leading = raw.match(/^\s*/)?.[0] ?? "";
    const trailing = raw.match(/\s*$/)?.[0] ?? "";
    const core = raw.slice(leading.length, raw.length - trailing.length);
    if (!core) return raw;
    const translated = (await translateText(core)).trim();
    return translated ? leading + translated + trailing : raw;
  }));

  nodes.forEach((node, index) => { node.data = translations[index] ?? node.data; });
  return body.innerHTML;
}
