import {canCollapseProseWhitespace} from "./collapsible-whitespace";

interface ProseEdit {node: Text; translated: string; writePolicy?: string}
const han = /\p{Script=Han}/u;
const leftTrim = (s: string) => s.replace(/^[ \t\r\n\f]+/u, "");
const rightTrim = (s: string) => s.replace(/[ \t\r\n\f]+$/u, "");
const closes = /^[，。；：！？、）》」』】]/u;
const opens = /[（《「『【]$/u;
const latinEnd = /[A-Za-z][A-Za-z0-9._+-]*(?: +[0-9]+)?$/u;

/** Empty atoms and line/block boundaries may carry layout without Text nodes. */
export function cjkSpacingBoundaryUnchanged(left: Text, right: Text, root: HTMLElement): boolean {
  const inline = (element: Element) => ["inline", "contents"].includes(
    element.ownerDocument.defaultView?.getComputedStyle(element).display || "inline");
  let cursor: Node = left;
  while (!cursor.nextSibling) {
    const parent = cursor.parentElement;
    if (!parent || parent === root || !inline(parent)) return false;
    cursor = parent;
  }
  cursor = cursor.nextSibling;
  while (cursor !== right) {
    if (cursor.nodeType !== Node.ELEMENT_NODE || !(cursor as Element).contains(right)
      || !inline(cursor as Element) || !cursor.firstChild) return false;
    cursor = cursor.firstChild;
  }
  return true;
}

export function cjkSpacingContextUnchanged(node: Text): boolean {
  if (!canCollapseProseWhitespace(node)) return false;
  for (let element = node.parentElement; element; element = element.parentElement) {
    const style = element.ownerDocument.defaultView?.getComputedStyle(element);
    if (!style || !["normal", "nowrap"].includes(style.whiteSpace || "normal")
      || style.whiteSpaceCollapse && style.whiteSpaceCollapse !== "collapse") return false;
  }
  return true;
}

/** Adjust whitespace only in validated, original prose Text slots.
 * Fixed gaps, NBSP, code and preformatted contexts remain source-owned.
 */
export function normalizeCjkSpacing(root: HTMLElement, edits: ProseEdit[], language: string): readonly (readonly [Text, Text])[] {
  const boundaries: [Text, Text][] = [];
  if (!/^zh(?:-|$)/iu.test(language) || !edits.some(e => han.test(e.translated))) return boundaries;
  const css = new Map<Element, boolean>();
  const allowsSpacing = (element: Element | null): boolean => {
    if (!element) return true;
    if (css.has(element)) return css.get(element)!;
    const style = element.ownerDocument.defaultView?.getComputedStyle(element);
    const allowed = Boolean(style && ["normal", "nowrap"].includes(style.whiteSpace || "normal")
      && (!style.whiteSpaceCollapse || style.whiteSpaceCollapse === "collapse")
      && allowsSpacing(element.parentElement));
    css.set(element, allowed); return allowed;
  };
  const eligible = new Map<Text, ProseEdit>();
  for (const edit of edits) {
    if (edit.writePolicy || !canCollapseProseWhitespace(edit.node) || !allowsSpacing(edit.node.parentElement)) continue;
    edit.translated = edit.translated
      .replace(/[ \t\r\n\f]+(?=[，。；：！？、）》」』】])/gu, "")
      .replace(/([（《「『【])[ \t\r\n\f]+/gu, "$1");
    eligible.set(edit.node, edit);
  }
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = []; let node: Node | null;
  while ((node = walker.nextNode())) nodes.push(node as Text);
  for (let i = 1; i < nodes.length; i++) {
    const left = eligible.get(nodes[i - 1]!), right = eligible.get(nodes[i]!);
    if (!left || !right || !cjkSpacingBoundaryUnchanged(left.node, right.node, root)) continue;
    const beforeLeft = left.translated, beforeRight = right.translated;
    const a = rightTrim(left.translated), b = leftTrim(right.translated);
    const last = [...a].at(-1) ?? "", first = [...b][0] ?? "";
    if (!last || !first) continue;
    if (han.test(last) && han.test(first) || opens.test(a) || closes.test(b)) {
      left.translated = a; right.translated = b;
    } else if (han.test(last) && /^[A-Za-z]/u.test(b) || latinEnd.test(a) && han.test(first)) {
      // Keep padding outside a link when an ordinary prose carrier exists.
      const leftLink = left.node.parentElement?.closest("a"), rightLink = right.node.parentElement?.closest("a");
      if (leftLink && rightLink && leftLink !== rightLink) continue;
      left.translated = a; right.translated = b;
      if (leftLink && !rightLink) right.translated = " " + b;
      else left.translated = a + " ";
    }
    if (left.translated !== beforeLeft || right.translated !== beforeRight) boundaries.push([left.node, right.node]);
  }
  return boundaries;
}
