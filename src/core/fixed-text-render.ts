import { captureSourceLayout, mountTranslation } from "./render";
import { isOptionalEnglishArticle } from "./translation-quality";
import { isElementEffectivelyHidden, isHiddenInsideClosedDetails, isTranslationControl, isNestedOwnerBoundary, isTranslationDisabled } from "./dom-policy";
import {canCollapseProseWhitespace, canWriteFrozenProseGap, isAsciiWhitespace, isAsciiWhitespaceOrEmpty} from "./collapsible-whitespace";
import {cjkSpacingBoundaryUnchanged, cjkSpacingContextUnchanged, normalizeCjkSpacing} from "./cjk-spacing";
import { parseHtmlBody } from "../shared/html-parser";

export type CapturedSourceLayout = ReturnType<typeof captureSourceLayout>;
export interface SourceTextSlot { id: number; node: Text; parent: Node; source: string; writePolicy?: "collapsible-whitespace" | "frozen-prose-gap" }
interface TextEdit extends SourceTextSlot { translated: string }
export interface FixedTextRecord {
  root: HTMLElement;
  edits: TextEdit[];
  snapshot: Array<{node: Node; text: string | null}>;
  mode: "translation" | "bilingual";
  translationNode: HTMLElement | null;
  hiddenElements?: ReadonlySet<Element>;
}
export interface FrozenProseWitness {target: string; readProjected: (edits: ReadonlyMap<Text, string>) => string}
const frozenSourceAuthority = new WeakSet<SourceTextSlot>();
const frozenRecordAuthority = new WeakMap<FixedTextRecord, FrozenProseWitness>();
const spacingAuthority = new WeakMap<FixedTextRecord, {nodes: readonly Text[]; boundaries: readonly (readonly [Text, Text])[]}>();

function sourceNodes(root: HTMLElement): Node[] {
  const nodes: Node[] = [];
  const walk = (node: Node) => {
    if (node.nodeType === Node.ELEMENT_NODE && (node as Element).hasAttribute("data-flt-generated")) return;
    if (node !== root && node.nodeType === Node.ELEMENT_NODE && isNestedOwnerBoundary(node, root)) return;
    nodes.push(node);
    for (const child of Array.from(node.childNodes)) walk(child);
  };
  walk(root);
  return nodes;
}

export function prepareFixedTextRecord(
  root: HTMLElement,
  slots: SourceTextSlot[],
  html: string,
  language = "",
  hiddenElements?: ReadonlySet<Element>,
): FixedTextRecord {
  const body = parseHtmlBody(html);
  const targets = Array.from(body.querySelectorAll("[data-flt-text-id]"));
  if (targets.length !== slots.length) throw new Error("Translation text-node mapping count mismatch");
  const edits: TextEdit[] = [];
  for (const slot of slots) {
    const target = targets[slot.id];
    if (!target || target.tagName !== "SPAN" || target.getAttribute("data-flt-text-id") !== String(slot.id)
        || target.childElementCount || !slot.node.isConnected || !root.contains(slot.node)
        || slot.node.parentNode !== slot.parent || slot.node.data !== slot.source) {
      throw new Error("Translation text-node mapping changed; original paragraph retained");
    }
    const translated = target.textContent ?? "";
    if (slot.writePolicy === "frozen-prose-gap") {
      if (!frozenSourceAuthority.has(slot) || !canWriteFrozenProseGap(slot.node, slot.source)) {
        throw new Error("Translation frozen prose gap requires verified application authority");
      }
    } else if (slot.writePolicy === "collapsible-whitespace") {
      if (!isAsciiWhitespace(slot.source) || !isAsciiWhitespaceOrEmpty(translated) || !canCollapseProseWhitespace(slot.node)) {
        throw new Error("Translation collapsible whitespace ownership changed");
      }
    } else if (!translated.trim() && !isOptionalEnglishArticle(slot.source)) throw new Error("Translation empty text-node translation");
    edits.push({...slot, translated});
  }
  const snapshot = sourceNodes(root).map(node => ({node, text: node.nodeType === Node.TEXT_NODE ? node.textContent : null}));
  const originalTranslations = edits.map(edit => edit.translated);
  const boundaries = normalizeCjkSpacing(root, edits, language);
  const record: FixedTextRecord = {
    root,
    edits,
    snapshot,
    mode: "bilingual",
    translationNode: null,
    ...(hiddenElements ? { hiddenElements } : {}),
  };
  const spacingNodes = edits.filter((edit, i) => edit.translated !== originalTranslations[i]).map(edit => edit.node);
  if (spacingNodes.length) spacingAuthority.set(record, {nodes: spacingNodes, boundaries});
  return record;
}

// The caller owns and verifies semantic ranges. This separate API only admits
// ordinary prose gaps after checking the complete frozen target against the
// renderer's parsed edits. JSON/model output cannot mint the private authority.
export function prepareFrozenProseRecord(root: HTMLElement, slots: SourceTextSlot[], html: string, witness: FrozenProseWitness): FixedTextRecord {
  if (!witness.target.trim()) throw new Error("Translation frozen prose target is empty");
  const authorized = slots.map(slot => ({...slot}));
  authorized.forEach(slot => {if (slot.writePolicy === "frozen-prose-gap") frozenSourceAuthority.add(slot);});
  const record = prepareFixedTextRecord(root, authorized, html);
  if (witness.readProjected(new Map(record.edits.map(edit => [edit.node, edit.translated]))) !== witness.target) {
    throw new Error("Translation frozen prose target witness failed");
  }
  frozenRecordAuthority.set(record, Object.freeze({target: witness.target, readProjected: witness.readProjected})); return record;
}

export function fixedTextRecordUnchanged(record: FixedTextRecord): boolean {
  if (!record.root.isConnected) return false;
  const nodes = sourceNodes(record.root);
  const translated = new Map(record.edits.map(edit => [edit.node as Node, edit.translated]));
  return nodes.length === record.snapshot.length && record.snapshot.every((item, index) =>
    nodes[index] === item.node && (item.text === null || item.node.textContent ===
      (record.mode === "translation" ? translated.get(item.node) ?? item.text : item.text)))
    && record.edits.every(edit => edit.node.parentNode === edit.parent);
}

export function clearFixedTextRecord(record: FixedTextRecord): void {
  record.translationNode?.remove(); record.translationNode = null;
  for (const edit of record.edits) {
    // Ownership follows the original Text object when a website reparents it.
    // Restore only our exact translation; a later website text edit still wins.
    if (record.mode === "translation" && edit.node.data === edit.translated) edit.node.data = edit.source;
  }
  record.mode = "bilingual";
}

const BILINGUAL_STRIP_TAGS = new Set([
  "UL", "OL", "DL", "TABLE", "SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE",
  "BUTTON", "INPUT", "SELECT", "TEXTAREA", "IFRAME", "OBJECT", "EMBED",
  "SVG", "CANVAS", "VIDEO", "AUDIO", "RELATIVE-TIME", "TIME-AGO", "LOCAL-TIME",
]);

function isExcludedBilingualChild(
  source: Element,
  root: HTMLElement,
  hiddenElements: ReadonlySet<Element> | undefined,
  visibilityCache: WeakMap<Element, boolean> | undefined,
): boolean {
  if (BILINGUAL_STRIP_TAGS.has(source.tagName.toUpperCase())) return true;
  if (
    source.hasAttribute("data-flt-generated") ||
    source.hasAttribute("hidden") ||
    source.getAttribute("aria-hidden") === "true" ||
    isHiddenInsideClosedDetails(source) ||
    isNestedOwnerBoundary(source, root)
  ) {
    return true;
  }
  if (source.hasAttribute("contenteditable") && source.getAttribute("contenteditable") !== "false") {
    return true;
  }
  if (hiddenElements) return hiddenElements.has(source);
  return isElementEffectivelyHidden(source, visibilityCache, root);
}

function stripUnsafeCloneAttributes(element: Element): void {
  for (const attr of Array.from(element.attributes)) {
    if (attr.name === "id" || attr.name.toLowerCase().startsWith("on")) element.removeAttribute(attr.name);
  }
  for (const child of Array.from(element.children)) stripUnsafeCloneAttributes(child);
}

function bilingualFragment(root: HTMLElement, record: FixedTextRecord): DocumentFragment {
  const clone = root.cloneNode(true) as HTMLElement;
  const translated = new Map(record.edits.map(edit => [edit.node, edit.translated]));
  const visibilityCache = record.hiddenElements ? undefined : new WeakMap<Element, boolean>([[root, false]]);
  const removed: Element[] = [];
  const walk = (source: Node, target: Node) => {
    if (source.nodeType === Node.TEXT_NODE && translated.has(source as Text)) target.textContent = translated.get(source as Text)!;
    if (target.nodeType === Node.ELEMENT_NODE) {
      const element = target as HTMLElement;
      if (source !== root && isExcludedBilingualChild(source as Element, root, record.hiddenElements, visibilityCache)) {
        removed.push(element); return;
      }
      if (element.tagName.toUpperCase() === "MATH") {
        stripUnsafeCloneAttributes(element);
        return;
      }
      // Clone application-owned markup, never model markup. Avoid duplicate IDs and handlers.
      for (const attr of Array.from(element.attributes)) {
        if (attr.name === "id" || attr.name.toLowerCase().startsWith("on")) element.removeAttribute(attr.name);
      }
      if (element.tagName === "A") {
        element.addEventListener("click", event => {
          if (event.button || event.ctrlKey || event.shiftKey || event.altKey || event.metaKey || !source.isConnected) return;
          event.preventDefault(); event.stopImmediatePropagation(); (source as HTMLElement).click();
        }, true);
      }
    }
    const children = Array.from(source.childNodes);
    children.forEach((child, index) => walk(child, target.childNodes[index]!));
  };
  walk(root, clone);
  for (const element of removed) element.remove();
  const fragment = root.ownerDocument.createDocumentFragment();
  if (root.tagName === "A") fragment.append(clone);
  else fragment.append(...Array.from(clone.childNodes));
  return fragment;
}

export function needsCapturedSourceLayout(
  root: HTMLElement,
  record: FixedTextRecord,
  mode: "translation" | "bilingual",
): boolean {
  if (mode !== "bilingual") return false;
  if (record.edits.every(edit => edit.translated.trim() === edit.source.trim())) return false;
  return !isTranslationControl(root);
}

export function validateFixedTextRecord(root: HTMLElement, record: FixedTextRecord): boolean {
  if (!fixedTextRecordUnchanged(record)) return false;
  if (record.edits.some(edit => isTranslationDisabled(edit.node.parentElement))) return false;
  const spacing = spacingAuthority.get(record);
  if (spacing && (spacing.nodes.some(node => !cjkSpacingContextUnchanged(node))
    || spacing.boundaries.some(([left, right]) => !cjkSpacingBoundaryUnchanged(left, right, root)))) return false;
  if (record.edits.some(edit => edit.writePolicy === "collapsible-whitespace"
    && !canCollapseProseWhitespace(edit.node) || edit.writePolicy === "frozen-prose-gap"
    && !canWriteFrozenProseGap(edit.node, edit.source))) return false;
  const witness = frozenRecordAuthority.get(record);
  if (record.edits.some(edit => edit.writePolicy === "frozen-prose-gap") && !witness) return false;
  if (witness && witness.readProjected(new Map(record.edits.map(edit => [edit.node, edit.translated]))) !== witness.target) return false;
  return true;
}

export function applyFixedTextRecord(
  root: HTMLElement,
  record: FixedTextRecord,
  mode: "translation" | "bilingual",
  language: string,
  bilingualOrder: "source-top" | "translation-top" = "source-top",
  capturedLayout?: CapturedSourceLayout,
  prevalidated?: boolean,
): boolean {
  const valid = prevalidated !== undefined ? prevalidated : validateFixedTextRecord(root, record);
  clearFixedTextRecord(record);
  if (!valid) return false;
  if (mode === "translation") {
    // Validate the entire paragraph before the first write; only existing Text.data changes.
    for (const edit of record.edits) edit.node.data = edit.translated;
  } else if (record.edits.every(edit => edit.translated.trim() === edit.source.trim())) {
    // Never inject a duplicate bilingual copy (e.g. a brand/logo inside a flex header)
    // when the translation is identical to the source text.
    record.mode = mode;
    return true;
  } else if (isTranslationControl(root)) {
    // Keep the original control clickable and anchor the bilingual label directly
    // beside the text slot so leading/trailing <svg> icons stay in place.
    const node = root.ownerDocument.createElement("span");
    node.className = "flt-translation";
    node.dataset.fltGenerated = "translation";
    node.dataset.fltControl = "true";
    if (bilingualOrder === "translation-top") node.dataset.fltOrder = "translation-top";
    node.lang = language;
    node.setAttribute("aria-hidden", "true");
    node.style.setProperty("display", "block", "important");
    node.style.setProperty("margin", "0", "important");
    node.textContent = record.edits.map(edit => edit.translated.trim()).filter(Boolean).join(" ");
    const parent = record.edits[0]?.node.parentElement;
    const host = parent && record.edits.every(edit => parent.contains(edit.node)) ? parent : root;
    const directChildAnchor = (target: Node | undefined): ChildNode | null => {
      let cursor: Node | null = target ?? null;
      while (cursor && cursor.parentNode !== host) cursor = cursor.parentNode;
      return cursor && cursor.parentNode === host ? (cursor as ChildNode) : null;
    };
    if (bilingualOrder === "translation-top") {
      const firstAnchor = directChildAnchor(record.edits[0]?.node);
      if (firstAnchor) host.insertBefore(node, firstAnchor);
      else host.prepend(node);
    } else {
      const lastAnchor = directChildAnchor(record.edits.at(-1)?.node);
      if (lastAnchor) host.insertBefore(node, lastAnchor.nextSibling);
      else host.append(node);
    }
    record.translationNode = node;
  } else {
    record.translationNode = mountTranslation(root, bilingualFragment(root, record), language, true, bilingualOrder, capturedLayout);
  }
  record.mode = mode;
  return true;
}
