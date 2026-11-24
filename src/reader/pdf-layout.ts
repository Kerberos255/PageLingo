/**
 * Layout-preserving & formula-aware PDF text reconstruction.
 * Converts raw pdf.js getTextContent() positioned glyph runs into clean
 * reading-order blocks (headings, paragraphs, lists, 2D display formulas) with
 * inline math spans protected as non-translatable tokens and exact page boxes
 * for HiDPI visual formula cropping.
 */

export interface PdfRawTextItem {
  str: string;
  transform: readonly number[];
  width: number;
  height?: number;
  fontName?: string;
  hasEOL?: boolean;
}

export interface PdfFontStyleInfo {
  fontFamily?: string;
  realFontName?: string;
  ascent?: number;
  descent?: number;
}

export interface PdfPageBox {
  /** Top-left normalized coordinates in PDF viewport pixels (origin top-left). */
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PdfMathPart {
  text: string;
  script?: "sup" | "sub";
}

export interface PdfInlineSegment {
  kind: "text" | "math";
  text: string;
  parts?: PdfMathPart[];
}

export type PdfBlockKind = "heading" | "paragraph" | "list-item" | "formula";

export interface PdfLayoutBlock {
  id: string;
  pageNumber: number;
  kind: PdfBlockKind;
  headingLevel?: number;
  column: "full" | "left" | "right";
  segments: PdfInlineSegment[];
  plainText: string;
  box: PdfPageBox;
  fontSize: number;
}

interface PositionedSpan {
  text: string;
  x: number;
  y: number; // top-down coordinate
  width: number;
  height: number;
  fontSize: number;
  fontName: string;
  fontFamily: string;
  realFontName: string;
  isMathFont: boolean;
  isBoldFont: boolean;
  baselineY: number;
  scriptRole?: "normal" | "sup" | "sub";
}

interface ReconstructedLine {
  spans: PositionedSpan[];
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  baselineY: number;
  fontSize: number;
  isBold: boolean;
  column: "full" | "left" | "right";
  segments: PdfInlineSegment[];
  plainText: string;
  mathRatio: number;
  proseWordCount: number;
  isDisplayFormula: boolean;
  isMathFragment: boolean;
}

interface TwoColumnGutter {
  splitX: number;
  gutterLeft: number;
  gutterRight: number;
  gutterWidth: number;
}

// Match real mathematical & symbol fonts (explicitly excluding CMR/LMR body roman fonts).
const MATH_FONT_RE = /(?:cmmi\w*|cmmib\w*|cmsy\w*|cmbsy\w*|cmex\w*|msam\w*|msbm\w*|lasy\w*|wasy\w*|stmary\w*|eufr\w*|eufm\w*|txmi\w*|txsy\w*|txex\w*|pxmi\w*|pxsy\w*|pxex\w*|rtxmi\w*|rtxsy\w*|mtmi\w*|mtsy\w*|mathjax|stix[^,]*math|cambria\s*math|latin\s*modern\s*math|lmmath|newtxmath|libertinust1math|asana[- ]?math|xits[- ]?math|symbol|standard\s*symbols|mathematica|feyn|bbold|dsrom|rsfs|esint)/i;
const BOLD_FONT_RE = /(?:bold|black|heavy|semibold|demibold|cmbx|lmbx|cmmib|cmbsy|NimbusRomNo9L-Medi|NimbusSanL-Bold|Helvetica-Bold|Times-Bold|[-_]B\b|[-_]Medi\b)/i;
const UNICODE_MATH_RE = /[∑∏∫∬∮∂∇∞±∓×÷≤≥≠≈≡≅∝∈∉∋⊂⊃⊆⊇∪∩∧∨¬∀∃→←↔⇒⇐⇔↦√∛∠⊥∥‖∣⟨⟩⌈⌉⌊⌋−′″△□○⊕⊗⊙ℓℏℝℂℤℕℚα-ωΑ-Ωϑφϕϖϱς∼⌣\u00B2\u00B3\u00B9\u2070-\u209F\u1D2C-\u1D6A\u239B-\u23B3\u23DC-\u23DF\uF8EE-\uF8FE\u{1D400}-\u{1D7FF}]/u;
const MATRIX_GLYPH_RE = /[︸︷\u239B-\u23B3\u23DC-\u23DF]/u;
const PAGE_NUMBER_RE = /^(?:[-–—]\s*)?(?:page\s*)?\d{1,4}(?:\s*(?:of|\/)\s*\d{1,4})?(?:\s*[-–—])?$/i;
const EQUATION_TAG_RE = /\(\d+(?:\.\d+)?\)\s*$/;
const LIST_PREFIX_RE = /^(?:[•●◦▪▫▸▹–—*-]|(?:\(?\d{1,3}[.)])|(?:\([a-zA-Z]\)))\s+/;
const LATEXIT_META_RE = /(?:<\/?latexit\b|sha1_base64=|AA[A-Za-z0-9+/]{24,}={0,2})/;
const ORDINAL_SUP_RE = /^(?:st|nd|rd|th)$/i;
const MATH_FUNCTION_WORD_RE = /^(?:softmax|argmax|argmin|sigmoid|tanh|relu|exp|log|ln|sin|cos|tan|min|max|lim|sup|inf|det|dim|diag|norm|loss|mod|where|and|with|for|else|if|otherwise|Attention|LayerNorm|MultiHead|Concat|FFN|Uniform|HBM|SRAM)$/i;
const COMMON_SHORT_PROSE_WORDS = new Set([
  "a", "an", "as", "at", "be", "by", "do", "go", "he", "if", "in", "is", "it",
  "me", "my", "no", "of", "on", "or", "so", "to", "up", "us", "we",
  "all", "and", "any", "are", "but", "can", "did", "for", "get", "had", "has",
  "her", "his", "how", "its", "let", "may", "new", "not", "now", "off", "old",
  "one", "our", "out", "own", "put", "run", "saw", "say", "see", "set", "she",
  "the", "too", "two", "use", "was", "way", "who", "why", "yet", "you",
]);

function median(values: readonly number[], fallback: number): number {
  const valid = values.filter((v) => Number.isFinite(v) && v > 0).sort((a, b) => a - b);
  if (valid.length === 0) return fallback;
  return valid[Math.floor(valid.length / 2)]!;
}

/** Computes character-weighted median font size so subscript-heavy pages never underestimate body size. */
function computeBodyFontSize(spans: readonly PositionedSpan[]): number {
  const proseWeighted: Array<{ size: number; weight: number }> = [];
  const allWeighted: Array<{ size: number; weight: number }> = [];

  for (const span of spans) {
    const len = span.text.replace(/\s+/g, "").length;
    if (len === 0 || !Number.isFinite(span.fontSize) || span.fontSize <= 0) continue;
    allWeighted.push({ size: span.fontSize, weight: len });
    if (!span.isMathFont && len >= 2 && /[A-Za-z\u4e00-\u9fff]{2,}/.test(span.text)) {
      proseWeighted.push({ size: span.fontSize, weight: len });
    }
  }

  const source = proseWeighted.length >= 4 ? proseWeighted : allWeighted;
  if (source.length === 0) return 11;
  source.sort((a, b) => a.size - b.size);
  const totalWeight = source.reduce((acc, item) => acc + item.weight, 0);
  let cumulative = 0;
  for (const item of source) {
    cumulative += item.weight;
    if (cumulative >= totalWeight / 2) return item.size;
  }
  return source[source.length - 1]!.size;
}

function isMathLikeToken(span: PositionedSpan, lineBaselineY: number, lineFontSize: number): boolean {
  const trimmed = span.text.trim();
  if (!trimmed) return false;
  if (span.isMathFont) return true;
  if (UNICODE_MATH_RE.test(trimmed)) return true;

  // Subscript or superscript micro-span shifted from baseline
  const verticalShift = Math.abs(span.baselineY - lineBaselineY);
  if (
    (span.scriptRole === "sup" || span.scriptRole === "sub"
      || (span.fontSize <= lineFontSize * 0.82 && verticalShift >= lineFontSize * 0.16))
    && trimmed.length <= 16
    && !ORDINAL_SUP_RE.test(trimmed)
    && /^[A-Za-z0-9+\-*/=(),ijkmnxyzT⊤′'∗*<>|[\]{}:;·,.]+$/u.test(trimmed)
  ) {
    // Pure single/double digit footnote superscripts after prose words (e.g., "functions²") stay non-math
    // unless paired with math neighbors (handled during coalescing).
    if (/^\d{1,2}$/.test(trimmed) && span.scriptRole === "sup") return false;
    return true;
  }

  // Inline compact math expression like "f(x) = Wx + b" or "d_k = 64" or "O(n log n)"
  if (
    /[=≈≤≥≠±×÷∑∫∂∇→⇒√^∼]/.test(trimmed)
    && trimmed.length <= 72
    && !/\b(?:the|and|for|with|that|this|from|have|which|where|when|into)\b/i.test(trimmed)
  ) {
    return true;
  }
  return false;
}

function countProseWords(text: string): number {
  const words = text.match(/\b[A-Za-z]{4,}\b/g) ?? [];
  let count = 0;
  for (const w of words) {
    if (!MATH_FUNCTION_WORD_RE.test(w)) count += 1;
  }
  const cjk = text.match(/[\u4e00-\u9fff]{2,}/g) ?? [];
  return count + cjk.length;
}

function classifyLineMath(
  line: Omit<ReconstructedLine, "mathRatio" | "proseWordCount" | "isDisplayFormula" | "isMathFragment">,
  colWidth: number,
  colLeftRef: number,
  bodyFontSize: number,
  pageHeight: number,
): { mathRatio: number; proseWordCount: number; isDisplayFormula: boolean; isMathFragment: boolean } {
  const text = line.plainText.trim();
  const totalChars = text.replace(/\s+/g, "").length;
  if (totalChars === 0) {
    return { mathRatio: 0, proseWordCount: 0, isDisplayFormula: false, isMathFragment: false };
  }

  const mathChars = line.segments
    .filter((s) => s.kind === "math")
    .reduce((sum, s) => sum + s.text.replace(/\s+/g, "").length, 0);
  const mathRatio = mathChars / totalChars;
  const proseWordCount = countProseWords(text);
  const hasMatrixGlyph = MATRIX_GLYPH_RE.test(text);
  const hasEquationOp = /[=≈≤≥≠≡→⇒∑∏∫∂∇√∼]/.test(text);
  const hasBigOp = /[∑∏∫∬∮]/.test(text);
  const hasEqTag = EQUATION_TAG_RE.test(text);
  const lineWidth = line.x1 - line.x0;
  const flushLeft = Math.abs(line.x0 - colLeftRef) <= bodyFontSize * 0.7;
  const spansMostOfCol = lineWidth >= colWidth * 0.72;
  const centeredOrIndented = line.x0 - colLeftRef > bodyFontSize * 1.15;
  const startsWithLowercaseProse = /^[a-z]{4,}\s+/.test(text);

  // Never classify standard captions, figure labels, citations, or numbered headings as formulas
  if (/^(?:Figure|Fig\.|Table|Algorithm|Theorem|Lemma|Proposition|Corollary|Definition|Proof|Section|Appendix)\s+\d/i.test(text)) {
    return { mathRatio, proseWordCount, isDisplayFormula: false, isMathFragment: false };
  }
  if (/^\[\d+(?:\s*,\s*\d+)*\]\.?$/.test(text)) {
    return { mathRatio, proseWordCount, isDisplayFormula: false, isMathFragment: false };
  }

  let isDisplayFormula = false;
  if (hasMatrixGlyph && proseWordCount <= 1) {
    isDisplayFormula = true;
  } else if (hasEqTag && !spansMostOfCol && (mathRatio >= 0.25 || hasEquationOp) && proseWordCount <= 3) {
    isDisplayFormula = true;
  } else if (hasEqTag && (mathRatio >= 0.45 || hasBigOp) && proseWordCount <= 2) {
    isDisplayFormula = true;
  } else if (
    hasEquationOp
    && !startsWithLowercaseProse
    && proseWordCount <= 2
    && totalChars <= 120
    && (
      (centeredOrIndented && (mathRatio >= 0.28 || proseWordCount <= 1))
      || (!flushLeft && mathRatio >= 0.35)
      || (proseWordCount === 0 && (mathRatio >= 0.65 || hasBigOp))
    )
  ) {
    isDisplayFormula = true;
  } else if (
    mathRatio >= 0.70
    && !startsWithLowercaseProse
    && line.fontSize <= bodyFontSize * 1.25
    && proseWordCount === 0
    && totalChars >= 3
    && (!flushLeft || hasBigOp || hasEqTag)
  ) {
    isDisplayFormula = true;
  }

  // Standalone right-aligned equation tag "(9)" or "(2.4)"
  const isStandaloneEqTag = /^\(\d+(?:\.\d+)?\)$/.test(text) && line.x0 > colLeftRef + colWidth * 0.55;
  const inHeaderFooterMargin = line.y0 < pageHeight * 0.09 || line.y1 > pageHeight * 0.91;

  // Math fragment: fraction numerator/denominator ("QK^T", "d_k", "1", "1 - α_t"), limits ("t=1", "t>1"),
  // underbrace labels ("L_T L_{t-1} L_0"), tall parens ("( ) ( )", "[ ]"), matrix entry ("x1", "xn").
  const isMathFragment = !isDisplayFormula
    && (
      isStandaloneEqTag
      || (
        proseWordCount === 0
        && totalChars <= 56
        && line.fontSize <= bodyFontSize * 1.15
        && !inHeaderFooterMargin
        && (
          hasMatrixGlyph
          || mathRatio >= 0.42
          || /^[()[\]{}|‖·.\s]+$/.test(text)
          || (lineWidth < colWidth * 0.55 && !flushLeft && /^[A-Za-z0-9α-ωΑ-Ω∑∏∫√¯˜ˆ−+\-*/=<>(),[\]{}|_^\s]+$/u.test(text))
        )
      )
    );

  return { mathRatio, proseWordCount, isDisplayFormula, isMathFragment };
}

function appendMathPart(parts: PdfMathPart[], text: string, script?: "sup" | "sub"): void {
  if (!text) return;
  const last = parts.at(-1);
  if (last && last.script === script) {
    last.text += text;
  } else {
    parts.push(script ? { text, script } : { text });
  }
}

function buildLineSegments(spans: readonly PositionedSpan[], lineBaselineY: number, lineFontSize: number): {
  segments: PdfInlineSegment[];
  plainText: string;
} {
  const sorted = [...spans].sort((a, b) => a.x - b.x || a.baselineY - b.baselineY);
  const rawSegments: PdfInlineSegment[] = [];
  let prevEnd = -Infinity;
  let prevSpan: PositionedSpan | null = null;

  for (const span of sorted) {
    if (!span.text) continue;
    const isScript = span.scriptRole === "sup" || span.scriptRole === "sub";
    const gap = span.x - prevEnd;
    const spaceThreshold = isScript
      ? Math.max(2.5, lineFontSize * 0.32)
      : Math.max(1.2, span.fontSize * 0.16);
    const needsSpace = prevEnd > -Infinity && gap > spaceThreshold
      && !/^\s/.test(span.text)
      && rawSegments.length > 0
      && !/\s$/.test(rawSegments.at(-1)!.text);

    let isMath = isMathLikeToken(span, lineBaselineY, lineFontSize);
    // Attach short numeric superscripts/subscripts directly to a preceding math token (e.g., O(N^2), x_1)
    if (!isMath && isScript && rawSegments.at(-1)?.kind === "math" && gap <= lineFontSize * 0.45 && /^[0-9+\-ijkmnxyzT]+$/u.test(span.text.trim())) {
      isMath = true;
    }
    // Single-letter base right before a math script or right inside math runs stays text until coalescing pass
    const kind: "text" | "math" = isMath ? "math" : "text";
    const script: "sup" | "sub" | undefined = isScript ? (span.scriptRole as "sup" | "sub") : undefined;

    if (needsSpace) {
      const prev = rawSegments.at(-1)!;
      if (prev.kind === "math" && kind === "math" && gap < lineFontSize * 0.85) {
        prev.text += " ";
        if (prev.parts) appendMathPart(prev.parts, " ");
      } else {
        rawSegments.push({ kind: "text", text: " " });
      }
    }

    const last = rawSegments.at(-1);
    if (last && last.kind === kind) {
      if (kind === "math") {
        // Insert subtle separator when a superscript immediately follows a subscript on the same x or vice versa
        if (script && prevSpan && (prevSpan.scriptRole === "sup" || prevSpan.scriptRole === "sub") && prevSpan.scriptRole !== script) {
          // Keep clean parts without corrupting text
        }
        last.text += span.text;
        last.parts ??= [{ text: last.text.slice(0, last.text.length - span.text.length) }];
        appendMathPart(last.parts, span.text, script);
      } else {
        last.text += span.text;
      }
    } else if (kind === "math") {
      rawSegments.push({
        kind: "math",
        text: span.text,
        parts: [script ? { text: span.text, script } : { text: span.text }],
      });
    } else {
      rawSegments.push({ kind: "text", text: span.text });
    }
    prevEnd = Math.max(prevEnd, span.x + span.width);
    prevSpan = span;
  }

  // Coalesce fragmented inline math runs separated only by math punctuation/operators/single symbols
  // e.g. `[M:W][M:i] [M:∈] [text:R] [M:d_k]` -> `[M:W_i ∈ R^{d_k}]`
  const coalesced: PdfInlineSegment[] = [];
  for (let i = 0; i < rawSegments.length; i += 1) {
    const seg = rawSegments[i]!;
    const prev = coalesced.at(-1);
    const next = rawSegments[i + 1];

    if (
      seg.kind === "text"
      && prev?.kind === "math"
      && next?.kind === "math"
    ) {
      const trimmed = seg.text.trim();
      const isShortConnector = trimmed.length === 0
        || /^[=≈≤≥≠±×÷+\-*/()[\]{}|:;,.·<>]+$/.test(trimmed)
        || (trimmed.length <= 2 && /^[A-Za-z0-9()[\]{}]+$/.test(trimmed) && !COMMON_SHORT_PROSE_WORDS.has(trimmed.toLowerCase()));
      // Do not bridge across ", " separating two distinct prose list clauses unless very compact
      const isListComma = /^,\s*$/.test(seg.text) && prev.text.length > 16;
      if (isShortConnector && !isListComma) {
        prev.text += seg.text;
        prev.parts ??= [{ text: prev.text.slice(0, prev.text.length - seg.text.length) }];
        appendMathPart(prev.parts, seg.text);
        continue;
      }
    }

    if (prev && prev.kind === seg.kind) {
      if (prev.kind === "math") {
        prev.text += seg.text;
        prev.parts ??= [{ text: prev.text.slice(0, prev.text.length - seg.text.length) }];
        if (seg.parts) {
          for (const p of seg.parts) appendMathPart(prev.parts, p.text, p.script);
        } else {
          appendMathPart(prev.parts, seg.text);
        }
      } else {
        prev.text += seg.text;
      }
    } else {
      coalesced.push(seg.parts ? { ...seg, parts: seg.parts.map((p) => ({ ...p })) } : { ...seg });
    }
  }

  // Also absorb a single trailing/leading math variable letter immediately attached to a math span
  // without whitespace (e.g., `p` + `[M:θ(x)]` -> `[M:pθ(x)]`, `d` + `[M:_k]` -> `[M:d_k]`, `ℝ` + `[M:N×d]`).
  for (let i = 0; i < coalesced.length; i += 1) {
    const seg = coalesced[i]!;
    if (seg.kind !== "text") continue;
    const next = coalesced[i + 1];
    if (next?.kind === "math" && !/\s$/.test(seg.text)) {
      const trailMatch = seg.text.match(/(^|[\s([{"'])([A-Za-z](?:\([A-Za-z0-9, ]{1,12}\))?)$/);
      if (trailMatch && !COMMON_SHORT_PROSE_WORDS.has(trailMatch[2]!.toLowerCase())) {
        const token = trailMatch[2]!;
        seg.text = seg.text.slice(0, seg.text.length - token.length);
        next.text = token + next.text;
        next.parts = [{ text: token }, ...(next.parts ?? [{ text: next.text.slice(token.length) }])];
      }
    }
    const prev = coalesced[i - 1];
    if (prev?.kind === "math" && !/^\s/.test(seg.text)) {
      const leadMatch = seg.text.match(/^(\([A-Za-z0-9,\s|;]{1,18}\)|[)\]}]+)/);
      if (leadMatch) {
        const token = leadMatch[1]!;
        seg.text = seg.text.slice(token.length);
        prev.text += token;
        prev.parts ??= [{ text: prev.text.slice(0, prev.text.length - token.length) }];
        appendMathPart(prev.parts, token);
      }
    }
  }

  // Detect explicit inline math expressions inside remaining plain text segments (e.g. `O(n^2)`, `d_k`)
  const refined: PdfInlineSegment[] = [];
  const inlineFormulaRe = /((?:[A-Za-z][A-Za-z0-9_]*\([^()\n]{1,24}\)\s*[=≈≤≥]\s*[^\s,;。]+(?:\s*[+\-*/·]\s*[^\s,;。]+)*)|(?:[A-Za-zα-ωΑ-Ω][A-Za-z0-9_′']*[\^_][A-Za-z0-9{}()+\-]+)|(?:[OΘΩ]\([^()\n]{1,24}\)))/gu;

  for (const seg of coalesced) {
    if (!seg.text) continue;
    if (seg.kind === "math") {
      refined.push(seg);
      continue;
    }
    let cursor = 0;
    let m: RegExpExecArray | null;
    while ((m = inlineFormulaRe.exec(seg.text)) !== null) {
      if (m.index > cursor) refined.push({ kind: "text", text: seg.text.slice(cursor, m.index) });
      refined.push({ kind: "math", text: m[0], parts: [{ text: m[0] }] });
      cursor = m.index + m[0].length;
    }
    if (cursor < seg.text.length) refined.push({ kind: "text", text: seg.text.slice(cursor) });
  }

  // Final re-coalesce of adjacent identical kinds
  const finalSegments: PdfInlineSegment[] = [];
  for (const seg of refined) {
    if (!seg.text) continue;
    const prev = finalSegments.at(-1);
    if (prev && prev.kind === seg.kind) {
      if (prev.kind === "math") {
        prev.text += seg.text;
        prev.parts ??= [{ text: prev.text.slice(0, prev.text.length - seg.text.length) }];
        if (seg.parts) {
          for (const p of seg.parts) appendMathPart(prev.parts, p.text, p.script);
        } else {
          appendMathPart(prev.parts, seg.text);
        }
      } else {
        prev.text += seg.text;
      }
    } else {
      finalSegments.push(seg);
    }
  }

  const plainText = finalSegments.map((s) => s.text).join("").replace(/\s+/g, " ").trim();
  return { segments: finalSegments, plainText };
}

function detectTwoColumnGutter(
  spans: readonly PositionedSpan[],
  pageWidth: number,
  bodyFontSize: number,
): TwoColumnGutter | null {
  if (spans.length < 10 || pageWidth < 360) return null;
  const searchStart = Math.floor(pageWidth * 0.38);
  const searchEnd = Math.ceil(pageWidth * 0.62);
  const bins = new Uint16Array(Math.ceil(pageWidth) + 2);

  // Filter to body-sized, single-column-width spans so centered titles/abstracts never mask the gutter
  const bodySpans = spans.filter(
    (span) => span.width <= pageWidth * 0.48
      && span.fontSize >= bodyFontSize * 0.78
      && span.fontSize <= bodyFontSize * 1.18,
  );
  if (bodySpans.length < 8) return null;

  for (const span of bodySpans) {
    const x0 = Math.max(0, Math.floor(span.x));
    const x1 = Math.min(bins.length - 1, Math.ceil(span.x + span.width));
    for (let x = x0; x <= x1; x += 1) {
      bins[x] = (bins[x] ?? 0) + 1;
    }
  }

  let leftPeak = 0;
  for (let x = Math.floor(pageWidth * 0.08); x < searchStart; x += 1) {
    if ((bins[x] ?? 0) > leftPeak) leftPeak = bins[x] ?? 0;
  }
  let rightPeak = 0;
  for (let x = searchEnd + 1; x <= Math.min(bins.length - 1, Math.ceil(pageWidth * 0.92)); x += 1) {
    if ((bins[x] ?? 0) > rightPeak) rightPeak = bins[x] ?? 0;
  }
  if (leftPeak < 3 || rightPeak < 3) return null;

  const maxGutterHits = Math.max(2, Math.floor(Math.min(leftPeak, rightPeak) * 0.22));
  let bestGapStart = -1;
  let bestGapLen = 0;
  let curStart = -1;
  for (let x = searchStart; x <= searchEnd; x += 1) {
    if ((bins[x] ?? 0) <= maxGutterHits) {
      if (curStart < 0) curStart = x;
    } else if (curStart >= 0) {
      const len = x - curStart;
      if (len > bestGapLen) {
        bestGapLen = len;
        bestGapStart = curStart;
      }
      curStart = -1;
    }
  }
  if (curStart >= 0) {
    const len = searchEnd - curStart + 1;
    if (len > bestGapLen) {
      bestGapLen = len;
      bestGapStart = curStart;
    }
  }

  if (bestGapLen < 10 || bestGapStart < 0) return null;
  const splitX = bestGapStart + bestGapLen / 2;

  let leftCount = 0;
  let rightCount = 0;
  let crossingCount = 0;
  for (const span of bodySpans) {
    if (span.x + span.width <= splitX + 4) leftCount += 1;
    else if (span.x >= splitX - 4) rightCount += 1;
    else crossingCount += 1;
  }
  if (leftCount < 4 || rightCount < 4) return null;
  const cleanRatio = (leftCount + rightCount) / Math.max(1, leftCount + rightCount + crossingCount);
  if (cleanRatio < 0.72) return null;

  return {
    splitX,
    gutterLeft: bestGapStart,
    gutterRight: bestGapStart + bestGapLen,
    gutterWidth: bestGapLen,
  };
}

function joinSegmentsWithHyphenRepair(
  target: PdfInlineSegment[],
  nextLine: readonly PdfInlineSegment[],
): void {
  if (nextLine.length === 0) return;
  const firstNext = nextLine[0]!;
  const lastTarget = target.at(-1);

  const appendSegment = (seg: PdfInlineSegment): void => {
    const prev = target.at(-1);
    if (prev && prev.kind === seg.kind) {
      if (prev.kind === "math") {
        prev.text += seg.text;
        prev.parts ??= [{ text: prev.text.slice(0, prev.text.length - seg.text.length) }];
        if (seg.parts) {
          for (const p of seg.parts) appendMathPart(prev.parts, p.text, p.script);
        } else {
          appendMathPart(prev.parts, seg.text);
        }
      } else {
        prev.text += seg.text;
      }
    } else {
      target.push(seg.parts ? { ...seg, parts: seg.parts.map((p) => ({ ...p })) } : { ...seg });
    }
  };

  if (
    lastTarget
    && lastTarget.kind === "text"
    && firstNext.kind === "text"
    && /[A-Za-z]-$/.test(lastTarget.text.trimEnd())
    && /^[a-z]/.test(firstNext.text.trimStart())
  ) {
    // Rejoin soft hyphenated word across PDF line wrap: "trans-" + "formation" -> "transformation"
    lastTarget.text = lastTarget.text.trimEnd().slice(0, -1) + firstNext.text.trimStart();
    for (let i = 1; i < nextLine.length; i += 1) appendSegment(nextLine[i]!);
    return;
  }

  // CJK text should not insert an artificial space across wrapped lines.
  const prevEndText = lastTarget?.text.trimEnd() ?? "";
  const nextStartText = firstNext.text.trimStart();
  const cjkJoin = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]$/u.test(prevEndText)
    && /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(nextStartText);

  if (lastTarget && lastTarget.kind === "text" && firstNext.kind === "text") {
    lastTarget.text = prevEndText + (cjkJoin ? "" : " ") + nextStartText;
    for (let i = 1; i < nextLine.length; i += 1) appendSegment(nextLine[i]!);
    return;
  }

  if (!cjkJoin && target.length > 0) {
    const prev = target.at(-1)!;
    if (prev.kind === "text") prev.text = prev.text.trimEnd() + " ";
    else target.push({ kind: "text", text: " " });
  }
  for (const seg of nextLine) appendSegment(seg);
}

interface RawLineBucket {
  column: "full" | "left" | "right";
  spans: PositionedSpan[];
  baselineY: number;
  fontSize: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

function summarizeBucket(column: "full" | "left" | "right", spans: PositionedSpan[], fallbackSize: number): RawLineBucket {
  const baselineY = median(spans.map((s) => s.baselineY), spans[0]!.baselineY);
  const fontSize = median(spans.map((s) => s.fontSize), fallbackSize);
  const x0 = Math.min(...spans.map((s) => s.x));
  const y0 = Math.min(...spans.map((s) => s.y));
  const x1 = Math.max(...spans.map((s) => s.x + s.width));
  const y1 = Math.max(...spans.map((s) => s.y + s.height));
  return { column, spans, baselineY, fontSize, x0, y0, x1, y1 };
}

function clusterSpansByBaseline(spans: readonly PositionedSpan[]): PositionedSpan[][] {
  if (spans.length === 0) return [];
  const sorted = [...spans].sort((a, b) => a.baselineY - b.baselineY || a.x - b.x);
  const clusters: PositionedSpan[][] = [];

  for (const span of sorted) {
    let placed = false;
    for (let i = clusters.length - 1; i >= Math.max(0, clusters.length - 6); i -= 1) {
      const cluster = clusters[i]!;
      const refBaseline = median(cluster.map((s) => s.baselineY), cluster[0]!.baselineY);
      const refSize = median(cluster.map((s) => s.fontSize), cluster[0]!.fontSize);
      if (Math.abs(span.baselineY - refBaseline) <= Math.max(2.6, refSize * 0.42)) {
        cluster.push(span);
        placed = true;
        break;
      }
    }
    if (!placed) clusters.push([span]);
  }
  return clusters;
}

function splitClusterByGutter(
  cluster: PositionedSpan[],
  gutter: TwoColumnGutter | null,
  bodyFontSize: number,
): RawLineBucket[] {
  if (!gutter) return [summarizeBucket("full", cluster, bodyFontSize)];

  const sorted = [...cluster].sort((a, b) => a.x - b.x);
  const leftSpans: PositionedSpan[] = [];
  const rightSpans: PositionedSpan[] = [];
  let hasBridgingSpan = false;

  for (const span of sorted) {
    const right = span.x + span.width;
    if (span.x < gutter.gutterLeft - 2 && right > gutter.gutterRight + 2) {
      hasBridgingSpan = true;
      break;
    }
    if (right <= gutter.splitX + 4) leftSpans.push(span);
    else if (span.x >= gutter.splitX - 4) rightSpans.push(span);
    else if (span.x + span.width / 2 < gutter.splitX) leftSpans.push(span);
    else rightSpans.push(span);
  }

  if (hasBridgingSpan) {
    return [summarizeBucket("full", sorted, bodyFontSize)];
  }

  if (leftSpans.length > 0 && rightSpans.length > 0) {
    const maxLeftEnd = Math.max(...leftSpans.map((s) => s.x + s.width));
    const minRightStart = Math.min(...rightSpans.map((s) => s.x));
    const centerGap = minRightStart - maxLeftEnd;
    // If left and right spans are only separated by a normal word space across the page center,
    // this is a full-width line (title, authors, full-width abstract, or full-width table), NOT two columns!
    const minGutterGap = Math.max(gutter.gutterWidth * 0.72, bodyFontSize * 1.15);
    if (centerGap < minGutterGap) {
      return [summarizeBucket("full", sorted, bodyFontSize)];
    }
    return [
      summarizeBucket("left", leftSpans, bodyFontSize),
      summarizeBucket("right", rightSpans, bodyFontSize),
    ];
  }

  const only = leftSpans.length > 0 ? leftSpans : rightSpans;
  const x0 = Math.min(...only.map((s) => s.x));
  const x1 = Math.max(...only.map((s) => s.x + s.width));
  const center = (x0 + x1) / 2;
  // Centered narrow line straddling page midline (e.g. centered title/subtitle/equation) -> full
  if (Math.abs(center - gutter.splitX) <= Math.max(24, gutter.gutterWidth * 1.6) && x0 < gutter.splitX && x1 > gutter.splitX) {
    return [summarizeBucket("full", only, bodyFontSize)];
  }
  return [summarizeBucket(leftSpans.length > 0 ? "left" : "right", only, bodyFontSize)];
}

/** Merges vertically stacked / overlapping 2D display formula & math-fragment lines into unified formula blocks. */
function coalesce2DFormulaLines(lines: ReconstructedLine[], bodyFontSize: number): ReconstructedLine[] {
  if (lines.length <= 1) return lines;

  // Step A: Mark lines that belong to a 2D formula cluster
  const isFormulaMember = lines.map((l) => l.isDisplayFormula);

  const canAttachFragment = (frag: ReconstructedLine, anchor: ReconstructedLine): boolean => {
    const vGap = Math.max(frag.y0 - anchor.y1, anchor.y0 - frag.y1);
    if (vGap > Math.max(7, bodyFontSize * 0.92)) return false;
    const hPad = Math.max(24, bodyFontSize * 3.0);
    const hOverlap = frag.x0 <= anchor.x1 + hPad && frag.x1 >= anchor.x0 - hPad;
    return hOverlap;
  };

  // Propagate outward from every display formula to absorb stacked fraction numerators/denominators,
  // integral/sum limits ("t=1", "t>1"), underbrace labels ("L_T L_{t-1} L_0"), and matrix brackets.
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < lines.length; i += 1) {
      if (isFormulaMember[i] || !lines[i]!.isMathFragment) continue;
      const prev = i > 0 && isFormulaMember[i - 1] ? lines[i - 1]! : null;
      const next = i + 1 < lines.length && isFormulaMember[i + 1] ? lines[i + 1]! : null;
      if ((prev && canAttachFragment(lines[i]!, prev)) || (next && canAttachFragment(lines[i]!, next))) {
        isFormulaMember[i] = true;
        changed = true;
      }
    }
  }

  // Step B: Promote contiguous stacks of >=2 math-fragment lines (e.g., tall column vectors / matrices)
  let idx = 0;
  while (idx < lines.length) {
    if (!lines[idx]!.isMathFragment || isFormulaMember[idx]) {
      idx += 1;
      continue;
    }
    let end = idx;
    while (end + 1 < lines.length && lines[end + 1]!.isMathFragment && !isFormulaMember[end + 1]) {
      const a = lines[end]!;
      const b = lines[end + 1]!;
      const vGap = b.y0 - a.y1;
      const hOverlap = b.x0 <= a.x1 + bodyFontSize * 2.5 && b.x1 >= a.x0 - bodyFontSize * 2.5;
      if (vGap <= Math.max(6, bodyFontSize * 0.78) && hOverlap) {
        end += 1;
      } else {
        break;
      }
    }
    if (end > idx) {
      const group = lines.slice(idx, end + 1);
      const combinedText = group.map((g) => g.plainText).join(" ");
      const hasMathEvidence = MATRIX_GLYPH_RE.test(combinedText)
        || UNICODE_MATH_RE.test(combinedText)
        || /[=≈≤≥≠±×÷∑∏∫∂∇√^_]/.test(combinedText)
        || group.some((g) => g.mathRatio >= 0.45);
      if (hasMathEvidence) {
        for (let k = idx; k <= end; k += 1) isFormulaMember[k] = true;
      }
    }
    idx = end + 1;
  }

  // Step C: Collapse consecutive formula-member lines within normal equation spacing into single 2D formula blocks
  const merged: ReconstructedLine[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (!isFormulaMember[i]) {
      merged.push(line);
      continue;
    }
    const prev = merged.at(-1);
    const vGap = prev ? line.y0 - prev.y1 : Infinity;
    if (prev && prev.isDisplayFormula && vGap <= Math.max(8, bodyFontSize * 0.85)) {
      prev.spans.push(...line.spans);
      prev.x0 = Math.min(prev.x0, line.x0);
      prev.y0 = Math.min(prev.y0, line.y0);
      prev.x1 = Math.max(prev.x1, line.x1);
      prev.y1 = Math.max(prev.y1, line.y1);
      prev.plainText = `${prev.plainText} ${line.plainText}`.replace(/\s+/g, " ").trim();
      prev.segments = [{ kind: "math", text: prev.plainText }];
    } else {
      merged.push({
        ...line,
        spans: [...line.spans],
        isDisplayFormula: true,
        isMathFragment: false,
        segments: [{ kind: "math", text: line.plainText }],
      });
    }
  }
  return merged;
}

export function extractPdfPageBlocks(
  items: readonly PdfRawTextItem[],
  styles: Record<string, PdfFontStyleInfo> | undefined,
  pageWidth: number,
  pageHeight: number,
  pageNumber: number,
): PdfLayoutBlock[] {
  const spans: PositionedSpan[] = [];
  for (const item of items) {
    if (!item || typeof item.str !== "string") continue;
    const cleanStr = item.str.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "");
    if (!cleanStr.trim()) continue;
    if (LATEXIT_META_RE.test(cleanStr)) continue;
    const t = item.transform;
    if (!Array.isArray(t) || t.length < 6) continue;
    const x = t[4] ?? 0;
    // Skip vertically rotated margin stamps (e.g. arXiv timestamps printed along the left margin)
    const isRotatedVertical = Math.abs(t[1] ?? 0) > Math.abs(t[0] ?? 0) * 1.2
      && Math.abs(t[2] ?? 0) > Math.abs(t[3] ?? 0) * 1.2;
    if (isRotatedVertical && (x < pageWidth * 0.12 || x > pageWidth * 0.88)) continue;

    const fontSize = Math.max(4, Math.hypot(t[0] ?? 0, t[1] ?? 0) || Math.hypot(t[2] ?? 0, t[3] ?? 0) || item.height || 10);
    const height = Math.max(fontSize, item.height || fontSize);
    const width = Math.max(1, item.width || cleanStr.length * fontSize * 0.45);
    const baselineY = pageHeight - (t[5] ?? 0);
    const fontName = item.fontName ?? "";
    const styleInfo = styles?.[fontName];
    const fontFamily = styleInfo?.fontFamily ?? "";
    const realFontName = styleInfo?.realFontName ?? "";
    const fontMeta = `${realFontName} ${fontName} ${fontFamily}`;
    // Extensible TeX CMEX glyphs (tall brackets, big parens, large sums/integrals) hang
    // downward from their PDF origin instead of ascending by height*0.85 above baselineY.
    const isCmexHanging = /(?:cmex|txex|pxex)/i.test(fontMeta) || MATRIX_GLYPH_RE.test(cleanStr);
    const y = isCmexHanging
      ? Math.max(0, baselineY - fontSize * 0.25)
      : Math.max(0, baselineY - height * 0.85);

    spans.push({
      text: cleanStr,
      x,
      y,
      width,
      height,
      fontSize,
      fontName,
      fontFamily,
      realFontName,
      isMathFont: MATH_FONT_RE.test(fontMeta),
      isBoldFont: BOLD_FONT_RE.test(fontMeta),
      baselineY,
    });
  }

  if (spans.length === 0) return [];

  const bodyFontSize = computeBodyFontSize(spans);
  const gutter = detectTwoColumnGutter(spans, pageWidth, bodyFontSize);

  // Two-pass line reconstruction:
  // Pass 1: cluster normal-sized spans into horizontal Y-bands and split across any 2-column gutter.
  // Pass 2: attach raised superscripts, lowered subscripts, and inline CMEX tall operators (∫, ∑, ∏)
  // to their host line before clustering remaining standalone math fragments.
  const mainSpans: PositionedSpan[] = [];
  const microSpans: PositionedSpan[] = [];
  for (const span of spans) {
    const trimmed = span.text.trim();
    const isSmallScript = span.fontSize < bodyFontSize * 0.78
      && span.width < bodyFontSize * 4.8
      && trimmed.length <= 16
      && !MATRIX_GLYPH_RE.test(trimmed);
    const isTallInlineOp = trimmed.length <= 2
      && span.width <= bodyFontSize * 2.2
      && /^[∑∏∫∬∮√]$/.test(trimmed);
    if (isSmallScript || isTallInlineOp) microSpans.push(span);
    else mainSpans.push(span);
  }

  const mainClusters = clusterSpansByBaseline(mainSpans);
  const lineBuckets: RawLineBucket[] = [];
  for (const cluster of mainClusters) {
    lineBuckets.push(...splitClusterByGutter(cluster, gutter, bodyFontSize));
  }

  // Promote top header/abstract lines sitting above the first true two-column split band back to "full"
  if (gutter) {
    let firstTwoColY = Number.POSITIVE_INFINITY;
    const byYBand = new Map<number, Set<"left" | "right">>();
    for (const bucket of lineBuckets) {
      if (bucket.column !== "left" && bucket.column !== "right") continue;
      const yKey = Math.round(bucket.baselineY / Math.max(4, bodyFontSize * 0.75));
      let set = byYBand.get(yKey);
      if (!set) { set = new Set(); byYBand.set(yKey, set); }
      set.add(bucket.column);
    }
    for (const bucket of lineBuckets) {
      if (bucket.column !== "left" && bucket.column !== "right") continue;
      const yKey = Math.round(bucket.baselineY / Math.max(4, bodyFontSize * 0.75));
      if ((byYBand.get(yKey)?.size ?? 0) >= 2 && bucket.y0 < firstTwoColY) {
        firstTwoColY = bucket.y0;
      }
    }
    const hasTopFull = lineBuckets.some((b) => b.column === "full" && b.y0 < firstTwoColY);
    if (hasTopFull && Number.isFinite(firstTwoColY)) {
      for (const bucket of lineBuckets) {
        if (bucket.y1 <= firstTwoColY - 2 && bucket.column !== "full") {
          bucket.column = "full";
        }
      }
    }
  }

  // Pass 2: Attach superscript/subscript micro-spans and inline CMEX operators to their host line
  const orphanMicroSpans: PositionedSpan[] = [];
  for (const micro of microSpans) {
    const isTallOp = /^[∑∏∫∬∮√]$/.test(micro.text.trim());
    const microMidY = micro.y + micro.height / 2;
    let bestBucket: RawLineBucket | null = null;
    let bestScore = Number.POSITIVE_INFINITY;

    for (const bucket of lineBuckets) {
      const dy = micro.baselineY - bucket.baselineY;
      // CMEX operators hang down from a raised origin: match by vertical box midpoint overlap
      // so √ / ∫ attaches to its true host line rather than grazing the line immediately above.
      if (isTallOp) {
        const bucketMidY = (bucket.y0 + bucket.y1) / 2;
        const overlapsY = micro.y <= bucket.y1 && (micro.y + micro.height) >= bucket.y0;
        const isWideProseLine = (bucket.x1 - bucket.x0) >= bodyFontSize * 12;
        if (!overlapsY || !isWideProseLine) continue;
        if (Math.abs(microMidY - bucketMidY) > bucket.fontSize * 0.85) continue;
        if (micro.x < bucket.x0 - bucket.fontSize || micro.x > bucket.x1 + bucket.fontSize) continue;
      } else {
        // Superscript sits above host baseline (dy in [-0.72*fs, -0.10*fs]);
        // Subscript sits below host baseline (dy in [+0.10*fs, +0.58*fs]).
        if (dy < -bucket.fontSize * 0.72 || dy > bucket.fontSize * 0.58) continue;
        if (micro.x + micro.width < bucket.x0 - bucket.fontSize * 0.8 || micro.x > bucket.x1 + bucket.fontSize * 1.4) {
          continue;
        }
      }
      // Verify horizontal adjacency to an actual span in this line bucket
      const nearAnchor = bucket.spans.some(
        (anchor) => micro.x <= anchor.x + anchor.width + bucket.fontSize * 1.6
          && micro.x + micro.width >= anchor.x - bucket.fontSize * 1.2,
      );
      if (!nearAnchor) continue;
      const score = isTallOp ? Math.abs(microMidY - (bucket.y0 + bucket.y1) / 2) : Math.abs(dy);
      if (score < bestScore) {
        bestScore = score;
        bestBucket = bucket;
      }
    }

    if (bestBucket) {
      const dy = micro.baselineY - bestBucket.baselineY;
      micro.scriptRole = isTallOp
        ? "normal"
        : dy < -bestBucket.fontSize * 0.14
          ? "sup"
          : dy > bestBucket.fontSize * 0.14
            ? "sub"
            : "normal";
      bestBucket.spans.push(micro);
      bestBucket.x0 = Math.min(bestBucket.x0, micro.x);
      bestBucket.y0 = Math.min(bestBucket.y0, micro.y);
      bestBucket.x1 = Math.max(bestBucket.x1, micro.x + micro.width);
      bestBucket.y1 = Math.max(bestBucket.y1, micro.y + micro.height);
    } else {
      orphanMicroSpans.push(micro);
    }
  }

  // Cluster remaining unattached micro-spans (e.g., standalone fraction numerators/denominators, sum limits)
  if (orphanMicroSpans.length > 0) {
    const microClusters = clusterSpansByBaseline(orphanMicroSpans);
    for (const cluster of microClusters) {
      lineBuckets.push(...splitClusterByGutter(cluster, gutter, bodyFontSize));
    }
  }

  // Build ReconstructedLine entries per column
  const buildColumnLines = (col: "full" | "left" | "right"): ReconstructedLine[] => {
    const colBuckets = lineBuckets.filter((b) => b.column === col);
    const colWidth = col === "full" ? pageWidth : pageWidth / 2;
    const wideBuckets = colBuckets.filter((b) => (b.x1 - b.x0) >= colWidth * 0.45);
    const colLeftRef = median(
      (wideBuckets.length >= 2 ? wideBuckets : colBuckets).map((b) => b.x0),
      col === "right" && gutter ? gutter.gutterRight : 0,
    );
    const lines: ReconstructedLine[] = [];

    for (const bucket of colBuckets) {
      const { segments, plainText } = buildLineSegments(bucket.spans, bucket.baselineY, bucket.fontSize);
      if (!plainText) continue;

      // Filter isolated page numbers in extreme top/bottom 9% margins
      if ((bucket.y0 < pageHeight * 0.09 || bucket.y1 > pageHeight * 0.91) && PAGE_NUMBER_RE.test(plainText)) {
        continue;
      }

      const boldChars = bucket.spans.filter((s) => s.isBoldFont).reduce((sum, s) => sum + s.text.trim().length, 0);
      const allChars = bucket.spans.reduce((sum, s) => sum + s.text.trim().length, 0);
      const isBold = allChars > 0 && boldChars / allChars >= 0.65;

      const partial = {
        spans: bucket.spans,
        x0: bucket.x0,
        y0: bucket.y0,
        x1: bucket.x1,
        y1: bucket.y1,
        baselineY: bucket.baselineY,
        fontSize: bucket.fontSize,
        isBold,
        column: col,
        segments,
        plainText,
      };
      const mathInfo = classifyLineMath(partial, colWidth, colLeftRef, bodyFontSize, pageHeight);
      lines.push({ ...partial, ...mathInfo });
    }

    lines.sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);

    // Demote a flush-left short trailing line (e.g. "d_ff = 2048.") that directly continues an
    // unfinished prose line immediately above it with normal line spacing.
    for (let i = 1; i < lines.length; i += 1) {
      const prev = lines[i - 1]!;
      const cur = lines[i]!;
      if (!cur.isDisplayFormula) continue;
      if (prev.isDisplayFormula || prev.isMathFragment || prev.proseWordCount < 3) continue;
      const vGap = cur.y0 - prev.y1;
      const flushLeft = Math.abs(cur.x0 - colLeftRef) <= bodyFontSize * 0.7;
      const prevIncomplete = !/[.?!:]$/.test(prev.plainText.trim());
      if (
        flushLeft
        && prevIncomplete
        && vGap <= bodyFontSize * 0.55
        && !EQUATION_TAG_RE.test(cur.plainText)
        && !MATRIX_GLYPH_RE.test(cur.plainText)
        && !/[∑∏∫∬∮]/.test(cur.plainText)
      ) {
        cur.isDisplayFormula = false;
        cur.isMathFragment = false;
      }
    }

    return coalesce2DFormulaLines(lines, bodyFontSize);
  };

  const fullLines = buildColumnLines("full");
  const leftLines = buildColumnLines("left");
  const rightLines = buildColumnLines("right");

  // Order full-width bands interleaved cleanly with two-column bands (supports top title/abstract,
  // mid-page full-width tables/figures, and bottom full-width footers).
  const orderedStreams: ReconstructedLine[][] = [];
  if (leftLines.length === 0 && rightLines.length === 0) {
    if (fullLines.length > 0) orderedStreams.push(fullLines);
  } else {
    const colTopY = Math.min(
      leftLines[0]?.y0 ?? Number.POSITIVE_INFINITY,
      rightLines[0]?.y0 ?? Number.POSITIVE_INFINITY,
    );
    const topFull = fullLines.filter((l) => l.y0 < colTopY);
    const restFull = fullLines.filter((l) => l.y0 >= colTopY);

    if (topFull.length > 0) orderedStreams.push(topFull);

    // Group remaining full-width lines into contiguous vertical bands to split left/right cleanly around them
    const midBands: Array<{ y0: number; y1: number; lines: ReconstructedLine[] }> = [];
    for (const fl of restFull) {
      const prev = midBands.at(-1);
      if (prev && fl.y0 - prev.y1 <= Math.max(18, bodyFontSize * 2.0)) {
        prev.lines.push(fl);
        prev.y1 = Math.max(prev.y1, fl.y1);
      } else {
        midBands.push({ y0: fl.y0, y1: fl.y1, lines: [fl] });
      }
    }

    let cursorY = colTopY;
    for (const band of midBands) {
      const segLeft = leftLines.filter((l) => l.y0 >= cursorY && l.y0 < band.y0);
      const segRight = rightLines.filter((l) => l.y0 >= cursorY && l.y0 < band.y0);
      if (segLeft.length > 0) orderedStreams.push(segLeft);
      if (segRight.length > 0) orderedStreams.push(segRight);
      orderedStreams.push(band.lines);
      cursorY = band.y1;
    }
    const tailLeft = leftLines.filter((l) => l.y0 >= cursorY);
    const tailRight = rightLines.filter((l) => l.y0 >= cursorY);
    if (tailLeft.length > 0) orderedStreams.push(tailLeft);
    if (tailRight.length > 0) orderedStreams.push(tailRight);
  }

  const blocks: PdfLayoutBlock[] = [];
  let blockIndex = 0;

  for (const stream of orderedStreams) {
    if (stream.length === 0) continue;
    const proseLinesInStream = stream.filter((l) => !l.isDisplayFormula && l.proseWordCount >= 2);
    const colLeftRef = median(
      (proseLinesInStream.length >= 2 ? proseLinesInStream : stream).map((l) => l.x0),
      stream[0]!.x0,
    );

    let current: {
      kind: PdfBlockKind;
      headingLevel?: number | undefined;
      column: "full" | "left" | "right";
      segments: PdfInlineSegment[];
      x0: number;
      y0: number;
      x1: number;
      y1: number;
      lastBaselineY: number;
      fontSize: number;
      isBold: boolean;
      lineCount: number;
      listIndentX?: number;
    } | null = null;

    const flush = () => {
      if (!current) return;
      const plainText = current.segments.map((s) => s.text).join("").replace(/\s+/g, " ").trim();
      if (plainText) {
        blocks.push({
          id: `pdf-p${pageNumber}-b${++blockIndex}`,
          pageNumber,
          kind: current.kind,
          ...(current.headingLevel ? { headingLevel: current.headingLevel } : {}),
          column: current.column,
          segments: current.segments,
          plainText,
          box: {
            x: current.x0,
            y: current.y0,
            width: Math.max(4, current.x1 - current.x0),
            height: Math.max(6, current.y1 - current.y0),
          },
          fontSize: current.fontSize,
        });
      }
      current = null;
    };

    for (const line of stream) {
      if (line.isDisplayFormula) {
        flush();
        blocks.push({
          id: `pdf-p${pageNumber}-b${++blockIndex}`,
          pageNumber,
          kind: "formula",
          column: line.column,
          segments: [{ kind: "math", text: line.plainText }],
          plainText: line.plainText,
          box: {
            x: line.x0,
            y: line.y0,
            width: Math.max(4, line.x1 - line.x0),
            height: Math.max(6, line.y1 - line.y0),
          },
          fontSize: line.fontSize,
        });
        continue;
      }

      const isNumberedHeading = /^\d+(?:\.\d+)*\.?\s+[A-Z\u4e00-\u9fff]/.test(line.plainText)
        && line.plainText.length <= 96
        && !/[.。!?]$/.test(line.plainText)
        && (line.isBold || line.fontSize >= bodyFontSize * 1.03);
      const isNamedSectionHeading = /^(?:Abstract|Introduction|Background|Related Work|Methodology|Methods|Experiments?|Results|Discussion|Conclusion|Conclusions|References|Acknowledgments?|Appendix|Overview|Summary)$/i.test(line.plainText)
        && (line.isBold || line.fontSize >= bodyFontSize * 1.02);
      const isHeading = (line.fontSize >= bodyFontSize * 1.18 && line.plainText.length <= 160 && line.mathRatio < 0.5)
        || (line.isBold && line.fontSize >= bodyFontSize * 1.02 && line.plainText.length <= 96 && !/[.。!?]$/.test(line.plainText) && line.mathRatio < 0.4)
        || isNumberedHeading
        || isNamedSectionHeading;
      const isListStart = !isHeading && LIST_PREFIX_RE.test(line.plainText);
      const lineKind: PdfBlockKind = isHeading ? "heading" : isListStart ? "list-item" : "paragraph";
      const headingLevel = isHeading
        ? (line.fontSize >= bodyFontSize * 1.55 ? 1 : line.fontSize >= bodyFontSize * 1.25 ? 2 : 3)
        : undefined;

      const verticalClose = Boolean(
        current
        && Math.abs(line.fontSize - current.fontSize) <= Math.max(1.5, current.fontSize * 0.15)
        && (line.y0 - current.y1) <= Math.max(8, current.fontSize * 0.95)
        && (line.baselineY - current.lastBaselineY) <= Math.max(15, current.fontSize * 1.85),
      );

      // Merge wrapped continuation lines of a bullet/numbered list item (hanging indent)
      const isListContinuation = Boolean(
        current
        && current.kind === "list-item"
        && lineKind === "paragraph"
        && current.column === line.column
        && verticalClose
        && line.x0 >= current.x0 - 4
        && line.x0 <= current.x0 + current.fontSize * 3.2,
      );

      // Merge normal paragraph continuation lines (never merge a new numbered/named section heading into a previous heading)
      const isSameKindContinuation = Boolean(
        current
        && current.column === line.column
        && current.kind === lineKind
        && lineKind !== "list-item"
        && !(lineKind === "heading" && (isNumberedHeading || isNamedSectionHeading))
        && verticalClose
        && (
          line.x0 - colLeftRef < current.fontSize * 0.95
          || Math.abs(line.x0 - current.x0) <= 4
          || current.lineCount === 0
        ),
      );

      if ((isListContinuation || isSameKindContinuation) && current) {
        joinSegmentsWithHyphenRepair(current.segments, line.segments);
        current.x0 = Math.min(current.x0, line.x0);
        current.y0 = Math.min(current.y0, line.y0);
        current.x1 = Math.max(current.x1, line.x1);
        current.y1 = Math.max(current.y1, line.y1);
        current.lastBaselineY = line.baselineY;
        current.lineCount += 1;
      } else {
        flush();
        current = {
          kind: lineKind,
          headingLevel,
          column: line.column,
          segments: line.segments.map((s) => (s.parts ? { ...s, parts: s.parts.map((p) => ({ ...p })) } : { ...s })),
          x0: line.x0,
          y0: line.y0,
          x1: line.x1,
          y1: line.y1,
          lastBaselineY: line.baselineY,
          fontSize: line.fontSize,
          isBold: line.isBold,
          lineCount: 1,
        };
      }
    }
    flush();
  }

  return blocks;
}
