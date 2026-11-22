// Bergamot-specific guards for protected terminology and standalone labels.
//
// Terminology protection wraps names in <span data-flt-term-id>. Marian models copy
// most Latin product names verbatim on their own, and the extra inline tags measurably
// degrade the sentence (dropped separators, glued words, worse word order). The client
// therefore translates the plain sentence first, verifies every protected name survived
// verbatim, and only re-protects the names that did not.

import { parseHtmlBody } from "../../shared/html-parser";

const TERM_SPAN = /<span data-flt-term-id="(\d+)">([^<]*)<\/span>/g;
const TERM_SPAN_TEST = /<span data-flt-term-id="\d+">[^<]*<\/span>/;

function decodeHtmlText(value: string): string {
  return value
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"")
    .replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, "\u00a0").replace(/&amp;/g, "&");
}

function htmlPlainText(html: string): string {
  return parseHtmlBody(html).textContent ?? "";
}

function countVerbatim(text: string, term: string): number {
  if (!term) return 0;
  const wordLike = /^[A-Za-z0-9_.-]+$/.test(term);
  let count = 0;
  for (let at = text.indexOf(term); at >= 0; at = text.indexOf(term, at + term.length)) {
    if (wordLike) {
      const before = at > 0 ? text[at - 1]! : "";
      const after = text[at + term.length] ?? "";
      if (/[A-Za-z0-9_]/.test(before) || /[A-Za-z0-9_]/.test(after)) continue;
    }
    count += 1;
  }
  return count;
}

export interface TermGuardPlan {
  /** Source HTML with every protection span unwrapped. */
  unprotected: string;
  /** Protected term -> verbatim occurrences expected in the translated text. */
  expected: Map<string, number>;
}

export function planTermGuard(html: string): TermGuardPlan | null {
  if (!TERM_SPAN_TEST.test(html)) return null;
  const terms = new Set<string>();
  const unprotected = html.replace(TERM_SPAN, (_full, _id, inner: string) => {
    terms.add(decodeHtmlText(inner));
    return inner;
  });
  const sourceText = htmlPlainText(unprotected);
  const expected = new Map<string, number>();
  for (const term of terms) expected.set(term, countVerbatim(sourceText, term));
  return { unprotected, expected };
}

/** Terms whose verbatim occurrence count changed in the translated output. */
export function damagedTerms(plan: TermGuardPlan, translatedHtml: string, ignore: ReadonlySet<string> = new Set()): Set<string> {
  const text = htmlPlainText(translatedHtml);
  const damaged = new Set<string>();
  for (const [term, count] of plan.expected) {
    if (!ignore.has(term) && countVerbatim(text, term) !== count) damaged.add(term);
  }
  return damaged;
}

/** Keep protection spans only around the given terms. */
export function protectOnly(html: string, terms: ReadonlySet<string>): string {
  return html.replace(TERM_SPAN, (full, _id, inner: string) => terms.has(decodeHtmlText(inner)) ? full : inner);
}

/** True when the segment carries no translatable words besides protected names. */
export function onlyProtectedTerms(html: string): boolean {
  if (!TERM_SPAN_TEST.test(html)) return false;
  const rest = htmlPlainText(html.replace(TERM_SPAN, "")).replace(/__FLT_LINK_(?:START|END)_\d+__/g, "");
  return /^[\s\p{P}\p{S}\p{N}]*$/u.test(rest);
}

// A lone CamelCase / lowerCamel token (PageLingo, OpenRouter, iPhone, macOS) is a name.
// Marian transliterates such tokens when they arrive without sentence context.
const CAMEL_NAME = /^(?:[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]*)+|[a-z]+[A-Z][A-Za-z0-9]*)$/;

// Standalone button/menu labels that the en->zh Marian models reproducibly mistranslate
// into an inverted or nonsensical output without sentence context (e.g. "Neither" -> "两者都").
// Strictly excludes polysemous words whose model translation is valid in another domain.
const STANDALONE_LABELS: Record<string, Record<string, string>> = {
  "zh-Hans": {
    "neither": "两者都不",
    "nevermind": "算了",
    "never mind": "算了",
    "masculine": "男性化",
    "androgynous": "中性",
    "hermaphrodite": "雌雄同体",
  },
  "zh-Hant": {
    "neither": "兩者都不",
    "nevermind": "算了",
    "never mind": "算了",
    "masculine": "男性化",
    "androgynous": "中性",
    "hermaphrodite": "雌雄同體",
  },
};

const SINGLE_SLOT = /^((?:\s*<(?:span|b|strong|i|em|u|small|mark)\b[^>]*>)*\s*)([^<>]+)(\s*(?:<\/(?:span|b|strong|i|em|u|small|mark)>\s*)*)$/;

/**
 * Deterministic result for segments that must not reach the model, or undefined.
 * Covers lone names (returned unchanged) and known-bad standalone labels.
 */
export function directBergamotResult(html: string, sourceLanguage: string, targetLanguage: string): string | undefined {
  if (onlyProtectedTerms(html)) return html;
  const slot = html.match(SINGLE_SLOT);
  if (!slot) return undefined;
  const prefix = slot[1]!;
  const body = slot[2]!;
  const suffix = slot[3]!;
  const text = decodeHtmlText(body).trim();
  if (!text) return undefined;
  if (CAMEL_NAME.test(text)) return html;
  if (sourceLanguage !== "en") return undefined;
  const label = STANDALONE_LABELS[targetLanguage]?.[text.toLowerCase().replace(/\s+/g, " ")];
  if (!label) return undefined;
  const lead = body.match(/^\s*/)![0];
  const trail = body.match(/\s*$/)![0];
  return `${prefix}${lead}${label}${trail}${suffix}`;
}
