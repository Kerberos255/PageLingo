export interface OcrBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface OcrRegion {
  text: string;
  confidence: number;
  box: OcrBox;
}

function unionBox(left: OcrBox, right: OcrBox): OcrBox {
  const x = Math.min(left.x, right.x);
  const y = Math.min(left.y, right.y);
  const maxX = Math.max(left.x + left.width, right.x + right.width);
  const maxY = Math.max(left.y + left.height, right.y + right.height);
  return { x, y, width: maxX - x, height: maxY - y };
}

function sameVisualLine(left: OcrRegion, right: OcrRegion): boolean {
  const leftCenter = left.box.y + left.box.height / 2;
  const rightCenter = right.box.y + right.box.height / 2;
  const verticalTolerance = Math.max(left.box.height, right.box.height) * 0.55;
  if (Math.abs(leftCenter - rightCenter) > verticalTolerance) return false;
  const gap = right.box.x - (left.box.x + left.box.width);
  return gap <= Math.max(24, Math.max(left.box.height, right.box.height) * 1.25);
}

export function mergeOcrRegions(regions: readonly OcrRegion[]): OcrRegion[] {
  const sorted = regions
    .filter((region) => region.text.trim().length > 0 && region.box.width > 0 && region.box.height > 0)
    .map((region) => ({ ...region, text: region.text.trim(), box: { ...region.box } }))
    .sort((a, b) => {
      const vertical = a.box.y - b.box.y;
      if (Math.abs(vertical) > Math.max(a.box.height, b.box.height) * 0.45) return vertical;
      return a.box.x - b.box.x;
    });

  const merged: OcrRegion[] = [];
  for (const region of sorted) {
    const previous = merged.at(-1);
    if (!previous || !sameVisualLine(previous, region)) {
      merged.push(region);
      continue;
    }
    const leftWeight = Math.max(previous.text.length, 1);
    const rightWeight = Math.max(region.text.length, 1);
    previous.text = `${previous.text} ${region.text}`.replace(/\s+/g, " ").trim();
    previous.confidence = (previous.confidence * leftWeight + region.confidence * rightWeight) / (leftWeight + rightWeight);
    previous.box = unionBox(previous.box, region.box);
  }
  return merged;
}
