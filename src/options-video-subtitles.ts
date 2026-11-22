// Settings controller for the Video Subtitle section, including live style preview and engine selection.

import { requestExternalTranslationConsent } from "./shared/data-consent";
import { sendRuntimeMessage } from "./shared/runtime-message";
import {
  DEFAULT_VIDEO_SUBTITLE_SETTINGS,
  loadSettings,
  saveVideoSubtitleSettings,
  type DisplayMode,
  type VideoSubtitleDisplayMode,
  type VideoSubtitleOrder,
  type VideoSubtitleSettings,
} from "./shared/settings";
import {
  BUILTIN_GOOGLE_ENGINE_ID,
  BUILTIN_MICROSOFT_ENGINE_ID,
  LOCAL_TRANSLATION_ENGINE_ID,
} from "./shared/translation-engine-settings";

interface EngineView {
  id: string;
  name: string;
  enabled: boolean;
  hasApiKey: boolean;
}

interface EngineStateResponse {
  ok?: boolean;
  state?: {
    activeEngineId: string;
    engines: EngineView[];
  };
}

const COLOR_LABELS: Record<string, string> = {
  "#ffffff": "纯白",
  "#fde047": "暖黄",
  "#fdba74": "琥珀橙",
  "#7dd3fc": "天蓝",
};

const enabledToggle = document.querySelector<HTMLInputElement>("#video-subtitle-enabled");
const playerButtonToggle = document.querySelector<HTMLInputElement>("#video-subtitle-player-button");
const engineSelect = document.querySelector<HTMLSelectElement>("#video-subtitle-engine");
const displayModeRadios = Array.from(document.querySelectorAll<HTMLInputElement>('input[name="video-subtitle-display-mode"]'));
const orderRadios = Array.from(document.querySelectorAll<HTMLInputElement>('input[name="video-subtitle-order"]'));
const learningModeToggle = document.querySelector<HTMLInputElement>("#video-subtitle-learning-mode");
const preferManualToggle = document.querySelector<HTMLInputElement>("#video-subtitle-prefer-manual");
const filterSfxToggle = document.querySelector<HTMLInputElement>("#video-subtitle-filter-sfx");
const mergeAsrToggle = document.querySelector<HTMLInputElement>("#video-subtitle-merge-asr");

const transSizeInput = document.querySelector<HTMLInputElement>("#video-subtitle-trans-size");
const transSizeValue = document.querySelector<HTMLOutputElement>("#video-subtitle-trans-size-value");
const srcSizeInput = document.querySelector<HTMLInputElement>("#video-subtitle-src-size");
const srcSizeValue = document.querySelector<HTMLOutputElement>("#video-subtitle-src-size-value");
const bgOpacityInput = document.querySelector<HTMLInputElement>("#video-subtitle-bg-opacity");
const bgOpacityValue = document.querySelector<HTMLOutputElement>("#video-subtitle-bg-opacity-value");
const colorLabel = document.querySelector<HTMLElement>("#video-subtitle-color-label");
const colorSwatches = Array.from(document.querySelectorAll<HTMLButtonElement>(".subtitle-swatch[data-subtitle-color]"));
const resetStyleButton = document.querySelector<HTMLButtonElement>("#video-subtitle-reset-style");

const previewChip = document.querySelector<HTMLElement>("#video-subtitle-preview-chip");
const previewBox = document.querySelector<HTMLElement>("#video-subtitle-preview-box");
const previewSource = document.querySelector<HTMLElement>("#video-subtitle-preview-source");
const previewTranslation = document.querySelector<HTMLElement>("#video-subtitle-preview-translation");
const saveStatus = document.querySelector<HTMLElement>("#save-status");

let currentVideoSettings: VideoSubtitleSettings = { ...DEFAULT_VIDEO_SUBTITLE_SETTINGS };
let webpageDisplayMode: DisplayMode = "translation";
let knownEngines: EngineView[] = [];
let saveDebounceTimer: ReturnType<typeof setTimeout> | null = null;

function notify(message: string, timeout = 1800): void {
  if (!saveStatus) return;
  saveStatus.textContent = message;
  window.setTimeout(() => {
    if (saveStatus.textContent === message) saveStatus.textContent = "";
  }, timeout);
}

function resolvedPreviewDisplayMode(): "bilingual" | "translation" {
  if (currentVideoSettings.displayMode === "follow") {
    return webpageDisplayMode === "bilingual" ? "bilingual" : "translation";
  }
  return currentVideoSettings.displayMode;
}

function renderPreview(): void {
  if (!previewBox || !previewSource || !previewTranslation) return;
  const effectiveMode = resolvedPreviewDisplayMode();
  const isBilingual = effectiveMode === "bilingual";
  const isLearning = isBilingual && currentVideoSettings.learningMode;

  previewBox.style.setProperty("--pl-sub-trans-size", `${currentVideoSettings.translationFontSize}px`);
  previewBox.style.setProperty("--pl-sub-src-size", `${currentVideoSettings.sourceFontSize}px`);
  previewBox.style.setProperty("--pl-sub-trans-color", currentVideoSettings.translationColor);
  previewBox.style.setProperty("--pl-sub-bg-alpha", String(currentVideoSettings.backgroundOpacity / 100));
  previewBox.dataset.order = currentVideoSettings.order;
  previewBox.dataset.learning = isLearning ? "true" : "false";
  if (!isLearning) previewBox.dataset.revealed = "false";

  previewSource.hidden = !isBilingual;
  previewTranslation.hidden = false;

  if (previewChip) {
    if (!isBilingual) {
      previewChip.textContent = currentVideoSettings.displayMode === "follow"
        ? "实时预览 · 跟随网页（当前：仅译文）"
        : "实时预览 · 仅译文";
    } else if (isLearning) {
      previewChip.textContent = "实时预览 · 学习模式（悬停或点击查看译文）";
    } else {
      previewChip.textContent = currentVideoSettings.displayMode === "follow"
        ? "实时预览 · 跟随网页（当前：双语字幕）"
        : "实时预览 · 双语字幕";
    }
  }
}

function syncControlsFromState(): void {
  if (enabledToggle) enabledToggle.checked = currentVideoSettings.enabled;
  if (playerButtonToggle) playerButtonToggle.checked = currentVideoSettings.showPlayerButton;
  if (learningModeToggle) learningModeToggle.checked = currentVideoSettings.learningMode;
  if (preferManualToggle) preferManualToggle.checked = currentVideoSettings.preferManualCaptions;
  if (filterSfxToggle) filterSfxToggle.checked = currentVideoSettings.filterSoundEffects;
  if (mergeAsrToggle) mergeAsrToggle.checked = currentVideoSettings.mergeAsrSegments;

  for (const radio of displayModeRadios) {
    radio.checked = radio.value === currentVideoSettings.displayMode;
  }
  for (const radio of orderRadios) {
    radio.checked = radio.value === currentVideoSettings.order;
  }

  if (transSizeInput) transSizeInput.value = String(currentVideoSettings.translationFontSize);
  if (transSizeValue) transSizeValue.textContent = `${currentVideoSettings.translationFontSize}px`;
  if (srcSizeInput) srcSizeInput.value = String(currentVideoSettings.sourceFontSize);
  if (srcSizeValue) srcSizeValue.textContent = `${currentVideoSettings.sourceFontSize}px`;
  if (bgOpacityInput) bgOpacityInput.value = String(currentVideoSettings.backgroundOpacity);
  if (bgOpacityValue) bgOpacityValue.textContent = `${currentVideoSettings.backgroundOpacity}%`;

  const color = currentVideoSettings.translationColor.toLowerCase();
  if (colorLabel) colorLabel.textContent = COLOR_LABELS[color] ?? color;
  for (const swatch of colorSwatches) {
    const active = swatch.dataset.subtitleColor?.toLowerCase() === color;
    swatch.classList.toggle("active", active);
    swatch.setAttribute("aria-checked", active ? "true" : "false");
  }

  if (engineSelect) {
    engineSelect.value = currentVideoSettings.engineId;
    if (engineSelect.value !== currentVideoSettings.engineId) {
      engineSelect.value = "follow";
    }
  }

  renderPreview();
}

async function persistPatch(patch: Partial<VideoSubtitleSettings>, message = "已保存"): Promise<void> {
  currentVideoSettings = await saveVideoSubtitleSettings(patch);
  syncControlsFromState();
  if (message) notify(message);
}

function scheduleStylePersist(patch: Partial<VideoSubtitleSettings>): void {
  currentVideoSettings = { ...currentVideoSettings, ...patch };
  syncControlsFromState();
  if (saveDebounceTimer) clearTimeout(saveDebounceTimer);
  saveDebounceTimer = setTimeout(() => {
    saveDebounceTimer = null;
    void saveVideoSubtitleSettings(currentVideoSettings).then((saved) => {
      currentVideoSettings = saved;
      notify("字幕样式已保存", 1400);
    });
  }, 220);
}

async function refreshVideoSubtitleEngines(): Promise<void> {
  if (!engineSelect) return;
  try {
    const response = await sendRuntimeMessage<EngineStateResponse>({ type: "get-translation-engines" });
    if (response?.ok && response.state) {
      knownEngines = response.state.engines;
    }
  } catch {
    knownEngines = [];
  }

  engineSelect.replaceChildren();
  const baseOptions: Array<{ value: string; label: string }> = [
    { value: "follow", label: "跟随当前网页引擎" },
    { value: LOCAL_TRANSLATION_ENGINE_ID, label: "Firefox 本地翻译" },
    { value: BUILTIN_MICROSOFT_ENGINE_ID, label: "微软翻译" },
    { value: BUILTIN_GOOGLE_ENGINE_ID, label: "Google 翻译" },
  ];
  for (const item of baseOptions) {
    const option = document.createElement("option");
    option.value = item.value;
    option.textContent = item.label;
    engineSelect.append(option);
  }
  for (const engine of knownEngines.filter((entry) => entry.enabled)) {
    const option = document.createElement("option");
    option.value = engine.id;
    option.textContent = engine.name;
    engineSelect.append(option);
  }

  engineSelect.value = currentVideoSettings.engineId;
  if (engineSelect.value !== currentVideoSettings.engineId) {
    engineSelect.value = "follow";
  }
}

async function handleEngineSelection(nextId: string): Promise<void> {
  const previousId = currentVideoSettings.engineId;
  if (nextId !== "follow" && nextId !== LOCAL_TRANSLATION_ENGINE_ID) {
    const configured = knownEngines.find((entry) => entry.id === nextId);
    const hasApiKey = Boolean(configured?.hasApiKey);
    const granted = await requestExternalTranslationConsent(hasApiKey);
    if (!granted) {
      if (engineSelect) engineSelect.value = previousId;
      notify("未授予外部翻译数据权限，已保留原字幕引擎", 3200);
      return;
    }
  }
  await persistPatch({ engineId: nextId }, "字幕翻译引擎已更新");
}

export async function initializeVideoSubtitleSettings(): Promise<void> {
  if (!enabledToggle && !previewBox) return;

  const settings = await loadSettings();
  webpageDisplayMode = settings.displayMode;
  currentVideoSettings = { ...settings.videoSubtitle };

  await refreshVideoSubtitleEngines();
  syncControlsFromState();

  enabledToggle?.addEventListener("change", () => {
    void persistPatch(
      { enabled: enabledToggle.checked },
      enabledToggle.checked ? "视频字幕翻译已开启" : "视频字幕翻译已关闭",
    );
  });

  playerButtonToggle?.addEventListener("change", () => {
    void persistPatch({ showPlayerButton: playerButtonToggle.checked });
  });

  engineSelect?.addEventListener("change", () => {
    void handleEngineSelection(engineSelect.value);
  });

  for (const radio of displayModeRadios) {
    radio.addEventListener("change", () => {
      if (!radio.checked) return;
      const mode: VideoSubtitleDisplayMode =
        radio.value === "follow" || radio.value === "translation" ? radio.value : "bilingual";
      void persistPatch({ displayMode: mode });
    });
  }

  for (const radio of orderRadios) {
    radio.addEventListener("change", () => {
      if (!radio.checked) return;
      const order: VideoSubtitleOrder = radio.value === "translation-top" ? "translation-top" : "source-top";
      void persistPatch({ order });
    });
  }

  learningModeToggle?.addEventListener("change", () => {
    void persistPatch({ learningMode: learningModeToggle.checked });
  });

  preferManualToggle?.addEventListener("change", () => {
    void persistPatch({ preferManualCaptions: preferManualToggle.checked });
  });

  filterSfxToggle?.addEventListener("change", () => {
    void persistPatch({ filterSoundEffects: filterSfxToggle.checked });
  });

  mergeAsrToggle?.addEventListener("change", () => {
    void persistPatch({ mergeAsrSegments: mergeAsrToggle.checked });
  });

  transSizeInput?.addEventListener("input", () => {
    scheduleStylePersist({ translationFontSize: Number.parseInt(transSizeInput.value, 10) });
  });

  srcSizeInput?.addEventListener("input", () => {
    scheduleStylePersist({ sourceFontSize: Number.parseInt(srcSizeInput.value, 10) });
  });

  bgOpacityInput?.addEventListener("input", () => {
    scheduleStylePersist({ backgroundOpacity: Number.parseInt(bgOpacityInput.value, 10) });
  });

  for (const swatch of colorSwatches) {
    swatch.addEventListener("click", () => {
      const color = swatch.dataset.subtitleColor;
      if (!color) return;
      void persistPatch({ translationColor: color }, "字幕样式已保存");
    });
  }

  resetStyleButton?.addEventListener("click", () => {
    void persistPatch({
      translationFontSize: DEFAULT_VIDEO_SUBTITLE_SETTINGS.translationFontSize,
      sourceFontSize: DEFAULT_VIDEO_SUBTITLE_SETTINGS.sourceFontSize,
      translationColor: DEFAULT_VIDEO_SUBTITLE_SETTINGS.translationColor,
      backgroundOpacity: DEFAULT_VIDEO_SUBTITLE_SETTINGS.backgroundOpacity,
    }, "已恢复默认字幕样式");
  });

  previewBox?.addEventListener("click", () => {
    if (previewBox.dataset.learning !== "true") return;
    const revealed = previewBox.dataset.revealed === "true";
    previewBox.dataset.revealed = revealed ? "false" : "true";
  });

  if (typeof browser !== "undefined" && browser.storage?.onChanged) {
    browser.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== "local") return;
      if (changes.displayMode) {
        webpageDisplayMode = changes.displayMode.newValue === "bilingual" ? "bilingual" : "translation";
        renderPreview();
      }
      if (changes.translationEngines || changes.activeTranslationEngineId) {
        void refreshVideoSubtitleEngines();
      }
    });
  }
}
