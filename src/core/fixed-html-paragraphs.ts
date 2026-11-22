import { getHtmlParser } from "../shared/html-parser";

const BLANK_LINE_BREAK_RE = /\r?\n[ \t]*\r?\n/u;
const BLANK_LINE_SPLIT_RE = /(\r?\n(?:[ \t]*\r?\n)+)/u;
const PREFORMATTED_WHITE_SPACE = new Set(["pre", "pre-wrap", "pre-line", "break-spaces"]);
const SINGLE_INLINE_WRAPPER_TAGS = new Set(["I", "B", "EM", "STRONG", "SPAN", "U", "S", "SMALL", "MARK", "Q", "CITE"]);

export interface PreformattedParagraphRun {
  html: string;
  plainText: string;
}

export interface PreformattedParagraphPlan {
  runs: PreformattedParagraphRun[];
  reassemble: (translatedRunHtmls: string[]) => string;
}

type SlotPartRef =
  | { kind: "literal"; text: string }
  | { kind: "piece"; runIndex: number; localSlotId: string };

/**
 * Returns true when CSS preserves literal line breaks inside `root`
 * (e.g. `white-space: pre-wrap` story containers in web apps/games).
 */
export function isPreformattedNewlineContext(root: HTMLElement): boolean {
  const ws = root.ownerDocument.defaultView?.getComputedStyle(root)?.whiteSpace ?? "";
  return PREFORMATTED_WHITE_SPACE.has(ws);
}

function isDirectSplitCandidate(node: Node): node is HTMLElement {
  if (node.nodeType !== Node.ELEMENT_NODE) return false;
  const el = node as HTMLElement;
  return el.tagName === "SPAN"
    && el.hasAttribute("data-flt-text-id")
    && el.childElementCount === 0
    && BLANK_LINE_BREAK_RE.test(el.textContent ?? "");
}

function isWrappedSplitCandidate(node: Node): { wrapper: HTMLElement; slot: HTMLElement } | null {
  if (node.nodeType !== Node.ELEMENT_NODE) return null;
  const el = node as HTMLElement;
  if (!SINGLE_INLINE_WRAPPER_TAGS.has(el.tagName) || el.childNodes.length !== 1) return null;
  const onlyChild = el.firstChild;
  if (!onlyChild || !isDirectSplitCandidate(onlyChild)) return null;
  return { wrapper: el, slot: onlyChild };
}

/**
 * Splits a fixed-text HTML segment that uses literal blank lines (`\n\n`) as
 * paragraph boundaries inside a `white-space: pre-wrap` / `pre-line` container
 * into independent paragraph-level HTML runs, while keeping inline elements on
 * the same paragraph together for full sentence context.
 *
 * Returns `null` when fewer than 2 translatable runs exist (caller should keep
 * the single-request fast path).
 */
export function planPreformattedParagraphRuns(sourceHtml: string): PreformattedParagraphPlan | null {
  if (!BLANK_LINE_BREAK_RE.test(sourceHtml) || !sourceHtml.includes("data-flt-text-id=")) {
    return null;
  }

  const parser = getHtmlParser();
  const sourceDoc = parser.parseFromString(sourceHtml, "text/html");
  if (sourceDoc.head.childNodes.length) return null;

  const runs: PreformattedParagraphRun[] = [];
  const slotReassembly = new Map<string, SlotPartRef[]>();
  const directSlotMap = new Map<string, { runIndex: number; localSlotId: string }>();

  let currentNodes: Node[] = [];
  const pendingPieces = new WeakMap<Element, { kind: "piece"; runIndex: number; localSlotId: string }>();

  const flushRun = () => {
    if (!currentNodes.length) return;
    const holder = sourceDoc.createElement("div");
    for (const node of currentNodes) holder.append(node);
    currentNodes = [];

    const slotSpans = Array.from(holder.querySelectorAll("span[data-flt-text-id]"));
    if (!slotSpans.length || !/\p{L}/u.test(holder.textContent ?? "")) return;

    const runIndex = runs.length;
    for (let localIndex = 0; localIndex < slotSpans.length; localIndex += 1) {
      const span = slotSpans[localIndex]!;
      const localSlotId = String(localIndex);
      const pending = pendingPieces.get(span);
      if (pending) {
        pending.runIndex = runIndex;
        pending.localSlotId = localSlotId;
      } else {
        const origId = span.getAttribute("data-flt-text-id");
        if (origId !== null) {
          directSlotMap.set(origId, { runIndex, localSlotId });
        }
      }
      span.setAttribute("data-flt-text-id", localSlotId);
    }

    runs.push({
      html: holder.innerHTML,
      plainText: holder.textContent ?? "",
    });
  };

  const splitSlotText = (slotId: string, rawText: string, wrapperTag: string | null) => {
    const parts = rawText.split(BLANK_LINE_SPLIT_RE);
    const refs: SlotPartRef[] = [];
    slotReassembly.set(slotId, refs);

    for (let i = 0; i < parts.length; i += 1) {
      const part = parts[i] ?? "";
      if (i % 2 === 1) {
        flushRun();
        refs.push({ kind: "literal", text: part });
        continue;
      }
      if (!part.trim() || !/\p{L}/u.test(part)) {
        refs.push({ kind: "literal", text: part });
        continue;
      }
      const span = sourceDoc.createElement("span");
      span.setAttribute("data-flt-text-id", slotId);
      span.textContent = part;
      const ref: { kind: "piece"; runIndex: number; localSlotId: string } = {
        kind: "piece",
        runIndex: -1,
        localSlotId: "",
      };
      refs.push(ref);
      pendingPieces.set(span, ref);
      if (wrapperTag) {
        const wrap = sourceDoc.createElement(wrapperTag.toLowerCase());
        wrap.append(span);
        currentNodes.push(wrap);
      } else {
        currentNodes.push(span);
      }
    }
  };

  for (const child of Array.from(sourceDoc.body.childNodes)) {
    if (isDirectSplitCandidate(child)) {
      const slotId = child.getAttribute("data-flt-text-id")!;
      splitSlotText(slotId, child.textContent ?? "", null);
      continue;
    }
    const wrapped = isWrappedSplitCandidate(child);
    if (wrapped) {
      const slotId = wrapped.slot.getAttribute("data-flt-text-id")!;
      splitSlotText(slotId, wrapped.slot.textContent ?? "", wrapped.wrapper.tagName);
      continue;
    }
    if (child.nodeType === Node.TEXT_NODE && BLANK_LINE_BREAK_RE.test(child.textContent ?? "")) {
      flushRun();
      continue;
    }
    currentNodes.push(child.cloneNode(true));
  }
  flushRun();

  if (runs.length <= 1) return null;

  return {
    runs,
    reassemble(translatedRunHtmls: string[]): string {
      if (translatedRunHtmls.length !== runs.length) {
        throw new Error("Multi-paragraph translation count mismatch");
      }
      const translatedMaps = translatedRunHtmls.map((runHtml) => {
        const parsed = parser.parseFromString(runHtml, "text/html");
        const map = new Map<string, string>();
        for (const span of parsed.body.querySelectorAll("span[data-flt-text-id]")) {
          const id = span.getAttribute("data-flt-text-id");
          if (id !== null) map.set(id, span.textContent ?? "");
        }
        return map;
      });

      const outputBody = sourceDoc.body.cloneNode(true) as HTMLElement;
      for (const span of outputBody.querySelectorAll("span[data-flt-text-id]")) {
        const origId = span.getAttribute("data-flt-text-id");
        if (origId === null) continue;
        const splitRefs = slotReassembly.get(origId);
        if (splitRefs) {
          span.textContent = splitRefs.map((ref) => {
            if (ref.kind === "literal") return ref.text;
            const value = translatedMaps[ref.runIndex]?.get(ref.localSlotId);
            if (typeof value !== "string") {
              throw new Error("Missing translated paragraph piece");
            }
            return value;
          }).join("");
          continue;
        }
        const direct = directSlotMap.get(origId);
        if (direct) {
          const value = translatedMaps[direct.runIndex]?.get(direct.localSlotId);
          if (typeof value !== "string") {
            throw new Error("Missing translated slot in paragraph run");
          }
          span.textContent = value;
        }
      }
      return outputBody.innerHTML;
    },
  };
}
