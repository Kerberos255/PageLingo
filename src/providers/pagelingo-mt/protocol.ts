import type { TranslationRequest } from "../../core/provider";

export interface EncodedMtHtml {
  source: string;
  elements: Map<number, { tag: string; attrs: Array<[string, string]> }>;
  slots: Map<string, { kind: "text" | "html"; value: string }>;
  parents: Map<number, number | null>;
}

export interface MtValidation {
  ok: boolean;
  markerOk: boolean;
  nestingOk: boolean;
  slotOk: boolean;
  cjkOk: boolean;
  cleanOk: boolean;
  errors: string[];
}

const markerRe = /⟦(\/?)(\d{1,2})⟧/g;
const slotRe = /⟪P(\d{1,2})⟫/g;
const protectedTags = new Set(["CODE", "KBD", "SAMP", "VAR"]);
const linkBoundaryRe = /^__FLT_LINK_(?:START|END)_\d+__$/;

export function mtPrompt(source: string, terminology: TranslationRequest["terminology"] = [], context?: TranslationRequest["context"]): string {
  const references = terminology.filter(entry => entry.source.trim() && entry.target.trim() && entry.source.length <= 96 && entry.target.length <= 96).slice(0, 16)
    .map(entry => `${entry.source} translates to ${entry.target}`);
  const domain = context ? `Domain: ${{http: "HTTP protocol documentation", javascript: "JavaScript programming", sql: "SQL transactions", python: "Python programming"}[context]}.\n` : "";
  const prefix = domain + (references.length ? `Reference the following translations:\n${references.join("\n")}\n\n` : "");
  return prefix + `Translate the following text from English into Simplified Chinese.
Rules:
1. Keep every ⟦n⟧ and ⟦/n⟧ inline marker exactly once. A marker pair may move as a whole when Chinese word order requires it, but its boundary must not expand, shrink, cross, or change nesting.
2. Keep every opaque protected slot such as ⟪P0⟫ exactly once and unchanged. Do not translate, split, remove, duplicate, or rewrite a protected slot. Protected slots may move with Chinese word order.
3. Output only the Chinese translation. Do not add explanations, names, prefixes, labels, or commentary.
English:
${source}
Chinese:`;
}

/** @deprecated Legacy movable-markup format; inference uses fixed-text.ts. */
export function encodeMtHtml(html: string): EncodedMtHtml {
  const parsed = new DOMParser().parseFromString(html, "text/html");
  const elements = new Map<number, { tag: string; attrs: Array<[string, string]> }>();
  const slots = new Map<string, { kind: "text" | "html"; value: string }>();
  const parents = new Map<number, number | null>();
  let nextMarker = 0;
  let nextSlot = 0;

  const slot = (value: { kind: "text" | "html"; value: string }): string => {
    const key = `P${nextSlot++}`;
    slots.set(key, value);
    return `⟪${key}⟫`;
  };

  const walk = (node: Node, parent: number | null): string => {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
    if (node.nodeType !== Node.ELEMENT_NODE) return "";
    const el = node as HTMLElement;
    const rawText = (el.textContent ?? "").trim();
    if ((protectedTags.has(el.tagName) && linkBoundaryRe.test(rawText)) || el.hasAttribute("data-flt-term-id")) {
      return slot({ kind: "html", value: el.outerHTML });
    }
    const id = nextMarker++;
    if (id > 31) throw new Error("PageLingo MT marker budget exceeded");
    parents.set(id, parent);
    elements.set(id, {
      tag: el.tagName.toLowerCase(),
      attrs: Array.from(el.attributes).map((attribute) => [attribute.name, attribute.value]),
    });
    let inner = "";
    if (protectedTags.has(el.tagName)) {
      inner = slot({ kind: "text", value: el.textContent ?? "" });
    } else {
      for (const child of Array.from(el.childNodes)) inner += walk(child, id);
    }
    return `⟦${id}⟧${inner}⟦/${id}⟧`;
  };

  let source = "";
  for (const child of Array.from(parsed.body.childNodes)) {
    source += child.nodeType === Node.TEXT_NODE ? (child.textContent ?? "") : walk(child, null);
  }
  return { source, elements, slots, parents };
}

function parseMarkers(text: string) {
  const stack: number[] = [];
  const parents = new Map<number, number | null>();
  const opens = new Map<number, number>();
  const closes = new Map<number, number>();
  const errors: string[] = [];
  for (const match of text.matchAll(markerRe)) {
    const closing = match[1] === "/";
    const id = Number(match[2]);
    if (!closing) {
      opens.set(id, (opens.get(id) ?? 0) + 1);
      if ((opens.get(id) ?? 0) !== 1) errors.push(`duplicate open ${id}`);
      parents.set(id, stack.length ? stack[stack.length - 1]! : null);
      stack.push(id);
    } else {
      closes.set(id, (closes.get(id) ?? 0) + 1);
      if (!stack.length || stack[stack.length - 1] !== id) errors.push(`mismatched close ${id}`);
      else stack.pop();
    }
  }
  if (stack.length) errors.push("unclosed marker");
  const ids = new Set([...opens.keys(), ...closes.keys()]);
  for (const id of ids) {
    if ((opens.get(id) ?? 0) !== 1 || (closes.get(id) ?? 0) !== 1) errors.push(`marker count invalid ${id}`);
  }
  return { ids, parents, errors };
}

/** @deprecated Does not establish text-node ownership; not used for MT inference. */
export function validateMtOutput(encoded: EncodedMtHtml, output: string): MtValidation {
  const source = parseMarkers(encoded.source);
  const target = parseMarkers(output);
  const errors = [...target.errors];
  const markerOk =
    source.errors.length === 0 &&
    target.errors.length === 0 &&
    source.ids.size === target.ids.size &&
    [...source.ids].every((id) => target.ids.has(id));

  let nestingOk = markerOk;
  if (markerOk) {
    for (const [id, parent] of encoded.parents) {
      if (target.parents.get(id) !== parent) {
        nestingOk = false;
        errors.push(`nesting changed ${id}`);
      }
    }
  }

  const expectedSlots = [...encoded.slots.keys()].sort();
  const actualSlots = [...output.matchAll(slotRe)].map((match) => `P${match[1]}`).sort();
  const slotOk =
    expectedSlots.length === actualSlots.length &&
    expectedSlots.every((key, index) => key === actualSlots[index]) &&
    expectedSlots.every((key) => output.split(`⟪${key}⟫`).length === 2);
  if (!slotOk) errors.push("slot mismatch");

  const sourceHasLetters = /\p{L}/u.test(encoded.source.replace(markerRe, "").replace(slotRe, ""));
  const cjkOk = !sourceHasLetters || /[\u3400-\u9fff]/u.test(output);
  if (!cjkOk) errors.push("no CJK");

  const lowered = output.trim().toLowerCase();
  const cleanOk = Boolean(output.trim()) &&
    !["<think>", "/ayushman", "translation:", "translated text:", "chinese:"].some((prefix) => lowered.startsWith(prefix));
  if (!cleanOk) errors.push("unclean output");

  return { ok: markerOk && nestingOk && slotOk && cjkOk && cleanOk, markerOk, nestingOk, slotOk, cjkOk, cleanOk, errors };
}

function appendDecodedText(parent: Node, value: string, slots: EncodedMtHtml["slots"]): void {
  let cursor = 0;
  for (const match of value.matchAll(slotRe)) {
    const index = match.index ?? 0;
    if (index > cursor) parent.appendChild(document.createTextNode(value.slice(cursor, index)));
    const key = `P${match[1]}`;
    const payload = slots.get(key);
    if (!payload) throw new Error(`missing slot ${key}`);
    if (payload.kind === "text") {
      parent.appendChild(document.createTextNode(payload.value));
    } else {
      const parsed = new DOMParser().parseFromString(payload.value, "text/html");
      for (const node of Array.from(parsed.body.childNodes)) parent.appendChild(document.importNode(node, true));
    }
    cursor = index + match[0].length;
  }
  if (cursor < value.length) parent.appendChild(document.createTextNode(value.slice(cursor)));
}

export function decodeMtHtml(encoded: EncodedMtHtml, output: string): string {
  type TreeNode = string | { id: number; children: TreeNode[] };
  const root: TreeNode[] = [];
  const stack: Array<{ id: number; children: TreeNode[] }> = [];
  let cursor = 0;

  for (const match of output.matchAll(markerRe)) {
    const index = match.index ?? 0;
    if (index > cursor) (stack.length ? stack[stack.length - 1]!.children : root).push(output.slice(cursor, index));
    const closing = match[1] === "/";
    const id = Number(match[2]);
    if (!closing) {
      const node = { id, children: [] as TreeNode[] };
      (stack.length ? stack[stack.length - 1]!.children : root).push(node);
      stack.push(node);
    } else {
      if (!stack.length || stack[stack.length - 1]!.id !== id) throw new Error("decoder nesting mismatch");
      stack.pop();
    }
    cursor = index + match[0].length;
  }
  if (cursor < output.length) (stack.length ? stack[stack.length - 1]!.children : root).push(output.slice(cursor));
  if (stack.length) throw new Error("decoder unclosed marker");

  const holder = document.createElement("div");
  const append = (parent: Node, items: TreeNode[]) => {
    for (const item of items) {
      if (typeof item === "string") {
        appendDecodedText(parent, item, encoded.slots);
        continue;
      }
      const template = encoded.elements.get(item.id);
      if (!template) throw new Error(`missing element template ${item.id}`);
      const element = document.createElement(template.tag);
      for (const [name, value] of template.attrs) element.setAttribute(name, value);
      append(element, item.children);
      parent.appendChild(element);
    }
  };
  append(holder, root);
  return holder.innerHTML;
}

export function mtMaxTokens(encoded: EncodedMtHtml): number {
  const plain = encoded.source.replace(markerRe, "").replace(slotRe, "").trim();
  return Math.max(48, Math.min(256, Math.ceil(plain.length * 1.5)));
}

export function mtRouteSupported(request: TranslationRequest): boolean {
  const source = request.sourceLanguage.toLowerCase();
  const target = request.targetLanguage.toLowerCase();
  return source === "en" && (target === "zh" || target.startsWith("zh-"));
}
