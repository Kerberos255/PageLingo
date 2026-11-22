export interface OcrBox { x: number; y: number; width: number; height: number }

export interface OcrRegion {
  text: string;
  confidence: number;
  box: OcrBox;
  lineBoxes?: OcrBox[];
  lineHeight?: number;
  _lineHeight?: number;
}

export interface OcrPixelContext {
  pixels: Uint8ClampedArray;
  width: number;
  height: number;
}

type LayoutOcrRegion = OcrRegion & {
  lineBoxes: OcrBox[];
  lineHeight: number;
  _lineHeight: number;
};

type RgbTuple = [number, number, number];

function boxArea(box: OcrBox): number {
  return Math.max(0, box.width) * Math.max(0, box.height);
}

function intersectionArea(left: OcrBox, right: OcrBox): number {
  const x1 = Math.max(left.x, right.x);
  const y1 = Math.max(left.y, right.y);
  const x2 = Math.min(left.x + left.width, right.x + right.width);
  const y2 = Math.min(left.y + left.height, right.y + right.height);
  return Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
}

function unionBox(left: OcrBox, right: OcrBox): OcrBox {
  const x = Math.min(left.x, right.x);
  const y = Math.min(left.y, right.y);
  const maxX = Math.max(left.x + left.width, right.x + right.width);
  const maxY = Math.max(left.y + left.height, right.y + right.height);
  return { x, y, width: maxX - x, height: maxY - y };
}

function normalizeOcrText(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase().replace(/[\s\p{P}]/gu, "");
}

function isCjkChar(char: string): boolean {
  return /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(char);
}

function joinHorizontalText(first: string, second: string): string {
  const left = first.trimEnd();
  const right = second.trimStart();
  if (!left) return right;
  if (!right) return left;
  const lastChar = Array.from(left).at(-1) ?? "";
  const firstChar = Array.from(right)[0] ?? "";
  if (isCjkChar(lastChar) && isCjkChar(firstChar)) return `${left}${right}`;
  return `${left} ${right}`;
}

function joinVerticalBlockText(first: string, second: string): string {
  const left = first.trimEnd();
  const right = second.trimStart();
  if (!left) return right;
  if (!right) return left;
  // Keep explicit list items on separate lines, while letting multi-line titles
  // and continuous sentences inside the same paragraph flow together for translation.
  const startsListItem = /^(?:[-•·*]\s|\d+[.)]\s)/u.test(right);
  if (startsListItem) return `${left}\n${right}`;
  return joinHorizontalText(left, right);
}

export function isUiMetadataText(value: unknown): boolean {
  const text = String(value ?? "").normalize("NFKC").trim();
  if (!text) return true;
  if (/^[✓✔√vV\/\s•·.,:;!?+\-–—|]+$/u.test(text)) return true;
  if (/^\d{1,3}%?$/u.test(text)) return true;
  if (/^(?:today|yesterday|online|offline)$/iu.test(text)) return true;
  if (/^\d{1,2}:\d{2}(?:\s*(?:am|pm))?(?:\s*[✓✔√vV\/]+)?$/iu.test(text)) return true;
  return false;
}

function rgbDistance(left: RgbTuple, right: RgbTuple): number {
  const dr = left[0] - right[0];
  const dg = left[1] - right[1];
  const db = left[2] - right[2];
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

function sampleRingBackground(context: OcrPixelContext, box: OcrBox): RgbTuple | null {
  const { pixels, width, height } = context;
  const x0 = Math.max(0, Math.floor(box.x));
  const y0 = Math.max(0, Math.floor(box.y));
  const x1 = Math.min(width - 1, Math.ceil(box.x + box.width));
  const y1 = Math.min(height - 1, Math.ceil(box.y + box.height));
  const band = 3;
  const buckets = new Map<number, { count: number; sumR: number; sumG: number; sumB: number }>();

  const add = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const offset = (y * width + x) * 4;
    if ((pixels[offset + 3] ?? 0) < 128) return;
    const r = pixels[offset] ?? 0;
    const g = pixels[offset + 1] ?? 0;
    const b = pixels[offset + 2] ?? 0;
    const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    const entry = buckets.get(key);
    if (entry) {
      entry.count += 1;
      entry.sumR += r;
      entry.sumG += g;
      entry.sumB += b;
    } else {
      buckets.set(key, { count: 1, sumR: r, sumG: g, sumB: b });
    }
  };

  const stepX = Math.max(1, Math.floor((x1 - x0) / 36));
  const stepY = Math.max(1, Math.floor((y1 - y0) / 16));
  for (let x = x0; x <= x1; x += stepX) {
    for (let d = 1; d <= band; d += 1) {
      add(x, y0 - d);
      add(x, y1 + d);
    }
  }
  for (let y = y0; y <= y1; y += stepY) {
    for (let d = 1; d <= band; d += 1) {
      add(x0 - d, y);
      add(x1 + d, y);
    }
  }

  let best: { count: number; sumR: number; sumG: number; sumB: number } | null = null;
  for (const entry of buckets.values()) {
    if (!best || entry.count > best.count) best = entry;
  }
  if (!best || best.count < 4) return null;
  return [
    Math.round(best.sumR / best.count),
    Math.round(best.sumG / best.count),
    Math.round(best.sumB / best.count),
  ];
}

function sampleLineForeground(
  context: OcrPixelContext,
  box: OcrBox,
  bgRgb: RgbTuple,
): RgbTuple | null {
  const { pixels, width, height } = context;
  const x0 = Math.max(0, Math.floor(box.x));
  const y0 = Math.max(0, Math.floor(box.y));
  const x1 = Math.min(width - 1, Math.ceil(box.x + box.width));
  const y1 = Math.min(height - 1, Math.ceil(box.y + box.height));
  const stepX = Math.max(1, Math.floor((x1 - x0) / 40));
  const stepY = Math.max(1, Math.floor((y1 - y0) / 12));
  const scored: Array<{ rgb: RgbTuple; dist: number }> = [];

  for (let y = y0; y <= y1; y += stepY) {
    for (let x = x0; x <= x1; x += stepX) {
      const offset = (y * width + x) * 4;
      if ((pixels[offset + 3] ?? 0) < 128) continue;
      const rgb: RgbTuple = [pixels[offset] ?? 0, pixels[offset + 1] ?? 0, pixels[offset + 2] ?? 0];
      const dist = rgbDistance(rgb, bgRgb);
      if (dist >= 32) scored.push({ rgb, dist });
    }
  }
  if (scored.length < 4) return null;
  scored.sort((a, b) => b.dist - a.dist);
  const top = scored.slice(0, Math.max(4, Math.floor(scored.length * 0.4)));
  const medianChannel = (idx: 0 | 1 | 2) => {
    const vals = top.map((item) => item.rgb[idx]).sort((a, b) => a - b);
    return vals[Math.floor(vals.length / 2)]!;
  };
  return [medianChannel(0), medianChannel(1), medianChannel(2)];
}

function backgroundsAndForegroundsCompatible(
  upper: LayoutOcrRegion,
  lower: LayoutOcrRegion,
  pixelContext?: OcrPixelContext,
): boolean {
  if (!pixelContext) return true;
  const upperLine = upper.lineBoxes.at(-1) ?? upper.box;
  const lowerLine = lower.lineBoxes[0] ?? lower.box;
  const upperBg = sampleRingBackground(pixelContext, upperLine);
  const lowerBg = sampleRingBackground(pixelContext, lowerLine);
  if (!upperBg || !lowerBg) return true;
  if (rgbDistance(upperBg, lowerBg) > 26) return false;

  const upperFg = sampleLineForeground(pixelContext, upperLine, upperBg);
  const lowerFg = sampleLineForeground(pixelContext, lowerLine, lowerBg);
  if (upperFg && lowerFg && rgbDistance(upperFg, lowerFg) > 58) return false;

  // Check if a bubble border, button outline, or canvas divider interrupts the vertical gap between lines.
  const gapTop = Math.ceil(upperLine.y + upperLine.height);
  const gapBottom = Math.floor(lowerLine.y);
  const gapSpan = gapBottom - gapTop;
  if (gapSpan >= 3) {
    const startX = Math.max(0, Math.floor(Math.max(upperLine.x, lowerLine.x)));
    const endX = Math.min(
      pixelContext.width - 1,
      Math.ceil(Math.min(upperLine.x + upperLine.width, lowerLine.x + lowerLine.width)),
    );
    if (endX > startX) {
      const avgBg: RgbTuple = [
        Math.round((upperBg[0] + lowerBg[0]) / 2),
        Math.round((upperBg[1] + lowerBg[1]) / 2),
        Math.round((upperBg[2] + lowerBg[2]) / 2),
      ];
      const stepX = Math.max(1, Math.floor((endX - startX) / 24));
      const rowStep = Math.max(1, Math.floor(gapSpan / 5));
      for (let scanY = gapTop + 1; scanY < gapBottom; scanY += rowStep) {
        let total = 0;
        let divergent = 0;
        for (let x = startX; x <= endX; x += stepX) {
          const offset = (scanY * pixelContext.width + x) * 4;
          if ((pixelContext.pixels[offset + 3] ?? 0) < 128) continue;
          total += 1;
          const sample: RgbTuple = [
            pixelContext.pixels[offset] ?? 0,
            pixelContext.pixels[offset + 1] ?? 0,
            pixelContext.pixels[offset + 2] ?? 0,
          ];
          if (rgbDistance(sample, avgBg) > 26) divergent += 1;
        }
        if (total >= 4 && divergent / total > 0.35) return false;
      }
    }
  }
  return true;
}

function medianHeight(boxes: readonly OcrBox[], fallback: number): number {
  const heights = boxes.map((item) => item.height).filter((h) => Number.isFinite(h) && h > 0).sort((a, b) => a - b);
  return heights.length ? heights[Math.floor(heights.length / 2)]! : fallback;
}

function mergeRegionPair(left: LayoutOcrRegion, right: LayoutOcrRegion, verticalBlock = false): LayoutOcrRegion {
  const leftWeight = Math.max(left.text.length, 1);
  const rightWeight = Math.max(right.text.length, 1);
  const leftText = left.text.trim();
  const rightText = right.text.trim();
  const leftNorm = normalizeOcrText(leftText);
  const rightNorm = normalizeOcrText(rightText);

  let text: string;
  let lineBoxes: OcrBox[];
  if (!verticalBlock && leftNorm && rightNorm && (leftNorm.includes(rightNorm) || rightNorm.includes(leftNorm))) {
    text = leftNorm.length >= rightNorm.length ? leftText : rightText;
    lineBoxes = [unionBox(left.box, right.box)];
  } else if (verticalBlock) {
    const upperFirst = left.box.y <= right.box.y;
    const first = upperFirst ? left : right;
    const second = upperFirst ? right : left;
    text = joinVerticalBlockText(first.text, second.text);
    lineBoxes = [...first.lineBoxes, ...second.lineBoxes].sort((a, b) => a.y - b.y || a.x - b.x);
  } else {
    const ordered = left.box.y < right.box.y - Math.min(left.box.height, right.box.height) * 0.35
      ? [leftText, rightText]
      : left.box.x <= right.box.x ? [leftText, rightText] : [rightText, leftText];
    text = joinHorizontalText(ordered[0]!, ordered[1]!).replace(/[^\S\n]+/g, " ").trim();
    lineBoxes = [unionBox(left.box, right.box)];
  }

  const fallbackLineHeight = ((left.lineHeight || left.box.height) + (right.lineHeight || right.box.height)) / 2;
  const blockLineHeight = medianHeight(lineBoxes, fallbackLineHeight);
  return {
    text,
    confidence: (left.confidence * leftWeight + right.confidence * rightWeight) / (leftWeight + rightWeight),
    box: unionBox(left.box, right.box),
    lineBoxes,
    lineHeight: blockLineHeight,
    _lineHeight: blockLineHeight,
  };
}

function overlapRatioOfSmaller(left: LayoutOcrRegion, right: LayoutOcrRegion): number {
  const intersection = intersectionArea(left.box, right.box);
  const smaller = Math.min(boxArea(left.box), boxArea(right.box));
  return smaller > 0 ? intersection / smaller : 0;
}

function verticalOverlapRatio(left: LayoutOcrRegion, right: LayoutOcrRegion): number {
  const top = Math.max(left.box.y, right.box.y);
  const bottom = Math.min(left.box.y + left.box.height, right.box.y + right.box.height);
  const overlap = Math.max(0, bottom - top);
  return overlap / Math.max(1, Math.min(left.box.height, right.box.height));
}

function sameVisualLine(left: LayoutOcrRegion, right: LayoutOcrRegion): boolean {
  if (verticalOverlapRatio(left, right) < 0.58) return false;
  // Do not weld message text to timestamps/read receipts/counters. Those short UI
  // labels often sit on the same baseline as a chat message but must remain a
  // separate OCR region so they are not fed into translation.
  if (isUiMetadataText(left.text) !== isUiMetadataText(right.text)) return false;
  const gap = right.box.x - (left.box.x + left.box.width);
  const maxHeight = Math.max(left.box.height, right.box.height);
  return gap <= Math.max(10, maxHeight * 0.62) && gap >= -maxHeight * 1.2;
}

function horizontalOverlapRatio(left: LayoutOcrRegion, right: LayoutOcrRegion): number {
  const start = Math.max(left.box.x, right.box.x);
  const end = Math.min(left.box.x + left.box.width, right.box.x + right.box.width);
  const overlap = Math.max(0, end - start);
  return overlap / Math.max(1, Math.min(left.box.width, right.box.width));
}

function sameTextBlock(
  upper: LayoutOcrRegion,
  lower: LayoutOcrRegion,
  pixelContext?: OcrPixelContext,
): boolean {
  if (lower.box.y < upper.box.y) return sameTextBlock(lower, upper, pixelContext);
  if (isUiMetadataText(upper.text) || isUiMetadataText(lower.text)) return false;
  const upperLine = upper.lineHeight || upper.box.height;
  const lowerLine = lower.lineHeight || lower.box.height;
  const maxLine = Math.max(upperLine, lowerLine);
  const minLine = Math.max(1, Math.min(upperLine, lowerLine));
  // Require line heights within 20% so headings and descriptions stay distinct blocks.
  if ((maxLine - minLine) / maxLine >= 0.2) return false;
  const gap = lower.box.y - (upper.box.y + upper.box.height);
  if (gap < -minLine * 0.35 || gap > Math.max(8, minLine * 1.5)) return false;
  if (upper.lineBoxes.length >= 2) {
    const internalGaps: number[] = [];
    for (let i = 0; i < upper.lineBoxes.length - 1; i += 1) {
      const a = upper.lineBoxes[i]!;
      const b = upper.lineBoxes[i + 1]!;
      internalGaps.push(Math.max(0, b.y - (a.y + a.height)));
    }
    internalGaps.sort((a, b) => a - b);
    const medianInternalGap = internalGaps[Math.floor(internalGaps.length / 2)] ?? 0;
    if (gap > Math.max(medianInternalGap * 1.85 + 4, minLine * 0.55)) return false;
  }
  const overlap = horizontalOverlapRatio(upper, lower);
  const alignTolerance = gap > minLine * 0.85 ? minLine * 1.05 : minLine * 1.35;
  const leftAligned = Math.abs(upper.box.x - lower.box.x) <= alignTolerance;
  const rightAligned = Math.abs((upper.box.x + upper.box.width) - (lower.box.x + lower.box.width)) <= alignTolerance;
  const centerAligned = Math.abs((upper.box.x + upper.box.width / 2) - (lower.box.x + lower.box.width / 2)) <= alignTolerance;
  if (gap > minLine * 0.85) {
    if (!(leftAligned || centerAligned)) return false;
  } else if (!(overlap >= 0.36 || leftAligned || rightAligned || centerAligned)) {
    return false;
  }
  return backgroundsAndForegroundsCompatible(upper, lower, pixelContext);
}

function mergeTextBlocks(
  regions: readonly LayoutOcrRegion[],
  pixelContext?: OcrPixelContext,
): LayoutOcrRegion[] {
  const output: LayoutOcrRegion[] = [];
  for (const region of regions) {
    let bestIndex = -1;
    let bestGap = Infinity;
    for (let index = 0; index < output.length; index += 1) {
      const existing = output[index];
      if (!existing || !sameTextBlock(existing, region, pixelContext)) continue;
      const gap = Math.abs(region.box.y - (existing.box.y + existing.box.height));
      if (gap < bestGap) {
        bestGap = gap;
        bestIndex = index;
      }
    }
    if (bestIndex < 0) output.push(region);
    else {
      const existing = output[bestIndex];
      if (existing) output[bestIndex] = mergeRegionPair(existing, region, true);
    }
  }
  return output;
}

function collapseOverlappingRegions(regions: readonly LayoutOcrRegion[]): LayoutOcrRegion[] {
  const output: LayoutOcrRegion[] = [];
  for (const region of regions) {
    let merged = false;
    for (let index = 0; index < output.length; index += 1) {
      const existing = output[index];
      if (!existing || overlapRatioOfSmaller(existing, region) < 0.68) continue;
      output[index] = mergeRegionPair(existing, region);
      merged = true;
      break;
    }
    if (!merged) output.push(region);
  }
  return output;
}

export function mergeOcrRegions(
  regions: readonly OcrRegion[],
  pixelContext?: OcrPixelContext,
): OcrRegion[] {
  const normalized: LayoutOcrRegion[] = regions
    .filter((region) => region.text.trim().length > 0 && region.box.width > 0 && region.box.height > 0)
    .map((region) => {
      const box = { ...region.box };
      const lineHeight = Number(region.lineHeight ?? region._lineHeight) || box.height;
      const lineBoxes = Array.isArray(region.lineBoxes) && region.lineBoxes.length > 0
        ? region.lineBoxes.map((item) => ({ ...item }))
        : [box];
      return {
        ...region,
        text: region.text.trim(),
        box,
        lineBoxes,
        lineHeight,
        _lineHeight: lineHeight,
      };
    });
  const deduped = collapseOverlappingRegions(normalized).sort((a, b) => {
    const vertical = a.box.y - b.box.y;
    if (Math.abs(vertical) > Math.max(a.box.height, b.box.height) * 0.4) return vertical;
    return a.box.x - b.box.x;
  });
  const merged: LayoutOcrRegion[] = [];
  for (const region of deduped) {
    const previous = merged.at(-1);
    if (!previous || !sameVisualLine(previous, region)) {
      merged.push(region);
      continue;
    }
    merged[merged.length - 1] = mergeRegionPair(previous, region);
  }
  const lineMerged = collapseOverlappingRegions(merged).sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x);
  return mergeTextBlocks(lineMerged, pixelContext).sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x);
}
