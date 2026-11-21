// @ts-nocheck
import { PageTranslator } from "./core/page-translator";
import { RuntimeMessageProvider } from "./providers/runtime-message-provider";
import { sendRuntimeMessage } from "./shared/runtime-message";
import { isSiteListed, languageLabel, loadSettings, normalizeDetectedLanguage, normalizeDisplayMode } from "./shared/settings";
import { applyTerminologyCorrectionsHtml, escapeHtml, parseTerminology, protectTerminologyHtml, restoreTerminologyHtml, sourceFingerprint, terminologyForText } from "./core/rich-segment";
import { freezeNavigationLayout, releaseNavigationLayoutAfterPaint, restoreNavigationLayout } from "./core/navigation-layout";
import { collectTranslationTelemetry } from "./core/translation-telemetry";
import {
    automaticTranslationLifecyclePending,
    automaticTranslationSettingsSignature,
} from "./shared/automatic-translation-state";
import { relativeTimeElements } from "./shared/relative-time";
import { sourceTextSample } from "./shared/source-text-sample";
import { isUiMetadataText } from "./image-translation/ocr-layout";
import { renderTranslatedImageToCanvas } from "./image-translation/image-renderer";
var translator = null;
var imageOverlays = new Map();
var imageResizeObservers = new Map();
var activeImageRequests = new Map();
var activeImageOverlay = null;
function ensureStyle() {
    if (document.getElementById("flt-style"))
        return;
    const style = document.createElement("style");
    style.id = "flt-style";
    style.dataset.fltGenerated = "style";
    style.textContent = `
    .flt-translation { display: block !important; margin-block-start: 0.28em !important; font: inherit !important; line-height: inherit !important; letter-spacing: inherit !important; text-transform: none !important; }
    .flt-translation a { display: inline !important; }
    .flt-source-hidden { display: none !important; }
    .flt-source-content-hidden { font-size: 0 !important; line-height: 0 !important; }
    .flt-source-content-hidden > :not(.flt-translation) { display: none !important; }
    .flt-source-content-hidden > .flt-translation { margin-block-start: 0 !important; font-size: var(--pagelingo-source-font-size) !important; line-height: var(--pagelingo-source-line-height) !important; }
    .flt-source-list-hidden > :not(.flt-translation) { display: none !important; }
    .flt-source-list-hidden > .flt-translation { display: inline !important; margin: 0 !important; padding: 0 !important; font-size: var(--pagelingo-source-font-size) !important; line-height: var(--pagelingo-source-line-height) !important; vertical-align: baseline !important; }
  `;
    document.documentElement.append(style);
}
function pageTextSample() {
    const root = document.querySelector("article, main, [role='main']") ?? document.body;
    if (!root)
        return "";
    return (root.innerText || root.textContent || "").replace(/\s+/g, " ").trim().slice(0, 4096);
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
async function resolveSourceLanguage(sourceLanguage) {
    if (sourceLanguage !== "auto")
        return normalizeDetectedLanguage(sourceLanguage) ?? sourceLanguage;
    // Explicit locale routes are the strongest automatic source-language signal.
    // This is especially important for bilingual SPA docs whose shell/sidebar can be
    // rendered in the target language while the current article is under /en/.
    const routeLanguage = routeLocaleHint();
    if (routeLanguage) return routeLanguage;
    const declaredLanguage = normalizeDetectedLanguage(document.documentElement.lang);
    if (declaredLanguage) return declaredLanguage;
    const info = await detectPageLanguage();
    if (info.detectedLanguage) return info.detectedLanguage;
    if (info.effectiveLanguage) return info.effectiveLanguage;
    throw new Error("无法可靠识别当前页面语言，请手动选择原文语言");
}
async function canTranslate(sourceLanguage, targetLanguage) {
    const response = await sendRuntimeMessage({ type: "can-translate", sourceLanguage, targetLanguage });
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
    const declared = normalizeDetectedLanguage(root.lang || root.closest("[lang]")?.lang);
    if (declared)
        return declared;
    const sample = (root.innerText || root.textContent || "").replace(/\s+/g, " ").trim().slice(0, 1200);
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
async function translatePage(sourceLanguage, targetLanguage, expectedAutoGeneration = null, manualOverride = false) {
    const stale = () => expectedAutoGeneration !== null && expectedAutoGeneration !== autoTranslateGeneration;
    const settings = await loadSettings();
    if (stale()) return 0;
    const resolvedSource = await resolveSourceLanguage(sourceLanguage);
    if (stale()) return 0;
    const normalizedTarget = normalizeDetectedLanguage(targetLanguage) ?? targetLanguage;
    if (resolvedSource === normalizedTarget)
        throw new Error("当前页面已经是目标语言");
    if (!await canTranslate(resolvedSource, normalizedTarget)) {
        throw new Error(`当前本地模型不支持 ${languageLabel(resolvedSource)} → ${languageLabel(normalizedTarget)}`);
    }
    if (stale()) return 0;
    ensureStyle();
    stopRelativeTimeLocalization();
    translator?.restore();
    restoreNavigationLayout();
    const automaticPass = expectedAutoGeneration !== null && !manualOverride;
    activeTranslationIsAutomatic = automaticPass;
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
        const rootText = sourceFingerprint(root).replace(/\s+/g, " ").trim();
        if (targetLooksChinese(normalizedTarget) && looksLikeChineseFragment(rootText)) return false;
        // A direct user action outranks automatic language/site rules. Keep only the
        // per-block target-language safety check above so already-Chinese fragments
        // are not sent through an English→Chinese model again.
        if (manualOverride) return true;
        if (settings.neverTranslateLanguages.length === 0) return true;
        const rootLanguage = await detectRootLanguage(root);
        if (!rootLanguage) return true;
        if (rootLanguage === normalizedTarget) return false;
        return !settings.neverTranslateLanguages.includes(rootLanguage);
    };
    const provider = new RuntimeMessageProvider();
    const executionProfile = await provider.getExecutionProfile();
    if (stale()) return 0;
    const pageTranslator = new PageTranslator(document, provider, {
        sourceLanguage: resolvedSource,
        targetLanguage: normalizedTarget,
        concurrency: executionProfile.recommendedConcurrency,
        displayMode: settings.displayMode,
        shouldTranslateRoot,
        terminology: parseTerminology(settings.glossaryCollections, resolvedSource, normalizedTarget, settings.builtinGlossaryEnabled),
    });
    translator = pageTranslator;
    let count = 0;
    try {
        count = await pageTranslator.translateAll();
        // Cleanup belongs to the lifecycle that performed the reset/replacement.
        // A stale pass must not call restore() here because restore() sweeps generated
        // translation DOM across the document and could erase replacement results.
        if (stale() || translator !== pageTranslator) {
            return 0;
        }
        pageTranslator.observe();
        pageTranslator.observeTooltips();
        return count;
    }
    finally {
        if (navigationHold) releaseNavigationLayoutAfterPaint(navigationHold);
    }
}
function ensureImageOverlayStyle() {
    if (document.getElementById("pagelingo-image-style"))
        return;
    const style = document.createElement("style");
    style.id = "pagelingo-image-style";
    style.dataset.pagelingoImageGenerated = "style";
    style.textContent = `
    @keyframes pagelingo-image-spin {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }
    [data-pagelingo-image-toolbar] {
      opacity: 0.36 !important;
      transition: opacity 160ms ease !important;
    }
    [data-pagelingo-image-toolbar]:hover,
    [data-pagelingo-image-toolbar]:focus-within {
      opacity: 1 !important;
    }
    [data-pagelingo-image-toolbar] button:hover {
      background: rgba(255, 255, 255, 0.2) !important;
    }
  `;
    document.documentElement.append(style);
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
function positionImageOverlay(image, overlay) {
    const rect = image.getBoundingClientRect();
    overlay.style.setProperty("left", `${rect.left + window.scrollX}px`, "important");
    overlay.style.setProperty("top", `${rect.top + window.scrollY}px`, "important");
    overlay.style.setProperty("width", `${rect.width}px`, "important");
    overlay.style.setProperty("height", `${rect.height}px`, "important");
    const computed = window.getComputedStyle?.(image);
    if (computed?.borderRadius) {
        overlay.style.setProperty("border-radius", computed.borderRadius, "important");
    }
}
function disposeImageOverlay(image) {
    const overlay = imageOverlays.get(image);
    if (overlay) {
        overlay.remove();
        imageOverlays.delete(image);
        if (activeImageOverlay === overlay) activeImageOverlay = null;
        for (const [id, candidate] of activeImageRequests) {
            if (candidate === overlay) activeImageRequests.delete(id);
        }
    }
    const resizeObserver = imageResizeObservers.get(image);
    if (resizeObserver) {
        resizeObserver.disconnect();
        imageResizeObservers.delete(image);
    }
}
function createImageOverlay(image) {
    ensureImageOverlayStyle();
    disposeImageOverlay(image);
    const overlay = document.createElement("div");
    overlay.dataset.pagelingoImageOverlay = "true";
    setImportantStyle(overlay, {
        position: "absolute",
        "z-index": "2147483646",
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
        const ro = new ResizeObserver(() => {
            if (!image.isConnected) {
                disposeImageOverlay(image);
                return;
            }
            positionImageOverlay(image, overlay);
        });
        ro.observe(image);
        imageResizeObservers.set(image, ro);
    }
    return overlay;
}
function createImageSpinnerSvg() {
    const svgNS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(svgNS, "svg");
    svg.setAttribute("viewBox", "0 0 36 36");
    svg.setAttribute("width", "30");
    svg.setAttribute("height", "30");
    svg.setAttribute("aria-hidden", "true");
    setImportantStyle(svg, {
        display: "block",
        width: "30px",
        height: "30px",
        "flex-shrink": "0",
        animation: "pagelingo-image-spin 0.85s linear infinite",
    });
    const track = document.createElementNS(svgNS, "circle");
    track.setAttribute("cx", "18");
    track.setAttribute("cy", "18");
    track.setAttribute("r", "14");
    track.setAttribute("fill", "none");
    track.setAttribute("stroke", "rgba(255, 255, 255, 0.28)");
    track.setAttribute("stroke-width", "3");
    const arc = document.createElementNS(svgNS, "circle");
    arc.setAttribute("cx", "18");
    arc.setAttribute("cy", "18");
    arc.setAttribute("r", "14");
    arc.setAttribute("fill", "none");
    arc.setAttribute("stroke", "#ffffff");
    arc.setAttribute("stroke-width", "3");
    arc.setAttribute("stroke-linecap", "round");
    arc.setAttribute("stroke-dasharray", "52 38");
    svg.append(track, arc);
    return svg;
}
function parseImageProgressStatus(rawStatus) {
    const text = String(rawStatus ?? "").trim();
    const countMatch = text.match(/\((\d+)\/(\d+)\)$/);
    if (countMatch) {
        const current = Number.parseInt(countMatch[1], 10);
        const total = Number.parseInt(countMatch[2], 10);
        const label = text.slice(0, countMatch.index).trim() || "识别文字中…";
        const ratio = total > 0 ? Math.max(0, Math.min(1, current / total)) : null;
        return { label, ratio };
    }
    return { label: text || "翻译中…", ratio: null };
}
function showImageStatus(overlay, status, options = {}) {
    const isError = options.error === true;
    const onDismiss = typeof options.onDismiss === "function" ? options.onDismiss : null;
    let card = overlay.querySelector("[data-pagelingo-image-status]");
    if (!card || card.dataset.pagelingoImageError !== (isError ? "true" : "false")) {
        card?.remove();
        card = document.createElement("div");
        card.dataset.pagelingoImageStatus = "true";
        card.dataset.pagelingoImageError = isError ? "true" : "false";
        setImportantStyle(card, {
            position: "absolute",
            left: "50%",
            top: "50%",
            transform: "translate(-50%, -50%)",
            display: "flex",
            "flex-direction": "column",
            "align-items": "center",
            "justify-content": "center",
            gap: "9px",
            "min-width": isError ? "148px" : "112px",
            "max-width": "calc(100% - 24px)",
            padding: isError ? "12px 16px" : "14px 18px",
            "border-radius": "14px",
            background: isError ? "rgba(28, 22, 24, 0.78)" : "rgba(24, 26, 32, 0.60)",
            "backdrop-filter": "blur(8px)",
            "-webkit-backdrop-filter": "blur(8px)",
            border: "1px solid rgba(255, 255, 255, 0.14)",
            color: "#ffffff",
            font: '500 13px/1.35 "PingFang SC", "Microsoft YaHei", system-ui, sans-serif',
            "text-align": "center",
            "box-shadow": "0 8px 24px rgba(0, 0, 0, 0.26)",
            "white-space": "normal",
            "box-sizing": "border-box",
            "pointer-events": isError ? "auto" : "none",
        });
        if (!isError) {
            card.append(createImageSpinnerSvg());
        }
        const labelEl = document.createElement("span");
        labelEl.dataset.pagelingoImageLabel = "true";
        setImportantStyle(labelEl, {
            display: "block",
            color: "#ffffff",
            font: '500 13px/1.35 "PingFang SC", "Microsoft YaHei", system-ui, sans-serif',
            "text-align": "center",
            "text-shadow": "0 1px 2px rgba(0, 0, 0, 0.3)",
            "white-space": "normal",
        });
        card.append(labelEl);

        if (!isError) {
            const barTrack = document.createElement("div");
            barTrack.dataset.pagelingoImageBarTrack = "true";
            setImportantStyle(barTrack, {
                display: "none",
                width: "84px",
                height: "3px",
                "border-radius": "999px",
                background: "rgba(255, 255, 255, 0.22)",
                overflow: "hidden",
            });
            const barFill = document.createElement("div");
            barFill.dataset.pagelingoImageBarFill = "true";
            setImportantStyle(barFill, {
                display: "block",
                width: "0%",
                height: "100%",
                "border-radius": "999px",
                background: "#ffffff",
                transition: "width 140ms ease-out",
            });
            barTrack.append(barFill);
            card.append(barTrack);
        }
        else if (onDismiss) {
            const closeBtn = document.createElement("button");
            closeBtn.type = "button";
            closeBtn.textContent = "关闭";
            setImportantStyle(closeBtn, {
                display: "inline-flex",
                "align-items": "center",
                "justify-content": "center",
                padding: "4px 10px",
                "border-radius": "999px",
                background: "rgba(255, 255, 255, 0.16)",
                color: "#ffffff",
                font: '500 12px/1.2 "PingFang SC", "Microsoft YaHei", system-ui, sans-serif',
                cursor: "pointer",
                border: "0",
            });
            closeBtn.addEventListener("click", (event) => {
                event.stopPropagation();
                onDismiss();
            });
            card.append(closeBtn);
        }
        overlay.append(card);
    }
    const labelEl = card.querySelector("[data-pagelingo-image-label]");
    const barTrack = card.querySelector("[data-pagelingo-image-bar-track]");
    const barFill = card.querySelector("[data-pagelingo-image-bar-fill]");
    if (isError) {
        if (labelEl) labelEl.textContent = status;
        return;
    }
    const parsed = parseImageProgressStatus(status);
    if (labelEl) labelEl.textContent = parsed.label;
    if (barTrack && barFill) {
        if (parsed.ratio !== null) {
            barTrack.style.setProperty("display", "block", "important");
            barFill.style.setProperty("width", `${Math.round(parsed.ratio * 100)}%`, "important");
        }
        else {
            barTrack.style.setProperty("display", "none", "important");
        }
    }
}
function setImportantStyle(element, values) {
    element.style.setProperty("all", "initial", "important");
    for (const [property, value] of Object.entries(values))
        element.style.setProperty(property, value, "important");
}
function createImageOverlayToolbar(image, canvas) {
    const toolbar = document.createElement("div");
    toolbar.dataset.pagelingoImageToolbar = "true";
    setImportantStyle(toolbar, {
        position: "absolute",
        top: "8px",
        right: "8px",
        display: "inline-flex",
        "align-items": "center",
        gap: "2px",
        padding: "3px 4px",
        "border-radius": "999px",
        background: "rgba(20, 22, 28, 0.68)",
        "backdrop-filter": "blur(8px)",
        "-webkit-backdrop-filter": "blur(8px)",
        border: "1px solid rgba(255, 255, 255, 0.16)",
        "box-shadow": "0 4px 12px rgba(0, 0, 0, 0.22)",
        "pointer-events": "auto",
        "z-index": "2",
    });

    const buttonStyle = {
        display: "inline-flex",
        "align-items": "center",
        "justify-content": "center",
        padding: "3px 8px",
        "border-radius": "999px",
        background: "transparent",
        color: "#ffffff",
        font: '500 11px/1.2 "PingFang SC", "Microsoft YaHei", system-ui, sans-serif',
        cursor: "pointer",
        border: "0",
        "white-space": "nowrap",
    };

    let showingTranslation = true;
    const toggleBtn = document.createElement("button");
    toggleBtn.type = "button";
    toggleBtn.textContent = "原文";
    toggleBtn.title = "切换原文与译文";
    setImportantStyle(toggleBtn, buttonStyle);
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
    closeBtn.title = "关闭图片译文";
    closeBtn.setAttribute("aria-label", "关闭图片译文");
    setImportantStyle(closeBtn, { ...buttonStyle, padding: "3px 6px", "font-size": "13px" });
    closeBtn.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        disposeImageOverlay(image);
    });

    toolbar.append(toggleBtn, closeBtn);
    return toolbar;
}
function renderTranslatedRegions(image, overlay, regions, ocrWidth, ocrHeight, pixels) {
    overlay.replaceChildren();
    positionImageOverlay(image, overlay);
    if (regions.length === 0) {
        showImageStatus(overlay, "未检测到需要翻译的文字", {
            error: true,
            onDismiss: () => disposeImageOverlay(image),
        });
        return;
    }

    // Render the whole translated image on one high-DPI canvas. This keeps every region in
    // one coordinate system, avoids page CSS leaking into translated text, and eliminates
    // misaligned DOM overlay boxes while matching the source image's exact geometry.
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
        "pointer-events": "none",
        "box-sizing": "border-box",
        opacity: "0",
        transition: "opacity 220ms ease-out",
    });

    const rect = image.getBoundingClientRect();
    const painted = renderTranslatedImageToCanvas(canvas, {
        image,
        regions,
        ocrWidth,
        ocrHeight,
        pixels,
        displayWidth: rect.width > 0 ? rect.width : ocrWidth,
        displayHeight: rect.height > 0 ? rect.height : ocrHeight,
        devicePixelRatio: window.devicePixelRatio || 1,
    });
    if (!painted) {
        showImageStatus(overlay, "无法创建图片画布", {
            error: true,
            onDismiss: () => disposeImageOverlay(image),
        });
        return;
    }

    overlay.append(canvas);
    if (rect.width >= 96 && rect.height >= 48) {
        overlay.append(createImageOverlayToolbar(image, canvas));
    }
    requestAnimationFrame(() => {
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
        const maxSide = 2200;
        const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
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
    const parsed = new DOMParser().parseFromString(html, "text/html");
    for (const br of Array.from(parsed.body.querySelectorAll("br"))) {
        br.replaceWith(parsed.createTextNode("\n"));
    }
    return (parsed.body.textContent ?? html)
        .replace(/\r\n?/g, "\n")
        .split("\n")
        .map((line) => line.replace(/[^\S\n]+/g, " ").trim())
        .filter((line, index, arr) => line.length > 0 || (index > 0 && index < arr.length - 1))
        .join("\n")
        .trim();
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
        throw new Error(`当前本地模型不支持 ${languageLabel(sourceLanguage)} → ${languageLabel(targetLanguage)}`);
    }
    const provider = new RuntimeMessageProvider();
    await provider.getExecutionProfile();
    const terminology = parseTerminology(settings.glossaryCollections, sourceLanguage, targetLanguage, settings.builtinGlossaryEnabled);
    return Promise.all(regions.map(async (region) => {
        // Timestamps, read receipts, counters and tiny status labels are interface
        // metadata, not message content. Translating them both hurts quality and can
        // make a chat screenshot look structurally wrong. Keep them pixel-identical.
        if (isUiMetadataText(region.text)) return { ...region };
        const protectedRegion = protectTerminologyHtml(document, escapeHtml(region.text), terminology);
        let html = await provider.translateHtml({
            html: protectedRegion.html,
            sourceLanguage,
            targetLanguage,
            terminology: terminologyForText(terminology, region.text),
        });
        html = applyTerminologyCorrectionsHtml(document, html, region.text, terminology);
        const restoredHtml = restoreTerminologyHtml(document, html, protectedRegion.replacements);
        return { ...region, text: translatedTextFromHtml(restoredHtml) || region.text };
    }));
}
async function translateImage(srcUrl) {
    const image = findImage(srcUrl);
    if (!image)
        throw new Error("找不到当前图片，请重新右键后再试");
    const overlay = createImageOverlay(image);
    const requestId = typeof crypto?.randomUUID === "function"
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    activeImageOverlay = overlay;
    activeImageRequests.set(requestId, overlay);
    showImageStatus(overlay, "识别文字中…");
    try {
        const input = await imagePixels(srcUrl);
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
        showImageStatus(overlay, "翻译中…");
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
        if (overlay.isConnected && imageOverlays.get(image) === overlay) {
            showImageStatus(overlay, error instanceof Error ? error.message : String(error), {
                error: true,
                onDismiss: () => disposeImageOverlay(image),
            });
        }
        throw error;
    }
    finally {
        activeImageRequests.delete(requestId);
        if (activeImageOverlay === overlay)
            activeImageOverlay = null;
    }
}
function restoreImage(srcUrl) {
    const image = findImage(srcUrl);
    if (!image)
        return false;
    if (!imageOverlays.has(image))
        return false;
    disposeImageOverlay(image);
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
            disposeImageOverlay(image);
            continue;
        }
        positionImageOverlay(image, overlay);
    }
}
window.addEventListener("resize", refreshImageOverlayPositions, { passive: true });
window.addEventListener("scroll", refreshImageOverlayPositions, { passive: true, capture: true });
browser.runtime.onMessage.addListener(async (message) => {
    if (message.type === "image-translation-progress") {
        const targetOverlay = typeof message.requestId === "string"
            ? activeImageRequests.get(message.requestId)
            : activeImageOverlay;
        if (targetOverlay?.isConnected && typeof message.status === "string")
            showImageStatus(targetOverlay, message.status);
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
        return {
            ok: true,
            pageTranslated: Boolean(translator),
            imageTranslated: Boolean(image && imageOverlays.has(image)),
        };
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
    if (message.type === "get-page-language")
        return { ok: true, language: await detectPageLanguage() };
    if (message.type === "translate-page") {
        try {
            const settings = await loadSettings();
            const count = await translatePage(message.sourceLanguage ?? "auto", message.targetLanguage ?? settings.targetLanguage, null, true);
            return { ok: true, count };
        }
        catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
    }
    if (message.type === "restore-page") {
        translator?.restore();
        translator = null;
        activeTranslationIsAutomatic = false;
        activeTranslationTargetLanguage = null;
        activeAutomaticSettingsSignature = null;
        stopRelativeTimeLocalization();
        restoreNavigationLayout();
        document.getElementById("flt-style")?.remove();
        return { ok: true };
    }
    return undefined;
});
browser.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local" || !changes.displayMode || !translator)
        return;
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
    // Translation-only mode hides original roots visually; source detection must ignore
    // PageLingo's generated target-language nodes and read the underlying source DOM.
    const sample = sourceTextSample(document);
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
    const resolved = await resolveAutomaticSourceLanguage(targetLanguage);
    if (generation !== autoTranslateGeneration) return;
    const { sourceLanguage, info } = resolved;
    if (!sourceLanguage || sourceLanguage === targetLanguage)
        return;
    const alwaysSite = isSiteListed(location.hostname, settings.alwaysTranslateSites);
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
    activeTranslationTargetLanguage = null;
    activeAutomaticSettingsSignature = null;
    stopRelativeTimeLocalization();
    restoreNavigationLayout();
    document.getElementById("flt-style")?.remove();
}
function preserveAutomaticTranslationAcrossRoute() {
    return Boolean(
        translator &&
        activeTranslationIsAutomatic &&
        location.hostname.toLowerCase() === "github.com"
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
        if (isSiteListed(location.hostname, settings.neverTranslateSites)) return;
        const alwaysSite = isSiteListed(location.hostname, settings.alwaysTranslateSites);
        if (!alwaysSite && !settings.autoTranslateEnabled) return;
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
    if (!preserveAutomaticTranslationAcrossRoute()) {
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
