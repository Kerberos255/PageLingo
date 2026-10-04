// @ts-nocheck
import { PageTranslator } from "./core/page-translator";
import { CheckedRuntimeMessageProvider, RuntimeMessageProvider } from "./providers/runtime-message-provider";
import { sendRuntimeMessage } from "./shared/runtime-message";
import { isSiteListed, languageLabel, loadSettings, normalizeDetectedLanguage, normalizeDisplayMode } from "./shared/settings";
import { applyTerminologyCorrectionsHtml, escapeHtml, parseTerminology, protectTerminologyHtml, restoreTerminologyHtml, sourceFingerprint } from "./core/rich-segment";
import { freezeNavigationLayout, releaseNavigationLayoutAfterPaint, restoreNavigationLayout } from "./core/navigation-layout";
import { collectTranslationTelemetry } from "./core/translation-telemetry";
import {
    automaticTranslationLifecyclePending,
    automaticTranslationSettingsSignature,
} from "./shared/automatic-translation-state";
import { relativeTimeElements } from "./shared/relative-time";
import { sourceTextSample } from "./shared/source-text-sample";
import { LOCAL_TRANSLATION_ENGINE_ID, PAGELINGO_MT_ENGINE_ID } from "./shared/translation-engine-settings";
var translator = null;
var imageOverlays = new Map();
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
    const engineResponse = await sendRuntimeMessage({ type: "get-translation-engines" });
    const pageLingoMtActive = engineResponse?.ok === true
        && engineResponse.state?.activeEngineId === PAGELINGO_MT_ENGINE_ID;
    const primaryProvider = pageLingoMtActive
        ? new CheckedRuntimeMessageProvider(PAGELINGO_MT_ENGINE_ID)
        : new RuntimeMessageProvider();
    const fallbackProvider = pageLingoMtActive
        ? new RuntimeMessageProvider(LOCAL_TRANSLATION_ENGINE_ID)
        : undefined;
    const pageTranslator = new PageTranslator(document, primaryProvider, {
        sourceLanguage: resolvedSource,
        targetLanguage: normalizedTarget,
        concurrency: pageLingoMtActive ? 1 : 4,
        displayMode: settings.displayMode,
        shouldTranslateRoot,
        terminology: parseTerminology(settings.glossaryCollections, resolvedSource, normalizedTarget, settings.builtinGlossaryEnabled),
        fallbackProvider,
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
}
function createImageOverlay(image) {
    imageOverlays.get(image)?.remove();
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
    return overlay;
}
function showImageStatus(overlay, status) {
    let statusEl = overlay.querySelector("[data-pagelingo-image-status]");
    if (!statusEl) {
        statusEl = document.createElement("div");
        statusEl.dataset.pagelingoImageStatus = "true";
        setImportantStyle(statusEl, {
            position: "absolute",
            left: "50%",
            top: "12px",
            transform: "translateX(-50%)",
            "max-width": "calc(100% - 24px)",
            padding: "7px 10px",
            "border-radius": "8px",
            background: "rgba(16, 18, 22, .96)",
            color: "white",
            font: "600 12px/1.35 system-ui, sans-serif",
            "text-align": "center",
            "box-shadow": "0 4px 16px rgba(0,0,0,.28)",
            "white-space": "normal",
            "box-sizing": "border-box",
        });
        overlay.append(statusEl);
    }
    statusEl.textContent = `PageLingo · ${status}`;
}
function setImportantStyle(element, values) {
    element.style.setProperty("all", "initial", "important");
    for (const [property, value] of Object.entries(values))
        element.style.setProperty(property, value, "important");
}
function medianNumber(values, fallback) {
    const clean = values.filter((value) => Number.isFinite(value) && value > 0).sort((a, b) => a - b);
    return clean.length ? clean[Math.floor(clean.length / 2)] : fallback;
}
function fitImageTranslationText(item, initialSize) {
    let low = 6;
    let high = Math.max(low, initialSize);
    item.style.setProperty("font-size", `${high}px`, "important");
    if (item.scrollHeight <= item.clientHeight + 0.5 && item.scrollWidth <= item.clientWidth + 0.5) return;
    for (let step = 0; step < 8; step += 1) {
        const mid = (low + high) / 2;
        item.style.setProperty("font-size", `${mid}px`, "important");
        const fits = item.scrollHeight <= item.clientHeight + 0.5 && item.scrollWidth <= item.clientWidth + 0.5;
        if (fits) low = mid;
        else high = mid;
    }
    item.style.setProperty("font-size", `${Math.max(6, low - 0.15)}px`, "important");
}
function sampleImageRegionBackground(pixels, imageWidth, imageHeight, box) {
    const data = new Uint8ClampedArray(pixels);
    const valuesR = [];
    const valuesG = [];
    const valuesB = [];
    const x0 = Math.max(0, Math.floor(box.x));
    const y0 = Math.max(0, Math.floor(box.y));
    const x1 = Math.min(imageWidth - 1, Math.ceil(box.x + box.width));
    const y1 = Math.min(imageHeight - 1, Math.ceil(box.y + box.height));
    const band = Math.max(3, Math.min(8, Math.round(box.height * 0.2)));
    const add = (x, y) => {
        if (x < 0 || y < 0 || x >= imageWidth || y >= imageHeight) return;
        const offset = (y * imageWidth + x) * 4;
        if ((data[offset + 3] ?? 0) < 128) return;
        valuesR.push(data[offset] ?? 0);
        valuesG.push(data[offset + 1] ?? 0);
        valuesB.push(data[offset + 2] ?? 0);
    };
    const step = Math.max(1, Math.floor(Math.max(box.width, box.height) / 90));
    for (let x = x0; x <= x1; x += step) {
        for (let d = 1; d <= band; d += 1) {
            add(x, y0 - d);
            add(x, y1 + d);
        }
    }
    for (let y = y0; y <= y1; y += step) {
        for (let d = 1; d <= band; d += 1) {
            add(x0 - d, y);
            add(x1 + d, y);
        }
    }
    if (valuesR.length < 4) return { background: "rgb(245, 245, 245)", color: "#111" };
    const median = (values) => {
        values.sort((a, b) => a - b);
        return values[Math.floor(values.length / 2)] ?? 245;
    };
    const r = median(valuesR);
    const g = median(valuesG);
    const b = median(valuesB);
    const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    return {
        background: `rgb(${r}, ${g}, ${b})`,
        color: luminance < 105 ? "#fff" : "#111",
    };
}
function expandedImageBox(box, imageWidth, imageHeight, xFactor = 0.55, yFactor = 0.38) {
    const padX = Math.max(5, Math.min(18, box.height * xFactor));
    const padY = Math.max(4, Math.min(12, box.height * yFactor));
    const x = Math.max(0, box.x - padX);
    const y = Math.max(0, box.y - padY);
    const right = Math.min(imageWidth, box.x + box.width + padX);
    const bottom = Math.min(imageHeight, box.y + box.height + padY);
    return { x, y, width: Math.max(1, right - x), height: Math.max(1, bottom - y) };
}
function percentBox(box, imageWidth, imageHeight) {
    const left = Math.max(0, Math.min(100, (box.x / imageWidth) * 100));
    const top = Math.max(0, Math.min(100, (box.y / imageHeight) * 100));
    const width = Math.max(1, Math.min(100 - left, (box.width / imageWidth) * 100));
    const height = Math.max(1, Math.min(100 - top, (box.height / imageHeight) * 100));
    return { left, top, width, height };
}
function canvasTextLines(context, text, maxWidth) {
    const normalized = String(text ?? "").replace(/\s+/g, " ").trim();
    if (!normalized) return [];
    const chars = Array.from(normalized);
    const lines = [];
    let line = "";
    let lastBreak = -1;
    for (let index = 0; index < chars.length; index += 1) {
        const char = chars[index];
        const candidate = line + char;
        if (/\s/u.test(char)) lastBreak = line.length;
        if (line && context.measureText(candidate).width > maxWidth) {
            if (lastBreak >= 0) {
                const head = line.slice(0, lastBreak).trimEnd();
                const tail = line.slice(lastBreak + 1).trimStart();
                if (head) lines.push(head);
                line = tail + (char === " " ? "" : char);
            }
            else {
                lines.push(line);
                line = char === " " ? "" : char;
            }
            lastBreak = -1;
            continue;
        }
        line = candidate;
    }
    if (line.trim()) lines.push(line.trim());
    return lines;
}
function fitCanvasTranslation(context, text, box, maxFontSize, minFontSize = 6) {
    const width = Math.max(8, box.width - 6);
    const height = Math.max(8, box.height - 4);
    for (let fontSize = Math.max(minFontSize, Math.floor(maxFontSize)); fontSize >= minFontSize; fontSize -= 0.5) {
        context.font = `500 ${fontSize}px system-ui, -apple-system, "Segoe UI", sans-serif`;
        const lines = canvasTextLines(context, text, width);
        const lineHeight = fontSize * 1.18;
        if (lines.length > 0 && lines.length * lineHeight <= height) {
            return { fontSize, lineHeight, lines };
        }
    }
    context.font = `500 ${minFontSize}px system-ui, -apple-system, "Segoe UI", sans-serif`;
    return { fontSize: minFontSize, lineHeight: minFontSize * 1.15, lines: canvasTextLines(context, text, width) };
}
function renderTranslatedRegions(image, overlay, regions, ocrWidth, ocrHeight, pixels) {
    overlay.replaceChildren();
    positionImageOverlay(image, overlay);
    if (regions.length === 0) {
        showImageStatus(overlay, "没有需要覆盖的译文");
        return;
    }

    // Render the whole translated image on one canvas. This keeps every region in
    // one coordinate system, avoids page CSS leaking into translated text, and
    // prevents dozens of absolutely-positioned DOM boxes from overlapping.
    const canvas = document.createElement("canvas");
    canvas.dataset.pagelingoImageCanvas = "true";
    canvas.width = Math.max(1, Math.round(ocrWidth));
    canvas.height = Math.max(1, Math.round(ocrHeight));
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
    });
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) {
        showImageStatus(overlay, "无法创建图片画布");
        return;
    }
    // Firefox content scripts can reject ImageData created in the extension realm when
    // it is passed into a canvas living in the page realm. drawImage does not cross that
    // typed-array boundary, and we already retain the OCR pixel buffer separately for
    // background-colour sampling.
    try {
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
    }
    catch (error) {
        console.warn("[PageLingo] Could not paint source image onto translation canvas", error);
    }

    const sourceLineHeights = regions.map((region) => Number(region._lineHeight) || region.box.height);
    const medianLineHeight = medianNumber(sourceLineHeights, 18);
    const uniformBaseFont = Math.max(7, Math.min(22, medianLineHeight * 0.78));
    const prepared = regions.map((region) => {
        const lineHeight = Math.max(1, Number(region._lineHeight) || medianLineHeight);
        const padX = Math.max(3, Math.min(10, lineHeight * 0.28));
        const padY = Math.max(2, Math.min(7, lineHeight * 0.22));
        const x = Math.max(0, region.box.x - padX);
        const y = Math.max(0, region.box.y - padY);
        const right = Math.min(ocrWidth, region.box.x + region.box.width + padX);
        const bottom = Math.min(ocrHeight, region.box.y + region.box.height + padY);
        const box = { x, y, width: Math.max(1, right - x), height: Math.max(1, bottom - y) };
        const palette = sampleImageRegionBackground(pixels, ocrWidth, ocrHeight, box);
        return { region, box, palette, lineHeight };
    });

    // Erase every source text area first, then draw all translations. Doing this in
    // two passes means an adjacent erase box can never paint over translated text.
    for (const entry of prepared) {
        context.save();
        context.fillStyle = entry.palette.background;
        const radius = Math.max(1, Math.min(5, entry.lineHeight * 0.22));
        context.beginPath();
        if (typeof context.roundRect === "function") context.roundRect(entry.box.x, entry.box.y, entry.box.width, entry.box.height, radius);
        else context.rect(entry.box.x, entry.box.y, entry.box.width, entry.box.height);
        context.fill();
        context.restore();
    }

    for (const entry of prepared) {
        const maxFont = Math.min(uniformBaseFont, Math.max(7, entry.lineHeight * 0.88));
        const layout = fitCanvasTranslation(context, entry.region.text, entry.box, maxFont, 6);
        context.save();
        context.fillStyle = entry.palette.color;
        context.font = `500 ${layout.fontSize}px system-ui, -apple-system, "Segoe UI", sans-serif`;
        context.textBaseline = "top";
        context.textAlign = "left";
        const innerX = entry.box.x + 3;
        const innerWidth = Math.max(1, entry.box.width - 6);
        const totalHeight = layout.lines.length * layout.lineHeight;
        let y = entry.box.y + Math.max(1, (entry.box.height - totalHeight) / 2);
        for (const line of layout.lines) {
            context.fillText(line, innerX, y, innerWidth);
            y += layout.lineHeight;
        }
        context.restore();
    }

    overlay.append(canvas);
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
    return (parsed.body.textContent ?? html).replace(/\s+/g, " ").trim();
}
function escapeHtml(text) {
    return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
function isOcrUiMetadataText(value) {
    const text = String(value ?? "").normalize("NFKC").trim();
    if (!text) return true;
    if (/^[✓✔√vV\/\s]+$/u.test(text)) return true;
    if (/^\d{1,3}$/u.test(text)) return true;
    if (/^(?:today|yesterday|online|offline)$/iu.test(text)) return true;
    if (/^\d{1,2}:\d{2}(?:\s*(?:am|pm))?(?:\s*[✓✔√vV\/]+)?$/iu.test(text)) return true;
    return false;
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
    const terminology = parseTerminology(settings.glossaryCollections, sourceLanguage, targetLanguage, settings.builtinGlossaryEnabled);
    return Promise.all(regions.map(async (region) => {
        // Timestamps, read receipts, counters and tiny status labels are interface
        // metadata, not message content. Translating them both hurts quality and can
        // make a chat screenshot look structurally wrong. Keep them pixel-identical.
        if (isOcrUiMetadataText(region.text)) return { ...region };
        const protectedRegion = protectTerminologyHtml(document, escapeHtml(region.text), terminology);
        let html = await provider.translateHtml({
            html: protectedRegion.html,
            sourceLanguage,
            targetLanguage,
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
    activeImageOverlay = overlay;
    showImageStatus(overlay, "正在识别图片…");
    try {
        const input = await imagePixels(srcUrl);
        const response = await sendRuntimeMessage({
            type: "recognize-image",
            width: input.width,
            height: input.height,
            pixels: input.pixels,
        });
        if (!response?.ok || !Array.isArray(response.regions))
            throw new Error(response?.error ?? "图片文字识别失败");
        if (!overlay.isConnected || imageOverlays.get(image) !== overlay)
            return;
        showImageStatus(overlay, "文字识别完成 · 正在翻译");
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
            showImageStatus(overlay, error instanceof Error ? error.message : String(error));
        throw error;
    }
    finally {
        if (activeImageOverlay === overlay)
            activeImageOverlay = null;
    }
}
function restoreImage(srcUrl) {
    const image = findImage(srcUrl);
    if (!image)
        return false;
    const overlay = imageOverlays.get(image);
    if (!overlay)
        return false;
    overlay.remove();
    imageOverlays.delete(image);
    if (activeImageOverlay === overlay)
        activeImageOverlay = null;
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
            overlay.remove();
            imageOverlays.delete(image);
            continue;
        }
        positionImageOverlay(image, overlay);
    }
}
window.addEventListener("resize", refreshImageOverlayPositions, { passive: true });
window.addEventListener("scroll", refreshImageOverlayPositions, { passive: true });
browser.runtime.onMessage.addListener(async (message) => {
    if (message.type === "image-translation-progress") {
        if (activeImageOverlay && typeof message.status === "string")
            showImageStatus(activeImageOverlay, message.status);
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
