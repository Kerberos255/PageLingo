// A narrow writing contract for standalone prose punctuation, never code text.
// Empty/whitespace, digits, operators, quotes and NBSP are deliberately excluded.
export interface ProsePunctuation {symbol: string; alternatives: string[]; terminal: boolean; collapsibleWhitespace?: boolean}
const alternatives: Record<string, string[]> = {
  ".": [".", "。"], ",": [",", "，", "、"], ":": [":", "："],
  ";": [";", "；"], "!": ["!", "！"], "?": ["?", "？"]
};
export function classifyProsePunctuation(text: string, before: string, after: string, {collapsibleWhitespace = false} = {}): ProsePunctuation | null {
  const match = (collapsibleWhitespace ? /^([ \t\r\n\f]*)([.,:;!?])([ \t\r\n\f]*)$/u : /^([ \t]*)([.,:;!?])([ \t]*)$/u).exec(text);
  if (!match || !before || !/\p{L}/u.test(before)) return null;
  // Do not reinterpret dotted names, versions, URL schemes or compact syntax.
  if (after && !match[3] && !/^[ \t\r\n]/u.test(after)) return null;
  return {symbol: match[2]!, alternatives: alternatives[match[2]!]!, terminal: after.length === 0,
    ...(collapsibleWhitespace ? {collapsibleWhitespace: true} : {})};
}
export function prosePunctuationPattern(role: ProsePunctuation): string {
  const escaped = role.alternatives.map(s => s.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"));
  const whitespace = role.collapsibleWhitespace ? "[ \\t\\r\\n\\f]*" : "[ \\t]*";
  return whitespace + "(?:" + escaped.join("|") + ")" + whitespace + (role.terminal ? "(?![\\s\\S])" : "");
}
// A source label's colon belongs inside that same format wrapper. Only an
// immediately adjacent colon may be included; no words may be added or rewritten.
export function closeLabelColon(source: string, target: string, start: number, end: number): {start: number; end: number} {
  if (!source.trimEnd().endsWith(":")) return {start, end};
  if (/[:：]$/u.test(target.slice(start, end))) return {start, end};
  if (/[:：]/u.test(target[end] ?? "")) return {start, end: end + 1};
  throw new Error("Format label colon is missing from its scope");
}

export function closeSentencePunctuation(source: string, target: string, start: number, end: number): {start: number; end: number} {
  const text = source.trimEnd(), symbol = text.slice(-1);
  if (![".", "!", "?"].includes(symbol) || (text.match(/[A-Za-z]+(?:[-'][A-Za-z]+)*/gu)?.length ?? 0) < 2
    || /(?:[A-Za-z]\.){2,}$/u.test(text)) return {start, end};
  const marks = alternatives[symbol]!;
  if (marks.includes(target[end - 1] ?? "")) return {start, end};
  if (marks.includes(target[end] ?? "")) return {start, end: end + 1};
  throw new Error("Format sentence punctuation is missing from its scope");
}
