export interface OcrBox { x:number; y:number; width:number; height:number }
export interface OcrRegion { text:string; confidence:number; box:OcrBox }
function boxArea(box) {
  return Math.max(0, box.width) * Math.max(0, box.height);
}
function intersectionArea(left, right) {
  const x1 = Math.max(left.x, right.x);
  const y1 = Math.max(left.y, right.y);
  const x2 = Math.min(left.x + left.width, right.x + right.width);
  const y2 = Math.min(left.y + left.height, right.y + right.height);
  return Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
}
function unionBox(left, right) {
  const x = Math.min(left.x, right.x);
  const y = Math.min(left.y, right.y);
  const maxX = Math.max(left.x + left.width, right.x + right.width);
  const maxY = Math.max(left.y + left.height, right.y + right.height);
  return { x, y, width: maxX - x, height: maxY - y };
}
function normalizeOcrText(value) {
  return value.normalize("NFKC").toLocaleLowerCase().replace(/[\s\p{P}]/gu, "");
}
function isUiMetadataText(value) {
  const text = String(value ?? "").normalize("NFKC").trim();
  if (!text) return true;
  if (/^[✓✔√vV\/\s]+$/u.test(text)) return true;
  if (/^\d{1,3}$/u.test(text)) return true;
  if (/^(?:today|yesterday|online|offline)$/iu.test(text)) return true;
  if (/^\d{1,2}:\d{2}(?:\s*(?:am|pm))?(?:\s*[✓✔√vV\/]+)?$/iu.test(text)) return true;
  return false;
}
function mergeRegionPair(left, right, verticalBlock = false) {
  const leftWeight = Math.max(left.text.length, 1);
  const rightWeight = Math.max(right.text.length, 1);
  const leftText = left.text.trim();
  const rightText = right.text.trim();
  const leftNorm = normalizeOcrText(leftText);
  const rightNorm = normalizeOcrText(rightText);
  let text;
  if (!verticalBlock && leftNorm && rightNorm && (leftNorm.includes(rightNorm) || rightNorm.includes(leftNorm))) {
    text = leftNorm.length >= rightNorm.length ? leftText : rightText;
  } else {
    const ordered = left.box.y < right.box.y - Math.min(left.box.height, right.box.height) * 0.35
      ? [leftText, rightText]
      : left.box.x <= right.box.x ? [leftText, rightText] : [rightText, leftText];
    text = ordered.join(verticalBlock ? "\n" : " ").replace(/[^\S\n]+/g, " ").trim();
  }
  const leftLineHeight = Number(left._lineHeight) || left.box.height;
  const rightLineHeight = Number(right._lineHeight) || right.box.height;
  return {
    text,
    confidence: (left.confidence * leftWeight + right.confidence * rightWeight) / (leftWeight + rightWeight),
    box: unionBox(left.box, right.box),
    _lineHeight: (leftLineHeight + rightLineHeight) / 2,
  };
}
function overlapRatioOfSmaller(left, right) {
  const intersection = intersectionArea(left.box, right.box);
  const smaller = Math.min(boxArea(left.box), boxArea(right.box));
  return smaller > 0 ? intersection / smaller : 0;
}
function verticalOverlapRatio(left, right) {
  const top = Math.max(left.box.y, right.box.y);
  const bottom = Math.min(left.box.y + left.box.height, right.box.y + right.box.height);
  const overlap = Math.max(0, bottom - top);
  return overlap / Math.max(1, Math.min(left.box.height, right.box.height));
}
function sameVisualLine(left, right) {
  if (verticalOverlapRatio(left, right) < 0.58) return false;
  // Do not weld message text to timestamps/read receipts/counters. Those short UI
  // labels often sit on the same baseline as a chat message but must remain a
  // separate OCR region so they are not fed into translation.
  if (isUiMetadataText(left.text) !== isUiMetadataText(right.text)) return false;
  const gap = right.box.x - (left.box.x + left.box.width);
  const maxHeight = Math.max(left.box.height, right.box.height);
  return gap <= Math.max(10, maxHeight * 0.62) && gap >= -maxHeight * 1.2;
}
function horizontalOverlapRatio(left, right) {
  const start = Math.max(left.box.x, right.box.x);
  const end = Math.min(left.box.x + left.box.width, right.box.x + right.box.width);
  const overlap = Math.max(0, end - start);
  return overlap / Math.max(1, Math.min(left.box.width, right.box.width));
}
function sameTextBlock(upper, lower) {
  if (lower.box.y < upper.box.y) return sameTextBlock(lower, upper);
  if (isUiMetadataText(upper.text) || isUiMetadataText(lower.text)) return false;
  const upperLine = Number(upper._lineHeight) || upper.box.height;
  const lowerLine = Number(lower._lineHeight) || lower.box.height;
  const lineHeight = Math.max(1, Math.min(upperLine, lowerLine));
  const gap = lower.box.y - (upper.box.y + upper.box.height);
  if (gap < -lineHeight * 0.35 || gap > Math.max(8, lineHeight * 0.72)) return false;
  const overlap = horizontalOverlapRatio(upper, lower);
  const leftAligned = Math.abs(upper.box.x - lower.box.x) <= lineHeight * 1.35;
  const rightAligned = Math.abs((upper.box.x + upper.box.width) - (lower.box.x + lower.box.width)) <= lineHeight * 1.35;
  return overlap >= 0.36 || leftAligned || rightAligned;
}
function mergeTextBlocks(regions) {
  const output = [];
  for (const region of regions) {
    let bestIndex = -1;
    let bestGap = Infinity;
    for (let index = 0; index < output.length; index += 1) {
      const existing = output[index];
      if (!sameTextBlock(existing, region)) continue;
      const gap = Math.abs(region.box.y - (existing.box.y + existing.box.height));
      if (gap < bestGap) {
        bestGap = gap;
        bestIndex = index;
      }
    }
    if (bestIndex < 0) output.push(region);
    else output[bestIndex] = mergeRegionPair(output[bestIndex], region, true);
  }
  return output;
}
function collapseOverlappingRegions(regions) {
  const output = [];
  for (const region of regions) {
    let merged = false;
    for (let index = 0; index < output.length; index += 1) {
      const existing = output[index];
      if (overlapRatioOfSmaller(existing, region) < 0.68) continue;
      output[index] = mergeRegionPair(existing, region);
      merged = true;
      break;
    }
    if (!merged) output.push(region);
  }
  return output;
}
export function mergeOcrRegions(regions) {
  const normalized = regions
    .filter((region) => region.text.trim().length > 0 && region.box.width > 0 && region.box.height > 0)
    .map((region) => ({ ...region, text: region.text.trim(), box: { ...region.box }, _lineHeight: Number(region._lineHeight) || region.box.height }));
  const deduped = collapseOverlappingRegions(normalized).sort((a, b) => {
    const vertical = a.box.y - b.box.y;
    if (Math.abs(vertical) > Math.max(a.box.height, b.box.height) * 0.4) return vertical;
    return a.box.x - b.box.x;
  });
  const merged = [];
  for (const region of deduped) {
    const previous = merged.at(-1);
    if (!previous || !sameVisualLine(previous, region)) {
      merged.push(region);
      continue;
    }
    merged[merged.length - 1] = mergeRegionPair(previous, region);
  }
  const lineMerged = collapseOverlappingRegions(merged).sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x);
  return mergeTextBlocks(lineMerged).sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x);
}
