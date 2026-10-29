// Research protocol for paired natural translation and fixed-node paraphrasing.
// Not imported by the extension. The existing decoder still owns all DOM writes.
import type {TranslationRequest} from "../../src/core/provider";
import {encodeFixedMtText, fixedMtGrammar, fixedMtMaxTokens, decodeFixedMtText} from "../../src/providers/pagelingo-mt/fixed-text";
import {assessTranslationQuality} from "../../src/core/translation-quality";

const protectedTags = new Set(["CODE", "KBD", "SAMP", "VAR", "BR", "WBR"]);
const linkBoundary = /^__FLT_LINK_(?:START|END)_\d+__$/u;
const emphasisTags = new Set(["EM", "STRONG", "B", "I", "MARK", "SUB", "SUP", "S", "U", "DEL", "INS", "SMALL", "Q"]);
function roles(node: Node): string[] {
  const result = new Set<string>();
  for (let element = node.parentElement; element && element.tagName !== "BODY"; element = element.parentElement) {
    if (element.tagName === "A") result.add("link");
    else if (emphasisTags.has(element.tagName)) result.add("emphasis:" + element.tagName.toLowerCase());
    else if (element.tagName === "SPAN" && !element.hasAttribute("data-flt-text-id")) result.add("format:span");
  }
  return result.size ? [...result] : ["plain"];
}
export function prepareSemanticRewrite(request: TranslationRequest, opaque: readonly {text: string}[] = []) {
  const fixed = encodeFixedMtText(request.html);
  const texts = new Map(fixed.texts.map(slot => [slot.node, slot]));
  const protectedContext: Array<{token: string; kind: string; text: string; roles: string[]}> = [];
  let cursor = 0;
  const restore = (value: string) => value.replace(/__FLT_OPAQUE_(\d+)__/gu, (_whole, id: string) => {
    if (!opaque[Number(id)]) throw new Error("Missing original protected content for semantic context");
    return opaque[Number(id)]!.text;
  }).replace(/__FLT_LINK_(?:START|END)_\d+__/gu, "");
  const walk = (node: Node): void => {
    const text = texts.get(node as Text);
    if (text) {
      if (fixed.parts[cursor++]?.text !== text) throw new Error("Semantic text traversal mismatch");
      return;
    }
    const element = node.nodeType === Node.ELEMENT_NODE ? node as Element : null;
    if (node.nodeType === Node.TEXT_NODE || element && (protectedTags.has(element.tagName) || element.hasAttribute("data-flt-term-id") || element.hasAttribute("data-flt-fixed"))) {
      const value = node.textContent ?? "";
      if (node.nodeType === Node.TEXT_NODE && !value) return;
      if (element && protectedTags.has(element.tagName) && linkBoundary.test(value.trim())) return;
      const part = fixed.parts[cursor++];
      if (!part || part.text) throw new Error("Semantic protected traversal mismatch");
      protectedContext.push({token: part.token, kind: element?.tagName.toLowerCase() ?? "literal", text: restore(value), roles: roles(node)});
      return;
    }
    if (!element) return;
    for (const child of Array.from(node.childNodes)) walk(child);
  };
  for (const child of Array.from(fixed.body.childNodes)) walk(child);
  if (cursor !== fixed.parts.length) throw new Error("Semantic context incomplete traversal");
  return {fixed, sourceText: restore(fixed.body.textContent ?? ""), protectedContext,
    textRoles: fixed.texts.map(slot => ({id: slot.id, roles: roles(slot.node)})),
    grammar: fixedMtGrammar(fixed), maxTokens: fixedMtMaxTokens(fixed)};
}
export type SemanticRewrite = ReturnType<typeof prepareSemanticRewrite>;

export function naturalTranslationPrompt(encoded: SemanticRewrite): string {
  const codes = encoded.protectedContext.filter(part => ["code", "kbd", "samp", "var"].includes(part.kind)).map(part => part.text);
  return `Translate the following English text into Simplified Chinese. Preserve every action, participant, condition, negation and temporal relationship. Keep the protected code strings unchanged. Output only the translation, without labels, HTML, explanations or markers.\nProtected code (JSON):\n${JSON.stringify(codes)}\nEnglish:\n${encoded.sourceText}`;
}
export function semanticFixedPrompt(encoded: SemanticRewrite, draft?: string): string {
  return `把下面英文完整译成简体中文，并作等义改写以适应原有文本节点的位置。
规则：
1. 每对 ⟦n⟧...⟦/n⟧ 是原有的一个文本节点。所有编号对只出现一次，保持原顺序。每个 ⟪Pn⟫ 必须原样保留一次，并留在原来的节点之间。
2. 通读整句再改写中文。必须保留全部动作、对象、条件、否定和先后关系，不得为了放置代码或标记而省略词义。
3. 标为 link、emphasis 或 format 的槽位只能承载对应英文范围的完整译义。普通文字槽可等义改写来安排语序，但不能吞并链接或强调范围的译义。除独立英文冠词外，各文字槽不得为空。
4. 所有新文字放在原有编号对内。只输出带这些标记的译文，不输出 HTML、说明、标签、规则或上下文。
文本槽角色（JSON）：
${JSON.stringify(encoded.textRoles)}
受保护内容（JSON，仅作语义上下文，输出其 token，不要输出其内容）：
${JSON.stringify(encoded.protectedContext)}
${draft === undefined ? "" : `中文草稿（JSON，仅供参考，可能有错；以英文为准并重新安排中文，不得照抄错误）：\n${JSON.stringify(draft)}\n`}英文：
${encoded.fixed.source}
译文：`;
}
export function checkSemanticFixed(encoded: SemanticRewrite, text: string, finishReason: string) {
  if (finishReason !== "stop") throw new Error("Semantic fixed generation incomplete");
  const sourceText = encoded.fixed.body.textContent ?? "";
  const html = decodeFixedMtText(encoded.fixed, text);
  const plain = new DOMParser().parseFromString(html, "text/html").body.textContent ?? "";
  // Assessment works on the transport representation, whose opaque sentinels are
  // excluded by the production quality check. Actual code restoration is rendered
  // by PageTranslator, not parsed from a generated response.
  const quality = assessTranslationQuality({sourceText, translatedText: plain, sourceLanguage: "en", targetLanguage: "zh-Hans"});
  if (!quality.accepted) throw new Error(quality.reasons.join(", "));
  return html;
}
