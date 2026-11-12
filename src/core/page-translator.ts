// @ts-nocheck
import { collectTranslationRoots, findTranslationRoot, isGeneratedNode, isTranslationRootElement, isProtectedApiSignature } from "./dom-policy";
import { createSafeTranslatedFragment, mountTranslation } from "./render";
import { escapeHtml, serializeRichSegment, sourceFingerprint, protectTerminologyHtml, applyTerminologyCorrectionsHtml, termOccurrenceCount, terminologyForText, restoreTerminologyHtml } from "./rich-segment";
import { freezeNavigationLayout, releaseNavigationLayoutAfterPaint } from "./navigation-layout";
import { TooltipController } from "./tooltip-controller";
import { contextualTerminology, translationContextForUrl } from "./translation-context";
import {prepareFixedTextRecord, fixedTextRecordUnchanged, clearFixedTextRecord, applyFixedTextRecord} from "./fixed-text-render";
import {restoreFixedHtmlTransport} from "./fixed-html-transport";
import {
    richHtmlStructureCompatible,
    richMarkerCandidateCount,
    richMarkerCandidateMaxDepth,
    translateRichHtmlByStructureBudgetPreservingWrappers,
    translateRichHtmlTextNodesSafely,
} from "./rich-segment-splitter";

export interface PageTranslatorOptions { sourceLanguage?:string; targetLanguage?:string; concurrency?:number; displayMode?:"translation"|"bilingual"; shouldTranslateRoot?:(root:HTMLElement)=>boolean|Promise<boolean>; terminology?:any[] }
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

async function translateLeafSafeRichHtml(doc, provider, html, sourceLanguage, targetLanguage, terminology) {
    const protectedChunk = protectTerminologyHtml(doc, html, terminology);
    const translated = await translateRichHtmlTextNodesSafely(protectedChunk.html, async (sourceText) => {
        const leafHtml = await provider.translateHtml({
            html: escapeHtml(sourceText),
            sourceLanguage,
            targetLanguage,
            terminology: terminologyForText(terminology, sourceText),
        });
        const leafText = translatedPlainText(doc, leafHtml);
        if (!leafText || hasBrokenTranslationText(leafText))
            return sourceText;
        return leafText;
    });
    return restoreTerminologyHtml(doc, translated, protectedChunk.replacements);
}

async function translateComplexRichHtml(doc, provider, html, sourceLanguage, targetLanguage, terminology) {
    const translateChunk = async (chunk) => {
        const chunkSourceText = translatedPlainText(doc, chunk);
        const protectedChunk = protectTerminologyHtml(doc, chunk, terminology);
        let translated = await provider.translateHtml({
            html: protectedChunk.html,
            sourceLanguage,
            targetLanguage,
            terminology: terminologyForText(terminology, chunkSourceText),
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
    #pending = new Set();
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
    #fixedRecords = new Map();
    #fixedOwners = new WeakMap();
    #contextModePromise = null;
    async #loadContextMode() {
        if (!this.#contextModePromise) this.#contextModePromise = Promise.resolve()
            .then(() => this.#provider.prefersWholeSentenceHtml?.() ?? false)
            .then(value => this.#wholeSentenceContext = Boolean(value), () => false);
        return this.#contextModePromise;
    }
    constructor(doc, provider, options = {}) {
        this.#doc = doc;
        this.#provider = provider;
        this.#sourceLanguage = options.sourceLanguage ?? "en";
        this.#targetLanguage = options.targetLanguage ?? "zh";
        this.#concurrency = Math.max(1, options.concurrency ?? 4);
        this.#shouldTranslateRoot = options.shouldTranslateRoot ?? null;
        this.#displayMode = options.displayMode ?? "translation";
        this.#terminology = Array.isArray(options.terminology) ? options.terminology : [];
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
            // Existing nested structural roots own their text independently.
            if (root.contains(owner.root) && isTranslationRootElement(owner.root)) continue;
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
            if (!applyFixedTextRecord(root, record, displayMode, this.#targetLanguage)) {
                this.#clearFixedRecord(root, record); this.#queue(root);
            }
        }
    }
    async translateAll(scope = this.#doc.body) {
        if (this.#disposed)
            return this.translatedCount;
        await this.#loadContextMode();
        const roots = collectTranslationRoots(scope, {preserveInlineContext: this.#wholeSentenceContext});
        let cursor = 0;
        const workers = Array.from({ length: Math.min(this.#concurrency, roots.length) }, async () => {
            while (cursor < roots.length) {
                const root = roots[cursor++];
                if (!root)
                    continue;
                try {
                    await this.translateRoot(root);
                }
                catch (error) {
                    console.warn("[PageLingo] Translation root failed", error);
                }
            }
        });
        await Promise.all(workers);
        return this.translatedCount;
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
        const context = this.#wholeSentenceContext ? translationContextForUrl(this.#doc.URL) : undefined;
        const requestTerminology = terminologyForText(this.#terminology, segment.fingerprint);
        for (const entry of terminologyForText(contextualTerminology(context), segment.fingerprint)) {
            if (!requestTerminology.some(existing => existing.source.toLowerCase() === entry.source.toLowerCase())) requestTerminology.push(entry);
        }
        let translatedHtml;
        const markerCount = richMarkerCandidateCount(segment.html);
        const markerDepth = richMarkerCandidateMaxDepth(segment.html);
        const complexRoot = markerCount >= COMPLEX_ROOT_MARKER_THRESHOLD;
        // Hy-MT regression testing shows a distinct failure pocket at 5-6 markers
        // with 2-3 levels of nesting. For local engines, route that narrow tail
        // through deterministic leaf-safe translation so PageLingo retains markup
        // ownership instead of asking the model to reproduce deep marker structure.
        const nestingRiskRoot = markerCount >= 5 && markerCount <= 6 && markerDepth >= 2;
        const structuralFallbackAllowed =
            !this.#wholeSentenceContext && (complexRoot || nestingRiskRoot) &&
            await providerAllowsStructuralSplitting(this.#provider);
        if (structuralFallbackAllowed && nestingRiskRoot) {
            translatedHtml = await translateLeafSafeRichHtml(
                this.#doc,
                this.#provider,
                segment.html,
                this.#sourceLanguage,
                this.#targetLanguage,
                this.#terminology,
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
        translatedHtml = applyTerminologyCorrectionsHtml(this.#doc, translatedHtml, segment.fingerprint, this.#terminology, dynamicAliases);
        if (hasBrokenTranslationHtml(translatedHtml)) {
            throw new Error("译文包含损坏字符，已保留原文");
        }

        // The main HTML translation is authoritative when every source link keeps a
        // unique transport identity and a non-empty translated label. In that common path
        // there is nothing to recover, so do not spend extra Bergamot calls on each label
        // and the text gaps around them. Keep the previous standalone path only as a
        // transport-damage fallback.
        if (this.#wholeSentenceContext) translatedHtml = restoreFixedHtmlTransport(segment.html, translatedHtml);
        const mainLinksComplete = translatedLinkTransportComplete(translatedHtml, segment.links);
        if (this.#wholeSentenceContext && !mainLinksComplete) throw new Error("MT link transport incomplete; preserving the original paragraph");
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
            const record = prepareFixedTextRecord(root, segment.textSlots, translatedHtml);
            if (!applyFixedTextRecord(root, record, this.#displayMode, this.#targetLanguage)) return;
            this.#fixedRecords.set(root, record);
            for (const edit of record.edits) this.#fixedOwners.set(edit.node, record);
            return;
        }
        const fragment = createSafeTranslatedFragment(this.#doc, translatedHtml, segment.links, segment.opaque, translatedLinkTexts, translatedGapTexts, []);
        const translationNode = mountTranslation(root, fragment, this.#targetLanguage);
        this.#records.set(root, { translationNode, fingerprint: segment.fingerprint });
        this.#applyDisplayMode(root, translationNode);
        } catch (error) {
            this.#failures.set(root, error instanceof Error ? error.message : String(error));
            throw error;
        } finally {
            this.#inFlight.delete(root);
            if (this.#rerun.delete(root) && !this.#disposed && root.isConnected) this.#queue(root);
        }
    }
    observe() {
        if (this.#observer || !this.#doc.body)
            return;
        this.#observer = new MutationObserver((mutations) => {
            for (const mutation of mutations) {
                if (isGeneratedNode(mutation.target))
                    continue;
                if (mutation.type === "characterData" && mutation.target.nodeType === Node.TEXT_NODE) {
                    const parent = mutation.target.parentElement;
                    if (parent) {
                        for (const root of collectTranslationRoots(parent, {preserveInlineContext: this.#wholeSentenceContext}))
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
                            for (const root of collectTranslationRoots(parent, {preserveInlineContext: this.#wholeSentenceContext}))
                                this.#queue(root);
                        }
                    }
                    else if (added.nodeType === Node.ELEMENT_NODE) {
                        if (added.matches?.("[data-flt-source-text-wrapper]"))
                            continue;
                        for (const root of collectTranslationRoots(added, {preserveInlineContext: this.#wholeSentenceContext}))
                            this.#queue(root);
                    }
                }
            }
        });
        this.#observer.observe(this.#doc.body, { childList: true, subtree: true, characterData: true });
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
        this.#tooltipController?.dispose();
        this.#tooltipController = null;
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
        for (const translationNode of Array.from(this.#doc.querySelectorAll('[data-flt-generated="translation"]'))) {
            translationNode.remove();
        }
        for (const root of Array.from(this.#doc.querySelectorAll('.flt-source-hidden, .flt-source-content-hidden, .flt-source-list-hidden, [data-flt-source-link-hidden]'))) {
            this.#clearDisplayMode(root);
        }
        for (const [link, styleAttribute] of this.#sourceLinkStyleSnapshots) {
            if (styleAttribute === null) link.removeAttribute("style");
            else link.setAttribute("style", styleAttribute);
            link.removeAttribute("data-flt-source-link-hidden");
        }
        this.#sourceLinkStyleSnapshots.clear();
        for (const wrapper of Array.from(this.#doc.querySelectorAll("[data-flt-source-text-wrapper]"))) {
            wrapper.replaceWith(...Array.from(wrapper.childNodes));
        }
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
        // Do not tear down an existing translation just because a mutation was observed.
        // Our own source wrappers generate child-list mutations; translateRoot compares the
        // source-only fingerprint and keeps the current translation when nothing actually changed.
        this.#pending.add(root);
        if (this.#flushQueued)
            return;
        this.#flushQueued = true;
        queueMicrotask(() => void this.#flush());
    }
    async #flush() {
        this.#flushQueued = false;
        const roots = Array.from(this.#pending);
        this.#pending.clear();
        const guardNavigation = !this.#wholeSentenceContext && this.#displayMode === "translation" && roots.length > 0;
        const navigationHold = guardNavigation ? freezeNavigationLayout(false) : null;
        try {
            for (const root of roots) {
                try {
                    await this.translateRoot(root);
                }
                catch (error) {
                    console.warn("[Local Immersive Translate] Dynamic translation failed", error);
                }
            }
        }
        finally {
            if (navigationHold) releaseNavigationLayoutAfterPaint(navigationHold);
        }
    }
}
