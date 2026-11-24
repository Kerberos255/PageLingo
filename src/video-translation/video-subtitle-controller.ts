// Video soft-subtitle overlay controller with Shadow DOM rendering, player quick toggle,
// windowed batched pre-translation, terminology preservation, and live settings sync.

import type { TranslationProvider } from "../core/provider";
import {
  applyTerminologyCorrectionsHtml,
  escapeHtml,
  parseTerminology,
  protectTerminologyHtml,
  restoreTerminologyHtml,
  terminologyForText,
  type TerminologyEntry,
} from "../core/rich-segment";
import { RuntimeMessageProvider } from "../providers/runtime-message-provider";
import {
  DEFAULT_SETTINGS,
  loadSettings,
  normalizeDetectedLanguage,
  type PageLingoSettings,
  type VideoSubtitleSettings,
} from "../shared/settings";
import {
  detectVideoPlatform,
  discoverVideoSubtitlesDetailed,
  extractYouTubeVideoId,
  isKnownPlatformPlayerContainer,
  readTextTrackCues,
  resolvePlatformControlsTarget,
  resolvePlayerContainer,
  type DiscoveredSubtitleTrack,
  type DiscoverTrackOptions,
  type PlatformControlsTarget,
  type SubtitleDiscoveryResult,
  type SubtitleDiscoveryStatus,
  type VideoMediaElement,
  type VideoPlatform,
} from "./platform-adapters";
import {
  filterSoundEffectText,
  findActiveCueIndex,
  prepareSubtitleCues,
  type SubtitleCue,
} from "./subtitle-cues";

const SUBTITLE_STYLE_ID = "pagelingo-video-subtitle-style";
const SUBTITLE_BATCH_SIZE = 12;
const SUBTITLE_LOOKAHEAD_CUES = 18;
const MAX_LANGUAGE_SAMPLE_CUES = 10;
const MAX_LIVE_TRANSLATION_CACHE = 400;

export type EffectiveSubtitleMode = "bilingual" | "translation" | "off";

export interface VideoSubtitleControllerOptions {
  doc?: Document;
  provider?: TranslationProvider;
  loadSettingsFn?: () => Promise<PageLingoSettings>;
  discoverFn?: (video: VideoMediaElement, options: DiscoverTrackOptions) => Promise<DiscoveredSubtitleTrack | null>;
  discoverDetailedFn?: (video: VideoMediaElement, options: DiscoverTrackOptions) => Promise<SubtitleDiscoveryResult>;
  detectLanguageFn?: (text: string) => Promise<string | null>;
  platformFn?: () => VideoPlatform;
}

interface AttachedVideoSession {
  video: VideoMediaElement;
  platform: VideoPlatform;
  container: HTMLElement;
  containerOriginalPosition: string | null;
  fullscreenHostParent: HTMLElement | null;
  host: HTMLDivElement;
  shadow: ShadowRoot;
  wrapEl: HTMLDivElement;
  boxEl: HTMLDivElement;
  sourceEl: HTMLDivElement;
  translationEl: HTMLDivElement;
  toggleButton: HTMLButtonElement | null;
  toggleMountKind: "youtube" | "bilibili" | "html5-inline" | "floating" | null;
  overrideMode: EffectiveSubtitleMode | null;
  track: DiscoveredSubtitleTrack | null;
  discoveryStatus: SubtitleDiscoveryStatus | "idle";
  cues: SubtitleCue[];
  sourceLanguage: string | null;
  liveDomMode: boolean;
  liveSourceText: string;
  liveTranslations: Map<string, string>;
  liveInFlight: Set<string>;
  liveFailed: Set<string>;
  boundTextTracks: WeakSet<TextTrack>;
  lastUrl: string;
  lastSrc: string;
  lastCueIndex: number;
  inFlight: Set<number>;
  failed: Set<number>;
  discovering: boolean;
  discoverVersion: number;
  abortController: AbortController;
  listeners: Array<() => void>;
}

function isNativeHtmlVideo(video: VideoMediaElement): video is HTMLVideoElement {
  return video.tagName.toLowerCase() === "video";
}

function parseClockTimeSeconds(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!/^\d{1,2}(?::\d{2}){1,2}$/.test(trimmed)) return null;
  const parts = trimmed.split(":").map((part) => Number.parseInt(part, 10));
  if (parts.some((n) => !Number.isFinite(n))) return null;
  if (parts.length === 2) return parts[0]! * 60 + parts[1]!;
  if (parts.length === 3) return parts[0]! * 3600 + parts[1]! * 60 + parts[2]!;
  return null;
}

function readMediaCurrentTime(video: VideoMediaElement, container: HTMLElement): number {
  const direct = (video as Partial<HTMLVideoElement>).currentTime;
  if (typeof direct === "number" && Number.isFinite(direct)) return direct;
  try {
    const unwrapped = (video as { wrappedJSObject?: { currentTime?: unknown } }).wrappedJSObject;
    if (typeof unwrapped?.currentTime === "number" && Number.isFinite(unwrapped.currentTime)) {
      return unwrapped.currentTime;
    }
  } catch {}
  const clockEl =
    container.querySelector<HTMLElement>(".bpx-player-ctrl-time-current, .bilibili-player-video-time-now")
    ?? container.closest<HTMLElement>(".bpx-player-container, .bilibili-player-area")?.querySelector<HTMLElement>(".bpx-player-ctrl-time-current, .bilibili-player-video-time-now");
  const parsed = parseClockTimeSeconds(clockEl?.textContent);
  return parsed ?? 0;
}

function readMediaSrc(video: VideoMediaElement): string {
  const direct = (video as Partial<HTMLVideoElement>).currentSrc || (video as Partial<HTMLVideoElement>).src;
  if (typeof direct === "string" && direct) return direct;
  try {
    const unwrapped = (video as { wrappedJSObject?: { currentSrc?: unknown; src?: unknown } }).wrappedJSObject;
    if (typeof unwrapped?.currentSrc === "string" && unwrapped.currentSrc) return unwrapped.currentSrc;
    if (typeof unwrapped?.src === "string" && unwrapped.src) return unwrapped.src;
  } catch {}
  return video.getAttribute("src") ?? "";
}

function readYouTubeLiveCaptionText(container: HTMLElement, filterSfx: boolean): string {
  const captionRoot = container.querySelector<HTMLElement>(".ytp-caption-window-container");
  if (!captionRoot) return "";
  const segments = Array.from(captionRoot.querySelectorAll<HTMLElement>(".ytp-caption-segment"));
  const raw = segments.length > 0
    ? segments.map((seg) => seg.textContent ?? "").join(" ")
    : (captionRoot.textContent ?? "");
  const normalized = raw.replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  return filterSfx ? filterSoundEffectText(normalized).replace(/\s+/g, " ").trim() : normalized;
}

function mutationTouchesYouTubeCaptions(mutations: readonly MutationRecord[]): boolean {
  for (const record of mutations) {
    const target = record.target;
    const el = target.nodeType === 1 ? (target as Element) : target.parentElement;
    if (el?.closest?.(".ytp-caption-window-container")) return true;
    for (const node of Array.from(record.addedNodes)) {
      if (node.nodeType === 1) {
        const added = node as Element;
        if (
          added.classList.contains("ytp-caption-window-container")
          || added.classList.contains("ytp-caption-segment")
          || Boolean(added.querySelector?.(".ytp-caption-window-container, .ytp-caption-segment"))
        ) {
          return true;
        }
      }
    }
    for (const node of Array.from(record.removedNodes)) {
      if (node.nodeType === 1) {
        const removed = node as Element;
        if (
          removed.classList.contains("ytp-caption-window-container")
          || removed.classList.contains("ytp-caption-segment")
        ) {
          return true;
        }
      }
    }
  }
  return false;
}

function insertToggleInControls(button: HTMLButtonElement, target: PlatformControlsTarget): void {
  if (target.placement === "prepend") {
    target.element.prepend(button);
    return;
  }
  if (target.placement === "before-fullscreen" && target.fullscreenSelector) {
    const fsBtn = target.element.querySelector(target.fullscreenSelector);
    if (fsBtn && fsBtn.parentElement === target.element) {
      target.element.insertBefore(button, fsBtn);
      return;
    }
  }
  target.element.append(button);
}

function htmlToPlainText(doc: Document, html: string): string {
  const Parser = doc.defaultView?.DOMParser ?? globalThis.DOMParser;
  if (typeof Parser === "function") {
    const parsed = new Parser().parseFromString(html, "text/html");
    return (parsed.body?.textContent ?? "").replace(/\s+/g, " ").trim();
  }
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

async function defaultDetectLanguage(sample: string): Promise<string | null> {
  if (!sample.trim()) return null;
  try {
    const detect = (globalThis as { browser?: typeof browser }).browser?.i18n?.detectLanguage;
    if (typeof detect !== "function") return null;
    const result = await detect(sample);
    const top = result?.languages?.[0];
    if (!top?.language || (top.percentage ?? 0) < 40) return null;
    return normalizeDetectedLanguage(top.language);
  } catch {
    return null;
  }
}

function ensureDocumentSubtitleStyle(doc: Document): void {
  if (doc.getElementById(SUBTITLE_STYLE_ID)) return;
  const style = doc.createElement("style");
  style.id = SUBTITLE_STYLE_ID;
  style.dataset.fltGenerated = "video-subtitle-style";
  style.textContent = `
    [data-pagelingo-subtitle-active="true"] .ytp-caption-window-container,
    [data-pagelingo-subtitle-active="true"] .bpx-player-subtitle-wrap,
    [data-pagelingo-subtitle-active="true"] .bpx-player-subtitle-panel-text,
    [data-pagelingo-subtitle-active="true"] .bilibili-player-video-subtitle,
    [data-pagelingo-subtitle-active="true"] .vjs-text-track-display,
    [data-pagelingo-subtitle-active="true"] .plyr__captions,
    [data-pagelingo-subtitle-active="true"] .vp-captions,
    [data-pagelingo-subtitle-active="true"] [data-purpose="captions-cue-text"],
    [data-pagelingo-subtitle-active="true"] .shaka-text-container,
    [data-pagelingo-subtitle-active="true"] .jw-captions,
    [data-pagelingo-subtitle-active="true"] .dplayer-subtitle,
    [data-pagelingo-subtitle-active="true"] .art-subtitle,
    [data-pagelingo-subtitle-active="true"] .xgplayer-texttrack {
      opacity: 0 !important;
      pointer-events: none !important;
    }
    .pagelingo-sub-toggle-floating {
      position: absolute !important;
      top: 12px !important;
      right: 12px !important;
      z-index: 2147483641 !important;
      display: inline-flex !important;
      align-items: center !important;
      gap: 5px !important;
      padding: 5px 10px !important;
      border: 1px solid rgba(255, 255, 255, 0.22) !important;
      border-radius: 999px !important;
      background: rgba(15, 18, 24, 0.72) !important;
      color: #f4f6fa !important;
      font: 600 12px/1.2 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif !important;
      white-space: nowrap !important;
      cursor: pointer !important;
      opacity: 0.68 !important;
      transition: opacity 160ms ease, background-color 160ms ease, border-color 160ms ease !important;
      backdrop-filter: blur(4px) !important;
      pointer-events: auto !important;
    }
    .pagelingo-sub-toggle-floating:hover,
    .pagelingo-sub-toggle-floating:focus-visible {
      opacity: 1 !important;
      background: rgba(15, 18, 24, 0.9) !important;
      border-color: rgba(255, 255, 255, 0.45) !important;
    }
    .pagelingo-sub-toggle-inline {
      display: inline-flex !important;
      align-items: center !important;
      justify-content: center !important;
      flex: 0 0 auto !important;
      width: auto !important;
      min-width: max-content !important;
      max-width: none !important;
      overflow: visible !important;
      visibility: visible !important;
      box-sizing: border-box !important;
      padding: 0 7px !important;
      height: 100% !important;
      background: transparent !important;
      border: 0 !important;
      color: #ffffff !important;
      font: 600 12px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif !important;
      white-space: nowrap !important;
      cursor: pointer !important;
      vertical-align: top !important;
      opacity: 0.92 !important;
      pointer-events: auto !important;
    }
    .pagelingo-sub-toggle-bilibili {
      height: 26px !important;
      line-height: 26px !important;
      margin-right: 6px !important;
      padding: 0 2px !important;
    }
    .pagelingo-sub-toggle-html5 {
      height: 28px !important;
      line-height: 28px !important;
      margin: 0 4px !important;
      padding: 0 2px !important;
      align-self: center !important;
    }
    .pagelingo-sub-toggle-inline:hover {
      opacity: 1 !important;
    }
    .pagelingo-sub-toggle-badge {
      display: inline-flex !important;
      align-items: center !important;
      gap: 4px !important;
      padding: 3px 7px !important;
      border-radius: 999px !important;
      background: rgba(255, 255, 255, 0.16) !important;
      color: #ffffff !important;
      font-size: 11px !important;
      line-height: 1.1 !important;
      white-space: nowrap !important;
    }
    [data-pagelingo-sub-mode="off"] .pagelingo-sub-toggle-badge,
    [data-pagelingo-sub-mode="unavailable"] .pagelingo-sub-toggle-badge,
    [data-pagelingo-sub-mode="loading"] .pagelingo-sub-toggle-badge {
      opacity: 0.68 !important;
    }
    [data-pagelingo-sub-mode="need-login"] .pagelingo-sub-toggle-badge {
      background: rgba(245, 158, 11, 0.28) !important;
      color: #fef3c7 !important;
    }
    [data-pagelingo-sub-mode="need-cc"] .pagelingo-sub-toggle-badge {
      background: rgba(56, 189, 248, 0.28) !important;
      color: #e0f2fe !important;
    }
  `;
  (doc.head ?? doc.documentElement).append(style);
}

function buildShadowStyles(platform: VideoPlatform): string {
  const bottomOffset = platform === "youtube" ? "12%" : platform === "bilibili" ? "11%" : "9%";
  return `
    :host {
      position: absolute !important;
      inset: 0 !important;
      pointer-events: none !important;
      z-index: 2147483640 !important;
      overflow: hidden !important;
      display: block !important;
    }
    .pl-sub-wrap {
      position: absolute;
      left: 50%;
      bottom: ${bottomOffset};
      transform: translateX(-50%);
      width: min(88%, 880px);
      display: flex;
      justify-content: center;
      pointer-events: none;
      box-sizing: border-box;
    }
    .pl-sub-wrap[hidden] {
      display: none !important;
    }
    .pl-sub-box {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 3px;
      max-width: 100%;
      padding: 6px 14px;
      border-radius: 8px;
      background: rgba(12, 14, 18, var(--pl-sub-bg-alpha, 0.72));
      text-align: center;
      box-sizing: border-box;
      pointer-events: none;
    }
    .pl-sub-box[data-order="translation-top"] {
      flex-direction: column-reverse;
    }
    .pl-sub-line {
      margin: 0;
      max-width: 100%;
      overflow-wrap: anywhere;
      text-shadow: 0 1px 3px rgba(0, 0, 0, 0.92), 0 0 8px rgba(0, 0, 0, 0.55);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
    }
    .pl-sub-line[hidden] {
      display: none !important;
    }
    .pl-sub-source {
      font-size: var(--pl-sub-src-size, 15px);
      line-height: 1.35;
      font-weight: 450;
      color: rgba(242, 244, 248, 0.9);
    }
    .pl-sub-translation {
      font-size: var(--pl-sub-trans-size, 20px);
      line-height: 1.38;
      font-weight: 580;
      color: var(--pl-sub-trans-color, #ffffff);
      transition: filter 160ms ease, opacity 160ms ease;
    }
    .pl-sub-box[data-learning="true"] {
      pointer-events: auto;
      cursor: pointer;
    }
    .pl-sub-box[data-learning="true"] .pl-sub-translation {
      filter: blur(7px);
      opacity: 0.45;
    }
    .pl-sub-box[data-learning="true"]:hover .pl-sub-translation,
    .pl-sub-box[data-learning="true"][data-revealed="true"] .pl-sub-translation {
      filter: none;
      opacity: 1;
    }
  `;
}

function toggleLabelForMode(mode: EffectiveSubtitleMode): { shortText: string; ariaLabel: string; modeAttr: string } {
  if (mode === "bilingual") {
    return { shortText: "PL 双语", ariaLabel: "PageLingo 字幕：双语对照（点击切换为仅译文）", modeAttr: "bilingual" };
  }
  if (mode === "translation") {
    return { shortText: "PL 译文", ariaLabel: "PageLingo 字幕：仅译文（点击关闭）", modeAttr: "translation" };
  }
  return { shortText: "PL 关", ariaLabel: "PageLingo 字幕：已关闭（点击开启双语）", modeAttr: "off" };
}

function toggleLabelForUnavailable(
  session: AttachedVideoSession,
): { shortText: string; ariaLabel: string; modeAttr: string } {
  if (session.discovering) {
    return {
      shortText: "PL 字幕…",
      ariaLabel: "PageLingo 正在检测当前视频的软字幕…",
      modeAttr: "loading",
    };
  }
  if (session.discoveryStatus === "need_login") {
    return {
      shortText: "PL 需登录",
      ariaLabel: "B 站软字幕 / AI 字幕接口需要登录账号；登录后点击重新检测",
      modeAttr: "need-login",
    };
  }
  if (session.discoveryStatus === "need_cc") {
    return {
      shortText: "PL 开CC",
      ariaLabel: "YouTube 需开启播放器原生 CC 字幕以授权字幕轨道；点击开启并翻译（或按 C 键）",
      modeAttr: "need-cc",
    };
  }
  if (session.discoveryStatus === "error") {
    return {
      shortText: "PL 重试",
      ariaLabel: "PageLingo 获取视频字幕失败；点击重新检测",
      modeAttr: "unavailable",
    };
  }
  return {
    shortText: "PL 无字幕",
    ariaLabel: "当前视频未检测到 CC / AI 软字幕（不支持内嵌硬字幕）；点击重新检测",
    modeAttr: "unavailable",
  };
}

function nextCycleMode(current: EffectiveSubtitleMode): EffectiveSubtitleMode {
  if (current === "bilingual") return "translation";
  if (current === "translation") return "off";
  return "bilingual";
}

export class VideoSubtitleManager {
  readonly #doc: Document;
  readonly #provider: TranslationProvider;
  readonly #loadSettings: () => Promise<PageLingoSettings>;
  readonly #discoverDetailed: (video: VideoMediaElement, options: DiscoverTrackOptions) => Promise<SubtitleDiscoveryResult>;
  readonly #detectLanguage: (text: string) => Promise<string | null>;
  readonly #platformFn: () => VideoPlatform;

  #settings: PageLingoSettings = { ...DEFAULT_SETTINGS, videoSubtitle: { ...DEFAULT_SETTINGS.videoSubtitle } };
  #sessions = new Map<VideoMediaElement, AttachedVideoSession>();
  #mutationObserver: MutationObserver | null = null;
  #storageListener: ((changes: Record<string, unknown>, areaName: string) => void) | null = null;
  #routeListeners: Array<() => void> = [];
  #routePollTimer: ReturnType<typeof setInterval> | null = null;
  #lastObservedHref = "";
  #scanTimer: ReturnType<typeof setTimeout> | null = null;
  #started = false;
  #disposed = false;

  constructor(options: VideoSubtitleControllerOptions = {}) {
    this.#doc = options.doc ?? document;
    this.#provider = options.provider ?? new RuntimeMessageProvider();
    this.#loadSettings = options.loadSettingsFn ?? loadSettings;
    if (options.discoverDetailedFn) {
      this.#discoverDetailed = options.discoverDetailedFn;
    } else if (options.discoverFn) {
      const customDiscover = options.discoverFn;
      this.#discoverDetailed = async (video, opts) => {
        const track = await customDiscover(video, opts);
        return track ? { track, status: "ready" } : { track: null, status: "no_subtitles" };
      };
    } else {
      this.#discoverDetailed = discoverVideoSubtitlesDetailed;
    }
    this.#detectLanguage = options.detectLanguageFn ?? defaultDetectLanguage;
    this.#platformFn = options.platformFn ?? (() => detectVideoPlatform(this.#doc.defaultView?.location.hostname ?? location.hostname));
  }

  async start(): Promise<void> {
    if (this.#started || this.#disposed) return;
    this.#started = true;
    this.#settings = await this.#loadSettings();
    if (this.#disposed) return;

    this.#bindStorageListener();
    if (this.#settings.videoSubtitle.enabled) {
      this.#activate();
    }
  }

  dispose(): void {
    this.#disposed = true;
    this.#deactivate();
    if (this.#storageListener) {
      try {
        (globalThis as { browser?: typeof browser }).browser?.storage?.onChanged?.removeListener(this.#storageListener as never);
      } catch {}
      this.#storageListener = null;
    }
  }

  /** Exposed for live updates in tests or direct settings synchronization. */
  async applySettings(next: PageLingoSettings): Promise<void> {
    const prev = this.#settings;
    this.#settings = next;

    if (!next.videoSubtitle.enabled) {
      this.#deactivate();
      return;
    }

    if (!prev.videoSubtitle.enabled) {
      this.#activate();
      return;
    }

    const needRediscover =
      prev.videoSubtitle.preferManualCaptions !== next.videoSubtitle.preferManualCaptions
      || prev.videoSubtitle.filterSoundEffects !== next.videoSubtitle.filterSoundEffects
      || prev.videoSubtitle.mergeAsrSegments !== next.videoSubtitle.mergeAsrSegments
      || prev.targetLanguage !== next.targetLanguage;

    const needRetranslate =
      prev.videoSubtitle.engineId !== next.videoSubtitle.engineId
      || prev.targetLanguage !== next.targetLanguage
      || prev.builtinGlossaryEnabled !== next.builtinGlossaryEnabled
      || JSON.stringify(prev.glossaryCollections) !== JSON.stringify(next.glossaryCollections);

    for (const session of this.#sessions.values()) {
      this.#applyOverlayStyles(session);
      this.#syncToggleButton(session);
      this.#syncNativeCaptionSuppression(session);
      if (needRediscover) {
        void this.#discoverSessionTrack(session, true);
      } else if (needRetranslate) {
        this.#resetSessionTranslations(session);
        this.#ensureWindowTranslated(session);
      } else {
        this.#renderCue(session, true);
      }
    }
  }

  getActiveSessionCount(): number {
    return this.#sessions.size;
  }

  #bindStorageListener(): void {
    const storageApi = (globalThis as { browser?: typeof browser }).browser?.storage?.onChanged;
    if (!storageApi) return;
    this.#storageListener = (changes, areaName) => {
      if (areaName !== "local" || this.#disposed) return;
      const relevant =
        "videoSubtitle" in changes
        || "displayMode" in changes
        || "targetLanguage" in changes
        || "glossaryCollections" in changes
        || "builtinGlossaryEnabled" in changes
        || "activeTranslationEngineId" in changes
        || "translationEngines" in changes;
      if (!relevant) return;
      const engineChanged = "activeTranslationEngineId" in changes || "translationEngines" in changes;
      void this.#loadSettings().then(async (next) => {
        if (this.#disposed) return;
        await this.applySettings(next);
        if (engineChanged && next.videoSubtitle.enabled && next.videoSubtitle.engineId === "follow") {
          for (const session of this.#sessions.values()) {
            this.#resetSessionTranslations(session);
            this.#ensureWindowTranslated(session);
          }
        }
      }).catch(() => {});
    };
    storageApi.addListener(this.#storageListener as never);
  }

  #activate(): void {
    ensureDocumentSubtitleStyle(this.#doc);
    this.#scanVideos();
    this.#startObservers();
  }

  #deactivate(): void {
    if (this.#scanTimer) {
      clearTimeout(this.#scanTimer);
      this.#scanTimer = null;
    }
    if (this.#routePollTimer) {
      clearInterval(this.#routePollTimer);
      this.#routePollTimer = null;
    }
    this.#mutationObserver?.disconnect();
    this.#mutationObserver = null;
    for (const cleanup of this.#routeListeners) cleanup();
    this.#routeListeners = [];

    for (const video of Array.from(this.#sessions.keys())) {
      this.#detachVideo(video);
    }
    this.#doc.getElementById(SUBTITLE_STYLE_ID)?.remove();
  }

  #startObservers(): void {
    const view = this.#doc.defaultView ?? window;
    this.#lastObservedHref = view.location?.href ?? "";
    if (!this.#mutationObserver && this.#doc.body) {
      this.#mutationObserver = new MutationObserver(() => {
        this.#scheduleScan();
      });
      this.#mutationObserver.observe(this.#doc.body, { childList: true, subtree: true });
    }
    if (this.#routeListeners.length === 0) {
      const onRoute = () => this.#handlePossibleNavigation();
      const onFullscreen = () => this.#syncFullscreenMounts();
      view.addEventListener("popstate", onRoute, { passive: true });
      view.addEventListener("hashchange", onRoute, { passive: true });
      view.addEventListener("yt-navigate-finish", onRoute as EventListener, { passive: true });
      this.#doc.addEventListener("fullscreenchange", onFullscreen, { passive: true });
      this.#doc.addEventListener("webkitfullscreenchange", onFullscreen as EventListener, { passive: true });
      this.#routeListeners.push(
        () => view.removeEventListener("popstate", onRoute),
        () => view.removeEventListener("hashchange", onRoute),
        () => view.removeEventListener("yt-navigate-finish", onRoute as EventListener),
        () => this.#doc.removeEventListener("fullscreenchange", onFullscreen),
        () => this.#doc.removeEventListener("webkitfullscreenchange", onFullscreen as EventListener),
      );
    }
    const platform = this.#platformFn();
    if (!this.#routePollTimer && (platform === "bilibili" || platform === "youtube")) {
      this.#routePollTimer = setInterval(() => {
        if (!this.#settings.videoSubtitle.enabled || this.#disposed) return;
        const currentHref = this.#doc.defaultView?.location.href ?? location.href;
        if (currentHref !== this.#lastObservedHref) {
          this.#lastObservedHref = currentHref;
          this.#handlePossibleNavigation();
        }
      }, 500);
    }
  }

  #syncFullscreenMounts(): void {
    const fsEl = (this.#doc.fullscreenElement
      ?? (this.#doc as Document & { webkitFullscreenElement?: Element | null }).webkitFullscreenElement) as HTMLElement | null;

    for (const session of this.#sessions.values()) {
      const needReparent = Boolean(
        fsEl
        && fsEl !== session.container
        && fsEl.contains(session.video)
        && !fsEl.contains(session.container),
      );
      if (needReparent && fsEl) {
        if (session.fullscreenHostParent !== fsEl) {
          session.fullscreenHostParent = fsEl;
          fsEl.append(session.host);
          this.#syncToggleButton(session);
        }
      } else if (session.fullscreenHostParent) {
        session.fullscreenHostParent = null;
        session.container.append(session.host);
        this.#syncToggleButton(session);
      }
    }
  }

  #scheduleScan(): void {
    if (this.#scanTimer || !this.#settings.videoSubtitle.enabled || this.#disposed) return;
    this.#scanTimer = setTimeout(() => {
      this.#scanTimer = null;
      this.#scanVideos();
    }, 180);
  }

  #handlePossibleNavigation(): void {
    if (!this.#settings.videoSubtitle.enabled || this.#disposed) return;
    this.#scanVideos();
    const href = this.#doc.defaultView?.location.href ?? location.href;
    this.#lastObservedHref = href;
    for (const session of this.#sessions.values()) {
      const currentSrc = readMediaSrc(session.video);
      if (session.lastUrl !== href || session.lastSrc !== currentSrc) {
        session.lastUrl = href;
        session.lastSrc = currentSrc;
        session.overrideMode = null;
        void this.#discoverSessionTrack(session, true);
      }
    }
  }

  #activeYouTubePlayerId(href: string): "shorts-player" | "movie_player" | null {
    let pathname = "";
    try {
      pathname = new URL(href).pathname;
    } catch {
      return null;
    }
    if (pathname.startsWith("/shorts/") && this.#doc.querySelector("#shorts-player")) {
      return "shorts-player";
    }
    if ((pathname === "/watch" || pathname.startsWith("/live/")) && this.#doc.querySelector("#movie_player")) {
      return "movie_player";
    }
    return null;
  }

  #scanVideos(): void {
    if (!this.#settings.videoSubtitle.enabled || this.#disposed) return;
    const platform = this.#platformFn();
    const href = this.#doc.defaultView?.location.href ?? location.href;
    const selector = platform === "bilibili" ? "video, bwp-video" : "video";
    const videos = new Set(Array.from(this.#doc.querySelectorAll<VideoMediaElement>(selector)));
    const youtubeActivePlayerId = platform === "youtube" ? this.#activeYouTubePlayerId(href) : null;
    const hasMainPlatformPlayer =
      (platform === "bilibili" && Boolean(this.#doc.querySelector(".bpx-player-video-area, .bpx-player-container, .bilibili-player-area")))
      || (platform === "youtube" && Boolean(this.#doc.querySelector("#movie_player, #shorts-player")));

    for (const existing of Array.from(this.#sessions.keys())) {
      const session = this.#sessions.get(existing);
      const isInactiveYouTubePlayer = Boolean(
        platform === "youtube"
        && youtubeActivePlayerId
        && session
        && (session.container.id === "movie_player" || session.container.id === "shorts-player")
        && session.container.id !== youtubeActivePlayerId,
      );
      if (!videos.has(existing) || !existing.isConnected || isInactiveYouTubePlayer) {
        this.#detachVideo(existing);
      }
    }

    for (const video of videos) {
      if (!this.#sessions.has(video)) {
        this.#attachVideo(video, platform, hasMainPlatformPlayer, youtubeActivePlayerId);
      } else {
        const session = this.#sessions.get(video)!;
        this.#syncToggleButton(session);
        const src = readMediaSrc(video);
        if (session.lastUrl !== href || (src && session.lastSrc && src !== session.lastSrc)) {
          session.lastUrl = href;
          session.lastSrc = src;
          session.overrideMode = null;
          void this.#discoverSessionTrack(session, true);
        }
      }
    }
  }

  #effectiveMode(session: AttachedVideoSession): EffectiveSubtitleMode {
    if (!this.#settings.videoSubtitle.enabled) return "off";
    if (session.overrideMode) return session.overrideMode;
    const configured = this.#settings.videoSubtitle.displayMode;
    if (configured === "follow") {
      return this.#settings.displayMode === "bilingual" ? "bilingual" : "translation";
    }
    return configured;
  }

  #attachVideo(
    video: VideoMediaElement,
    platform: VideoPlatform,
    hasMainPlatformPlayer: boolean,
    youtubeActivePlayerId: "shorts-player" | "movie_player" | null,
  ): void {
    const container = resolvePlayerContainer(video, platform);
    if (!container) return;
    if (hasMainPlatformPlayer && !isKnownPlatformPlayerContainer(container, platform)) return;
    if (
      platform === "youtube"
      && youtubeActivePlayerId
      && (container.id === "movie_player" || container.id === "shorts-player")
      && container.id !== youtubeActivePlayerId
    ) {
      return;
    }
    for (const existing of this.#sessions.values()) {
      if (existing.container === container) return;
    }

    const view = this.#doc.defaultView ?? window;
    const computedPos = view.getComputedStyle?.(container)?.position;
    let containerOriginalPosition: string | null = null;
    if (computedPos === "static" || (!computedPos && !container.style.position)) {
      containerOriginalPosition = container.style.position;
      container.style.position = "relative";
    }

    const host = this.#doc.createElement("div");
    host.dataset.fltGenerated = "video-subtitle";
    const shadow = host.attachShadow({ mode: "open" });

    const styleEl = this.#doc.createElement("style");
    styleEl.textContent = buildShadowStyles(platform);

    const wrapEl = this.#doc.createElement("div");
    wrapEl.className = "pl-sub-wrap";
    wrapEl.hidden = true;

    const boxEl = this.#doc.createElement("div");
    boxEl.className = "pl-sub-box";

    const sourceEl = this.#doc.createElement("div");
    sourceEl.className = "pl-sub-line pl-sub-source";
    sourceEl.hidden = true;

    const translationEl = this.#doc.createElement("div");
    translationEl.className = "pl-sub-line pl-sub-translation";
    translationEl.hidden = true;

    boxEl.append(sourceEl, translationEl);
    wrapEl.append(boxEl);
    shadow.append(styleEl, wrapEl);
    container.append(host);

    const session: AttachedVideoSession = {
      video,
      platform,
      container,
      containerOriginalPosition,
      fullscreenHostParent: null,
      host,
      shadow,
      wrapEl,
      boxEl,
      sourceEl,
      translationEl,
      toggleButton: null,
      toggleMountKind: null,
      overrideMode: null,
      track: null,
      discoveryStatus: "idle",
      cues: [],
      sourceLanguage: null,
      liveDomMode: false,
      liveSourceText: "",
      liveTranslations: new Map(),
      liveInFlight: new Set(),
      liveFailed: new Set(),
      boundTextTracks: new WeakSet(),
      lastUrl: view.location?.href ?? "",
      lastSrc: readMediaSrc(video),
      lastCueIndex: -2,
      inFlight: new Set(),
      failed: new Set(),
      discovering: false,
      discoverVersion: 0,
      abortController: new AbortController(),
      listeners: [],
    };

    boxEl.addEventListener("click", (event) => {
      if (boxEl.dataset.learning !== "true") return;
      event.stopPropagation();
      const revealed = boxEl.dataset.revealed === "true";
      boxEl.dataset.revealed = revealed ? "false" : "true";
    });

    const onTimeUpdate = () => {
      this.#renderCue(session, false);
      this.#ensureWindowTranslated(session);
    };
    const onSeeked = () => {
      this.#renderCue(session, true);
      this.#ensureWindowTranslated(session);
    };
    const onLoadedMetadata = () => {
      const nextSrc = readMediaSrc(video);
      if (!session.track || (nextSrc && nextSrc !== session.lastSrc)) {
        session.lastSrc = nextSrc;
        void this.#discoverSessionTrack(session, true);
      }
    };
    const onTextTrackListChange = () => {
      this.#bindTextTrackListeners(session);
      if (!session.track) void this.#discoverSessionTrack(session, false);
    };

    video.addEventListener("timeupdate", onTimeUpdate);
    video.addEventListener("seeked", onSeeked);
    video.addEventListener("loadedmetadata", onLoadedMetadata);
    session.listeners.push(
      () => video.removeEventListener("timeupdate", onTimeUpdate),
      () => video.removeEventListener("seeked", onSeeked),
      () => video.removeEventListener("loadedmetadata", onLoadedMetadata),
    );
    if (isNativeHtmlVideo(video) && video.textTracks && typeof video.textTracks.addEventListener === "function") {
      video.textTracks.addEventListener("addtrack", onTextTrackListChange);
      video.textTracks.addEventListener("change", onTextTrackListChange);
      session.listeners.push(
        () => video.textTracks.removeEventListener("addtrack", onTextTrackListChange),
        () => video.textTracks.removeEventListener("change", onTextTrackListChange),
      );
      this.#bindTextTrackListeners(session);
    }
    if (!isNativeHtmlVideo(video)) {
      const bwpSyncTimer = setInterval(onTimeUpdate, 200);
      session.listeners.push(() => clearInterval(bwpSyncTimer));
    }

    if (platform === "youtube") {
      this.#bindYouTubeFallbackObservers(session, view);
    }

    this.#sessions.set(video, session);
    this.#applyOverlayStyles(session);
    this.#syncFullscreenMounts();
    this.#syncToggleButton(session);
    void this.#discoverSessionTrack(session, false);
  }

  #bindTextTrackListeners(session: AttachedVideoSession): void {
    if (!isNativeHtmlVideo(session.video) || !session.video.textTracks) return;
    for (const track of Array.from(session.video.textTracks)) {
      if (track.kind && track.kind !== "subtitles" && track.kind !== "captions") continue;
      if (session.boundTextTracks.has(track)) continue;
      session.boundTextTracks.add(track);
      const onCueChange = () => this.#handleTextTrackCueChange(session, track);
      try {
        track.addEventListener("cuechange", onCueChange);
        session.listeners.push(() => {
          try { track.removeEventListener("cuechange", onCueChange); } catch {}
        });
      } catch {}
    }
  }

  #handleTextTrackCueChange(session: AttachedVideoSession, track: TextTrack): void {
    if (this.#disposed || !this.#sessions.has(session.video)) return;
    if (!session.track) {
      if ((track.cues?.length ?? 0) > 0) {
        void this.#discoverSessionTrack(session, false);
      }
      return;
    }
    if (session.track.liveTextTrack !== track) return;
    const rawCues = readTextTrackCues(track);
    const prepared = prepareSubtitleCues(rawCues, {
      filterSoundEffects: this.#settings.videoSubtitle.filterSoundEffects,
      mergeAsr: false,
    });
    if (prepared.length === 0) return;

    const existingKeys = new Set(session.cues.map((c) => `${c.startTime.toFixed(2)}|${c.text}`));
    let added = false;
    for (const cue of prepared) {
      const key = `${cue.startTime.toFixed(2)}|${cue.text}`;
      if (!existingKeys.has(key)) {
        existingKeys.add(key);
        session.cues.push({ ...cue });
        added = true;
      }
    }
    if (added) {
      session.cues.sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime);
      session.lastCueIndex = -2;
      this.#renderCue(session, true);
      this.#ensureWindowTranslated(session);
    }
  }

  #bindYouTubeFallbackObservers(session: AttachedVideoSession, view: Window): void {
    // 1. Watch for YouTube's own player loading a pot-authorized /api/timedtext resource.
    const PerfObserverCtor = (view as Window & { PerformanceObserver?: typeof PerformanceObserver }).PerformanceObserver
      ?? globalThis.PerformanceObserver;
    if (typeof PerfObserverCtor === "function") {
      let timedTextRetryTimer: ReturnType<typeof setTimeout> | null = null;
      try {
        const perfObserver = new PerfObserverCtor((list) => {
          if (this.#disposed || session.track || !this.#sessions.has(session.video)) return;
          const currentHref = this.#doc.defaultView?.location.href ?? location.href;
          const activeVideoId = extractYouTubeVideoId(currentHref);
          const matched = list.getEntries().some((entry) => {
            if (!entry.name.includes("/api/timedtext")) return false;
            if (!activeVideoId) return true;
            try {
              return new URL(entry.name).searchParams.get("v") === activeVideoId;
            } catch {
              return false;
            }
          });
          if (!matched) return;
          if (timedTextRetryTimer) clearTimeout(timedTextRetryTimer);
          timedTextRetryTimer = setTimeout(() => {
            timedTextRetryTimer = null;
            if (!this.#disposed && !session.track && this.#sessions.has(session.video)) {
              void this.#discoverSessionTrack(session, false);
            }
          }, 180);
        });
        perfObserver.observe({ entryTypes: ["resource"] });
        session.listeners.push(() => {
          if (timedTextRetryTimer) clearTimeout(timedTextRetryTimer);
          try { perfObserver.disconnect(); } catch {}
        });
      } catch {}
    }

    // 2. Fallback live DOM caption bridge for PO-token videos & YouTube live streams when CC is active.
    const captionObserver = new MutationObserver((mutations) => {
      if (this.#disposed || session.track || !this.#sessions.has(session.video)) return;
      if (!mutationTouchesYouTubeCaptions(mutations)) return;
      this.#syncLiveYouTubeCaption(session);
    });
    captionObserver.observe(session.container, { childList: true, subtree: true, characterData: true });
    session.listeners.push(() => captionObserver.disconnect());
  }

  #syncLiveYouTubeCaption(session: AttachedVideoSession): void {
    if (session.platform !== "youtube" || session.track || this.#disposed) return;
    const text = readYouTubeLiveCaptionText(session.container, this.#settings.videoSubtitle.filterSoundEffects);
    if (!text) {
      if (session.liveDomMode) {
        session.liveSourceText = "";
        session.wrapEl.hidden = true;
      }
      return;
    }

    if (!session.liveDomMode) {
      session.liveDomMode = true;
      this.#syncToggleButton(session);
      this.#syncNativeCaptionSuppression(session);
    }
    if (text !== session.liveSourceText) {
      session.liveSourceText = text;
      session.boxEl.dataset.revealed = "false";
    }
    this.#renderLiveDomCaption(session);
    void this.#translateLiveDomCaption(session, text);
  }

  #renderLiveDomCaption(session: AttachedVideoSession): void {
    const mode = this.#effectiveMode(session);
    if (mode === "off" || !session.liveDomMode || !session.liveSourceText) {
      session.wrapEl.hidden = true;
      return;
    }
    const translated = session.liveTranslations.get(session.liveSourceText) ?? "";
    this.#renderCaptionTexts(session, session.liveSourceText, translated, mode);
  }

  async #translateLiveDomCaption(session: AttachedVideoSession, text: string): Promise<void> {
    const mode = this.#effectiveMode(session);
    if (mode === "off" || !session.liveDomMode || session.track || !text) return;
    if (session.liveTranslations.has(text) || session.liveInFlight.has(text) || session.liveFailed.has(text)) return;

    const signal = session.abortController.signal;
    if (!session.sourceLanguage) {
      session.sourceLanguage = (await this.#detectLanguage(text)) ?? "en";
      if (signal.aborted || this.#disposed || session.track) return;
    }

    const targetLanguage = normalizeDetectedLanguage(this.#settings.targetLanguage) ?? this.#settings.targetLanguage;
    const sourceLanguage = normalizeDetectedLanguage(session.sourceLanguage) ?? session.sourceLanguage ?? "en";
    if (sourceLanguage === targetLanguage) {
      session.liveTranslations.set(text, text);
      if (session.liveSourceText === text) this.#renderLiveDomCaption(session);
      return;
    }

    const terminology: TerminologyEntry[] = parseTerminology(
      this.#settings.glossaryCollections,
      sourceLanguage,
      targetLanguage,
      this.#settings.builtinGlossaryEnabled,
    );
    const engineId = this.#settings.videoSubtitle.engineId !== "follow"
      ? this.#settings.videoSubtitle.engineId
      : undefined;

    session.liveInFlight.add(text);
    const escaped = escapeHtml(text);
    const protectedResult = protectTerminologyHtml(this.#doc, escaped, terminology) as { html: string; replacements: string[] };
    const termHints = terminologyForText(terminology, text);

    try {
      const translatedHtml = await this.#provider.translateHtml({
        html: protectedResult.html,
        sourceLanguage,
        targetLanguage,
        ...(termHints.length ? { terminology: termHints } : {}),
        ...(engineId ? { engineId } : {}),
        signal,
      });
      session.liveInFlight.delete(text);
      if (signal.aborted || this.#disposed || session.track) return;
      let restored = restoreTerminologyHtml(this.#doc, translatedHtml, protectedResult.replacements) as string;
      restored = applyTerminologyCorrectionsHtml(this.#doc, restored, text, terminology) as string;
      const plain = htmlToPlainText(this.#doc, restored);
      if (plain) {
        if (session.liveTranslations.size >= MAX_LIVE_TRANSLATION_CACHE) {
          const oldest = session.liveTranslations.keys().next().value;
          if (typeof oldest === "string") session.liveTranslations.delete(oldest);
        }
        session.liveTranslations.set(text, plain);
        if (session.liveSourceText === text) this.#renderLiveDomCaption(session);
      }
    } catch {
      session.liveInFlight.delete(text);
      if (!signal.aborted) session.liveFailed.add(text);
    }
  }

  #detachVideo(video: VideoMediaElement): void {
    const session = this.#sessions.get(video);
    if (!session) return;
    this.#sessions.delete(video);

    session.abortController.abort();
    for (const cleanup of session.listeners) cleanup();
    session.listeners = [];

    this.#restoreNativeCaptions(session);
    session.toggleButton?.remove();
    session.toggleButton = null;
    session.host.remove();
    session.fullscreenHostParent = null;
    if (session.containerOriginalPosition !== null) {
      session.container.style.position = session.containerOriginalPosition;
    }
  }

  #applyOverlayStyles(session: AttachedVideoSession): void {
    const vs: VideoSubtitleSettings = this.#settings.videoSubtitle;
    session.wrapEl.style.setProperty("--pl-sub-trans-size", `${vs.translationFontSize}px`);
    session.wrapEl.style.setProperty("--pl-sub-src-size", `${vs.sourceFontSize}px`);
    session.wrapEl.style.setProperty("--pl-sub-trans-color", vs.translationColor);
    session.wrapEl.style.setProperty("--pl-sub-bg-alpha", String(vs.backgroundOpacity / 100));
    session.boxEl.dataset.order = vs.order;
  }

  #syncToggleButton(session: AttachedVideoSession): void {
    const controlsTarget = resolvePlatformControlsTarget(session.container, session.platform);
    const hasKnownPlayer = isKnownPlatformPlayerContainer(session.container, session.platform) || Boolean(controlsTarget);
    const shouldShow =
      this.#settings.videoSubtitle.enabled
      && this.#settings.videoSubtitle.showPlayerButton
      && (Boolean(session.track) || session.liveDomMode || hasKnownPlayer);

    if (!shouldShow) {
      session.toggleButton?.remove();
      session.toggleButton = null;
      session.toggleMountKind = null;
      return;
    }

    const desiredKind: "youtube" | "bilibili" | "html5-inline" | "floating" =
      controlsTarget ? controlsTarget.mountKind : "floating";
    const floatingHost = session.fullscreenHostParent ?? session.container;
    const targetParent = desiredKind === "floating" ? floatingHost : controlsTarget!.element;

    if (
      !session.toggleButton
      || session.toggleMountKind !== desiredKind
      || !session.toggleButton.isConnected
      || session.toggleButton.parentElement !== targetParent
    ) {
      session.toggleButton?.remove();
      const button = this.#doc.createElement("button");
      button.type = "button";
      button.dataset.fltGenerated = "video-subtitle-control";
      button.className = desiredKind === "floating"
        ? "pagelingo-sub-toggle-floating"
        : desiredKind === "youtube"
          ? "ytp-button pagelingo-sub-toggle-inline"
          : desiredKind === "bilibili"
            ? "pagelingo-sub-toggle-inline pagelingo-sub-toggle-bilibili"
            : "pagelingo-sub-toggle-inline pagelingo-sub-toggle-html5";

      const badge = this.#doc.createElement("span");
      badge.className = "pagelingo-sub-toggle-badge";
      button.append(badge);

      button.addEventListener("mousedown", (event) => {
        event.stopPropagation();
      });
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (!session.track && !session.liveDomMode) {
          if (session.platform === "youtube" && session.discoveryStatus === "need_cc") {
            const ccButton = session.container.querySelector<HTMLButtonElement>(".ytp-subtitles-button");
            if (ccButton && ccButton.getAttribute("aria-pressed") !== "true") {
              ccButton.click();
            }
            this.#syncLiveYouTubeCaption(session);
            const signal = session.abortController.signal;
            setTimeout(() => {
              if (!signal.aborted && !this.#disposed && !session.track && this.#sessions.has(session.video)) {
                this.#syncLiveYouTubeCaption(session);
                void this.#discoverSessionTrack(session, false);
              }
            }, 350);
            return;
          }
          if (!session.discovering) {
            void this.#discoverSessionTrack(session, true);
          }
          return;
        }
        const next = nextCycleMode(this.#effectiveMode(session));
        session.overrideMode = next;
        this.#updateToggleButtonState(session);
        this.#syncNativeCaptionSuppression(session);
        if (session.track) {
          this.#renderCue(session, true);
          if (next !== "off") this.#ensureWindowTranslated(session);
        } else if (session.liveDomMode) {
          this.#renderLiveDomCaption(session);
          if (next !== "off" && session.liveSourceText) {
            void this.#translateLiveDomCaption(session, session.liveSourceText);
          }
        }
      });

      if (desiredKind === "floating") targetParent.append(button);
      else insertToggleInControls(button, controlsTarget!);

      session.toggleButton = button;
      session.toggleMountKind = desiredKind;
    }

    this.#updateToggleButtonState(session);
  }

  #updateToggleButtonState(session: AttachedVideoSession): void {
    const button = session.toggleButton;
    if (!button) return;
    const { shortText, ariaLabel, modeAttr } = (session.track || session.liveDomMode)
      ? toggleLabelForMode(this.#effectiveMode(session))
      : toggleLabelForUnavailable(session);
    button.dataset.pagelingoSubMode = modeAttr;
    button.setAttribute("aria-label", ariaLabel);
    button.title = ariaLabel;
    const badge = button.firstElementChild;
    if (badge) badge.textContent = shortText;
  }

  #syncNativeCaptionSuppression(session: AttachedVideoSession): void {
    const active = Boolean((session.track || session.liveDomMode) && this.#effectiveMode(session) !== "off");
    if (active) {
      session.container.setAttribute("data-pagelingo-subtitle-active", "true");
      if (session.platform === "html5" && isNativeHtmlVideo(session.video) && session.video.textTracks) {
        for (const track of Array.from(session.video.textTracks)) {
          if (track.mode === "showing") track.mode = "hidden";
        }
      }
    } else {
      this.#restoreNativeCaptions(session);
    }
  }

  #restoreNativeCaptions(session: AttachedVideoSession): void {
    session.container.removeAttribute("data-pagelingo-subtitle-active");
    try {
      session.track?.restoreNativeTrack?.();
    } catch {}
  }

  #resetSessionTranslations(session: AttachedVideoSession): void {
    session.abortController.abort();
    session.abortController = new AbortController();
    session.inFlight.clear();
    session.failed.clear();
    session.liveTranslations.clear();
    session.liveInFlight.clear();
    session.liveFailed.clear();
    if (!session.track?.hasManualTarget) {
      for (const cue of session.cues) {
        delete cue.translatedText;
      }
    }
    session.lastCueIndex = -2;
    if (session.track) {
      this.#renderCue(session, true);
    } else if (session.liveDomMode) {
      this.#renderLiveDomCaption(session);
      if (session.liveSourceText) void this.#translateLiveDomCaption(session, session.liveSourceText);
    }
  }

  async #discoverSessionTrack(session: AttachedVideoSession, forceReset: boolean): Promise<void> {
    if (session.discovering && !forceReset) return;
    session.discovering = true;
    session.discoverVersion += 1;
    const version = session.discoverVersion;

    if (forceReset) {
      session.abortController.abort();
      session.abortController = new AbortController();
      this.#restoreNativeCaptions(session);
      session.track = null;
      session.discoveryStatus = "idle";
      session.liveDomMode = false;
      session.liveSourceText = "";
      session.liveTranslations.clear();
      session.liveInFlight.clear();
      session.liveFailed.clear();
      session.sourceLanguage = null;
      session.cues = [];
      session.inFlight.clear();
      session.failed.clear();
      session.lastCueIndex = -2;
      session.wrapEl.hidden = true;
    }
    this.#syncToggleButton(session);

    try {
      const discovered = await this.#discoverDetailed(session.video, {
        targetLanguage: this.#settings.targetLanguage,
        preferManualCaptions: this.#settings.videoSubtitle.preferManualCaptions,
        filterSoundEffects: this.#settings.videoSubtitle.filterSoundEffects,
        mergeAsrSegments: this.#settings.videoSubtitle.mergeAsrSegments,
      });

      if (this.#disposed || version !== session.discoverVersion || !this.#sessions.has(session.video)) {
        discovered.track?.restoreNativeTrack?.();
        return;
      }

      if (!discovered.track || discovered.track.cues.length === 0) {
        session.track = null;
        session.discoveryStatus = discovered.status === "ready" ? "no_subtitles" : discovered.status;
        session.cues = [];
        session.discovering = false;
        if (session.platform === "youtube") {
          this.#syncLiveYouTubeCaption(session);
        }
        if (!session.liveDomMode) {
          this.#syncToggleButton(session);
          this.#syncNativeCaptionSuppression(session);
          session.wrapEl.hidden = true;
        }
        return;
      }

      session.track = discovered.track;
      session.discoveryStatus = "ready";
      session.liveDomMode = false;
      session.liveSourceText = "";
      session.liveTranslations.clear();
      session.liveInFlight.clear();
      session.liveFailed.clear();
      session.cues = discovered.track.cues.map((cue) => ({ ...cue }));
      session.sourceLanguage = discovered.track.sourceLanguage;
      session.inFlight.clear();
      session.failed.clear();
      session.lastCueIndex = -2;

      if (!session.sourceLanguage && !discovered.track.hasManualTarget) {
        const sample = session.cues.slice(0, MAX_LANGUAGE_SAMPLE_CUES).map((c) => c.text).join(" ");
        session.sourceLanguage = (await this.#detectLanguage(sample)) ?? "en";
        if (this.#disposed || version !== session.discoverVersion) return;
      }

      session.discovering = false;
      this.#bindTextTrackListeners(session);
      this.#syncToggleButton(session);
      this.#syncNativeCaptionSuppression(session);
      this.#renderCue(session, true);
      this.#ensureWindowTranslated(session);
    } catch {
      if (!this.#disposed && version === session.discoverVersion && this.#sessions.has(session.video)) {
        session.track = null;
        session.discoveryStatus = "error";
        session.cues = [];
        session.discovering = false;
        if (session.platform === "youtube") {
          this.#syncLiveYouTubeCaption(session);
        }
        if (!session.liveDomMode) {
          this.#syncToggleButton(session);
          this.#syncNativeCaptionSuppression(session);
          session.wrapEl.hidden = true;
        }
      }
    } finally {
      if (version === session.discoverVersion) {
        session.discovering = false;
        if (!this.#disposed && this.#sessions.has(session.video)) {
          this.#syncToggleButton(session);
        }
      }
    }
  }

  #ensureWindowTranslated(session: AttachedVideoSession): void {
    const mode = this.#effectiveMode(session);
    if (mode === "off" || !session.track || session.cues.length === 0) return;

    const targetLanguage = normalizeDetectedLanguage(this.#settings.targetLanguage) ?? this.#settings.targetLanguage;
    const sourceLanguage = normalizeDetectedLanguage(session.sourceLanguage) ?? session.sourceLanguage ?? "en";
    if (sourceLanguage === targetLanguage) return;

    const currentTime = readMediaCurrentTime(session.video, session.container);
    let anchor = findActiveCueIndex(session.cues, currentTime);
    if (anchor < 0) {
      anchor = session.cues.findIndex((cue) => cue.endTime >= currentTime);
      if (anchor < 0) anchor = 0;
    }

    const windowEnd = Math.min(session.cues.length, anchor + SUBTITLE_LOOKAHEAD_CUES);
    const pendingIndices: number[] = [];
    for (let i = anchor; i < windowEnd && pendingIndices.length < SUBTITLE_BATCH_SIZE; i += 1) {
      const cue = session.cues[i]!;
      if (typeof cue.translatedText === "string" || session.inFlight.has(i) || session.failed.has(i)) continue;
      pendingIndices.push(i);
    }
    if (pendingIndices.length === 0) return;

    const terminology: TerminologyEntry[] = parseTerminology(
      this.#settings.glossaryCollections,
      sourceLanguage,
      targetLanguage,
      this.#settings.builtinGlossaryEnabled,
    );
    const engineId = this.#settings.videoSubtitle.engineId !== "follow"
      ? this.#settings.videoSubtitle.engineId
      : undefined;
    const signal = session.abortController.signal;

    // Dispatch synchronously in one tick so RuntimeMessageProvider batches them together.
    for (const index of pendingIndices) {
      const cue = session.cues[index]!;
      session.inFlight.add(index);
      const escaped = escapeHtml(cue.text);
      const protectedResult = protectTerminologyHtml(this.#doc, escaped, terminology) as { html: string; replacements: string[] };
      const termHints = terminologyForText(terminology, cue.text);

      void this.#provider.translateHtml({
        html: protectedResult.html,
        sourceLanguage,
        targetLanguage,
        ...(termHints.length ? { terminology: termHints } : {}),
        ...(engineId ? { engineId } : {}),
        signal,
      }).then((translatedHtml) => {
        session.inFlight.delete(index);
        if (signal.aborted || this.#disposed) return;
        let restored = restoreTerminologyHtml(this.#doc, translatedHtml, protectedResult.replacements) as string;
        restored = applyTerminologyCorrectionsHtml(this.#doc, restored, cue.text, terminology) as string;
        const plain = htmlToPlainText(this.#doc, restored);
        if (plain) {
          cue.translatedText = plain;
          this.#renderCue(session, true);
        }
      }).catch(() => {
        session.inFlight.delete(index);
        if (!signal.aborted) session.failed.add(index);
      });
    }
  }

  #renderCue(session: AttachedVideoSession, force: boolean): void {
    const mode = this.#effectiveMode(session);
    if (mode === "off") {
      session.wrapEl.hidden = true;
      session.lastCueIndex = -1;
      return;
    }
    if (!session.track || session.cues.length === 0) {
      if (session.liveDomMode) {
        this.#renderLiveDomCaption(session);
        return;
      }
      session.wrapEl.hidden = true;
      session.lastCueIndex = -1;
      return;
    }

    const currentTime = readMediaCurrentTime(session.video, session.container);
    const index = findActiveCueIndex(session.cues, currentTime);
    const cueChanged = index !== session.lastCueIndex;
    if (!force && !cueChanged) return;
    session.lastCueIndex = index;
    if (cueChanged) session.boxEl.dataset.revealed = "false";

    if (index < 0) {
      session.wrapEl.hidden = true;
      return;
    }

    const cue = session.cues[index]!;
    this.#renderCaptionTexts(session, cue.text, cue.translatedText ?? "", mode);
  }

  #renderCaptionTexts(
    session: AttachedVideoSession,
    sourceText: string,
    translatedText: string,
    mode: Exclude<EffectiveSubtitleMode, "off">,
  ): void {
    const sameText = Boolean(translatedText && translatedText.trim() === sourceText.trim());

    if (mode === "translation") {
      session.sourceEl.hidden = true;
      session.sourceEl.textContent = "";
      // While the translation for the active cue is still in flight, keep source visible
      // as an unobtrusive fallback instead of flashing blank.
      session.translationEl.hidden = false;
      session.translationEl.textContent = translatedText || sourceText;
      session.boxEl.dataset.learning = "false";
      session.boxEl.dataset.revealed = "false";
      session.wrapEl.hidden = false;
      return;
    }

    // Bilingual mode
    if (sameText) {
      session.sourceEl.hidden = true;
      session.sourceEl.textContent = "";
      session.translationEl.hidden = false;
      session.translationEl.textContent = translatedText;
      session.boxEl.dataset.learning = "false";
      session.boxEl.dataset.revealed = "false";
      session.wrapEl.hidden = false;
      return;
    }

    session.sourceEl.hidden = false;
    session.sourceEl.textContent = sourceText;
    if (translatedText) {
      session.translationEl.hidden = false;
      session.translationEl.textContent = translatedText;
      const learning = this.#settings.videoSubtitle.learningMode;
      session.boxEl.dataset.learning = learning ? "true" : "false";
      if (!learning) session.boxEl.dataset.revealed = "false";
    } else {
      session.translationEl.hidden = true;
      session.translationEl.textContent = "";
      session.boxEl.dataset.learning = "false";
      session.boxEl.dataset.revealed = "false";
    }
    session.wrapEl.hidden = false;
  }
}

let singletonManager: VideoSubtitleManager | null = null;

export function initializeVideoSubtitles(): VideoSubtitleManager {
  if (!singletonManager) {
    singletonManager = new VideoSubtitleManager();
    void singletonManager.start();
  }
  return singletonManager;
}
