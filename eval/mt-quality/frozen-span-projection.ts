// Research only. Preserve the source DOM and a frozen target; never infer text edits.
import {applyFixedTextRecord, clearFixedTextRecord, prepareFixedTextRecord, type SourceTextSlot} from "../../src/core/fixed-text-render";
import {isOptionalEnglishArticle} from "../../src/core/translation-quality";

export interface TargetSpan {id: string; start: number; end: number}
interface Snapshot {node: Node; children: Node[]; attrs: string | null; text: string | null}
export interface SourceAnnotation {
  id: string; tag: string; start: number; end: number; text: string;
  parent: string | null; immutable: boolean; node: HTMLElement;
}
export interface FrozenSource {
  root: HTMLElement; sourceText: string; annotations: SourceAnnotation[];
  slots: SourceTextSlot[]; snapshot: Snapshot[]; originalHtml: string;
  rootParent: Node | null;
}
const formatting = new Set(["A", "EM", "STRONG", "B", "I", "MARK", "SPAN", "SUB", "SUP", "SMALL", "S", "U", "DEL", "INS", "ABBR", "CITE", "Q"]);
const opaque = new Set(["CODE", "KBD", "SAMP", "VAR"]);
const attrs = (node: Node) => node.nodeType === Node.ELEMENT_NODE
  ? JSON.stringify([...((node as Element).attributes)].map(a => [a.name, a.value])) : null;
const snapshot = (root: Node): Snapshot[] => {
  const out: Snapshot[] = [];
  const walk = (node: Node) => {out.push({node, children: [...node.childNodes], attrs: attrs(node),
    text: node.nodeType === Node.TEXT_NODE || node.nodeType === Node.COMMENT_NODE ? node.textContent : null});
    for (const child of [...node.childNodes]) walk(child);};
  walk(root); return out;
};
function unchanged(source: Pick<FrozenSource, "root" | "snapshot" | "rootParent">, includeText: boolean) {
  return source.root.isConnected && source.root.parentNode === source.rootParent && source.snapshot.every(s => s.node.isConnected && attrs(s.node) === s.attrs
    && s.node.childNodes.length === s.children.length && s.children.every((c, i) => c === s.node.childNodes[i])
    && (!includeText || s.text === null || s.node.textContent === s.text));
}
export function captureFrozenSource(root: HTMLElement): FrozenSource {
  if (!root.isConnected) throw new Error("Projection source is detached");
  const annotations: SourceAnnotation[] = [], slots: SourceTextSlot[] = [];
  let offset = 0;
  const walk = (node: Node, parent: string | null) => {
    if (node.nodeType === Node.COMMENT_NODE) return;
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node as Text;
      if (text.data) slots.push({id: slots.length, node: text, parent: text.parentNode!, source: text.data});
      offset += text.data.length; return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) throw new Error("Projection unsupported source node");
    const element = node as HTMLElement;
    const immutable = opaque.has(element.tagName) || element.getAttribute("translate") === "no";
    if (element !== root && !immutable && !formatting.has(element.tagName)) throw new Error("Projection unsupported inline element: " + element.tagName);
    if (element !== root && (!element.textContent || element.hasAttribute("data-flt-generated"))) throw new Error("Projection empty or generated inline element");
    const annotation: SourceAnnotation | null = element === root ? null : {id: "s" + annotations.length, tag: element.tagName,
      start: offset, end: 0, text: element.textContent ?? "", parent, immutable, node: element};
    if (annotation) annotations.push(annotation);
    if (immutable) offset += element.textContent?.length ?? 0;
    else for (const child of [...element.childNodes]) walk(child, annotation?.id ?? null);
    if (annotation) annotation.end = offset;
  };
  walk(root, null);
  const sourceText = root.textContent ?? "";
  if (sourceText.length !== offset) throw new Error("Projection source coverage mismatch");
  return {root, sourceText, annotations, slots, snapshot: snapshot(root), originalHtml: root.outerHTML, rootParent: root.parentNode};
}
function validBoundary(text: string, index: number) {
  return Number.isSafeInteger(index) && index >= 0 && index <= text.length
    && !(index > 0 && index < text.length && /[\uD800-\uDBFF]/u.test(text[index - 1]!) && /[\uDC00-\uDFFF]/u.test(text[index]!));
}

export function compileFrozenProjection(source: FrozenSource, target: string, spans: TargetSpan[]) {
  if (!unchanged(source, true)) throw new Error("Projection source changed before compilation");
  if (!target.trim()) throw new Error("Projection empty frozen translation");
  const byId = new Map<string, TargetSpan>(), byNode = new Map<HTMLElement, SourceAnnotation>();
  for (const span of spans) {
    if (byId.has(span.id) || !source.annotations.some(a => a.id === span.id)) throw new Error("Projection duplicate or unknown annotation");
    if (!validBoundary(target, span.start) || !validBoundary(target, span.end) || span.start >= span.end) throw new Error("Projection invalid UTF-16 span");
    byId.set(span.id, {...span});
  }
  if (byId.size !== source.annotations.length) throw new Error("Projection missing annotation");
  for (const a of source.annotations) {
    byNode.set(a.node, a);
    const s = byId.get(a.id)!;
    if (a.immutable && target.slice(s.start, s.end) !== a.text) throw new Error("Projection changed immutable content");
  }
  const edits = new Map<Text, string>();
  const distribute = (nodes: Text[], value: string) => {
    if (!nodes.length) {if (value) throw new Error("Projection target text has no source node"); return;}
    if (nodes.length > 1) {
      if (nodes.map(n => n.data).join("") !== value) throw new Error("Projection ambiguous adjacent text nodes");
      for (const n of nodes) edits.set(n, n.data); return;
    }
    const node = nodes[0]!;
    if (!value.trim() && value !== node.data && !isOptionalEnglishArticle(node.data)) throw new Error("Projection would empty a nonoptional source node");
    edits.set(node, value);
  };
  const assign = (element: HTMLElement, start: number, end: number) => {
    let cursor = start, text: Text[] = [];
    for (const child of [...element.childNodes]) {
      if (child.nodeType === Node.COMMENT_NODE) continue;
      if (child.nodeType === Node.TEXT_NODE) {if ((child as Text).data) text.push(child as Text); continue;}
      const annotation = byNode.get(child as HTMLElement);
      if (!annotation) throw new Error("Projection source tree differs");
      const span = byId.get(annotation.id)!;
      if (span.start < cursor || span.end > end) throw new Error("Projection reordered, crossing or unnested inline elements");
      distribute(text, target.slice(cursor, span.start)); text = [];
      if (!annotation.immutable) assign(annotation.node, span.start, span.end);
      cursor = span.end;
    }
    distribute(text, target.slice(cursor, end));
  };
  assign(source.root, 0, target.length);
  const textOf = (node: Node): string => node.nodeType === Node.TEXT_NODE ? edits.get(node as Text) ?? node.textContent ?? ""
    : node.nodeType === Node.COMMENT_NODE ? "" : [...node.childNodes].map(textOf).join("");
  if (textOf(source.root) !== target) throw new Error("Projection altered frozen target text");
  // Only application-created transport spans. Model output is always textContent.
  const holder = source.root.ownerDocument.createElement("div"), slots: SourceTextSlot[] = [];
  for (const slot of source.slots) {
    const value = edits.get(slot.node);
    if (value === undefined || value === slot.source) continue;
    const id = slots.length, span = holder.ownerDocument.createElement("span");
    span.setAttribute("data-flt-text-id", String(id)); span.textContent = value; holder.append(span);
    slots.push({...slot, id});
  }
  const record = prepareFixedTextRecord(source.root, slots, holder.innerHTML);
  return {record, target, assignments: source.annotations.map(a => ({id: a.id, tag: a.tag, source: a.text,
    target: target.slice(byId.get(a.id)!.start, byId.get(a.id)!.end)})), apply: () => {
      if (!unchanged(source, true)) throw new Error("Projection source changed before application");
      if (!applyFixedTextRecord(source.root, record, "translation", "zh-Hans")) throw new Error("Projection renderer refused source ownership");
      if (source.root.textContent !== target || !unchanged(source, false)) throw new Error("Projection renderer invariant failed");
    }, restore: () => clearFixedTextRecord(record)};
}

export async function replayFrozenProjection(sample: {id: string; html: string; root_selector?: string}, target: string, spans: TargetSpan[]) {
  const scope = document.createElement("article"); scope.innerHTML = sample.html; document.body.append(scope);
  const roots = sample.root_selector ? [...scope.querySelectorAll(sample.root_selector)] : [...scope.children];
  if (roots.length !== 1 || !roots[0] || !["P", "LI", "TD", "TH", "H1", "H2", "DIV"].includes(roots[0].tagName)) {
    scope.remove(); throw new Error("Projection fixture needs one supported root");
  }
  let source: FrozenSource;
  try {source = captureFrozenSource(roots[0] as HTMLElement);} catch (error) {scope.remove(); throw error;}
  const before = scope.innerHTML, outer = {root: scope, snapshot: snapshot(scope), rootParent: scope.parentNode};
  const code = [...scope.querySelectorAll("code,kbd,samp,var")].map(n => [n, n.outerHTML] as const);
  const links = [...source.root.querySelectorAll("a")]; let clicks = 0;
  const listener = (e: Event) => {e.preventDefault(); clicks++;}; links.forEach(n => n.addEventListener("click", listener));
  let displayed = false, reason: string | null = null, compiled: ReturnType<typeof compileFrozenProjection> | undefined;
  try {
    try {compiled = compileFrozenProjection(source, target, spans); compiled.apply(); displayed = true;}
    catch (error) {reason = String(error);}
    links.forEach(n => n.dispatchEvent(new MouseEvent("click", {bubbles: true, cancelable: true})));
    const result = {id: sample.id, displayed, reason, translated_text: source.root.textContent,
      frozen_target_exact: displayed && source.root.textContent === target,
      original_structure_unchanged: unchanged(source, false) && unchanged(outer, false), code_unchanged: code.every(([n, html]) => n.outerHTML === html),
      surrounding_text_unchanged: outer.snapshot.every(s => s.text === null || source.root.contains(s.node) || s.node.textContent === s.text),
      original_link_listeners_preserved: clicks === links.length, rejected_source_untouched: displayed || scope.innerHTML === before,
      labels: source.annotations.filter(a => !a.immutable).map(a => ({id: a.id, tag: a.tag, source: a.text, target: a.node.textContent}))};
    compiled?.restore(); return {...result, restored_exact: scope.innerHTML === before};
  } finally {links.forEach(n => n.removeEventListener("click", listener)); scope.remove();}
}
