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
  overlayCanvas: HTMLCanvasElement;
  hitLayer: HTMLElement;
  pageCard: HTMLElement;
  pageStatsEl: HTMLElement;
  ocrBtnEl: HTMLButtonElement;
  blocks: PdfLayoutBlock[];
  isScanned: boolean;
  ocrDone: boolean;
}

let activeKind: "none" | "pdf" | "doc" = "none";
let activeDisplayMode: DisplayMode = "bilingual";
let activePdfViewMode: PdfViewMode = "split";
let activeTranslator: PageTranslator | null = null;
let isDocumentTranslated = false;
let activePdfBytes: Uint8Array | null = null;
let activePdfScale = 1.0;
let activeBlockId = "";
let activePdfPages: PdfPageRecord[] = [];
let activeOcrRequestId = "";
let batchOcrRunning = false;
let batchOcrCancelRequested = false;
let overlaySourceCardEl: HTMLElement | null = null;

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

  if (block.kind === "formula") {
    const formula = document.createElement("div");
    formula.className = "reader-formula";
    formula.setAttribute("translate", "no");
    formula.title = block.plainText;
    formula.setAttribute("aria-label", block.plainText);
    const snapshot = pageCanvas
      ? cropRegionSnapshot(pageCanvas, block.box, renderScale, dpr, clipBounds, "formula")
      : null;
    if (snapshot) {
      formula.classList.add("is-snapshot");
      formula.append(snapshot);
    } else {
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
    const snapshot = pageCanvas
      ? cropRegionSnapshot(pageCanvas, block.box, renderScale, dpr, clipBounds, "figure")
      : null;
    if (snapshot) {
      fig.append(tag, snapshot);
    } else {
      fig.textContent = block.plainText;
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
    const snapshot = pageCanvas
      ? cropRegionSnapshot(pageCanvas, block.box, renderScale, dpr, clipBounds, "table")
      : null;
    if (snapshot) {
      tableCard.append(tag, snapshot);
    } else {
      tableCard.textContent = block.plainText;
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

function canvasHasVisualInk(canvas: HTMLCanvasElement): boolean {
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx || canvas.width < 16 || canvas.height < 16) return false;
  try {
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    const stepX = Math.max(1, Math.floor(canvas.width / 28));
    const stepY = Math.max(1, Math.floor(canvas.height / 28));
    let nonWhite = 0;
    for (let y = stepY; y < canvas.height - stepY; y += stepY) {
      for (let x = stepX; x < canvas.width - stepX; x += stepX) {
        const off = (y * canvas.width + x) * 4;
        if ((data[off + 3] ?? 255) < 32) continue;
        const r = data[off] ?? 255;
        const g = data[off + 1] ?? 255;
        const b = data[off + 2] ?? 255;
        if (r < 242 || g < 242 || b < 242) {
          nonWhite += 1;
          if (nonWhite >= 6) return true;
        }
      }
    }
  } catch {
    return true;
  }
  return false;
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

function populatePdfPageBlocks(record: PdfPageRecord, blocks: PdfLayoutBlock[]): void {
  record.blocks = blocks;
  record.hitLayer.replaceChildren();
  // Remove all children inside pageCard except its header
  while (record.pageCard.children.length > 1) {
    record.pageCard.lastElementChild?.remove();
  }
  // Clear stale overlay pixels until re-rendered
  clearPdfOverlayForPage(record);

  const totalTextChars = blocks
    .filter((b) => !isVisualSnapshotBlock(b))
    .reduce((sum, b) => sum + b.plainText.replace(/\s+/g, "").length, 0);
  const looksScanned = !record.ocrDone && totalTextChars < 16 && canvasHasVisualInk(record.baseCanvas);
  record.isScanned = looksScanned;

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
    record.pageCard.append(renderPdfBlockElement(block, record.baseCanvas, record.renderScale, record.dpr, clipBounds));
  }

  if (looksScanned || blocks.length === 0) {
    const card = document.createElement("div");
    card.className = "pdf-scanned-card";
    const note = document.createElement("p");
    note.textContent = looksScanned
      ? "本页未检出可用文字层（疑似扫描图像页）。可启用本地版面检测（PP-DocLayout-M）+ PP-OCRv6 识别正文，并自动保留原页公式、表格与图表。"
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

  updateBatchOcrButton();
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

function clearPdfOverlayForPage(record: PdfPageRecord): void {
  const ctx = record.overlayCanvas.getContext("2d");
  if (ctx) ctx.clearRect(0, 0, record.overlayCanvas.width, record.overlayCanvas.height);
  record.overlayCanvas.classList.remove("has-overlay");
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
    const imgData = baseCtx.getImageData(0, 0, record.baseCanvas.width, record.baseCanvas.height);
    const rendered = renderTranslatedImageToCanvas(record.overlayCanvas, {
      regions,
      ocrWidth: record.baseCanvas.width,
      ocrHeight: record.baseCanvas.height,
      pixels: imgData.data.buffer,
      displayWidth: record.baseCanvas.width,
      displayHeight: record.baseCanvas.height,
      devicePixelRatio: 1,
      paintBaseImage: false,
    });
    record.overlayCanvas.classList.toggle("has-overlay", rendered);
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
  for (const record of activePdfPages) {
    renderPdfOverlayForPage(record);
  }
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
  const requestId = `pdf-ocr-p${record.pageNumber}-${Date.now()}`;
  activeOcrRequestId = requestId;
  record.ocrBtnEl.disabled = true;
  if (triggerBtn) {
    triggerBtn.disabled = true;
    triggerBtn.textContent = "正在识别版面与文字…";
  }
  setStatus(`第 ${record.pageNumber} 页：准备版面检测与 PP-OCRv6 本地识别…`);
  try {
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
    if (!response?.ok || !Array.isArray(response.blocks)) {
      throw new Error(response?.error ?? "扫描页 OCR 识别失败");
    }
    record.ocrDone = true;
    record.isScanned = false;
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
        activeTranslator = translator;
        await translator.translateAll(record.pageCard, true);
      }
      renderPdfOverlayForPage(record);
      setStatus(`第 ${record.pageNumber} 页已识别并翻译完成`);
    }
    return true;
  } catch (error) {
    setStatus(`第 ${record.pageNumber} 页 OCR 失败：${error instanceof Error ? error.message : String(error)}`);
    if (triggerBtn) {
      triggerBtn.disabled = false;
      triggerBtn.textContent = "OCR 识别本页（保留公式与图表）";
    }
    return false;
  } finally {
    if (activeOcrRequestId === requestId) activeOcrRequestId = "";
    record.ocrBtnEl.disabled = false;
    updateBatchOcrButton();
  }
}

async function runOcrForAllScannedPages(): Promise<void> {
  if (batchOcrRunning) {
    batchOcrCancelRequested = true;
    setStatus("正在停止批量扫描页 OCR…");
    return;
  }
  const targets = activePdfPages.filter((p) => p.isScanned && !p.ocrDone);
  if (targets.length === 0) return;
  batchOcrRunning = true;
  batchOcrCancelRequested = false;
  updateBatchOcrButton();

  let succeeded = 0;
  for (let i = 0; i < targets.length; i += 1) {
    if (batchOcrCancelRequested) break;
    const record = targets[i]!;
    setStatus(`批量 OCR（${i + 1}/${targets.length}）：正在识别第 ${record.pageNumber} 页…`);
    const ok = await runOcrForPage(record);
    if (ok) succeeded += 1;
  }

  const cancelled = batchOcrCancelRequested;
  batchOcrRunning = false;
  batchOcrCancelRequested = false;
  updateBatchOcrButton();
  setStatus(
    cancelled
      ? `已停止批量识别（已完成 ${succeeded}/${targets.length} 页）`
      : `扫描页批量 OCR 完成（成功 ${succeeded}/${targets.length} 页）`,
  );
}

function clearActiveDocument(): void {
  batchOcrCancelRequested = true;
  batchOcrRunning = false;
  activeTranslator?.restore();
  activeTranslator = null;
  isDocumentTranslated = false;
  activeBlockId = "";
  activePdfPages = [];
  hideOverlaySourceCard();
  pdfCanvasPane.replaceChildren();
  pdfTextPane.replaceChildren();
  docTocList.replaceChildren();
  docContentEl.replaceChildren();
  ocrAllBtn.hidden = true;
}

async function openPdfBytes(bytes: Uint8Array, title: string, autoTranslate = false): Promise<void> {
  clearActiveDocument();
  activeKind = "pdf";
  activePdfBytes = bytes;
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
    data: bytes.slice(),
    cMapUrl,
    cMapPacked: true,
    standardFontDataUrl,
    isEvalSupported: false,
    useSystemFonts: true,
  });
  const pdf = await loadingTask.promise;
  const totalPages = pdf.numPages;
  const maxPages = Math.min(totalPages, 80);
  let totalBlocks = 0;
  let totalFormulas = 0;
  let totalTables = 0;
  const targetDpr = Math.min(2.5, Math.max(2, window.devicePixelRatio || 1));
  const maxCanvasSidePx = 2400;

  for (let pageNum = 1; pageNum <= maxPages; pageNum += 1) {
    setStatus(`正在渲染并提取第 ${pageNum}/${maxPages} 页…`);
    const page = await pdf.getPage(pageNum);
    const baseViewport = page.getViewport({ scale: 1.0 });
    const paneBaseWidth = activePdfViewMode === "overlay"
      ? Math.max(520, Math.min(860, (pdfCanvasPane.clientWidth || 820) - 48))
      : Math.max(420, Math.min(720, (pdfCanvasPane.clientWidth || 600) - 44));
    const targetCssWidth = paneBaseWidth * activePdfScale;
    const renderScale = targetCssWidth / baseViewport.width;
    const viewport = page.getViewport({ scale: renderScale });
    const dpr = Math.max(1, Math.min(targetDpr, maxCanvasSidePx / Math.max(1, viewport.width, viewport.height)));

    // Left/Main pane: original PDF canvas + transparent in-place overlay canvas + hit layer
    const shell = document.createElement("div");
    shell.className = "pdf-page-shell";
    shell.style.width = `${Math.round(viewport.width)}px`;
    shell.style.height = `${Math.round(viewport.height)}px`;

    const baseCanvas = document.createElement("canvas");
    baseCanvas.className = "pdf-base-canvas";
    baseCanvas.width = Math.round(viewport.width * dpr);
    baseCanvas.height = Math.round(viewport.height * dpr);
    baseCanvas.style.width = `${Math.round(viewport.width)}px`;
    baseCanvas.style.height = `${Math.round(viewport.height)}px`;
    const ctx = baseCanvas.getContext("2d")!;
    ctx.scale(dpr, dpr);
    await page.render({ canvasContext: ctx, viewport, canvas: baseCanvas }).promise;

    const overlayCanvas = document.createElement("canvas");
    overlayCanvas.className = "pdf-overlay-canvas";
    overlayCanvas.width = baseCanvas.width;
    overlayCanvas.height = baseCanvas.height;

    const badge = document.createElement("span");
    badge.className = "pdf-page-badge";
    badge.textContent = `${pageNum} / ${totalPages}`;

    const hitLayer = document.createElement("div");
    hitLayer.className = "pdf-hit-layer";

    shell.append(baseCanvas, overlayCanvas, hitLayer, badge);
    pdfCanvasPane.append(shell);

    // Extract layout-preserving, formula-protected, table-aware blocks from PDF text layer
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
    for (const [fontKey, style] of Object.entries(textContent.styles as Record<string, PdfFontStyleInfo>)) {
      let realFontName = style?.realFontName;
      if (!realFontName) {
        try {
          const obj = page.commonObjs.has(fontKey)
            ? (page.commonObjs.get(fontKey) as { name?: string } | null)
            : null;
          if (obj && typeof obj.name === "string") realFontName = obj.name;
        } catch {
          // Ignore unavailable font metadata objects.
        }
      }
      enrichedStyles[fontKey] = { ...style, ...(realFontName ? { realFontName } : {}) };
    }
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
    ocrBtnEl.title = "使用本地 PP-DocLayout-M + PP-OCRv6 重新识别本页版面与正文";
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
      overlayCanvas,
      hitLayer,
      pageCard,
      pageStatsEl,
      ocrBtnEl,
      blocks: [],
      isScanned: false,
      ocrDone: false,
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

  translateBtn.disabled = false;
  restoreBtn.disabled = true;
  const scannedPages = activePdfPages.filter((p) => p.isScanned).length;
  const pageHint = totalPages > maxPages ? `（已载入前 ${maxPages}/${totalPages} 页）` : `（共 ${totalPages} 页）`;
  const parts = [`已载入 PDF ${pageHint} · ${totalBlocks} 个区块`];
  if (totalFormulas > 0) parts.push(`保护 ${totalFormulas} 处公式`);
  if (totalTables > 0) parts.push(`识别 ${totalTables} 张表格`);
  if (scannedPages > 0) parts.push(`${scannedPages} 页扫描图像可按需 OCR`);
  setStatus(parts.join(" · "));

  if (autoTranslate && totalBlocks > 0) {
    await runTranslation();
  }
}

function renderParsedDocument(parsed: ParsedDocumentResult): void {
  clearActiveDocument();
  activeKind = "doc";
  activePdfBytes = null;
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
  const lower = file.name.toLowerCase();
  const buffer = await file.arrayBuffer();
  if (lower.endsWith(".pdf") || file.type === "application/pdf") {
    await openPdfBytes(new Uint8Array(buffer), file.name);
    return;
  }
  if (lower.endsWith(".epub")) {
    const parsed = await parseEpubDocument(document, buffer, file.name);
    renderParsedDocument(parsed);
    return;
  }
  if (lower.endsWith(".docx")) {
    const parsed = await parseDocxDocument(document, buffer, file.name);
    renderParsedDocument(parsed);
    return;
  }
  const text = new TextDecoder("utf-8").decode(buffer);
  if (lower.endsWith(".md") || lower.endsWith(".markdown")) {
    renderParsedDocument(parseMarkdownDocument(document, text, file.name));
  } else if (lower.endsWith(".html") || lower.endsWith(".htm") || file.type === "text/html") {
    renderParsedDocument(parseHtmlFileDocument(document, text, file.name));
  } else {
    renderParsedDocument(parsePlainTextDocument(document, text, file.name));
  }
}

async function openRemoteUrl(rawUrl: string, autoTranslate = false): Promise<void> {
  setStatus(`正在读取在线文档：${rawUrl}…`);
  const response = await sendRuntimeMessage<{
    ok?: boolean;
    bytes?: ArrayBuffer;
    contentType?: string;
    finalUrl?: string;
    error?: string;
  }>({ type: "fetch-document-bytes", url: rawUrl });

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
    await openPdfBytes(bytes, fileName, autoTranslate);
    return;
  }
  if (/\.epub$/i.test(pathname) || ct.includes("application/epub+zip")) {
    renderParsedDocument(await parseEpubDocument(document, response.bytes, fileName));
    if (autoTranslate) await runTranslation();
    return;
  }
  if (/\.docx$/i.test(pathname) || ct.includes("application/vnd.openxmlformats-officedocument.wordprocessingml.document")) {
    renderParsedDocument(await parseDocxDocument(document, response.bytes, fileName));
    if (autoTranslate) await runTranslation();
    return;
  }
  const text = new TextDecoder("utf-8").decode(bytes);
  if (ct.includes("text/html") || /\.html?$/i.test(pathname)) {
    renderParsedDocument(parseHtmlFileDocument(document, text, fileName));
  } else if (/\.md$|\.markdown$/i.test(pathname)) {
    renderParsedDocument(parseMarkdownDocument(document, text, fileName));
  } else {
    renderParsedDocument(parsePlainTextDocument(document, text, fileName));
  }
  if (autoTranslate) await runTranslation();
}

async function runTranslation(): Promise<void> {
  const scope = activeKind === "pdf" ? pdfTextPane : activeKind === "doc" ? docContentEl : null;
  if (!scope) return;

  translateBtn.disabled = true;
  translateBtn.textContent = "翻译中…";
  setStatus("正在翻译文档内容（公式、数值表格与代码块已自动保护）…");

  try {
    activeTranslator?.restore();
    const { translator, sourceLanguage, targetLanguage } = await createConfiguredTranslator(scope);
    activeTranslator = translator;
    const count = await translator.translateAll(scope, true);
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
    setStatus(error instanceof Error ? error.message : String(error));
  } finally {
    translateBtn.disabled = false;
    translateBtn.textContent = "翻译文档";
  }
}

function restoreOriginal(): void {
  activeTranslator?.restore();
  activeTranslator = null;
  isDocumentTranslated = false;
  clearAllPdfOverlays();
  hideOverlaySourceCard();
  restoreBtn.disabled = true;
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
  if (file) void openFile(file).catch((err) => setStatus(err instanceof Error ? err.message : String(err)));
  fileInputEl.value = "";
});

urlFormEl.addEventListener("submit", (e) => {
  e.preventDefault();
  const value = urlInputEl.value.trim();
  if (!value) return;
  void openRemoteUrl(value).catch((err) => setStatus(err instanceof Error ? err.message : String(err)));
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
          setStatus("已切换原位覆盖视图（公式、表格与图表像素原样保留，点击段落可查看原文）");
        } else {
          setStatus("已切换原位覆盖视图 · 点击「翻译文档」即可在原页覆盖译文（公式与图表原样保留）");
        }
      } else {
        clearAllPdfOverlays();
        setStatus("已切换双栏对照视图");
      }
    }
  });
}

ocrAllBtn.addEventListener("click", () => void runOcrForAllScannedPages());
translateBtn.addEventListener("click", () => void runTranslation());
restoreBtn.addEventListener("click", () => restoreOriginal());

zoomInBtn.addEventListener("click", () => {
  if (!activePdfBytes) return;
  const wasTranslated = isDocumentTranslated;
  activePdfScale = Math.min(1.6, Number((activePdfScale + 0.15).toFixed(2)));
  void openPdfBytes(activePdfBytes, docTitleEl.textContent || "PDF", wasTranslated);
});

zoomOutBtn.addEventListener("click", () => {
  if (!activePdfBytes) return;
  const wasTranslated = isDocumentTranslated;
  activePdfScale = Math.max(0.7, Number((activePdfScale - 0.15).toFixed(2)));
  void openPdfBytes(activePdfBytes, docTitleEl.textContent || "PDF", wasTranslated);
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
  if (file) void openFile(file).catch((err) => setStatus(err instanceof Error ? err.message : String(err)));
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
    await openRemoteUrl(targetUrl, true).catch((err) => {
      setStatus(err instanceof Error ? err.message : String(err));
    });
  }
}

void initReader();
