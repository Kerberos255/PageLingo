// @ts-nocheck
import { PageTranslator } from "./core/page-translator";
import { RuntimeMessageProvider } from "./providers/runtime-message-provider";
import { sendRuntimeMessage } from "./shared/runtime-message";
import { isSiteListed, languageLabel, loadSettings, normalizeBilingualStyle, normalizeDetectedLanguage, normalizeDisplayMode } from "./shared/settings";
import { buildBilingualRulesCss } from "./core/bilingual-style";
import { applyTerminologyCorrectionsHtml, escapeHtml, parseTerminology, protectTerminologyHtml, restoreTerminologyHtml, sourceFingerprint, terminologyForText } from "./core/rich-segment";
import { freezeNavigationLayout, releaseNavigationLayoutAfterPaint, restoreNavigationLayout } from "./core/navigation-layout";
import { collectTranslationTelemetry } from "./core/translation-telemetry";
import {
    automaticTranslationLifecyclePending,
    automaticTranslationSettingsSignature,
} from "./shared/automatic-translation-state";
import { relativeTimeElements } from "./shared/relative-time";
import { sourceTextSample } from "./shared/source-text-sample";
import { MAX_OCR_IMAGE_SIDE } from "./image-translation/ocr-models";
import { isUiMetadataText } from "./image-translation/ocr-layout";
import { renderTranslatedImageToCanvas } from "./image-translation/image-renderer";
import { matchImageUiShortTerm, normalizeImagePunctuation } from "./image-translation/ui-short-terms";
import { initializeVideoSubtitles } from "./video-translation/video-subtitle-controller";
import { parseHtmlDocument } from "./shared/html-parser";
import { SelectionTranslatorController } from "./core/selection-popover";
import { detectForeignLanguageFromSample, extractForeignTextSample, fragmentAlreadyInTargetScript } from "./shared/mixed-language";
var translator = null;
var selectionTranslator = new SelectionTranslatorController(document);
selectionTranslator.attach();
var imageOverlays = new Map();
var imageRequests = new Map();
var imageOverlayCleanups = new WeakMap();
var lastContextMenuTarget = null;
document.addEventListener("contextmenu", (event) => {
    const target = event.composedPath?.()[0] ?? event.target;
    lastContextMenuTarget = target instanceof Node ? target : null;
}, true);
function ensureStyle(bilingualStyle = undefined) {
    let style = document.getElementById("flt-style");
    const isNew = !style;
    if (!style) {
        style = document.createElement("style");
        style.id = "flt-style";
        style.dataset.fltGenerated = "style";
    }
    const normalized = normalizeBilingualStyle(bilingualStyle);
    const nextCss = `
    .flt-translation { display: block !important; margin-block-start: 0.28em !important; font: inherit !important; line-height: inherit !important; letter-spacing: inherit !important; text-transform: none !important; }
    .flt-translation a { display: inline !important; }
    .flt-source-hidden { display: none !important; }
    .flt-source-content-hidden { font-size: 0 !important; line-height: 0 !important; }
    .flt-source-content-hidden > :not(.flt-translation) { display: none !important; }
    .flt-source-content-hidden > .flt-translation { margin-block-start: 0 !important; font-size: var(--pagelingo-source-font-size) !important; line-height: var(--pagelingo-source-line-height) !important; }
    .flt-source-list-hidden > :not(.flt-translation) { display: none !important; }
    .flt-source-list-hidden > .flt-translation { display: inline !important; margin: 0 !important; padding: 0 !important; font-size: var(--pagelingo-source-font-size) !important; line-height: var(--pagelingo-source-line-height) !important; vertical-align: baseline !important; }
    [data-flt-generated="progress"] {
      all: initial !important; position: fixed !important; z-index: 2147483646 !important; pointer-events: none !important;
      width: 10px !important; height: 10px !important; box-sizing: border-box !important; border-radius: 50% !important;
      border: 1.5px solid rgba(228, 111, 82, .33) !important; border-inline-end-color: #c64d32 !important;
      animation: pagelingo-spin .75s linear infinite !important;
    }
    @keyframes pagelingo-spin { to { transform: rotate(1turn); } }
    @media (prefers-reduced-motion: reduce) { [data-flt-generated="progress"] { animation: none !important; } }
    ${buildBilingualRulesCss(normalized, ":root")}
  `;
    if (style.textContent !== nextCss) style.textContent = nextCss;
    if (isNew) (document.head ?? document.documentElement).append(style);
}
function pageTextSample() {
    return sourceTextSample(
        document,
        4096,
        translator ? (node) => translator.originalTextForNode(node) : undefined,
    );
}
async function detectPageLanguage(sampleOverride = null) {
    const declaredLanguage = normalizeDetectedLanguage(document.documentElement.lang);
    const sample = sampleOverride ?? pageTextSample();
    if (!sample)
        return { declaredLanguage, detectedLanguage: null, effectiveLanguage: declaredLanguage, percentage: 0, isReliable: false, sampleLength: 0 };
    try {
        const result = await browser.i18n.detectLanguage(sample);
        const top = result.languages?.[0];
        const detectedLanguage = normalizeDetectedLanguage(top?.language);
        const percentage = Math.round(top?.percentage ?? 0);
        const isReliable = Boolean(result.isReliable && sample.length >= 150 && percentage >= 60);
        return {
            declaredLanguage,
            detectedLanguage,
            effectiveLanguage: isReliable ? detectedLanguage : (declaredLanguage ?? detectedLanguage),
            percentage,
            isReliable,
            sampleLength: sample.length,
        };
    }
    catch {
        return { declaredLanguage, detectedLanguage: null, effectiveLanguage: declaredLanguage, percentage: 0, isReliable: false, sampleLength: sample.length };
    }
}
function routeLocaleHint() {
    const segments = location.pathname.split("/").filter(Boolean).map((part) => part.toLowerCase());
    for (const segment of segments) {
        if (["en", "en-us", "en-gb", "en-ca", "en-au"].includes(segment)) return "en";
        if (["zh", "zh-cn", "zh-sg", "zh-hans"].includes(segment)) return "zh-Hans";
        if (["zh-tw", "zh-hk", "zh-mo", "zh-hant"].includes(segment)) return "zh-Hant";
    }
    return null;
}
async function resolveSourceLanguage(sourceLanguage, targetLanguage = null, manualOverride = false) {
    if (sourceLanguage !== "auto")
        return normalizeDetectedLanguage(sourceLanguage) ?? sourceLanguage;
    const normalizedTarget = targetLanguage ? (normalizeDetectedLanguage(targetLanguage) ?? targetLanguage) : null;
    // Explicit locale routes are the strongest automatic source-language signal.
    // This is especially important for bilingual SPA docs whose shell/sidebar can be
    // rendered in the target language while the current article is under /en/.
    const routeLanguage = routeLocaleHint();
    if (routeLanguage && (!manualOverride || routeLanguage !== normalizedTarget)) return routeLanguage;
    const declaredLanguage = normalizeDetectedLanguage(document.documentElement.lang);
    if (declaredLanguage && (!manualOverride || !normalizedTarget || declaredLanguage !== normalizedTarget)) {
        return declaredLanguage;
    }
    const info = await detectPageLanguage();
    const detected = info.detectedLanguage ?? info.effectiveLanguage;
    if (detected && (!manualOverride || !normalizedTarget || detected !== normalizedTarget)) {
        return detected;
    }
    // Mixed-language page (e.g. Chinese webmail containing English emails):
    // strip text already in targetLanguage and detect the dominant foreign language.
    if (manualOverride && normalizedTarget) {
        const foreignSample = extractForeignTextSample(document, normalizedTarget);
        const foreignLanguage = await detectForeignLanguageFromSample(foreignSample, normalizedTarget);
        if (foreignLanguage) return foreignLanguage;
    }
    if (declaredLanguage) return declaredLanguage;
    if (detected) return detected;
    throw new Error("无法可靠识别当前页面语言，请手动选择原文语言");
}
async function canTranslate(sourceLanguage, targetLanguage) {
    const response = await sendRuntimeMessage({ type: "can-translate", sourceLanguage, targetLanguage });
    if (response?.ok === false && typeof response.error === "string") throw new Error(response.error);
    return response?.ok === true && response.supported === true;
}
async function translationRouteReady(sourceLanguage, targetLanguage) {
    const response = await sendRuntimeMessage({
        type: "is-translation-ready",
        sourceLanguage,
        targetLanguage,
    });
    return response?.ok === true && response.ready === true;
}
function targetLooksChinese(targetLanguage) {
    const normalized = normalizeDetectedLanguage(targetLanguage);
    return normalized === "zh-Hans" || normalized === "zh-Hant";
}
function chineseScriptStats(value) {
    const chars = Array.from(String(value || "").replace(/\s+/g, ""));
    let han = 0, kana = 0, letters = 0;
    for (const ch of chars) {
        if (/\p{Script=Han}/u.test(ch)) han += 1;
        else if (/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(ch)) kana += 1;
        if (/\p{L}/u.test(ch)) letters += 1;
    }
    return { chars: chars.length, han, kana, letters };
}
function looksLikeChineseText(value) {
    const { chars, han, kana, letters } = chineseScriptStats(value);
    if (chars < 8 || han < 6 || kana > Math.max(2, han * 0.18)) return false;
    return han / Math.max(letters, 1) >= 0.28;
}
function looksLikeChineseFragment(value) {
    const { han, kana, letters } = chineseScriptStats(value);
    if (han < 3 || kana > Math.max(1, han * 0.18)) return false;
    return han / Math.max(letters, 1) >= 0.42;
}
function looksLikeLatinDominantText(value) {
    const chars = Array.from(String(value || ""));
    let latin = 0, letters = 0, han = 0;
    for (const ch of chars) {
        if (/\p{L}/u.test(ch)) letters += 1;
        if (/\p{Script=Latin}/u.test(ch)) latin += 1;
        if (/\p{Script=Han}/u.test(ch)) han += 1;
    }
    if (letters < 24) return false;
    return latin / letters >= 0.72 && han / letters < 0.12;
}
function routeLooksEnglish() {
    return /(?:^|\/)en(?:\/|$)/i.test(location.pathname);
}
async function detectRootLanguage(root) {
    const closestLangEl = root.lang ? root : root.closest("[lang]");
    const declared = closestLangEl && closestLangEl !== document.documentElement
        ? normalizeDetectedLanguage(closestLangEl.lang)
        : null;
    if (declared)
        return declared;
    const sample = sourceFingerprint(root, { excludeNestedRoots: true }).replace(/\s+/g, " ").trim().slice(0, 1200);
    if (sample.length < 24)
        return null;
    try {
        const result = await browser.i18n.detectLanguage(sample);
        const top = result.languages?.[0];
        if (!top || (top.percentage ?? 0) < 55)
            return null;
        return normalizeDetectedLanguage(top.language);
    }
    catch {
        return null;
    }
}
let autoTranslateGeneration = 0;
let autoTranslateInFlightGeneration = -1;
let autoTranslateInFlightPromise = null;
let activeTranslationIsAutomatic = false;
let activeTranslationSourceLanguage = null;
let activeTranslationTargetLanguage = null;
let activeAutomaticSettingsSignature = null;
var relativeTimeLangSnapshots = new Map();
var relativeTimeObserver = null;
function relativeTimeLocale(targetLanguage) {
    const normalized = normalizeDetectedLanguage(targetLanguage) ?? targetLanguage;
    if (normalized === "zh-Hans") return "zh-CN";
    if (normalized === "zh-Hant") return "zh-TW";
    return normalized;
}
function localizeRelativeTimeElements(targetLanguage, scope = document) {
    const locale = relativeTimeLocale(targetLanguage);
    if (!locale) return;
    for (const element of relativeTimeElements(scope)) {
        if (!relativeTimeLangSnapshots.has(element)) {
            relativeTimeLangSnapshots.set(element, element.getAttribute("lang"));
        }
        if (element.getAttribute("lang") !== locale) element.setAttribute("lang", locale);
    }
}
function startRelativeTimeLocalization(targetLanguage) {
    relativeTimeObserver?.disconnect();
    relativeTimeObserver = null;
    localizeRelativeTimeElements(targetLanguage, document);
    if (!document.body) return;
    relativeTimeObserver = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
            for (const added of Array.from(mutation.addedNodes)) {
                if (added.nodeType !== Node.ELEMENT_NODE) continue;
                localizeRelativeTimeElements(targetLanguage, added);
            }
        }
    });
    relativeTimeObserver.observe(document.body, { childList: true, subtree: true });
}
function stopRelativeTimeLocalization() {
    relativeTimeObserver?.disconnect();
    relativeTimeObserver = null;
    for (const [element, lang] of relativeTimeLangSnapshots) {
        if (lang === null) element.removeAttribute("lang");
        else element.setAttribute("lang", lang);
    }
    relativeTimeLangSnapshots.clear();
}
async function translatePage(sourceLanguage, targetLanguage, expectedAutoGeneration = null, manualOverride = false, bypassCache = false) {
    const stale = () => expectedAutoGeneration !== null && expectedAutoGeneration !== autoTranslateGeneration;
    const settings = await loadSettings();
    if (stale()) return 0;
    const normalizedTarget = normalizeDetectedLanguage(targetLanguage) ?? targetLanguage;
    const resolvedSource = (sourceLanguage === "auto" && translator && activeTranslationSourceLanguage)
        ? activeTranslationSourceLanguage
        : await resolveSourceLanguage(sourceLanguage, normalizedTarget, manualOverride);
    if (stale()) return 0;
    if (resolvedSource === normalizedTarget)
        return 0;
    if (!await canTranslate(resolvedSource, normalizedTarget)) {
        throw new Error(`当前本地模型不支持 ${languageLabel(resolvedSource)} → ${languageLabel(normalizedTarget)}`);
    }
    if (stale()) return 0;
    ensureStyle(settings.bilingualStyle);
    stopRelativeTimeLocalization();
    translator?.restore();
    restoreNavigationLayout();
    const automaticPass = expectedAutoGeneration !== null && !manualOverride;
    activeTranslationIsAutomatic = automaticPass;
    activeTranslationSourceLanguage = resolvedSource;
    activeTranslationTargetLanguage = normalizedTarget;
    activeAutomaticSettingsSignature = automaticPass
        ? automaticTranslationSettingsSignature(settings, routeLocaleHint(), resolvedSource)
        : null;
    const navigationHold = settings.displayMode === "translation"
        ? freezeNavigationLayout()
        : null;
    if (navigationHold) {
        startRelativeTimeLocalization(normalizedTarget);
    }
    const shouldTranslateRoot = async (root) => {
        // Inspect only source text. LI/TD/TH keep the generated translation inside the root;
        // using innerText here would mistake our own Chinese output for source-language content
        // and immediately remove the translation on the next mutation/rescan.
        const rootText = sourceFingerprint(root, { excludeNestedRoots: true }).replace(/\s+/g, " ").trim();
        if (fragmentAlreadyInTargetScript(rootText, normalizedTarget)) return false;
        if (targetLooksChinese(normalizedTarget) && looksLikeChineseFragment(rootText)) return false;
        // A direct user action outranks automatic language/site rules. Keep only the
        // per-block target-language safety check above so already-target-language fragments
        // (such as Chinese webmail menus/labels) are not sent through an English→Chinese model.
        if (manualOverride) return true;
        if (settings.neverTranslateLanguages.length === 0) return true;
        const rootLanguage = await detectRootLanguage(root);
        if (!rootLanguage) return true;
        if (rootLanguage === normalizedTarget) return false;
        return !settings.neverTranslateLanguages.includes(rootLanguage);
    };
    const pageTranslator = new PageTranslator(document, new RuntimeMessageProvider(), {
        sourceLanguage: resolvedSource,
        targetLanguage: normalizedTarget,
        showProgress: true,
        displayMode: settings.displayMode,
        bilingualStyle: settings.bilingualStyle,
        shouldTranslateRoot,
        terminology: parseTerminology(settings.glossaryCollections, resolvedSource, normalizedTarget, settings.builtinGlossaryEnabled),
        bypassCache,
    });
    translator = pageTranslator;
    let count = 0;
    try {
        count = await pageTranslator.translateAll(document.body, true);
        // Cleanup belongs to the lifecycle that performed the reset/replacement.
        // A stale pass must not call restore() here because restore() sweeps generated
        // translation DOM across the document and could erase replacement results.
        if (stale() || translator !== pageTranslator) {
            return 0;
        }
        if (count === 0 && pageTranslator.failedCount > 0) {
            throw new Error(pageTranslator.firstFailure ?? "翻译未完成，已保留原文");
        }
        pageTranslator.observe();
        pageTranslator.observeTooltips();
        return count;
    }
    finally {
        if (navigationHold) releaseNavigationLayoutAfterPaint(navigationHold);
    }
}
function normalizeAbsoluteUrl(value) {
    try {
        return new URL(value, document.baseURI).href;
    }
    catch {
        return value;
    }
}
function findImage(srcUrl) {
    const target = normalizeAbsoluteUrl(srcUrl);
    for (const image of Array.from(document.images)) {
        if (normalizeAbsoluteUrl(image.currentSrc || image.src) === target || normalizeAbsoluteUrl(image.src) === target)
            return image;
    }
    return null;
}
function ensureImageStyle() {
    if (document.getElementById("pagelingo-image-style"))
        return;
    const style = document.createElement("style");
    style.id = "pagelingo-image-style";
    style.dataset.fltGenerated = "image-style";
    style.textContent = `
    @keyframes pagelingo-img-spin { to { transform: rotate(360deg); } }
    @keyframes pagelingo-img-pulse { 0%, 100% { opacity: 0.72; } 50% { opacity: 1; } }
    [data-pagelingo-image-toolbar="true"] {
      opacity: 0.42 !important;
      transition: opacity 180ms ease, transform 180ms ease !important;
    }
    [data-pagelingo-image-toolbar="true"]:hover,
    [data-pagelingo-image-toolbar="true"]:focus-within {
      opacity: 1 !important;
    }
    @media (prefers-reduced-motion: reduce) {
      [data-pagelingo-image-spinner="true"] { animation: none !important; }
    }
  `;
    (document.head ?? document.documentElement).append(style);
}
function positionImageOverlay(image, overlay) {
    const rect = image.getBoundingClientRect();
    const computed = window.getComputedStyle(image);
    overlay.style.setProperty("left", `${rect.left + window.scrollX}px`, "important");
    overlay.style.setProperty("top", `${rect.top + window.scrollY}px`, "important");
    overlay.style.setProperty("width", `${rect.width}px`, "important");
    overlay.style.setProperty("height", `${rect.height}px`, "important");
    if (computed.borderRadius && computed.borderRadius !== "0px") {
        overlay.style.setProperty("border-radius", computed.borderRadius, "important");
    } else {
        overlay.style.removeProperty("border-radius");
    }
}
function imageLayer(image) {
    let layer = "10";
    for (let element = image; element && element !== document.body; element = element.parentElement) {
        const { position, zIndex } = window.getComputedStyle(element);
        if (position !== "static" && zIndex !== "auto") {
            const parsed = Number.parseInt(zIndex, 10);
            layer = Number.isFinite(parsed) ? String(Math.max(10, parsed + 1)) : zIndex;
        }
    }
    return layer;
}
function cleanupImageOverlay(image, overlay) {
    const cleanup = imageOverlayCleanups.get(overlay);
    if (cleanup) {
        cleanup();
        imageOverlayCleanups.delete(overlay);
    }
    overlay.remove();
    if (imageOverlays.get(image) === overlay) imageOverlays.delete(image);
    for (const [reqId, entry] of imageRequests) {
        if (entry.overlay === overlay) imageRequests.delete(reqId);
    }
}
function createImageOverlay(image) {
    ensureImageStyle();
    const previous = imageOverlays.get(image);
    if (previous) cleanupImageOverlay(image, previous);
    const overlay = document.createElement("div");
    overlay.dataset.pagelingoImageOverlay = "true";
    overlay.dataset.fltGenerated = "image-overlay";
    setImportantStyle(overlay, {
        position: "absolute",
        "z-index": imageLayer(image),
        "pointer-events": "none",
        overflow: "hidden",
        "box-sizing": "border-box",
        margin: "0",
        padding: "0",
        border: "0",
        background: "transparent",
    });
    positionImageOverlay(image, overlay);
    (document.body ?? document.documentElement).append(overlay);
    imageOverlays.set(image, overlay);

    if (typeof ResizeObserver === "function") {
        const observer = new ResizeObserver(() => {
            if (!image.isConnected || !overlay.isConnected) {
                cleanupImageOverlay(image, overlay);
                return;
            }
            positionImageOverlay(image, overlay);
        });
        observer.observe(image);
        imageOverlayCleanups.set(overlay, () => observer.disconnect());
    }
    return overlay;
}
function buildSpinnerSvg(size) {
    const spinner = document.createElement("span");
    spinner.setAttribute("aria-hidden", "true");
    spinner.dataset.pagelingoImageSpinner = "true";
    setImportantStyle(spinner, {
        display: "inline-block",
        width: `${size}px`,
        height: `${size}px`,
        "box-sizing": "border-box",
        "border-radius": "50%",
        border: "2.4px solid rgba(255, 255, 255, 0.22)",
        "border-top-color": "#f28466",
        "border-right-color": "#f28466",
        flex: "0 0 auto",
        animation: "pagelingo-img-spin 0.8s linear infinite",
    });
    return spinner;
}
function showImageLoading(overlay, status, progress = 0.08) {
    const rect = overlay.getBoundingClientRect();
    const compact = rect.height > 0 && (rect.height < 140 || rect.width < 220);
    let backdrop = overlay.querySelector("[data-pagelingo-image-loading]");
    if (!backdrop) {
        overlay.replaceChildren();
        backdrop = document.createElement("div");
        backdrop.dataset.pagelingoImageLoading = "true";
        setImportantStyle(backdrop, {
            position: "absolute",
            inset: "0",
            display: "flex",
            "align-items": "center",
            "justify-content": "center",
            padding: compact ? "8px" : "16px",
            background: "rgba(15, 18, 26, 0.24)",
            "backdrop-filter": "blur(2px)",
            "box-sizing": "border-box",
            "pointer-events": "none",
        });

        const card = document.createElement("div");
        card.dataset.pagelingoImageCard = "true";
        setImportantStyle(card, {
            display: "flex",
            "flex-direction": "column",
            "align-items": "center",
            gap: compact ? "7px" : "10px",
            width: "max-content",
            "min-width": compact ? "144px" : "188px",
            "max-width": "calc(100% - 16px)",
            padding: compact ? "10px 14px" : "14px 18px",
            "border-radius": compact ? "10px" : "14px",
            background: "rgba(20, 23, 30, 0.86)",
            "backdrop-filter": "blur(12px)",
            border: "1px solid rgba(255, 255, 255, 0.14)",
            "box-shadow": "0 10px 30px rgba(0, 0, 0, 0.28)",
            "box-sizing": "border-box",
            color: "#f8fafc",
            font: `500 ${compact ? 12 : 13}px/1.4 "PingFang SC", "Microsoft YaHei", system-ui, -apple-system, sans-serif`,
            "text-align": "center",
        });

        const header = document.createElement("div");
        setImportantStyle(header, {
            display: "flex",
            "align-items": "center",
            "justify-content": "center",
            gap: compact ? "8px" : "10px",
            width: "100%",
        });
        const spinner = buildSpinnerSvg(compact ? 16 : 20);
        const label = document.createElement("span");
        label.dataset.pagelingoImageStatusText = "true";
        setImportantStyle(label, {
            display: "inline-block",
            color: "#f8fafc",
            font: `500 ${compact ? 12 : 13}px/1.4 "PingFang SC", "Microsoft YaHei", system-ui, -apple-system, sans-serif`,
            "font-variant-numeric": "tabular-nums",
            "white-space": compact ? "normal" : "nowrap",
            "overflow-wrap": "anywhere",
        });
        header.append(spinner, label);

        const barTrack = document.createElement("div");
        setImportantStyle(barTrack, {
            display: "block",
            width: "100%",
            height: "3px",
            "border-radius": "999px",
            background: "rgba(255, 255, 255, 0.16)",
            overflow: "hidden",
        });
        const barFill = document.createElement("div");
        barFill.dataset.pagelingoImageProgressFill = "true";
        setImportantStyle(barFill, {
            display: "block",
            height: "100%",
            width: "10%",
            "border-radius": "999px",
            background: "linear-gradient(90deg, #e46f52, #f59e0b)",
            transition: "width 240ms ease",
        });
        barTrack.append(barFill);

        card.append(header, barTrack);
        backdrop.append(card);
        overlay.append(backdrop);
    }

    const labelEl = backdrop.querySelector("[data-pagelingo-image-status-text]");
    if (labelEl) labelEl.textContent = status;
    const fillEl = backdrop.querySelector("[data-pagelingo-image-progress-fill]");
    if (fillEl && typeof progress === "number" && Number.isFinite(progress)) {
        const clamped = Math.max(6, Math.min(100, Math.round(progress * 100)));
        fillEl.style.setProperty("width", `${clamped}%`, "important");
    }
}
function showImageError(image, overlay, message) {
    overlay.replaceChildren();
    const backdrop = document.createElement("div");
    backdrop.dataset.pagelingoImageStatus = "true";
    setImportantStyle(backdrop, {
        position: "absolute",
        inset: "0",
        display: "flex",
        "align-items": "center",
        "justify-content": "center",
        padding: "14px",
        background: "rgba(15, 18, 26, 0.22)",
        "box-sizing": "border-box",
        "pointer-events": "none",
    });
    const card = document.createElement("div");
    setImportantStyle(card, {
        display: "flex",
        "align-items": "center",
        gap: "10px",
        "max-width": "calc(100% - 20px)",
        padding: "10px 14px",
        "border-radius": "10px",
        background: "rgba(24, 24, 28, 0.90)",
        "backdrop-filter": "blur(10px)",
        border: "1px solid rgba(255, 255, 255, 0.14)",
        "box-shadow": "0 8px 24px rgba(0, 0, 0, 0.28)",
        color: "#f8fafc",
        font: '500 12.5px/1.4 "PingFang SC", "Microsoft YaHei", system-ui, sans-serif',
        "pointer-events": "auto",
    });
    const text = document.createElement("span");
    text.textContent = message;
    setImportantStyle(text, {
        color: "#f8fafc",
        font: '500 12.5px/1.4 "PingFang SC", "Microsoft YaHei", system-ui, sans-serif',
    });
    const close = document.createElement("button");
    close.type = "button";
    close.textContent = "×";
    close.setAttribute("aria-label", "关闭提示");
    setImportantStyle(close, {
        border: "0",
        background: "rgba(255, 255, 255, 0.14)",
        color: "#ffffff",
        width: "22px",
        height: "22px",
        "border-radius": "999px",
        display: "inline-flex",
        "align-items": "center",
        "justify-content": "center",
        cursor: "pointer",
        font: "600 14px/1 system-ui, sans-serif",
        flex: "0 0 auto",
    });
    close.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        cleanupImageOverlay(image, overlay);
    });
    card.append(text, close);
    backdrop.append(card);
    overlay.append(backdrop);
}
function setImportantStyle(element, values) {
    element.style.setProperty("all", "initial", "important");
    for (const [property, value] of Object.entries(values))
        element.style.setProperty(property, value, "important");
}
function createImageToggleToolbar(image, overlay, canvas) {
    const toolbar = document.createElement("div");
    toolbar.dataset.pagelingoImageToolbar = "true";
    setImportantStyle(toolbar, {
        position: "absolute",
        top: "8px",
        right: "8px",
        display: "inline-flex",
        "align-items": "center",
        gap: "4px",
        padding: "3px 4px",
        "border-radius": "999px",
        background: "rgba(20, 23, 30, 0.78)",
        "backdrop-filter": "blur(10px)",
        border: "1px solid rgba(255, 255, 255, 0.16)",
        "box-shadow": "0 4px 14px rgba(0, 0, 0, 0.24)",
        "pointer-events": "auto",
        "z-index": "2",
    });

    let showingTranslation = true;
    const toggleBtn = document.createElement("button");
    toggleBtn.type = "button";
    toggleBtn.textContent = "原文";
    toggleBtn.title = "切换显示原图或译文";
    setImportantStyle(toggleBtn, {
        border: "0",
        background: "transparent",
        color: "#f8fafc",
        padding: "3px 8px",
        "border-radius": "999px",
        cursor: "pointer",
        font: '500 11.5px/1.2 "PingFang SC", "Microsoft YaHei", system-ui, sans-serif',
    });
    toggleBtn.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        showingTranslation = !showingTranslation;
        canvas.style.setProperty("opacity", showingTranslation ? "1" : "0", "important");
        toggleBtn.textContent = showingTranslation ? "原文" : "译文";
    });

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.textContent = "×";
    closeBtn.title = "关闭图片翻译";
    closeBtn.setAttribute("aria-label", "关闭图片翻译");
    setImportantStyle(closeBtn, {
        border: "0",
        background: "rgba(255, 255, 255, 0.12)",
        color: "#f8fafc",
        width: "20px",
        height: "20px",
        "border-radius": "999px",
        display: "inline-flex",
        "align-items": "center",
        "justify-content": "center",
        cursor: "pointer",
        font: "600 13px/1 system-ui, sans-serif",
    });
    closeBtn.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        cleanupImageOverlay(image, overlay);
    });

    toolbar.append(toggleBtn, closeBtn);
    return toolbar;
}
function renderTranslatedRegions(image, overlay, regions, ocrWidth, ocrHeight, pixels) {
    overlay.replaceChildren();
    positionImageOverlay(image, overlay);
    if (regions.length === 0) {
        showImageError(image, overlay, "图片中未检测到需要翻译的文字");
        return;
    }

    const rect = image.getBoundingClientRect();
    const canvas = document.createElement("canvas");
    canvas.dataset.pagelingoImageCanvas = "true";
    setImportantStyle(canvas, {
        position: "absolute",
        left: "0",
        top: "0",
        width: "100%",
        height: "100%",
        display: "block",
        margin: "0",
        padding: "0",
        border: "0",
        opacity: "0",
        transition: "opacity 220ms ease",
        "pointer-events": "none",
        "box-sizing": "border-box",
    });

    const rendered = renderTranslatedImageToCanvas(canvas, {
        image,
        regions,
        ocrWidth,
        ocrHeight,
        pixels,
        displayWidth: rect.width || ocrWidth,
        displayHeight: rect.height || ocrHeight,
        devicePixelRatio: window.devicePixelRatio || 1,
        paintBaseImage: false,
    });
    if (!rendered) {
        showImageError(image, overlay, "无法创建图片画布");
        return;
    }

    overlay.append(canvas, createImageToggleToolbar(image, overlay, canvas));
    window.requestAnimationFrame(() => {
        if (canvas.isConnected) canvas.style.setProperty("opacity", "1", "important");
    });
}
async function imagePixels(srcUrl) {
    const response = await sendRuntimeMessage({ type: "fetch-image-bytes", url: srcUrl });
    if (!response?.ok || !(response.bytes instanceof ArrayBuffer))
        throw new Error(response?.error ?? "无法读取图片");
    const blob = new Blob([response.bytes], { type: response.contentType || "application/octet-stream" });
    const bitmap = await createImageBitmap(blob);
    try {
        const scale = Math.min(1, MAX_OCR_IMAGE_SIDE / Math.max(bitmap.width, bitmap.height));
        const width = Math.max(1, Math.round(bitmap.width * scale));
        const height = Math.max(1, Math.round(bitmap.height * scale));
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext("2d", { willReadFrequently: true });
        if (!context)
            throw new Error("无法创建图片画布");
        context.drawImage(bitmap, 0, 0, width, height);
        const data = context.getImageData(0, 0, width, height).data;
        const pixels = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
        return { width, height, pixels };
    }
    finally {
        bitmap.close();
    }
}
function translatedTextFromHtml(html) {
    const parsed = parseHtmlDocument(html);
    return (parsed.body.textContent ?? html)
        .replace(/\r\n?/g, "\n")
        .split("\n")
        .map((line) => line.replace(/[^\S\n]+/g, " ").trim())
        .filter(Boolean)
        .join("\n");
}
async function translateOcrRegions(regions) {
    if (regions.length === 0)
        return [];
    const settings = await loadSettings();
    const sample = regions.map((region) => region.text).join("\n").slice(0, 4096);
    const detection = await browser.i18n.detectLanguage(sample);
    const sourceLanguage = normalizeDetectedLanguage(detection.languages?.[0]?.language);
    const targetLanguage = normalizeDetectedLanguage(settings.targetLanguage) ?? settings.targetLanguage;
    if (!sourceLanguage)
        throw new Error("无法识别图片文字语言");
    if (sourceLanguage === targetLanguage)
        return regions.map((region) => ({ ...region }));
    if (!await canTranslate(sourceLanguage, targetLanguage)) {
        throw new Error(`当前翻译引擎不支持 ${languageLabel(sourceLanguage)} → ${languageLabel(targetLanguage)}`);
    }
    const provider = new RuntimeMessageProvider();
    await provider.concurrentSegments();
    const terminology = parseTerminology(settings.glossaryCollections, sourceLanguage, targetLanguage, settings.builtinGlossaryEnabled);
    return Promise.all(regions.map(async (region) => {
        // Timestamps, read receipts, counters and tiny status labels are interface
        // metadata, not message content. Keep them pixel-identical.
        if (isUiMetadataText(region.text)) return { ...region };
        const exactUiLabel = matchImageUiShortTerm(region.text, targetLanguage);
        if (exactUiLabel) return { ...region, text: exactUiLabel };
        const protectedRegion = protectTerminologyHtml(document, escapeHtml(region.text), terminology);
        let html = await provider.translateHtml({
            html: protectedRegion.html,
            sourceLanguage,
            targetLanguage,
            terminology: terminologyForText(terminology, region.text),
        });
        html = applyTerminologyCorrectionsHtml(document, html, region.text, terminology);
        const restoredHtml = restoreTerminologyHtml(document, html, protectedRegion.replacements);
        const translatedText = translatedTextFromHtml(restoredHtml) || region.text;
        return { ...region, text: normalizeImagePunctuation(translatedText) };
    }));
}
async function translateImage(srcUrl) {
    const image = findImage(srcUrl);
    if (!image)
        throw new Error("找不到当前图片，请重新右键后再试");
    const overlay = createImageOverlay(image);
    const requestId = `img-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    imageRequests.set(requestId, { image, overlay });
    showImageLoading(overlay, "正在读取图片", 0.08);
    try {
        const input = await imagePixels(srcUrl);
        if (!overlay.isConnected || imageOverlays.get(image) !== overlay)
            return;
        showImageLoading(overlay, "正在识别图片文字", 0.16);
        const response = await sendRuntimeMessage({
            type: "recognize-image",
            requestId,
            width: input.width,
            height: input.height,
            pixels: input.pixels,
        });
        if (!response?.ok || !Array.isArray(response.regions))
            throw new Error(response?.error ?? "图片文字识别失败");
        if (!overlay.isConnected || imageOverlays.get(image) !== overlay)
            return;
        showImageLoading(overlay, "正在翻译图片文字", 0.86);
        const translated = await translateOcrRegions(response.regions);
        if (!overlay.isConnected || imageOverlays.get(image) !== overlay)
            return;
        const changed = translated.filter((region, index) => {
            const source = response.regions[index]?.text ?? "";
            return region.text.replace(/\s+/g, " ").trim() !== source.replace(/\s+/g, " ").trim();
        });
        renderTranslatedRegions(image, overlay, changed, input.width, input.height, input.pixels);
    }
    catch (error) {
        if (overlay.isConnected && imageOverlays.get(image) === overlay)
            showImageError(image, overlay, error instanceof Error ? error.message : String(error));
        throw error;
    }
    finally {
        imageRequests.delete(requestId);
    }
}
function restoreImage(srcUrl) {
    const image = findImage(srcUrl);
    if (!image)
        return false;
    const overlay = imageOverlays.get(image);
    if (!overlay)
        return false;
    cleanupImageOverlay(image, overlay);
    return true;
}
async function toggleImageTranslation(srcUrl) {
    const image = findImage(srcUrl);
    if (!image)
        throw new Error("找不到当前图片，请重新右键后再试");
    if (imageOverlays.has(image)) {
        restoreImage(srcUrl);
        return false;
    }
    await translateImage(srcUrl);
    return imageOverlays.has(image);
}
async function togglePageTranslation() {
    if (translator) {
        translator.restore();
        translator = null;
        activeTranslationIsAutomatic = false;
        activeTranslationSourceLanguage = null;
        activeTranslationTargetLanguage = null;
        activeAutomaticSettingsSignature = null;
        stopRelativeTimeLocalization();
        restoreNavigationLayout();
        document.getElementById("flt-style")?.remove();
        return { translated: false, count: 0 };
    }
    const settings = await loadSettings();
    const count = await translatePage("auto", settings.targetLanguage, null, true);
    return { translated: true, count };
}
function refreshImageOverlayPositions() {
    for (const [image, overlay] of imageOverlays) {
        if (!image.isConnected) {
            cleanupImageOverlay(image, overlay);
            continue;
        }
        positionImageOverlay(image, overlay);
    }
}
window.addEventListener("resize", refreshImageOverlayPositions, { passive: true });
window.addEventListener("scroll", refreshImageOverlayPositions, { passive: true });
browser.runtime.onMessage.addListener(async (message) => {
    if (message.type === "image-translation-progress") {
        const entry = typeof message.requestId === "string"
            ? imageRequests.get(message.requestId)
            : Array.from(imageRequests.values()).at(-1);
        if (entry?.overlay?.isConnected && typeof message.status === "string") {
            showImageLoading(entry.overlay, message.status, typeof message.progress === "number" ? message.progress : undefined);
        }
        return { ok: true };
    }
    if (message.type === "translate-image") {
        try {
            if (typeof message.srcUrl !== "string")
                throw new Error("图片地址无效");
            await translateImage(message.srcUrl);
            return { ok: true, translated: true };
        }
        catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
    }
    if (message.type === "toggle-image-translation") {
        try {
            if (typeof message.srcUrl !== "string")
                throw new Error("图片地址无效");
            const translated = await toggleImageTranslation(message.srcUrl);
            return { ok: true, translated };
        }
        catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
    }
    if (message.type === "get-context-menu-state") {
        const image = typeof message.srcUrl === "string" ? findImage(message.srcUrl) : null;
        const segmentRoot = translator ? translator.findTranslatedRootForNode(lastContextMenuTarget) : null;
        return {
            ok: true,
            pageTranslated: Boolean(translator),
            imageTranslated: Boolean(image && imageOverlays.has(image)),
            canRetranslateSegment: Boolean(segmentRoot),
        };
    }
    if (message.type === "translate-selection") {
        try {
            const selectionText = typeof message.selectionText === "string" ? message.selectionText : undefined;
            void selectionTranslator.translateSelection(selectionText);
            return { ok: true };
        }
        catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
    }
    if (message.type === "retranslate-segment") {
        try {
            if (!translator) throw new Error("当前页面尚未翻译");
            const segmentRoot = translator.findTranslatedRootForNode(lastContextMenuTarget);
            if (!segmentRoot) throw new Error("当前位置没有可重新翻译的段落");
            const translated = await translator.retranslateRoot(segmentRoot, { bypassCache: true });
            return { ok: true, translated };
        }
        catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
    }
    if (message.type === "toggle-page-translation") {
        try {
            const result = await togglePageTranslation();
            return { ok: true, ...result };
        }
        catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
    }
    if (message.type === "ping")
        return { ok: true };
    if (message.type === "get-dom-translation-telemetry") {
        try {
            if (!document.body) throw new Error("Document body is not ready");
            return { ok: true, telemetry: collectTranslationTelemetry(document.body) };
        }
        catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
    }
    if (message.type === "get-page-language") {
        const language = translator && activeTranslationSourceLanguage
            ? {
                declaredLanguage: activeTranslationSourceLanguage,
                detectedLanguage: activeTranslationSourceLanguage,
                effectiveLanguage: activeTranslationSourceLanguage,
                percentage: 100,
                isReliable: true,
                sampleLength: 0,
            }
            : await detectPageLanguage();
        return { ok: true, pageTranslated: Boolean(translator), language };
    }
    if (message.type === "translate-page") {
        try {
            const settings = await loadSettings();
            const count = await translatePage(
                message.sourceLanguage ?? "auto",
                message.targetLanguage ?? settings.targetLanguage,
                null,
                true,
                message.bypassCache === true,
            );
            return { ok: true, count, failedCount: translator?.failedCount ?? 0 };
        }
        catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
    }
    if (message.type === "restore-page") {
        translator?.restore();
        translator = null;
        selectionTranslator.closePopover();
        for (const el of Array.from(document.querySelectorAll('[data-pagelingo-selection-inline="true"]'))) el.remove();
        activeTranslationIsAutomatic = false;
        activeTranslationSourceLanguage = null;
        activeTranslationTargetLanguage = null;
        activeAutomaticSettingsSignature = null;
        stopRelativeTimeLocalization();
        restoreNavigationLayout();
        document.getElementById("flt-style")?.remove();
        return { ok: true };
    }
    return undefined;
});
void loadSettings().then((settings) => {
    selectionTranslator.setQuickButtonEnabled(settings.selectionQuickTranslateButton);
}).catch(() => {});
browser.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") return;
    if (changes.selectionQuickTranslateButton) {
        selectionTranslator.setQuickButtonEnabled(changes.selectionQuickTranslateButton.newValue === true);
    }
    if (!translator)
        return;
    if (changes.displayMode) {
        const mode = normalizeDisplayMode(changes.displayMode.newValue);
        const navigationHold = mode === "translation" ? freezeNavigationLayout() : null;
        if (mode === "translation") {
            if (activeTranslationTargetLanguage) startRelativeTimeLocalization(activeTranslationTargetLanguage);
        } else {
            restoreNavigationLayout();
            stopRelativeTimeLocalization();
        }
        translator.setDisplayMode(mode);
        if (navigationHold) releaseNavigationLayoutAfterPaint(navigationHold);
    }
    if (changes.bilingualStyle) {
        const nextStyle = normalizeBilingualStyle(changes.bilingualStyle.newValue);
        ensureStyle(nextStyle);
        translator.setBilingualStyle(nextStyle);
    }
});
const AUTO_TRANSLATION_INVALIDATING_SETTINGS = new Set([
    "autoTranslateEnabled",
    "targetLanguage",
    "neverTranslateSites",
    "alwaysTranslateSites",
    "neverTranslateLanguages",
    "alwaysTranslateLanguages",
    "builtinGlossaryEnabled",
    "glossaryCollections",
]);
browser.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local")
        return;
    if (!Object.keys(changes).some((key) => AUTO_TRANSLATION_INVALIDATING_SETTINGS.has(key)))
        return;
    if (!automaticTranslationLifecyclePending(
        activeTranslationIsAutomatic,
        autoTranslateInFlightGeneration,
    ))
        return;
    autoTranslateGeneration += 1;
    routeRescanGeneration += 1;
    clearRouteRescanTimers();
    softResetForRoute();
    void maybeAutoTranslate(autoTranslateGeneration);
});
async function resolveAutomaticSourceLanguage(targetLanguage) {
    // Translation-only mode mutates text nodes in place; source detection must ignore
    // PageLingo's generated/mutated target-language nodes and read the underlying source text.
    const sample = pageTextSample();
    const routeLanguage = routeLocaleHint();
    // Never let a target-language shell/sidebar veto an explicit source-locale route.
    // /en/ pages can legitimately contain Chinese navigation while the article remains English.
    if (targetLooksChinese(targetLanguage) && looksLikeChineseText(sample) && !routeLanguage) {
        return { sourceLanguage: null, routeLanguage, info: null };
    }
    const info = await detectPageLanguage(sample);
    let sourceLanguage = routeLanguage ?? info.declaredLanguage ?? info.effectiveLanguage;
    // An explicit page locale is a stronger hint than statistical detection when its
    // script agrees with the visible text. Technical documentation can contain enough
    // package names, commands, hashes and identifiers for browser.i18n.detectLanguage()
    // to confidently misclassify English as another Latin-script language. In that case
    // trusting the detector makes PageLingo probe the wrong model route and silently skip
    // automatic translation. Preserve a declared English locale (or an /en/ route) when
    // the current article is overwhelmingly Latin text.
    if (looksLikeLatinDominantText(sample) && (info.declaredLanguage === "en" || routeLooksEnglish())) {
        sourceLanguage = "en";
    }
    // Bilingual SPAs can briefly keep the previous locale's <html lang> while the new
    // route content is already rendered. If a stale Chinese declaration survives while
    // the article is clearly Latin text, prefer a non-target detector result, then /en/.
    else if (targetLooksChinese(targetLanguage) && sourceLanguage === targetLanguage && looksLikeLatinDominantText(sample)) {
        const detected = info.detectedLanguage;
        sourceLanguage = detected && detected !== targetLanguage
            ? detected
            : (routeLooksEnglish() ? "en" : sourceLanguage);
    }
    return { sourceLanguage, routeLanguage, info };
}

async function runAutoTranslate(generation) {
    if (window.top !== window || generation !== autoTranslateGeneration)
        return;
    const settings = await loadSettings();
    if (generation !== autoTranslateGeneration) return;
    if (isSiteListed(location.hostname, settings.neverTranslateSites))
        return;
    const targetLanguage = normalizeDetectedLanguage(settings.targetLanguage) ?? settings.targetLanguage;
    const alwaysSite = isSiteListed(location.hostname, settings.alwaysTranslateSites);
    const resolved = await resolveAutomaticSourceLanguage(targetLanguage);
    if (generation !== autoTranslateGeneration) return;
    let { sourceLanguage, info } = resolved;
    if (alwaysSite && (!sourceLanguage || sourceLanguage === targetLanguage)) {
        const foreignSample = extractForeignTextSample(document, targetLanguage);
        sourceLanguage = await detectForeignLanguageFromSample(foreignSample, targetLanguage);
        if (generation !== autoTranslateGeneration) return;
    }
    if (!sourceLanguage || sourceLanguage === targetLanguage)
        return;
    if (!alwaysSite && settings.neverTranslateLanguages.includes(sourceLanguage))
        return;
    const explicitAlways = alwaysSite || settings.alwaysTranslateLanguages.includes(sourceLanguage);
    if (!explicitAlways) {
        if (!settings.autoTranslateEnabled)
            return;
        if (!await translationRouteReady(sourceLanguage, targetLanguage)) {
            console.info("[PageLingo] Automatic translation skipped: route not ready", {
                declaredLanguage: info?.declaredLanguage ?? null,
                detectedLanguage: info?.detectedLanguage ?? null,
                effectiveLanguage: info?.effectiveLanguage ?? null,
                sourceLanguage,
                targetLanguage,
                detectorReliable: info?.isReliable ?? false,
                detectorPercentage: info?.percentage ?? 0,
            });
            return;
        }
        if (generation !== autoTranslateGeneration) return;
    }
    try {
        await translatePage(sourceLanguage, targetLanguage, generation);
    }
    catch (error) {
        if (generation === autoTranslateGeneration) console.warn("[PageLingo] Automatic translation failed", error);
    }
}
function maybeAutoTranslate(generation = autoTranslateGeneration) {
    if (autoTranslateInFlightPromise && autoTranslateInFlightGeneration === generation) return autoTranslateInFlightPromise;
    const promise = runAutoTranslate(generation);
    autoTranslateInFlightGeneration = generation;
    autoTranslateInFlightPromise = promise.finally(() => {
        if (autoTranslateInFlightPromise === promise || autoTranslateInFlightGeneration === generation) {
            autoTranslateInFlightPromise = null;
            autoTranslateInFlightGeneration = -1;
        }
    });
    return autoTranslateInFlightPromise;
}

// Treat SPA navigation as a fresh translation lifecycle. Reusing records across routes is
// unsafe because frameworks frequently keep the same DOM nodes and mutate their text. That can
// leave stale fingerprints/in-flight work attached to the new page and cause partial translation.
// A soft reset restores the source DOM, invalidates old async work, releases old navigation-slot
// widths, then rebuilds translation state for the current route. Later passes only rescan newly
// settled content.
let lastObservedUrl = location.href;
let routeRescanGeneration = 0;
let routeRescanTimers = [];
function clearRouteRescanTimers() {
    for (const timer of routeRescanTimers) clearTimeout(timer);
    routeRescanTimers = [];
}
function softResetForRoute() {
    translator?.restore();
    translator = null;
    activeTranslationIsAutomatic = false;
    activeTranslationSourceLanguage = null;
    activeTranslationTargetLanguage = null;
    activeAutomaticSettingsSignature = null;
    stopRelativeTimeLocalization();
    restoreNavigationLayout();
    document.getElementById("flt-style")?.remove();
}
function preserveTranslationAcrossRoute() {
    return Boolean(
        translator &&
        (!activeTranslationIsAutomatic || location.hostname.toLowerCase() === "github.com")
    );
}
async function rescanAfterRouteChange(generation) {
    if (generation !== routeRescanGeneration || window.top !== window) return;
    try {
        const settings = await loadSettings();
        let currentSourceLanguage = null;
        let currentRouteLanguage = routeLocaleHint();
        if (translator && activeTranslationIsAutomatic) {
            const targetLanguage = normalizeDetectedLanguage(settings.targetLanguage) ?? settings.targetLanguage;
            const resolved = await resolveAutomaticSourceLanguage(targetLanguage);
            if (generation !== routeRescanGeneration) return;
            currentSourceLanguage = resolved.sourceLanguage;
            currentRouteLanguage = resolved.routeLanguage;
        }
        const currentAutomaticSignature = automaticTranslationSettingsSignature(
            settings,
            currentRouteLanguage,
            currentSourceLanguage,
        );
        if (
            translator &&
            activeTranslationIsAutomatic &&
            activeAutomaticSettingsSignature !== currentAutomaticSignature
        ) {
            softResetForRoute();
        }
        const manual = translator && !activeTranslationIsAutomatic;
        if (!manual && isSiteListed(location.hostname, settings.neverTranslateSites)) return;
        const alwaysSite = isSiteListed(location.hostname, settings.alwaysTranslateSites);
        if (!manual && !alwaysSite && !settings.autoTranslateEnabled) return;
        if (!translator) {
            await maybeAutoTranslate(autoTranslateGeneration);
            return;
        }
        // New navigation nodes can arrive after the first route render. Preserve their original
        // source-language box widths before translating any newly discovered roots.
        const navigationHold = settings.displayMode === "translation"
            ? freezeNavigationLayout(false)
            : null;
        if (navigationHold && activeTranslationTargetLanguage) {
            localizeRelativeTimeElements(activeTranslationTargetLanguage, document);
        }
        try {
            await translator.translateAll(document.body);
            translator.observe();
            translator.observeTooltips();
        }
        finally {
            if (navigationHold) releaseNavigationLayoutAfterPaint(navigationHold);
        }
    } catch (error) {
        console.warn("[PageLingo] SPA translation rescan failed", error);
    }
}
function scheduleRouteResetAndRescan() {
    routeRescanGeneration += 1;
    autoTranslateGeneration += 1;
    const generation = routeRescanGeneration;
    clearRouteRescanTimers();
    // GitHub is a Turbo/SPA app whose persistent repository navigation is frequently
    // re-rendered after the first automatic translation pass. Restoring the whole page
    // here creates a visible English flash and can leave the persistent navigation in
    // English if the later automatic pass is skipped. Keep the active automatic
    // translator alive on GitHub and let its MutationObserver + settlement rescans
    // translate only the route content that actually changed.
    if (!preserveTranslationAcrossRoute()) {
        softResetForRoute();
    }
    // One early rebuild plus later settlement passes. The translator observer remains active
    // between passes, so async route content is handled both reactively and deterministically.
    routeRescanTimers = [100, 360, 900, 1800, 3200].map((delay) => setTimeout(() => {
        void rescanAfterRouteChange(generation);
    }, delay));
}
function noticePossibleRouteChange() {
    const currentUrl = location.href;
    if (currentUrl === lastObservedUrl) return;
    lastObservedUrl = currentUrl;
    scheduleRouteResetAndRescan();
}
if (window.top === window) {
    window.addEventListener("popstate", () => { setTimeout(noticePossibleRouteChange, 0); }, { passive: true });
    window.addEventListener("hashchange", () => { setTimeout(noticePossibleRouteChange, 0); }, { passive: true });
    document.addEventListener("click", (event) => {
        const target = event.target instanceof Element ? event.target.closest("a[href]") : null;
        if (!(target instanceof HTMLAnchorElement)) return;
        try {
            const next = new URL(target.href, location.href);
            if (next.origin === location.origin && next.href !== location.href) {
                setTimeout(noticePossibleRouteChange, 0);
                setTimeout(noticePossibleRouteChange, 120);
            }
        } catch {}
    }, true);
    setInterval(noticePossibleRouteChange, 400);
}
void maybeAutoTranslate(autoTranslateGeneration);
initializeVideoSubtitles();
