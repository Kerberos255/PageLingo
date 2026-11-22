// Settings controller for webpage bilingual styling (order, learning mode, theme, scale, color) and live preview.

import {
  DEFAULT_BILINGUAL_STYLE,
  loadSettings,
  normalizeBilingualStyle,
  normalizeDisplayMode,
  saveBilingualStyle,
  type BilingualOrder,
  type BilingualStyleSettings,
  type BilingualTheme,
  type DisplayMode,
} from "./shared/settings";

const BILINGUAL_COLOR_LABELS: Record<string, string> = {
  inherit: "跟随页面",
  "#2563eb": "柔和蓝",
  "#b45309": "暖琥珀",
  "#0f766e": "翡翠绿",
  "#6b7280": "淡灰",
};

const orderRadios = Array.from(document.querySelectorAll<HTMLInputElement>('input[name="bilingual-order"]'));
const learningModeToggle = document.querySelector<HTMLInputElement>("#bilingual-learning-mode");
const themeRadios = Array.from(document.querySelectorAll<HTMLInputElement>('input[name="bilingual-theme"]'));
const fontScaleInput = document.querySelector<HTMLInputElement>("#bilingual-font-scale");
const fontScaleValue = document.querySelector<HTMLOutputElement>("#bilingual-font-scale-value");
const colorLabel = document.querySelector<HTMLElement>("#bilingual-color-label");
const colorSwatches = Array.from(document.querySelectorAll<HTMLButtonElement>(".bilingual-swatch[data-bilingual-color]"));
const resetStyleButton = document.querySelector<HTMLButtonElement>("#bilingual-reset-style");

const previewChip = document.querySelector<HTMLElement>("#bilingual-preview-chip");
const previewHint = document.querySelector<HTMLElement>("#bilingual-preview-hint");
const previewArticle = document.querySelector<HTMLElement>("#bilingual-preview-article");
const previewPairs = Array.from(document.querySelectorAll<HTMLElement>(".bilingual-preview-pair"));
const previewTranslations = Array.from(document.querySelectorAll<HTMLElement>("[data-preview-translation]"));
const saveStatus = document.querySelector<HTMLElement>("#save-status");

let currentStyle: BilingualStyleSettings = { ...DEFAULT_BILINGUAL_STYLE };
let webpageDisplayMode: DisplayMode = "translation";
let saveDebounceTimer: ReturnType<typeof setTimeout> | null = null;

function notify(message: string, timeout = 1600): void {
  if (!saveStatus) return;
  saveStatus.textContent = message;
  window.setTimeout(() => {
    if (saveStatus.textContent === message) saveStatus.textContent = "";
  }, timeout);
}

function renderPreview(): void {
  if (!previewArticle) return;
  previewArticle.dataset.theme = currentStyle.theme;
  previewArticle.dataset.learning = currentStyle.learningMode ? "true" : "false";
  previewArticle.style.setProperty("--pl-bi-scale", (currentStyle.fontScale / 100).toFixed(2));
  if (currentStyle.translationColor === "inherit") {
    previewArticle.style.removeProperty("--pl-bi-color");
  } else {
    previewArticle.style.setProperty("--pl-bi-color", currentStyle.translationColor);
  }

  for (const pair of previewPairs) {
    pair.dataset.order = currentStyle.order;
  }
  if (!currentStyle.learningMode) {
    for (const node of previewTranslations) {
      node.removeAttribute("data-revealed");
    }
  }

  if (previewChip) {
    previewChip.textContent = currentStyle.learningMode
      ? "实时预览 · 学习模式（悬停或点击译文查看）"
      : "实时预览 · 双语对照";
  }
  if (previewHint) {
    previewHint.hidden = webpageDisplayMode === "bilingual";
  }
}

function syncControlsFromState(): void {
  for (const radio of orderRadios) {
    radio.checked = radio.value === currentStyle.order;
  }
  if (learningModeToggle) {
    learningModeToggle.checked = currentStyle.learningMode;
  }
  for (const radio of themeRadios) {
    radio.checked = radio.value === currentStyle.theme;
  }
  if (fontScaleInput) fontScaleInput.value = String(currentStyle.fontScale);
  if (fontScaleValue) fontScaleValue.textContent = `${currentStyle.fontScale}%`;

  const colorKey = currentStyle.translationColor.toLowerCase();
  if (colorLabel) colorLabel.textContent = BILINGUAL_COLOR_LABELS[colorKey] ?? colorKey;
  for (const swatch of colorSwatches) {
    const active = swatch.dataset.bilingualColor?.toLowerCase() === colorKey;
    swatch.classList.toggle("active", active);
    swatch.setAttribute("aria-checked", active ? "true" : "false");
  }

  renderPreview();
}

async function persistPatch(patch: Partial<BilingualStyleSettings>, message = "双语样式已保存"): Promise<void> {
  currentStyle = await saveBilingualStyle(patch);
  syncControlsFromState();
  if (message) notify(message);
}

function scheduleScalePersist(fontScale: number): void {
  currentStyle = normalizeBilingualStyle({ ...currentStyle, fontScale });
  syncControlsFromState();
  if (saveDebounceTimer) clearTimeout(saveDebounceTimer);
  saveDebounceTimer = setTimeout(() => {
    saveDebounceTimer = null;
    void saveBilingualStyle(currentStyle).then((saved) => {
      currentStyle = saved;
      notify("双语样式已保存", 1400);
    });
  }, 200);
}

export async function initializeBilingualStyleSettings(): Promise<void> {
  if (!previewArticle && !learningModeToggle) return;

  const settings = await loadSettings();
  webpageDisplayMode = settings.displayMode;
  currentStyle = { ...settings.bilingualStyle };
  syncControlsFromState();

  for (const radio of orderRadios) {
    radio.addEventListener("change", () => {
      if (!radio.checked) return;
      const order: BilingualOrder = radio.value === "translation-top" ? "translation-top" : "source-top";
      void persistPatch({ order });
    });
  }

  learningModeToggle?.addEventListener("change", () => {
    void persistPatch({ learningMode: learningModeToggle.checked });
  });

  for (const radio of themeRadios) {
    radio.addEventListener("change", () => {
      if (!radio.checked) return;
      const value = radio.value;
      const theme: BilingualTheme =
        value === "muted" || value === "border-left" || value === "highlight" || value === "underline"
          ? value
          : "inherit";
      void persistPatch({ theme });
    });
  }

  fontScaleInput?.addEventListener("input", () => {
    scheduleScalePersist(Number.parseInt(fontScaleInput.value, 10));
  });

  for (const swatch of colorSwatches) {
    swatch.addEventListener("click", () => {
      const color = swatch.dataset.bilingualColor;
      if (!color) return;
      void persistPatch({ translationColor: color });
    });
  }

  resetStyleButton?.addEventListener("click", () => {
    void persistPatch({ ...DEFAULT_BILINGUAL_STYLE }, "已恢复默认双语样式");
  });

  previewArticle?.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (target.closest("a")) {
      event.preventDefault();
      return;
    }
    if (!currentStyle.learningMode) return;
    const translation = target.closest<HTMLElement>("[data-preview-translation]");
    if (!translation) return;
    const revealed = translation.dataset.revealed === "true";
    if (revealed) translation.removeAttribute("data-revealed");
    else translation.dataset.revealed = "true";
  });

  for (const radio of Array.from(document.querySelectorAll<HTMLInputElement>('input[name="display-mode"]'))) {
    radio.addEventListener("change", () => {
      if (!radio.checked) return;
      webpageDisplayMode = normalizeDisplayMode(radio.value);
      renderPreview();
    });
  }

  if (typeof browser !== "undefined" && browser.storage?.onChanged) {
    browser.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== "local") return;
      if (changes.displayMode) {
        webpageDisplayMode = normalizeDisplayMode(changes.displayMode.newValue);
        renderPreview();
      }
      if (changes.bilingualStyle) {
        currentStyle = normalizeBilingualStyle(changes.bilingualStyle.newValue);
        syncControlsFromState();
      }
    });
  }
}
