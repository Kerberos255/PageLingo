/**
 * Document layout fusion for scanned PDF pages (PP-DocLayout-M + PP-OCRv6_small).
 *
 * Pipeline:
 * 1. `prepareLayoutMaskPlan` cleans PP-DocLayout boxes (cross-class NMS, formula_number
 *    merging, inline-formula preservation so prose isn't punctured, multi-panel figure merging).
 * 2. `maskImageRgbaForOcr` fills protected visual regions (display formulas, tables, figures,
 *    charts, headers/footers/page numbers) with the sampled page background before OCR,
 *    preventing garbled OCR on formulas/tables/charts and cutting OCR latency.
 * 3. `buildPdfBlocksFromOcr` fuses surviving OCR lines with layout containers (+ fallback
 *    clustering for any prose missed by the layout model) into reading-order `PdfLayoutBlock[]`
 *    identical to the digital text-layer representation.
 */

import type { OcrRegion } from "../image-translation/ocr-layout";
import type { PdfBlockKind, PdfLayoutBlock, PdfPageBox } from "./pdf-layout";

export interface DocLayoutBox {
  label: string;
  score: number;
  box: PdfPageBox;
}

export interface LayoutVisualRegion {
  kind: "formula" | "table" | "figure";
  label: string;
  score: number;
  box: PdfPageBox;
}

export interface LayoutTextContainer {
  label: string;
  score: number;
  box: PdfPageBox;
}

export interface LayoutMaskPlan {
  visualBlocks: LayoutVisualRegion[];
  textContainers: LayoutTextContainer[];
  skipRects: PdfPageBox[];
  maskRects: PdfPageBox[];
}

const VISUAL_LABELS = new Set(["table", "image", "chart", "seal", "algorithm"]);
const TEXT_LABELS = new Set([
  "doc_title",
  "paragraph_title",
  "text",
  "abstract",
  "content",
  "table_title",
  "figure_title",
  "chart_title",
  "footnote",
  "reference",
  "aside_text",
]);
const SKIP_CHROME_LABELS = new Set([
  "header",
  "footer",
  "number",
  "header_image",
  "footer_image",
]);
const SPECIFIC_TITLE_LABELS = new Set([
  "doc_title",
  "paragraph_title",
  "table_title",
  "figure_title",
  "chart_title",
]);
const LIST_ITEM_PREFIX_RE = /^(?:[•●◦▪▫▸▹–—*-]|(?:\(?\d{1,3}[.)])|(?:\([a-zA-Z]\)))\s+/;

function classThreshold(label: string): number {
  if (label === "table") return 0.48;
  if (label === "formula") return 0.48;
  if (label === "formula_number") return 0.42;
  if (VISUAL_LABELS.has(label)) return 0.45;
  if (SKIP_CHROME_LABELS.has(label)) return 0.45;
  return 0.38;
}

function visualPriority(label: string): number {
  switch (label) {
    case "table": return 5;
    case "algorithm": return 4;
    case "image": return 3;
    case "chart": return 2;
    case "seal": return 1;
    default: return 0;
  }
}

function boxArea(box: PdfPageBox): number {
  return Math.max(0, box.width) * Math.max(0, box.height);
}

function intersectArea(a: PdfPageBox, b: PdfPageBox): number {
  const x0 = Math.max(a.x, b.x);
  const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.width, b.x + b.width);
  const y1 = Math.min(a.y + a.height, b.y + b.height);
  return Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
}

function boxIoU(a: PdfPageBox, b: PdfPageBox): number {
  const inter = intersectArea(a, b);
  if (inter <= 0) return 0;
  const union = boxArea(a) + boxArea(b) - inter;
  return union > 0 ? inter / union : 0;
}

function containmentRatio(inner: PdfPageBox, outer: PdfPageBox): number {
  const area = boxArea(inner);
  if (area <= 0) return 0;
  return intersectArea(inner, outer) / area;
}

function unionBox(a: PdfPageBox, b: PdfPageBox): PdfPageBox {
  const x0 = Math.min(a.x, b.x);
  const y0 = Math.min(a.y, b.y);
  const x1 = Math.max(a.x + a.width, b.x + b.width);
  const y1 = Math.max(a.y + a.height, b.y + b.height);
  return { x: x0, y: y0, width: Math.max(1, x1 - x0), height: Math.max(1, y1 - y0) };
}

function clampBox(box: PdfPageBox, width: number, height: number): PdfPageBox {
  const x0 = Math.max(0, Math.min(width - 1, box.x));
  const y0 = Math.max(0, Math.min(height - 1, box.y));
  const x1 = Math.max(x0 + 1, Math.min(width, box.x + box.width));
  const y1 = Math.max(y0 + 1, Math.min(height, box.y + box.height));
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

export function prepareLayoutMaskPlan(
  rawBoxes: readonly DocLayoutBox[],
  imageWidth: number,
  imageHeight: number,
): LayoutMaskPlan {
  const filtered: DocLayoutBox[] = [];
  for (const raw of rawBoxes) {
    if (!raw || raw.score < classThreshold(raw.label)) continue;
    const box = clampBox(raw.box, imageWidth, imageHeight);
    if (box.width < 6 || box.height < 6) continue;
    filtered.push({ label: raw.label, score: raw.score, box });
  }

  // 1. Deduplicate visual non-text regions (table, image, chart, seal, algorithm)
  const rawVisuals = filtered
    .filter((b) => VISUAL_LABELS.has(b.label))
    .sort((a, b) => visualPriority(b.label) - visualPriority(a.label) || b.score - a.score);

  const keptVisuals: LayoutVisualRegion[] = [];
  for (const cand of rawVisuals) {
    let absorbed = false;
    for (const existing of keptVisuals) {
      const iou = boxIoU(cand.box, existing.box);
      const insideExisting = containmentRatio(cand.box, existing.box);
      const existingInsideCand = containmentRatio(existing.box, cand.box);
      const bothImageLike = (cand.label === "image" || cand.label === "chart")
        && (existing.label === "image" || existing.label === "chart");
      if (iou >= 0.35 || insideExisting >= 0.65 || existingInsideCand >= 0.65) {
        if (bothImageLike) {
          // Union overlapping image + chart detections (e.g., multi-panel academic figures)
          existing.box = unionBox(existing.box, cand.box);
          existing.score = Math.max(existing.score, cand.score);
        }
        absorbed = true;
        break;
      }
    }
    if (!absorbed) {
      keptVisuals.push({
        kind: cand.label === "table" ? "table" : "figure",
        label: cand.label,
        score: cand.score,
        box: { ...cand.box },
      });
    }
  }

  // 2. Deduplicate text containers (prefer specific title classes over generic "text")
  const rawTexts = filtered
    .filter((b) => TEXT_LABELS.has(b.label))
    .sort((a, b) => {
      const aSpec = SPECIFIC_TITLE_LABELS.has(a.label) ? 1 : 0;
      const bSpec = SPECIFIC_TITLE_LABELS.has(b.label) ? 1 : 0;
      if (aSpec !== bSpec) return bSpec - aSpec;
      return b.score - a.score;
    });

  const textContainers: LayoutTextContainer[] = [];
  for (const cand of rawTexts) {
    // Drop text container mostly inside a table or figure visual block
    if (keptVisuals.some((v) => containmentRatio(cand.box, v.box) >= 0.68)) continue;
    let duplicate = false;
    for (const existing of textContainers) {
      if (boxIoU(cand.box, existing.box) >= 0.55 || containmentRatio(cand.box, existing.box) >= 0.78) {
        duplicate = true;
        break;
      }
    }
    if (!duplicate) {
      textContainers.push({ label: cand.label, score: cand.score, box: { ...cand.box } });
    }
  }

  // 3. Filter standalone block formulas vs inline formulas embedded inside text paragraphs
  const formulaNumbers = filtered.filter((b) => b.label === "formula_number");
  const rawFormulas = filtered
    .filter((b) => b.label === "formula")
    .sort((a, b) => b.score - a.score);

  const keptFormulas: LayoutVisualRegion[] = [];
  for (const cand of rawFormulas) {
    // Skip formulas already enclosed in a table/figure/algorithm
    if (keptVisuals.some((v) => containmentRatio(cand.box, v.box) >= 0.55 || boxIoU(cand.box, v.box) >= 0.45)) {
      continue;
    }
    // Deduplicate overlapping formula proposals
    if (keptFormulas.some((f) => boxIoU(cand.box, f.box) >= 0.45 || containmentRatio(cand.box, f.box) >= 0.70)) {
      continue;
    }
    // Check if this formula has a paired formula_number on the same horizontal band -> always display formula!
    const candCenterY = cand.box.y + cand.box.height / 2;
    const pairedNumber = formulaNumbers.find((fn) => {
      const fnCenterY = fn.box.y + fn.box.height / 2;
      const dy = Math.abs(fnCenterY - candCenterY);
      return dy <= Math.max(cand.box.height * 0.6, 22) && fn.box.x >= cand.box.x + cand.box.width - 12;
    });

    // If NOT paired with a formula_number, check whether it's an inline formula inside a prose paragraph
    if (!pairedNumber) {
      const enclosingText = textContainers.find((t) => containmentRatio(cand.box, t.box) >= 0.65);
      if (enclosingText) {
        const isShortSingleLine = cand.box.height < imageHeight * 0.045
          || (cand.box.height < enclosingText.box.height * 0.42 && cand.box.width < enclosingText.box.width * 0.72);
        if (isShortSingleLine) {
          // Leave inline formula unmasked inside its prose paragraph so OCR reads the whole line cleanly!
          continue;
        }
      }
    }

    const finalBox = pairedNumber ? unionBox(cand.box, pairedNumber.box) : { ...cand.box };
    keptFormulas.push({
      kind: "formula",
      label: "formula",
      score: cand.score,
      box: clampBox(finalBox, imageWidth, imageHeight),
    });
  }

  // 4. Page chrome to skip (header, footer, page number, header/footer image, standalone formula_number)
  const skipRects: PdfPageBox[] = [];
  for (const cand of filtered) {
    if (SKIP_CHROME_LABELS.has(cand.label)) {
      // Never skip something overlapping a kept main text container substantially
      if (textContainers.some((t) => containmentRatio(cand.box, t.box) >= 0.65)) continue;
      skipRects.push(cand.box);
    } else if (cand.label === "formula_number") {
      if (!keptFormulas.some((f) => containmentRatio(cand.box, f.box) >= 0.5)) {
        skipRects.push(cand.box);
      }
    }
  }

  const visualBlocks: LayoutVisualRegion[] = [...keptVisuals, ...keptFormulas];
  const maskRects: PdfPageBox[] = [
    ...visualBlocks.map((v) => v.box),
    ...skipRects,
  ];

  return { visualBlocks, textContainers, skipRects, maskRects };
}

function samplePageBackgroundRgb(pixels: Uint8ClampedArray, width: number, height: number): [number, number, number] {
  const rs: number[] = [];
  const gs: number[] = [];
  const bs: number[] = [];
  const marginX = Math.max(2, Math.floor(width * 0.03));
  const marginY = Math.max(2, Math.floor(height * 0.03));

  const samplePoint = (x: number, y: number) => {
    const cx = Math.max(0, Math.min(width - 1, x));
    const cy = Math.max(0, Math.min(height - 1, y));
    const off = (cy * width + cx) * 4;
    if ((pixels[off + 3] ?? 255) < 128) return;
    rs.push(pixels[off] ?? 255);
    gs.push(pixels[off + 1] ?? 255);
    bs.push(pixels[off + 2] ?? 255);
  };

  for (let i = 0; i < 12; i += 1) {
    const fx = Math.floor((width - 1) * (i / 11));
    const fy = Math.floor((height - 1) * (i / 11));
    samplePoint(fx, marginY);
    samplePoint(fx, height - 1 - marginY);
    samplePoint(marginX, fy);
    samplePoint(width - 1 - marginX, fy);
  }
  if (rs.length === 0) return [255, 255, 255];
  rs.sort((a, b) => a - b);
  gs.sort((a, b) => a - b);
  bs.sort((a, b) => a - b);
  const mid = Math.floor(rs.length / 2);
  return [rs[mid]!, gs[mid]!, bs[mid]!];
}

/**
 * Returns a copy of `pixels` where every `maskRect` (formulas, tables, figures, headers/footers)
 * is filled with the page's sampled paper background so OCR skips those regions completely.
 */
export function maskImageRgbaForOcr(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  maskRects: readonly PdfPageBox[],
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(pixels);
  if (maskRects.length === 0) return out;
  const [bgR, bgG, bgB] = samplePageBackgroundRgb(pixels, width, height);

  for (const rect of maskRects) {
    // Shrink inward by 1px to avoid clipping adjacent prose ascenders/descenders
    const x0 = Math.max(0, Math.floor(rect.x + 1));
    const y0 = Math.max(0, Math.floor(rect.y + 1));
    const x1 = Math.min(width, Math.ceil(rect.x + rect.width - 1));
    const y1 = Math.min(height, Math.ceil(rect.y + rect.height - 1));
    for (let y = y0; y < y1; y += 1) {
      let off = (y * width + x0) * 4;
      for (let x = x0; x < x1; x += 1) {
        out[off] = bgR;
        out[off + 1] = bgG;
        out[off + 2] = bgB;
        out[off + 3] = 255;
        off += 4;
      }
    }
  }
  return out;
}

function isCjkEnd(value: string): boolean {
  return /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]$/u.test(value);
}

function isCjkStart(value: string): boolean {
  return /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(value);
}

function joinOcrLines(lines: readonly string[]): string {
  let acc = "";
  for (const raw of lines) {
    const text = raw.replace(/\s+/g, " ").trim();
    if (!text) continue;
    if (!acc) {
      acc = text;
      continue;
    }
    if (/[A-Za-z]-$/.test(acc) && /^[a-z]/.test(text)) {
      acc = acc.slice(0, -1) + text;
    } else if (isCjkEnd(acc) && isCjkStart(text)) {
      acc += text;
    } else {
      acc += ` ${text}`;
    }
  }
  return acc;
}

function groupOcrLinesIntoRows(lines: readonly OcrRegion[]): OcrRegion[][] {
  if (lines.length === 0) return [];
  const byMidY = [...lines].sort((a, b) => (a.box.y + a.box.height / 2) - (b.box.y + b.box.height / 2) || a.box.x - b.box.x);
  const rows: Array<{ items: OcrRegion[]; midY: number; refH: number }> = [];

  for (const item of byMidY) {
    const midY = item.box.y + item.box.height / 2;
    let bestRow: { items: OcrRegion[]; midY: number; refH: number } | null = null;
    let bestDist = Number.POSITIVE_INFINITY;
    for (let ri = rows.length - 1; ri >= Math.max(0, rows.length - 6); ri -= 1) {
      const row = rows[ri]!;
      const tol = Math.max(row.refH, item.box.height) * 0.65;
      const dist = Math.abs(midY - row.midY);
      if (dist <= tol && dist < bestDist) {
        bestDist = dist;
        bestRow = row;
      }
    }
    if (bestRow) {
      bestRow.items.push(item);
      const mids = bestRow.items.map((r) => r.box.y + r.box.height / 2).sort((a, b) => a - b);
      bestRow.midY = mids[Math.floor(mids.length / 2)]!;
      bestRow.refH = Math.max(bestRow.refH, item.box.height);
    } else {
      rows.push({ items: [item], midY, refH: item.box.height });
    }
  }

  rows.sort((a, b) => a.midY - b.midY);
  return rows.map((row) => row.items.sort((a, b) => a.box.x - b.box.x));
}

function sortOcrLinesInReadingOrder(lines: readonly OcrRegion[]): OcrRegion[] {
  return groupOcrLinesIntoRows(lines).flat();
}

function medianVal(values: readonly number[], fallback: number): number {
  const valid = values.filter((v) => Number.isFinite(v) && v > 0).sort((a, b) => a - b);
  return valid.length > 0 ? valid[Math.floor(valid.length / 2)]! : fallback;
}

interface UnorderedBlock {
  kind: PdfBlockKind;
  headingLevel?: number;
  text: string;
  box: PdfPageBox;
  lineBoxes?: PdfPageBox[];
  fontSize: number;
  tableMode?: "snapshot" | "html";
}

function classifyColumnForBlock(
  box: PdfPageBox,
  pageWidth: number,
  isTwoColumn: boolean,
): "full" | "left" | "right" {
  if (!isTwoColumn) return "full";
  const midX = pageWidth / 2;
  const x0 = box.x;
  const x1 = box.x + box.width;
  if (x1 <= midX + pageWidth * 0.04) return "left";
  if (x0 >= midX - pageWidth * 0.04) return "right";
  return "full";
}

/**
 * Sorts visual + OCR text blocks into true multi-column XY-Cut reading order:
 * top full-width bands -> left column -> right column -> mid full-width bands -> ...
 */
function orderBlocksMultiColumn(
  items: readonly UnorderedBlock[],
  pageWidth: number,
): Array<UnorderedBlock & { column: "full" | "left" | "right" }> {
  if (items.length === 0) return [];
  const midX = pageWidth / 2;
  const leftOnly = items.filter((b) => b.box.x + b.box.width <= midX + pageWidth * 0.04 && b.box.width < pageWidth * 0.52);
  const rightOnly = items.filter((b) => b.box.x >= midX - pageWidth * 0.04 && b.box.width < pageWidth * 0.52);
  const hasParallelColumns = leftOnly.some((l) =>
    rightOnly.some((r) => Math.min(l.box.y + l.box.height, r.box.y + r.box.height) > Math.max(l.box.y, r.box.y) + 6),
  );
  const isTwoColumn = (leftOnly.length >= 2 && rightOnly.length >= 2) || hasParallelColumns;

  const tagged = items.map((item) => ({
    ...item,
    column: classifyColumnForBlock(item.box, pageWidth, isTwoColumn),
  }));

  if (!isTwoColumn) {
    return tagged.sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x);
  }

  const fullBlocks = tagged.filter((b) => b.column === "full").sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x);
  const leftBlocks = tagged.filter((b) => b.column === "left").sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x);
  const rightBlocks = tagged.filter((b) => b.column === "right").sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x);

  const colTopY = Math.min(
    leftBlocks[0]?.box.y ?? Number.POSITIVE_INFINITY,
    rightBlocks[0]?.box.y ?? Number.POSITIVE_INFINITY,
  );
  const topFull = fullBlocks.filter((b) => b.box.y < colTopY);
  const restFull = fullBlocks.filter((b) => b.box.y >= colTopY);

  const ordered: Array<UnorderedBlock & { column: "full" | "left" | "right" }> = [...topFull];

  let cursorY = colTopY;
  for (const fullBlock of restFull) {
    const segLeft = leftBlocks.filter((b) => b.box.y >= cursorY && b.box.y < fullBlock.box.y);
    const segRight = rightBlocks.filter((b) => b.box.y >= cursorY && b.box.y < fullBlock.box.y);
    ordered.push(...segLeft, ...segRight, fullBlock);
    cursorY = fullBlock.box.y + fullBlock.box.height;
  }
  ordered.push(
    ...leftBlocks.filter((b) => b.box.y >= cursorY),
    ...rightBlocks.filter((b) => b.box.y >= cursorY),
  );
  return ordered;
}

export function buildPdfBlocksFromOcr(
  plan: LayoutMaskPlan,
  ocrRegions: readonly OcrRegion[],
  imageWidth: number,
  imageHeight: number,
  pageWidth: number,
  pageHeight: number,
  pageNumber: number,
): PdfLayoutBlock[] {
  const sx = pageWidth / Math.max(1, imageWidth);
  const sy = pageHeight / Math.max(1, imageHeight);
  const scaleBox = (box: PdfPageBox): PdfPageBox => ({
    x: box.x * sx,
    y: box.y * sy,
    width: Math.max(4, box.width * sx),
    height: Math.max(6, box.height * sy),
  });

  // 1. Filter low-confidence OCR lines and any stray box inside a masked visual/skip region
  const validLines = ocrRegions.filter((region) => {
    const text = region.text?.trim();
    if (!text || region.confidence < 0.30) return false;
    const centerBox: PdfPageBox = {
      x: region.box.x + region.box.width * 0.25,
      y: region.box.y + region.box.height * 0.25,
      width: Math.max(1, region.box.width * 0.5),
      height: Math.max(1, region.box.height * 0.5),
    };
    if (plan.visualBlocks.some((v) => containmentRatio(centerBox, v.box) >= 0.7)) return false;
    if (plan.skipRects.some((s) => containmentRatio(centerBox, s) >= 0.7)) return false;
    return true;
  });

  const medianImgLineH = medianVal(validLines.map((r) => r.box.height), Math.max(14, imageHeight * 0.015));

  // 2. Assign OCR lines to PP-DocLayout text containers
  const containerBuckets = new Map<number, OcrRegion[]>();
  const orphanLines: OcrRegion[] = [];

  for (const line of validLines) {
    const cx = line.box.x + line.box.width / 2;
    const cy = line.box.y + line.box.height / 2;
    let bestIdx = -1;
    let bestScore = 0;

    for (let ci = 0; ci < plan.textContainers.length; ci += 1) {
      const container = plan.textContainers[ci]!;
      const insideCenter = cx >= container.box.x - 4
        && cx <= container.box.x + container.box.width + 4
        && cy >= container.box.y - 4
        && cy <= container.box.y + container.box.height + 4;
      const ratio = containmentRatio(line.box, container.box);
      const score = ratio + (insideCenter ? 0.5 : 0);
      if ((insideCenter || ratio >= 0.45) && score > bestScore) {
        bestScore = score;
        bestIdx = ci;
      }
    }

    if (bestIdx >= 0) {
      let arr = containerBuckets.get(bestIdx);
      if (!arr) { arr = []; containerBuckets.set(bestIdx, arr); }
      arr.push(line);
    } else {
      orphanLines.push(line);
    }
  }

  const unordered: UnorderedBlock[] = [];
  const avoidsVisuals = (box: PdfPageBox): boolean =>
    plan.visualBlocks.every((v) => intersectArea(box, v.box) <= 0);

  // 3. Emit blocks for each populated PP-DocLayout text container
  for (const [ci, lines] of containerBuckets.entries()) {
    const container = plan.textContainers[ci]!;
    const rows = groupOcrLinesIntoRows(lines);
    const orderedLines = rows.flat();
    const text = joinOcrLines(orderedLines.map((l) => l.text));
    if (!text) continue;

    const lineH = medianVal(orderedLines.map((l) => l.box.height), medianImgLineH);
    const fontSize = Math.max(7, lineH * sy * 0.82);

    // Merge horizontally-split OCR fragments on the same visual row (e.g. around an inline fraction)
    // into unified row erase boxes, and fill any horizontal hole inside the layout container
    // when strictly safe from visual regions (formulas/tables/figures).
    const rowBoxes: PdfPageBox[] = rows.map((row, rIdx) => {
      let rowUnion = row[0]!.box;
      for (let k = 1; k < row.length; k += 1) {
        rowUnion = unionBox(rowUnion, row[k]!.box);
      }
      if (rows.length >= 2 && container.label !== "doc_title" && container.label !== "paragraph_title") {
        const isLastRow = rIdx === rows.length - 1;
        const leftGap = rowUnion.x - container.box.x;
        const rightEdge = rowUnion.x + rowUnion.width;
        const containerRight = container.box.x + container.box.width;
        const rightGap = containerRight - rightEdge;
        // Expand leftward if a row missed its leading phrase (more than normal paragraph indent of ~2.5*lineH)
        const expandLeft = leftGap > lineH * 2.4;
        // Expand rightward on non-last lines if trailing inline math/words were missed
        const expandRight = !isLastRow && rightGap > lineH * 1.4;
        if (expandLeft || expandRight) {
          const candX0 = expandLeft ? container.box.x : rowUnion.x;
          const candX1 = expandRight ? containerRight : rightEdge;
          const candidate: PdfPageBox = {
            x: candX0,
            y: rowUnion.y,
            width: Math.max(4, candX1 - candX0),
            height: rowUnion.height,
          };
          if (avoidsVisuals(candidate)) {
            rowUnion = candidate;
          }
        }
      }
      return rowUnion;
    });

    let union = rowBoxes[0]!;
    for (let i = 1; i < rowBoxes.length; i += 1) {
      union = unionBox(union, rowBoxes[i]!);
    }

    let kind: PdfBlockKind = "paragraph";
    let headingLevel: number | undefined;
    if (container.label === "doc_title") {
      kind = "heading";
      headingLevel = 1;
    } else if (container.label === "paragraph_title") {
      kind = "heading";
      headingLevel = 2;
    } else if (LIST_ITEM_PREFIX_RE.test(text)) {
      kind = "list-item";
    }

    unordered.push({
      kind,
      ...(headingLevel ? { headingLevel } : {}),
      text,
      box: scaleBox(union),
      lineBoxes: rowBoxes.map((rb) => scaleBox(rb)),
      fontSize,
    });
  }

  // 4. Fallback paragraph clustering for orphan OCR lines (prose missed by PP-DocLayout)
  if (orphanLines.length > 0) {
    const sortedOrphans = sortOcrLinesInReadingOrder(orphanLines);
    const groups: OcrRegion[][] = [];
    for (const line of sortedOrphans) {
      let placed = false;
      for (let gi = groups.length - 1; gi >= Math.max(0, groups.length - 6); gi -= 1) {
        const group = groups[gi]!;
        const last = group.at(-1)!;
        const vGap = line.box.y - (last.box.y + last.box.height);
        const refH = Math.max(line.box.height, last.box.height);
        const hOverlap = Math.min(line.box.x + line.box.width, last.box.x + last.box.width)
          - Math.max(line.box.x, last.box.x);
        const nearLeft = Math.abs(line.box.x - last.box.x) <= refH * 2.2;
        if (vGap >= -refH * 0.35 && vGap <= refH * 1.15 && (hOverlap > 0 || nearLeft)) {
          group.push(line);
          placed = true;
          break;
        }
      }
      if (!placed) groups.push([line]);
    }

    for (const group of groups) {
      const orderedLines = sortOcrLinesInReadingOrder(group);
      const text = joinOcrLines(orderedLines.map((l) => l.text));
      if (!text) continue;
      let union = orderedLines[0]!.box;
      for (let i = 1; i < orderedLines.length; i += 1) union = unionBox(union, orderedLines[i]!.box);
      const lineH = medianVal(orderedLines.map((l) => l.box.height), medianImgLineH);
      const isHeading = lineH >= medianImgLineH * 1.28 && text.length <= 120;
      unordered.push({
        kind: isHeading ? "heading" : LIST_ITEM_PREFIX_RE.test(text) ? "list-item" : "paragraph",
        ...(isHeading ? { headingLevel: 2 } : {}),
        text,
        box: scaleBox(union),
        lineBoxes: orderedLines.map((l) => scaleBox(l.box)),
        fontSize: Math.max(7, lineH * sy * 0.82),
      });
    }
  }

  // 5. Add preserved visual blocks (display formulas, tables, figures/charts)
  for (const visual of plan.visualBlocks) {
    const scaled = scaleBox(visual.box);
    unordered.push({
      kind: visual.kind,
      text: visual.kind === "formula" ? "[Formula]" : visual.kind === "table" ? "[Table]" : "[Figure]",
      box: scaled,
      fontSize: Math.max(9, medianImgLineH * sy * 0.8),
      ...(visual.kind === "table" ? { tableMode: "snapshot" as const } : {}),
    });
  }

  // 6. Filter isolated margin page numbers & sort into multi-column XY-Cut reading order
  const PAGE_NUM_RE = /^(?:[-–—]\s*)?(?:page\s*)?\d{1,4}(?:\s*(?:of|\/)\s*\d{1,4})?(?:\s*[-–—])?$/i;
  const cleaned = unordered.filter((item) => {
    if (item.kind !== "paragraph") return true;
    const inExtremeMargin = item.box.y < pageHeight * 0.09 || (item.box.y + item.box.height) > pageHeight * 0.91;
    return !(inExtremeMargin && PAGE_NUM_RE.test(item.text.trim()));
  });

  const ordered = orderBlocksMultiColumn(cleaned, pageWidth);

  return ordered.map((item, idx) => ({
    id: `pdf-p${pageNumber}-ocr-b${idx + 1}`,
    pageNumber,
    kind: item.kind,
    ...(item.headingLevel ? { headingLevel: item.headingLevel } : {}),
    column: item.column,
    segments: item.kind === "formula"
      ? [{ kind: "math" as const, text: item.text }]
      : [{ kind: "text" as const, text: item.text }],
    plainText: item.text,
    box: item.box,
    ...(item.lineBoxes ? { lineBoxes: item.lineBoxes } : {}),
    fontSize: item.fontSize,
    ...(item.tableMode ? { tableMode: item.tableMode } : {}),
    source: "ocr" as const,
  }));
}
