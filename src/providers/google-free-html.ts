// Whole-paragraph compact HTML transport for Google Free (translate_a/t).
//
// translate_a/t?client=dict-chrome-ex natively translates HTML and honors
// class="notranslate". Sending the entire paragraph with compact inline tags
// instead of splitting at every <strong>/<a>/<code>/<span data-flt-term-id>
// preserves full sentence context (preventing broken fragments like
// "Onboarding offers" -> "入职优惠") while mapping deterministically back into
// PageLingo's fixed text-slot skeleton. Any paragraph whose tags are reordered
// or altered by Google returns undefined so the caller falls back safely.

const MAX_GOOGLE_HTML_WIRE_CHARS = 2800;
const LINK_MARKER_RE = /^__FLT_LINK_(?:START|END)_\d+__$/u;
const BLANK_LINE_RE = /\r?\n[ \t]*\r?\n/u;
const ASCII_WS_RE = /^[\t\n\f\r ]*$/u;
const OPAQUE_ATOM_SELECTOR = "code,kbd,samp,var,[data-flt-fixed]";
const UNSUPPORTED_VOID_SELECTOR = "br,wbr,img,svg,hr,input,textarea,select,video,audio,iframe";

function escapeWireHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function isLinkBoundaryMarker(node: Node): boolean {
  if (node.nodeType !== Node.ELEMENT_NODE) return false;
  const el = node as Element;
  return /^(?:CODE|KBD|SAMP|VAR)$/u.test(el.tagName)
    && el.childElementCount === 0
    && LINK_MARKER_RE.test((el.textContent ?? "").trim());
}

function isTermSpan(node: Node): node is Element {
  if (node.nodeType !== Node.ELEMENT_NODE) return false;
  const el = node as Element;
  return el.tagName === "SPAN"
    && el.hasAttribute("data-flt-term-id")
    && /^\d+$/u.test(el.getAttribute("data-flt-term-id") ?? "")
    && el.childElementCount === 0;
}

function isTextSlotSpan(node: Node): node is Element {
  if (node.nodeType !== Node.ELEMENT_NODE) return false;
  const el = node as Element;
  return el.tagName === "SPAN"
    && el.hasAttribute("data-flt-text-id")
    && /^\d+$/u.test(el.getAttribute("data-flt-text-id") ?? "");
}

function isOpaqueAtom(node: Node): node is Element {
  if (node.nodeType !== Node.ELEMENT_NODE) return false;
  const el = node as Element;
  return el.matches(OPAQUE_ATOM_SELECTOR);
}

function wireTagForElement(tagName: string): string {
  switch (tagName) {
    case "A": return "a";
    case "B":
    case "STRONG": return "b";
    case "I":
    case "EM": return "i";
    case "U": return "u";
    case "S":
    case "DEL": return "s";
    case "SUB": return "sub";
    case "SUP": return "sup";
    default: return "span";
  }
}

interface SourceGapSlot {
  slotEl: Element;
  expectedTerms: Map<string, string>;
  leadingWs: string;
  trailingWs: string;
  hadNonEmptyText: boolean;
}

interface ContainerPlan {
  /** Number of gaps = structural.length + 1. Each gap has at most one text slot. */
  gapSlots: Array<SourceGapSlot | null>;
  structural: Array<
    | { kind: "atom"; id: string; sourceEl: Element }
    | { kind: "el"; id: string; sourceEl: Element; childPlan: ContainerPlan }
  >;
}

export type GoogleFreeHtmlPlan =
  | {
      kind: "fixed-slots";
      sourceBody: HTMLElement;
      wireHtml: string;
      rootPlan: ContainerPlan;
    }
  | {
      kind: "simple";
      wireHtml: string;
      expectedTerms: Map<string, string>;
    };

function serializeTermTextContainer(container: Element): { wire: string; expectedTerms: Map<string, string> } | null {
  const expectedTerms = new Map<string, string>();
  let wire = "";
  for (const child of Array.from(container.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      wire += escapeWireHtml(child.textContent ?? "");
    } else if (isTermSpan(child)) {
      const tid = child.getAttribute("data-flt-term-id")!;
      const text = child.textContent ?? "";
      if (expectedTerms.has(tid)) return null;
      expectedTerms.set(tid, text);
      wire += `<span class="notranslate" data-pl-t="${tid}">${escapeWireHtml(text)}</span>`;
    } else {
      return null;
    }
  }
  return { wire, expectedTerms };
}

export function packGoogleFreeHtml(sourceHtml: string): GoogleFreeHtmlPlan | null {
  if (!sourceHtml || sourceHtml.length > MAX_GOOGLE_HTML_WIRE_CHARS || BLANK_LINE_RE.test(sourceHtml)) {
    return null;
  }
  const doc = new DOMParser().parseFromString(sourceHtml, "text/html");
  const body = doc.body;
  if (body.querySelector(UNSUPPORTED_VOID_SELECTOR)) return null;

  const hasTextSlots = Boolean(body.querySelector("[data-flt-text-id]"));
  if (!hasTextSlots) {
    // Simple non-slot HTML (e.g. popup text / image OCR): only pack if it consists
    // solely of text nodes and protected term spans.
    const serialized = serializeTermTextContainer(body);
    if (!serialized || serialized.expectedTerms.size === 0) return null;
    if (serialized.wire.length > MAX_GOOGLE_HTML_WIRE_CHARS) return null;
    return {
      kind: "simple",
      wireHtml: serialized.wire,
      expectedTerms: serialized.expectedTerms,
    };
  }

  let elCounter = 0;
  let atomCounter = 0;
  let slotCount = 0;

  const buildContainer = (container: Element): { wire: string; plan: ContainerPlan } | null => {
    const gapSlots: Array<SourceGapSlot | null> = [null];
    const structural: ContainerPlan["structural"] = [];
    let wire = "";

    for (const child of Array.from(container.childNodes)) {
      if (isLinkBoundaryMarker(child)) continue;

      if (child.nodeType === Node.TEXT_NODE) {
        const text = child.textContent ?? "";
        if (!ASCII_WS_RE.test(text)) return null;
        wire += text;
        continue;
      }

      if (isTextSlotSpan(child)) {
        const gapIndex = structural.length;
        if (gapSlots[gapIndex] !== null) return null; // Adjacent slots without separator.
        const serialized = serializeTermTextContainer(child);
        if (!serialized) return null;
        const fullText = child.textContent ?? "";
        gapSlots[gapIndex] = {
          slotEl: child,
          expectedTerms: serialized.expectedTerms,
          leadingWs: fullText.match(/^\s*/u)?.[0] ?? "",
          trailingWs: fullText.match(/\s*$/u)?.[0] ?? "",
          hadNonEmptyText: fullText.trim().length > 0,
        };
        slotCount += 1;
        wire += serialized.wire;
        continue;
      }

      if (isOpaqueAtom(child)) {
        const id = String(atomCounter++);
        structural.push({ kind: "atom", id, sourceEl: child });
        gapSlots.push(null);
        wire += `<span class="notranslate" data-pl-a="${id}">${escapeWireHtml(child.textContent ?? "")}</span>`;
        continue;
      }

      if (child.nodeType === Node.ELEMENT_NODE) {
        const el = child as Element;
        if (el.hasAttribute("data-flt-term-id")) return null;
        const id = String(elCounter++);
        const inner = buildContainer(el);
        if (!inner) return null;
        structural.push({ kind: "el", id, sourceEl: el, childPlan: inner.plan });
        gapSlots.push(null);
        const tag = wireTagForElement(el.tagName);
        wire += `<${tag} data-pl-el="${id}">${inner.wire}</${tag}>`;
        continue;
      }

      return null;
    }

    return { wire, plan: { gapSlots, structural } };
  };

  const built = buildContainer(body);
  if (!built || slotCount === 0 || built.wire.length > MAX_GOOGLE_HTML_WIRE_CHARS) return null;
  // Require at least one inline structure or protected term; pure single-slot text
  // without terms needs no HTML wrapping at all.
  if (elCounter === 0 && atomCounter === 0 && !built.wire.includes("data-pl-t=")) return null;

  return {
    kind: "fixed-slots",
    sourceBody: body,
    wireHtml: built.wire,
    rootPlan: built.plan,
  };
}

function restoreTermNodesIntoSlot(
  doc: Document,
  targetSlot: Element,
  wireGapNodes: Node[],
  expectedTerms: Map<string, string>,
  leadingWs: string,
  trailingWs: string,
  hadNonEmptyText: boolean,
): boolean {
  const seenTerms = new Set<string>();
  const builtNodes: Node[] = [];

  for (const node of wireGapNodes) {
    if (node.nodeType === Node.TEXT_NODE) {
      builtNodes.push(doc.createTextNode(node.textContent ?? ""));
      continue;
    }
    if (node.nodeType === Node.ELEMENT_NODE) {
      const el = node as Element;
      const tid = el.getAttribute("data-pl-t");
      if (el.tagName !== "SPAN" || tid === null || !expectedTerms.has(tid) || seenTerms.has(tid)) {
        return false;
      }
      seenTerms.add(tid);
      const span = doc.createElement("span");
      span.setAttribute("data-flt-term-id", tid);
      span.textContent = expectedTerms.get(tid)!;
      builtNodes.push(span);
      continue;
    }
    return false;
  }

  // If Google unwrapped a <span data-pl-t> while keeping the exact protected text
  // verbatim inside a text node in this gap, re-wrap that occurrence deterministically.
  if (seenTerms.size < expectedTerms.size) {
    for (const [tid, termText] of expectedTerms) {
      if (seenTerms.has(tid)) continue;
      if (!termText) return false;
      let rewrapped = false;
      for (let i = 0; i < builtNodes.length; i += 1) {
        const node = builtNodes[i]!;
        if (node.nodeType !== Node.TEXT_NODE) continue;
        const data = node.textContent ?? "";
        const at = data.indexOf(termText);
        if (at < 0) continue;
        const before = data.slice(0, at);
        const after = data.slice(at + termText.length);
        const span = doc.createElement("span");
        span.setAttribute("data-flt-term-id", tid);
        span.textContent = termText;
        const replacement: Node[] = [];
        if (before) replacement.push(doc.createTextNode(before));
        replacement.push(span);
        if (after) replacement.push(doc.createTextNode(after));
        builtNodes.splice(i, 1, ...replacement);
        seenTerms.add(tid);
        rewrapped = true;
        break;
      }
      if (!rewrapped) return false;
    }
  }

  if (seenTerms.size !== expectedTerms.size) return false;

  // Normalize outer edge whitespace to match the original slot boundary.
  const first = builtNodes[0];
  if (first && first.nodeType === Node.TEXT_NODE) {
    first.textContent = leadingWs + (first.textContent ?? "").replace(/^\s+/u, "");
  } else if (leadingWs) {
    builtNodes.unshift(doc.createTextNode(leadingWs));
  }
  const last = builtNodes[builtNodes.length - 1];
  if (last && last.nodeType === Node.TEXT_NODE) {
    last.textContent = (last.textContent ?? "").replace(/\s+$/u, "") + trailingWs;
  } else if (trailingWs) {
    builtNodes.push(doc.createTextNode(trailingWs));
  }

  targetSlot.replaceChildren(...builtNodes);
  if (hadNonEmptyText && !(targetSlot.textContent ?? "").trim()) return false;
  return true;
}

export function unpackGoogleFreeHtml(plan: GoogleFreeHtmlPlan, translatedWireHtml: string): string | undefined {
  if (typeof translatedWireHtml !== "string" || !translatedWireHtml.trim()) return undefined;
  const wireDoc = new DOMParser().parseFromString(translatedWireHtml, "text/html");
  if (wireDoc.head.childNodes.length > 0) return undefined;

  if (plan.kind === "simple") {
    const outDoc = new DOMParser().parseFromString("", "text/html");
    const ok = restoreTermNodesIntoSlot(
      outDoc,
      outDoc.body,
      Array.from(wireDoc.body.childNodes),
      plan.expectedTerms,
      "",
      "",
      true,
    );
    return ok ? outDoc.body.innerHTML : undefined;
  }

  const outDoc = new DOMParser().parseFromString(plan.sourceBody.innerHTML, "text/html");
  const findCorresponding = (
    rootContainer: Element,
    clonedContainer: Element,
    sourceTarget: Element,
  ): Element | null => {
    const sourceChildren = Array.from(rootContainer.children);
    const clonedChildren = Array.from(clonedContainer.children);
    const idx = sourceChildren.indexOf(sourceTarget);
    return idx >= 0 && idx < clonedChildren.length ? clonedChildren[idx]! : null;
  };

  const applyContainer = (
    sourceContainer: Element,
    clonedContainer: Element,
    wireContainer: Element,
    containerPlan: ContainerPlan,
  ): boolean => {
    const wireGaps: Node[][] = [[]];
    const wireStructural: Array<{ kind: "atom" | "el"; id: string; el: Element }> = [];

    for (const child of Array.from(wireContainer.childNodes)) {
      if (child.nodeType === Node.ELEMENT_NODE) {
        const el = child as Element;
        const atomId = el.getAttribute("data-pl-a");
        if (atomId !== null) {
          wireStructural.push({ kind: "atom", id: atomId, el });
          wireGaps.push([]);
          continue;
        }
        const elId = el.getAttribute("data-pl-el");
        if (elId !== null) {
          wireStructural.push({ kind: "el", id: elId, el });
          wireGaps.push([]);
          continue;
        }
      }
      wireGaps[wireGaps.length - 1]!.push(child);
    }

    if (wireStructural.length !== containerPlan.structural.length) return false;
    for (let i = 0; i < containerPlan.structural.length; i += 1) {
      const expected = containerPlan.structural[i]!;
      const actual = wireStructural[i]!;
      if (expected.kind !== actual.kind || expected.id !== actual.id) return false;
    }

    for (let gapIndex = 0; gapIndex < containerPlan.gapSlots.length; gapIndex += 1) {
      const gapSlot = containerPlan.gapSlots[gapIndex] ?? null;
      const gapNodes = wireGaps[gapIndex] ?? [];
      if (!gapSlot) {
        const strayText = gapNodes.map((n) => n.textContent ?? "").join("");
        if (!ASCII_WS_RE.test(strayText)) return false;
        continue;
      }
      const clonedSlot = findCorresponding(sourceContainer, clonedContainer, gapSlot.slotEl);
      if (!clonedSlot) return false;
      const ok = restoreTermNodesIntoSlot(
        outDoc,
        clonedSlot,
        gapNodes,
        gapSlot.expectedTerms,
        gapSlot.leadingWs,
        gapSlot.trailingWs,
        gapSlot.hadNonEmptyText,
      );
      if (!ok) return false;
    }

    for (let i = 0; i < containerPlan.structural.length; i += 1) {
      const item = containerPlan.structural[i]!;
      if (item.kind !== "el") continue;
      const clonedChild = findCorresponding(sourceContainer, clonedContainer, item.sourceEl);
      if (!clonedChild) return false;
      if (!applyContainer(item.sourceEl, clonedChild, wireStructural[i]!.el, item.childPlan)) {
        return false;
      }
    }

    return true;
  };

  const ok = applyContainer(plan.sourceBody, outDoc.body, wireDoc.body, plan.rootPlan);
  return ok ? outDoc.body.innerHTML : undefined;
}
