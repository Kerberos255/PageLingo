// @ts-nocheck
import { collectTranslationRoots, collectTranslationRootsAsync, findTranslationRoot, hasNestedOwnerBoundaryBetween, inspectElementHidden, isElementEffectivelyHidden, isGeneratedNode, isStandaloneShortcutLabel, isTranslationDisabled, isTranslationRootElement, isProtectedApiSignature } from "./dom-policy";
import { TranslationProgress } from "./translation-progress";
import { captureSourceLayout, createSafeTranslatedFragment, mountTranslation } from "./render";
import { escapeHtml, serializeRichSegment, sourceFingerprint, protectTerminologyHtml, applyTerminologyCorrectionsHtml, termOccurrenceCount, terminologyForText, restoreTerminologyHtml } from "./rich-segment";
import { TooltipController } from "./tooltip-controller";
import { contextualTerminology, translationContextForUrl } from "./translation-context";
import {prepareFixedTextRecord, fixedTextRecordUnchanged, clearFixedTextRecord, applyFixedTextRecord, needsCapturedSourceLayout, validateFixedTextRecord} from "./fixed-text-render";
import {restoreFixedHtmlTransport} from "./fixed-html-transport";
import {protectListMarkersHtml, restoreListMarkersHtml} from "./list-marker-preserve";
import {isPreformattedNewlineContext, planPreformattedParagraphRuns} from "./fixed-html-paragraphs";
import {
    richHtmlStructureCompatible,
    richMarkerCandidateCount,
    richMarkerCandidateMaxDepth,
    translateRichHtmlByStructureBudgetPreservingWrappers,
    translateRichHtmlTextNodesSafely,
} from "./rich-segment-splitter";

import { buildBilingualRulesCss } from "./bilingual-style";
import { parseHtmlDocument } from "../shared/html-parser";
import { DEFAULT_BILINGUAL_STYLE, normalizeBilingualStyle, type BilingualStyleSettings } from "../shared/settings";

export interface PageTranslatorOptions { sourceLanguage?:string; targetLanguage?:string; concurrency?:number; displayMode?:"translation"|"bilingual"; bilingualStyle?:Partial<BilingualStyleSettings>; shouldTranslateRoot?:(root:HTMLElement)=>boolean|Promise<boolean>; terminology?:any[]; showProgress?:boolean; bypassCache?:boolean }
function translatedPlainText(_doc, html) {
    const parsed = parseHtmlDocument(html);
    return (parsed.body.textContent ?? "").replace(/\s+/g, " ").trim();
}
function exactTerminologyTarget(value, entries) {
    const raw = String(value || "").trim();
    if (!raw) return null;
    const lower = raw.toLocaleLowerCase();
    const entry = (entries ?? []).find((item) =>
        item.caseSensitive === true ? item.source === raw : item.source.toLocaleLowerCase() === lower
    );
    return entry?.target ?? null;
}
function hasBrokenTranslationText(value) {
    return /\uFFFD/u.test(String(value || ""));
}
function hasBrokenTranslationHtml(html) {
    return /\uFFFD|&#x0*fffd;|&#0*65533;/iu.test(String(html || ""));
}
const COMPLEX_ROOT_MARKER_THRESHOLD = 8;
const COMPLEX_CHUNK_MARKER_BUDGET = 6;

async function translateLeafSafeRichHtml(doc, provider, html, sourceLanguage, targetLanguage, terminology, bypassCache = false) {
    const protectedChunk = protectTerminologyHtml(doc, html, terminology);
    const translated = await translateRichHtmlTextNodesSafely(protectedChunk.html, async (sourceText) => {
        const leafHtml = await provider.translateHtml({
            html: escapeHtml(sourceText),
            sourceLanguage,
            targetLanguage,
            terminology: terminologyForText(terminology, sourceText),
            ...(bypassCache ? { bypassCache: true } : {}),
        });
        const leafText = translatedPlainText(doc, leafHtml);
        if (!leafText || hasBrokenTranslationText(leafText))
            return sourceText;
        return leafText;
    });
    return restoreTerminologyHtml(doc, translated, protectedChunk.replacements);
}

async function translateComplexRichHtml(doc, provider, html, sourceLanguage, targetLanguage, terminology, bypassCache = false) {
    const translateChunk = async (chunk) => {
        const chunkSourceText = translatedPlainText(doc, chunk);
        const protectedChunk = protectTerminologyHtml(doc, chunk, terminology);
        let translated = await provider.translateHtml({
            html: protectedChunk.html,
            sourceLanguage,
            targetLanguage,
            terminology: terminologyForText(terminology, chunkSourceText),
            ...(bypassCache ? { bypassCache: true } : {}),
        });

        const translatedText = translatedPlainText(doc, translated);
        if (
            hasBrokenTranslationHtml(translated)
            || (chunkSourceText && !translatedText)
            || !richHtmlStructureCompatible(protectedChunk.html, translated)
        ) {
            return translateLeafSafeRichHtml(
                doc,
                provider,
                chunk,
                sourceLanguage,
                targetLanguage,
                terminology,
                bypassCache,
            );
        }

        return restoreTerminologyHtml(doc, translated, protectedChunk.replacements);
    };

    return translateRichHtmlByStructureBudgetPreservingWrappers(
        html,
        COMPLEX_CHUNK_MARKER_BUDGET,
        translateChunk,
        (leaf) => translateLeafSafeRichHtml(
            doc,
            provider,
            leaf,
            sourceLanguage,
            targetLanguage,
            terminology,
            bypassCache,
        ),
    );
}

async function providerAllowsStructuralSplitting(provider) {
    if (typeof provider.supportsStructuralSplitting !== "function")
        return true;
    try {
        return await provider.supportsStructuralSplitting();
    }
    catch {
        return false;
    }
}
function stripStandaloneLinkQuotes(source, translated) {
    let value = translated.trim();
    const sourceValue = source.trim();
    const sourceStartsQuoted = /^[“‘「『《〈«‹"']/.test(sourceValue);
    const sourceEndsQuoted = /[”’」』》〉»›"']$/.test(sourceValue);
    if (!sourceStartsQuoted) value = value.replace(/^[“‘「『《〈«‹"']+/, "");
    if (!sourceEndsQuoted) value = value.replace(/[”’」』》〉»›"']+$/, "");
    return value.trim();
}
function stableLinkLabel(sourceText, translatedText, targetLanguage = "") {
    const source = sourceText.trim();
    const translated = stripStandaloneLinkQuotes(source, translatedText);
    if (!translated) return source;
    const questionWord = /^(why|what|how|where|when|who)\b/i;
    const sourceWord = source.match(questionWord)?.[1]?.toLocaleLowerCase();
    const translatedWord = translated.match(questionWord)?.[1]?.toLocaleLowerCase();
    if (sourceWord && translatedWord && sourceWord !== translatedWord) return source;

    // Guard only against the known semantic inversion (Why -> When). Do not manufacture
    // a preferred Chinese title: natural wording belongs to the translation engine.
    if (/^why\s+/i.test(source) && /^zh(?:-|$)/i.test(targetLanguage)) {
        const looksLikeWhen = /^(?:何时|何時|什么时候|什麼時候|幾時)/u.test(translated);
        if (looksLikeWhen) return source;
    }
    return translated;
}
function wrapListDirectText(root, translationNode) {
    for (const child of Array.from(root.childNodes)) {
        if (child === translationNode || child.nodeType !== Node.TEXT_NODE || !(child.textContent ?? "").trim()) continue;
        const wrapper = root.ownerDocument.createElement("span");
        wrapper.dataset.fltSourceTextWrapper = "true";
        wrapper.dataset.fltListSourceWrapper = "true";
        child.replaceWith(wrapper);
        wrapper.append(child);
    }
}
function unwrapListDirectText(root) {
    for (const wrapper of Array.from(root.querySelectorAll(":scope > [data-flt-list-source-wrapper]"))) {
        wrapper.replaceWith(...Array.from(wrapper.childNodes));
    }
}
function translatedLinkTransportComplete(html, links) {
    if (!links.length)
        return true;
    const parsed = parseHtmlDocument(html);
    const seen = new Set();
    for (const anchor of Array.from(parsed.body.querySelectorAll("a"))) {
        let linkIndex = null;
        const rawId = anchor.getAttribute("data-flt-link-id");
        if (rawId && /^\d+$/.test(rawId)) {
            linkIndex = Number.parseInt(rawId, 10);
        }
        else {
            const href = anchor.getAttribute("href") ?? "";
            const match = href.match(/^https:\/\/pagelingo\.invalid\/__link\/(\d+)$/);
            if (match) linkIndex = Number.parseInt(match[1], 10);
        }
        if (linkIndex === null || linkIndex < 0 || linkIndex >= links.length)
            continue;
        if (seen.has(linkIndex))
            return false;

        const startToken = `__FLT_LINK_START_${linkIndex}__`;
        const endToken = `__FLT_LINK_END_${linkIndex}__`;
        const markerElements = Array.from(anchor.querySelectorAll("code,kbd,samp,var"))
            .filter((element) => {
                const text = (element.textContent ?? "").trim();
                return /^__FLT_LINK_(?:START|END)_\d+__$/.test(text);
            });
        const startMarkers = markerElements.filter((element) => (element.textContent ?? "").trim() === startToken);
        const endMarkers = markerElements.filter((element) => (element.textContent ?? "").trim() === endToken);
        const rawMarkers = (anchor.textContent ?? "").match(/__FLT_LINK_(?:START|END)_\d+__/g) ?? [];
        if (markerElements.length !== 2 || startMarkers.length !== 1 || endMarkers.length !== 1 ||
            rawMarkers.length !== 2 || rawMarkers[0] !== startToken || rawMarkers[1] !== endToken) {
            return false;
        }

        const start = startMarkers[0];
        const end = endMarkers[0];
        if (!(start.compareDocumentPosition(end) & Node.DOCUMENT_POSITION_FOLLOWING))
            return false;
        const labelRange = parsed.createRange();
        labelRange.setStartAfter(start);
        labelRange.setEndBefore(end);
        const source = links[linkIndex];
        if (source?.sourceText?.trim() && !labelRange.toString().trim())
            return false;
        seen.add(linkIndex);
    }
    return seen.size === links.length;
}
function singleTooltipTextNode(element) {
    const walker = element.ownerDocument.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const nodes = [];
    let current = walker.nextNode();
    while (current) {
        const text = current;
        if ((text.data ?? "").trim()) nodes.push(text);
        current = walker.nextNode();
    }
    return nodes.length === 1 ? nodes[0] : null;
}
export class PageTranslator {
    #doc;
    #provider;
    #sourceLanguage;
    #targetLanguage;
    #concurrency;
    #shouldTranslateRoot;
    #displayMode;
    #terminology;
    #records = new Map();
    #failures = new Map();
    #pending = new Map();
    #pendingOrder = [];
    #pendingDirty = false;
    #flushBurstStart = 0;
    #activeJobs = 0;
    #hiddenScopes = new WeakSet();
    #pendingProgress = new Map();
    #progress;
    #inFlight = new Set();
    #rerun = new Set();
    #observer = null;
    #tooltipController = null;
    #tooltipSnapshots = new Map();
    #placeholderSnapshots = new Map();
    #flushQueued = false;
    #disposed = false;
    #sourceLinkStyleSnapshots = new Map();
    #sourceHadClassAttribute = new WeakMap();
    #wholeSentenceContext = false;
    #lazyOffscreen = false;
    #fixedRecords = new Map();
    #fixedOwners = new WeakMap();
    #visibilityObserver = null;
    #deferredRoots = new Set();
    #contextModePromise = null;
    #bypassCache = false;
    #forceBypassRoots = new WeakSet();
    #shadowRoots = new Set();
    #shadowObservers = new Map();
    #watchedFadeScopes = new WeakSet();
    #inFlightLazyScopes = new WeakSet();
    #commitQueue = [];
    #commitFlushScheduled = false;
    #commitRafId = 0;
    #commitCoalesceTimer = null;
    #commitFallbackTimer = null;
    #commitFirstQueuedAt = 0;
    #hasRealViewport = false;
    #awaitingPaintPromise = null;
    #awaitingPaintResolve = null;
    #postPaintTimer = null;
    #bilingualStyle = { ...DEFAULT_BILINGUAL_STYLE };
    #learningClickBound = false;
    async #loadContextMode() {
        if (!this.#contextModePromise) this.#contextModePromise = Promise.all([
            Promise.resolve().then(() => this.#provider.prefersWholeSentenceHtml?.()).catch(() => false),
            Promise.resolve().then(() => this.#provider.concurrentSegments?.()).catch(() => undefined),
            Promise.resolve().then(() => this.#provider.prefersLazyOffscreen?.()).catch(() => false),
        ]).then(([wholeSentence, concurrency, lazyOffscreen]) => {
            this.#wholeSentenceContext = Boolean(wholeSentence);
            if (Number.isInteger(concurrency)) this.#concurrency = Math.max(1, Math.min(32, concurrency));
            this.#lazyOffscreen = Boolean(lazyOffscreen);
        });
        return this.#contextModePromise;
    }
    #hasRealViewportGeometry(roots) {
        const view = this.#doc.defaultView;
        if (!view || !(view.innerHeight > 0)) return false;
        const limit = Math.min(roots.length, 64);
        for (let i = 0; i < limit; i += 1) {
            const rect = roots[i].getBoundingClientRect();
            if (rect.width > 0 || rect.height > 0 || rect.top !== 0 || rect.bottom !== 0) {
                this.#hasRealViewport = true;
                return true;
            }
        }
        for (let i = limit; i < roots.length; i += 1) {
            const rect = roots[i].getBoundingClientRect();
            if (rect.width > 0 || rect.height > 0 || rect.top !== 0 || rect.bottom !== 0) {
                this.#hasRealViewport = true;
                return true;
            }
        }
        return false;
    }
    #classifyRootPriority(root, mainScopes = null) {
        const view = this.#doc.defaultView;
        const rect = root.getBoundingClientRect();
        const vh = view?.innerHeight ?? 0;
        const vw = view?.innerWidth ?? 0;
        const visible = rect.bottom > 0 && rect.top < vh && rect.right > 0 && rect.left < vw;
        const nearViewport = !visible && rect.bottom > -200 && rect.top < vh + 600 && rect.right > -100 && rect.left < vw + 100;
        const inMain = mainScopes
            ? mainScopes.some((scopeEl) => scopeEl.contains(root))
            : Boolean(root.closest("main, article, [role='main']"));
        const tier = visible
            ? (inMain ? 0 : 1)
            : nearViewport
                ? (inMain ? 2 : 3)
                : 4;
        return { tier, top: rect.top, visible };
    }
    #ensureVisibilityObserver() {
        if (this.#visibilityObserver || this.#disposed) return;
        const ObserverCtor = this.#doc.defaultView?.IntersectionObserver ?? globalThis.IntersectionObserver;
        if (typeof ObserverCtor !== "function") return;
        this.#visibilityObserver = new ObserverCtor((entries) => {
            if (this.#disposed) return;
            const revealed = [];
            for (const entry of entries) {
                if (!entry.isIntersecting) continue;
                const root = entry.target;
                this.#visibilityObserver?.unobserve(root);
                this.#deferredRoots.delete(root);
                if (root.isConnected) {
                    revealed.push({ root, rect: entry.boundingClientRect ?? root.getBoundingClientRect() });
                }
            }
            if (!revealed.length) return;
            const view = this.#doc.defaultView;
            const vh = view?.innerHeight ?? 0;
            const vw = view?.innerWidth ?? 0;
            const mainScopes = Array.from(this.#doc.querySelectorAll("main, article, [role='main']"));
            const scoped = mainScopes.length <= 6 ? mainScopes : null;
            const prioritized = revealed.map(({ root, rect }) => {
                const visible = rect.bottom > 0 && rect.top < vh && rect.right > 0 && rect.left < vw;
                const inMain = scoped ? scoped.some((s) => s.contains(root)) : Boolean(root.closest("main, article, [role='main']"));
                const tier = visible ? (inMain ? 0 : 1) : (inMain ? 2 : 3);
                return { root, tier, top: rect.top };
            });
            prioritized.sort((a, b) => a.tier - b.tier || a.top - b.top);
            for (const item of prioritized) void this.#queue(item.root, item);
        }, { rootMargin: "900px 0px" });
    }
    #deferRoot(root) {
        if (this.#disposed || !root.isConnected || this.#deferredRoots.has(root)) return;
        this.#ensureVisibilityObserver();
        if (!this.#visibilityObserver) {
            void this.#queue(root);
            return;
        }
        this.#deferredRoots.add(root);
        this.#visibilityObserver.observe(root);
    }
    constructor(doc, provider, options = {}) {
        this.#doc = doc;
        this.#progress = options.showProgress ? new TranslationProgress(doc) : null;
        this.#provider = provider;
        this.#sourceLanguage = options.sourceLanguage ?? "en";
        this.#targetLanguage = options.targetLanguage ?? "zh";
        this.#concurrency = Math.max(1, options.concurrency ?? 4);
        this.#shouldTranslateRoot = options.shouldTranslateRoot ?? null;
        this.#displayMode = options.displayMode ?? "translation";
        this.#bilingualStyle = normalizeBilingualStyle(options.bilingualStyle);
        this.#terminology = Array.isArray(options.terminology) ? options.terminology : [];
        this.#bypassCache = options.bypassCache === true;
        this.#syncLearningClickListener();
    }
    get translatedCount() {
        return this.#records.size + this.#fixedRecords.size;
    }
    get failedCount() {
        return Array.from(this.#failures.keys()).filter(root => root.isConnected).length;
    }
    get firstFailure() {
        return Array.from(this.#failures).find(([root]) => root.isConnected)?.[1] ?? null;
    }
    originalTextForNode(node) {
        if (!node || node.nodeType !== Node.TEXT_NODE) return node?.textContent ?? "";
        const owner = this.#fixedOwners.get(node);
        if (owner && this.#fixedRecords.get(owner.root) === owner) {
            const edit = owner.edits.find((item) => item.node === node);
            if (edit) return edit.source;
        }
        return node.data ?? "";
    }
    findTranslatedRootForNode(target) {
        if (!target || this.#disposed) return null;
        if (target.nodeType === Node.TEXT_NODE) {
            const owner = this.#fixedOwners.get(target);
            if (owner && this.#fixedRecords.get(owner.root) === owner && owner.root.isConnected) return owner.root;
        }
        const element = target.nodeType === Node.ELEMENT_NODE ? target : target.parentElement;
        if (!element) return null;
        const generated = element.closest?.('[data-flt-generated="translation"]');
        if (generated) {
            for (const [root, record] of this.#fixedRecords) {
                if (record.translationNode === generated && root.isConnected) return root;
            }
            for (const [root, record] of this.#records) {
                if (record.translationNode === generated && root.isConnected) return root;
            }
        }
        for (let cursor = element; cursor && cursor !== this.#doc.body; cursor = cursor.parentElement) {
            if ((this.#fixedRecords.has(cursor) || this.#records.has(cursor)) && cursor.isConnected) return cursor;
        }
        return null;
    }
    async retranslateRoot(root, options = {}) {
        if (this.#disposed || !root || !root.isConnected) return false;
        const fixedPrevious = this.#fixedRecords.get(root);
        if (fixedPrevious) this.#clearFixedRecord(root, fixedPrevious);
        const previous = this.#records.get(root);
        if (previous) {
            this.#clearDisplayMode(root);
            previous.translationNode.remove();
            this.#records.delete(root);
        }
        if (options.bypassCache !== false) this.#forceBypassRoots.add(root);
        await this.translateRoot(root);
        return this.#fixedRecords.has(root) || this.#records.has(root);
    }
    #clearFixedRecord(root, record) {
        clearFixedTextRecord(record); this.#fixedRecords.delete(root);
        for (const edit of record.edits) {
            if (this.#fixedOwners.get(edit.node) === record) this.#fixedOwners.delete(edit.node);
        }
    }
    #restoreDisplacedFixedOwners(root) {
        if (!this.#fixedRecords.size) return;
        const seen = new Set();
        const walker = this.#doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            const owner = this.#fixedOwners.get(node);
            if (!owner || owner.root === root || seen.has(owner) || this.#fixedRecords.get(owner.root) !== owner) continue;
            seen.add(owner);
            // Existing nested structural roots and nested block boundaries own their text independently.
            if (root.contains(owner.root) && hasNestedOwnerBoundaryBetween(owner.root, root)) continue;
            if (root.contains(owner.root) || !fixedTextRecordUnchanged(owner)) this.#clearFixedRecord(owner.root, owner);
        }
    }
    #handleLearningClick = (event) => {
        if (this.#disposed || this.#displayMode !== "bilingual" || !this.#bilingualStyle.learningMode) return;
        const target = event.composedPath?.()[0] ?? event.target;
        if (!(target instanceof Element)) return;
        if (target.closest("a")) return;
        const box = target.closest('[data-flt-generated="translation"]');
        if (!box) return;
        const revealed = box.getAttribute("data-pagelingo-revealed") === "true";
        if (revealed) box.removeAttribute("data-pagelingo-revealed");
        else box.setAttribute("data-pagelingo-revealed", "true");
    };
    #syncLearningClickListener() {
        const shouldBind = !this.#disposed && this.#displayMode === "bilingual" && this.#bilingualStyle.learningMode;
        if (shouldBind && !this.#learningClickBound) {
            this.#doc.addEventListener("click", this.#handleLearningClick, true);
            this.#learningClickBound = true;
        } else if (!shouldBind && this.#learningClickBound) {
            this.#doc.removeEventListener("click", this.#handleLearningClick, true);
            this.#learningClickBound = false;
        }
    }
    #syncRecordOrder(root, node) {
        if (!node || !node.isConnected || !root.isConnected) return;
        const wantTop = this.#bilingualStyle.order === "translation-top";
        const isTop = node.dataset.fltOrder === "translation-top";
        if (wantTop === isTop) return;
        if (wantTop) {
            node.dataset.fltOrder = "translation-top";
            if (root.contains(node) && node.parentElement) node.parentElement.prepend(node);
            else root.insertAdjacentElement("beforebegin", node);
        } else {
            delete node.dataset.fltOrder;
            if (root.contains(node) && node.parentElement) node.parentElement.append(node);
            else root.insertAdjacentElement("afterend", node);
        }
    }
    setDisplayMode(displayMode) {
        if (this.#disposed || this.#displayMode === displayMode)
            return;
        this.#displayMode = displayMode;
        this.#syncLearningClickListener();
        // Phase 1: Pure READ pass across all fixed records (zero DOM writes between getComputedStyle calls).
        const fixedPlan = [];
        for (const [root, record] of this.#fixedRecords) {
            const valid = validateFixedTextRecord(root, record);
            const layout = valid && displayMode === "bilingual" && root.isConnected && needsCapturedSourceLayout(root, record, displayMode)
                ? captureSourceLayout(root)
                : undefined;
            fixedPlan.push({ root, record, valid, layout });
        }
        // Phase 2: Pure WRITE pass (zero getComputedStyle / layout reads while mutating DOM).
        for (const [root, record] of this.#records) {
            this.#applyDisplayMode(root, record.translationNode);
            if (displayMode === "bilingual") this.#syncRecordOrder(root, record.translationNode);
        }
        for (const { root, record, valid, layout } of fixedPlan) {
            if (displayMode === "bilingual") this.#ensureShadowStyle(root);
            if (!applyFixedTextRecord(root, record, displayMode, this.#targetLanguage, this.#bilingualStyle.order, layout, valid)) {
                this.#clearFixedRecord(root, record); this.#queue(root);
            }
        }
    }
    setBilingualStyle(nextStyle) {
        if (this.#disposed) return;
        const prev = this.#bilingualStyle;
        const normalized = normalizeBilingualStyle(nextStyle);
        this.#bilingualStyle = normalized;
        this.#syncLearningClickListener();
        if (!normalized.learningMode) {
            for (const scope of [this.#doc, ...Array.from(this.#shadowRoots)]) {
                for (const node of Array.from(scope.querySelectorAll('[data-pagelingo-revealed="true"]'))) {
                    node.removeAttribute("data-pagelingo-revealed");
                }
            }
        }
        for (const shadowRoot of this.#shadowRoots) {
            const style = shadowRoot.querySelector('style[data-flt-generated="style"]');
            if (style) style.textContent = this.#shadowStyleText();
        }
        if (this.#displayMode === "bilingual" && prev.order !== normalized.order) {
            const fallbackPlan = new Map();
            for (const [root, record] of this.#fixedRecords) {
                if (!(record.translationNode?.isConnected && record.translationNode.dataset.fltControl !== "true")) {
                    const valid = validateFixedTextRecord(root, record);
                    const layout = valid && root.isConnected && needsCapturedSourceLayout(root, record, "bilingual")
                        ? captureSourceLayout(root)
                        : undefined;
                    fallbackPlan.set(root, { valid, layout });
                }
            }
            for (const [root, record] of this.#fixedRecords) {
                if (record.translationNode?.isConnected && record.translationNode.dataset.fltControl !== "true") {
                    this.#syncRecordOrder(root, record.translationNode);
                } else {
                    const plan = fallbackPlan.get(root);
                    if (!applyFixedTextRecord(root, record, "bilingual", this.#targetLanguage, normalized.order, plan?.layout, plan?.valid)) {
                        this.#clearFixedRecord(root, record); this.#queue(root);
                    }
                }
            }
            for (const [root, record] of this.#records) {
                this.#syncRecordOrder(root, record.translationNode);
            }
        }
    }
    async translateAll(scope = this.#doc.body, watchDuringPass = false) {
        if (this.#disposed)
            return this.translatedCount;
        await this.#loadContextMode();
        if (this.#disposed) return this.translatedCount;
        const collected = await this.#collectAsync(scope);
        if (this.#disposed) return this.translatedCount;
        if (watchDuringPass) this.observe();
        if (this.#bypassCache) {
            for (const root of collected) this.#forceBypassRoots.add(root);
            this.#bypassCache = false;
        }
        const hasGeometry = this.#hasRealViewportGeometry(collected);
        const ObserverCtor = this.#doc.defaultView?.IntersectionObserver ?? globalThis.IntersectionObserver;
        const useLazy = this.#lazyOffscreen && hasGeometry && typeof ObserverCtor === "function";

        const mainScopesRaw = hasGeometry ? Array.from(this.#doc.querySelectorAll("main, article, [role='main']")) : [];
        const mainScopes = mainScopesRaw.length <= 6 ? mainScopesRaw : null;
        const ranked = new Array(collected.length);
        const yieldNow = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
        let sliceStart = performance.now();
        for (let index = 0; index < collected.length; index += 1) {
            if (hasGeometry && (index & 127) === 127 && performance.now() - sliceStart >= 12) {
                await yieldNow();
                if (this.#disposed) return this.translatedCount;
                sliceStart = performance.now();
            }
            const root = collected[index];
            const priority = hasGeometry ? this.#classifyRootPriority(root, mainScopes) : { tier: 0, top: index, visible: true };
            ranked[index] = { root, index, tier: priority.tier, top: priority.top };
        }
        if (hasGeometry) {
            ranked.sort((a, b) => a.tier - b.tier || a.top - b.top || a.index - b.index);
        }
        if (useLazy) {
            const immediate = [];
            const deferred = [];
            for (const item of ranked) {
                if (item.tier <= 3) immediate.push(item);
                else deferred.push(item.root);
            }
            if (immediate.length === 0 && deferred.length > 0) {
                for (const root of deferred.splice(0, 8)) immediate.push({ root, tier: 4, top: 0 });
            }
            // Start translating visible viewport items immediately before registering thousands of deferred roots.
            const immediateDone = Promise.all(immediate.map((item) => this.#queue(item.root, item)));
            const placeholdersDone = this.#translatePlaceholdersInScope(scope);
            sliceStart = performance.now();
            for (let i = 0; i < deferred.length; i += 1) {
                if ((i & 255) === 255 && performance.now() - sliceStart >= 12) {
                    await yieldNow();
                    if (this.#disposed) return this.translatedCount;
                    sliceStart = performance.now();
                }
                this.#deferRoot(deferred[i]);
            }
            await Promise.all([immediateDone, placeholdersDone]);
            return this.translatedCount;
        }
        await Promise.all([
            Promise.all(ranked.map((item) => this.#queue(item.root, item))),
            this.#translatePlaceholdersInScope(scope),
        ]);
        return this.translatedCount;
    }
    #watchHiddenFade(element, mayHaveFadeAnimation = true) {
        this.#hiddenScopes.add(element);
        if (!mayHaveFadeAnimation || this.#watchedFadeScopes.has(element) || typeof element.getAnimations !== "function") return;
        const animations = element.getAnimations().filter(animation => animation && animation.playState !== "finished");
        if (!animations.length) return;
        this.#watchedFadeScopes.add(element);
        void Promise.allSettled(animations.map(animation => animation.finished)).then(() => {
            this.#watchedFadeScopes.delete(element);
            this.#queueVisibleScope(element);
        });
    }
    #registerShadowRoot(shadowRoot) {
        if (!shadowRoot || this.#disposed) return;
        this.#shadowRoots.add(shadowRoot);
        if (this.#observer && !this.#shadowObservers.has(shadowRoot)) {
            this.#observeShadowRoot(shadowRoot);
        }
    }
    #shadowStyleText() {
        return `.flt-translation { display: block !important; margin-block-start: 0.28em !important; font: inherit !important; line-height: inherit !important; letter-spacing: inherit !important; text-transform: none !important; } .flt-translation a { display: inline !important; } .flt-source-hidden { display: none !important; } ${buildBilingualRulesCss(this.#bilingualStyle, ":host")}`;
    }
    #ensureShadowStyle(root) {
        const rootNode = root.getRootNode?.();
        if (!rootNode || rootNode === this.#doc || rootNode.nodeType !== Node.DOCUMENT_FRAGMENT_NODE || !("host" in rootNode)) return;
        this.#shadowRoots.add(rootNode);
        const existing = rootNode.querySelector('style[data-flt-generated="style"]');
        if (existing) {
            existing.textContent = this.#shadowStyleText();
            return;
        }
        const style = this.#doc.createElement("style");
        style.dataset.fltGenerated = "style";
        style.textContent = this.#shadowStyleText();
        rootNode.append(style);
    }
    #collect(scope) {
        return collectTranslationRoots(scope, {
            preserveInlineContext: this.#wholeSentenceContext,
            onHidden: (element, mayFade) => this.#watchHiddenFade(element, mayFade),
            onShadowRoot: shadowRoot => this.#registerShadowRoot(shadowRoot),
        });
    }
    #collectAsync(scope, extraOptions = {}) {
        return collectTranslationRootsAsync(scope, {
            preserveInlineContext: this.#wholeSentenceContext,
            onHidden: (element, mayFade) => this.#watchHiddenFade(element, mayFade),
            onShadowRoot: shadowRoot => this.#registerShadowRoot(shadowRoot),
            isCancelled: () => this.#disposed,
            beforeResume: () => this.#awaitingPaintPromise,
            ...extraOptions,
        });
    }
    async translateRoot(root) {
        if (this.#disposed || !root.isConnected || isGeneratedNode(root) || isProtectedApiSignature(root))
            return;
        if (this.#inFlight.has(root)) {
            this.#rerun.add(root);
            return;
        }
        this.#inFlight.add(root);
        this.#failures.delete(root);
        try {
        await this.#loadContextMode();
        const fixedPrevious = this.#fixedRecords.get(root);
        if (fixedPrevious) {
            // A translation-only record writes into the original text nodes.
            // Unchanged records must bypass source-language checks; changed
            // records must restore owned source before that predicate reads it.
            if (fixedTextRecordUnchanged(fixedPrevious)) return;
            this.#clearFixedRecord(root, fixedPrevious);
        }
        this.#restoreDisplacedFixedOwners(root);
        if (this.#shouldTranslateRoot && !await this.#shouldTranslateRoot(root)) {
            if (this.#disposed)
                return;
            const previous = this.#records.get(root);
            if (previous) {
                this.#clearDisplayMode(root);
                previous.translationNode.remove();
                this.#records.delete(root);
            }
            return;
        }
        const currentFingerprint = sourceFingerprint(root);
        const previous = this.#records.get(root);
        if (previous?.fingerprint === currentFingerprint)
            return;
        if (previous) {
            // Restore the source before re-serializing. Translation-only mode may hide
            // structural descendants with CSS; serializing while those rules are active
            // can mistake PageLingo's own hiding for source-page visibility.
            this.#clearDisplayMode(root);
            previous.translationNode.remove();
            this.#records.delete(root);
        }
        const preformattedRoot = isPreformattedNewlineContext(root);
        const segment = serializeRichSegment(root, {
            fixedTextSlots: this.#wholeSentenceContext,
            collapseNewlines: this.#wholeSentenceContext && !preformattedRoot,
            prosePunctuationSlots: this.#wholeSentenceContext,
        });
        if (this.#wholeSentenceContext && !segment.textSlots.some((slot) => slot.writePolicy !== "prose-punctuation")) return;
        if (!segment.html.trim())
            return;
        const lastSlot = segment.textSlots?.at(-1);
        if (lastSlot && this.#progress) this.#pendingProgress.set(root, this.#progress.show(root, lastSlot.node));
        const context = this.#wholeSentenceContext ? translationContextForUrl(this.#doc.URL) : undefined;
        const requestTerminology = terminologyForText(this.#terminology, segment.fingerprint);
        for (const entry of terminologyForText(contextualTerminology(context), segment.fingerprint)) {
            if (!requestTerminology.some(existing => existing.source.toLowerCase() === entry.source.toLowerCase())) requestTerminology.push(entry);
        }
        let translatedHtml;
        const markerCount = richMarkerCandidateCount(segment.html);
        const markerDepth = richMarkerCandidateMaxDepth(segment.html);
        const complexRoot = markerCount >= COMPLEX_ROOT_MARKER_THRESHOLD;
        // Regression testing shows a failure pocket at 5-6 markers with 2-3 levels
        // of nesting. For local engines, route that narrow tail through deterministic
        // leaf-safe translation so PageLingo retains markup ownership.
        const nestingRiskRoot = markerCount >= 5 && markerCount <= 6 && markerDepth >= 2;
        const structuralFallbackAllowed =
            !this.#wholeSentenceContext && (complexRoot || nestingRiskRoot) &&
            await providerAllowsStructuralSplitting(this.#provider);
        const bypassCache = this.#forceBypassRoots.has(root);
        const paragraphPlan = this.#wholeSentenceContext && preformattedRoot
            ? planPreformattedParagraphRuns(segment.html)
            : null;
        let terminologyAppliedPerRun = false;
        let protectedListMarkers = [];
        if (paragraphPlan) {
            const settledRuns = await Promise.allSettled(paragraphPlan.runs.map(async (run) => {
                const runTerms = terminologyForText(this.#terminology, run.plainText);
                for (const entry of terminologyForText(contextualTerminology(context), run.plainText)) {
                    if (!runTerms.some(existing => existing.source.toLowerCase() === entry.source.toLowerCase())) runTerms.push(entry);
                }
                const protectedRunMarkers = protectListMarkersHtml(run.html);
                const protectedRun = protectTerminologyHtml(this.#doc, protectedRunMarkers.html, this.#terminology);
                let runHtml = await this.#provider.translateHtml({
                    html: protectedRun.html,
                    sourceLanguage: this.#sourceLanguage,
                    targetLanguage: this.#targetLanguage,
                    terminology: runTerms,
                    context,
                    ...(bypassCache ? { bypassCache: true } : {}),
                });
                runHtml = restoreTerminologyHtml(this.#doc, runHtml, protectedRun.replacements);
                if (hasBrokenTranslationHtml(runHtml)) {
                    throw new Error("译文包含损坏字符，已保留原文");
                }
                runHtml = applyTerminologyCorrectionsHtml(this.#doc, runHtml, run.plainText, this.#terminology, new Map());
                if (hasBrokenTranslationHtml(runHtml)) {
                    throw new Error("译文包含损坏字符，已保留原文");
                }
                runHtml = restoreListMarkersHtml(run.html, runHtml, protectedRunMarkers.markers);
                return restoreFixedHtmlTransport(run.html, runHtml);
            }));
            const fatalRe = /数据权限|请填写 API Key|请填写模型名称|必须使用 HTTPS|HTTP (?:401|402|403|429)\b/u;
            let succeededCount = 0;
            let firstError = null;
            const translatedRuns = settledRuns.map((outcome, index) => {
                if (outcome.status === "fulfilled") {
                    succeededCount += 1;
                    return outcome.value;
                }
                const err = outcome.reason;
                const msg = err instanceof Error ? err.message : String(err ?? "");
                if (fatalRe.test(msg)) throw err;
                if (!firstError) firstError = err;
                // Keep only the single failed paragraph in its original source text
                // instead of discarding every other translated paragraph in the scene.
                return paragraphPlan.runs[index].html;
            });
            if (succeededCount === 0 && firstError) throw firstError;
            translatedHtml = paragraphPlan.reassemble(translatedRuns);
            terminologyAppliedPerRun = true;
        }
        else if (structuralFallbackAllowed && nestingRiskRoot) {
            translatedHtml = await translateLeafSafeRichHtml(
                this.#doc,
                this.#provider,
                segment.html,
                this.#sourceLanguage,
                this.#targetLanguage,
                this.#terminology,
                bypassCache,
            );
        }
        else if (structuralFallbackAllowed && complexRoot) {
            translatedHtml = await translateComplexRichHtml(
                this.#doc,
                this.#provider,
                segment.html,
                this.#sourceLanguage,
                this.#targetLanguage,
                this.#terminology,
                bypassCache,
            );
        }
        else {
            // Keep the complete root and its protected terminology in one provider request,
            // while stripping leading numeric list ordinals ("1. ", "1.2. ") so models do not
            // convert ordinal dots into "。" or swallow the separator space.
            const protectedMarkers = protectListMarkersHtml(segment.html);
            protectedListMarkers = protectedMarkers.markers;
            const protectedSegment = protectTerminologyHtml(this.#doc, protectedMarkers.html, this.#terminology);
            translatedHtml = await this.#provider.translateHtml({
                html: protectedSegment.html,
                sourceLanguage: this.#sourceLanguage,
                targetLanguage: this.#targetLanguage,
                terminology: requestTerminology,
                context,
                ...(bypassCache ? { bypassCache: true } : {}),
            });
            translatedHtml = restoreTerminologyHtml(this.#doc, translatedHtml, protectedSegment.replacements);
        }
        if (this.#disposed)
            return;
        if (hasBrokenTranslationHtml(translatedHtml)) {
            throw new Error("译文包含损坏字符，已保留原文");
        }

        // Preferred translations are post-corrections. For a user-only term we learn the
        // engine's standalone default as an alias, but never inject the preferred target into
        // the source sentence before translation.
        const dynamicAliases = new Map();
        const userTerms = this.#wholeSentenceContext ? [] : this.#terminology.filter((entry) => entry.mode === "replace" && entry.origin === "user" && termOccurrenceCount(segment.fingerprint, entry.source, entry.caseSensitive === true) > 0);
        if (userTerms.length) {
            await Promise.all(userTerms.map(async (entry) => {
                try {
                    const aliasHtml = await this.#provider.translateHtml({
                        html: escapeHtml(entry.source),
                        sourceLanguage: this.#sourceLanguage,
                        targetLanguage: this.#targetLanguage,
                    });
                    const alias = translatedPlainText(this.#doc, aliasHtml);
                    if (alias) dynamicAliases.set(entry.source.toLocaleLowerCase(), alias);
                } catch {}
            }));
        }
        if (!terminologyAppliedPerRun) {
            translatedHtml = applyTerminologyCorrectionsHtml(this.#doc, translatedHtml, segment.fingerprint, this.#terminology, dynamicAliases);
            if (hasBrokenTranslationHtml(translatedHtml)) {
                throw new Error("译文包含损坏字符，已保留原文");
            }
            translatedHtml = restoreListMarkersHtml(segment.html, translatedHtml, protectedListMarkers);
        }

        // The main HTML translation is authoritative when every source link keeps a
        // unique transport identity and a non-empty translated label. In that common path
        // there is nothing to recover, so do not spend extra Bergamot calls on each label
        // and the text gaps around them. Keep the previous standalone path only as a
        // transport-damage fallback.
        if (this.#wholeSentenceContext) translatedHtml = restoreFixedHtmlTransport(segment.html, translatedHtml);
        const mainLinksComplete = translatedLinkTransportComplete(translatedHtml, segment.links);
        if (this.#wholeSentenceContext && !mainLinksComplete) throw new Error("Translation link transport incomplete; preserving the original paragraph");
        const translatedLinkTexts = mainLinksComplete ? [] : await Promise.all(segment.links.map(async (link) => {
            if (!link.sourceText.trim()) return "";
            const exactTerm = exactTerminologyTarget(link.sourceText, this.#terminology);
            if (exactTerm) return exactTerm;
            try {
                const protectedLink = protectTerminologyHtml(this.#doc, escapeHtml(link.sourceText), this.#terminology);
                let linkHtml = await this.#provider.translateHtml({
                    html: protectedLink.html,
                    sourceLanguage: this.#sourceLanguage,
                    targetLanguage: this.#targetLanguage,
                    terminology: terminologyForText(this.#terminology, link.sourceText),
                    ...(bypassCache ? { bypassCache: true } : {}),
                });
                linkHtml = restoreTerminologyHtml(this.#doc, linkHtml, protectedLink.replacements);
                linkHtml = applyTerminologyCorrectionsHtml(this.#doc, linkHtml, link.sourceText, this.#terminology);
                const translated = translatedPlainText(this.#doc, linkHtml);
                if (hasBrokenTranslationText(translated)) {
                    console.warn("[PageLingo] Link label translation contained replacement characters; preserving source", link.sourceText);
                    return link.sourceText;
                }
                return stableLinkLabel(link.sourceText, translated, this.#targetLanguage);
            }
            catch (error) {
                console.warn("[PageLingo] Link label translation failed", error);
                return link.sourceText;
            }
        }));
        const translatedGapTexts = mainLinksComplete || !segment.linkGaps?.length ? [] : await Promise.all(segment.linkGaps.map(async (gap) => {
            if (!gap.trim()) return "";
            try {
                const protectedGap = protectTerminologyHtml(this.#doc, escapeHtml(gap.trim()), this.#terminology);
                let gapHtml = await this.#provider.translateHtml({
                    html: protectedGap.html,
                    sourceLanguage: this.#sourceLanguage,
                    targetLanguage: this.#targetLanguage,
                    terminology: terminologyForText(this.#terminology, gap.trim()),
                    ...(bypassCache ? { bypassCache: true } : {}),
                });
                gapHtml = restoreTerminologyHtml(this.#doc, gapHtml, protectedGap.replacements);
                gapHtml = applyTerminologyCorrectionsHtml(this.#doc, gapHtml, gap.trim(), this.#terminology);
                const translated = translatedPlainText(this.#doc, gapHtml);
                return hasBrokenTranslationText(translated) ? gap.trim() : translated;
            }
            catch {
                return "";
            }
        }));
        if (this.#disposed || !root.isConnected || sourceFingerprint(root, {excludeNestedRoots: this.#wholeSentenceContext}) !== segment.fingerprint)
            return;
        if (this.#wholeSentenceContext) {
            const record = prepareFixedTextRecord(root, segment.textSlots, translatedHtml, this.#targetLanguage, segment.hiddenElements);
            await this.#enqueueCommit({
                isFixed: true,
                root,
                fingerprint: segment.fingerprint,
                record,
                capturedLayout: undefined,
                skip: false,
            });
            return;
        }
        const fragment = createSafeTranslatedFragment(this.#doc, translatedHtml, segment.links, segment.opaque, translatedLinkTexts, translatedGapTexts, []);
        await this.#enqueueCommit({
            isFixed: false,
            root,
            fingerprint: segment.fingerprint,
            fragment,
            capturedLayout: undefined,
            skip: false,
        });
        } catch (error) {
            this.#failures.set(root, error instanceof Error ? error.message : String(error));
            throw error;
        } finally {
            this.#forceBypassRoots.delete(root);
            this.#pendingProgress.get(root)?.();
            this.#pendingProgress.delete(root);
            this.#inFlight.delete(root);
            if (this.#rerun.delete(root) && !this.#disposed && root.isConnected) this.#queue(root);
            this.#scheduleFlush();
        }
    }
    #cancelCommitTimers() {
        const view = this.#doc.defaultView;
        if (this.#commitRafId && view?.cancelAnimationFrame) {
            view.cancelAnimationFrame(this.#commitRafId);
        }
        this.#commitRafId = 0;
        if (this.#commitCoalesceTimer !== null) {
            clearTimeout(this.#commitCoalesceTimer);
            this.#commitCoalesceTimer = null;
        }
        if (this.#commitFallbackTimer !== null) {
            clearTimeout(this.#commitFallbackTimer);
            this.#commitFallbackTimer = null;
        }
    }
    #markDomDirtyForPaint() {
        if (!this.#hasRealViewport || this.#disposed || this.#awaitingPaintPromise) return;
        this.#awaitingPaintPromise = new Promise((resolve) => {
            this.#awaitingPaintResolve = resolve;
        });
        this.#postPaintTimer = setTimeout(() => {
            this.#clearAwaitingPaint();
            this.#scheduleFlush();
        }, 0);
    }
    #clearAwaitingPaint() {
        if (this.#postPaintTimer !== null) {
            clearTimeout(this.#postPaintTimer);
            this.#postPaintTimer = null;
        }
        const resolve = this.#awaitingPaintResolve;
        this.#awaitingPaintPromise = null;
        this.#awaitingPaintResolve = null;
        resolve?.();
    }
    #scheduleCommitOnFrame() {
        if (this.#commitRafId) return;
        const view = this.#doc.defaultView;
        if (typeof view?.requestAnimationFrame === "function") {
            this.#commitRafId = view.requestAnimationFrame(() => {
                this.#commitRafId = 0;
                this.#flushCommits();
            });
            // Safety fallback for backgrounded tabs where rAF may be throttled.
            if (this.#commitFallbackTimer === null) {
                this.#commitFallbackTimer = setTimeout(() => {
                    this.#commitFallbackTimer = null;
                    this.#flushCommits();
                }, 60);
            }
        } else {
            queueMicrotask(() => this.#flushCommits());
        }
    }
    #enqueueCommit(task) {
        return new Promise((resolve) => {
            task.resolve = resolve;
            this.#commitQueue.push(task);
            const coalesceBilingual = this.#hasRealViewport && this.#displayMode === "bilingual";
            if (!coalesceBilingual) {
                if (!this.#commitFlushScheduled) {
                    this.#commitFlushScheduled = true;
                    queueMicrotask(() => this.#flushCommits());
                }
                return;
            }
            const now = performance.now();
            if (!this.#commitFirstQueuedAt) this.#commitFirstQueuedAt = now;
            const moreInFlight = this.#activeJobs > this.#commitQueue.length;
            const elapsed = now - this.#commitFirstQueuedAt;
            if (!moreInFlight || elapsed >= 45) {
                if (this.#commitCoalesceTimer !== null) {
                    clearTimeout(this.#commitCoalesceTimer);
                    this.#commitCoalesceTimer = null;
                }
                this.#commitFlushScheduled = true;
                this.#scheduleCommitOnFrame();
            } else if (!this.#commitFlushScheduled) {
                this.#commitFlushScheduled = true;
                this.#commitCoalesceTimer = setTimeout(() => {
                    this.#commitCoalesceTimer = null;
                    this.#scheduleCommitOnFrame();
                }, 28);
            }
        });
    }
    #flushCommits() {
        this.#cancelCommitTimers();
        this.#commitFlushScheduled = false;
        this.#commitFirstQueuedAt = 0;
        const batch = this.#commitQueue.splice(0);
        if (!batch.length) return;
        if (this.#disposed) {
            for (const task of batch) task.resolve();
            return;
        }
        // Phase 1: Pure READ pass across the entire resolving batch (at most 1 browser style recalc
        // for all queued roots combined instead of N interleaved read->write forced recalcs).
        for (let i = 0; i < batch.length; i += 1) {
            const task = batch[i];
            if (!task.root.isConnected || sourceFingerprint(task.root, { excludeNestedRoots: task.isFixed }) !== task.fingerprint) {
                task.skip = true;
                continue;
            }
            if (task.isFixed) {
                const valid = validateFixedTextRecord(task.root, task.record);
                task.valid = valid;
                if (valid && needsCapturedSourceLayout(task.root, task.record, this.#displayMode)) {
                    task.capturedLayout = captureSourceLayout(task.root);
                }
            } else {
                task.capturedLayout = captureSourceLayout(task.root);
            }
        }
        // Phase 2: Pure WRITE pass (zero getComputedStyle / layout reads while mutating DOM).
        let insertedElements = false;
        for (let i = 0; i < batch.length; i += 1) {
            const task = batch[i];
            if (task.skip || this.#disposed || !task.root.isConnected) continue;
            if (task.isFixed) {
                if (this.#displayMode === "bilingual") this.#ensureShadowStyle(task.root);
                if (!applyFixedTextRecord(task.root, task.record, this.#displayMode, this.#targetLanguage, this.#bilingualStyle.order, task.capturedLayout, task.valid)) {
                    continue;
                }
                if (task.record.translationNode) insertedElements = true;
                this.#fixedRecords.set(task.root, task.record);
                for (const edit of task.record.edits) this.#fixedOwners.set(edit.node, task.record);
            } else {
                this.#ensureShadowStyle(task.root);
                const translationNode = mountTranslation(task.root, task.fragment, this.#targetLanguage, false, this.#bilingualStyle.order, task.capturedLayout);
                insertedElements = true;
                this.#records.set(task.root, { translationNode, fingerprint: task.fingerprint });
                this.#applyDisplayMode(task.root, translationNode, task.capturedLayout);
            }
        }
        // Let the browser paint element insertions before the next batch reads computed styles.
        if (insertedElements && this.#hasRealViewport) {
            this.#markDomDirtyForPaint();
        }
        // Phase 3: Notify awaiting translateRoot calls.
        for (let i = 0; i < batch.length; i += 1) {
            batch[i].resolve();
        }
    }
    #handleToggle = (event) => {
        if (event.target instanceof Element && (event.newState === "open" || event.target.hasAttribute("open"))) {
            this.#queueVisibleScope(event.target);
        }
    };
    #handleMutations = (mutations) => {
        const revealed = new Set();
        for (const mutation of mutations) {
            if (isGeneratedNode(mutation.target))
                continue;
            if (mutation.type === "attributes") {
                const region = mutation.target;
                const attr = mutation.attributeName;
                if (attr === "aria-expanded" || attr === "aria-selected") {
                    if (region.getAttribute(attr) !== "true") continue;
                    const scopeRoot = region.getRootNode?.();
                    for (const id of (region.getAttribute("aria-controls") ?? "").split(/\s+/)) {
                        const panel = scopeRoot?.getElementById?.(id) ?? this.#doc.getElementById(id);
                        if (panel) revealed.add(panel);
                    }
                    continue;
                }
                if (attr === "class" || attr === "style") {
                    if (!this.#hiddenScopes.has(region)) {
                        const role = region.getAttribute("role");
                        if (
                            region.tagName !== "DIALOG" &&
                            !region.hasAttribute("popover") &&
                            role !== "dialog" && role !== "tabpanel" && role !== "menu" && role !== "listbox"
                        ) continue;
                    }
                }
                if ((attr !== "open" || region.hasAttribute("open"))
                    && !region.closest("[hidden],[inert],[aria-hidden='true']")) revealed.add(region);
                continue;
            }
            if (mutation.type === "characterData" && mutation.target.nodeType === Node.TEXT_NODE) {
                const owner = this.#fixedOwners.get(mutation.target);
                const edit = owner?.edits.find(edit => edit.node === mutation.target);
                if (edit && mutation.target.data === (owner.mode === "translation" ? edit.translated : edit.source)) continue;
                const parent = mutation.target.parentElement;
                if (parent) {
                    for (const root of this.#collect(parent))
                        this.#queue(root);
                }
                continue;
            }
            for (const added of Array.from(mutation.addedNodes)) {
                if (isGeneratedNode(added))
                    continue;
                if (added.nodeType === Node.TEXT_NODE) {
                    const parent = added.parentElement;
                    if (parent) {
                        for (const root of this.#collect(parent))
                            this.#queue(root);
                    }
                }
                else if (added.nodeType === Node.ELEMENT_NODE) {
                    if (added.hasAttribute?.("data-flt-source-text-wrapper"))
                        continue;
                    if (this.#wholeSentenceContext && this.#lazyOffscreen && added.childElementCount >= 16) {
                        void this.#queueScopeLazy(added);
                    } else {
                        for (const root of this.#collect(added))
                            this.#queue(root);
                        void this.#translatePlaceholdersInScope(added);
                    }
                }
            }
        }
        for (const region of revealed) {
            if ([...revealed].some(parent => parent !== region && parent.contains(region))) continue;
            const hiddenState = inspectElementHidden(region);
            if (hiddenState === 0) {
                this.#queueVisibleScope(region);
                continue;
            }
            // Accessibility state or added nodes can appear before a CSS fade completes.
            this.#watchHiddenFade(region, hiddenState === 2);
        }
    };
    #observeShadowRoot(shadowRoot) {
        if (this.#disposed || this.#shadowObservers.has(shadowRoot)) return;
        const observer = new MutationObserver(this.#handleMutations);
        observer.observe(shadowRoot, {
            childList: true, subtree: true, characterData: true, attributes: true,
            attributeFilter: ["hidden", "aria-hidden", "inert", "open", "class", "style", "data-state", "aria-expanded", "aria-selected"],
        });
        this.#shadowObservers.set(shadowRoot, observer);
    }
    observe() {
        if (this.#observer || !this.#doc.body)
            return;
        this.#observer = new MutationObserver(this.#handleMutations);
        this.#observer.observe(this.#doc.body, {
            childList: true, subtree: true, characterData: true, attributes: true,
            attributeFilter: ["hidden", "aria-hidden", "inert", "open", "class", "style", "data-state", "aria-expanded", "aria-selected"],
        });
        for (const shadowRoot of this.#shadowRoots) {
            this.#observeShadowRoot(shadowRoot);
        }
        this.#doc.addEventListener("toggle", this.#handleToggle, true);
    }
    #queueVisibleScope(region) {
        if (this.#disposed || !region.isConnected || isElementEffectivelyHidden(region)) return;
        // Large newly revealed panels (such as a 500-item <details> accordion) must use the
        // same time-sliced scan + viewport-first lazy deferral as translateAll so a single
        // click never stalls the main thread or floods off-screen work.
        if (this.#wholeSentenceContext && this.#lazyOffscreen && region.childElementCount > 0) {
            void this.#queueScopeLazy(region);
            return;
        }
        for (const root of this.#collect(region)) {
            this.#queue(root);
        }
        void this.#translatePlaceholdersInScope(region);
    }
    async #queueScopeLazy(region) {
        if (this.#disposed || !region.isConnected || this.#inFlightLazyScopes.has(region)) return;
        this.#inFlightLazyScopes.add(region);
        try {
            if (this.#awaitingPaintPromise) {
                await this.#awaitingPaintPromise;
                if (this.#disposed || !region.isConnected) return;
            }
            const ObserverCtor = this.#doc.defaultView?.IntersectionObserver ?? globalThis.IntersectionObserver;
            const mainScopesRaw = Array.from(this.#doc.querySelectorAll("main, article, [role='main']"));
            const mainScopes = mainScopesRaw.length <= 6 ? mainScopesRaw : null;
            const earlyHandled = new Set();
            const scheduleBatch = (roots) => {
                if (this.#disposed || !roots.length) return;
                const hasGeo = this.#hasRealViewportGeometry(roots);
                const useLazyHere = this.#lazyOffscreen && hasGeo && typeof ObserverCtor === "function";
                const immediate = [];
                for (let i = 0; i < roots.length; i += 1) {
                    const root = roots[i];
                    if (!root.isConnected || earlyHandled.has(root)) continue;
                    earlyHandled.add(root);
                    const priority = hasGeo ? this.#classifyRootPriority(root, mainScopes) : { tier: 0, top: i, visible: true };
                    if (useLazyHere && priority.tier > 3) this.#deferRoot(root);
                    else immediate.push({ root, tier: priority.tier, top: priority.top });
                }
                immediate.sort((a, b) => a.tier - b.tier || a.top - b.top);
                for (const item of immediate) void this.#queue(item.root, item);
            };
            const collected = await this.#collectAsync(region, { onEarlyRoots: scheduleBatch });
            if (this.#disposed || !collected.length) return;
            const remaining = earlyHandled.size ? collected.filter((root) => !earlyHandled.has(root)) : collected;
            if (!remaining.length) return;
            const hasGeometry = this.#hasRealViewportGeometry(remaining);
            const useLazy = this.#lazyOffscreen && hasGeometry && typeof ObserverCtor === "function";
            const yieldNow = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
            let sliceStart = performance.now();
            const immediate = [];
            const deferred = [];
            for (let i = 0; i < remaining.length; i += 1) {
                if (hasGeometry && (i & 127) === 127 && performance.now() - sliceStart >= 12) {
                    await yieldNow();
                    if (this.#disposed) return;
                    if (this.#awaitingPaintPromise) {
                        await this.#awaitingPaintPromise;
                        if (this.#disposed) return;
                    }
                    sliceStart = performance.now();
                }
                const root = remaining[i];
                if (!root.isConnected) continue;
                const priority = hasGeometry ? this.#classifyRootPriority(root, mainScopes) : { tier: 0, top: i, visible: true };
                if (useLazy && priority.tier > 3) deferred.push(root);
                else immediate.push({ root, tier: priority.tier, top: priority.top });
            }
            immediate.sort((a, b) => a.tier - b.tier || a.top - b.top);
            for (const item of immediate) void this.#queue(item.root, item);
            void this.#translatePlaceholdersInScope(region);
            sliceStart = performance.now();
            for (let i = 0; i < deferred.length; i += 1) {
                if ((i & 255) === 255 && performance.now() - sliceStart >= 12) {
                    await yieldNow();
                    if (this.#disposed) return;
                    sliceStart = performance.now();
                }
                this.#deferRoot(deferred[i]);
            }
        } finally {
            this.#inFlightLazyScopes.delete(region);
        }
    }
    #collectPlaceholders(scope) {
        if (!scope || this.#disposed) return [];
        const elements = [];
        if (scope instanceof Element && scope.matches("input[placeholder],textarea[placeholder]")) {
            elements.push(scope);
        }
        if ("querySelectorAll" in scope) {
            elements.push(...Array.from(scope.querySelectorAll("input[placeholder],textarea[placeholder]")));
        }
        for (const shadowRoot of this.#shadowRoots) {
            if (scope === this.#doc.body || scope === this.#doc || (scope instanceof Node && scope.contains(shadowRoot.host))) {
                elements.push(...Array.from(shadowRoot.querySelectorAll("input[placeholder],textarea[placeholder]")));
            }
        }
        if (!elements.length) return [];
        const visibility = new WeakMap();
        return elements.filter((el) => {
            if (!el.isConnected || isGeneratedNode(el) || isTranslationDisabled(el)) return false;
            if (inspectElementHidden(el, visibility) !== 0) return false;
            const raw = el.getAttribute("placeholder") ?? "";
            const previous = this.#placeholderSnapshots.get(el);
            if (previous && raw === previous.translatedText) return false;
            const text = raw.replace(/\s+/g, " ").trim();
            if (!text || !/\p{L}/u.test(text)) return false;
            if (/^v\d+(?:\.\d+)+(?:[-+][\w.-]+)?$/iu.test(text)) return false;
            if (/https?:\/\/|www\.|\S+@\S+\.\S+/iu.test(text)) return false;
            if (isStandaloneShortcutLabel(text)) return false;
            if (this.#targetLanguage.toLowerCase().startsWith("zh") && /\p{Script=Han}/u.test(text)) {
                const chars = Array.from(text.replace(/\s+/g, ""));
                const han = chars.filter((ch) => /\p{Script=Han}/u.test(ch)).length;
                const letters = chars.filter((ch) => /\p{L}/u.test(ch)).length;
                if (han >= 2 && han / Math.max(letters, 1) >= 0.42) return false;
            }
            return true;
        });
    }
    async #translatePlaceholderElement(element) {
        if (this.#disposed || !element.isConnected) return false;
        const originalText = element.getAttribute("placeholder") ?? "";
        const previous = this.#placeholderSnapshots.get(element);
        if (previous && originalText === previous.translatedText) return true;
        const sourceText = originalText.replace(/\s+/g, " ").trim();
        if (!sourceText || !/\p{L}/u.test(sourceText)) return false;
        const bypassCache = this.#forceBypassRoots.has(element);
        const exactTerm = exactTerminologyTarget(sourceText, this.#terminology);
        let translated = exactTerm;
        if (!translated) {
            const baseHtml = this.#wholeSentenceContext
                ? `<span data-flt-text-id="0">${escapeHtml(sourceText)}</span>`
                : escapeHtml(sourceText);
            const protectedMarkers = protectListMarkersHtml(baseHtml);
            const protectedInput = protectTerminologyHtml(this.#doc, protectedMarkers.html, this.#terminology);
            const context = this.#wholeSentenceContext ? translationContextForUrl(this.#doc.URL) : undefined;
            const requestTerminology = terminologyForText(this.#terminology, sourceText);
            for (const entry of terminologyForText(contextualTerminology(context), sourceText)) {
                if (!requestTerminology.some((existing) => existing.source.toLowerCase() === entry.source.toLowerCase())) {
                    requestTerminology.push(entry);
                }
            }
            let translatedHtml = await this.#provider.translateHtml({
                html: protectedInput.html,
                sourceLanguage: this.#sourceLanguage,
                targetLanguage: this.#targetLanguage,
                terminology: requestTerminology,
                ...(context ? { context } : {}),
                ...(bypassCache ? { bypassCache: true } : {}),
            });
            translatedHtml = restoreTerminologyHtml(this.#doc, translatedHtml, protectedInput.replacements);
            translatedHtml = applyTerminologyCorrectionsHtml(this.#doc, translatedHtml, sourceText, this.#terminology);
            translatedHtml = restoreListMarkersHtml(baseHtml, translatedHtml, protectedMarkers.markers);
            translated = translatedPlainText(this.#doc, translatedHtml);
        }
        if (!translated || hasBrokenTranslationText(translated)) return false;
        if (this.#disposed || !element.isConnected || element.getAttribute("placeholder") !== originalText) return false;
        const leading = originalText.match(/^\s*/)?.[0] ?? "";
        const trailing = originalText.match(/\s*$/)?.[0] ?? "";
        const translatedText = leading + translated + trailing;
        this.#placeholderSnapshots.set(element, { originalText, translatedText });
        element.setAttribute("placeholder", translatedText);
        return true;
    }
    async #translatePlaceholdersInScope(scope) {
        const placeholders = this.#collectPlaceholders(scope);
        if (!placeholders.length) return;
        await Promise.all(placeholders.map((el) => this.#translatePlaceholderElement(el).catch(() => false)));
    }
    observeTooltips() {
        if (this.#disposed || this.#tooltipController)
            return;
        this.#tooltipController = new TooltipController(this.#doc, {
            translate: (element) => this.#translateTooltipElement(element),
        });
        this.#tooltipController.start();
    }
    async #translateTooltipElement(element) {
        if (this.#disposed || !element.isConnected)
            return false;
        const previous = this.#tooltipSnapshots.get(element);
        if (previous?.node?.isConnected && previous.node.data === previous.translatedText)
            return true;
        const node = singleTooltipTextNode(element);
        if (!node)
            return false;
        const originalText = node.data;
        const sourceText = originalText.replace(/\s+/g, " ").trim();
        if (!sourceText || !/\p{L}/u.test(sourceText))
            return false;
        const protectedTooltip = protectTerminologyHtml(this.#doc, escapeHtml(sourceText), this.#terminology);
        let translatedHtml = await this.#provider.translateHtml({
            html: protectedTooltip.html,
            sourceLanguage: this.#sourceLanguage,
            targetLanguage: this.#targetLanguage,
            terminology: terminologyForText(this.#terminology, sourceText),
        });
        translatedHtml = restoreTerminologyHtml(this.#doc, translatedHtml, protectedTooltip.replacements);
        translatedHtml = applyTerminologyCorrectionsHtml(this.#doc, translatedHtml, sourceText, this.#terminology);
        const translated = translatedPlainText(this.#doc, translatedHtml);
        if (!translated || hasBrokenTranslationText(translated))
            return false;
        if (this.#disposed || !element.isConnected || node.data !== originalText)
            return false;
        const leading = originalText.match(/^\s*/)?.[0] ?? "";
        const trailing = originalText.match(/\s*$/)?.[0] ?? "";
        const translatedText = leading + translated + trailing;
        this.#tooltipSnapshots.set(element, { node, originalText, translatedText });
        node.data = translatedText;
        return true;
    }
    restore() {
        this.#failures.clear();
        this.#disposed = true;
        this.#syncLearningClickListener();
        this.#observer?.disconnect();
        this.#observer = null;
        for (const observer of this.#shadowObservers.values()) observer.disconnect();
        this.#shadowObservers.clear();
        this.#visibilityObserver?.disconnect();
        this.#visibilityObserver = null;
        this.#deferredRoots.clear();
        this.#doc.removeEventListener("toggle", this.#handleToggle, true);
        for (const stop of this.#pendingProgress.values()) stop();
        this.#pendingProgress.clear();
        this.#progress?.clear();
        this.#tooltipController?.dispose();
        this.#tooltipController = null;
        for (const job of this.#pending.values()) job.resolve();
        this.#pending.clear();
        this.#pendingOrder = [];
        this.#pendingDirty = false;
        this.#cancelCommitTimers();
        this.#clearAwaitingPaint();
        this.#commitFirstQueuedAt = 0;
        for (const task of this.#commitQueue) task.resolve();
        this.#commitQueue = [];
        this.#commitFlushScheduled = false;
        this.#rerun.clear();
        this.#inFlight.clear();
        for (const [root, record] of this.#fixedRecords) this.#clearFixedRecord(root, record);
        this.#fixedRecords.clear();
        this.#fixedOwners = new WeakMap();
        for (const [root, { translationNode }] of this.#records) {
            this.#clearDisplayMode(root);
            translationNode.remove();
        }
        for (const snapshot of this.#tooltipSnapshots.values()) {
            if (snapshot.node?.isConnected && snapshot.node.data === snapshot.translatedText) {
                snapshot.node.data = snapshot.originalText;
            }
        }
        this.#tooltipSnapshots.clear();
        for (const [element, snapshot] of this.#placeholderSnapshots.entries()) {
            if (element?.isConnected && element.getAttribute("placeholder") === snapshot.translatedText) {
                element.setAttribute("placeholder", snapshot.originalText);
            }
        }
        this.#placeholderSnapshots.clear();
        this.#records.clear();
        const cleanupScopes = [this.#doc, ...Array.from(this.#shadowRoots)];
        for (const scope of cleanupScopes) {
            for (const translationNode of Array.from(scope.querySelectorAll('[data-flt-generated="translation"]'))) {
                translationNode.remove();
            }
            if (scope !== this.#doc) {
                for (const styleNode of Array.from(scope.querySelectorAll('style[data-flt-generated="style"]'))) {
                    styleNode.remove();
                }
            }
            for (const root of Array.from(scope.querySelectorAll('.flt-source-hidden, .flt-source-content-hidden, .flt-source-list-hidden, [data-flt-source-link-hidden]'))) {
                this.#clearDisplayMode(root);
            }
            for (const wrapper of Array.from(scope.querySelectorAll("[data-flt-source-text-wrapper]"))) {
                wrapper.replaceWith(...Array.from(wrapper.childNodes));
            }
        }
        this.#shadowRoots.clear();
        for (const [link, styleAttribute] of this.#sourceLinkStyleSnapshots) {
            if (styleAttribute === null) link.removeAttribute("style");
            else link.setAttribute("style", styleAttribute);
            link.removeAttribute("data-flt-source-link-hidden");
        }
        this.#sourceLinkStyleSnapshots.clear();
    }
    #applyDisplayMode(root, translationNode, capturedLayout = null) {
        if (!this.#sourceHadClassAttribute.has(root)) {
            this.#sourceHadClassAttribute.set(root, root.hasAttribute("class"));
        }
        this.#clearDisplayMode(root);
        delete translationNode.dataset.fltDisplayMode;
        if (this.#displayMode !== "translation")
            return;
        if (root.tagName === "LI") {
            const fontSize = capturedLayout?.fontSize ?? this.#doc.defaultView?.getComputedStyle(root)?.fontSize;
            const lineHeight = capturedLayout?.lineHeight ?? this.#doc.defaultView?.getComputedStyle(root)?.lineHeight;
            if (fontSize) root.style.setProperty("--pagelingo-source-font-size", fontSize);
            if (lineHeight) root.style.setProperty("--pagelingo-source-line-height", lineHeight);
            wrapListDirectText(root, translationNode);
            root.classList.add("flt-source-list-hidden");
            translationNode.dataset.fltDisplayMode = "translation";
            return;
        }
        if (["TD", "TH"].includes(root.tagName)) {
            const fontSize = capturedLayout?.fontSize ?? this.#doc.defaultView?.getComputedStyle(root)?.fontSize;
            const lineHeight = capturedLayout?.lineHeight ?? this.#doc.defaultView?.getComputedStyle(root)?.lineHeight;
            if (fontSize) root.style.setProperty("--pagelingo-source-font-size", fontSize);
            if (lineHeight) root.style.setProperty("--pagelingo-source-line-height", lineHeight);
            root.classList.add("flt-source-content-hidden");
            translationNode.dataset.fltDisplayMode = "translation";
            return;
        }
        if (root.tagName === "A") {
            if (!this.#sourceLinkStyleSnapshots.has(root)) this.#sourceLinkStyleSnapshots.set(root, root.getAttribute("style"));
            root.dataset.fltSourceLinkHidden = "true";
            root.style.setProperty("display", "none", "important");
            translationNode.dataset.fltDisplayMode = "translation";
            return;
        }
        root.classList.add("flt-source-hidden");
        translationNode.dataset.fltDisplayMode = "translation";
    }
    #clearDisplayMode(root) {
        root.classList.remove("flt-source-hidden", "flt-source-content-hidden", "flt-source-list-hidden");
        if (this.#sourceHadClassAttribute.get(root) === false && root.classList.length === 0) {
            root.removeAttribute("class");
        }
        if (root.tagName === "LI") unwrapListDirectText(root);
        if (root.tagName !== "A") {
            root.style.removeProperty("--pagelingo-source-font-size");
            root.style.removeProperty("--pagelingo-source-line-height");
        }
        if (root.tagName === "A" && this.#sourceLinkStyleSnapshots.has(root)) {
            const styleAttribute = this.#sourceLinkStyleSnapshots.get(root);
            if (styleAttribute === null) root.removeAttribute("style");
            else root.setAttribute("style", styleAttribute);
        }
        root.removeAttribute("data-flt-source-link-hidden");
    }
    #queue(root, precomputedPriority = null) {
        if (this.#disposed || !root.isConnected) return Promise.resolve();
        if (this.#deferredRoots.delete(root)) this.#visibilityObserver?.unobserve(root);
        const existing = this.#pending.get(root);
        if (existing) return existing.done;
        let resolve;
        const done = new Promise(finish => { resolve = finish; });
        const { tier, top } = precomputedPriority ?? this.#classifyRootPriority(root);
        const job = { root, done, resolve, tier, top };
        this.#pending.set(root, job);
        this.#pendingOrder.push(job);
        this.#pendingDirty = true;
        this.#scheduleFlush();
        return done;
    }
    #scheduleFlush() {
        if (this.#disposed || this.#flushQueued || this.#awaitingPaintPromise || !this.#pending.size || this.#activeJobs >= this.#concurrency) return;
        this.#flushQueued = true;
        const now = performance.now();
        if (!this.#flushBurstStart) this.#flushBurstStart = now;
        if (now - this.#flushBurstStart >= 12) {
            // Yield back to the browser macrotask queue so user clicks, scrolling, and paints never stall.
            this.#flushBurstStart = 0;
            setTimeout(() => this.#flush(), 0);
        } else {
            queueMicrotask(() => this.#flush());
        }
    }
    #flush() {
        this.#flushQueued = false;
        if (this.#disposed || !this.#pending.size || this.#activeJobs >= this.#concurrency) {
            if (!this.#pending.size) this.#flushBurstStart = 0;
            return;
        }
        if (this.#pendingDirty) {
            // Sort descending so popping from the tail is O(1) with zero array shifting.
            this.#pendingOrder.sort((a, b) => (b.tier - a.tier) || (b.top - a.top));
            this.#pendingDirty = false;
        }
        const deferredInFlight = [];
        while (this.#pendingOrder.length > 0 && this.#activeJobs < this.#concurrency) {
            const job = this.#pendingOrder.pop();
            if (!job || this.#pending.get(job.root) !== job) continue;
            if (this.#inFlight.has(job.root)) {
                deferredInFlight.push(job);
                continue;
            }
            this.#pending.delete(job.root);
            this.#activeJobs += 1;
            void this.translateRoot(job.root).catch(error => console.warn("[PageLingo] Translation root failed", error)).finally(() => {
                this.#activeJobs -= 1;
                job.resolve();
                this.#scheduleFlush();
            });
        }
        for (let i = deferredInFlight.length - 1; i >= 0; i -= 1) {
            this.#pendingOrder.push(deferredInFlight[i]);
        }
        if (!this.#pending.size) {
            this.#pendingOrder.length = 0;
            this.#flushBurstStart = 0;
        }
    }
}
