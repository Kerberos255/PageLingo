// A narrow writing contract for standalone prose punctuation, never code text.
// Empty/whitespace, digits, operators, quotes and NBSP are deliberately excluded.
export interface ProsePunctuation {symbol: string; alternatives: string[]; terminal: boolean}
const alternatives: Record<string, string[]> = {
  ".": [".", "。"], ",": [",", "，", "、"], ":": [":", "："],
  ";": [";", "；"], "!": ["!", "！"], "?": ["?", "？"]
};
export function classifyProsePunctuation(text: string, before: string, after: string): ProsePunctuation | null {
  const match = /^([ \t]*)([.,:;!?])([ \t]*)$/u.exec(text);
  if (!match || !before || !/\p{L}/u.test(before)) return null;
  // Do not reinterpret dotted names, versions, URL schemes or compact syntax.
  if (after && !match[3] && !/^[ \t\r\n]/u.test(after)) return null;
  return {symbol: match[2]!, alternatives: alternatives[match[2]!]!, terminal: after.length === 0};
}
export function prosePunctuationPattern(role: ProsePunctuation): string {
  const escaped = role.alternatives.map(s => s.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"));
  return "[ \\t]*(?:" + escaped.join("|") + ")[ \\t]*" + (role.terminal ? "(?![\\s\\S])" : "");
}
// A source label's colon belongs inside that same format wrapper. Only an
// immediately adjacent colon may be included; no words may be added or rewritten.
export function closeLabelColon(source: string, target: string, start: number, end: number): {start: number; end: number} {
  if (!source.trimEnd().endsWith(":")) return {start, end};
  if (/[:：]$/u.test(target.slice(start, end))) return {start, end};
  if (/[:：]/u.test(target[end] ?? "")) return {start, end: end + 1};
  throw new Error("Format label colon is missing from its scope");
}
