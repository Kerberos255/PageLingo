/**
 * Layout-preserving & formula-aware PDF text reconstruction.
 * Converts raw pdf.js getTextContent() positioned glyph runs into clean
 * reading-order blocks (headings, paragraphs, lists, display formulas) with
 * inline math spans protected as non-translatable tokens and exact page boxes.
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

export interface PdfInlineSegment {
  kind: "text" | "math";
  text: string;
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
  isMathFont: boolean;
  isBoldFont: boolean;
  baselineY: number;
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
  isDisplayFormula: boolean;
}

const MATH_FONT_RE = /(?:cmmi|cmsy|cmex|msam|msbm|cmr\d|stix|cambria\s*math|latin\s*modern\s*math|lmmath|mathjax|tex-math|eufr|eufm|wasy|stmary|mtmi|mtsy|symbol|txsy|txmi|pxsy|pxmi|rtxmi|rtxr)/i;
const BOLD_FONT_RE = /(?:bold|black|heavy|semibold|demibold|cmbx|NimbusSanL-Bold|Helvetica-Bold|Times-Bold|[-_]B\b)/i;
const UNICODE_MATH_RE = /[∑∏∫∬∮∂∇∞±∓×÷≤≥≠≈≡≅∝∈∉∋⊂⊃⊆⊇∪∩∧∨¬∀∃→←↔⇒⇐⇔↦√∛∠⊥∥‖∣⟨⟩⌈⌉⌊⌋−′″△□○⊕⊗⊙ℓℏℝℂℤℕℚα-ωΑ-Ωϑφϕϖϱς\u00B2\u00B3\u00B9\u2070-\u209F\u1D2C-\u1D6A]/u;
const PAGE_NUMBER_RE = /^(?:[-–—]\s*)?(?:page\s*)?\d{1,4}(?:\s*(?:of|\/)\s*\d{1,4})?(?:\s*[-–—])?$/i;
const EQUATION_TAG_RE = /\(\d+(?:\.\d+)?\)\s*$/;
const LIST_PREFIX_RE = /^(?:[•●◦▪▫▸▹–—*-]|(?:\(?\d{1,3}[.)])|(?:\([a-zA-Z]\)))\s+/;

function median(values: readonly number[], fallback: number): number {
  const valid = values.filter((v) => Number.isFinite(v) && v > 0).sort((a, b) => a - b);
  if (valid.length === 0) return fallback;
  return valid[Math.floor(valid.length / 2)]!;
}

function isMathLikeToken(span: PositionedSpan, lineBaselineY: number, lineFontSize: number): boolean {
  const trimmed = span.text.trim();
  if (!trimmed) return false;
  if (span.isMathFont) return true;
  if (UNICODE_MATH_RE.test(trimmed)) return true;

  // Subscript or superscript micro-span shifted from baseline
  const verticalShift = Math.abs(span.baselineY - lineBaselineY);
  if (
    span.fontSize <= lineFontSize * 0.82
    && verticalShift >= lineFontSize * 0.16
    && trimmed.length <= 12
    && /^[A-Za-z0-9+\-*/=(),ijkmnxyzT⊤′'∗*]+$/u.test(trimmed)
  ) {
    return true;
  }

  // Inline compact math expression like "f(x) = Wx + b" or "d_k = 64" or "O(n log n)"
  if (
    /[=≈≤≥≠±×÷∑∫∂∇→⇒√^]/.test(trimmed)
    && trimmed.length <= 72
    && !/\b(?:the|and|for|with|that|this|from|have|which|where|when|into)\b/i.test(trimmed)
  ) {
    return true;
  }
  return false;
}

function classifyDisplayFormula(line: Omit<ReconstructedLine, "isDisplayFormula">, pageWidth: number, bodyFontSize: number): boolean {
  const text = line.plainText.trim();
  if (!text) return false;

  const totalChars = text.replace(/\s+/g, "").length;
  if (totalChars === 0) return false;

  const mathChars = line.segments
    .filter((s) => s.kind === "math")
    .reduce((sum, s) => sum + s.text.replace(/\s+/g, "").length, 0);
  const mathRatio = mathChars / totalChars;

  const proseWords = (text.match(/\b[A-Za-z]{4,}\b/g) ?? []).filter(
    (w) => !/^(?:softmax|argmax|argmin|sigmoid|tanh|relu|exp|log|sin|cos|tan|min|max|lim|sup|inf|det|dim|diag|norm|loss|Attention|LayerNorm|MultiHead|Concat|FFN)$/i.test(w),
  );

  // Equation with right-aligned equation number e.g. "(1)" or "(2.4)"
  if (EQUATION_TAG_RE.test(text) && (mathRatio >= 0.25 || /[=≈≤≥∑∫√]/.test(text)) && proseWords.length <= 4) {
    return true;
  }

  // Standalone math equation line (e.g., "Attention(Q, K, V) = softmax(QK^T / √d_k) V")
  const hasEquationOp = /[=≈≤≥≠≡→⇒∑∏∫∂∇√]/.test(text);
  const lineWidth = line.x1 - line.x0;
  const centeredOrIndented = line.x0 > pageWidth * 0.14 || lineWidth < pageWidth * 0.65;
  if (hasEquationOp && proseWords.length <= 2 && totalChars <= 96 && (mathRatio >= 0.32 || centeredOrIndented)) {
    return true;
  }

  // Pure symbol/math font line (not a heading)
  if (mathRatio >= 0.68 && line.fontSize <= bodyFontSize * 1.25 && proseWords.length <= 1) {
    return true;
  }

  return false;
}

function buildLineSegments(spans: readonly PositionedSpan[], lineBaselineY: number, lineFontSize: number): {
  segments: PdfInlineSegment[];
  plainText: string;
} {
  const sorted = [...spans].sort((a, b) => a.x - b.x);
  const rawSegments: PdfInlineSegment[] = [];
  let prevEnd = -Infinity;

  for (const span of sorted) {
    if (!span.text) continue;
    const gap = span.x - prevEnd;
    const spaceThreshold = Math.max(1.2, span.fontSize * 0.16);
    const needsSpace = prevEnd > -Infinity && gap > spaceThreshold
      && !/^\s/.test(span.text)
      && rawSegments.length > 0
      && !/\s$/.test(rawSegments.at(-1)!.text);

    const isMath = isMathLikeToken(span, lineBaselineY, lineFontSize);
    const kind: "text" | "math" = isMath ? "math" : "text";

    if (needsSpace) {
      const prev = rawSegments.at(-1)!;
      if (prev.kind === "math" && kind === "math") {
        prev.text += " ";
      } else {
        rawSegments.push({ kind: "text", text: " " });
      }
    }

    const last = rawSegments.at(-1);
    if (last && last.kind === kind) {
      last.text += span.text;
    } else {
      rawSegments.push({ kind, text: span.text });
    }
    prevEnd = Math.max(prevEnd, span.x + span.width);
  }

  // Expand inline math tokens to catch short adjacent variables / parens like "x = 1" or "O(n log n)"
  const merged: PdfInlineSegment[] = [];
  for (const seg of rawSegments) {
    const last = merged.at(-1);
    if (last && last.kind === seg.kind) {
      last.text += seg.text;
    } else {
      merged.push({ ...seg });
    }
  }

  // Also detect inline math expressions inside text segments (e.g. `O(n^2)`, `α = 0.05`, `E = mc²`, `d_k`)
  const refined: PdfInlineSegment[] = [];
  const inlineFormulaRe = /((?:[A-Za-z][A-Za-z0-9_]*\([^()\n]{1,24}\)\s*[=≈≤≥]\s*[^\s,;。]+(?:\s*[+\-*/·]\s*[^\s,;。]+)*)|(?:[A-Za-zα-ωΑ-Ω][A-Za-z0-9_′']*[\^_][A-Za-z0-9{}()+\-]+)|(?:[OΘΩ]\([^()\n]{1,24}\)))/gu;

  for (const seg of merged) {
    if (seg.kind === "math") {
      refined.push(seg);
      continue;
    }
    let cursor = 0;
    let m: RegExpExecArray | null;
    while ((m = inlineFormulaRe.exec(seg.text)) !== null) {
      if (m.index > cursor) refined.push({ kind: "text", text: seg.text.slice(cursor, m.index) });
      refined.push({ kind: "math", text: m[0] });
      cursor = m.index + m[0].length;
    }
    if (cursor < seg.text.length) refined.push({ kind: "text", text: seg.text.slice(cursor) });
  }

  // Re-coalesce adjacent segments of the same kind
  const finalSegments: PdfInlineSegment[] = [];
  for (const seg of refined) {
    if (!seg.text) continue;
    const prev = finalSegments.at(-1);
    if (prev && prev.kind === seg.kind) prev.text += seg.text;
    else finalSegments.push(seg);
  }

  const plainText = finalSegments.map((s) => s.text).join("").replace(/\s+/g, " ").trim();
  return { segments: finalSegments, plainText };
}

function detectTwoColumnSplitX(
  spans: readonly PositionedSpan[],
  pageWidth: number,
  bodyFontSize: number,
): number | null {
  if (spans.length < 10 || pageWidth < 360) return null;
  const searchStart = Math.floor(pageWidth * 0.38);
  const searchEnd = Math.ceil(pageWidth * 0.62);
  const bins = new Uint16Array(Math.ceil(pageWidth) + 2);

  // Filter to body-sized, single-column-width spans so centered title/author headers never mask the gutter
  const bodySpans = spans.filter(
    (span) => span.width <= pageWidth * 0.50 && span.fontSize <= bodyFontSize * 1.18,
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
  return splitX;
}

function joinSegmentsWithHyphenRepair(
  target: PdfInlineSegment[],
  nextLine: readonly PdfInlineSegment[],
): void {
  if (nextLine.length === 0) return;
  const firstNext = nextLine[0]!;
  const lastTarget = target.at(-1);

  if (
    lastTarget
    && lastTarget.kind === "text"
    && firstNext.kind === "text"
    && /[A-Za-z]-$/.test(lastTarget.text.trimEnd())
    && /^[a-z]/.test(firstNext.text.trimStart())
  ) {
    // Rejoin soft hyphenated word across PDF line wrap: "trans-" + "formation" -> "transformation"
    lastTarget.text = lastTarget.text.trimEnd().slice(0, -1) + firstNext.text.trimStart();
    for (let i = 1; i < nextLine.length; i += 1) {
      const seg = nextLine[i]!;
      const prev = target.at(-1);
      if (prev && prev.kind === seg.kind) prev.text += seg.text;
      else target.push({ ...seg });
    }
    return;
  }

  // CJK text should not insert an artificial space across wrapped lines.
  const prevEndText = lastTarget?.text.trimEnd() ?? "";
  const nextStartText = firstNext.text.trimStart();
  const cjkJoin = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]$/u.test(prevEndText)
    && /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(nextStartText);

  if (lastTarget && lastTarget.kind === "text" && firstNext.kind === "text") {
    lastTarget.text = prevEndText + (cjkJoin ? "" : " ") + nextStartText;
    for (let i = 1; i < nextLine.length; i += 1) {
      const seg = nextLine[i]!;
      const prev = target.at(-1);
      if (prev && prev.kind === seg.kind) prev.text += seg.text;
      else target.push({ ...seg });
    }
    return;
  }

  if (!cjkJoin && target.length > 0) {
    const prev = target.at(-1)!;
    if (prev.kind === "text") prev.text = prev.text.trimEnd() + " ";
    else target.push({ kind: "text", text: " " });
  }
  for (const seg of nextLine) {
    const prev = target.at(-1);
    if (prev && prev.kind === seg.kind) prev.text += seg.text;
    else target.push({ ...seg });
  }
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
    if (!item || typeof item.str !== "string" || !item.str.trim()) continue;
    const t = item.transform;
    if (!Array.isArray(t) || t.length < 6) continue;
    const fontSize = Math.max(4, Math.hypot(t[0] ?? 0, t[1] ?? 0) || Math.hypot(t[2] ?? 0, t[3] ?? 0) || item.height || 10);
    const height = Math.max(fontSize, item.height || fontSize);
    const width = Math.max(1, item.width || item.str.length * fontSize * 0.45);
    const x = t[4] ?? 0;
    const baselineY = pageHeight - (t[5] ?? 0);
    const y = Math.max(0, baselineY - height * 0.85);
    const fontName = item.fontName ?? "";
    const fontFamily = styles?.[fontName]?.fontFamily ?? "";
    const fontMeta = `${fontName} ${fontFamily}`;

    spans.push({
      text: item.str,
      x,
      y,
      width,
      height,
      fontSize,
      fontName,
      fontFamily,
      isMathFont: MATH_FONT_RE.test(fontMeta),
      isBoldFont: BOLD_FONT_RE.test(fontMeta),
      baselineY,
    });
  }

  if (spans.length === 0) return [];

  const bodyFontSize = median(spans.map((s) => s.fontSize), 11);
  const splitX = detectTwoColumnSplitX(spans, pageWidth, bodyFontSize);

  const assignColumn = (span: PositionedSpan): "full" | "left" | "right" => {
    if (splitX === null) return "full";
    const spanRight = span.x + span.width;
    if (span.x < splitX - 18 && spanRight > splitX + 18) return "full";
    if (spanRight <= splitX + 8) return "left";
    if (span.x >= splitX - 8) return "right";
    return span.x + span.width / 2 < splitX ? "left" : "right";
  };

  // Group spans into horizontal lines within each column bucket
  const groupedSpans: Record<"full" | "left" | "right", PositionedSpan[]> = {
    full: [],
    left: [],
    right: [],
  };
  for (const span of spans) {
    groupedSpans[assignColumn(span)].push(span);
  }

  const buildLinesForColumn = (
    col: "full" | "left" | "right",
    colSpans: PositionedSpan[],
  ): ReconstructedLine[] => {
    if (colSpans.length === 0) return [];
    const sorted = [...colSpans].sort((a, b) => a.baselineY - b.baselineY || a.x - b.x);
    const rawLines: PositionedSpan[][] = [];

    for (const span of sorted) {
      let placed = false;
      for (let i = rawLines.length - 1; i >= Math.max(0, rawLines.length - 4); i -= 1) {
        const line = rawLines[i]!;
        const refBaseline = median(line.map((s) => s.baselineY), line[0]!.baselineY);
        const refSize = median(line.map((s) => s.fontSize), line[0]!.fontSize);
        if (Math.abs(span.baselineY - refBaseline) <= Math.max(3, refSize * 0.48)) {
          line.push(span);
          placed = true;
          break;
        }
      }
      if (!placed) rawLines.push([span]);
    }

    const lines: ReconstructedLine[] = [];
    for (const lineSpans of rawLines) {
      const baselineY = median(lineSpans.map((s) => s.baselineY), lineSpans[0]!.baselineY);
      const fontSize = median(lineSpans.map((s) => s.fontSize), bodyFontSize);
      const x0 = Math.min(...lineSpans.map((s) => s.x));
      const y0 = Math.min(...lineSpans.map((s) => s.y));
      const x1 = Math.max(...lineSpans.map((s) => s.x + s.width));
      const y1 = Math.max(...lineSpans.map((s) => s.y + s.height));
      const { segments, plainText } = buildLineSegments(lineSpans, baselineY, fontSize);
      if (!plainText) continue;

      // Filter isolated page numbers in extreme top/bottom 9% margins
      if ((y0 < pageHeight * 0.09 || y1 > pageHeight * 0.91) && PAGE_NUMBER_RE.test(plainText)) {
        continue;
      }

      const boldChars = lineSpans.filter((s) => s.isBoldFont).reduce((sum, s) => sum + s.text.trim().length, 0);
      const allChars = lineSpans.reduce((sum, s) => sum + s.text.trim().length, 0);
      const isBold = allChars > 0 && boldChars / allChars >= 0.65;

      const partial: Omit<ReconstructedLine, "isDisplayFormula"> = {
        spans: lineSpans,
        x0,
        y0,
        x1,
        y1,
        baselineY,
        fontSize,
        isBold,
        column: col,
        segments,
        plainText,
      };
      const isDisplayFormula = classifyDisplayFormula(partial, col === "full" ? pageWidth : pageWidth / 2, bodyFontSize);
      lines.push({ ...partial, isDisplayFormula });
    }
    return lines.sort((a, b) => a.y0 - b.y0);
  };

  const fullLines = buildLinesForColumn("full", groupedSpans.full);
  const leftLines = buildLinesForColumn("left", groupedSpans.left);
  const rightLines = buildLinesForColumn("right", groupedSpans.right);

  // Order full-width header/title bands above the columns, then left col, right col, then full-width footer bands
  const colTopY = Math.min(
    leftLines[0]?.y0 ?? Number.POSITIVE_INFINITY,
    rightLines[0]?.y0 ?? Number.POSITIVE_INFINITY,
  );
  const topFull = fullLines.filter((l) => l.y0 < colTopY);
  const bottomFull = fullLines.filter((l) => l.y0 >= colTopY);

  const orderedStreams: ReconstructedLine[][] = [topFull, leftLines, rightLines, bottomFull];
  const blocks: PdfLayoutBlock[] = [];
  let blockIndex = 0;

  for (const stream of orderedStreams) {
    if (stream.length === 0) continue;
    const colLeftRef = median(stream.map((l) => l.x0), stream[0]!.x0);

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
        && line.fontSize >= bodyFontSize * 1.03;
      const isNamedSectionHeading = /^(?:Abstract|Introduction|Background|Related Work|Methodology|Methods|Experiments?|Results|Discussion|Conclusion|Conclusions|References|Acknowledgments?|Appendix|Overview|Summary)$/i.test(line.plainText)
        && line.fontSize >= bodyFontSize * 1.03;
      const isHeading = (line.fontSize >= bodyFontSize * 1.18 && line.plainText.length <= 160)
        || (line.isBold && line.fontSize >= bodyFontSize * 1.02 && line.plainText.length <= 96 && !/[.。!?]$/.test(line.plainText))
        || isNumberedHeading
        || isNamedSectionHeading;
      const isList = !isHeading && LIST_PREFIX_RE.test(line.plainText);
      const lineKind: PdfBlockKind = isHeading ? "heading" : isList ? "list-item" : "paragraph";
      const headingLevel = isHeading
        ? (line.fontSize >= bodyFontSize * 1.55 ? 1 : line.fontSize >= bodyFontSize * 1.25 ? 2 : 3)
        : undefined;

      const canMerge = Boolean(
        current
        && current.column === line.column
        && current.kind === lineKind
        && lineKind !== "list-item"
        && Math.abs(line.fontSize - current.fontSize) <= Math.max(1.5, current.fontSize * 0.14)
        && (line.y0 - current.y1) <= Math.max(8, current.fontSize * 0.95)
        && (line.baselineY - current.lastBaselineY) <= Math.max(14, current.fontSize * 1.85)
        && (line.x0 - colLeftRef < current.fontSize * 1.15 || current.lineCount === 0)
      );

      if (canMerge && current) {
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
          segments: line.segments.map((s) => ({ ...s })),
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
