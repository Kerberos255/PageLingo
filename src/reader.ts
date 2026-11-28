import * as pdfjsLib from "pdfjs-dist";
import { PageTranslator } from "./core/page-translator";
import { buildBilingualRulesCss } from "./core/bilingual-style";
import { parseTerminology, sourceFingerprint } from "./core/rich-segment";
import { renderTranslatedImageToCanvas } from "./image-translation/image-renderer";
import type { OcrRegion } from "./image-translation/ocr-layout";
import { RuntimeMessageProvider } from "./providers/runtime-message-provider";
import { sendRuntimeMessage } from "./shared/runtime-message";
import { detectForeignLanguageFromSample, extractForeignTextSample, fragmentAlreadyInTargetScript } from "./shared/mixed-language";
import {
  languageLabel,
  loadSettings,
  normalizeBilingualStyle,
  normalizeDetectedLanguage,
  type DisplayMode,
} from "./shared/settings";
import {
  parseDocxDocument,
  parseEpubDocument,
  parseHtmlFileDocument,
  parseMarkdownDocument,
  parsePlainTextDocument,
  type ParsedDocumentResult,
} from "./reader/document-parsers";
import {
  extractPdfPageBlocks,
  type PdfFontStyleInfo,
  type PdfInlineSegment,
  type PdfLayoutBlock,
  type PdfPageBox,
  type PdfRawTextItem,
} from "./reader/pdf-layout";
import { canvasHasVisualInk } from "./reader/pdf-ink";
import {
  MAX_EAGER_FONT_OP_PROBES,
  MAX_PDF_CANVAS_BUDGET_BYTES,
  MAX_RENDERED_PDF_CANVASES,
  PDF_LAZY_MARGIN_PX,
  PDF_LAZY_ROOT_MARGIN,
  PDF_TEXT_LAZY_ROOT_MARGIN,
  canvasPixelBytes,
  isRectNearVerticalWindow,
  pickNextLazyPdfPage,
  selectPdfPagesToEvict,
} from "./reader/pdf-lazy-render";

// Point pdf.js worker to the locally bundled worker inside the extension (zero remote code).
const workerSrc = typeof browser !== "undefined" && browser.runtime?.getURL
  ? browser.runtime.getURL("vendor/pdfjs/pdf.worker.mjs")
  : new URL("vendor/pdfjs/pdf.worker.mjs", location.href).href;
pdfjsLib.GlobalWorkerOptions.workerSrc = workerSrc;

const cMapUrl = typeof browser !== "undefined" && browser.runtime?.getURL
  ? browser.runtime.getURL("vendor/pdfjs/cmaps/")
  : new URL("vendor/pdfjs/cmaps/", location.href).href;

const standardFontDataUrl = typeof browser !== "undefined" && browser.runtime?.getURL
  ? browser.runtime.getURL("vendor/pdfjs/standard_fonts/")
  : new URL("vendor/pdfjs/standard_fonts/", location.href).href;

const MAX_PDF_OCR_SIDE = 1450;
const SIGNIFICANT_PDF_FONT_RE = /(?:cmmi|cmsy|cmex|msam|msbm|txmi|txsy|txex|pxmi|pxsy|pxex|math|symbol|stix|cambria|eufm|eurm|bold|bx\d|demi|black|heavy)/i;

const stageEl = document.querySelector<HTMLElement>("#reader-stage")!;
const emptyEl = document.querySelector<HTMLElement>("#reader-empty")!;
const dropzoneEl = document.querySelector<HTMLElement>("#reader-dropzone")!;
const fileInputEl = document.querySelector<HTMLInputElement>("#reader-file-input")!;
const openFileBtn = document.querySelector<HTMLButtonElement>("#reader-open-file")!;
const pickPrimaryBtn = document.querySelector<HTMLButtonElement>("#reader-pick-primary")!;
const urlFormEl = document.querySelector<HTMLFormElement>("#reader-url-form")!;
const urlInputEl = document.querySelector<HTMLInputElement>("#reader-url-input")!;
const docTitleEl = document.querySelector<HTMLElement>("#reader-doc-title")!;
const statusEl = document.querySelector<HTMLElement>("#reader-status")!;
const sourceSelect = document.querySelector<HTMLSelectElement>("#reader-source-lang")!;
const targetSelect = document.querySelector<HTMLSelectElement>("#reader-target-lang")!;
const modeButtons = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-reader-mode]"));
const pdfViewButtons = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-pdf-view]"));
const ocrAllBtn = document.querySelector<HTMLButtonElement>("#reader-ocr-all")!;
const translateBtn = document.querySelector<HTMLButtonElement>("#reader-translate")!;
const restoreBtn = document.querySelector<HTMLButtonElement>("#reader-restore")!;
const openSettingsBtn = document.querySelector<HTMLButtonElement>("#reader-open-settings")!;
const pdfToolsEl = document.querySelector<HTMLElement>("#reader-pdf-tools")!;
const zoomOutBtn = document.querySelector<HTMLButtonElement>("#reader-zoom-out")!;
const zoomInBtn = document.querySelector<HTMLButtonElement>("#reader-zoom-in")!;
const zoomLabelEl = document.querySelector<HTMLElement>("#reader-zoom-label")!;
const pdfWorkspaceEl = document.querySelector<HTMLElement>("#pdf-workspace")!;
const pdfCanvasPane = document.querySelector<HTMLElement>("#pdf-canvas-pane")!;
const pdfTextPane = document.querySelector<HTMLElement>("#pdf-text-pane")!;
const docWorkspaceEl = document.querySelector<HTMLElement>("#doc-workspace")!;
const docTocPane = document.querySelector<HTMLElement>("#doc-toc-pane")!;
const docTocList = document.querySelector<HTMLElement>("#doc-toc-list")!;
const docContentEl = document.querySelector<HTMLElement>("#doc-content")!;

type PdfViewMode = "split" | "overlay";

interface PdfPageRecord {
  pageNumber: number;
  pageWidth: number;
  pageHeight: number;
  renderScale: number;
  dpr: number;
  shell: HTMLElement;
  baseCanvas: HTMLCanvasElement;
  overlayCanvas: HTMLCanvasElement | null;
  hitLayer: HTMLElement;
  pageCard: HTMLElement;
  pageStatsEl: HTMLElement;
  ocrBtnEl: HTMLButtonElement;
  blocks: PdfLayoutBlock[];
  isScanned: boolean;
  ocrDone: boolean;
  baseRendered: boolean;
  renderedScale: number;
  renderedDpr: number;
  lastUsedSeq: number;
  isCanvasVisible: boolean;
  needsSnapshotHydration: boolean;
  needsScanCheck: boolean;
  unresolvedFontKeys: string[];
  fontRefined: boolean;
  canvasBytes: number;
  snapshotBytes: number;
}

let activeKind: "none" | "pdf" | "doc" = "none";
let activeDisplayMode: DisplayMode = "bilingual";
let activePdfViewMode: PdfViewMode = "split";
let activeTranslator: PageTranslator | null = null;
let isDocumentTranslated = false;
let activePdfLoadingTask: pdfjsLib.PDFDocumentLoadingTask | null = null;
let activePdfDoc: pdfjsLib.PDFDocumentProxy | null = null;
let activeRenderTask: pdfjsLib.RenderTask | null = null;
let activeOpenGeneration = 0;
let activeDocumentGeneration = 0;
let activePdfRenderGeneration = 0;
let activeTranslationGeneration = 0;
let activePdfScale = 1.0;
let activeBlockId = "";
let activePdfPages: PdfPageRecord[] = [];
let activeOcrRequestId = "";
let batchOcrRunning = false;
let batchOcrCancelRequested = false;
let overlaySourceCardEl: HTMLElement | null = null;
let pdfLoadingPages = false;
let pdfCanvasObserver: IntersectionObserver | null = null;
let pdfTextPaneObserver: IntersectionObserver | null = null;
const pdfPendingRenders = new Set<PdfPageRecord>();
const pdfUrgentRenders = new Set<PdfPageRecord>();
const pdfPageRenderWaiters = new Map<PdfPageRecord, Array<(ok: boolean) => void>>();
let pdfRenderLoopActive = false;
let pdfRenderSeq = 0;

interface LanguageOption { code: string; label: string }
interface CatalogResponse {
  ok?: boolean;
  catalog?: { sourceLanguages: LanguageOption[]; targetLanguages: LanguageOption[] };
}

interface RecognizePdfPageResponse {
  ok?: boolean;
  blocks?: PdfLayoutBlock[];
  visualCount?: number;
  ocrLineCount?: number;
  error?: string;
}

function setStatus(message: string): void {
  statusEl.textContent = message;
}

function ensureReaderBilingualStyle(styleSettings: unknown): void {
  let styleEl = document.getElementById("flt-style");
  if (!styleEl) {
    styleEl = document.createElement("style");
    styleEl.id = "flt-style";
    styleEl.dataset.fltGenerated = "style";
    document.head.append(styleEl);
  }
  const normalized = normalizeBilingualStyle(styleSettings);
  styleEl.textContent = [
    ".flt-translation { display: block !important; margin-block-start: 0.3em !important; font: inherit !important; line-height: inherit !important; }",
    ".flt-translation a { display: inline !important; }",
    ".flt-source-hidden { display: none !important; }",
    ".flt-source-content-hidden { font-size: 0 !important; line-height: 0 !important; }",
    ".flt-source-content-hidden > :not(.flt-translation) { display: none !important; }",
    ".flt-source-content-hidden > .flt-translation { margin-block-start: 0 !important; font-size: var(--pagelingo-source-font-size) !important; line-height: var(--pagelingo-source-line-height) !important; }",
    ".flt-source-list-hidden > :not(.flt-translation) { display: none !important; }",
    ".flt-source-list-hidden > .flt-translation { display: inline !important; margin: 0 !important; padding: 0 !important; font-size: var(--pagelingo-source-font-size) !important; line-height: var(--pagelingo-source-line-height) !important; vertical-align: baseline !important; }",
    buildBilingualRulesCss(normalized, ":root"),
  ].join("\n");
}

function syncModeButtons(): void {
  for (const btn of modeButtons) {
    const active = btn.dataset.readerMode === activeDisplayMode;
    btn.classList.toggle("active", active);
    btn.setAttribute("aria-pressed", String(active));
  }
}

function syncPdfViewButtons(): void {
  for (const btn of pdfViewButtons) {
    const active = btn.dataset.pdfView === activePdfViewMode;
    btn.classList.toggle("active", active);
    btn.setAttribute("aria-pressed", String(active));
  }
  pdfWorkspaceEl.classList.toggle("is-overlay-mode", activePdfViewMode === "overlay");
  if (activePdfViewMode !== "overlay") hideOverlaySourceCard();
}

function hideOverlaySourceCard(): void {
  overlaySourceCardEl?.remove();
  overlaySourceCardEl = null;
}

function showOverlaySourceCard(block: PdfLayoutBlock): void {
  hideOverlaySourceCard();
  if (activePdfViewMode !== "overlay") return;
  const card = document.createElement("aside");
  card.className = "pdf-overlay-source-card";
  const head = document.createElement("div");
  head.className = "pdf-overlay-source-head";
  const label = document.createElement("span");
  label.textContent = `第 ${block.pageNumber} 页 · 原文对照`;
  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "pdf-overlay-source-close";
  closeBtn.textContent = "×";
  closeBtn.setAttribute("aria-label", "关闭原文预览");
  closeBtn.addEventListener("click", () => hideOverlaySourceCard());
  head.append(label, closeBtn);

  const body = document.createElement("div");
  body.textContent = block.plainText;
  card.append(head, body);
  document.body.append(card);
  overlaySourceCardEl = card;
}

function highlightSyncedBlock(blockId: string, scrollTarget: "canvas" | "text" | "none"): void {
  if (activeBlockId) {
    for (const el of Array.from(document.querySelectorAll(`[data-block-id="${CSS.escape(activeBlockId)}"]`))) {
      el.classList.remove("is-active");
    }
  }
  activeBlockId = blockId;
  if (!blockId) return;
  const escaped = CSS.escape(blockId);
  const hitBox = pdfCanvasPane.querySelector<HTMLElement>(`.pdf-hit-box[data-block-id="${escaped}"]`);
  const textCard = pdfTextPane.querySelector<HTMLElement>(`.pdf-block-wrap[data-block-id="${escaped}"]`);
  hitBox?.classList.add("is-active");
  textCard?.classList.add("is-active");
  if (activePdfViewMode === "overlay") {
    const matched = activePdfPages.flatMap((p) => p.blocks).find((b) => b.id === blockId);
    if (matched && !isVisualSnapshotBlock(matched)) {
      showOverlaySourceCard(matched);
    } else {
      hideOverlaySourceCard();
    }
    return;
  }
  if (scrollTarget === "canvas" && hitBox) {
    const owner = activePdfPages.find((p) => p.blocks.some((b) => b.id === blockId));
    if (owner) void ensurePdfPageRendered(owner, true);
    hitBox.scrollIntoView({ behavior: "smooth", block: "center" });
  } else if (scrollTarget === "text" && textCard) {
    textCard.scrollIntoView({ behavior: "smooth", block: "center" });
  }
}

/**
 * Crops a high-DPI visual snapshot of a display formula, dense table, or figure directly
 * from the rendered PDF page canvas, clamped to neighbor non-visual bounds so adjacent prose
 * never bleeds into the cropped image.
 */
function cropRegionSnapshot(
  sourceCanvas: HTMLCanvasElement,
  box: PdfPageBox,
  renderScale: number,
  dpr: number,
  clipBounds: { minY?: number; maxY?: number } | undefined,
  kind: "formula" | "table" | "figure",
): HTMLCanvasElement | null {
  const scale = renderScale * dpr;
  const padX = kind === "table" ? 10 : kind === "figure" ? 6 : 8;
  const padTop = kind === "table" ? 6 : kind === "figure" ? 5 : 3;
  const padBottom = kind === "table" ? 6 : kind === "figure" ? 5 : 4;
  const topPageY = Math.max(clipBounds?.minY ?? 0, box.y - padTop);
  const bottomPageY = clipBounds?.maxY !== undefined
    ? Math.min(clipBounds.maxY, box.y + box.height + padBottom)
    : box.y + box.height + padBottom;
  const sx = Math.max(0, Math.floor((box.x - padX) * scale));
  const sy = Math.max(0, Math.floor(topPageY * scale));
  const sw = Math.min(sourceCanvas.width - sx, Math.ceil((box.width + padX * 2) * scale));
  const sh = Math.min(sourceCanvas.height - sy, Math.ceil(Math.max(4, bottomPageY - topPageY) * scale));
  if (sw < 8 || sh < 6) return null;

  const crop = document.createElement("canvas");
  crop.width = sw;
  crop.height = sh;
  const cssW = Math.round(sw / dpr);
  const cssH = Math.round(sh / dpr);
  crop.style.width = `${cssW}px`;
  crop.style.height = `${cssH}px`;
  crop.className = kind === "figure" ? "reader-formula-canvas" : "reader-formula-canvas is-invertible";
  const ctx = crop.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(sourceCanvas, sx, sy, sw, sh, 0, 0, sw, sh);
  return crop;
}

function appendInlineSegments(target: HTMLElement, segments: readonly PdfInlineSegment[]): void {
  for (const seg of segments) {
    if (seg.kind === "math") {
      const mathCode = document.createElement("code");
      mathCode.className = "reader-inline-math";
      mathCode.setAttribute("translate", "no");
      mathCode.setAttribute("data-flt-fixed", "formula");
      if (seg.parts && seg.parts.some((p) => p.script)) {
        for (const part of seg.parts) {
          if (part.script === "sup") {
            const sup = document.createElement("sup");
            sup.textContent = part.text;
            mathCode.append(sup);
          } else if (part.script === "sub") {
            const sub = document.createElement("sub");
            sub.textContent = part.text;
            mathCode.append(sub);
          } else {
            mathCode.append(document.createTextNode(part.text));
          }
        }
      } else {
        mathCode.textContent = seg.text;
      }
      target.append(mathCode);
    } else {
      target.append(document.createTextNode(seg.text));
    }
  }
}

function renderPdfBlockElement(
  block: PdfLayoutBlock,
  pageCanvas?: HTMLCanvasElement,
  renderScale = 1,
  dpr = 1,
  clipBounds?: { minY?: number; maxY?: number },
): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "pdf-block-wrap";
  wrap.dataset.blockId = block.id;
  wrap.dataset.blockKind = block.kind;
  wrap.addEventListener("click", () => highlightSyncedBlock(block.id, "canvas"));

  const readyCanvas = pageCanvas && pageCanvas.width > 0 && pageCanvas.height > 0 ? pageCanvas : undefined;

  if (block.kind === "formula") {
    const formula = document.createElement("div");
    formula.className = "reader-formula";
    formula.setAttribute("translate", "no");
    formula.title = block.plainText;
    formula.setAttribute("aria-label", block.plainText);
    const snapshot = readyCanvas
      ? cropRegionSnapshot(readyCanvas, block.box, renderScale, dpr, clipBounds, "formula")
      : null;
    if (snapshot) {
      formula.classList.add("is-snapshot");
      formula.append(snapshot);
    } else {
      if (!readyCanvas) formula.classList.add("is-snapshot-pending");
      formula.textContent = block.plainText;
    }
    wrap.append(formula);
    return wrap;
  }

  if (block.kind === "figure") {
    const fig = document.createElement("div");
    fig.className = "reader-figure-snapshot";
    fig.setAttribute("translate", "no");
    const tag = document.createElement("span");
    tag.className = "reader-snapshot-tag";
    tag.textContent = "原页图表";
    const snapshot = readyCanvas
      ? cropRegionSnapshot(readyCanvas, block.box, renderScale, dpr, clipBounds, "figure")
      : null;
    if (snapshot) {
      fig.append(tag, snapshot);
    } else {
      if (!readyCanvas) fig.classList.add("is-snapshot-pending");
      fig.append(tag, document.createTextNode(block.plainText));
    }
    wrap.append(fig);
    return wrap;
  }

  if (block.kind === "table") {
    if (block.tableMode === "html" && block.tableRows && block.tableRows.length > 0) {
      const tableWrap = document.createElement("div");
      tableWrap.className = "pdf-html-table-wrap";
      const table = document.createElement("table");
      table.className = "pdf-html-table";
      const hasHeader = Boolean(block.tableHasHeader && block.tableRows.length >= 2);
      if (hasHeader) {
        const thead = document.createElement("thead");
        const tr = document.createElement("tr");
        const row = block.tableRows[0]!;
        for (let ci = 0; ci < row.length; ci += 1) {
          const th = document.createElement("th");
          th.dataset.tableRow = "0";
          th.dataset.tableCol = String(ci);
          if (row[ci]!.length > 0) {
            const p = document.createElement("p");
            p.className = "pdf-table-cell";
            appendInlineSegments(p, row[ci]!);
            th.append(p);
          }
          tr.append(th);
        }
        thead.append(tr);
        table.append(thead);
      }
      const tbody = document.createElement("tbody");
      for (let ri = hasHeader ? 1 : 0; ri < block.tableRows.length; ri += 1) {
        const tr = document.createElement("tr");
        const row = block.tableRows[ri]!;
        for (let ci = 0; ci < row.length; ci += 1) {
          const td = document.createElement("td");
          td.dataset.tableRow = String(ri);
          td.dataset.tableCol = String(ci);
          if (row[ci]!.length > 0) {
            const p = document.createElement("p");
            p.className = "pdf-table-cell";
            appendInlineSegments(p, row[ci]!);
            td.append(p);
          }
          tr.append(td);
        }
        tbody.append(tr);
      }
      table.append(tbody);
      tableWrap.append(table);
      wrap.append(tableWrap);
      return wrap;
    }

    const tableCard = document.createElement("div");
    tableCard.className = "reader-table-snapshot";
    tableCard.setAttribute("translate", "no");
    tableCard.title = block.plainText;
    const tag = document.createElement("span");
    tag.className = "reader-snapshot-tag";
    tag.textContent = "原页数值/结构表格（保真保留）";
    const snapshot = readyCanvas
      ? cropRegionSnapshot(readyCanvas, block.box, renderScale, dpr, clipBounds, "table")
      : null;
    if (snapshot) {
      tableCard.append(tag, snapshot);
    } else {
      if (!readyCanvas) tableCard.classList.add("is-snapshot-pending");
      tableCard.append(tag, document.createTextNode(block.plainText));
    }
    wrap.append(tableCard);
    return wrap;
  }

  let el: HTMLElement;
  if (block.kind === "heading") {
    const lvl = Math.min(3, Math.max(1, block.headingLevel ?? 2));
    el = document.createElement(`h${lvl}`);
  } else if (block.kind === "list-item") {
    el = document.createElement("p");
    el.className = "pdf-list-item";
  } else {
    el = document.createElement("p");
  }

  appendInlineSegments(el, block.segments);
  wrap.append(el);
  return wrap;
}

function isVisualSnapshotBlock(block: PdfLayoutBlock): boolean {
  return block.kind === "formula"
    || block.kind === "figure"
    || (block.kind === "table" && block.tableMode !== "html");
}

function computeClipBoundsForBlock(
  blocks: readonly PdfLayoutBlock[],
  index: number,
): { minY?: number; maxY?: number } | undefined {
  const block = blocks[index]!;
  if (!isVisualSnapshotBlock(block)) return undefined;
  let minY: number | undefined;
  let maxY: number | undefined;
  for (let pi = index - 1; pi >= 0; pi -= 1) {
    const prev = blocks[pi]!;
    if (isVisualSnapshotBlock(prev)) continue;
    if (prev.column !== block.column && prev.column !== "full" && block.column !== "full") continue;
    const prevBottom = prev.box.y + prev.box.height + Math.max(1.5, prev.fontSize * 0.22);
    if (prevBottom <= block.box.y + block.box.height - 4) {
      minY = prevBottom;
      break;
    }
  }
  for (let ni = index + 1; ni < blocks.length; ni += 1) {
    const next = blocks[ni]!;
    if (isVisualSnapshotBlock(next)) continue;
    if (next.column !== block.column && next.column !== "full" && block.column !== "full") continue;
    const nextTop = next.box.y - 1.5;
    if (nextTop >= block.box.y + 4) {
      maxY = nextTop;
      break;
    }
  }
  return { ...(minY !== undefined ? { minY } : {}), ...(maxY !== undefined ? { maxY } : {}) };
}

function updateBatchOcrButton(): void {
  const scannedCount = activePdfPages.filter((p) => p.isScanned && !p.ocrDone).length;
  if (batchOcrRunning) {
    ocrAllBtn.hidden = false;
    ocrAllBtn.disabled = false;
    ocrAllBtn.textContent = "停止识别";
    return;
  }
  if (scannedCount > 0) {
    ocrAllBtn.hidden = false;
    ocrAllBtn.disabled = false;
    ocrAllBtn.textContent = `识别扫描页 (${scannedCount} 页)`;
  } else {
    ocrAllBtn.hidden = true;
  }
}

function hydratePdfPageSnapshots(record: PdfPageRecord): void {
  if (!record.needsSnapshotHydration || !record.baseRendered || record.baseCanvas.width <= 0 || record.baseCanvas.height <= 0) {
    return;
  }
  for (let bi = 0; bi < record.blocks.length; bi += 1) {
    const block = record.blocks[bi]!;
    if (!isVisualSnapshotBlock(block)) continue;
    const wrap = record.pageCard.querySelector<HTMLElement>(`.pdf-block-wrap[data-block-id="${CSS.escape(block.id)}"]`);
    if (!wrap) continue;
    const clipBounds = computeClipBoundsForBlock(record.blocks, bi);
    if (block.kind === "formula") {
      const formula = wrap.querySelector<HTMLElement>(".reader-formula");
      if (!formula) continue;
      const snapshot = cropRegionSnapshot(record.baseCanvas, block.box, record.renderScale, record.dpr, clipBounds, "formula");
      if (snapshot) {
        formula.replaceChildren(snapshot);
        formula.classList.add("is-snapshot");
        formula.classList.remove("is-snapshot-pending");
      }
    } else if (block.kind === "figure") {
      const fig = wrap.querySelector<HTMLElement>(".reader-figure-snapshot");
      if (!fig) continue;
      const snapshot = cropRegionSnapshot(record.baseCanvas, block.box, record.renderScale, record.dpr, clipBounds, "figure");
      if (snapshot) {
        const tag = document.createElement("span");
        tag.className = "reader-snapshot-tag";
        tag.textContent = "原页图表";
        fig.replaceChildren(tag, snapshot);
        fig.classList.remove("is-snapshot-pending");
      }
    } else if (block.kind === "table") {
      const tableCard = wrap.querySelector<HTMLElement>(".reader-table-snapshot");
      if (!tableCard) continue;
      const snapshot = cropRegionSnapshot(record.baseCanvas, block.box, record.renderScale, record.dpr, clipBounds, "table");
      if (snapshot) {
        const tag = document.createElement("span");
        tag.className = "reader-snapshot-tag";
        tag.textContent = "原页数值/结构表格（保真保留）";
        tableCard.replaceChildren(tag, snapshot);
        tableCard.classList.remove("is-snapshot-pending");
      }
    }
  }
  record.needsSnapshotHydration = false;
  record.snapshotBytes = measurePageCardSnapshotBytes(record.pageCard);
  if (!record.needsScanCheck) pdfTextPaneObserver?.unobserve(record.pageCard);
}

function finalizePdfPageScanCheck(record: PdfPageRecord): void {
  if (!record.needsScanCheck || record.ocrDone || !record.baseRendered || record.baseCanvas.width <= 0 || record.baseCanvas.height <= 0) {
    return;
  }
  record.needsScanCheck = false;
  const hasInk = canvasHasVisualInk(record.baseCanvas);
  record.isScanned = hasInk;
  const note = record.pageCard.querySelector<HTMLElement>(".pdf-scanned-card p");
  if (note) {
    note.textContent = hasInk
      ? "本页未检出可用文字层（疑似扫描图像页）。可启用本地版面与文字识别提取正文，并自动保留原页公式、表格与图表。"
      : "本页未检出文字内容。";
  }
  if (!record.needsSnapshotHydration) pdfTextPaneObserver?.unobserve(record.pageCard);
  updateBatchOcrButton();
}

function populatePdfPageBlocks(record: PdfPageRecord, blocks: PdfLayoutBlock[]): void {
  record.blocks = blocks;
  record.hitLayer.replaceChildren();
  // Remove all children inside pageCard except its header
  while (record.pageCard.children.length > 1) {
    record.pageCard.lastElementChild?.remove();
  }
  // Clear stale overlay pixels until re-rendered
  clearPdfOverlayForPage(record);

  const canvasReady = record.baseRendered && record.baseCanvas.width > 0 && record.baseCanvas.height > 0;
  const totalTextChars = blocks
    .filter((b) => !isVisualSnapshotBlock(b))
    .reduce((sum, b) => sum + b.plainText.replace(/\s+/g, "").length, 0);
  const candidateScanned = !record.ocrDone && totalTextChars < 16;
  const looksScanned = candidateScanned && (canvasReady ? canvasHasVisualInk(record.baseCanvas) : true);
  record.isScanned = looksScanned;
  record.needsScanCheck = candidateScanned && !canvasReady;
  record.needsSnapshotHydration = !canvasReady && blocks.some(isVisualSnapshotBlock);

  const pageFormulas = blocks.filter((b) => b.kind === "formula" || b.segments.some((s) => s.kind === "math")).length;
  const pageTables = blocks.filter((b) => b.kind === "table").length;
  const pageFigures = blocks.filter((b) => b.kind === "figure").length;
  const statParts = [`${blocks.length} 段`];
  if (pageFormulas > 0) statParts.push(`公式 ${pageFormulas}`);
  if (pageTables > 0) statParts.push(`表格 ${pageTables}`);
  if (pageFigures > 0) statParts.push(`图表 ${pageFigures}`);
  if (record.ocrDone) statParts.push("OCR");
  record.pageStatsEl.textContent = statParts.join(" · ");
  record.ocrBtnEl.textContent = record.ocrDone ? "重新 OCR" : "版面 OCR";

  for (let bi = 0; bi < blocks.length; bi += 1) {
    const block = blocks[bi]!;
    const hit = document.createElement("div");
    hit.className = "pdf-hit-box";
    hit.dataset.blockId = block.id;
    hit.dataset.blockKind = block.kind;
    hit.style.left = `${Math.max(0, block.box.x * record.renderScale - 2)}px`;
    hit.style.top = `${Math.max(0, block.box.y * record.renderScale - 2)}px`;
    hit.style.width = `${Math.max(8, block.box.width * record.renderScale + 4)}px`;
    hit.style.height = `${Math.max(8, block.box.height * record.renderScale + 4)}px`;
    hit.addEventListener("click", () => highlightSyncedBlock(block.id, "text"));
    record.hitLayer.append(hit);

    const clipBounds = computeClipBoundsForBlock(blocks, bi);
    record.pageCard.append(
      renderPdfBlockElement(block, canvasReady ? record.baseCanvas : undefined, record.renderScale, record.dpr, clipBounds),
    );
  }

  if (looksScanned || blocks.length === 0) {
    const card = document.createElement("div");
    card.className = "pdf-scanned-card";
    const note = document.createElement("p");
    note.textContent = looksScanned
      ? "本页未检出可用文字层（疑似扫描图像页）。可启用本地版面与文字识别提取正文，并自动保留原页公式、表格与图表。"
      : "本页未检出文字内容。";
    const actionBtn = document.createElement("button");
    actionBtn.type = "button";
    actionBtn.className = "primary-btn";
    actionBtn.textContent = "OCR 识别本页（保留公式与图表）";
    actionBtn.addEventListener("click", () => {
      void runOcrForPage(record, actionBtn);
    });
    card.append(note, actionBtn);
    record.pageCard.append(card);
  }

  record.snapshotBytes = measurePageCardSnapshotBytes(record.pageCard);

  if (pdfTextPaneObserver) {
    if (record.needsSnapshotHydration || record.needsScanCheck) {
      pdfTextPaneObserver.observe(record.pageCard);
    } else {
      pdfTextPaneObserver.unobserve(record.pageCard);
    }
  }

  updateBatchOcrButton();
}

function measurePageCardSnapshotBytes(pageCard: HTMLElement): number {
  let bytes = 0;
  for (const canvas of Array.from(pageCard.querySelectorAll<HTMLCanvasElement>("canvas.reader-formula-canvas"))) {
    bytes += canvasPixelBytes(canvas);
  }
  return bytes;
}

function updateRecordCanvasBytes(record: PdfPageRecord): void {
  record.canvasBytes = canvasPixelBytes(record.baseCanvas) + canvasPixelBytes(record.overlayCanvas);
}

function totalPdfSnapshotBytes(): number {
  let bytes = 0;
  for (const page of activePdfPages) bytes += page.snapshotBytes;
  return bytes;
}

function extractTranslatedText(container: HTMLElement, sourcePlainText: string): string | null {
  const translationNodes = Array.from(container.querySelectorAll<HTMLElement>(".flt-translation"));
  if (translationNodes.length > 0) {
    const text = translationNodes
      .map((n) => (n.textContent ?? "").replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .join(" ");
    return text || null;
  }
  // In "translation" mode with fixed-text-render (inline math), text nodes were replaced in place.
  const clone = container.cloneNode(true) as HTMLElement;
  for (const hidden of Array.from(clone.querySelectorAll(".flt-source-hidden"))) {
    hidden.remove();
  }
  const text = (clone.textContent ?? "").replace(/\s+/g, " ").trim();
  if (!text) return null;
  const normSource = sourcePlainText.replace(/\s+/g, " ").trim();
  if (text === normSource) return null;
  return text;
}

function releaseCanvasBacking(canvas: HTMLCanvasElement | null | undefined): void {
  if (!canvas) return;
  canvas.width = 0;
  canvas.height = 0;
}

function ensureOverlayCanvas(record: PdfPageRecord): HTMLCanvasElement {
  let canvas = record.overlayCanvas;
  if (!canvas) {
    canvas = document.createElement("canvas");
    canvas.className = "pdf-overlay-canvas";
    record.baseCanvas.after(canvas);
    record.overlayCanvas = canvas;
  }
  if (canvas.width !== record.baseCanvas.width) canvas.width = record.baseCanvas.width;
  if (canvas.height !== record.baseCanvas.height) canvas.height = record.baseCanvas.height;
  updateRecordCanvasBytes(record);
  return canvas;
}

function clearPdfOverlayForPage(record: PdfPageRecord): void {
  const canvas = record.overlayCanvas;
  if (!canvas) return;
  canvas.classList.remove("has-overlay");
  releaseCanvasBacking(canvas);
  canvas.remove();
  record.overlayCanvas = null;
  updateRecordCanvasBytes(record);
}

function clearAllPdfOverlays(): void {
  for (const record of activePdfPages) {
    clearPdfOverlayForPage(record);
  }
}

function renderPdfOverlayForPage(record: PdfPageRecord): void {
  if (!isDocumentTranslated || activePdfViewMode !== "overlay") {
    clearPdfOverlayForPage(record);
    return;
  }

  const baseCtx = record.baseCanvas.getContext("2d", { willReadFrequently: true });
  if (!baseCtx || record.baseCanvas.width <= 0 || record.baseCanvas.height <= 0) return;

  const scale = record.renderScale * record.dpr;
  const regions: OcrRegion[] = [];

  for (const block of record.blocks) {
    // Keep display formulas, figures, and dense/numeric snapshot tables 100% untouched on original PDF pixels!
    if (isVisualSnapshotBlock(block)) continue;

    const wrap = record.pageCard.querySelector<HTMLElement>(`.pdf-block-wrap[data-block-id="${CSS.escape(block.id)}"]`);
    if (!wrap) continue;

    if (block.kind === "table" && block.tableMode === "html" && block.tableCellBoxes) {
      for (const cellMeta of block.tableCellBoxes) {
        const cellEl = wrap.querySelector<HTMLElement>(
          `[data-table-row="${cellMeta.rowIndex}"][data-table-col="${cellMeta.colIndex}"]`,
        );
        if (!cellEl) continue;
        const sourceText = block.tableRows?.[cellMeta.rowIndex]?.[cellMeta.colIndex]
          ?.map((s) => s.text)
          .join("") ?? "";
        const translated = extractTranslatedText(cellEl, sourceText);
        if (!translated) continue;
        const box = {
          x: cellMeta.box.x * scale,
          y: cellMeta.box.y * scale,
          width: Math.max(8, cellMeta.box.width * scale),
          height: Math.max(8, cellMeta.box.height * scale),
        };
        const lineHeight = Math.max(10, cellMeta.fontSize * scale * 1.22);
        regions.push({
          text: translated,
          confidence: 1,
          box,
          lineBoxes: [box],
          lineHeight,
        });
      }
      continue;
    }

    const translated = extractTranslatedText(wrap, block.plainText);
    if (!translated) continue;

    const box = {
      x: block.box.x * scale,
      y: block.box.y * scale,
      width: Math.max(8, block.box.width * scale),
      height: Math.max(8, block.box.height * scale),
    };
    const lineBoxes = block.lineBoxes && block.lineBoxes.length > 0
      ? block.lineBoxes.map((lb) => ({
          x: lb.x * scale,
          y: lb.y * scale,
          width: Math.max(8, lb.width * scale),
          height: Math.max(8, lb.height * scale),
        }))
      : [box];
    const lineHeight = Math.max(10, block.fontSize * scale * 1.25);

    regions.push({
      text: translated,
      confidence: 1,
      box,
      lineBoxes,
      lineHeight,
    });
  }

  if (regions.length === 0) {
    clearPdfOverlayForPage(record);
    return;
  }

  try {
    const overlayCanvas = ensureOverlayCanvas(record);
    const imgData = baseCtx.getImageData(0, 0, record.baseCanvas.width, record.baseCanvas.height);
    const rendered = renderTranslatedImageToCanvas(overlayCanvas, {
      regions,
      ocrWidth: record.baseCanvas.width,
      ocrHeight: record.baseCanvas.height,
      pixels: imgData.data.buffer,
      displayWidth: record.baseCanvas.width,
      displayHeight: record.baseCanvas.height,
      devicePixelRatio: 1,
      paintBaseImage: false,
    });
    if (!rendered) {
      clearPdfOverlayForPage(record);
      return;
    }
    overlayCanvas.classList.add("has-overlay");
    updateRecordCanvasBytes(record);
  } catch (error) {
    console.warn("[PageLingo] Failed to render PDF in-place overlay", error);
    clearPdfOverlayForPage(record);
  }
}

function renderAllPdfOverlays(): void {
  if (activeKind !== "pdf") return;
  if (!isDocumentTranslated || activePdfViewMode !== "overlay") {
    clearAllPdfOverlays();
    return;
  }
  let anchor: PdfPageRecord | null = null;
  for (const record of activePdfPages) {
    if (record.isCanvasVisible && record.baseRendered) {
      anchor ??= record;
      renderPdfOverlayForPage(record);
    } else {
      clearPdfOverlayForPage(record);
    }
  }
  if (anchor) evictFarPdfCanvases(anchor);
}

function captureCanvasForOcr(baseCanvas: HTMLCanvasElement): { width: number; height: number; pixels: ArrayBuffer } {
  const maxSide = Math.max(baseCanvas.width, baseCanvas.height);
  const scale = maxSide > MAX_PDF_OCR_SIDE ? MAX_PDF_OCR_SIDE / maxSide : 1;
  const width = Math.max(1, Math.round(baseCanvas.width * scale));
  const height = Math.max(1, Math.round(baseCanvas.height * scale));
  const tmp = document.createElement("canvas");
  tmp.width = width;
  tmp.height = height;
  const ctx = tmp.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("无法创建 OCR 采样画布");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(baseCanvas, 0, 0, width, height);
  const imgData = ctx.getImageData(0, 0, width, height);
  return { width, height, pixels: imgData.data.buffer };
}

async function createConfiguredTranslator(scope: HTMLElement): Promise<{
  translator: PageTranslator;
  sourceLanguage: string;
  targetLanguage: string;
}> {
  const settings = await loadSettings();
  ensureReaderBilingualStyle(settings.bilingualStyle);
  const targetLanguage = normalizeDetectedLanguage(targetSelect.value) ?? settings.targetLanguage ?? "zh-Hans";
  let sourceLanguage = sourceSelect.value;
  if (sourceLanguage === "auto") {
    const foreignSample = extractForeignTextSample(scope, targetLanguage, 4096);
    sourceLanguage = (await detectForeignLanguageFromSample(foreignSample, targetLanguage)) ?? "en";
  }
  if (sourceLanguage === targetLanguage) {
    throw new Error("文档已是目标语言，请切换译文语言后重试");
  }
  const provider = new RuntimeMessageProvider();
  const terminology = parseTerminology(
    settings.glossaryCollections,
    sourceLanguage,
    targetLanguage,
    settings.builtinGlossaryEnabled,
  );
  const translator = new PageTranslator(document, provider, {
    sourceLanguage,
    targetLanguage,
    displayMode: activeDisplayMode,
    bilingualStyle: settings.bilingualStyle,
    showProgress: true,
    terminology,
    shouldTranslateRoot: (root: HTMLElement) => {
      if (root.closest(".reader-formula, .reader-table-snapshot, .reader-figure-snapshot, pre, .pdf-text-page-head, .pdf-scanned-card")) {
        return false;
      }
      const text = sourceFingerprint(root, { excludeNestedRoots: true }).replace(/\s+/g, " ").trim();
      if (!text || fragmentAlreadyInTargetScript(text, targetLanguage)) return false;
      return true;
    },
  });
  return { translator, sourceLanguage, targetLanguage };
}

async function runOcrForPage(record: PdfPageRecord, triggerBtn?: HTMLButtonElement): Promise<boolean> {
  const docGen = activeDocumentGeneration;
  const requestId = `pdf-ocr-p${record.pageNumber}-${Date.now()}`;
  activeOcrRequestId = requestId;
  record.ocrBtnEl.disabled = true;
  if (triggerBtn) {
    triggerBtn.disabled = true;
    triggerBtn.textContent = "正在识别版面与文字…";
  }
  setStatus(`第 ${record.pageNumber} 页：准备本地版面与文字识别…`);
  try {
    const rendered = await ensurePdfPageRendered(record, true);
    if (docGen !== activeDocumentGeneration) return false;
    if (!rendered || record.baseCanvas.width <= 0 || record.baseCanvas.height <= 0) {
      throw new Error("无法渲染当前 PDF 页面用于 OCR");
    }
    const sample = captureCanvasForOcr(record.baseCanvas);
    const response = await sendRuntimeMessage<RecognizePdfPageResponse>({
      type: "recognize-pdf-page",
      width: sample.width,
      height: sample.height,
      pageWidth: record.pageWidth,
      pageHeight: record.pageHeight,
      pageNumber: record.pageNumber,
      pixels: sample.pixels,
      requestId,
    });
    if (docGen !== activeDocumentGeneration) return false;
    if (!response?.ok || !Array.isArray(response.blocks)) {
      throw new Error(response?.error ?? "扫描页 OCR 识别失败");
    }
    record.ocrDone = true;
    record.isScanned = false;
    record.needsScanCheck = false;
    populatePdfPageBlocks(record, response.blocks);

    const visualCount = response.visualCount ?? 0;
    const textBlocks = response.blocks.filter((b) => !isVisualSnapshotBlock(b)).length;
    setStatus(
      `第 ${record.pageNumber} 页 OCR 完成：提取 ${textBlocks} 段正文${visualCount > 0 ? `，自动保护 ${visualCount} 处公式/表格/图表` : ""}`,
    );

    if (isDocumentTranslated && textBlocks > 0) {
      setStatus(`第 ${record.pageNumber} 页 OCR 完成，正在自动翻译新识别正文…`);
      if (activeTranslator) {
        await activeTranslator.translateAll(record.pageCard, true);
      } else {
        const { translator } = await createConfiguredTranslator(record.pageCard);
        if (docGen !== activeDocumentGeneration) {
          translator.restore();
          return false;
        }
        activeTranslator = translator;
        await translator.translateAll(record.pageCard, true);
      }
      if (docGen !== activeDocumentGeneration) return false;
      renderPdfOverlayForPage(record);
      setStatus(`第 ${record.pageNumber} 页已识别并翻译完成`);
    }
    return true;
  } catch (error) {
    if (docGen !== activeDocumentGeneration) return false;
    setStatus(`第 ${record.pageNumber} 页 OCR 失败：${error instanceof Error ? error.message : String(error)}`);
    if (triggerBtn) {
      triggerBtn.disabled = false;
      triggerBtn.textContent = "OCR 识别本页（保留公式与图表）";
    }
    return false;
  } finally {
    if (activeOcrRequestId === requestId) activeOcrRequestId = "";
    if (docGen === activeDocumentGeneration) {
      record.ocrBtnEl.disabled = false;
      updateBatchOcrButton();
    }
  }
}

async function runOcrForAllScannedPages(): Promise<void> {
  if (batchOcrRunning) {
    batchOcrCancelRequested = true;
    setStatus("正在停止批量扫描页 OCR…");
    return;
  }
  const docGen = activeDocumentGeneration;
  const targets = activePdfPages.filter((p) => p.isScanned && !p.ocrDone);
  if (targets.length === 0) return;
  batchOcrRunning = true;
  batchOcrCancelRequested = false;
  updateBatchOcrButton();

  let succeeded = 0;
  let processed = 0;
  for (let i = 0; i < targets.length; i += 1) {
    if (batchOcrCancelRequested || docGen !== activeDocumentGeneration) break;
    const record = targets[i]!;
    if (record.needsScanCheck) {
      setStatus(`批量 OCR（${i + 1}/${targets.length}）：正在检查第 ${record.pageNumber} 页图像内容…`);
      const ready = await ensurePdfPageRendered(record, true);
      if (batchOcrCancelRequested || docGen !== activeDocumentGeneration) break;
      if (!ready || !record.isScanned || record.ocrDone) continue;
    }
    processed += 1;
    setStatus(`批量 OCR（${i + 1}/${targets.length}）：正在识别第 ${record.pageNumber} 页…`);
    const ok = await runOcrForPage(record);
    if (ok) succeeded += 1;
  }

  if (docGen !== activeDocumentGeneration) return;
  const cancelled = batchOcrCancelRequested;
  batchOcrRunning = false;
  batchOcrCancelRequested = false;
  updateBatchOcrButton();
  const totalLabel = processed > 0 ? processed : targets.length;
  setStatus(
    cancelled
      ? `已停止批量识别（已完成 ${succeeded}/${totalLabel} 页）`
      : `扫描页批量 OCR 完成（成功 ${succeeded}/${totalLabel} 页）`,
  );
}

function isPdfRenderCancelledError(error: unknown): boolean {
  return Boolean(
    error
    && typeof error === "object"
    && ((error as { name?: unknown }).name === "RenderingCancelledException"
      || String((error as { message?: unknown }).message ?? "").includes("Rendering cancelled")),
  );
}

function computePdfPageMetrics(baseViewport: { width: number; height: number }): {
  renderScale: number;
  dpr: number;
} {
  const targetDpr = Math.min(2.5, Math.max(2, window.devicePixelRatio || 1));
  const maxCanvasSidePx = 2400;
  const paneBaseWidth = activePdfViewMode === "overlay"
    ? Math.max(520, Math.min(860, (pdfCanvasPane.clientWidth || 820) - 48))
    : Math.max(420, Math.min(720, (pdfCanvasPane.clientWidth || 600) - 44));
  const targetCssWidth = paneBaseWidth * activePdfScale;
  const renderScale = targetCssWidth / Math.max(1, baseViewport.width);
  const scaledW = baseViewport.width * renderScale;
  const scaledH = baseViewport.height * renderScale;
  const dpr = Math.max(1, Math.min(targetDpr, maxCanvasSidePx / Math.max(1, scaledW, scaledH)));
  return { renderScale, dpr };
}

function syncPdfPageHitBoxes(record: PdfPageRecord): void {
  const blockById = new Map<string, PdfLayoutBlock>();
  for (const block of record.blocks) blockById.set(block.id, block);
  for (const hit of Array.from(record.hitLayer.querySelectorAll<HTMLElement>(".pdf-hit-box"))) {
    const block = blockById.get(hit.dataset.blockId ?? "");
    if (!block) continue;
    hit.style.left = `${Math.max(0, block.box.x * record.renderScale - 2)}px`;
    hit.style.top = `${Math.max(0, block.box.y * record.renderScale - 2)}px`;
    hit.style.width = `${Math.max(8, block.box.width * record.renderScale + 4)}px`;
    hit.style.height = `${Math.max(8, block.box.height * record.renderScale + 4)}px`;
  }
}

function resolvePdfPageWaiters(record: PdfPageRecord, ok: boolean): void {
  const waiters = pdfPageRenderWaiters.get(record);
  if (!waiters) return;
  pdfPageRenderWaiters.delete(record);
  for (const resolve of waiters) resolve(ok);
}

function clearAllPdfRenderWaiters(ok: boolean): void {
  for (const [record, waiters] of Array.from(pdfPageRenderWaiters.entries())) {
    pdfPageRenderWaiters.delete(record);
    for (const resolve of waiters) resolve(ok);
  }
}

function isPdfCanvasUpToDate(record: PdfPageRecord): boolean {
  return record.baseRendered
    && record.baseCanvas.width > 0
    && record.baseCanvas.height > 0
    && record.renderedScale === record.renderScale
    && record.renderedDpr === record.dpr;
}

function evictPdfPageCanvas(record: PdfPageRecord): void {
  releaseCanvasBacking(record.baseCanvas);
  clearPdfOverlayForPage(record);
  record.baseRendered = false;
  record.renderedScale = 0;
  record.renderedDpr = 0;
  record.canvasBytes = 0;
  record.shell.classList.add("is-pending");
}

function evictFarPdfCanvases(anchor: PdfPageRecord, reserveBytes = 0, reserveSlots = 0): void {
  const victims = selectPdfPagesToEvict(activePdfPages, anchor.pageNumber, {
    maxRendered: Math.max(1, MAX_RENDERED_PDF_CANVASES - reserveSlots),
    maxBytes: Math.max(0, MAX_PDF_CANVAS_BUDGET_BYTES - reserveBytes),
    snapshotBytes: totalPdfSnapshotBytes(),
  });
  for (const victim of victims) {
    evictPdfPageCanvas(victim);
  }
}

async function extractPdfPageTextAndStyles(page: pdfjsLib.PDFPageProxy): Promise<{
  rawItems: PdfRawTextItem[];
  enrichedStyles: Record<string, PdfFontStyleInfo>;
  unresolvedFontKeys: string[];
}> {
  const textContent = await page.getTextContent();
  const rawItems: PdfRawTextItem[] = [];
  for (const item of textContent.items) {
    if ("str" in item && typeof item.str === "string") {
      rawItems.push({
        str: item.str,
        transform: item.transform,
        width: item.width,
        height: item.height,
        fontName: item.fontName,
        hasEOL: item.hasEOL,
      });
    }
  }
  const enrichedStyles: Record<string, PdfFontStyleInfo> = {};
  const unresolvedFontKeys: string[] = [];
  for (const [fontKey, style] of Object.entries(textContent.styles as Record<string, PdfFontStyleInfo>)) {
    let realFontName = style?.realFontName;
    if (!realFontName) {
      try {
        if (page.commonObjs.has(fontKey)) {
          const obj = page.commonObjs.get(fontKey) as { name?: string } | null;
          if (obj && typeof obj.name === "string") realFontName = obj.name;
        } else {
          unresolvedFontKeys.push(fontKey);
        }
      } catch {
        // Ignore unavailable font metadata objects.
      }
    }
    enrichedStyles[fontKey] = { ...style, ...(realFontName ? { realFontName } : {}) };
  }
  return { rawItems, enrichedStyles, unresolvedFontKeys };
}

function hasSignificantNewlyResolvedFont(page: pdfjsLib.PDFPageProxy, fontKeys: readonly string[]): boolean {
  for (const fontKey of fontKeys) {
    try {
      if (!page.commonObjs.has(fontKey)) continue;
      const obj = page.commonObjs.get(fontKey) as { name?: string } | null;
      if (obj && typeof obj.name === "string" && SIGNIFICANT_PDF_FONT_RE.test(obj.name)) {
        return true;
      }
    } catch {
      // Ignore unavailable font metadata objects.
    }
  }
  return false;
}

async function renderSinglePdfPage(
  record: PdfPageRecord,
  docGen: number,
  renderGen: number,
): Promise<"rendered" | "rescaled" | "stale" | "failed"> {
  const pdf = activePdfDoc;
  if (!pdf || docGen !== activeDocumentGeneration) return "stale";
  if (renderGen !== activePdfRenderGeneration) return "rescaled";

  const page = await pdf.getPage(record.pageNumber);
  if (docGen !== activeDocumentGeneration) {
    page.cleanup();
    return "stale";
  }
  if (renderGen !== activePdfRenderGeneration) {
    page.cleanup();
    return "rescaled";
  }

  const targetScale = record.renderScale;
  const targetDpr = record.dpr;
  const viewport = page.getViewport({ scale: targetScale });
  const cssW = Math.round(viewport.width);
  const cssH = Math.round(viewport.height);

  const pixelW = Math.max(1, Math.round(viewport.width * targetDpr));
  const pixelH = Math.max(1, Math.round(viewport.height * targetDpr));
  if (!record.baseRendered) {
    const incomingBytes = pixelW * pixelH * 4 * (isDocumentTranslated && activePdfViewMode === "overlay" ? 2 : 1);
    evictFarPdfCanvases(record, incomingBytes, 1);
  }

  record.shell.style.width = `${cssW}px`;
  record.shell.style.height = `${cssH}px`;
  record.baseCanvas.width = pixelW;
  record.baseCanvas.height = pixelH;
  record.baseCanvas.style.width = `${cssW}px`;
  record.baseCanvas.style.height = `${cssH}px`;
  const ctx = record.baseCanvas.getContext("2d");
  if (!ctx) {
    evictPdfPageCanvas(record);
    page.cleanup();
    return "failed";
  }
  ctx.setTransform(targetDpr, 0, 0, targetDpr, 0, 0);

  const renderTask = page.render({ canvasContext: ctx, viewport, canvas: record.baseCanvas });
  activeRenderTask = renderTask;
  try {
    await renderTask.promise;
  } catch (error) {
    if (isPdfRenderCancelledError(error)) {
      if (!record.baseRendered) evictPdfPageCanvas(record);
      return docGen !== activeDocumentGeneration ? "stale" : "rescaled";
    }
    if (docGen !== activeDocumentGeneration) {
      evictPdfPageCanvas(record);
      return "stale";
    }
    if (renderGen !== activePdfRenderGeneration) {
      evictPdfPageCanvas(record);
      return "rescaled";
    }
    evictPdfPageCanvas(record);
    console.warn(`[PageLingo] Failed to render PDF page ${record.pageNumber}`, error);
    return "failed";
  } finally {
    if (activeRenderTask === renderTask) activeRenderTask = null;
  }

  if (docGen !== activeDocumentGeneration) {
    evictPdfPageCanvas(record);
    page.cleanup();
    return "stale";
  }
  if (renderGen !== activePdfRenderGeneration) {
    evictPdfPageCanvas(record);
    page.cleanup();
    return "rescaled";
  }

  record.baseRendered = true;
  record.renderedScale = targetScale;
  record.renderedDpr = targetDpr;
  record.lastUsedSeq = ++pdfRenderSeq;
  record.shell.classList.remove("is-pending");
  updateRecordCanvasBytes(record);

  try {
    if (
      !record.fontRefined
      && !record.ocrDone
      && record.unresolvedFontKeys.length > 0
      && !isDocumentTranslated
      && hasSignificantNewlyResolvedFont(page, record.unresolvedFontKeys)
    ) {
      const { rawItems, enrichedStyles } = await extractPdfPageTextAndStyles(page);
      if (docGen === activeDocumentGeneration && renderGen === activePdfRenderGeneration && !isDocumentTranslated) {
        const refinedBlocks = extractPdfPageBlocks(
          rawItems,
          enrichedStyles,
          record.pageWidth,
          record.pageHeight,
          record.pageNumber,
        );
        populatePdfPageBlocks(record, refinedBlocks);
      }
    }
    record.fontRefined = true;
    record.unresolvedFontKeys = [];
  } finally {
    page.cleanup();
  }

  if (docGen !== activeDocumentGeneration) return "stale";
  if (renderGen !== activePdfRenderGeneration) return "rescaled";

  hydratePdfPageSnapshots(record);
  finalizePdfPageScanCheck(record);
  if (isDocumentTranslated && activePdfViewMode === "overlay") {
    renderPdfOverlayForPage(record);
  }
  evictFarPdfCanvases(record);
  return "rendered";
}

function pumpPdfRenderQueue(): void {
  if (pdfRenderLoopActive) return;
  pdfRenderLoopActive = true;
  void (async () => {
    try {
      while (pdfPendingRenders.size > 0 && activePdfDoc) {
        const docGen = activeDocumentGeneration;
        const renderGen = activePdfRenderGeneration;
        const paneRect = pdfCanvasPane.getBoundingClientRect();
        const viewportCenterY = (paneRect.top + paneRect.bottom) / 2;

        const beforePick = Array.from(pdfPendingRenders);
        const next = pickNextLazyPdfPage(
          pdfPendingRenders,
          pdfUrgentRenders,
          viewportCenterY,
          (record) => {
            const rect = record.shell.getBoundingClientRect();
            return (rect.top + rect.bottom) / 2;
          },
        );
        for (const candidate of beforePick) {
          if (!pdfPendingRenders.has(candidate)) {
            resolvePdfPageWaiters(candidate, isPdfCanvasUpToDate(candidate));
          }
        }
        if (!next) break;

        pdfPendingRenders.delete(next);
        pdfUrgentRenders.delete(next);

        if (isPdfCanvasUpToDate(next)) {
          next.lastUsedSeq = ++pdfRenderSeq;
          hydratePdfPageSnapshots(next);
          finalizePdfPageScanCheck(next);
          if (isDocumentTranslated && activePdfViewMode === "overlay" && !next.overlayCanvas) {
            renderPdfOverlayForPage(next);
          }
          resolvePdfPageWaiters(next, true);
          continue;
        }

        const outcome = await renderSinglePdfPage(next, docGen, renderGen);
        if (outcome === "rendered") {
          resolvePdfPageWaiters(next, true);
        } else if (outcome === "rescaled" && docGen === activeDocumentGeneration && pdfPendingRenders.has(next)) {
          // Keep waiters attached so they resolve after the new zoom scale renders.
        } else {
          resolvePdfPageWaiters(next, false);
        }
      }
    } finally {
      pdfRenderLoopActive = false;
      if (pdfPendingRenders.size > 0 && activePdfDoc) {
        pumpPdfRenderQueue();
      }
    }
  })();
}

function ensurePdfPageRendered(record: PdfPageRecord, urgent = false): Promise<boolean> {
  if (!activePdfDoc) return Promise.resolve(false);
  if (isPdfCanvasUpToDate(record)) {
    record.lastUsedSeq = ++pdfRenderSeq;
    hydratePdfPageSnapshots(record);
    finalizePdfPageScanCheck(record);
    if (isDocumentTranslated && activePdfViewMode === "overlay" && !record.overlayCanvas) {
      renderPdfOverlayForPage(record);
    }
    return Promise.resolve(true);
  }
  return new Promise<boolean>((resolve) => {
    const existing = pdfPageRenderWaiters.get(record);
    if (existing) existing.push(resolve);
    else pdfPageRenderWaiters.set(record, [resolve]);
    pdfPendingRenders.add(record);
    if (urgent) pdfUrgentRenders.add(record);
    pumpPdfRenderQueue();
  });
}

function enqueueVisiblePdfPages(): PdfPageRecord[] {
  const paneRect = pdfCanvasPane.getBoundingClientRect();
  const hasViewport = paneRect.bottom > paneRect.top;
  const visible: PdfPageRecord[] = [];
  for (const record of activePdfPages) {
    const isNear = hasViewport
      ? isRectNearVerticalWindow(record.shell.getBoundingClientRect(), paneRect, PDF_LAZY_MARGIN_PX)
      : record.pageNumber <= 2;
    record.isCanvasVisible = isNear;
    if (!isNear) continue;
    visible.push(record);
    if (!isPdfCanvasUpToDate(record)) {
      pdfPendingRenders.add(record);
    } else if (isDocumentTranslated && activePdfViewMode === "overlay" && !record.overlayCanvas) {
      renderPdfOverlayForPage(record);
    }
  }
  if (pdfPendingRenders.size > 0) pumpPdfRenderQueue();
  return visible;
}

function setupPdfLazyObservers(): void {
  pdfCanvasObserver?.disconnect();
  pdfCanvasObserver = null;
  pdfTextPaneObserver?.disconnect();
  pdfTextPaneObserver = null;
  if (activePdfPages.length === 0) return;

  if (typeof IntersectionObserver !== "function") {
    for (const record of activePdfPages) {
      record.isCanvasVisible = true;
      if (!isPdfCanvasUpToDate(record)) pdfPendingRenders.add(record);
    }
    pumpPdfRenderQueue();
    return;
  }

  const recordByShell = new Map<Element, PdfPageRecord>();
  const recordByCard = new Map<Element, PdfPageRecord>();
  for (const record of activePdfPages) {
    recordByShell.set(record.shell, record);
    recordByCard.set(record.pageCard, record);
  }

  pdfCanvasObserver = new IntersectionObserver((entries) => {
    let shouldPump = false;
    for (const entry of entries) {
      const record = recordByShell.get(entry.target);
      if (!record) continue;
      record.isCanvasVisible = entry.isIntersecting;
      if (!entry.isIntersecting) continue;
      if (!isPdfCanvasUpToDate(record)) {
        pdfPendingRenders.add(record);
        shouldPump = true;
      } else {
        record.lastUsedSeq = ++pdfRenderSeq;
        if (isDocumentTranslated && activePdfViewMode === "overlay" && !record.overlayCanvas) {
          renderPdfOverlayForPage(record);
        }
      }
    }
    if (shouldPump) pumpPdfRenderQueue();
  }, { root: pdfCanvasPane, rootMargin: PDF_LAZY_ROOT_MARGIN });

  pdfTextPaneObserver = new IntersectionObserver((entries) => {
    let shouldPump = false;
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const record = recordByCard.get(entry.target);
      if (!record) continue;
      if (!record.needsSnapshotHydration && !record.needsScanCheck) {
        pdfTextPaneObserver?.unobserve(record.pageCard);
        continue;
      }
      if (!isPdfCanvasUpToDate(record)) {
        pdfPendingRenders.add(record);
        shouldPump = true;
      } else {
        hydratePdfPageSnapshots(record);
        finalizePdfPageScanCheck(record);
      }
    }
    if (shouldPump) pumpPdfRenderQueue();
  }, { root: pdfTextPane, rootMargin: PDF_TEXT_LAZY_ROOT_MARGIN });

  for (const record of activePdfPages) {
    pdfCanvasObserver.observe(record.shell);
    if (record.needsSnapshotHydration || record.needsScanCheck) {
      pdfTextPaneObserver.observe(record.pageCard);
    }
  }
}

function clearActiveDocument(bumpOpenGeneration = true): void {
  if (bumpOpenGeneration) activeOpenGeneration += 1;
  activeDocumentGeneration += 1;
  activePdfRenderGeneration += 1;
  activeTranslationGeneration += 1;
  pdfLoadingPages = false;
  batchOcrCancelRequested = true;
  batchOcrRunning = false;
  activeOcrRequestId = "";
  pdfCanvasObserver?.disconnect();
  pdfCanvasObserver = null;
  pdfTextPaneObserver?.disconnect();
  pdfTextPaneObserver = null;
  pdfPendingRenders.clear();
  pdfUrgentRenders.clear();
  clearAllPdfRenderWaiters(false);
  pdfRenderSeq = 0;
  try {
    activeRenderTask?.cancel();
  } catch {}
  activeRenderTask = null;
  const prevDoc = activePdfDoc;
  activePdfDoc = null;
  if (prevDoc) void prevDoc.destroy().catch(() => {});
  const prevLoading = activePdfLoadingTask;
  activePdfLoadingTask = null;
  if (prevLoading) void prevLoading.destroy().catch(() => {});

  for (const page of activePdfPages) {
    releaseCanvasBacking(page.baseCanvas);
    releaseCanvasBacking(page.overlayCanvas);
  }
  activeTranslator?.restore();
  activeTranslator = null;
  isDocumentTranslated = false;
  activeBlockId = "";
  activePdfPages = [];
  translateBtn.textContent = "翻译文档";
  hideOverlaySourceCard();
  pdfCanvasPane.replaceChildren();
  pdfTextPane.replaceChildren();
  docTocList.replaceChildren();
  docContentEl.replaceChildren();
  ocrAllBtn.hidden = true;
}

async function rerenderActivePdfAtCurrentScale(): Promise<void> {
  const pdf = activePdfDoc;
  if (!pdf || activePdfPages.length === 0) return;
  const docGen = activeDocumentGeneration;
  const renderGen = ++activePdfRenderGeneration;
  try {
    activeRenderTask?.cancel();
  } catch {}
  activeRenderTask = null;

  zoomLabelEl.textContent = `${Math.round(activePdfScale * 100)}%`;

  // Preserve urgent requests (such as an active OCR page) while dropping stale non-urgent scale renders.
  const retainedUrgent = new Set(pdfUrgentRenders);
  for (const stale of Array.from(pdfPendingRenders)) {
    if (!retainedUrgent.has(stale)) {
      pdfPendingRenders.delete(stale);
      resolvePdfPageWaiters(stale, false);
    }
  }

  for (const record of activePdfPages) {
    const { renderScale, dpr } = computePdfPageMetrics({
      width: record.pageWidth,
      height: record.pageHeight,
    });
    const cssW = Math.round(record.pageWidth * renderScale);
    const cssH = Math.round(record.pageHeight * renderScale);
    record.renderScale = renderScale;
    record.dpr = dpr;
    record.shell.style.width = `${cssW}px`;
    record.shell.style.height = `${cssH}px`;
    record.baseCanvas.style.width = `${cssW}px`;
    record.baseCanvas.style.height = `${cssH}px`;
    evictPdfPageCanvas(record);
    syncPdfPageHitBoxes(record);
  }

  for (const urgent of retainedUrgent) {
    pdfPendingRenders.add(urgent);
    pdfUrgentRenders.add(urgent);
  }

  const visiblePages = enqueueVisiblePdfPages();
  const targets = visiblePages.length > 0 ? visiblePages : [activePdfPages[0]!];
  setStatus(`正在缩放当前可见页（${Math.round(activePdfScale * 100)}%）…`);
  await Promise.all(targets.map((record) => ensurePdfPageRendered(record)));

  if (docGen === activeDocumentGeneration && renderGen === activePdfRenderGeneration) {
    setStatus(`已缩放至 ${Math.round(activePdfScale * 100)}%（保留当前译文与 OCR 结果）`);
  }
}

async function openPdfBytes(
  bytes: Uint8Array,
  title: string,
  autoTranslate = false,
  expectedOpenGen?: number,
): Promise<void> {
  if (expectedOpenGen !== undefined && expectedOpenGen !== activeOpenGeneration) return;
  clearActiveDocument(expectedOpenGen === undefined);
  const openGen = expectedOpenGen ?? activeOpenGeneration;
  const docGen = activeDocumentGeneration;
  const renderGen = activePdfRenderGeneration;
  activeKind = "pdf";
  docTitleEl.textContent = title;
  emptyEl.hidden = true;
  docWorkspaceEl.hidden = true;
  pdfWorkspaceEl.hidden = false;
  pdfToolsEl.hidden = false;
  syncPdfViewButtons();
  zoomLabelEl.textContent = `${Math.round(activePdfScale * 100)}%`;
  translateBtn.disabled = true;
  restoreBtn.disabled = true;
  setStatus(`正在本地解析 PDF：${title}…`);

  const loadingTask = pdfjsLib.getDocument({
    data: bytes,
    cMapUrl,
    cMapPacked: true,
    standardFontDataUrl,
    isEvalSupported: false,
    useSystemFonts: true,
  });
  activePdfLoadingTask = loadingTask;

  let pdf: pdfjsLib.PDFDocumentProxy;
  try {
    pdf = await loadingTask.promise;
  } catch (error) {
    if (docGen !== activeDocumentGeneration || openGen !== activeOpenGeneration) return;
    if (activePdfLoadingTask === loadingTask) activePdfLoadingTask = null;
    throw error;
  }
  if (activePdfLoadingTask === loadingTask) activePdfLoadingTask = null;
  if (docGen !== activeDocumentGeneration || openGen !== activeOpenGeneration) {
    void pdf.destroy().catch(() => {});
    return;
  }
  activePdfDoc = pdf;

  const totalPages = pdf.numPages;
  const maxPages = Math.min(totalPages, 80);
  let totalBlocks = 0;
  let totalFormulas = 0;
  let totalTables = 0;
  let eagerFontOpProbes = 0;
  pdfLoadingPages = true;

  try {
    for (let pageNum = 1; pageNum <= maxPages; pageNum += 1) {
      if (docGen !== activeDocumentGeneration || openGen !== activeOpenGeneration) return;
      setStatus(
        pageNum === 1
          ? `正在渲染第 1/${maxPages} 页并提取目录与正文…`
          : `正在提取第 ${pageNum}/${maxPages} 页正文结构（画布按滚动按需渲染）…`,
      );
      const page = await pdf.getPage(pageNum);
      if (docGen !== activeDocumentGeneration || openGen !== activeOpenGeneration) {
        page.cleanup();
        return;
      }
      const baseViewport = page.getViewport({ scale: 1.0 });
      const { renderScale, dpr } = computePdfPageMetrics(baseViewport);
      const viewport = page.getViewport({ scale: renderScale });
      const cssW = Math.round(viewport.width);
      const cssH = Math.round(viewport.height);

      // Left/Main pane: shell with exact CSS dimensions; only page 1 renders eagerly,
      // while pages 2..maxPages allocate and render their HiDPI canvas lazily on scroll.
      const shell = document.createElement("div");
      shell.className = "pdf-page-shell";
      shell.dataset.pageNumber = String(pageNum);
      shell.style.width = `${cssW}px`;
      shell.style.height = `${cssH}px`;

      const baseCanvas = document.createElement("canvas");
      baseCanvas.className = "pdf-base-canvas";
      baseCanvas.style.width = `${cssW}px`;
      baseCanvas.style.height = `${cssH}px`;

      let baseRendered = false;
      if (pageNum === 1) {
        baseCanvas.width = Math.max(1, Math.round(viewport.width * dpr));
        baseCanvas.height = Math.max(1, Math.round(viewport.height * dpr));
        const ctx = baseCanvas.getContext("2d")!;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        const renderTask = page.render({ canvasContext: ctx, viewport, canvas: baseCanvas });
        activeRenderTask = renderTask;
        try {
          await renderTask.promise;
          baseRendered = true;
        } catch (error) {
          if (isPdfRenderCancelledError(error) || docGen !== activeDocumentGeneration || openGen !== activeOpenGeneration) {
            releaseCanvasBacking(baseCanvas);
            page.cleanup();
            return;
          }
          page.cleanup();
          throw error;
        } finally {
          if (activeRenderTask === renderTask) activeRenderTask = null;
        }
      } else {
        baseCanvas.width = 0;
        baseCanvas.height = 0;
        shell.classList.add("is-pending");
      }

      if (docGen !== activeDocumentGeneration || openGen !== activeOpenGeneration) {
        releaseCanvasBacking(baseCanvas);
        page.cleanup();
        return;
      }

      const badge = document.createElement("span");
      badge.className = "pdf-page-badge";
      badge.textContent = `${pageNum} / ${totalPages}`;

      const hitLayer = document.createElement("div");
      hitLayer.className = "pdf-hit-layer";

      shell.append(baseCanvas, hitLayer, badge);
      pdfCanvasPane.append(shell);

      // Extract layout-preserving, formula-protected, table-aware blocks from PDF text layer.
      // Because page 1 already rendered, shared document fonts are warm in page.commonObjs.
      // When a later text page introduces a brand-new font key (e.g. a unique math font on page 2),
      // fetch its operator list without rasterizing a canvas so realFontName is known before translation.
      let extracted = await extractPdfPageTextAndStyles(page);
      if (docGen !== activeDocumentGeneration || openGen !== activeOpenGeneration) {
        page.cleanup();
        return;
      }
      if (
        !baseRendered
        && extracted.rawItems.length > 0
        && extracted.unresolvedFontKeys.length > 0
        && eagerFontOpProbes < MAX_EAGER_FONT_OP_PROBES
      ) {
        eagerFontOpProbes += 1;
        try {
          await page.getOperatorList();
          if (docGen !== activeDocumentGeneration || openGen !== activeOpenGeneration) {
            page.cleanup();
            return;
          }
          extracted = await extractPdfPageTextAndStyles(page);
        } catch {
          // Keep initial text styles if operator list lookup fails.
        }
      }
      if (docGen !== activeDocumentGeneration || openGen !== activeOpenGeneration) {
        page.cleanup();
        return;
      }
      page.cleanup();

      const { rawItems, enrichedStyles, unresolvedFontKeys } = extracted;
      const blocks = extractPdfPageBlocks(
        rawItems,
        enrichedStyles,
        baseViewport.width,
        baseViewport.height,
        pageNum,
      );

      const pageCard = document.createElement("section");
      pageCard.className = "pdf-text-page";
      pageCard.dataset.pageNumber = String(pageNum);
      const pageHead = document.createElement("div");
      pageHead.className = "pdf-text-page-head";
      const pageLabel = document.createElement("span");
      pageLabel.textContent = `第 ${pageNum} 页`;
      const headRight = document.createElement("div");
      headRight.className = "pdf-page-head-right";
      const pageStatsEl = document.createElement("span");
      const ocrBtnEl = document.createElement("button");
      ocrBtnEl.type = "button";
      ocrBtnEl.className = "pdf-page-ocr-btn";
      ocrBtnEl.textContent = "版面 OCR";
      ocrBtnEl.title = "使用本地版面与文字识别重新提取本页内容";
      headRight.append(pageStatsEl, ocrBtnEl);
      pageHead.append(pageLabel, headRight);
      pageCard.append(pageHead);
      pdfTextPane.append(pageCard);

      const record: PdfPageRecord = {
        pageNumber: pageNum,
        pageWidth: baseViewport.width,
        pageHeight: baseViewport.height,
        renderScale,
        dpr,
        shell,
        baseCanvas,
        overlayCanvas: null,
        hitLayer,
        pageCard,
        pageStatsEl,
        ocrBtnEl,
        blocks: [],
        isScanned: false,
        ocrDone: false,
        baseRendered,
        renderedScale: baseRendered ? renderScale : 0,
        renderedDpr: baseRendered ? dpr : 0,
        lastUsedSeq: baseRendered ? ++pdfRenderSeq : 0,
        isCanvasVisible: pageNum === 1,
        needsSnapshotHydration: false,
        needsScanCheck: false,
        unresolvedFontKeys: baseRendered ? [] : unresolvedFontKeys,
        fontRefined: baseRendered || unresolvedFontKeys.length === 0,
        canvasBytes: canvasPixelBytes(baseCanvas),
        snapshotBytes: 0,
      };
      ocrBtnEl.addEventListener("click", () => {
        void runOcrForPage(record);
      });
      activePdfPages.push(record);
      populatePdfPageBlocks(record, blocks);

      totalBlocks += blocks.length;
      for (const block of blocks) {
        if (block.kind === "formula") totalFormulas += 1;
        else if (block.kind === "table") totalTables += 1;
        else totalFormulas += block.segments.filter((s) => s.kind === "math").length;
      }
    }
  } finally {
    if (docGen === activeDocumentGeneration) {
      pdfLoadingPages = false;
    }
  }

  if (docGen !== activeDocumentGeneration || openGen !== activeOpenGeneration) return;
  setupPdfLazyObservers();
  enqueueVisiblePdfPages();

  translateBtn.disabled = false;
  restoreBtn.disabled = true;
  const scannedPages = activePdfPages.filter((p) => p.isScanned).length;
  const pageHint = totalPages > maxPages ? `（已载入前 ${maxPages}/${totalPages} 页）` : `（共 ${totalPages} 页）`;
  const parts = [`已载入 PDF ${pageHint} · ${totalBlocks} 个区块`];
  if (totalFormulas > 0) parts.push(`保护 ${totalFormulas} 处公式`);
  if (totalTables > 0) parts.push(`识别 ${totalTables} 张表格`);
  if (scannedPages > 0) parts.push(`${scannedPages} 页扫描图像可按需 OCR`);
  setStatus(parts.join(" · "));

  if (renderGen !== activePdfRenderGeneration) {
    void rerenderActivePdfAtCurrentScale().catch((err) => {
      if (docGen === activeDocumentGeneration) {
        setStatus(err instanceof Error ? err.message : String(err));
      }
    });
  }
  if (autoTranslate && totalBlocks > 0 && docGen === activeDocumentGeneration && openGen === activeOpenGeneration) {
    await runTranslation();
  }
}

function renderParsedDocument(parsed: ParsedDocumentResult, expectedOpenGen?: number): void {
  if (expectedOpenGen !== undefined && expectedOpenGen !== activeOpenGeneration) return;
  clearActiveDocument(expectedOpenGen === undefined);
  activeKind = "doc";
  docTitleEl.textContent = parsed.title;
  emptyEl.hidden = true;
  pdfWorkspaceEl.hidden = true;
  pdfToolsEl.hidden = true;
  docWorkspaceEl.hidden = false;

  docContentEl.append(parsed.fragment);
  if (parsed.toc.length >= 2) {
    docTocPane.hidden = false;
    for (const item of parsed.toc) {
      const link = document.createElement("a");
      link.href = `#${item.id}`;
      link.textContent = item.label;
      link.dataset.level = String(item.level);
      link.addEventListener("click", (e) => {
        e.preventDefault();
        document.getElementById(item.id)?.scrollIntoView({ behavior: "smooth", block: "start" });
      });
      docTocList.append(link);
    }
  } else {
    docTocPane.hidden = true;
  }

  translateBtn.disabled = false;
  restoreBtn.disabled = true;
  setStatus(`已载入 ${parsed.kind.toUpperCase()} 文档：${parsed.title}${parsed.formulaCount > 0 ? ` · 已保护 ${parsed.formulaCount} 处公式` : ""}`);
}

async function openFile(file: File): Promise<void> {
  const openGen = ++activeOpenGeneration;
  try {
    const lower = file.name.toLowerCase();
    const buffer = await file.arrayBuffer();
    if (openGen !== activeOpenGeneration) return;
    if (lower.endsWith(".pdf") || file.type === "application/pdf") {
      await openPdfBytes(new Uint8Array(buffer), file.name, false, openGen);
      return;
    }
    if (lower.endsWith(".epub")) {
      const parsed = await parseEpubDocument(document, buffer, file.name);
      if (openGen !== activeOpenGeneration) return;
      renderParsedDocument(parsed, openGen);
      return;
    }
    if (lower.endsWith(".docx")) {
      const parsed = await parseDocxDocument(document, buffer, file.name);
      if (openGen !== activeOpenGeneration) return;
      renderParsedDocument(parsed, openGen);
      return;
    }
    const text = new TextDecoder("utf-8").decode(buffer);
    if (lower.endsWith(".md") || lower.endsWith(".markdown")) {
      renderParsedDocument(parseMarkdownDocument(document, text, file.name), openGen);
    } else if (lower.endsWith(".html") || lower.endsWith(".htm") || file.type === "text/html") {
      renderParsedDocument(parseHtmlFileDocument(document, text, file.name), openGen);
    } else {
      renderParsedDocument(parsePlainTextDocument(document, text, file.name), openGen);
    }
  } catch (error) {
    if (openGen === activeOpenGeneration) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  }
}

async function openRemoteUrl(rawUrl: string, autoTranslate = false): Promise<void> {
  const openGen = ++activeOpenGeneration;
  setStatus(`正在读取在线文档：${rawUrl}…`);
  try {
    const response = await sendRuntimeMessage<{
      ok?: boolean;
      bytes?: ArrayBuffer;
      contentType?: string;
      finalUrl?: string;
      error?: string;
    }>({ type: "fetch-document-bytes", url: rawUrl });
    if (openGen !== activeOpenGeneration) return;

    if (!response?.ok || !(response.bytes instanceof ArrayBuffer)) {
      throw new Error(response?.error ?? "无法读取在线文档");
    }
    const finalUrl = response.finalUrl || rawUrl;
    const pathname = (() => {
      try { return new URL(finalUrl).pathname; } catch { return finalUrl; }
    })();
    const fileName = decodeURIComponent(pathname.split("/").filter(Boolean).pop() || "在线文档");
    const ct = (response.contentType || "").toLowerCase();
    const bytes = new Uint8Array(response.bytes);
    const looksPdf = ct.includes("application/pdf")
      || /\.pdf$/i.test(pathname)
      || (bytes.length >= 4 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46);

    if (looksPdf) {
      await openPdfBytes(bytes, fileName, autoTranslate, openGen);
      return;
    }
    if (/\.epub$/i.test(pathname) || ct.includes("application/epub+zip")) {
      const parsed = await parseEpubDocument(document, response.bytes, fileName);
      if (openGen !== activeOpenGeneration) return;
      renderParsedDocument(parsed, openGen);
      if (autoTranslate && openGen === activeOpenGeneration) await runTranslation();
      return;
    }
    if (/\.docx$/i.test(pathname) || ct.includes("application/vnd.openxmlformats-officedocument.wordprocessingml.document")) {
      const parsed = await parseDocxDocument(document, response.bytes, fileName);
      if (openGen !== activeOpenGeneration) return;
      renderParsedDocument(parsed, openGen);
      if (autoTranslate && openGen === activeOpenGeneration) await runTranslation();
      return;
    }
    const text = new TextDecoder("utf-8").decode(bytes);
    if (ct.includes("text/html") || /\.html?$/i.test(pathname)) {
      renderParsedDocument(parseHtmlFileDocument(document, text, fileName), openGen);
    } else if (/\.md$|\.markdown$/i.test(pathname)) {
      renderParsedDocument(parseMarkdownDocument(document, text, fileName), openGen);
    } else {
      renderParsedDocument(parsePlainTextDocument(document, text, fileName), openGen);
    }
    if (autoTranslate && openGen === activeOpenGeneration) await runTranslation();
  } catch (error) {
    if (openGen === activeOpenGeneration) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  }
}

async function runTranslation(): Promise<void> {
  const scope = activeKind === "pdf" ? pdfTextPane : activeKind === "doc" ? docContentEl : null;
  if (!scope) return;

  const docGen = activeDocumentGeneration;
  const transGen = ++activeTranslationGeneration;
  const isStale = (): boolean => docGen !== activeDocumentGeneration || transGen !== activeTranslationGeneration;

  translateBtn.disabled = true;
  translateBtn.textContent = "翻译中…";
  setStatus("正在翻译文档内容（公式、数值表格与代码块已自动保护）…");

  try {
    activeTranslator?.restore();
    activeTranslator = null;
    const { translator, sourceLanguage, targetLanguage } = await createConfiguredTranslator(scope);
    if (isStale()) {
      translator.restore();
      return;
    }
    activeTranslator = translator;
    const count = await translator.translateAll(scope, true);
    if (isStale()) {
      translator.restore();
      return;
    }
    isDocumentTranslated = count > 0;
    restoreBtn.disabled = count === 0;
    if (activeKind === "pdf" && activePdfViewMode === "overlay") {
      renderAllPdfOverlays();
    }
    const failed = translator.failedCount ?? 0;
    setStatus(
      `翻译完成（${languageLabel(sourceLanguage)} → ${languageLabel(targetLanguage)}）：已翻译 ${count} 个段落${failed > 0 ? `；${failed} 段保留原文` : ""}`,
    );
  } catch (error) {
    if (!isStale()) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  } finally {
    if (!isStale()) {
      translateBtn.disabled = false;
      translateBtn.textContent = "翻译文档";
    }
  }
}

function restoreOriginal(): void {
  activeTranslationGeneration += 1;
  activeTranslator?.restore();
  activeTranslator = null;
  isDocumentTranslated = false;
  clearAllPdfOverlays();
  hideOverlaySourceCard();
  restoreBtn.disabled = true;
  translateBtn.disabled = pdfLoadingPages;
  translateBtn.textContent = "翻译文档";
  setStatus("已恢复文档原文");
}

// Listen for background PDF OCR progress updates
if (typeof browser !== "undefined" && browser.runtime?.onMessage) {
  browser.runtime.onMessage.addListener((raw: unknown) => {
    const msg = raw as { type?: string; requestId?: string; status?: string };
    if (msg?.type === "pdf-ocr-progress" && msg.status && (!msg.requestId || msg.requestId === activeOcrRequestId)) {
      setStatus(msg.status);
    }
    return undefined;
  });
}

// Event wiring
openFileBtn.addEventListener("click", () => fileInputEl.click());
pickPrimaryBtn.addEventListener("click", () => fileInputEl.click());
openSettingsBtn.addEventListener("click", () => {
  void browser.runtime?.openOptionsPage?.();
});
fileInputEl.addEventListener("change", () => {
  const file = fileInputEl.files?.[0];
  if (file) void openFile(file);
  fileInputEl.value = "";
});

urlFormEl.addEventListener("submit", (e) => {
  e.preventDefault();
  const value = urlInputEl.value.trim();
  if (!value) return;
  void openRemoteUrl(value);
});

for (const btn of modeButtons) {
  btn.addEventListener("click", () => {
    activeDisplayMode = btn.dataset.readerMode === "translation" ? "translation" : "bilingual";
    syncModeButtons();
    activeTranslator?.setDisplayMode(activeDisplayMode);
    if (activeKind === "pdf" && activePdfViewMode === "overlay") {
      renderAllPdfOverlays();
    }
  });
}

for (const btn of pdfViewButtons) {
  btn.addEventListener("click", () => {
    const nextView: PdfViewMode = btn.dataset.pdfView === "overlay" ? "overlay" : "split";
    if (nextView === activePdfViewMode) return;
    activePdfViewMode = nextView;
    syncPdfViewButtons();
    if (activeKind === "pdf") {
      if (activePdfViewMode === "overlay") {
        if (isDocumentTranslated) {
          renderAllPdfOverlays();
          enqueueVisiblePdfPages();
          setStatus("已切换原位覆盖视图（公式、表格与图表像素原样保留，点击段落可查看原文）");
        } else {
          enqueueVisiblePdfPages();
          setStatus("已切换原位覆盖视图 · 点击「翻译文档」即可在原页覆盖译文（公式与图表原样保留）");
        }
      } else {
        clearAllPdfOverlays();
        enqueueVisiblePdfPages();
        setStatus("已切换双栏对照视图");
      }
    }
  });
}

ocrAllBtn.addEventListener("click", () => void runOcrForAllScannedPages());
translateBtn.addEventListener("click", () => void runTranslation());
restoreBtn.addEventListener("click", () => restoreOriginal());

function applyPdfZoomDelta(delta: number): void {
  if (activeKind !== "pdf") return;
  const nextScale = Math.max(0.7, Math.min(1.6, Number((activePdfScale + delta).toFixed(2))));
  if (nextScale === activePdfScale) return;
  activePdfScale = nextScale;
  zoomLabelEl.textContent = `${Math.round(activePdfScale * 100)}%`;
  if (pdfLoadingPages || activePdfLoadingTask) {
    activePdfRenderGeneration += 1;
  } else if (activePdfDoc && activePdfPages.length > 0) {
    const docGen = activeDocumentGeneration;
    void rerenderActivePdfAtCurrentScale().catch((err) => {
      if (docGen === activeDocumentGeneration) {
        setStatus(err instanceof Error ? err.message : String(err));
      }
    });
  }
}

zoomInBtn.addEventListener("click", () => applyPdfZoomDelta(0.15));
zoomOutBtn.addEventListener("click", () => applyPdfZoomDelta(-0.15));
window.addEventListener("pagehide", () => {
  clearActiveDocument();
});

// Drag & Drop support across the entire reader stage
stageEl.addEventListener("dragover", (e) => {
  e.preventDefault();
  stageEl.classList.add("drag-active");
});
stageEl.addEventListener("dragleave", () => {
  stageEl.classList.remove("drag-active");
});
stageEl.addEventListener("drop", (e) => {
  e.preventDefault();
  stageEl.classList.remove("drag-active");
  const file = e.dataTransfer?.files?.[0];
  if (file) void openFile(file);
});
dropzoneEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    fileInputEl.click();
  }
});

// Initialization
async function initReader(): Promise<void> {
  const [settings, catalogRes] = await Promise.all([
    loadSettings().catch(() => null),
    sendRuntimeMessage<CatalogResponse>({ type: "get-language-catalog" }).catch(() => null),
  ]);
  if (settings) {
    activeDisplayMode = settings.displayMode === "translation" ? "translation" : "bilingual";
    syncModeButtons();
    ensureReaderBilingualStyle(settings.bilingualStyle);
  }
  syncPdfViewButtons();
  if (catalogRes?.ok && catalogRes.catalog) {
    sourceSelect.replaceChildren();
    const autoOpt = document.createElement("option");
    autoOpt.value = "auto";
    autoOpt.textContent = "自动检测";
    sourceSelect.append(autoOpt);
    for (const lang of catalogRes.catalog.sourceLanguages) {
      const opt = document.createElement("option");
      opt.value = lang.code;
      opt.textContent = lang.label;
      sourceSelect.append(opt);
    }
    targetSelect.replaceChildren();
    for (const lang of catalogRes.catalog.targetLanguages) {
      const opt = document.createElement("option");
      opt.value = lang.code;
      opt.textContent = lang.label;
      targetSelect.append(opt);
    }
    if (settings?.targetLanguage) targetSelect.value = settings.targetLanguage;
  }

  const params = new URLSearchParams(location.search);
  const targetUrl = params.get("url");
  if (targetUrl && /^https?:\/\//i.test(targetUrl)) {
    urlInputEl.value = targetUrl;
    await openRemoteUrl(targetUrl, true);
  }
}

void initReader();
