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

export type PdfBlockKind = "heading" | "paragraph" | "list-item" | "formula" | "table" | "figure";

export interface PdfTableCellBox {
  rowIndex: number;
  colIndex: number;
  box: PdfPageBox;
  fontSize: number;
}

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
  /** Per-line boxes inside this block for accurate in-place overlay erasure & sizing. */
  lineBoxes?: PdfPageBox[];
  /** For kind === "table": snapshot crops the HiDPI canvas; html renders a translatable <table>. */
  tableMode?: "snapshot" | "html";
  /** For kind === "table" && tableMode === "html": [row][col][inline segments]. */
  tableRows?: PdfInlineSegment[][][];
  tableHasHeader?: boolean;
  /** Cell coordinates in PDF page space for in-place overlay translation of HTML tables. */
  tableCellBoxes?: PdfTableCellBox[];
  source?: "text-layer" | "ocr";
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
  isRotatedVertical?: boolean;
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
  hasRotatedSpan?: boolean;
  column: "full" | "left" | "right";
  segments: PdfInlineSegment[];
  plainText: string;
  mathRatio: number;
  proseWordCount: number;
  isDisplayFormula: boolean;
  isMathFragment: boolean;
  isTableBlock?: boolean;
  tableMode?: "snapshot" | "html";
  tableRows?: PdfInlineSegment[][][];
  tableHasHeader?: boolean;
  tableCellBoxes?: PdfTableCellBox[];
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

  // Validate against full-page baseline rows so a single-column document containing
  // multi-column tables (whose cells leave a vertical gap near mid-page) is never
  // misclassified as a two-column layout.
  const allClusters = clusterSpansByBaseline(
    spans.filter((s) => !s.isRotatedVertical && s.fontSize >= bodyFontSize * 0.78 && s.fontSize <= bodyFontSize * 1.25),
  );
  let trueTwoColRows = 0;
  let fullWidthProseRows = 0;
  for (const cluster of allClusters) {
    const rowX0 = Math.min(...cluster.map((s) => s.x));
    const rowX1 = Math.max(...cluster.map((s) => s.x + s.width));
    const leftSide = cluster.filter((s) => s.x + s.width <= splitX + 4);
    const rightSide = cluster.filter((s) => s.x >= splitX - 4);
    const hasCrossingSpan = cluster.some((s) => s.x < bestGapStart - 2 && s.x + s.width > bestGapStart + bestGapLen + 2);
    const cells = splitSpansIntoHorizontalCells(cluster, bodyFontSize);
    const rowText = cells.map((c) => c.text).join(" ").trim();

    if (hasCrossingSpan || (leftSide.length > 0 && rightSide.length > 0 && Math.min(...rightSide.map((s) => s.x)) - Math.max(...leftSide.map((s) => s.x + s.width)) < Math.max(bestGapLen * 0.65, bodyFontSize * 1.1))) {
      if ((rowX1 - rowX0) >= pageWidth * 0.58 && countProseWords(rowText) >= 6 && !CAPTION_PREFIX_RE.test(rowText)) {
        fullWidthProseRows += 1;
      }
      continue;
    }

    if (leftSide.length > 0 && rightSide.length > 0 && cells.length === 2) {
      const leftText = cells[0]!.text;
      const rightText = cells[1]!.text;
      const leftW = cells[0]!.x1 - cells[0]!.x0;
      const rightW = cells[1]!.x1 - cells[1]!.x0;
      const looksLikeTwoProseCols = (countProseWords(leftText) >= 3 || leftW >= pageWidth * 0.22)
        && (countProseWords(rightText) >= 3 || rightW >= pageWidth * 0.22);
      if (looksLikeTwoProseCols) {
        trueTwoColRows += 1;
      }
    }
  }
  if (trueTwoColRows < 3) return null;
  if (fullWidthProseRows >= 4 && trueTwoColRows < fullWidthProseRows) return null;

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
      if (Boolean(cluster[0]!.isRotatedVertical) !== Boolean(span.isRotatedVertical)) continue;
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
    if (line.isTableBlock || !isFormulaMember[i]) {
      merged.push(line);
      continue;
    }
    const prev = merged.at(-1);
    const vGap = prev ? line.y0 - prev.y1 : Infinity;
    if (prev && prev.isDisplayFormula && !prev.isTableBlock && vGap <= Math.max(8, bodyFontSize * 0.85)) {
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

interface HorizontalCell {
  spans: PositionedSpan[];
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  baselineY: number;
  fontSize: number;
  text: string;
}

const CAPTION_PREFIX_RE = /^(?:Table|Tab\.|Figure|Fig\.|Algorithm|Listing|表|图)\s*\d+(?:\.\d+)?(?:\s*[:.：—–-]|\s|$)/i;
const BULLET_CELL_RE = /^(?:[•●◦▪▫▸▹–—*-]|\(?\d{1,3}[.)]|\([a-zA-Z]\))$/;
const EQUATION_NUM_CELL_RE = /^\(\d+(?:\.\d+)?\)$/;
const AUTHOR_AFFILIATION_RE = /@|\b(?:university|institute|research|google|microsoft|facebook|meta|deepmind|openai|department|laboratory|corp\.?|inc\.?)\b|[∗†‡§]/i;
const NUMERIC_OR_ARCH_CELL_RE = /^(?:[-+]?\d+(?:[.,]\d+)?%?(?:\s*[×xX·*±/]\s*\d+(?:[.,]\d+)?(?:\^\d+)?)*|[<>≤≥~≈±]\s*\d+(?:\.\d+)?|(?:\d+(?:\.\d+)?\s*(?:ms|s|k|K|M|B|GB|MB|KB|px|Hz|GHz|FLOPs?))|(?:conv\d[\w_]*|res\d[\w_]*|\d+-layer|O\([^)]+\)|[a-zA-Z]_[a-zA-Z0-9]+)|[-–—−]+|N\/A)$/i;

function splitSpansIntoHorizontalCells(spans: readonly PositionedSpan[], bodyFontSize: number): HorizontalCell[] {
  if (spans.length === 0) return [];
  const sorted = [...spans].sort((a, b) => a.x - b.x || a.baselineY - b.baselineY);
  const lineFs = median(spans.map((s) => s.fontSize), bodyFontSize);
  const gapThreshold = Math.max(6, Math.min(bodyFontSize, lineFs) * 1.15);
  const groups: PositionedSpan[][] = [];

  for (const span of sorted) {
    const prevGroup = groups.at(-1);
    if (!prevGroup) {
      groups.push([span]);
      continue;
    }
    const prevMaxX = Math.max(...prevGroup.map((s) => s.x + s.width));
    const gap = span.x - prevMaxX;
    if (gap < gapThreshold) {
      prevGroup.push(span);
    } else {
      groups.push([span]);
    }
  }

  return groups.map((group) => {
    const x0 = Math.min(...group.map((s) => s.x));
    const y0 = Math.min(...group.map((s) => s.y));
    const x1 = Math.max(...group.map((s) => s.x + s.width));
    const y1 = Math.max(...group.map((s) => s.y + s.height));
    const baselineY = median(group.map((s) => s.baselineY), group[0]!.baselineY);
    const fontSize = median(group.map((s) => s.fontSize), bodyFontSize);
    const { plainText } = buildLineSegments(group, baselineY, fontSize);
    return { spans: group, x0, y0, x1, y1, baselineY, fontSize, text: plainText };
  }).filter((cell) => cell.text.length > 0);
}

/**
 * Before splitting a 2-column page along the center gutter, identify vertical Y-bands
 * occupied by full-width multi-column tables (e.g. ResNet Table 1) so their rows are
 * never torn apart into separate left/right column streams.
 */
function detectFullWidthTableYBands(
  clusters: readonly PositionedSpan[][],
  gutter: TwoColumnGutter,
  pageWidth: number,
  bodyFontSize: number,
): Array<{ y0: number; y1: number }> {
  const seeds: Array<{ y0: number; y1: number }> = [];
  const halfColWidth = Math.max(80, gutter.gutterLeft - pageWidth * 0.08);

  for (const cluster of clusters) {
    const cells = splitSpansIntoHorizontalCells(cluster, bodyFontSize);
    if (cells.length < 3) continue;
    const joined = cells.map((c) => c.text).join(" ");
    if (CAPTION_PREFIX_RE.test(joined)) continue;

    const leftCells = cells.filter((c) => c.x1 <= gutter.splitX + 6);
    const rightCells = cells.filter((c) => c.x0 >= gutter.splitX - 6);
    const bridgingCell = cells.some((c) => c.x0 < gutter.gutterLeft - 2 && c.x1 > gutter.gutterRight + 2);
    if (!bridgingCell && (leftCells.length === 0 || rightCells.length === 0)) continue;

    // Exclude 2-column body prose lines (or a single-column table sitting beside prose in the other column).
    const hasColumnWideProse = cells.some(
      (c) => (c.x1 - c.x0) >= halfColWidth * 0.65 && countProseWords(c.text) >= 4,
    );
    if (hasColumnWideProse) continue;

    // Require genuine multi-column tabular structure on both sides of the gutter unless a cell bridges the center.
    if (!bridgingCell && (leftCells.length < 2 || rightCells.length < 2)) continue;

    const compactCells = cells.filter((c) => (c.x1 - c.x0) < pageWidth * 0.30).length;
    if (compactCells < 2) continue;

    const y0 = Math.min(...cluster.map((s) => s.y));
    const y1 = Math.max(...cluster.map((s) => s.y + s.height));
    seeds.push({ y0, y1 });
  }

  if (seeds.length < 3) return [];
  seeds.sort((a, b) => a.y0 - b.y0);

  const bands: Array<{ y0: number; y1: number; count: number }> = [];
  for (const seed of seeds) {
    const prev = bands.at(-1);
    if (prev && seed.y0 - prev.y1 <= Math.max(28, bodyFontSize * 3.0)) {
      prev.y1 = Math.max(prev.y1, seed.y1);
      prev.count += 1;
    } else {
      bands.push({ y0: seed.y0, y1: seed.y1, count: 1 });
    }
  }
  return bands.filter((b) => b.count >= 3).map(({ y0, y1 }) => ({ y0, y1 }));
}

interface ColumnBand {
  x0: number;
  x1: number;
  hits: number;
}

function clusterColumnBands(cells: readonly HorizontalCell[], bodyFontSize: number): ColumnBand[] {
  if (cells.length === 0) return [];
  // Ignore wide spanning cells (>55% of full table width) when discovering column centers.
  const minX = Math.min(...cells.map((c) => c.x0));
  const maxX = Math.max(...cells.map((c) => c.x1));
  const spanW = Math.max(1, maxX - minX);
  const normalCells = cells.filter((c) => (c.x1 - c.x0) <= spanW * 0.62);
  const source = normalCells.length >= 4 ? normalCells : cells;

  const sorted = [...source].sort((a, b) => a.x0 - b.x0);
  const bands: ColumnBand[] = [];
  const tol = Math.max(4, bodyFontSize * 0.45);

  for (const cell of sorted) {
    let matched: ColumnBand | null = null;
    let bestOverlap = -Infinity;
    for (const band of bands) {
      const overlap = Math.min(cell.x1, band.x1) - Math.max(cell.x0, band.x0);
      const centerDist = Math.abs((cell.x0 + cell.x1) / 2 - (band.x0 + band.x1) / 2);
      if (overlap >= -tol || centerDist <= Math.max(10, bodyFontSize * 1.1)) {
        if (overlap > bestOverlap) {
          bestOverlap = overlap;
          matched = band;
        }
      }
    }
    if (matched) {
      matched.x0 = Math.min(matched.x0, cell.x0);
      matched.x1 = Math.max(matched.x1, cell.x1);
      matched.hits += 1;
    } else {
      bands.push({ x0: cell.x0, x1: cell.x1, hits: 1 });
    }
  }

  // Merge adjacent bands that now overlap substantially
  bands.sort((a, b) => a.x0 - b.x0);
  const merged: ColumnBand[] = [];
  for (const band of bands) {
    const prev = merged.at(-1);
    if (prev && band.x0 <= prev.x1 + 2) {
      prev.x1 = Math.max(prev.x1, band.x1);
      prev.hits += band.hits;
    } else {
      merged.push({ ...band });
    }
  }
  return merged;
}

function isNumericOrCodeCell(cell: HorizontalCell): boolean {
  const text = cell.text.trim();
  if (!text) return false;
  if (NUMERIC_OR_ARCH_CELL_RE.test(text)) return true;
  if (MATRIX_GLYPH_RE.test(text)) return true;
  const nonSpace = text.replace(/\s+/g, "");
  const digitSymCount = (nonSpace.match(/[0-9.%×xX·*±+\-–—=()[\]/^_<>≤≥]/g) ?? []).length;
  if (nonSpace.length <= 18 && digitSymCount / Math.max(1, nonSpace.length) >= 0.55) return true;
  return false;
}

function isMathBearingCell(cell: HorizontalCell): boolean {
  if (MATRIX_GLYPH_RE.test(cell.text) || UNICODE_MATH_RE.test(cell.text)) return true;
  const mathChars = cell.spans
    .filter((s) => s.isMathFont || s.scriptRole === "sup" || s.scriptRole === "sub")
    .reduce((sum, s) => sum + s.text.trim().length, 0);
  const allChars = cell.spans.reduce((sum, s) => sum + s.text.trim().length, 0);
  return allChars > 0 && mathChars / allChars >= 0.35;
}

/**
 * Two-tier table detector on a column's pre-coalesced lines:
 * - Dense numeric / architecture / formula / wide (>=5 col) tables -> `tableMode: "snapshot"` (HiDPI canvas crop)
 * - Clean 2-4 column prose comparison tables -> `tableMode: "html"` (translatable HTML <table> + cell boxes)
 */
function detectAndCoalesceTableLines(
  lines: ReconstructedLine[],
  colWidth: number,
  bodyFontSize: number,
  pageHeight: number,
  pageNumber: number,
): ReconstructedLine[] {
  if (lines.length < 3) return lines;

  const lineCells = lines.map((line) => splitSpansIntoHorizontalCells(line.spans, bodyFontSize));

  const isCaptionLine = (idx: number): boolean => CAPTION_PREFIX_RE.test(lines[idx]!.plainText.trim());

  const isStrongTabularLine = (idx: number): boolean => {
    const cells = lineCells[idx]!;
    if (isCaptionLine(idx) || lines[idx]!.hasRotatedSpan) return false;
    if (cells.length >= 3) return true;
    if (cells.length === 2) {
      const c0 = cells[0]!;
      const c1 = cells[1]!;
      if (BULLET_CELL_RE.test(c0.text.trim())) return false;
      if (EQUATION_NUM_CELL_RE.test(c1.text.trim())) return false;
      const gap = c1.x0 - c0.x1;
      if (gap >= Math.max(12, bodyFontSize * 1.35) && (c0.x1 - c0.x0) < colWidth * 0.58) {
        return true;
      }
    }
    return false;
  };

  const isWideProseLine = (idx: number): boolean => {
    const line = lines[idx]!;
    const cells = lineCells[idx]!;
    if (cells.length !== 1) return false;
    const width = line.x1 - line.x0;
    return width >= colWidth * 0.68 && line.proseWordCount >= 7 && line.mathRatio < 0.25;
  };

  const isTableBridgeSubLine = (idx: number, tableX0: number, tableX1: number): boolean => {
    if (isCaptionLine(idx) || isWideProseLine(idx) || lines[idx]!.hasRotatedSpan) return false;
    const line = lines[idx]!;
    const cells = lineCells[idx]!;
    if (cells.length === 0) return false;
    // Allow narrow sub-lines (wrapped cell text, stacked fraction parts, exponents, spanning headers)
    // that fall horizontally inside the table footprint.
    const withinX = line.x0 >= tableX0 - bodyFontSize * 2.5 && line.x1 <= tableX1 + bodyFontSize * 2.5;
    if (!withinX) return false;
    if (line.proseWordCount >= 9 && /[.?!。！？]$/.test(line.plainText.trim())) return false;
    return true;
  };

  const out: ReconstructedLine[] = [];
  let i = 0;

  while (i < lines.length) {
    if (!isStrongTabularLine(i)) {
      out.push(lines[i]!);
      i += 1;
      continue;
    }

    // Grow contiguous tabular run forward
    let end = i;
    let tableX0 = lines[i]!.x0;
    let tableX1 = lines[i]!.x1;
    let j = i + 1;

    while (j < lines.length) {
      const prevLine = lines[end]!;
      const cand = lines[j]!;
      const vGap = cand.y0 - prevLine.y1;
      if (vGap > Math.max(24, bodyFontSize * 2.6)) break;
      if (isCaptionLine(j) || isWideProseLine(j)) break;

      if (isStrongTabularLine(j)) {
        end = j;
        tableX0 = Math.min(tableX0, cand.x0);
        tableX1 = Math.max(tableX1, cand.x1);
        j += 1;
        continue;
      }

      // Bridge up to 2 short sub-lines (exponents, fraction denominators, wrapped cells)
      // when followed closely by another tabular row, OR absorb a trailing wrapped cell line
      // aligned tightly beneath the last tabular row.
      if (isTableBridgeSubLine(j, tableX0, tableX1)) {
        let nextStrong = -1;
        for (let k = j + 1; k <= Math.min(lines.length - 1, j + 2); k += 1) {
          if (lines[k]!.y0 - lines[k - 1]!.y1 > Math.max(20, bodyFontSize * 2.2)) break;
          if (isCaptionLine(k) || isWideProseLine(k)) break;
          if (isStrongTabularLine(k)) {
            nextStrong = k;
            break;
          }
        }
        if (nextStrong !== -1) {
          for (let k = j; k <= nextStrong; k += 1) {
            tableX0 = Math.min(tableX0, lines[k]!.x0);
            tableX1 = Math.max(tableX1, lines[k]!.x1);
          }
          end = nextStrong;
          j = nextStrong + 1;
          continue;
        }
        // Check tight trailing continuation line (e.g. last wrapped line of bottom row cell)
        if (vGap <= Math.max(7, bodyFontSize * 0.78) && (cand.x1 - cand.x0) < (tableX1 - tableX0) * 0.65) {
          end = j;
          tableX0 = Math.min(tableX0, cand.x0);
          tableX1 = Math.max(tableX1, cand.x1);
          j += 1;
          continue;
        }
      }
      break;
    }

    // Absorb up to 3 spanning header rows immediately above the table (e.g. multi-level column headers)
    let start = i;
    for (let back = 0; back < 3 && out.length > 0; back += 1) {
      const prevOut = out.at(-1)!;
      const prevGap = lines[start]!.y0 - prevOut.y1;
      const prevCells = splitSpansIntoHorizontalCells(prevOut.spans, bodyFontSize);
      const isShortHeader = !prevOut.isTableBlock
        && !prevOut.hasRotatedSpan
        && !CAPTION_PREFIX_RE.test(prevOut.plainText.trim())
        && prevGap >= -4
        && prevGap <= Math.max(20, bodyFontSize * 2.2)
        && prevOut.x0 >= tableX0 - bodyFontSize * 2.5
        && prevOut.x1 <= tableX1 + bodyFontSize * 2.5
        && (prevCells.length >= 2 || (prevOut.proseWordCount <= 5 && prevOut.x1 - prevOut.x0 <= (tableX1 - tableX0) * 0.85))
        && !/[.?!。！？]$/.test(prevOut.plainText.trim());
      if (!isShortHeader) break;
      out.pop();
      start -= 1;
      tableX0 = Math.min(tableX0, prevOut.x0);
      tableX1 = Math.max(tableX1, prevOut.x1);
    }

    const runLines = lines.slice(start, end + 1);
    const runCellRows = runLines.map((l) => splitSpansIntoHorizontalCells(l.spans, bodyFontSize));
    const strongRows = runCellRows.filter((cells) => cells.length >= 2).length;
    const rowsWith3Plus = runCellRows.filter((cells) => cells.length >= 3).length;
    const allCells = runCellRows.flat();
    const colBands = clusterColumnBands(allCells, bodyFontSize);
    const alignedBands = colBands.filter((b) => b.hits >= 2);
    const TABLE_CAPTION_RE = /^(?:Table|Tab\.|Algorithm|Listing|表)\s*\d+(?:\.\d+)?(?:\s*[:.：—–-]|\s|$)/i;
    const nearbyCaption = (start > 0 && TABLE_CAPTION_RE.test(lines[start - 1]!.plainText.trim())
      && lines[start]!.y0 - lines[start - 1]!.y1 <= Math.max(36, bodyFontSize * 4))
      || (end + 1 < lines.length && TABLE_CAPTION_RE.test(lines[end + 1]!.plainText.trim())
        && lines[end + 1]!.y0 - lines[end]!.y1 <= Math.max(36, bodyFontSize * 4));

    // Guard against side-by-side vector chart y-axis tick columns above a "Figure N." caption
    let hasNearbyFigureCaptionBelow = false;
    if (rowsWith3Plus === 0 && !nearbyCaption && runLines.every((l) => l.fontSize <= bodyFontSize * 0.94)) {
      for (let k = end + 1; k < Math.min(lines.length, end + 10); k += 1) {
        const nextLine = lines[k]!;
        if (nextLine.y0 - runLines.at(-1)!.y1 > pageHeight * 0.22) break;
        if (FIGURE_CAPTION_RE.test(nextLine.plainText.trim())) {
          hasNearbyFigureCaptionBelow = true;
          break;
        }
        if (nextLine.proseWordCount >= 4 && !nextLine.hasRotatedSpan) break;
      }
    }

    const numericCells = allCells.filter(isNumericOrCodeCell).length;
    const mathCells = allCells.filter(isMathBearingCell).length;
    const numericCellRatio = numericCells / Math.max(1, allCells.length);
    const mathCellRatio = mathCells / Math.max(1, allCells.length);
    const combinedText = runLines.map((l) => l.plainText).join(" ");

    // Anti-false-positive guards:
    const isPage1AuthorBlock = pageNumber === 1
      && runLines[0]!.y0 < pageHeight * 0.38
      && !nearbyCaption
      && AUTHOR_AFFILIATION_RE.test(combinedText)
      && numericCellRatio < 0.15;

    const isDisplayEquationStack = rowsWith3Plus === 0
      && runLines.every((l) => l.isDisplayFormula || l.isMathFragment || l.mathRatio >= 0.55)
      && /[=≈≤≥≠]/.test(combinedText)
      && !nearbyCaption;

    const hasEnoughRows = (strongRows >= 3 && alignedBands.length >= 2 && allCells.length >= 6)
      || (rowsWith3Plus >= 2 && alignedBands.length >= 3 && (nearbyCaption || strongRows >= 3));

    if (!hasEnoughRows || isPage1AuthorBlock || isDisplayEquationStack || hasNearbyFigureCaptionBelow) {
      for (const l of runLines) out.push(l);
      i = end + 1;
      continue;
    }

    // Two-tier classification: snapshot vs translatable HTML table
    const colCount = alignedBands.length;
    const totalProseWords = allCells.reduce((sum, c) => sum + countProseWords(c.text), 0);

    // Try mapping rows cleanly to aligned column bands for HTML reconstruction
    let mappedCount = 0;
    const mappedGrid: Array<{
      cells: Array<{ spans: PositionedSpan[]; x0: number; y0: number; x1: number; y1: number; fontSize: number } | null>;
      y0: number;
      y1: number;
      isBold: boolean;
    }> = [];

    for (let rIdx = 0; rIdx < runLines.length; rIdx += 1) {
      const cells = runCellRows[rIdx]!;
      const line = runLines[rIdx]!;
      const rowSlots: Array<{ spans: PositionedSpan[]; x0: number; y0: number; x1: number; y1: number; fontSize: number } | null> =
        new Array(colCount).fill(null);

      for (const cell of cells) {
        const cellMid = (cell.x0 + cell.x1) / 2;
        let bestCol = -1;
        let bestScore = -Infinity;
        for (let ci = 0; ci < colCount; ci += 1) {
          const band = alignedBands[ci]!;
          const overlap = Math.min(cell.x1, band.x1) - Math.max(cell.x0, band.x0);
          const dist = Math.abs(cellMid - (band.x0 + band.x1) / 2);
          const score = overlap >= -4 ? overlap + 1000 : -dist;
          if (score > bestScore && (overlap >= -8 || dist <= Math.max(24, bodyFontSize * 2.5))) {
            bestScore = score;
            bestCol = ci;
          }
        }
        if (bestCol >= 0) {
          mappedCount += 1;
          const existing = rowSlots[bestCol];
          if (existing) {
            existing.spans.push(...cell.spans);
            existing.x0 = Math.min(existing.x0, cell.x0);
            existing.y0 = Math.min(existing.y0, cell.y0);
            existing.x1 = Math.max(existing.x1, cell.x1);
            existing.y1 = Math.max(existing.y1, cell.y1);
          } else {
            rowSlots[bestCol] = {
              spans: [...cell.spans],
              x0: cell.x0,
              y0: cell.y0,
              x1: cell.x1,
              y1: cell.y1,
              fontSize: cell.fontSize,
            };
          }
        }
      }

      const filledCols = rowSlots.filter(Boolean).length;
      if (filledCols === 0) continue;

      const prevRow = mappedGrid.at(-1);
      const vGap = prevRow ? line.y0 - prevRow.y1 : Infinity;
      const tightWrapGap = Math.max(7, bodyFontSize * 0.78);

      // Case A: vertically centered / sparse column label filling empty slot(s) of prevRow
      // (e.g., single-line col-0 label centered vertically beside a 2-line col-1/col-2 row).
      const fillsEmptySlots = Boolean(
        prevRow
        && vGap <= tightWrapGap
        && prevRow.isBold === line.isBold
        && rowSlots.every((slot, ci) => !slot || prevRow.cells[ci] === null),
      );

      // Case B: standard wrapped continuation where col 0 is empty and filled slots continue existing cells.
      const isPartialContinuation = Boolean(
        prevRow
        && vGap <= tightWrapGap
        && prevRow.isBold === line.isBold
        && filledCols < colCount
        && rowSlots[0] === null
        && rowSlots.every((slot, ci) => !slot || prevRow.cells[ci] !== null),
      );

      // Case C: multi-line wrapped prose row where all (or col 0 + other) columns wrap onto a second line
      // tightly beneath prevRow (e.g. "Side-by-side" / "reader" | "Clear ... for" / "careful study").
      let isFullRowWrapContinuation = false;
      if (
        prevRow
        && !fillsEmptySlots
        && !isPartialContinuation
        && vGap <= tightWrapGap
        && prevRow.isBold === line.isBold
        && !(mappedGrid.length === 1 && prevRow.isBold)
      ) {
        let overlapCount = 0;
        let continuationSignals = 0;
        for (let ci = 0; ci < colCount; ci += 1) {
          const prevSlot = prevRow.cells[ci];
          const curSlot = rowSlots[ci];
          if (!prevSlot || !curSlot) continue;
          overlapCount += 1;
          const prevText = prevSlot.spans.map((s) => s.text).join(" ").replace(/\s+/g, " ").trim();
          const curText = curSlot.spans.map((s) => s.text).join(" ").replace(/\s+/g, " ").trim();
          const prevW = prevSlot.x1 - prevSlot.x0;
          const curW = curSlot.x1 - curSlot.x0;
          const startsLower = /^[a-z]/.test(curText);
          const prevHyphen = /[A-Za-z]-$/.test(prevText);
          const prevUnfinished = !/[.?!。！？:：]$/.test(prevText)
            && (/\b(?:for|on|in|of|to|with|from|into|inside|per|the|a|an|and|or|as|by|at|that|which)$/i.test(prevText)
              || (countProseWords(prevText) >= 4 && curW < prevW * 0.72));
          if (startsLower || prevHyphen || prevUnfinished) {
            continuationSignals += 1;
          }
        }
        if (overlapCount >= 2 && continuationSignals >= 2) {
          isFullRowWrapContinuation = true;
        }
      }

      if ((fillsEmptySlots || isPartialContinuation || isFullRowWrapContinuation) && prevRow) {
        for (let ci = 0; ci < colCount; ci += 1) {
          const slot = rowSlots[ci];
          if (!slot) continue;
          const prevSlot = prevRow.cells[ci];
          if (prevSlot) {
            prevSlot.spans.push(...slot.spans);
            prevSlot.x0 = Math.min(prevSlot.x0, slot.x0);
            prevSlot.y0 = Math.min(prevSlot.y0, slot.y0);
            prevSlot.x1 = Math.max(prevSlot.x1, slot.x1);
            prevSlot.y1 = Math.max(prevSlot.y1, slot.y1);
          } else {
            prevRow.cells[ci] = slot;
          }
        }
        prevRow.y0 = Math.min(prevRow.y0, line.y0);
        prevRow.y1 = Math.max(prevRow.y1, line.y1);
      } else {
        mappedGrid.push({ cells: rowSlots, y0: line.y0, y1: line.y1, isBold: line.isBold });
      }
    }

    const mappingCleanRatio = mappedCount / Math.max(1, allCells.length);
    const shouldSnapshot = colCount >= 5
      || numericCellRatio >= 0.42
      || mathCellRatio >= 0.28
      || mappingCleanRatio < 0.78
      || mappedGrid.length < 2
      || totalProseWords < 4;

    const unionX0 = Math.min(...runLines.map((l) => l.x0));
    const unionY0 = Math.min(...runLines.map((l) => l.y0));
    const unionX1 = Math.max(...runLines.map((l) => l.x1));
    const unionY1 = Math.max(...runLines.map((l) => l.y1));
    const allSpans = runLines.flatMap((l) => l.spans);
    const tableFontSize = median(runLines.map((l) => l.fontSize), bodyFontSize);

    if (shouldSnapshot) {
      out.push({
        spans: allSpans,
        x0: unionX0,
        y0: unionY0,
        x1: unionX1,
        y1: unionY1,
        baselineY: unionY1,
        fontSize: tableFontSize,
        isBold: false,
        column: runLines[0]!.column,
        segments: [{ kind: "text", text: combinedText }],
        plainText: combinedText,
        mathRatio: mathCellRatio,
        proseWordCount: totalProseWords,
        isDisplayFormula: false,
        isMathFragment: false,
        isTableBlock: true,
        tableMode: "snapshot",
      });
    } else {
      const tableRows: PdfInlineSegment[][][] = [];
      const tableCellBoxes: PdfTableCellBox[] = [];
      for (let ri = 0; ri < mappedGrid.length; ri += 1) {
        const gridRow = mappedGrid[ri]!;
        const rowSegments: PdfInlineSegment[][] = [];
        for (let ci = 0; ci < colCount; ci += 1) {
          const slot = gridRow.cells[ci];
          if (!slot) {
            rowSegments.push([]);
            continue;
          }
          // Cluster wrapped sub-lines inside the cell top-to-bottom so multi-line prose joins cleanly
          const subClusters = clusterSpansByBaseline(slot.spans);
          const mergedSegs: PdfInlineSegment[] = [];
          for (const sub of subClusters) {
            const subBase = median(sub.map((s) => s.baselineY), sub[0]!.baselineY);
            const subFs = median(sub.map((s) => s.fontSize), slot.fontSize);
            const { segments: subSegs } = buildLineSegments(sub, subBase, subFs);
            if (mergedSegs.length === 0) mergedSegs.push(...subSegs);
            else joinSegmentsWithHyphenRepair(mergedSegs, subSegs);
          }
          rowSegments.push(mergedSegs);
          tableCellBoxes.push({
            rowIndex: ri,
            colIndex: ci,
            box: {
              x: slot.x0,
              y: slot.y0,
              width: Math.max(4, slot.x1 - slot.x0),
              height: Math.max(6, slot.y1 - slot.y0),
            },
            fontSize: slot.fontSize,
          });
        }
        tableRows.push(rowSegments);
      }

      const firstRow = mappedGrid[0]!;
      const firstRowMaxWords = Math.max(
        0,
        ...tableRows[0]!.map((segs) => countProseWords(segs.map((s) => s.text).join(""))),
      );
      const bodyMaxWords = Math.max(
        0,
        ...tableRows.slice(1).flat().map((segs) => countProseWords(segs.map((s) => s.text).join(""))),
      );
      const tableHasHeader = firstRow.isBold || (firstRowMaxWords <= 4 && bodyMaxWords >= 3);

      out.push({
        spans: allSpans,
        x0: unionX0,
        y0: unionY0,
        x1: unionX1,
        y1: unionY1,
        baselineY: unionY1,
        fontSize: tableFontSize,
        isBold: false,
        column: runLines[0]!.column,
        segments: [{ kind: "text", text: combinedText }],
        plainText: combinedText,
        mathRatio: mathCellRatio,
        proseWordCount: totalProseWords,
        isDisplayFormula: false,
        isMathFragment: false,
        isTableBlock: true,
        tableMode: "html",
        tableRows,
        tableHasHeader,
        tableCellBoxes,
      });
    }

    i = end + 1;
  }

  return out;
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
      ...(isRotatedVertical ? { isRotatedVertical: true } : {}),
      baselineY,
    });
  }

  if (spans.length === 0) return [];

  const bodyFontSize = computeBodyFontSize(spans);
  const gutter = detectTwoColumnGutter(spans, pageWidth, bodyFontSize);

  // Detect full-width multi-column table Y-bands across ALL spans (including compact 7pt tables like ResNet Table 1)
  // before splitting into left/right column streams.
  const fullWidthTableBands = gutter
    ? detectFullWidthTableYBands(clusterSpansByBaseline(spans), gutter, pageWidth, bodyFontSize)
    : [];

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

  const isInsideFullWidthTableBand = (cluster: readonly PositionedSpan[]): boolean => {
    if (fullWidthTableBands.length === 0) return false;
    const cy = median(cluster.map((s) => s.y + s.height / 2), cluster[0]!.y);
    const joined = cluster.map((s) => s.text).join(" ").trim();
    if (CAPTION_PREFIX_RE.test(joined)) return false;
    return fullWidthTableBands.some((band) => cy >= band.y0 - 2 && cy <= band.y1 + 2);
  };

  const lineBuckets: RawLineBucket[] = [];
  for (const cluster of mainClusters) {
    if (isInsideFullWidthTableBand(cluster)) {
      lineBuckets.push(summarizeBucket("full", cluster, bodyFontSize));
    } else {
      lineBuckets.push(...splitClusterByGutter(cluster, gutter, bodyFontSize));
    }
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
      if (isInsideFullWidthTableBand(cluster)) {
        lineBuckets.push(summarizeBucket("full", cluster, bodyFontSize));
      } else {
        lineBuckets.push(...splitClusterByGutter(cluster, gutter, bodyFontSize));
      }
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
        hasRotatedSpan: bucket.spans.some((s) => s.isRotatedVertical),
        column: col,
        segments,
        plainText,
      };
      const mathInfo = classifyLineMath(partial, colWidth, colLeftRef, bodyFontSize, pageHeight);
      lines.push({ ...partial, ...mathInfo });
    }

    lines.sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);

    // Detect two-tier tables BEFORE 2D formula coalescing so stacked fractions/brackets
    // inside numeric/architecture/derivative tables stay unified in the table block.
    const withTables = detectAndCoalesceTableLines(lines, colWidth, bodyFontSize, pageHeight, pageNumber);

    // Demote a flush-left short trailing line (e.g. "d_ff = 2048.") that directly continues an
    // unfinished prose line immediately above it with normal line spacing.
    for (let i = 1; i < withTables.length; i += 1) {
      const prev = withTables[i - 1]!;
      const cur = withTables[i]!;
      if (cur.isTableBlock || !cur.isDisplayFormula) continue;
      if (prev.isTableBlock || prev.isDisplayFormula || prev.isMathFragment || prev.proseWordCount < 3) continue;
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

    return coalesce2DFormulaLines(withTables, bodyFontSize);
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
  const pageRotatedBlockIds = new Set<string>();
  let blockIndex = 0;

  for (const stream of orderedStreams) {
    if (stream.length === 0) continue;
    const proseLinesInStream = stream.filter((l) => !l.isDisplayFormula && !l.isTableBlock && l.proseWordCount >= 2);
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
      lineBoxes: PdfPageBox[];
      lastBaselineY: number;
      fontSize: number;
      isBold: boolean;
      hasRotatedSpan: boolean;
      lineCount: number;
      listIndentX?: number;
    } | null = null;
    const rotatedBlockIds = new Set<string>();

    const flush = () => {
      if (!current) return;
      const plainText = current.segments.map((s) => s.text).join("").replace(/\s+/g, " ").trim();
      if (plainText) {
        const id = `pdf-p${pageNumber}-b${++blockIndex}`;
        if (current.hasRotatedSpan) rotatedBlockIds.add(id);
        blocks.push({
          id,
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
          lineBoxes: current.lineBoxes,
          fontSize: current.fontSize,
          source: "text-layer",
        });
      }
      current = null;
    };

    for (const line of stream) {
      if (line.isTableBlock) {
        flush();
        blocks.push({
          id: `pdf-p${pageNumber}-b${++blockIndex}`,
          pageNumber,
          kind: "table",
          column: line.column,
          segments: line.segments,
          plainText: line.plainText,
          box: {
            x: line.x0,
            y: line.y0,
            width: Math.max(4, line.x1 - line.x0),
            height: Math.max(6, line.y1 - line.y0),
          },
          fontSize: line.fontSize,
          tableMode: line.tableMode ?? "snapshot",
          ...(line.tableRows ? { tableRows: line.tableRows } : {}),
          ...(line.tableHasHeader !== undefined ? { tableHasHeader: line.tableHasHeader } : {}),
          ...(line.tableCellBoxes ? { tableCellBoxes: line.tableCellBoxes } : {}),
          source: "text-layer",
        });
        continue;
      }

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
          source: "text-layer",
        });
        continue;
      }

      const lineBox: PdfPageBox = {
        x: line.x0,
        y: line.y0,
        width: Math.max(4, line.x1 - line.x0),
        height: Math.max(6, line.y1 - line.y0),
      };

      const isNumberedHeading = /^\d+(?:\.\d+)*\.?\s+[A-Z\u4e00-\u9fff]/.test(line.plainText)
        && line.plainText.length <= 96
        && !/[.。!?]$/.test(line.plainText)
        && (line.isBold || line.fontSize >= bodyFontSize * 1.03);
      const isNamedSectionHeading = /^(?:Abstract|Introduction|Background|Related Work|Methodology|Methods|Experiments?|Results|Discussion|Conclusion|Conclusions|References|Acknowledgments?|Appendix|Overview|Summary)$/i.test(line.plainText)
        && (line.isBold || line.fontSize >= bodyFontSize * 1.02);
      const isHeading = !line.hasRotatedSpan && (
        (line.fontSize >= bodyFontSize * 1.18 && line.plainText.length <= 160 && line.mathRatio < 0.5)
        || (line.isBold && line.fontSize >= bodyFontSize * 1.02 && line.plainText.length <= 96 && !/[.。!?]$/.test(line.plainText) && line.mathRatio < 0.4)
        || isNumberedHeading
        || isNamedSectionHeading
      );
      const isListStart = !isHeading && !line.hasRotatedSpan && LIST_PREFIX_RE.test(line.plainText);
      const lineKind: PdfBlockKind = isHeading ? "heading" : isListStart ? "list-item" : "paragraph";
      const headingLevel = isHeading
        ? (line.fontSize >= bodyFontSize * 1.55 ? 1 : line.fontSize >= bodyFontSize * 1.25 ? 2 : 3)
        : undefined;

      const verticalClose = Boolean(
        current
        && !line.hasRotatedSpan
        && !current.hasRotatedSpan
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
        current.lineBoxes.push(lineBox);
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
          lineBoxes: [lineBox],
          lastBaselineY: line.baselineY,
          fontSize: line.fontSize,
          isBold: line.isBold,
          hasRotatedSpan: Boolean(line.hasRotatedSpan),
          lineCount: 1,
        };
      }
    }
    flush();

    // Transfer rotatedBlockIds onto a page-wide set across streams
    for (const id of rotatedBlockIds) pageRotatedBlockIds.add(id);
  }

  return coalesceDigitalFigureBlocks(blocks, pageRotatedBlockIds, bodyFontSize, pageWidth, pageHeight, pageNumber);
}

const FIGURE_CAPTION_RE = /^(?:Figure|Fig\.|图)\s*\d+(?:\.\d+)?(?:\s*[:.：—–-]|\s|$)/i;

/**
 * Collapses scattered vector-chart axis ticks, legends, and 90°-rotated axis titles
 * sitting directly above a `Figure N.` caption into a single protected `figure` snapshot block
 * so digital PDF charts stay crisp and untouched in both split and overlay modes.
 */
function coalesceDigitalFigureBlocks(
  blocks: PdfLayoutBlock[],
  rotatedBlockIds: ReadonlySet<string>,
  bodyFontSize: number,
  pageWidth: number,
  pageHeight: number,
  pageNumber: number,
): PdfLayoutBlock[] {
  if (blocks.length < 3) return blocks;

  const isChartLabelCandidate = (b: PdfLayoutBlock): boolean => {
    if (b.kind === "table" || b.kind === "heading" || b.kind === "list-item" || b.kind === "figure") return false;
    const text = b.plainText.trim();
    if (!text || CAPTION_PREFIX_RE.test(text)) return false;
    if (rotatedBlockIds.has(b.id)) return true;
    if (b.kind === "formula") {
      return b.fontSize <= bodyFontSize * 0.94 && text.length <= 32 && !EQUATION_TAG_RE.test(text);
    }
    const proseWords = countProseWords(text);
    const endsSentence = /[.?!。！？]$/.test(text);
    if (endsSentence) return false;
    if (text.length <= 44 && /^[\d.,\s+-]+$/.test(text)) return true;
    if (b.fontSize <= bodyFontSize * 0.94 && text.length <= 72 && proseWords <= 4) return true;
    return false;
  };

  const removedIds = new Set<string>();
  const insertBeforeCaption = new Map<string, PdfLayoutBlock>();
  let figIndex = 0;

  for (const caption of blocks) {
    if (caption.kind !== "paragraph" || !FIGURE_CAPTION_RE.test(caption.plainText.trim())) continue;
    const maxLookbackY = Math.max(0, caption.box.y - pageHeight * 0.44);
    const sameColumnScope = (b: PdfLayoutBlock): boolean =>
      caption.column === "full" || b.column === caption.column || b.column === "full";

    // Find the lowest non-chart barrier above this caption inside the lookback window
    let aboveBarrierY = maxLookbackY;
    for (const b of blocks) {
      if (b.id === caption.id || removedIds.has(b.id) || !sameColumnScope(b)) continue;
      const bBottom = b.box.y + b.box.height;
      if (bBottom > caption.box.y + 4 || bBottom < maxLookbackY) continue;
      if (!isChartLabelCandidate(b)) {
        aboveBarrierY = Math.max(aboveBarrierY, bBottom);
      }
    }

    const candidates: PdfLayoutBlock[] = [];
    for (const b of blocks) {
      if (b.id === caption.id || removedIds.has(b.id) || !sameColumnScope(b)) continue;
      if (b.box.y < aboveBarrierY - 2 || b.box.y + b.box.height > caption.box.y + 4) continue;
      if (isChartLabelCandidate(b)) candidates.push(b);
    }

    const hasRotated = candidates.some((b) => rotatedBlockIds.has(b.id));
    if (candidates.length >= 4 || (hasRotated && candidates.length >= 2)) {
      let minX = Number.POSITIVE_INFINITY;
      let minY = Number.POSITIVE_INFINITY;
      let maxX = Number.NEGATIVE_INFINITY;
      let maxY = Number.NEGATIVE_INFINITY;
      for (const c of candidates) {
        removedIds.add(c.id);
        minX = Math.min(minX, c.box.x);
        minY = Math.min(minY, c.box.y);
        maxX = Math.max(maxX, c.box.x + c.box.width);
        maxY = Math.max(maxY, c.box.y + c.box.height);
      }
      const x0 = Math.max(0, minX - 14);
      const x1 = Math.min(pageWidth, maxX + 14);
      const y0 = Math.max(aboveBarrierY + 2, minY - 14);
      const y1 = Math.min(caption.box.y - 2, maxY + 4);
      if (x1 > x0 + 10 && y1 > y0 + 10) {
        insertBeforeCaption.set(caption.id, {
          id: `pdf-p${pageNumber}-fig${++figIndex}`,
          pageNumber,
          kind: "figure",
          column: caption.column,
          segments: [{ kind: "text", text: "[Figure]" }],
          plainText: "[Figure]",
          box: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 },
          fontSize: bodyFontSize,
          source: "text-layer",
        });
      }
    }
  }

  if (removedIds.size === 0) return blocks;
  const out: PdfLayoutBlock[] = [];
  for (const b of blocks) {
    if (removedIds.has(b.id)) continue;
    const fig = insertBeforeCaption.get(b.id);
    if (fig) out.push(fig);
    out.push(b);
  }
  return out;
}
