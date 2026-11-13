import { mountTranslation } from "./render";
import { isOptionalEnglishArticle } from "./translation-quality";
import { isElementEffectivelyHidden, isTranslationRootElement, isTranslationDisabled } from "./dom-policy";
import {canCollapseProseWhitespace, canWriteFrozenProseGap, isAsciiWhitespace, isAsciiWhitespaceOrEmpty} from "./collapsible-whitespace";
import {cjkSpacingBoundaryUnchanged, cjkSpacingContextUnchanged, normalizeCjkSpacing} from "./cjk-spacing";

export interface SourceTextSlot { id: number; node: Text; parent: Node; source: string; writePolicy?: "collapsible-whitespace" | "frozen-prose-gap" }
interface TextEdit extends SourceTextSlot { translated: string }
export interface FixedTextRecord {
  root: HTMLElement;
  edits: TextEdit[];
  snapshot: Array<{node: Node; text: string | null}>;
  mode: "translation" | "bilingual";
  translationNode: HTMLElement | null;
}
export interface FrozenProseWitness {target: string; readProjected: (edits: ReadonlyMap<Text, string>) => string}
const frozenSourceAuthority = new WeakSet<SourceTextSlot>();
const frozenRecordAuthority = new WeakMap<FixedTextRecord, FrozenProseWitness>();
const spacingAuthority = new WeakMap<FixedTextRecord, {nodes: readonly Text[]; boundaries: readonly (readonly [Text, Text])[]}>();

function sourceNodes(root: HTMLElement): Node[] {
  const nodes: Node[] = [];
  const walk = (node: Node) => {
    if (node.nodeType === Node.ELEMENT_NODE && (node as Element).hasAttribute("data-flt-generated")) return;
    if (node !== root && node.nodeType === Node.ELEMENT_NODE && isTranslationRootElement(node)) return;
    nodes.push(node);
    for (const child of Array.from(node.childNodes)) walk(child);
  };
  walk(root);
  return nodes;
}

export function prepareFixedTextRecord(root: HTMLElement, slots: SourceTextSlot[], html: string, language = ""): FixedTextRecord {
  const body = new DOMParser().parseFromString(html, "text/html").body;
  const targets = Array.from(body.querySelectorAll("[data-flt-text-id]"));
  if (targets.length !== slots.length) throw new Error("MT text-node mapping count mismatch");
  const edits: TextEdit[] = [];
  for (const slot of slots) {
    const target = targets[slot.id];
    if (!target || target.tagName !== "SPAN" || target.getAttribute("data-flt-text-id") !== String(slot.id)
        || target.childElementCount || !slot.node.isConnected || !root.contains(slot.node)
        || slot.node.parentNode !== slot.parent || slot.node.data !== slot.source) {
      throw new Error("MT text-node mapping changed; original paragraph retained");
    }
    const translated = target.textContent ?? "";
    if (slot.writePolicy === "frozen-prose-gap") {
      if (!frozenSourceAuthority.has(slot) || !canWriteFrozenProseGap(slot.node, slot.source)) {
        throw new Error("MT frozen prose gap requires verified application authority");
      }
    } else if (slot.writePolicy === "collapsible-whitespace") {
      if (!isAsciiWhitespace(slot.source) || !isAsciiWhitespaceOrEmpty(translated) || !canCollapseProseWhitespace(slot.node)) {
        throw new Error("MT collapsible whitespace ownership changed");
      }
    } else if (!translated.trim() && !isOptionalEnglishArticle(slot.source)) throw new Error("MT empty text-node translation");
    edits.push({...slot, translated});
  }
  const snapshot = sourceNodes(root).map(node => ({node, text: node.nodeType === Node.TEXT_NODE ? node.textContent : null}));
  const originalTranslations = edits.map(edit => edit.translated);
  const boundaries = normalizeCjkSpacing(root, edits, language);
  const record: FixedTextRecord = {root, edits, snapshot, mode: "bilingual", translationNode: null};
  const spacingNodes = edits.filter((edit, i) => edit.translated !== originalTranslations[i]).map(edit => edit.node);
  if (spacingNodes.length) spacingAuthority.set(record, {nodes: spacingNodes, boundaries});
  return record;
}

// The caller owns and verifies semantic ranges. This separate API only admits
// ordinary prose gaps after checking the complete frozen target against the
// renderer's parsed edits. JSON/model output cannot mint the private authority.
export function prepareFrozenProseRecord(root: HTMLElement, slots: SourceTextSlot[], html: string, witness: FrozenProseWitness): FixedTextRecord {
  if (!witness.target.trim()) throw new Error("MT frozen prose target is empty");
  const authorized = slots.map(slot => ({...slot}));
  authorized.forEach(slot => {if (slot.writePolicy === "frozen-prose-gap") frozenSourceAuthority.add(slot);});
  const record = prepareFixedTextRecord(root, authorized, html);
  if (witness.readProjected(new Map(record.edits.map(edit => [edit.node, edit.translated]))) !== witness.target) {
    throw new Error("MT frozen prose target witness failed");
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

function bilingualFragment(root: HTMLElement, record: FixedTextRecord): DocumentFragment {
  const clone = root.cloneNode(true) as HTMLElement;
  const translated = new Map(record.edits.map(edit => [edit.node, edit.translated]));
  const removed: Element[] = [];
  const walk = (source: Node, target: Node) => {
    if (source.nodeType === Node.TEXT_NODE && translated.has(source as Text)) target.textContent = translated.get(source as Text)!;
    if (target.nodeType === Node.ELEMENT_NODE) {
      const element = target as HTMLElement;
      if (source !== root && (isTranslationRootElement(source) || (source as Element).matches("ul,ol,dl,table,script,style,noscript,template,button,input,select,textarea,iframe,object,embed,svg,math,canvas,video,audio,[data-flt-generated],[contenteditable]:not([contenteditable='false']),relative-time,time-ago,local-time")
          || isElementEffectivelyHidden(source))) {
        removed.push(element); return;
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

export function applyFixedTextRecord(root: HTMLElement, record: FixedTextRecord, mode: "translation" | "bilingual", language: string): boolean {
  const unchanged = fixedTextRecordUnchanged(record);
  clearFixedTextRecord(record);
  if (record.edits.some(edit => isTranslationDisabled(edit.node.parentElement))) return false;
  const spacing = spacingAuthority.get(record);
  if (spacing && (spacing.nodes.some(node => !cjkSpacingContextUnchanged(node))
    || spacing.boundaries.some(([left, right]) => !cjkSpacingBoundaryUnchanged(left, right, root)))) return false;
  if (!unchanged || record.edits.some(edit => edit.writePolicy === "collapsible-whitespace"
    && !canCollapseProseWhitespace(edit.node) || edit.writePolicy === "frozen-prose-gap"
    && !canWriteFrozenProseGap(edit.node, edit.source))) return false;
  const witness = frozenRecordAuthority.get(record);
  if (record.edits.some(edit => edit.writePolicy === "frozen-prose-gap") && !witness) return false;
  if (witness && witness.readProjected(new Map(record.edits.map(edit => [edit.node, edit.translated]))) !== witness.target) return false;
  if (mode === "translation") {
    // Validate the entire paragraph before the first write; only existing Text.data changes.
    for (const edit of record.edits) edit.node.data = edit.translated;
  } else {
    record.translationNode = mountTranslation(root, bilingualFragment(root, record), language, true);
  }
  record.mode = mode;
  return true;
}
