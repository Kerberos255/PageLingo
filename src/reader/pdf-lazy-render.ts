export const PDF_LAZY_MARGIN_PX = 900;
export const PDF_LAZY_ROOT_MARGIN = `${PDF_LAZY_MARGIN_PX}px 0px`;
export const PDF_TEXT_LAZY_ROOT_MARGIN = "600px 0px";
export const MAX_RENDERED_PDF_CANVASES = 10;
export const MAX_PDF_CANVAS_BUDGET_BYTES = 96 * 1024 * 1024;
export const MAX_EAGER_FONT_OP_PROBES = 12;

export interface VerticalRect {
  top: number;
  bottom: number;
}

export interface LazyPdfPageState {
  pageNumber: number;
  baseRendered: boolean;
  isCanvasVisible: boolean;
  lastUsedSeq: number;
  needsSnapshotHydration: boolean;
  needsScanCheck: boolean;
  /** Total RGBA pixel bytes currently allocated for this page's base + overlay canvases. */
  canvasBytes: number;
}

export interface PdfEvictionOptions {
  maxRendered?: number;
  maxBytes?: number;
  /** Total RGBA pixel bytes held by right-pane cropped formula/figure/table snapshot canvases. */
  snapshotBytes?: number;
}

export function canvasPixelBytes(
  canvas: { width: number; height: number } | null | undefined,
): number {
  if (!canvas || canvas.width <= 0 || canvas.height <= 0) return 0;
  return canvas.width * canvas.height * 4;
}

export function isRectNearVerticalWindow(
  itemRect: VerticalRect,
  containerRect: VerticalRect,
  marginPx = PDF_LAZY_MARGIN_PX,
): boolean {
  if (containerRect.bottom <= containerRect.top) return false;
  return itemRect.bottom >= containerRect.top - marginPx
    && itemRect.top <= containerRect.bottom + marginPx;
}

export function pickNextLazyPdfPage<T extends LazyPdfPageState>(
  pending: Set<T>,
  urgent: Set<T>,
  viewportCenterY: number,
  getPageCenterY: (page: T) => number,
): T | null {
  for (const page of Array.from(pending)) {
    if (!urgent.has(page) && !page.isCanvasVisible && !page.needsSnapshotHydration && !page.needsScanCheck) {
      pending.delete(page);
    }
  }
  if (pending.size === 0) return null;

  for (const page of urgent) {
    if (pending.has(page)) return page;
  }

  let bestVisible: T | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const page of pending) {
    if (!page.isCanvasVisible) continue;
    const distance = Math.abs(getPageCenterY(page) - viewportCenterY);
    if (
      !bestVisible
      || distance < bestDistance
      || (distance === bestDistance && page.pageNumber < bestVisible.pageNumber)
    ) {
      bestVisible = page;
      bestDistance = distance;
    }
  }
  if (bestVisible) return bestVisible;

  let bestFallback: T | null = null;
  for (const page of pending) {
    if (!bestFallback || page.pageNumber < bestFallback.pageNumber) {
      bestFallback = page;
    }
  }
  return bestFallback;
}

export function selectPdfPagesToEvict<T extends LazyPdfPageState>(
  pages: readonly T[],
  anchorPageNumber: number,
  options: PdfEvictionOptions = {},
): T[] {
  const maxRendered = options.maxRendered ?? MAX_RENDERED_PDF_CANVASES;
  const maxBytes = options.maxBytes ?? MAX_PDF_CANVAS_BUDGET_BYTES;
  let renderedCount = 0;
  let totalBytes = Math.max(0, options.snapshotBytes ?? 0);
  for (const page of pages) {
    if (page.baseRendered) {
      renderedCount += 1;
      totalBytes += Math.max(0, page.canvasBytes);
    }
  }
  if (renderedCount <= maxRendered && totalBytes <= maxBytes) return [];

  const candidates = pages.filter(
    (page) => page.baseRendered && !page.isCanvasVisible && page.pageNumber !== anchorPageNumber,
  );
  candidates.sort((a, b) => {
    const distDiff = Math.abs(b.pageNumber - anchorPageNumber) - Math.abs(a.pageNumber - anchorPageNumber);
    if (distDiff !== 0) return distDiff;
    return a.lastUsedSeq - b.lastUsedSeq;
  });

  const victims: T[] = [];
  for (const candidate of candidates) {
    if (renderedCount <= maxRendered && totalBytes <= maxBytes) break;
    victims.push(candidate);
    renderedCount -= 1;
    totalBytes -= Math.max(0, candidate.canvasBytes);
  }
  return victims;
}
