// Evaluation only: no production module imports these experimental prompts.
import type {TranslationRequest} from "../../src/core/provider";
import {fixedMtPrompt} from "../../src/providers/pagelingo-mt/fixed-text";
import {MT_CONTEXT_TOKENS} from "../../src/providers/pagelingo-mt/sentence-plan";
import {prepareSemanticRewrite} from "./semantic-rewrite";

export type CompactContextVariant = "baseline" | "code-map" | "scope-map" | "native-scope-map";
export interface OriginalOpaqueCode {tagName: string; text: string}
const codeTags = new Set(["CODE", "KBD", "SAMP", "VAR"]);
const protectedTags = new Set([...codeTags, "BR", "WBR"]);
const linkBoundary = /^__FLT_LINK_(?:START|END)_\d+__$/u;
// Short identifiers/expressions only; whole snippets and prose retain baseline.
const codeName = /^[A-Za-z0-9_$.'"()[\]{}<>][A-Za-z0-9_$.:()[\]{}<>|&,*?=+'"/!-]*$/u;

export function prepareCompactContext(request: TranslationRequest, opaque: readonly OriginalOpaqueCode[] = []) {
  const semantic = prepareSemanticRewrite(request, opaque);
  const baseline = fixedMtPrompt(semantic.fixed, request);
  const texts = new Set(semantic.fixed.texts.map(slot => slot.node));
  const nodes: Node[] = [];
  const walk = (node: Node) => {
    if (texts.has(node as Text)) return;
    if (node.nodeType === Node.TEXT_NODE) { if (node.textContent) nodes.push(node); return; }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as Element;
    if (protectedTags.has(el.tagName) || el.hasAttribute("data-flt-term-id") || el.hasAttribute("data-flt-fixed")) {
      if (!(protectedTags.has(el.tagName) && linkBoundary.test((el.textContent ?? "").trim()))) nodes.push(el);
      return;
    }
    for (const child of Array.from(node.childNodes)) walk(child);
  };
  for (const child of Array.from(semantic.fixed.body.childNodes)) walk(child);
  if (nodes.length !== semantic.protectedContext.length) throw new Error("Readonly code traversal mismatch");
  const codes: Record<string, string> = {};
  for (const [i, node] of nodes.entries()) {
    const part = semantic.protectedContext[i]!;
    const index = (node.textContent ?? "").match(/^__FLT_OPAQUE_(\d+)__$/u);
    const kind = index ? opaque[Number(index[1])]!.tagName : node.nodeType === Node.ELEMENT_NODE ? (node as Element).tagName : "literal";
    if (codeTags.has(kind.toUpperCase()) && /[\p{L}\p{N}]/u.test(part.text)) codes[part.token] = part.text;
  }
  const formatted = semantic.textRoles.filter(slot => slot.roles.some(role => role !== "plain")).map(slot => slot.id);
  const map = JSON.stringify(codes), ids = JSON.stringify(formatted);
  const terms = (request.terminology ?? []).filter(entry => entry.source.trim() && entry.target.trim()
    && entry.source.length <= 96 && entry.target.length <= 96).slice(0, 16)
    .map(entry => `${entry.source} translates to ${entry.target}`);
  const prefix = (request.context ? `Domain: ${{http: "HTTP protocol documentation", javascript: "JavaScript programming", sql: "SQL transactions", python: "Python programming"}[request.context]}.\n` : "")
    + (terms.length ? `Reference the following translations:\n${terms.join("\n")}\n\n` : "");
  const source = semantic.fixed.source;
  const englishMap = `Read-only code names (JSON, for understanding only; do not output this table):\n${map}\n`;
  const suffix = `English:\n${source}\nChinese:`;
  if (!baseline.endsWith(suffix)) throw new Error("Unexpected baseline fixed prompt suffix");
  const mapOnly = baseline.slice(0, -suffix.length) + englishMap + suffix;
  const scopeMap = prefix + `Translate the following English into Simplified Chinese.
Rules:
1. Keep every numbered pair and every protected token exactly once in the original order and position. Output all translated text inside the original pairs. The application restores the protected code unchanged.
2. Fixed-meaning text-slot IDs are ${ids}. Keep their original link, emphasis or formatting meaning within their own scope. Other slots are unformatted prose: paraphrase and redistribute that prose across the ordinary slots for natural Chinese word order.
3. Preserve every action, participant, reference, negation and condition. Use names or pronouns when needed to make references clear. Output only the marked translation, without HTML, labels or this context table.
${englishMap}English:
${source}
Chinese:`;
  const native = prefix + `将以下英文译为简体中文，只输出带标记的译文。
1. 所有编号对和受保护标记按原顺序各保留一次，位置不变；译文只放在原编号对内。受保护代码由程序原样还原。
2. 固定译义槽编号为 ${ids}，这些链接、强调或格式范围只承载自己的原意。其他普通槽可等义改写并调整普通文字的分布，以适应中文语序。
3. 保留全部动作、对象、指代、否定和条件；需要时可用名称或代词明确指代。不输出 HTML、标签、说明或对照表。
代码名对照（JSON，只读上下文，不输出此表）：
${map}
英文：
${source}
译文：`;
  const attempted: Record<CompactContextVariant, string> = {baseline, "code-map": mapOnly, "scope-map": scopeMap, "native-scope-map": native};
  const bytes = (s: string) => new TextEncoder().encode(s).length;
  let reason: string | null = null;
  const values = Object.values(codes);
  if (new Set(values).size < 2) reason = "fewer_than_two_distinct_code_names";
  else if (values.length > 16 || values.some(v => bytes(v) > 96) || bytes(map) > 512) reason = "readonly_code_budget_exceeded";
  else if (values.some(v => !codeName.test(v) || /__FLT_|[⟦⟧⟪⟫⟨⟩]/u.test(v))) reason = "non_identifier_or_transport_literal";
  else if (Object.values(attempted).some(prompt => bytes(prompt) + semantic.maxTokens + 8 > MT_CONTEXT_TOKENS)) reason = "conservative_context_budget_exceeded";
  const eligible = reason === null;
  const prompts = eligible ? attempted : Object.fromEntries(Object.keys(attempted).map(key => [key, baseline])) as Record<CompactContextVariant, string>;
  return {semantic, codes, formatted, eligible, reason, prompts, attempted};
}
