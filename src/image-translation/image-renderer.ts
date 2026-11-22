import type { OcrBox, OcrRegion } from "./ocr-layout";

export type RgbColor = [number, number, number];

export interface RegionAppearance {
  bgRgb: RgbColor;
  backgroundCss: string;
  fgRgb: RgbColor;
  foregroundCss: string;
  bgSpread: number;
  isUniform: boolean;
  fontWeight: number;
  edgeColors: {
    top: RgbColor;
    bottom: RgbColor;
    left: RgbColor;
    right: RgbColor;
  };
}

export interface CanvasTextLayout {
  fontSize: number;
  lineHeight: number;
  paragraphGap: number;
  paragraphs: string[][];
  totalHeight: number;
}

const IMAGE_FONT_STACK = '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", "Source Han Sans SC", system-ui, -apple-system, "Segoe UI", sans-serif';
const NO_LINE_START_CHARS = new Set([
  "，", "。", "！", "？", "；", "：", "、", "）", "》", "」", "』", "】", "”", "’", "…", "—",
  ",", ".", "!", "?", ";", ":", ")", "]", "}", "%",
]);
const NO_LINE_END_CHARS = new Set(["（", "《", "「", "『", "【", "“", "‘", "(", "[", "{"]);

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function rgbCss([r, g, b]: RgbColor, alpha = 1): string {
  if (alpha >= 0.999) return `rgb(${r}, ${g}, ${b})`;
  return `rgba(${r}, ${g}, ${b}, ${Number(alpha.toFixed(3))})`;
}

export function rgbDistance(left: RgbColor, right: RgbColor): number {
  const dr = left[0] - right[0];
  const dg = left[1] - right[1];
  const db = left[2] - right[2];
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

function relativeLuminance([r, g, b]: RgbColor): number {
  const channel = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function contrastRatio(left: RgbColor, right: RgbColor): number {
  const l1 = relativeLuminance(left);
  const l2 = relativeLuminance(right);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

function averageRgb(samples: readonly RgbColor[], fallback: RgbColor): RgbColor {
  if (samples.length === 0) return fallback;
  let r = 0;
  let g = 0;
  let b = 0;
  for (const sample of samples) {
    r += sample[0];
    g += sample[1];
    b += sample[2];
  }
  return [
    Math.round(r / samples.length),
    Math.round(g / samples.length),
    Math.round(b / samples.length),
  ];
}

function dominantClusterRgb(samples: readonly RgbColor[], fallback: RgbColor): { rgb: RgbColor; spread: number } {
  if (samples.length === 0) return { rgb: fallback, spread: 0 };
  const buckets = new Map<number, { count: number; r: number; g: number; b: number }>();
  for (const [r, g, b] of samples) {
    const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    const existing = buckets.get(key);
    if (existing) {
      existing.count += 1;
      existing.r += r;
      existing.g += g;
      existing.b += b;
    } else {
      buckets.set(key, { count: 1, r, g, b });
    }
  }
  let best: { count: number; r: number; g: number; b: number } | null = null;
  for (const entry of buckets.values()) {
    if (!best || entry.count > best.count) best = entry;
  }
  if (!best) return { rgb: fallback, spread: 0 };
  const center: RgbColor = [
    Math.round(best.r / best.count),
    Math.round(best.g / best.count),
    Math.round(best.b / best.count),
  ];

  // Refine mean using all samples close to the dominant cluster peak.
  let nearCount = 0;
  let nearR = 0;
  let nearG = 0;
  let nearB = 0;
  let sumSqDist = 0;
  for (const sample of samples) {
    const dist = rgbDistance(sample, center);
    sumSqDist += dist * dist;
    if (dist <= 20) {
      nearCount += 1;
      nearR += sample[0];
      nearG += sample[1];
      nearB += sample[2];
    }
  }
  const rgb: RgbColor = nearCount >= 3
    ? [Math.round(nearR / nearCount), Math.round(nearG / nearCount), Math.round(nearB / nearCount)]
    : center;
  const spread = Math.sqrt(sumSqDist / samples.length);
  return { rgb, spread };
}

function medianChannelRgb(samples: readonly RgbColor[], fallback: RgbColor): RgbColor {
  if (samples.length === 0) return fallback;
  const pick = (channel: 0 | 1 | 2): number => {
    const sorted = samples.map((item) => item[channel]).sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)]!;
  };
  return [pick(0), pick(1), pick(2)];
}

function ensureReadableForeground(fg: RgbColor, bg: RgbColor, minContrast = 3.0): RgbColor {
  if (contrastRatio(fg, bg) >= minContrast) return fg;
  const bgLum = relativeLuminance(bg);
  const darken = bgLum > 0.32;
  let current: RgbColor = [...fg];
  for (let step = 0; step < 12; step += 1) {
    current = darken
      ? [Math.round(current[0] * 0.84), Math.round(current[1] * 0.84), Math.round(current[2] * 0.84)]
      : [
          Math.round(current[0] + (255 - current[0]) * 0.25),
          Math.round(current[1] + (255 - current[1]) * 0.25),
          Math.round(current[2] + (255 - current[2]) * 0.25),
        ];
    if (contrastRatio(current, bg) >= minContrast) return current;
  }
  return darken ? [24, 26, 30] : [248, 250, 252];
}

function pointInsideAnyBox(x: number, y: number, boxes: readonly OcrBox[]): boolean {
  for (const box of boxes) {
    if (x >= box.x && x <= box.x + box.width && y >= box.y && y <= box.y + box.height) return true;
  }
  return false;
}

export function analyzeRegionAppearance(
  pixels: Uint8ClampedArray,
  imageWidth: number,
  imageHeight: number,
  box: OcrBox,
  lineBoxes: readonly OcrBox[],
): RegionAppearance {
  const targetBoxes = lineBoxes.length > 0 ? lineBoxes : [box];
  const ringSamples: RgbColor[] = [];
  const topSamples: RgbColor[] = [];
  const bottomSamples: RgbColor[] = [];
  const leftSamples: RgbColor[] = [];
  const rightSamples: RgbColor[] = [];

  const samplePixel = (x: number, y: number): RgbColor | null => {
    if (x < 0 || y < 0 || x >= imageWidth || y >= imageHeight) return null;
    const offset = (y * imageWidth + x) * 4;
    if ((pixels[offset + 3] ?? 0) < 128) return null;
    return [pixels[offset] ?? 0, pixels[offset + 1] ?? 0, pixels[offset + 2] ?? 0];
  };

  for (const line of targetBoxes) {
    const x0 = clamp(Math.floor(line.x), 0, imageWidth - 1);
    const y0 = clamp(Math.floor(line.y), 0, imageHeight - 1);
    const x1 = clamp(Math.ceil(line.x + line.width), 0, imageWidth - 1);
    const y1 = clamp(Math.ceil(line.y + line.height), 0, imageHeight - 1);
    const band = clamp(Math.round(line.height * 0.16), 2, 5);
    const stepX = Math.max(1, Math.floor((x1 - x0) / 48));
    const stepY = Math.max(1, Math.floor((y1 - y0) / 16));

    for (let x = x0; x <= x1; x += stepX) {
      for (let d = 1; d <= band; d += 1) {
        if (!pointInsideAnyBox(x, y0 - d, targetBoxes)) {
          const px = samplePixel(x, y0 - d);
          if (px) {
            ringSamples.push(px);
            topSamples.push(px);
          }
        }
        if (!pointInsideAnyBox(x, y1 + d, targetBoxes)) {
          const px = samplePixel(x, y1 + d);
          if (px) {
            ringSamples.push(px);
            bottomSamples.push(px);
          }
        }
      }
    }
    for (let y = y0; y <= y1; y += stepY) {
      for (let d = 1; d <= band; d += 1) {
        if (!pointInsideAnyBox(x0 - d, y, targetBoxes)) {
          const px = samplePixel(x0 - d, y);
          if (px) {
            ringSamples.push(px);
            leftSamples.push(px);
          }
        }
        if (!pointInsideAnyBox(x1 + d, y, targetBoxes)) {
          const px = samplePixel(x1 + d, y);
          if (px) {
            ringSamples.push(px);
            rightSamples.push(px);
          }
        }
      }
    }
  }

  const fallbackBg: RgbColor = [245, 245, 245];
  const { rgb: bgRgb, spread: bgSpread } = dominantClusterRgb(ringSamples, fallbackBg);

  // Sample interior pixels of original text lines to extract farthest foreground cluster
  // and measure stroke coverage inside tight glyph bounding boxes.
  const interiorScored: Array<{ rgb: RgbColor; dist: number }> = [];
  const lineGrids: Array<{ cols: number; rows: number; dists: Float32Array }> = [];

  for (const line of targetBoxes) {
    const x0 = clamp(Math.floor(line.x), 0, imageWidth - 1);
    const y0 = clamp(Math.floor(line.y), 0, imageHeight - 1);
    const x1 = clamp(Math.ceil(line.x + line.width), 0, imageWidth - 1);
    const y1 = clamp(Math.ceil(line.y + line.height), 0, imageHeight - 1);
    const stepX = Math.max(1, Math.floor((x1 - x0) / 140));
    const stepY = Math.max(1, Math.floor((y1 - y0) / 36));
    const cols = Math.floor((x1 - x0) / stepX) + 1;
    const rows = Math.floor((y1 - y0) / stepY) + 1;
    const dists = new Float32Array(cols * rows);

    let r = 0;
    for (let y = y0; y <= y1; y += stepY, r += 1) {
      let c = 0;
      for (let x = x0; x <= x1; x += stepX, c += 1) {
        const px = samplePixel(x, y);
        if (!px) continue;
        const dist = rgbDistance(px, bgRgb);
        dists[r * cols + c] = dist;
        if (dist >= 32) {
          interiorScored.push({ rgb: px, dist });
        }
      }
    }
    lineGrids.push({ cols, rows, dists });
  }

  let rawFg: RgbColor = relativeLuminance(bgRgb) > 0.32 ? [24, 26, 30] : [248, 250, 252];
  if (interiorScored.length >= 4) {
    interiorScored.sort((a, b) => b.dist - a.dist);
    const topCount = Math.max(4, Math.floor(interiorScored.length * 0.35));
    const farthestSamples = interiorScored.slice(0, topCount).map((entry) => entry.rgb);
    rawFg = medianChannelRgb(farthestSamples, rawFg);
  }
  const fgRgb = ensureReadableForeground(rawFg, bgRgb, 3.0);

  // Measure foreground stroke area ratio inside each line's core tight glyph band
  // (excluding outer OCR padding, sparse ascender/descender tails, and inter-word spaces).
  const fgDist = Math.max(36, rgbDistance(rawFg, bgRgb));
  const strokeThreshold = Math.max(32, fgDist * 0.42);
  let totalTightInk = 0;
  let totalTightArea = 0;

  for (const grid of lineGrids) {
    const { cols, rows, dists } = grid;
    let minRow = rows;
    let maxRow = -1;
    const colHasStroke = new Uint8Array(cols);
    const rowInk = new Float32Array(rows);

    for (let r = 0; r < rows; r += 1) {
      const rowOffset = r * cols;
      for (let c = 0; c < cols; c += 1) {
        const d = dists[rowOffset + c]!;
        if (d >= strokeThreshold) {
          if (r < minRow) minRow = r;
          if (r > maxRow) maxRow = r;
          colHasStroke[c] = 1;
        }
        if (d >= 24) {
          rowInk[r] = (rowInk[r] ?? 0) + Math.min(1, d / fgDist);
        }
      }
    }
    if (maxRow < minRow) continue;

    // Isolate the core glyph body band (rows carrying >= 35% of peak row ink) so
    // stroke density does not fluctuate with whether a line contains descenders (g, p, y).
    let peakRowInk = 0;
    for (let r = minRow; r <= maxRow; r += 1) {
      if ((rowInk[r] ?? 0) > peakRowInk) peakRowInk = rowInk[r]!;
    }
    let coreMinRow = rows;
    let coreMaxRow = -1;
    for (let r = minRow; r <= maxRow; r += 1) {
      if ((rowInk[r] ?? 0) >= peakRowInk * 0.35) {
        if (r < coreMinRow) coreMinRow = r;
        if (r > coreMaxRow) coreMaxRow = r;
      }
    }
    if (coreMaxRow < coreMinRow) {
      coreMinRow = minRow;
      coreMaxRow = maxRow;
    }

    const coreHeight = coreMaxRow - coreMinRow + 1;
    const wordGapCols = Math.max(2, Math.round(coreHeight * 0.28));

    // Identify word-level tight horizontal spans by skipping empty gaps wider than wordGapCols.
    let c = 0;
    while (c < cols) {
      while (c < cols && !colHasStroke[c]) c += 1;
      if (c >= cols) break;
      const spanStart = c;
      let spanEnd = c;
      let emptyRun = 0;
      c += 1;
      while (c < cols) {
        if (colHasStroke[c]) {
          spanEnd = c;
          emptyRun = 0;
        } else {
          emptyRun += 1;
          if (emptyRun > wordGapCols) break;
        }
        c += 1;
      }

      const spanWidth = spanEnd - spanStart + 1;
      let inkSum = 0;
      for (let r = coreMinRow; r <= coreMaxRow; r += 1) {
        const rowOffset = r * cols;
        for (let sc = spanStart; sc <= spanEnd; sc += 1) {
          const d = dists[rowOffset + sc]!;
          if (d >= 24) {
            inkSum += Math.min(1, d / fgDist);
          }
        }
      }
      totalTightInk += inkSum;
      totalTightArea += spanWidth * coreHeight;
    }
  }

  const tightStrokeRatio = totalTightArea > 0 ? totalTightInk / totalTightArea : 0.32;
  const fontWeight = tightStrokeRatio >= 0.49 ? 700 : tightStrokeRatio >= 0.43 ? 600 : 400;

  return {
    bgRgb,
    backgroundCss: rgbCss(bgRgb),
    fgRgb,
    foregroundCss: rgbCss(fgRgb),
    bgSpread,
    isUniform: bgSpread < 20,
    fontWeight,
    edgeColors: {
      top: dominantClusterRgb(topSamples, bgRgb).rgb,
      bottom: dominantClusterRgb(bottomSamples, bgRgb).rgb,
      left: dominantClusterRgb(leftSamples, bgRgb).rgb,
      right: dominantClusterRgb(rightSamples, bgRgb).rgb,
    },
  };
}

function stripMatchesBackground(
  pixels: Uint8ClampedArray,
  imageWidth: number,
  imageHeight: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  bgRgb: RgbColor,
  tolerance = 30,
  minMatchRatio = 0.95,
): boolean {
  const cx0 = clamp(Math.floor(x0), 0, imageWidth - 1);
  const cy0 = clamp(Math.floor(y0), 0, imageHeight - 1);
  const cx1 = clamp(Math.ceil(x1), 0, imageWidth - 1);
  const cy1 = clamp(Math.ceil(y1), 0, imageHeight - 1);
  const horizontal = cx1 - cx0 >= cy1 - cy0;
  const span = Math.max(1, horizontal ? cx1 - cx0 : cy1 - cy0);
  const step = Math.max(1, Math.floor(span / 96));
  let total = 0;
  let matching = 0;

  if (horizontal) {
    const y = Math.round((cy0 + cy1) / 2);
    for (let x = cx0; x <= cx1; x += step) {
      const offset = (y * imageWidth + x) * 4;
      if ((pixels[offset + 3] ?? 0) < 128) continue;
      total += 1;
      const sample: RgbColor = [pixels[offset] ?? 0, pixels[offset + 1] ?? 0, pixels[offset + 2] ?? 0];
      if (rgbDistance(sample, bgRgb) <= tolerance) matching += 1;
    }
  } else {
    const x = Math.round((cx0 + cx1) / 2);
    for (let y = cy0; y <= cy1; y += step) {
      const offset = (y * imageWidth + x) * 4;
      if ((pixels[offset + 3] ?? 0) < 128) continue;
      total += 1;
      const sample: RgbColor = [pixels[offset] ?? 0, pixels[offset + 1] ?? 0, pixels[offset + 2] ?? 0];
      if (rgbDistance(sample, bgRgb) <= tolerance) matching += 1;
    }
  }
  return total > 0 && matching / total >= minMatchRatio;
}

export function clampBoxToUniformBackground(
  pixels: Uint8ClampedArray,
  imageWidth: number,
  imageHeight: number,
  box: OcrBox,
  bgRgb: RgbColor,
  maxPadX: number,
  maxPadY: number,
): OcrBox {
  let left = clamp(box.x, 0, imageWidth);
  let right = clamp(box.x + box.width, 0, imageWidth);
  let top = clamp(box.y, 0, imageHeight);
  let bottom = clamp(box.y + box.height, 0, imageHeight);

  const growSide = (
    maxSteps: number,
    check: (delta: number) => boolean,
  ): number => {
    let accepted = 0;
    for (let delta = 1; delta <= maxSteps; delta += 1) {
      if (!check(delta)) break;
      accepted = delta;
    }
    return accepted;
  };

  const padLeft = growSide(maxPadX, (d) =>
    left - d >= 0 && stripMatchesBackground(pixels, imageWidth, imageHeight, left - d, top, left - d, bottom, bgRgb, 30, 0.95));
  const padRight = growSide(maxPadX, (d) =>
    right + d < imageWidth && stripMatchesBackground(pixels, imageWidth, imageHeight, right + d, top, right + d, bottom, bgRgb, 30, 0.95));
  const padTop = growSide(maxPadY, (d) =>
    top - d >= 0 && stripMatchesBackground(pixels, imageWidth, imageHeight, left, top - d, right, top - d, bgRgb, 30, 0.95));
  const padBottom = growSide(maxPadY, (d) =>
    bottom + d < imageHeight && stripMatchesBackground(pixels, imageWidth, imageHeight, left, bottom + d, right, bottom + d, bgRgb, 30, 0.95));

  left = Math.max(0, left - padLeft);
  right = Math.min(imageWidth, right + padRight);
  top = Math.max(0, top - padTop);
  bottom = Math.min(imageHeight, bottom + padBottom);
  return { x: left, y: top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) };
}

function hasCjkText(text: string): boolean {
  return /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text);
}

function isWordJoinChar(char: string): boolean {
  return /[A-Za-z0-9'’_-]/.test(char);
}

export function wrapTranslatedParagraphs(
  measureWidth: (value: string) => number,
  text: string,
  maxWidth: number,
): string[][] {
  const safeMaxWidth = Math.max(8, maxWidth);
  const rawParagraphs = String(text ?? "")
    .replace(/\r\n?/g, "\n")
    .split("\n");

  const result: string[][] = [];
  for (const rawParagraph of rawParagraphs) {
    const paragraph = rawParagraph.replace(/[^\S\n]+/g, " ").trim();
    if (!paragraph) continue;
    const chars = Array.from(paragraph);
    const lines: string[] = [];
    let current = "";
    let lastWhitespaceIndex = -1;

    const pushLine = (value: string) => {
      const cleaned = value.trim();
      if (cleaned) lines.push(cleaned);
    };

    for (let index = 0; index < chars.length; index += 1) {
      const char = chars[index]!;
      if (current === "" && char === " ") continue;
      const candidate = current + char;
      if (/\s/u.test(char)) lastWhitespaceIndex = current.length;

      if (current && measureWidth(candidate) > safeMaxWidth) {
        if (NO_LINE_START_CHARS.has(char)) {
          const currentChars = Array.from(current);
          if (currentChars.length >= 2) {
            const pulled = currentChars.pop()!;
            pushLine(currentChars.join(""));
            current = pulled + char;
            lastWhitespaceIndex = -1;
            continue;
          }
        }

        if (lastWhitespaceIndex > 0 && isWordJoinChar(char)) {
          const head = current.slice(0, lastWhitespaceIndex).trimEnd();
          const tail = current.slice(lastWhitespaceIndex + 1).trimStart();
          pushLine(head);
          current = tail + char;
          lastWhitespaceIndex = -1;
          continue;
        }

        const currentChars = Array.from(current);
        const lastChar = currentChars.at(-1) ?? "";
        if (currentChars.length >= 2 && NO_LINE_END_CHARS.has(lastChar)) {
          currentChars.pop();
          pushLine(currentChars.join(""));
          current = lastChar + (char === " " ? "" : char);
          lastWhitespaceIndex = -1;
          continue;
        }

        pushLine(current);
        current = char === " " ? "" : char;
        lastWhitespaceIndex = -1;
        continue;
      }

      current = candidate;
    }

    pushLine(current);
    if (lines.length > 0) result.push(lines);
  }
  return result;
}

export function inferTextAlignment(box: OcrBox, lineBoxes: readonly OcrBox[]): "left" | "center" | "right" {
  if (lineBoxes.length < 2) return "left";
  const maxWidth = Math.max(...lineBoxes.map((line) => line.width));
  const minWidth = Math.min(...lineBoxes.map((line) => line.width));
  if (maxWidth <= 0 || minWidth / maxWidth > 0.88) return "left";

  const boxCenter = box.x + box.width / 2;
  const boxRight = box.x + box.width;
  let leftErr = 0;
  let centerErr = 0;
  let rightErr = 0;
  for (const line of lineBoxes) {
    leftErr += Math.abs(line.x - box.x);
    centerErr += Math.abs((line.x + line.width / 2) - boxCenter);
    rightErr += Math.abs((line.x + line.width) - boxRight);
  }
  const threshold = Math.max(4, box.width * 0.06) * lineBoxes.length;
  if (centerErr < leftErr * 0.65 && centerErr < rightErr * 0.65 && centerErr <= threshold) return "center";
  if (rightErr < leftErr * 0.6 && rightErr <= threshold) return "right";
  return "left";
}

function estimateCjkEquivalentLength(text: string): number {
  let length = 0;
  for (const char of Array.from(text)) {
    if (/\s/u.test(char)) length += 0.3;
    else if (hasCjkText(char)) length += 1;
    else length += 0.55;
  }
  return length;
}

function boxVerticalOverlapRatio(left: OcrBox, right: OcrBox): number {
  const top = Math.max(left.y, right.y);
  const bottom = Math.min(left.y + left.height, right.y + right.height);
  const overlap = Math.max(0, bottom - top);
  return overlap / Math.max(1, Math.min(left.height, right.height));
}

function boxHorizontalGap(left: OcrBox, right: OcrBox): number {
  if (left.x + left.width <= right.x) return right.x - (left.x + left.width);
  if (right.x + right.width <= left.x) return left.x - (right.x + right.width);
  return 0;
}

export function isStandaloneShortBox(
  region: OcrRegion,
  allRegions: readonly OcrRegion[],
  translatedText: string,
  regionBgByRef?: ReadonlyMap<OcrRegion, RgbColor>,
): boolean {
  const rawLineBoxes = Array.isArray(region.lineBoxes) && region.lineBoxes.length > 0
    ? region.lineBoxes
    : [region.box];
  const lineHeight = Math.max(1, Number(region.lineHeight ?? region._lineHeight) || region.box.height);
  if (rawLineBoxes.length > 1 || region.box.height > lineHeight * 1.65) return false;
  if (region.box.width > lineHeight * 7.5) return false;

  const trimmed = String(translatedText ?? "").trim();
  if (!trimmed || trimmed.includes("\n")) return false;
  const withoutTrailingEllipsis = trimmed.replace(/(?:\.{3}|…)\s*$/u, "").trim();
  if (!withoutTrailingEllipsis) return false;
  if (/[，。！？；：,.!?;]/u.test(withoutTrailingEllipsis)) return false;
  if (estimateCjkEquivalentLength(withoutTrailingEllipsis) > 5.5) return false;

  const closeInlineGap = Math.max(10, lineHeight * 0.9);
  let hasRowPeer = false;
  for (const other of allRegions) {
    if (other === region) continue;
    if (boxVerticalOverlapRatio(region.box, other.box) >= 0.4) {
      hasRowPeer = true;
      if (boxHorizontalGap(region.box, other.box) < closeInlineGap) return false;
    }
  }

  // Keep left-aligned single-line headings directly above a left-aligned subtitle or
  // body block on the same background left-aligned instead of shifting them right.
  if (!hasRowPeer) {
    const myBg = regionBgByRef?.get(region);
    const maxHeadingGap = Math.max(24, lineHeight * 2.2);
    const leftTolerance = Math.max(8, lineHeight * 0.55);
    for (const other of allRegions) {
      if (other === region) continue;
      const gapY = other.box.y - (region.box.y + region.box.height);
      if (gapY < 0 || gapY > maxHeadingGap) continue;
      if (Math.abs(other.box.x - region.box.x) > leftTolerance) continue;
      const otherLines = Array.isArray(other.lineBoxes) ? other.lineBoxes.length : 1;
      if (other.box.width < region.box.width * 0.85 && otherLines < 2) continue;
      const otherBg = regionBgByRef?.get(other);
      if (myBg && otherBg && rgbDistance(myBg, otherBg) > 26) continue;
      return false;
    }
  }

  return true;
}

function isOrphanLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  const totalChars = Array.from(trimmed);
  const coreChars = Array.from(trimmed.replace(/[\s\p{P}\p{S}]/gu, ""));
  return coreChars.length <= 2 && totalChars.length <= 4;
}

function countOrphanLines(paragraphs: readonly string[][]): number {
  let count = 0;
  for (const lines of paragraphs) {
    if (lines.length < 2) continue;
    const joined = lines.join("");
    if (!hasCjkText(joined)) continue;
    if (isOrphanLine(lines.at(-1) ?? "")) count += 1;
  }
  return count;
}

export function hasOrphanLastLine(paragraphs: readonly string[][]): boolean {
  return countOrphanLines(paragraphs) > 0;
}

function totalLineCount(paragraphs: readonly string[][]): number {
  return paragraphs.reduce((sum, lines) => sum + lines.length, 0);
}

export function fitRegionTypography(
  context: CanvasRenderingContext2D,
  text: string,
  textBox: OcrBox,
  targetFontSize: number,
  minFontSize: number,
  fontWeight: number,
  extraWidthSlack = 0,
): CanvasTextLayout {
  const cjk = hasCjkText(text);
  const lineHeightRatio = cjk ? 1.34 : 1.24;
  const paragraphGapRatio = 0.36;
  const maxWidth = Math.max(8, textBox.width);
  const maxHeight = Math.max(8, textBox.height);

  const measureAt = (fontSize: number, widthBudget = maxWidth): CanvasTextLayout => {
    context.font = `${fontWeight} ${fontSize}px ${IMAGE_FONT_STACK}`;
    const paragraphs = wrapTranslatedParagraphs((value) => context.measureText(value).width, text, widthBudget);
    const lineHeight = fontSize * lineHeightRatio;
    const paragraphGap = paragraphs.length > 1 ? fontSize * paragraphGapRatio : 0;
    const lineCount = totalLineCount(paragraphs);
    const totalHeight = lineCount * lineHeight + Math.max(0, paragraphs.length - 1) * paragraphGap;
    return { fontSize, lineHeight, paragraphGap, paragraphs, totalHeight };
  };

  const upper = Math.max(minFontSize, targetFontSize);
  let best = measureAt(upper);
  if (best.totalHeight > maxHeight + 0.5) {
    let low = minFontSize;
    let high = upper;
    best = measureAt(minFontSize);
    for (let iter = 0; iter < 9; iter += 1) {
      const mid = (low + high) / 2;
      const candidate = measureAt(mid);
      if (candidate.totalHeight <= maxHeight + 0.5) {
        best = candidate;
        low = mid;
      } else {
        high = mid;
      }
    }
  }

  // Orphan control: if a multi-line CJK paragraph ends with 1-2 characters (e.g. "序。"),
  // try relaxing right padding by 2-3px and/or shrinking font size by 5%-8% to pull it up.
  const baseOrphans = countOrphanLines(best.paragraphs);
  if (baseOrphans > 0) {
    const baseLines = totalLineCount(best.paragraphs);
    const slack = Math.max(0, extraWidthSlack);
    const attempts: Array<{ size: number; width: number }> = [];
    if (slack > 0) attempts.push({ size: best.fontSize, width: maxWidth + slack });
    for (const scale of [0.95, 0.92]) {
      const scaledSize = Math.max(minFontSize, best.fontSize * scale);
      if (scaledSize < best.fontSize - 0.05) {
        attempts.push({ size: scaledSize, width: maxWidth });
        if (slack > 0) attempts.push({ size: scaledSize, width: maxWidth + slack });
      }
    }
    for (const attempt of attempts) {
      const candidate = measureAt(attempt.size, attempt.width);
      if (
        candidate.totalHeight <= maxHeight + 0.5
        && countOrphanLines(candidate.paragraphs) < baseOrphans
        && totalLineCount(candidate.paragraphs) < baseLines
      ) {
        best = candidate;
        break;
      }
    }
  }

  return best;
}

function medianNumber(values: readonly number[], fallback: number): number {
  const clean = values.filter((value) => Number.isFinite(value) && value > 0).sort((a, b) => a - b);
  return clean.length ? clean[Math.floor(clean.length / 2)]! : fallback;
}

function drawRoundedRect(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  context.beginPath();
  if (typeof context.roundRect === "function") context.roundRect(x, y, width, height, radius);
  else context.rect(x, y, width, height);
}

function eraseBoxFeathered(
  context: CanvasRenderingContext2D,
  box: OcrBox,
  appearance: RegionAppearance,
  radius: number,
  scaleX: number,
  scaleY: number,
): void {
  const x = box.x * scaleX;
  const y = box.y * scaleY;
  const width = box.width * scaleX;
  const height = box.height * scaleY;

  context.save();
  if (appearance.isUniform) {
    const feather = Math.max(0.8, Math.min(2.2, Math.min(scaleX, scaleY) * 1.4));
    context.fillStyle = rgbCss(appearance.bgRgb, 0.55);
    drawRoundedRect(context, x - feather, y - feather, width + feather * 2, height + feather * 2, radius + feather);
    context.fill();

    context.fillStyle = appearance.backgroundCss;
    drawRoundedRect(context, x, y, width, height, radius);
    context.fill();
  } else {
    const vGrad = context.createLinearGradient(x, y, x, y + height);
    vGrad.addColorStop(0, rgbCss(appearance.edgeColors.top, 0.96));
    vGrad.addColorStop(0.5, rgbCss(appearance.bgRgb, 0.98));
    vGrad.addColorStop(1, rgbCss(appearance.edgeColors.bottom, 0.96));
    context.fillStyle = vGrad;
    drawRoundedRect(context, x, y, width, height, radius);
    context.fill();

    const hGrad = context.createLinearGradient(x, y, x + width, y);
    hGrad.addColorStop(0, rgbCss(appearance.edgeColors.left, 0.45));
    hGrad.addColorStop(0.5, rgbCss(averageRgb([appearance.edgeColors.left, appearance.edgeColors.right], appearance.bgRgb), 0.15));
    hGrad.addColorStop(1, rgbCss(appearance.edgeColors.right, 0.45));
    context.fillStyle = hGrad;
    drawRoundedRect(context, x, y, width, height, radius);
    context.fill();
  }
  context.restore();
}

export interface RenderTranslatedImageOptions {
  image?: HTMLImageElement;
  regions: readonly OcrRegion[];
  ocrWidth: number;
  ocrHeight: number;
  pixels: ArrayBuffer;
  displayWidth?: number;
  displayHeight?: number;
  devicePixelRatio?: number;
  /** When false (default overlay mode), leave areas outside text boxes transparent so the original image stays untouched. */
  paintBaseImage?: boolean;
}

export function renderTranslatedImageToCanvas(
  canvas: HTMLCanvasElement,
  options: RenderTranslatedImageOptions,
): boolean {
  const { image, regions, ocrWidth, ocrHeight } = options;
  const pixelBytes = new Uint8ClampedArray(options.pixels);
  const dpr = clamp(options.devicePixelRatio ?? 1, 1, 2);
  const displayWidth = Math.max(1, options.displayWidth ?? ocrWidth);
  const targetWidth = Math.max(Math.round(ocrWidth), Math.min(2400, Math.round(displayWidth * dpr)));
  const aspect = ocrHeight / Math.max(1, ocrWidth);
  const targetHeight = Math.max(1, Math.round(targetWidth * aspect));

  canvas.width = Math.max(1, targetWidth);
  canvas.height = Math.max(1, targetHeight);
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return false;

  context.clearRect(0, 0, canvas.width, canvas.height);

  // Keeping the canvas transparent outside translated text boxes preserves original
  // image sharpness, cross-origin safety, and page overlays. Standalone callers/tests
  // can opt into painting the base image via paintBaseImage: true.
  if (options.paintBaseImage && image) {
    try {
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = "high";
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
    } catch (error) {
      console.warn("[PageLingo] Could not paint source image onto translation canvas", error);
    }
  }

  const scaleX = canvas.width / Math.max(1, ocrWidth);
  const scaleY = canvas.height / Math.max(1, ocrHeight);
  const lineHeights = regions.map((region) => Number(region.lineHeight ?? region._lineHeight) || region.box.height);
  const medianLineHeight = medianNumber(lineHeights, 18);

  const prepared = regions.map((region) => {
    const rawLineBoxes = Array.isArray(region.lineBoxes) && region.lineBoxes.length > 0
      ? region.lineBoxes
      : [region.box];
    const fallbackLineHeight = Math.max(1, Number(region.lineHeight ?? region._lineHeight) || medianLineHeight);
    const lineHeight = medianNumber(rawLineBoxes.map((line) => line.height), fallbackLineHeight);
    const appearance = analyzeRegionAppearance(pixelBytes, ocrWidth, ocrHeight, region.box, rawLineBoxes);
    const maxPadX = clamp(Math.round(lineHeight * 0.24), 2, 8);
    const maxPadY = clamp(Math.round(lineHeight * 0.20), 2, 6);

    const eraseBoxes = rawLineBoxes.map((line) =>
      appearance.isUniform
        ? clampBoxToUniformBackground(pixelBytes, ocrWidth, ocrHeight, line, appearance.bgRgb, maxPadX, maxPadY)
        : {
            x: Math.max(0, line.x - 2),
            y: Math.max(0, line.y - 2),
            width: Math.min(ocrWidth - Math.max(0, line.x - 2), line.width + 4),
            height: Math.min(ocrHeight - Math.max(0, line.y - 2), line.height + 4),
          },
    );

    const bridgeBoxes: OcrBox[] = [];
    if (appearance.isUniform && eraseBoxes.length > 1) {
      for (let i = 0; i < eraseBoxes.length - 1; i += 1) {
        const upper = eraseBoxes[i]!;
        const lower = eraseBoxes[i + 1]!;
        const gapY = upper.y + upper.height;
        const gapHeight = lower.y - gapY;
        if (gapHeight > 0 && gapHeight <= lineHeight * 0.85) {
          const bx = Math.min(upper.x, lower.x);
          const bRight = Math.max(upper.x + upper.width, lower.x + lower.width);
          if (stripMatchesBackground(pixelBytes, ocrWidth, ocrHeight, bx, gapY, bRight, lower.y, appearance.bgRgb, 32, 0.85)) {
            bridgeBoxes.push({ x: bx, y: gapY - 1, width: Math.max(1, bRight - bx), height: gapHeight + 2 });
          }
        }
      }
    }

    let minX = ocrWidth;
    let minY = ocrHeight;
    let maxX = 0;
    let maxY = 0;
    for (const eb of eraseBoxes) {
      minX = Math.min(minX, eb.x);
      minY = Math.min(minY, eb.y);
      maxX = Math.max(maxX, eb.x + eb.width);
      maxY = Math.max(maxY, eb.y + eb.height);
    }
    const textBoxOcr: OcrBox = {
      x: minX,
      y: minY,
      width: Math.max(1, maxX - minX),
      height: Math.max(1, maxY - minY),
    };

    const alignment = inferTextAlignment(region.box, rawLineBoxes);
    const isSingleOriginalLine = rawLineBoxes.length === 1 && region.box.height <= lineHeight * 1.65;
    return {
      region,
      lineHeight,
      appearance,
      eraseBoxes,
      bridgeBoxes,
      textBoxOcr,
      alignment,
      isSingleOriginalLine,
    };
  });

  const regionBgByRef = new Map<OcrRegion, RgbColor>(
    prepared.map((entry) => [entry.region, entry.appearance.bgRgb]),
  );

  // Pass 1: Erase every source text line first so adjacent erasures never clip rendered translations.
  for (const entry of prepared) {
    const radius = clamp(entry.lineHeight * 0.16 * scaleY, 1, 6);
    for (const bridge of entry.bridgeBoxes) {
      eraseBoxFeathered(context, bridge, entry.appearance, 1, scaleX, scaleY);
    }
    for (const eraseBox of entry.eraseBoxes) {
      eraseBoxFeathered(context, eraseBox, entry.appearance, radius, scaleX, scaleY);
    }
  }

  // Pass 2: Draw crisp, properly aligned, non-squished translations while preserving visual hierarchy.
  for (const entry of prepared) {
    // Derive each block's initial font size directly from its own median OCR line height
    // so headings, body text, and secondary captions retain their original size hierarchy.
    const targetFont = Math.max(9, entry.lineHeight * 0.78 * scaleY);
    const weight = entry.appearance.fontWeight;

    const padX = Math.max(2, Math.min(6, targetFont * 0.16));
    const padY = Math.max(1, Math.min(4, targetFont * 0.10));
    const textBoxCanvas: OcrBox = {
      x: entry.textBoxOcr.x * scaleX + padX,
      y: entry.textBoxOcr.y * scaleY + padY,
      width: Math.max(8, entry.textBoxOcr.width * scaleX - padX * 2),
      height: Math.max(8, entry.textBoxOcr.height * scaleY - padY * 2),
    };

    const minFont = Math.max(7, Math.min(10, targetFont * 0.55));
    const extraWidthSlack = Math.min(3 * scaleX, padX);
    const layout = fitRegionTypography(
      context,
      entry.region.text,
      textBoxCanvas,
      targetFont,
      minFont,
      weight,
      extraWidthSlack,
    );

    context.save();
    context.fillStyle = entry.appearance.foregroundCss;
    context.font = `${weight} ${layout.fontSize}px ${IMAGE_FONT_STACK}`;

    const standaloneCenter = isStandaloneShortBox(entry.region, regions, entry.region.text, regionBgByRef);
    const isSingleRenderedLine = layout.paragraphs.length === 1 && (layout.paragraphs[0]?.length ?? 0) === 1;

    if (standaloneCenter && isSingleRenderedLine) {
      const line = layout.paragraphs[0]![0]!;
      const rawCenterX = (entry.region.box.x + entry.region.box.width / 2) * scaleX;
      const rawCenterY = (entry.region.box.y + entry.region.box.height / 2) * scaleY;
      const measuredW = context.measureText(line).width;
      const eraseLeft = entry.textBoxOcr.x * scaleX;
      const eraseRight = (entry.textBoxOcr.x + entry.textBoxOcr.width) * scaleX;
      const drawCenterX = eraseRight - eraseLeft >= measuredW
        ? clamp(rawCenterX, eraseLeft + measuredW / 2, eraseRight - measuredW / 2)
        : (eraseLeft + eraseRight) / 2;
      context.textAlign = "center";
      context.textBaseline = "middle";
      context.fillText(line, drawCenterX, rawCenterY);
    } else {
      context.textBaseline = "top";
      context.textAlign = entry.alignment;

      const drawX = entry.alignment === "center"
        ? textBoxCanvas.x + textBoxCanvas.width / 2
        : entry.alignment === "right"
          ? textBoxCanvas.x + textBoxCanvas.width
          : textBoxCanvas.x;

      const extraHeight = Math.max(0, textBoxCanvas.height - layout.totalHeight);
      let y = entry.isSingleOriginalLine && isSingleRenderedLine
        ? textBoxCanvas.y + extraHeight / 2
        : textBoxCanvas.y + Math.min(extraHeight * 0.25, layout.fontSize * 0.35);

      for (let pIndex = 0; pIndex < layout.paragraphs.length; pIndex += 1) {
        const lines = layout.paragraphs[pIndex]!;
        for (const line of lines) {
          context.fillText(line, drawX, y);
          y += layout.lineHeight;
        }
        if (pIndex < layout.paragraphs.length - 1) y += layout.paragraphGap;
      }
    }
    context.restore();
  }

  return true;
}
