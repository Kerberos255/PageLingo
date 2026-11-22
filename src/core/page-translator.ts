// @ts-nocheck
import { collectTranslationRoots, findTranslationRoot, hasNestedOwnerBoundaryBetween, isElementEffectivelyHidden, isGeneratedNode, isTranslationRootElement, isProtectedApiSignature } from "./dom-policy";
import { TranslationProgress } from "./translation-progress";
import { createSafeTranslatedFragment, mountTranslation } from "./render";
import { escapeHtml, serializeRichSegment, sourceFingerprint, protectTerminologyHtml, applyTerminologyCorrectionsHtml, termOccurrenceCount, terminologyForText, restoreTerminologyHtml } from "./rich-segment";
import { TooltipController } from "./tooltip-controller";
import { contextualTerminology, translationContextForUrl } from "./translation-context";
import {prepareFixedTextRecord, fixedTextRecordUnchanged, clearFixedTextRecord, applyFixedTextRecord} from "./fixed-text-render";
import {restoreFixedHtmlTransport} from "./fixed-html-transport";
import {isPreformattedNewlineContext, planPreformattedParagraphRuns} from "./fixed-html-paragraphs";
import {
    richHtmlStructureCompatible,
    richMarkerCandidateCount,
    richMarkerCandidateMaxDepth,
    translateRichHtmlByStructureBudgetPreservingWrappers,
    translateRichHtmlTextNodesSafely,
} from "./rich-segment-splitter";

export interface PageTranslatorOptions { sourceLanguage?:string; targetLanguage?:string; concurrency?:number; displayMode?:"translation"|"bilingual"; shouldTranslateRoot?:(root:HTMLElement)=>boolean|Promise<boolean>; terminology?:any[]; showProgress?:boolean; bypassCache?:boolean }
function translatedPlainText(_doc, html) {
    const parsed = new DOMParser().parseFromString(html, "text/html");
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
    const parsed = new DOMParser().parseFromString(html, "text/html");
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
    #activeJobs = 0;
    #hiddenScopes = new WeakSet();
    #pendingProgress = new Map();
    #progress;
    #inFlight = new Set();
    #rerun = new Set();
    #observer = null;
    #tooltipController = null;
    #tooltipSnapshots = new Map();
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
        for (const root of roots) {
            const rect = root.getBoundingClientRect();
            if (rect.width > 0 || rect.height > 0 || rect.top !== 0 || rect.bottom !== 0) return true;
        }
        return false;
    }
    #classifyRootPriority(root) {
        const view = this.#doc.defaultView;
        const rect = root.getBoundingClientRect();
        const vh = view?.innerHeight ?? 0;
        const vw = view?.innerWidth ?? 0;
        const visible = rect.bottom > 0 && rect.top < vh && rect.right > 0 && rect.left < vw;
        const nearViewport = !visible && rect.bottom > -200 && rect.top < vh + 500 && rect.right > -100 && rect.left < vw + 100;
        const inMain = Boolean(root.closest("main, article, [role='main']"));
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
                if (root.isConnected) revealed.push(root);
            }
            if (!revealed.length) return;
            revealed.sort((a, b) => {
                const pa = this.#classifyRootPriority(a);
                const pb = this.#classifyRootPriority(b);
                return pa.tier - pb.tier || pa.top - pb.top;
            });
            for (const root of revealed) void this.#queue(root);
        }, { rootMargin: "600px 0px" });
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
        this.#terminology = Array.isArray(options.terminology) ? options.terminology : [];
        this.#bypassCache = options.bypassCache === true;
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
    setDisplayMode(displayMode) {
        if (this.#disposed || this.#displayMode === displayMode)
            return;
        this.#displayMode = displayMode;
        for (const [root, record] of this.#records) {
            this.#applyDisplayMode(root, record.translationNode);
        }
        for (const [root, record] of this.#fixedRecords) {
            if (displayMode === "bilingual") this.#ensureShadowStyle(root);
            if (!applyFixedTextRecord(root, record, displayMode, this.#targetLanguage)) {
                this.#clearFixedRecord(root, record); this.#queue(root);
            }
        }
    }
    async translateAll(scope = this.#doc.body, watchDuringPass = false) {
        if (this.#disposed)
            return this.translatedCount;
        await this.#loadContextMode();
        if (watchDuringPass) this.observe();
        const collected = this.#collect(scope);
        if (this.#bypassCache) {
            for (const root of collected) this.#forceBypassRoots.add(root);
            this.#bypassCache = false;
        }
        const hasGeometry = this.#hasRealViewportGeometry(collected);
        const ObserverCtor = this.#doc.defaultView?.IntersectionObserver ?? globalThis.IntersectionObserver;
        const useLazy = this.#lazyOffscreen && hasGeometry && typeof ObserverCtor === "function";
        const ranked = collected.map((root, index) => {
            const priority = hasGeometry ? this.#classifyRootPriority(root) : { tier: 0, top: index, visible: true };
            return { root, index, ...priority };
        });
        if (hasGeometry) {
            ranked.sort((a, b) => a.tier - b.tier || a.top - b.top || a.index - b.index);
        }
        if (useLazy) {
            const immediate = [];
            const deferred = [];
            for (const item of ranked) {
                if (item.tier <= 3) immediate.push(item.root);
                else deferred.push(item.root);
            }
            if (immediate.length === 0 && deferred.length > 0) {
                immediate.push(...deferred.splice(0, 8));
            }
            for (const root of deferred) this.#deferRoot(root);
            await Promise.all(immediate.map((root) => this.#queue(root)));
            return this.translatedCount;
        }
        await Promise.all(ranked.map(({ root }) => this.#queue(root)));
        return this.translatedCount;
    }
    #watchHiddenFade(element) {
        this.#hiddenScopes.add(element);
        if (this.#watchedFadeScopes.has(element) || typeof element.getAnimations !== "function") return;
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
    #ensureShadowStyle(root) {
        const rootNode = root.getRootNode?.();
        if (!rootNode || rootNode === this.#doc || rootNode.nodeType !== Node.DOCUMENT_FRAGMENT_NODE || !("host" in rootNode)) return;
        this.#shadowRoots.add(rootNode);
        if (rootNode.querySelector('style[data-flt-generated="style"]')) return;
        const style = this.#doc.createElement("style");
        style.dataset.fltGenerated = "style";
        style.textContent = ".flt-translation { display: block !important; margin-block-start: 0.28em !important; font: inherit !important; line-height: inherit !important; letter-spacing: inherit !important; text-transform: none !important; } .flt-translation a { display: inline !important; } .flt-source-hidden { display: none !important; }";
        rootNode.append(style);
    }
    #collect(scope) {
        return collectTranslationRoots(scope, {
            preserveInlineContext: this.#wholeSentenceContext,
            onHidden: element => this.#watchHiddenFade(element),
            onShadowRoot: shadowRoot => this.#registerShadowRoot(shadowRoot),
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
        const segment = serializeRichSegment(root, {fixedTextSlots: this.#wholeSentenceContext});
        if (this.#wholeSentenceContext && !segment.textSlots.length) return;
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
        const paragraphPlan = this.#wholeSentenceContext && isPreformattedNewlineContext(root)
            ? planPreformattedParagraphRuns(segment.html)
            : null;
        let terminologyAppliedPerRun = false;
        if (paragraphPlan) {
            const settledRuns = await Promise.allSettled(paragraphPlan.runs.map(async (run) => {
                const runTerms = terminologyForText(this.#terminology, run.plainText);
                for (const entry of terminologyForText(contextualTerminology(context), run.plainText)) {
                    if (!runTerms.some(existing => existing.source.toLowerCase() === entry.source.toLowerCase())) runTerms.push(entry);
                }
                const protectedRun = protectTerminologyHtml(this.#doc, run.html, this.#terminology);
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
            // Keep the complete root and its protected terminology in one provider request.
            const protectedSegment = protectTerminologyHtml(this.#doc, segment.html, this.#terminology);
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
        if (!terminologyAppliedPerRun) {
            translatedHtml = applyTerminologyCorrectionsHtml(this.#doc, translatedHtml, segment.fingerprint, this.#terminology, dynamicAliases);
            if (hasBrokenTranslationHtml(translatedHtml)) {
                throw new Error("译文包含损坏字符，已保留原文");
            }
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
            if (this.#displayMode === "bilingual") this.#ensureShadowStyle(root);
            const record = prepareFixedTextRecord(root, segment.textSlots, translatedHtml, this.#targetLanguage);
            if (!applyFixedTextRecord(root, record, this.#displayMode, this.#targetLanguage)) return;
            this.#fixedRecords.set(root, record);
            for (const edit of record.edits) this.#fixedOwners.set(edit.node, record);
            return;
        }
        this.#ensureShadowStyle(root);
        const fragment = createSafeTranslatedFragment(this.#doc, translatedHtml, segment.links, segment.opaque, translatedLinkTexts, translatedGapTexts, []);
        const translationNode = mountTranslation(root, fragment, this.#targetLanguage);
        this.#records.set(root, { translationNode, fingerprint: segment.fingerprint });
        this.#applyDisplayMode(root, translationNode);
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
                if (["aria-expanded", "aria-selected"].includes(mutation.attributeName)) {
                    if (region.getAttribute(mutation.attributeName) !== "true") continue;
                    const scopeRoot = region.getRootNode?.();
                    for (const id of (region.getAttribute("aria-controls") ?? "").split(/\s+/)) {
                        const panel = scopeRoot?.getElementById?.(id) ?? this.#doc.getElementById(id);
                        if (panel) revealed.add(panel);
                    }
                    continue;
                }
                if (["class", "style"].includes(mutation.attributeName)
                    && !this.#hiddenScopes.has(region)
                    && !region.matches("dialog,[popover],[role='dialog'],[role='tabpanel'],[role='menu'],[role='listbox']")) continue;
                if ((mutation.attributeName !== "open" || region.hasAttribute("open"))
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
                    if (added.matches?.("[data-flt-source-text-wrapper]"))
                        continue;
                    for (const root of this.#collect(added))
                        this.#queue(root);
                }
            }
        }
        for (const region of revealed) {
            if ([...revealed].some(parent => parent !== region && parent.contains(region))) continue;
            if (!isElementEffectivelyHidden(region)) {
                this.#queueVisibleScope(region);
                continue;
            }
            // Accessibility state or added nodes can appear before a CSS fade completes.
            this.#watchHiddenFade(region);
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
        for (const root of this.#collect(region)) {
            this.#queue(root);
        }
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
    #applyDisplayMode(root, translationNode) {
        if (!this.#sourceHadClassAttribute.has(root)) {
            this.#sourceHadClassAttribute.set(root, root.hasAttribute("class"));
        }
        this.#clearDisplayMode(root);
        if (this.#displayMode !== "translation")
            return;
        if (root.tagName === "LI") {
            const computed = this.#doc.defaultView?.getComputedStyle(root);
            if (computed) {
                root.style.setProperty("--pagelingo-source-font-size", computed.fontSize);
                root.style.setProperty("--pagelingo-source-line-height", computed.lineHeight);
            }
            wrapListDirectText(root, translationNode);
            root.classList.add("flt-source-list-hidden");
            translationNode.dataset.fltDisplayMode = "translation";
            return;
        }
        if (["TD", "TH"].includes(root.tagName)) {
            const computed = this.#doc.defaultView?.getComputedStyle(root);
            if (computed) {
                root.style.setProperty("--pagelingo-source-font-size", computed.fontSize);
                root.style.setProperty("--pagelingo-source-line-height", computed.lineHeight);
            }
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
    #queue(root) {
        if (this.#disposed || !root.isConnected) return Promise.resolve();
        if (this.#deferredRoots.delete(root)) this.#visibilityObserver?.unobserve(root);
        const existing = this.#pending.get(root);
        if (existing) return existing.done;
        let resolve;
        const done = new Promise(finish => { resolve = finish; });
        const { tier, top } = this.#classifyRootPriority(root);
        this.#pending.set(root, { done, resolve, tier, top });
        this.#scheduleFlush();
        return done;
    }
    #scheduleFlush() {
        if (this.#disposed || this.#flushQueued || !this.#pending.size || this.#activeJobs >= this.#concurrency) return;
        this.#flushQueued = true;
        queueMicrotask(() => this.#flush());
    }
    #flush() {
        this.#flushQueued = false;
        // Dispatch visible <main>/<article> roots first, then other visible roots, then near/off-screen.
        const ready = Array.from(this.#pending.entries()).filter(([root]) => !this.#inFlight.has(root));
        ready.sort(([, a], [, b]) => a.tier - b.tier || a.top - b.top);
        for (const [root, job] of ready) {
            if (this.#activeJobs >= this.#concurrency) return;
            this.#pending.delete(root);
            this.#activeJobs += 1;
            void this.translateRoot(root).catch(error => console.warn("[PageLingo] Translation root failed", error)).finally(() => {
                this.#activeJobs -= 1;
                job.resolve();
                this.#scheduleFlush();
            });
        }
    }
}
