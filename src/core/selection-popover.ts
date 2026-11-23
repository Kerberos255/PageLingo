import { RuntimeMessageProvider } from "../providers/runtime-message-provider";
import {
  applyTerminologyCorrectionsHtml,
  escapeHtml,
  parseTerminology,
  protectTerminologyHtml,
  restoreTerminologyHtml,
  terminologyForText,
} from "./rich-segment";
import { parseHtmlBody } from "../shared/html-parser";
import { guessLanguageFromScript, isChineseTarget } from "../shared/mixed-language";
import { languageLabel, loadSettings, normalizeDetectedLanguage } from "../shared/settings";

const HOST_ATTR = "data-pagelingo-selection-ui";
const TRIGGER_ATTR = "data-pagelingo-selection-trigger";
const INLINE_INSERT_ATTR = "data-pagelingo-selection-inline";
const INLINE_TEXT_ATTR = "data-pagelingo-selection-inline-text";
const INLINE_CLOSE_ATTR = "data-pagelingo-selection-inline-close";
const INLINE_STYLE_ID = "pagelingo-selection-inline-style";
const SVG_NS = "http://www.w3.org/2000/svg";

const INLINE_BLOCK_CSS = `
[${INLINE_INSERT_ATTR}="true"] {
  position: relative !important;
  box-sizing: border-box !important;
  margin: 6px 0 10px !important;
  padding: 8px 34px 8px 12px !important;
  border-left: 3px solid #c64d32 !important;
  background: rgba(198, 77, 50, 0.065) !important;
  border-radius: 0 8px 8px 0 !important;
  font-size: 0.95em !important;
  line-height: 1.62 !important;
  white-space: pre-wrap !important;
  word-break: break-word !important;
  transition: background-color 160ms ease !important;
}
[${INLINE_INSERT_ATTR}="true"]:hover {
  background: rgba(198, 77, 50, 0.095) !important;
}
[${INLINE_TEXT_ATTR}="true"] {
  display: inline !important;
}
[${INLINE_CLOSE_ATTR}="true"] {
  all: initial !important;
  box-sizing: border-box !important;
  position: absolute !important;
  top: 6px !important;
  right: 6px !important;
  width: 22px !important;
  height: 22px !important;
  border-radius: 999px !important;
  display: inline-flex !important;
  align-items: center !important;
  justify-content: center !important;
  padding: 0 !important;
  margin: 0 !important;
  border: 0 !important;
  background: transparent !important;
  color: #b64b33 !important;
  opacity: 0.36 !important;
  cursor: pointer !important;
  user-select: none !important;
  -webkit-user-select: none !important;
  transition: opacity 150ms ease, background-color 150ms ease, transform 150ms ease !important;
}
[${INLINE_INSERT_ATTR}="true"]:hover [${INLINE_CLOSE_ATTR}="true"],
[${INLINE_INSERT_ATTR}="true"]:focus-within [${INLINE_CLOSE_ATTR}="true"] {
  opacity: 0.78 !important;
}
[${INLINE_CLOSE_ATTR}="true"]:hover,
[${INLINE_CLOSE_ATTR}="true"]:focus-visible {
  opacity: 1 !important;
  background: rgba(198, 77, 50, 0.16) !important;
  transform: scale(1.06) !important;
}
[${INLINE_CLOSE_ATTR}="true"]:focus-visible {
  outline: 1.5px solid rgba(198, 77, 50, 0.55) !important;
  outline-offset: 1px !important;
}
[${INLINE_CLOSE_ATTR}="true"]:active {
  transform: scale(0.94) !important;
}
[${INLINE_CLOSE_ATTR}="true"] svg {
  display: block !important;
  width: 11px !important;
  height: 11px !important;
  pointer-events: none !important;
}
@media (prefers-color-scheme: dark) {
  [${INLINE_INSERT_ATTR}="true"] {
    border-left-color: #e38b71 !important;
    background: rgba(227, 139, 113, 0.11) !important;
  }
  [${INLINE_INSERT_ATTR}="true"]:hover {
    background: rgba(227, 139, 113, 0.15) !important;
  }
  [${INLINE_CLOSE_ATTR}="true"] {
    color: #e38b71 !important;
  }
  [${INLINE_CLOSE_ATTR}="true"]:hover,
  [${INLINE_CLOSE_ATTR}="true"]:focus-visible {
    background: rgba(227, 139, 113, 0.22) !important;
  }
}
`;

interface SelectionAnchor {
  text: string;
  rect: { left: number; top: number; right: number; bottom: number; width: number; height: number };
  containerElement: HTMLElement | null;
}

const POPOVER_CSS = `
:host {
  all: initial;
  font-family: system-ui, -apple-system, "Segoe UI", "Noto Sans CJK SC", sans-serif;
  color-scheme: light dark;
}
.pl-card {
  box-sizing: border-box;
  width: min(380px, calc(100vw - 24px));
  max-height: min(340px, calc(100vh - 24px));
  display: flex;
  flex-direction: column;
  background: #ffffff;
  color: #18181b;
  border: 1px solid rgba(24, 24, 27, 0.14);
  border-radius: 12px;
  box-shadow: 0 14px 36px rgba(15, 23, 42, 0.18), 0 2px 8px rgba(15, 23, 42, 0.08);
  overflow: hidden;
  font-size: 13px;
  line-height: 1.55;
}
.pl-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 12px;
  background: #f8f7f5;
  border-bottom: 1px solid rgba(24, 24, 27, 0.08);
}
.pl-head-left {
  display: flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
}
.pl-badge {
  display: inline-flex;
  align-items: center;
  padding: 1px 7px;
  border-radius: 999px;
  background: rgba(182, 75, 51, 0.12);
  color: #a63d26;
  font-size: 11px;
  font-weight: 650;
  white-space: nowrap;
}
.pl-lang {
  font-size: 11.5px;
  color: #64748b;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pl-close {
  border: 0;
  background: transparent;
  color: #71717a;
  width: 24px;
  height: 24px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 16px;
  line-height: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.pl-close:hover {
  background: rgba(24, 24, 27, 0.07);
  color: #18181b;
}
.pl-body {
  padding: 11px 13px;
  overflow-y: auto;
  flex: 1 1 auto;
}
.pl-source {
  font-size: 12px;
  color: #64748b;
  margin-bottom: 8px;
  padding-bottom: 8px;
  border-bottom: 1px dashed rgba(24, 24, 27, 0.10);
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 76px;
  overflow-y: auto;
}
.pl-result {
  font-size: 13.5px;
  color: #0f172a;
  white-space: pre-wrap;
  word-break: break-word;
  user-select: text;
}
.pl-result.is-loading {
  color: #64748b;
}
.pl-result.is-error {
  color: #c94a38;
}
.pl-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 7px 11px;
  border-top: 1px solid rgba(24, 24, 27, 0.08);
  background: #fbfaf9;
}
.pl-actions {
  display: flex;
  align-items: center;
  gap: 6px;
}
.pl-btn {
  border: 1px solid rgba(24, 24, 27, 0.14);
  background: #ffffff;
  color: #27272a;
  border-radius: 6px;
  padding: 4px 9px;
  font-size: 11.5px;
  font-weight: 550;
  cursor: pointer;
  line-height: 1.25;
}
.pl-btn:hover:not(:disabled) {
  background: #f4f4f5;
  border-color: rgba(24, 24, 27, 0.24);
}
.pl-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.pl-btn.primary {
  background: #b64b33;
  border-color: #b64b33;
  color: #ffffff;
}
.pl-btn.primary:hover:not(:disabled) {
  filter: brightness(0.94);
}
.pl-trigger {
  all: initial;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 9px;
  border-radius: 999px;
  background: #b64b33;
  color: #ffffff;
  font-family: system-ui, -apple-system, "Segoe UI", "Noto Sans CJK SC", sans-serif;
  font-size: 11.5px;
  font-weight: 650;
  box-shadow: 0 6px 18px rgba(15, 23, 42, 0.22);
  cursor: pointer;
  border: 1px solid rgba(255, 255, 255, 0.24);
}
.pl-trigger:hover {
  filter: brightness(1.06);
}
@media (prefers-color-scheme: dark) {
  .pl-card {
    background: #1c1c1e;
    color: #f4f4f5;
    border-color: rgba(255, 255, 255, 0.14);
    box-shadow: 0 16px 40px rgba(0, 0, 0, 0.48);
  }
  .pl-head {
    background: #242427;
    border-bottom-color: rgba(255, 255, 255, 0.10);
  }
  .pl-badge {
    background: rgba(227, 139, 113, 0.18);
    color: #f2a088;
  }
  .pl-lang, .pl-source, .pl-result.is-loading {
    color: #a1a1aa;
  }
  .pl-source {
    border-bottom-color: rgba(255, 255, 255, 0.10);
  }
  .pl-result {
    color: #f4f4f5;
  }
  .pl-result.is-error {
    color: #f28b7d;
  }
  .pl-close {
    color: #a1a1aa;
  }
  .pl-close:hover {
    background: rgba(255, 255, 255, 0.10);
    color: #ffffff;
  }
  .pl-foot {
    background: #222225;
    border-top-color: rgba(255, 255, 255, 0.10);
  }
  .pl-btn {
    background: #2c2c30;
    border-color: rgba(255, 255, 255, 0.14);
    color: #e4e4e7;
  }
  .pl-btn:hover:not(:disabled) {
    background: #36363b;
  }
  .pl-btn.primary {
    background: #e38b71;
    border-color: #e38b71;
    color: #18181b;
  }
}
`;

function enclosingBlock(node: Node | null): HTMLElement | null {
  let el = node instanceof HTMLElement ? node : node?.parentElement ?? null;
  while (el && el !== document.body && el !== document.documentElement) {
    const tag = el.tagName;
    if (["P", "DIV", "LI", "BLOCKQUOTE", "TD", "TH", "ARTICLE", "SECTION", "H1", "H2", "H3", "H4", "H5", "H6"].includes(tag)) {
      return el;
    }
    el = el.parentElement;
  }
  return null;
}

export function captureActiveSelection(fallbackText?: string): SelectionAnchor | null {
  const selection = window.getSelection?.();
  const selectedText = (selection?.toString() ?? "").trim() || (fallbackText ?? "").trim();
  if (!selectedText) return null;

  let rect = { left: Math.round(window.innerWidth / 2 - 160), top: 96, right: Math.round(window.innerWidth / 2 + 160), bottom: 120, width: 320, height: 24 };
  let containerElement: HTMLElement | null = null;

  if (selection && selection.rangeCount > 0) {
    const range = selection.getRangeAt(0);
    const bounding = range.getBoundingClientRect();
    if (bounding.width > 0 || bounding.height > 0) {
      rect = {
        left: bounding.left,
        top: bounding.top,
        right: bounding.right,
        bottom: bounding.bottom,
        width: bounding.width,
        height: bounding.height,
      };
    }
    containerElement = enclosingBlock(range.commonAncestorContainer);
  }
  return { text: selectedText, rect, containerElement };
}

export async function resolveSelectionLanguages(
  text: string,
  preferredTarget: string,
): Promise<{ sourceLanguage: string; targetLanguage: string }> {
  const normalizedPreferred = normalizeDetectedLanguage(preferredTarget) ?? "zh-Hans";
  let detected: string | null = null;
  try {
    const result = await browser.i18n?.detectLanguage?.(text.slice(0, 2048));
    const top = result?.languages?.[0];
    if (top?.language && top.language !== "und") {
      detected = normalizeDetectedLanguage(top.language);
    }
  } catch {
    // Fall back to script heuristics.
  }
  if (!detected) detected = guessLanguageFromScript(text) ?? "en";

  let targetLanguage = normalizedPreferred;
  if (detected === targetLanguage || (isChineseTarget(detected) && isChineseTarget(targetLanguage))) {
    targetLanguage = isChineseTarget(detected) ? "en" : "zh-Hans";
  }
  return { sourceLanguage: detected, targetLanguage };
}

export class SelectionTranslatorController {
  private popoverHost: HTMLDivElement | null = null;
  private triggerHost: HTMLDivElement | null = null;
  private activeSeq = 0;
  private quickButtonEnabled = false;
  private mouseUpTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly provider = new RuntimeMessageProvider();

  constructor(private readonly doc: Document = document) {}

  setQuickButtonEnabled(enabled: boolean): void {
    this.quickButtonEnabled = enabled;
    if (!enabled) this.hideTrigger();
  }

  attach(): void {
    this.doc.addEventListener("keydown", this.onKeyDown, true);
    this.doc.addEventListener("mousedown", this.onMouseDown, true);
    this.doc.addEventListener("mouseup", this.onMouseUp, false);
  }

  destroy(): void {
    this.doc.removeEventListener("keydown", this.onKeyDown, true);
    this.doc.removeEventListener("mousedown", this.onMouseDown, true);
    this.doc.removeEventListener("mouseup", this.onMouseUp, false);
    this.closePopover();
    this.hideTrigger();
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "Escape") {
      this.closePopover();
      this.hideTrigger();
    }
  };

  private readonly onMouseDown = (event: MouseEvent): void => {
    const path = event.composedPath?.() ?? [];
    if (this.popoverHost && !path.includes(this.popoverHost)) {
      this.closePopover();
    }
    if (this.triggerHost && !path.includes(this.triggerHost)) {
      this.hideTrigger();
    }
  };

  private readonly onMouseUp = (event: MouseEvent): void => {
    if (!this.quickButtonEnabled) return;
    const path = event.composedPath?.() ?? [];
    if ((this.popoverHost && path.includes(this.popoverHost)) || (this.triggerHost && path.includes(this.triggerHost))) {
      return;
    }
    const target = event.target as HTMLElement | null;
    if (target?.closest?.("input, textarea, [contenteditable='true']")) return;
    if (this.mouseUpTimer) clearTimeout(this.mouseUpTimer);
    this.mouseUpTimer = setTimeout(() => {
      const anchor = captureActiveSelection();
      if (!anchor || anchor.text.length < 2) {
        this.hideTrigger();
        return;
      }
      this.showTrigger(anchor);
    }, 120);
  };

  private hideTrigger(): void {
    this.triggerHost?.remove();
    this.triggerHost = null;
  }

  closePopover(): void {
    this.activeSeq += 1;
    this.popoverHost?.remove();
    this.popoverHost = null;
  }

  private showTrigger(anchor: SelectionAnchor): void {
    this.hideTrigger();
    const host = this.doc.createElement("div");
    host.setAttribute(TRIGGER_ATTR, "true");
    host.dataset.fltGenerated = "selection-trigger";
    const left = Math.max(8, Math.min(window.innerWidth - 88, anchor.rect.right - 24));
    const top = Math.max(8, Math.min(window.innerHeight - 36, anchor.rect.bottom + 6));
    host.style.cssText = `position:fixed!important;left:${Math.round(left)}px!important;top:${Math.round(top)}px!important;z-index:2147483647!important;margin:0!important;padding:0!important;`;
    const shadow = host.attachShadow({ mode: "open" });
    const style = this.doc.createElement("style");
    style.textContent = POPOVER_CSS;
    const btn = this.doc.createElement("button");
    btn.type = "button";
    btn.className = "pl-trigger";
    btn.textContent = "译 · 翻译";
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.hideTrigger();
      void this.translateSelection(anchor.text, anchor);
    });
    shadow.append(style, btn);
    (this.doc.body ?? this.doc.documentElement).append(host);
    this.triggerHost = host;
  }

  async translateSelection(fallbackText?: string, preCaptured?: SelectionAnchor | null): Promise<void> {
    this.hideTrigger();
    const anchor = preCaptured ?? captureActiveSelection(fallbackText);
    if (!anchor) return;

    this.closePopover();
    const seq = ++this.activeSeq;

    const host = this.doc.createElement("div");
    host.setAttribute(HOST_ATTR, "true");
    host.dataset.fltGenerated = "selection-popover";
    const cardW = Math.min(380, window.innerWidth - 24);
    const left = Math.max(12, Math.min(window.innerWidth - cardW - 12, anchor.rect.left));
    const preferBelow = anchor.rect.bottom + 220 <= window.innerHeight;
    const top = preferBelow
      ? Math.max(12, anchor.rect.bottom + 8)
      : Math.max(12, anchor.rect.top - 190);
    host.style.cssText = `position:fixed!important;left:${Math.round(left)}px!important;top:${Math.round(top)}px!important;z-index:2147483647!important;margin:0!important;padding:0!important;`;

    const shadow = host.attachShadow({ mode: "open" });
    const style = this.doc.createElement("style");
    style.textContent = POPOVER_CSS;

    const card = this.doc.createElement("div");
    card.className = "pl-card";
    card.setAttribute("role", "dialog");
    card.setAttribute("aria-label", "PageLingo 划词翻译");

    const head = this.doc.createElement("div");
    head.className = "pl-head";
    const headLeft = this.doc.createElement("div");
    headLeft.className = "pl-head-left";
    const badge = this.doc.createElement("span");
    badge.className = "pl-badge";
    badge.textContent = "PageLingo";
    const langEl = this.doc.createElement("span");
    langEl.className = "pl-lang";
    langEl.textContent = "正在识别语言…";
    headLeft.append(badge, langEl);

    const closeBtn = this.doc.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "pl-close";
    closeBtn.setAttribute("aria-label", "关闭");
    closeBtn.textContent = "×";
    closeBtn.addEventListener("click", () => this.closePopover());
    head.append(headLeft, closeBtn);

    const body = this.doc.createElement("div");
    body.className = "pl-body";
    const sourceEl = this.doc.createElement("div");
    sourceEl.className = "pl-source";
    sourceEl.textContent = anchor.text;
    const resultEl = this.doc.createElement("div");
    resultEl.className = "pl-result is-loading";
    resultEl.textContent = "正在翻译…";
    body.append(sourceEl, resultEl);

    const foot = this.doc.createElement("div");
    foot.className = "pl-foot";
    const leftActions = this.doc.createElement("div");
    leftActions.className = "pl-actions";
    const retranslateBtn = this.doc.createElement("button");
    retranslateBtn.type = "button";
    retranslateBtn.className = "pl-btn";
    retranslateBtn.textContent = "重译";
    retranslateBtn.disabled = true;

    const insertBtn = this.doc.createElement("button");
    insertBtn.type = "button";
    insertBtn.className = "pl-btn";
    insertBtn.textContent = "就地插入";
    insertBtn.disabled = true;
    if (!anchor.containerElement) insertBtn.hidden = true;
    leftActions.append(retranslateBtn, insertBtn);

    const copyBtn = this.doc.createElement("button");
    copyBtn.type = "button";
    copyBtn.className = "pl-btn primary";
    copyBtn.textContent = "复制";
    copyBtn.disabled = true;

    foot.append(leftActions, copyBtn);
    card.append(head, body, foot);
    shadow.append(style, card);
    (this.doc.body ?? this.doc.documentElement).append(host);
    this.popoverHost = host;

    let latestTranslation = "";
    let activeInsertedEl: HTMLElement | null = null;
    let insertedTranslation = "";

    const syncInsertButton = (): void => {
      if (activeInsertedEl && !activeInsertedEl.isConnected) {
        activeInsertedEl = null;
        insertedTranslation = "";
      }
      if (!anchor.containerElement) {
        insertBtn.hidden = true;
        return;
      }
      if (activeInsertedEl) {
        insertBtn.textContent = insertedTranslation === latestTranslation || !latestTranslation
          ? "移除插入"
          : "更新插入";
        insertBtn.disabled = false;
      } else {
        insertBtn.textContent = "就地插入";
        insertBtn.disabled = !latestTranslation;
      }
    };

    const run = async (bypassCache: boolean): Promise<void> => {
      resultEl.className = "pl-result is-loading";
      resultEl.textContent = bypassCache ? "正在重新翻译…" : "正在翻译…";
      copyBtn.disabled = true;
      retranslateBtn.disabled = true;
      insertBtn.disabled = true;
      try {
        const settings = await loadSettings();
        const { sourceLanguage, targetLanguage } = await resolveSelectionLanguages(anchor.text, settings.targetLanguage);
        if (seq !== this.activeSeq) return;
        langEl.textContent = `${languageLabel(sourceLanguage)} → ${languageLabel(targetLanguage)}`;

        const terminology = parseTerminology(
          settings.glossaryCollections,
          sourceLanguage,
          targetLanguage,
          settings.builtinGlossaryEnabled,
        );
        const lines = anchor.text.replace(/\r\n?/g, "\n").split("\n");
        const translatedLines = await Promise.all(lines.map(async (line) => {
          if (!line.trim()) return "";
          const protectedLine = protectTerminologyHtml(this.doc, escapeHtml(line), terminology);
          let html = await this.provider.translateHtml({
            html: protectedLine.html,
            sourceLanguage,
            targetLanguage,
            terminology: terminologyForText(terminology, line),
            ...(bypassCache ? { bypassCache: true } : {}),
          });
          html = restoreTerminologyHtml(this.doc, html, protectedLine.replacements);
          html = applyTerminologyCorrectionsHtml(this.doc, html, line, terminology);
          return parseHtmlBody(html).textContent ?? line;
        }));
        if (seq !== this.activeSeq) return;
        latestTranslation = translatedLines.join("\n").trim();
        resultEl.className = "pl-result";
        resultEl.textContent = latestTranslation || anchor.text;
        copyBtn.disabled = !latestTranslation;
        retranslateBtn.disabled = false;
        syncInsertButton();
      } catch (error) {
        if (seq !== this.activeSeq) return;
        resultEl.className = "pl-result is-error";
        resultEl.textContent = error instanceof Error ? error.message : String(error);
        retranslateBtn.disabled = false;
        syncInsertButton();
      }
    };

    retranslateBtn.addEventListener("click", () => {
      void run(true);
    });

    copyBtn.addEventListener("click", () => {
      if (!latestTranslation || !navigator.clipboard?.writeText) return;
      void navigator.clipboard.writeText(latestTranslation).then(() => {
        copyBtn.textContent = "已复制";
        setTimeout(() => { copyBtn.textContent = "复制"; }, 1400);
      });
    });

    insertBtn.addEventListener("click", () => {
      if (activeInsertedEl && !activeInsertedEl.isConnected) {
        activeInsertedEl = null;
        insertedTranslation = "";
      }
      if (activeInsertedEl && (insertedTranslation === latestTranslation || !latestTranslation)) {
        activeInsertedEl.remove();
        activeInsertedEl = null;
        insertedTranslation = "";
        syncInsertButton();
        return;
      }
      if (!latestTranslation || !anchor.containerElement?.parentElement) return;
      this.ensureInlineBlockStyle(anchor.containerElement);
      const existing = anchor.containerElement.nextElementSibling;
      let insertedEl: HTMLElement;
      if (existing instanceof HTMLElement && existing.getAttribute(INLINE_INSERT_ATTR) === "true") {
        this.populateInlineBlock(existing, latestTranslation, () => {
          if (activeInsertedEl === existing) {
            activeInsertedEl = null;
            insertedTranslation = "";
            syncInsertButton();
          }
        });
        insertedEl = existing;
      } else {
        const block = this.doc.createElement("div");
        block.setAttribute(INLINE_INSERT_ATTR, "true");
        block.dataset.fltGenerated = "translation";
        this.populateInlineBlock(block, latestTranslation, () => {
          if (activeInsertedEl === block) {
            activeInsertedEl = null;
            insertedTranslation = "";
            syncInsertButton();
          }
        });
        anchor.containerElement.insertAdjacentElement("afterend", block);
        insertedEl = block;
      }
      activeInsertedEl = insertedEl;
      insertedTranslation = latestTranslation;
      // Shift popover cleanly below the newly inserted translation so it never covers it
      if (this.popoverHost) {
        const insertedRect = insertedEl.getBoundingClientRect();
        if (insertedRect.width > 0 && insertedRect.height > 0) {
          const nextTop = Math.min(Math.max(12, window.innerHeight - 200), insertedRect.bottom + 8);
          this.popoverHost.style.setProperty("top", `${Math.round(nextTop)}px`, "important");
        }
      }
      syncInsertButton();
    });

    await run(false);
  }

  private ensureInlineBlockStyle(target: Element): void {
    const rootNode = target.getRootNode?.();
    if (rootNode && rootNode !== this.doc && rootNode.nodeType === Node.DOCUMENT_FRAGMENT_NODE && "host" in rootNode) {
      const shadowRoot = rootNode as ShadowRoot;
      if (shadowRoot.querySelector(`style[data-pagelingo-inline-style="true"]`)) return;
      const style = this.doc.createElement("style");
      style.dataset.fltGenerated = "style";
      style.dataset.pagelingoInlineStyle = "true";
      style.textContent = INLINE_BLOCK_CSS;
      shadowRoot.append(style);
      return;
    }
    if (this.doc.getElementById(INLINE_STYLE_ID)) return;
    const style = this.doc.createElement("style");
    style.id = INLINE_STYLE_ID;
    style.dataset.fltGenerated = "style";
    style.textContent = INLINE_BLOCK_CSS;
    (this.doc.head ?? this.doc.documentElement).append(style);
  }

  private populateInlineBlock(block: HTMLElement, text: string, onRemoved: () => void): void {
    let textSpan = block.querySelector<HTMLElement>(`:scope > [${INLINE_TEXT_ATTR}="true"]`);
    let closeBtn = block.querySelector<HTMLButtonElement>(`:scope > [${INLINE_CLOSE_ATTR}="true"]`);
    if (!textSpan || !closeBtn) {
      block.replaceChildren();
      textSpan = this.doc.createElement("span");
      textSpan.setAttribute(INLINE_TEXT_ATTR, "true");
      closeBtn = this.doc.createElement("button");
      closeBtn.type = "button";
      closeBtn.setAttribute(INLINE_CLOSE_ATTR, "true");
      closeBtn.setAttribute("aria-label", "移除插入译文");
      closeBtn.title = "移除译文";
      const svg = this.doc.createElementNS(SVG_NS, "svg");
      svg.setAttribute("viewBox", "0 0 12 12");
      svg.setAttribute("width", "11");
      svg.setAttribute("height", "11");
      svg.setAttribute("fill", "none");
      svg.setAttribute("aria-hidden", "true");
      const path = this.doc.createElementNS(SVG_NS, "path");
      path.setAttribute("d", "M3 3L9 9M9 3L3 9");
      path.setAttribute("stroke", "currentColor");
      path.setAttribute("stroke-width", "1.6");
      path.setAttribute("stroke-linecap", "round");
      svg.append(path);
      closeBtn.append(svg);
      block.append(textSpan, closeBtn);
    }
    textSpan.textContent = text;
    closeBtn.onclick = (event) => {
      event.preventDefault();
      event.stopPropagation();
      block.remove();
      onRemoved();
    };
  }
}
