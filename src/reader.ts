import * as pdfjsLib from "pdfjs-dist";
import { PageTranslator } from "./core/page-translator";
import { buildBilingualRulesCss } from "./core/bilingual-style";
import { parseTerminology } from "./core/rich-segment";
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
import { extractPdfPageBlocks, type PdfFontStyleInfo, type PdfLayoutBlock, type PdfRawTextItem } from "./reader/pdf-layout";

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

let activeKind: "none" | "pdf" | "doc" = "none";
let activeDisplayMode: DisplayMode = "bilingual";
let activeTranslator: PageTranslator | null = null;
let activePdfBytes: Uint8Array | null = null;
let activePdfScale = 1.0;
let activeBlockId = "";

interface LanguageOption { code: string; label: string }
interface CatalogResponse {
  ok?: boolean;
  catalog?: { sourceLanguages: LanguageOption[]; targetLanguages: LanguageOption[] };
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
  if (scrollTarget === "canvas" && hitBox) {
    hitBox.scrollIntoView({ behavior: "smooth", block: "center" });
  } else if (scrollTarget === "text" && textCard) {
    textCard.scrollIntoView({ behavior: "smooth", block: "center" });
  }
}

function renderPdfBlockElement(block: PdfLayoutBlock): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "pdf-block-wrap";
  wrap.dataset.blockId = block.id;
  wrap.addEventListener("click", () => highlightSyncedBlock(block.id, "canvas"));

  if (block.kind === "formula") {
    const formula = document.createElement("div");
    formula.className = "reader-formula";
    formula.setAttribute("translate", "no");
    formula.textContent = block.plainText;
    wrap.append(formula);
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

  for (const seg of block.segments) {
    if (seg.kind === "math") {
      const mathCode = document.createElement("code");
      mathCode.className = "reader-inline-math";
      mathCode.setAttribute("translate", "no");
      mathCode.setAttribute("data-flt-fixed", "formula");
      mathCode.textContent = seg.text;
      el.append(mathCode);
    } else {
      el.append(document.createTextNode(seg.text));
    }
  }

  wrap.append(el);
  return wrap;
}

function clearActiveDocument(): void {
  activeTranslator?.restore();
  activeTranslator = null;
  activeBlockId = "";
  pdfCanvasPane.replaceChildren();
  pdfTextPane.replaceChildren();
  docTocList.replaceChildren();
  docContentEl.replaceChildren();
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
  const dpr = Math.min(2, window.devicePixelRatio || 1);

  for (let pageNum = 1; pageNum <= maxPages; pageNum += 1) {
    setStatus(`正在渲染并提取第 ${pageNum}/${maxPages} 页…`);
    const page = await pdf.getPage(pageNum);
    const baseViewport = page.getViewport({ scale: 1.0 });
    const targetCssWidth = Math.max(420, Math.min(720, (pdfCanvasPane.clientWidth || 600) - 44)) * activePdfScale;
    const renderScale = targetCssWidth / baseViewport.width;
    const viewport = page.getViewport({ scale: renderScale });

    // Left pane: original PDF canvas + interactive hit overlay
    const shell = document.createElement("div");
    shell.className = "pdf-page-shell";
    shell.style.width = `${Math.round(viewport.width)}px`;
    shell.style.height = `${Math.round(viewport.height)}px`;

    const canvas = document.createElement("canvas");
    canvas.width = Math.round(viewport.width * dpr);
    canvas.height = Math.round(viewport.height * dpr);
    canvas.style.width = `${Math.round(viewport.width)}px`;
    canvas.style.height = `${Math.round(viewport.height)}px`;
    const ctx = canvas.getContext("2d")!;
    ctx.scale(dpr, dpr);
    await page.render({ canvasContext: ctx, viewport, canvas }).promise;

    const badge = document.createElement("span");
    badge.className = "pdf-page-badge";
    badge.textContent = `${pageNum} / ${totalPages}`;

    const hitLayer = document.createElement("div");
    hitLayer.className = "pdf-hit-layer";

    shell.append(canvas, hitLayer, badge);
    pdfCanvasPane.append(shell);

    // Extract layout-preserving & formula-protected blocks
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
    const blocks = extractPdfPageBlocks(
      rawItems,
      textContent.styles as Record<string, PdfFontStyleInfo>,
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
    const pageStats = document.createElement("span");
    const pageFormulas = blocks.filter((b) => b.kind === "formula" || b.segments.some((s) => s.kind === "math")).length;
    pageStats.textContent = pageFormulas > 0 ? `${blocks.length} 段 · 保护 ${pageFormulas} 处公式` : `${blocks.length} 段`;
    pageHead.append(pageLabel, pageStats);
    pageCard.append(pageHead);

    for (const block of blocks) {
      totalBlocks += 1;
      if (block.kind === "formula") totalFormulas += 1;
      else totalFormulas += block.segments.filter((s) => s.kind === "math").length;

      const hit = document.createElement("div");
      hit.className = "pdf-hit-box";
      hit.dataset.blockId = block.id;
      hit.style.left = `${Math.max(0, block.box.x * renderScale - 2)}px`;
      hit.style.top = `${Math.max(0, block.box.y * renderScale - 2)}px`;
      hit.style.width = `${Math.max(8, block.box.width * renderScale + 4)}px`;
      hit.style.height = `${Math.max(8, block.box.height * renderScale + 4)}px`;
      hit.addEventListener("click", () => highlightSyncedBlock(block.id, "text"));
      hitLayer.append(hit);

      pageCard.append(renderPdfBlockElement(block));
    }

    if (blocks.length === 0) {
      const emptyNote = document.createElement("p");
      emptyNote.style.color = "var(--muted)";
      emptyNote.textContent = "本页未检出可选文字（可能为纯扫描图像页）。";
      pageCard.append(emptyNote);
    }

    pdfTextPane.append(pageCard);
  }

  translateBtn.disabled = false;
  restoreBtn.disabled = true;
  const pageHint = totalPages > maxPages ? `（已载入前 ${maxPages}/${totalPages} 页）` : `（共 ${totalPages} 页）`;
  setStatus(`已载入 PDF ${pageHint} · ${totalBlocks} 个文本块${totalFormulas > 0 ? ` · 已识别并保护 ${totalFormulas} 处公式` : ""}`);

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
  setStatus("正在翻译文档内容（公式与代码块已自动保护）…");

  try {
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

    activeTranslator?.restore();
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
        if (root.closest(".reader-formula, pre, .pdf-text-page-head")) return false;
        const text = (root.textContent ?? "").replace(/\s+/g, " ").trim();
        if (!text || fragmentAlreadyInTargetScript(text, targetLanguage)) return false;
        return true;
      },
    });
    activeTranslator = translator;
    const count = await translator.translateAll(scope, true);
    restoreBtn.disabled = count === 0;
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
  restoreBtn.disabled = true;
  setStatus("已恢复文档原文");
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
  });
}

translateBtn.addEventListener("click", () => void runTranslation());
restoreBtn.addEventListener("click", () => restoreOriginal());

zoomInBtn.addEventListener("click", () => {
  if (!activePdfBytes) return;
  activePdfScale = Math.min(1.6, Number((activePdfScale + 0.15).toFixed(2)));
  void openPdfBytes(activePdfBytes, docTitleEl.textContent || "PDF");
});

zoomOutBtn.addEventListener("click", () => {
  if (!activePdfBytes) return;
  activePdfScale = Math.max(0.7, Number((activePdfScale - 0.15).toFixed(2)));
  void openPdfBytes(activePdfBytes, docTitleEl.textContent || "PDF");
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
