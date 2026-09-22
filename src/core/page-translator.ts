// @ts-nocheck
import { collectTranslationRoots, findTranslationRoot, isGeneratedNode } from "./dom-policy";
import { createSafeTranslatedFragment, mountTranslation } from "./render";
import { escapeHtml, serializeRichSegment, sourceFingerprint, protectTerminologyHtml, applyTerminologyCorrectionsHtml, termOccurrenceCount, restoreTerminologyHtml } from "./rich-segment";
import { freezeNavigationLayout } from "./navigation-layout";

export interface PageTranslatorOptions { sourceLanguage?:string; targetLanguage?:string; concurrency?:number; displayMode?:"translation"|"bilingual"; shouldTranslateRoot?:(root:HTMLElement)=>boolean|Promise<boolean>; terminology?:any[] }
function translatedPlainText(doc, html) {
    const template = doc.createElement("template");
    template.innerHTML = html;
    return (template.content.textContent ?? "").replace(/\s+/g, " ").trim();
}
function exactTerminologyTarget(value, entries) {
    const key = String(value || "").trim().toLocaleLowerCase();
    if (!key) return null;
    const entry = (entries ?? []).find((item) => item.source.toLocaleLowerCase() === key);
    return entry?.target ?? null;
}
function hasBrokenTranslationText(value) {
    return /\uFFFD/u.test(String(value || ""));
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
    if (sourceWord && translatedWord && sourceWord !== translatedWord) {
        if (sourceWord === "why" && /^zh(?:-|$)/i.test(targetLanguage)) {
            const subject = source.replace(/^why\s+/i, "").trim();
            return targetLanguage.toLowerCase().includes("hant") ? `為什麼選擇${subject}` : `为什么选择${subject}`;
        }
        return source;
    }
    // Bergamot can translate an English Why-title into a Chinese When-title. When the
    // source semantic is unambiguous, prefer a deterministic title rather than silently
    // changing the question being asked.
    if (/^why\s+/i.test(source) && /^zh(?:-|$)/i.test(targetLanguage)) {
        const looksLikeWhy = /^(?:为什么|为何|為什麼|為何)/u.test(translated);
        const looksLikeWhen = /^(?:何时|何時|什么时候|什麼時候|幾時)/u.test(translated);
        if (!looksLikeWhy || looksLikeWhen) {
            const subject = source.replace(/^why\s+/i, "").trim();
            return targetLanguage.toLowerCase().includes("hant") ? `為什麼選擇${subject}` : `为什么选择${subject}`;
        }
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
    #pending = new Set();
    #inFlight = new Set();
    #rerun = new Set();
    #observer = null;
    #flushQueued = false;
    #disposed = false;
    #sourceLinkStyleSnapshots = new Map();
    #sourceHadClassAttribute = new WeakMap();
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
        return this.#records.size;
    }
    setDisplayMode(displayMode) {
        if (this.#disposed || this.#displayMode === displayMode)
            return;
        this.#displayMode = displayMode;
        for (const [root, record] of this.#records) {
            this.#applyDisplayMode(root, record.translationNode);
        }
    }
    async translateAll(scope = this.#doc.body) {
        if (this.#disposed)
            return this.#records.size;
        const roots = collectTranslationRoots(scope);
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
        return this.#records.size;
    }
    async translateRoot(root) {
        if (this.#disposed || !root.isConnected || isGeneratedNode(root))
            return;
        if (this.#inFlight.has(root)) {
            this.#rerun.add(root);
            return;
        }
        this.#inFlight.add(root);
        try {
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
        const segment = serializeRichSegment(root);
        if (!segment.html.trim())
            return;
        const protectedSegment = protectTerminologyHtml(this.#doc, segment.html, this.#terminology);
        let translatedHtml = await this.#provider.translateHtml({
            html: protectedSegment.html,
            sourceLanguage: this.#sourceLanguage,
            targetLanguage: this.#targetLanguage,
        });
        if (this.#disposed)
            return;

        // Preferred translations are post-corrections. For a user-only term we learn the
        // engine's standalone default as an alias, but never inject the preferred target into
        // the source sentence before translation.
        const dynamicAliases = new Map();
        const userTerms = this.#terminology.filter((entry) => entry.mode === "replace" && entry.origin === "user" && termOccurrenceCount(segment.fingerprint, entry.source) > 0);
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

        // Whole-sentence translation is authoritative. Standard href transport survives more
        // engines than data-* attributes; matching anchor count is also enough to avoid a
        // second link-label translation.
        const translatedProbe = this.#doc.createElement("template");
        translatedProbe.innerHTML = translatedHtml;
        const probeAnchors = Array.from(translatedProbe.content.querySelectorAll("a"));
        const translatedLinkTexts = await Promise.all(segment.links.map(async (link) => {
            if (!link.sourceText.trim()) return "";
            const exactTerm = exactTerminologyTarget(link.sourceText, this.#terminology);
            if (exactTerm) return exactTerm;
            try {
                const linkHtml = await this.#provider.translateHtml({
                    html: escapeHtml(link.sourceText),
                    sourceLanguage: this.#sourceLanguage,
                    targetLanguage: this.#targetLanguage,
                });
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
        const translatedGapTexts = segment.linkGaps?.length ? await Promise.all(segment.linkGaps.map(async (gap) => {
            if (!gap.trim()) return "";
            try {
                const protectedGap = protectTerminologyHtml(this.#doc, escapeHtml(gap.trim()), this.#terminology);
                const gapHtml = await this.#provider.translateHtml({
                    html: protectedGap.html,
                    sourceLanguage: this.#sourceLanguage,
                    targetLanguage: this.#targetLanguage,
                });
                return translatedPlainText(this.#doc, restoreTerminologyHtml(this.#doc, gapHtml, protectedGap.replacements));
            }
            catch {
                return "";
            }
        })) : [];
        if (this.#disposed || !root.isConnected || sourceFingerprint(root) !== segment.fingerprint)
            return;
        const fragment = createSafeTranslatedFragment(this.#doc, translatedHtml, segment.links, segment.opaque, translatedLinkTexts, translatedGapTexts, protectedSegment.replacements);
        const translationNode = mountTranslation(root, fragment, this.#targetLanguage);
        this.#records.set(root, { translationNode, fingerprint: segment.fingerprint });
        this.#applyDisplayMode(root, translationNode);
        } finally {
            this.#inFlight.delete(root);
            if (this.#rerun.delete(root) && !this.#disposed && root.isConnected) this.#queue(root);
        }
    }
    observe() {
        if (this.#observer || !this.#doc.body)
            return;
        this.#observer = new MutationObserver((mutations) => {
            // SPA frameworks may replace navigation items after the initial page pass.
            // Freeze new navigation slots while they still contain source-language text,
            // before queued translation work can shorten their labels and shift flex/grid layout.
            if (this.#displayMode === "translation") freezeNavigationLayout(false);
            for (const mutation of mutations) {
                if (isGeneratedNode(mutation.target))
                    continue;
                if (mutation.type === "characterData" && mutation.target.nodeType === Node.TEXT_NODE) {
                    const root = findTranslationRoot(mutation.target);
                    if (root)
                        this.#queue(root);
                    continue;
                }
                for (const added of Array.from(mutation.addedNodes)) {
                    if (isGeneratedNode(added))
                        continue;
                    if (added.nodeType === Node.TEXT_NODE) {
                        const root = findTranslationRoot(added);
                        if (root)
                            this.#queue(root);
                    }
                    else if (added.nodeType === Node.ELEMENT_NODE) {
                        if (added.matches?.("[data-flt-source-text-wrapper]"))
                            continue;
                        for (const root of collectTranslationRoots(added))
                            this.#queue(root);
                    }
                }
            }
        });
        this.#observer.observe(this.#doc.body, { childList: true, subtree: true, characterData: true });
    }
    restore() {
        this.#disposed = true;
        this.#observer?.disconnect();
        this.#observer = null;
        this.#pending.clear();
        this.#rerun.clear();
        this.#inFlight.clear();
        for (const [root, { translationNode }] of this.#records) {
            this.#clearDisplayMode(root);
            translationNode.remove();
        }
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
        for (const root of roots) {
            try {
                await this.translateRoot(root);
            }
            catch (error) {
                console.warn("[Local Immersive Translate] Dynamic translation failed", error);
            }
        }
    }
}
