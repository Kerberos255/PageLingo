import { normalizeDetectedLanguage } from "./settings";

export interface ScriptCounts {
  chars: number;
  letters: number;
  han: number;
  kana: number;
  hangul: number;
  latin: number;
  cyrillic: number;
  arabic: number;
  thai: number;
}

export function analyzeScriptCounts(value: string): ScriptCounts {
  const compact = String(value || "").replace(/\s+/g, "");
  let chars = 0;
  let letters = 0;
  let han = 0;
  let kana = 0;
  let hangul = 0;
  let latin = 0;
  let cyrillic = 0;
  let arabic = 0;
  let thai = 0;

  for (const ch of compact) {
    chars += 1;
    if (/\p{L}/u.test(ch)) letters += 1;
    if (/\p{Script=Han}/u.test(ch)) han += 1;
    else if (/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(ch)) kana += 1;
    else if (/\p{Script=Hangul}/u.test(ch)) hangul += 1;
    else if (/\p{Script=Latin}/u.test(ch)) latin += 1;
    else if (/\p{Script=Cyrillic}/u.test(ch)) cyrillic += 1;
    else if (/\p{Script=Arabic}/u.test(ch)) arabic += 1;
    else if (/\p{Script=Thai}/u.test(ch)) thai += 1;
  }

  return { chars, letters, han, kana, hangul, latin, cyrillic, arabic, thai };
}

export function isChineseTarget(targetLanguage: string): boolean {
  const normalized = normalizeDetectedLanguage(targetLanguage);
  return normalized === "zh-Hans" || normalized === "zh-Hant";
}

/**
 * Returns true when a text fragment is already predominantly in `targetLanguage`
 * based on script signals (used to avoid re-translating native UI labels on mixed-language pages
 * like Chinese webmail containing English emails).
 */
export function fragmentAlreadyInTargetScript(text: string, targetLanguage: string): boolean {
  const normalizedTarget = normalizeDetectedLanguage(targetLanguage) ?? targetLanguage;
  const stats = analyzeScriptCounts(text);
  if (stats.letters === 0) return true;

  if (isChineseTarget(normalizedTarget)) {
    // Reject Japanese text containing kana even if it has kanji.
    if (stats.kana > Math.max(1, stats.han * 0.18)) return false;
    // Short pure Chinese labels like "删除", "回复", "收件箱" (1-2 Han chars, no meaningful non-Han letters).
    if (stats.han >= 1 && stats.kana === 0 && stats.letters - stats.han <= 2 && stats.han / stats.letters >= 0.5) {
      return true;
    }
    if (stats.han >= 3 && stats.han / stats.letters >= 0.42) return true;
    // Short bilingual titles/labels that already provide an explicit Chinese side
    // (such as "PROJECT: DRYWELL / 焦土泵站" or "Settings | 设置").
    if (
      stats.han >= 2 &&
      stats.kana === 0 &&
      stats.letters <= 48 &&
      /(?:[\/|｜]|(?:\s[-–—·]\s))/.test(text) &&
      /\p{Script=Han}{2,}/u.test(text)
    ) {
      return true;
    }
    return false;
  }

  if (normalizedTarget === "ja") {
    return stats.kana >= 2 && (stats.kana + stats.han) / stats.letters >= 0.6;
  }
  if (normalizedTarget === "ko") {
    return stats.hangul >= 2 && stats.hangul / stats.letters >= 0.55;
  }
  if (normalizedTarget === "ru" || normalizedTarget === "uk" || normalizedTarget === "bg" || normalizedTarget === "be") {
    return stats.cyrillic >= 3 && stats.cyrillic / stats.letters >= 0.65;
  }
  if (normalizedTarget === "ar" || normalizedTarget === "fa") {
    return stats.arabic >= 3 && stats.arabic / stats.letters >= 0.65;
  }
  if (normalizedTarget === "th") {
    return stats.thai >= 3 && stats.thai / stats.letters >= 0.65;
  }
  return false;
}

/**
 * Collects visible source text excluding fragments that are already written in `targetLanguage`.
 * Enables mixed-language pages (e.g. `<html lang="zh-CN">` webmail with English email content)
 * to detect the dominant foreign language accurately.
 */
export function extractForeignTextSample(
  root: Document | Element,
  targetLanguage: string,
  maxChars = 4096,
): string {
  const scope = root instanceof Document ? (root.body ?? root.documentElement) : root;
  if (!scope) return "";
  const doc = scope.ownerDocument ?? (root instanceof Document ? root : document);
  const view = doc.defaultView;
  const pieces: string[] = [];
  let length = 0;

  const walker = doc.createTreeWalker(scope, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      if (parent.closest('[data-flt-generated], script, style, noscript, template, code, pre, textarea, input, select, svg')) {
        return NodeFilter.FILTER_REJECT;
      }
      if (parent.hidden || parent.getAttribute("aria-hidden") === "true") {
        return NodeFilter.FILTER_REJECT;
      }
      if (view) {
        const style = view.getComputedStyle(parent);
        if (style.display === "none" || style.visibility === "hidden") {
          return NodeFilter.FILTER_REJECT;
        }
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  let current = walker.nextNode();
  while (current && length < maxChars) {
    const value = (current.textContent ?? "").replace(/\s+/g, " ").trim();
    if (value && value.length >= 2 && !fragmentAlreadyInTargetScript(value, targetLanguage)) {
      const stats = analyzeScriptCounts(value);
      if (stats.letters >= 2) {
        pieces.push(value);
        length += value.length + 1;
      }
    }
    current = walker.nextNode();
  }

  return pieces.join(" ").replace(/\s+/g, " ").trim().slice(0, maxChars);
}

export function guessLanguageFromScript(text: string, excludeLanguage?: string | null): string | null {
  const stats = analyzeScriptCounts(text);
  if (stats.letters === 0) return null;
  const excluded = excludeLanguage ? (normalizeDetectedLanguage(excludeLanguage) ?? excludeLanguage) : null;

  const candidates: Array<{ code: string; score: number }> = [
    { code: "ja", score: stats.kana >= 2 ? stats.kana * 2 + stats.han * 0.4 : 0 },
    { code: "ko", score: stats.hangul >= 2 ? stats.hangul * 1.5 : 0 },
    { code: "zh-Hans", score: stats.han >= 2 && stats.kana === 0 ? stats.han * 1.2 : 0 },
    { code: "ru", score: stats.cyrillic >= 3 ? stats.cyrillic * 1.2 : 0 },
    { code: "ar", score: stats.arabic >= 3 ? stats.arabic * 1.2 : 0 },
    { code: "th", score: stats.thai >= 3 ? stats.thai * 1.2 : 0 },
    { code: "en", score: stats.latin >= 4 ? stats.latin : 0 },
  ];

  candidates.sort((a, b) => b.score - a.score);
  for (const item of candidates) {
    if (item.score <= 0) continue;
    if (excluded && item.code === excluded) continue;
    if (excluded && isChineseTarget(excluded) && isChineseTarget(item.code)) continue;
    return item.code;
  }
  return null;
}

export async function detectForeignLanguageFromSample(
  sample: string,
  targetLanguage: string,
): Promise<string | null> {
  const trimmed = sample.trim();
  const stats = analyzeScriptCounts(trimmed);
  if (stats.letters < 8) return null;
  const normalizedTarget = normalizeDetectedLanguage(targetLanguage) ?? targetLanguage;

  try {
    const result = await browser.i18n?.detectLanguage?.(trimmed);
    const ranked = result?.languages ?? [];
    for (const entry of ranked) {
      if (!entry?.language || entry.language === "und") continue;
      const normalized = normalizeDetectedLanguage(entry.language);
      if (!normalized || normalized === normalizedTarget) continue;
      if (isChineseTarget(normalized) && isChineseTarget(normalizedTarget)) continue;
      if ((entry.percentage ?? 0) >= 25) return normalized;
    }
  } catch {
    // Fall back to script heuristics when browser.i18n.detectLanguage is unavailable.
  }

  return guessLanguageFromScript(trimmed, normalizedTarget);
}
