// @ts-nocheck
import { isElementEffectivelyHidden, isNestedOwnerBoundary, isEligibleTextNode, isEligibleTextContext, isTranslationDisabled, isProtectedTranslationSubtree, isProtectedFilePathLink } from "./dom-policy";
import type { SourceTextSlot } from "./fixed-text-render";
import { normalizeGlossaryEntry } from "../shared/settings";
import { parseHtmlDocument } from "../shared/html-parser";

export interface LinkStyleSnapshot { color:string; textDecorationLine:string; textDecorationStyle:string; textDecorationColor:string; textDecorationThickness:string; textUnderlineOffset:string }
export interface LinkSnapshot { href:string|null; target:string|null; rel:string|null; title:string|null; className:string; sourceElement:HTMLAnchorElement; sourceText:string; linkStyle:LinkStyleSnapshot|null }
export interface OpaqueSnapshot { tagName:string; text:string }
export interface TerminologyEntry { source:string; target:string; mode:"protect"|"replace"; caseSensitive?:boolean; origin?:"builtin"|"user"; aliases?:string[] }
export type SerializedSourcePart =
    | {kind:"text"; node:Text; source:string; slotId:number|null; editableContext:boolean}
    | {kind:"opaque"; node:HTMLElement; source:string; opaqueIndex:number}
    | {kind:"element"; node:HTMLElement; tagName:string; inline:boolean; children:SerializedSourcePart[]; fallbackText?:string}
    | {kind:"boundary"; node:HTMLElement; reason:"generated"|"time"|"hidden"|"nested-root"|"br"|"wbr"|"protected"};
export interface SerializedSourceTrace { parts:SerializedSourcePart[]; trimStart:number; trimEnd:number }
export interface RichSegment { html:string; links:LinkSnapshot[]; opaque:OpaqueSnapshot[]; linkGaps:string[]; fingerprint:string; textSlots?:SourceTextSlot[]; sourceTrace?:SerializedSourceTrace; hiddenElements?:Set<Element> }

const LINK_TRANSPORT_PREFIX = "https://pagelingo.invalid/__link/";
var INLINE_TAGS = new Set([
    "A", "SPAN", "STRONG", "EM", "B", "I", "U", "S", "SMALL",
    "SUB", "SUP", "MARK", "ABBR", "CITE", "Q", "DEL", "INS",
    "DFN", "TIME", "BDI", "BDO", "DATA", "OUTPUT",
    "CODE", "KBD", "SAMP", "VAR", "BR", "WBR",
]);
var OPAQUE_TAGS = new Set(["CODE", "KBD", "SAMP", "VAR"]);
var DYNAMIC_TIME_TAGS = new Set(["RELATIVE-TIME", "TIME-AGO", "LOCAL-TIME"]);
export function escapeHtml(value) {
    return value
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;");
}
function parseHtmlFragment(doc, html) {
    const parsed = parseHtmlDocument(html);
    const fragment = doc.createDocumentFragment();
    for (const child of Array.from(parsed.body.childNodes)) fragment.append(doc.importNode(child, true));
    return fragment;
}
function snapshotLink(element, captureStyle = true) {
    const computed = captureStyle ? element.ownerDocument.defaultView?.getComputedStyle(element) : null;
    return {
        href: element.getAttribute("href"),
        target: element.getAttribute("target"),
        rel: element.getAttribute("rel"),
        title: element.getAttribute("title"),
        className: element.className,
        sourceElement: element,
        sourceText: element.textContent ?? "",
        linkStyle: computed ? {
            color: computed.color,
            textDecorationLine: computed.textDecorationLine,
            textDecorationStyle: computed.textDecorationStyle,
            textDecorationColor: computed.textDecorationColor,
            textDecorationThickness: computed.textDecorationThickness,
            textUnderlineOffset: computed.textUnderlineOffset,
        } : null,
    };
}
const MID_SENTENCE_NEWLINE_RE = /(?<=\S)[ \t]*\r?\n[ \t]*(?=\S)/gu;
function serializeChildren(parent, root, links, opaque, textSlots, trace, collapseNewlines = false, visibilityCache = undefined, hiddenElements = undefined) {
    let html = "";
    for (const node of parent.childNodes) {
        if (node.nodeType === Node.TEXT_NODE) {
            if (textSlots && isTranslationDisabled(node.parentElement)) {
                const index = opaque.length;
                opaque.push({tagName: "SPAN", text: node.data});
                html += `<code>__FLT_OPAQUE_${index}__</code>`;
                trace?.push({kind: "text", node, source: node.data, slotId: null, editableContext: false});
                continue;
            }
            const rawText = node.textContent ?? "";
            const transportText = collapseNewlines ? rawText.replace(MID_SENTENCE_NEWLINE_RE, " ") : rawText;
            const text = escapeHtml(transportText);
            let slotId = null;
            if (textSlots && rawText.trim()) {
                if (isEligibleTextNode(node, visibilityCache, root)) {
                    const id = textSlots.length;
                    slotId = id;
                    textSlots.push({id, node, parent: node.parentNode, source: node.data});
                    html += `<span data-flt-text-id="${id}">${text}</span>`;
                } else html += `<span data-flt-fixed="true">${text}</span>`;
            } else html += text;
            if (trace) trace.push({kind: "text", node, source: node.data, slotId, editableContext: isEligibleTextContext(node, visibilityCache, root)});
            continue;
        }
        if (node.nodeType !== Node.ELEMENT_NODE)
            continue;
        const element = node;
        if (element.hasAttribute("data-flt-generated")) {
            trace?.push({kind: "boundary", node: element, reason: "generated"});
            continue;
        }
        if (element !== root && DYNAMIC_TIME_TAGS.has(element.tagName)) {
            trace?.push({kind: "boundary", node: element, reason: "time"});
            continue;
        }
        if (element !== root && isElementEffectivelyHidden(element, visibilityCache, root)) {
            hiddenElements?.add(element);
            trace?.push({kind: "boundary", node: element, reason: "hidden"});
            continue;
        }
        if (element !== root && isNestedOwnerBoundary(element, root)) {
            trace?.push({kind: "boundary", node: element, reason: "nested-root"});
            continue;
        }
        const tag = element.tagName;
        if (textSlots && !OPAQUE_TAGS.has(tag) && (isProtectedFilePathLink(element)
            || (isTranslationDisabled(element) && !element.querySelector('[translate="yes" i],[translate=""]')))) {
            const index = opaque.length;
            const source = element.textContent ?? "";
            opaque.push({tagName: tag, text: source});
            html += `<code>__FLT_OPAQUE_${index}__</code>`;
            trace?.push({kind: "opaque", node: element, source, opaqueIndex: index});
            continue;
        }
        // Controls, SVG and other excluded subtrees remain source-owned. Do not
        // leak their labels/options into a fixed HTML request as editable prose.
        if (textSlots && !OPAQUE_TAGS.has(tag) && isProtectedTranslationSubtree(element)) {
            trace?.push({kind: "boundary", node: element, reason: "protected"});
            continue;
        }
        if (!INLINE_TAGS.has(tag)) {
            const children = trace ? [] : undefined;
            html += serializeChildren(element, root, links, opaque, textSlots, children, collapseNewlines, visibilityCache, hiddenElements);
            trace?.push({kind: "element", node: element, tagName: tag, inline: false, children});
            continue;
        }
        const lower = tag.toLowerCase();
        if (tag === "BR" || tag === "WBR") {
            html += `<${lower}>`;
            trace?.push({kind: "boundary", node: element, reason: tag === "BR" ? "br" : "wbr"});
            continue;
        }
        if (tag === "A") {
            const linkIndex = links.length;
            links.push(snapshotLink(element, !textSlots));
            // Legacy providers use link sentinels for recovery. Original-node mode additionally maps
            // each original text node to a fixed slot; link topology is application-owned.
            const children = trace ? [] : undefined;
            const serializedLabel = serializeChildren(element, root, links, opaque, textSlots, children, collapseNewlines, visibilityCache, hiddenElements);
            if (textSlots && !serializedLabel.replace(/<[^>]*>/gu, "").trim()) {
                links.pop();
                trace?.push({kind: "boundary", node: element, reason: "protected"});
                continue;
            }
            const labelHtml = serializedLabel || escapeHtml(element.textContent ?? "");
            html += `<a data-flt-link-id="${linkIndex}" href="${LINK_TRANSPORT_PREFIX}${linkIndex}"><code>__FLT_LINK_START_${linkIndex}__</code>${labelHtml}<code>__FLT_LINK_END_${linkIndex}__</code></a>`;
            trace?.push({kind: "element", node: element, tagName: tag, inline: true, children,
                ...(!serializedLabel ? {fallbackText: element.textContent ?? ""} : {})});
            continue;
        }
        if (OPAQUE_TAGS.has(tag)) {
            const index = opaque.length;
            opaque.push({ tagName: tag, text: element.textContent ?? "" });
            html += `<${lower}>__FLT_OPAQUE_${index}__</${lower}>`;
            trace?.push({kind: "opaque", node: element, source: element.textContent ?? "", opaqueIndex: index});
            continue;
        }
        const children = trace ? [] : undefined;
        const innerHtml = serializeChildren(element, root, links, opaque, textSlots, children, collapseNewlines, visibilityCache, hiddenElements);
        if (textSlots && !innerHtml.replace(/<[^>]*>/gu, "").trim() && !innerHtml.includes("data-flt-") && !innerHtml.includes("__FLT_")) {
            html += innerHtml;
            trace?.push({kind: "boundary", node: element, reason: "protected"});
            continue;
        }
        html += `<${lower}>${innerHtml}</${lower}>`;
        trace?.push({kind: "element", node: element, tagName: tag, inline: true, children});
    }
    return html;
}
export function sourceFingerprint(root, {excludeNestedRoots = false} = {}) {
    let text = "";
    const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let current = walker.nextNode();
    while (current) {
        const node = current;
        let nested = false;
        if (excludeNestedRoots) {
            for (let parent = node.parentElement; parent && parent !== root; parent = parent.parentElement) {
                if (isNestedOwnerBoundary(parent, root)) { nested = true; break; }
            }
        }
        if (!nested && !node.parentElement?.closest("[data-flt-generated]") && !node.parentElement?.closest("[hidden],[aria-hidden='true'],tool-tip,[role='tooltip'],[inert]")) text += node.data;
        current = walker.nextNode();
    }
    return text;
}
function snapshotLinkGaps(root, visibilityCache = undefined) {
    const gaps = [""];
    let linkIndex = 0;
    function walk(parent) {
        for (const node of parent.childNodes) {
            if (node.nodeType === Node.TEXT_NODE) {
                gaps[linkIndex] = (gaps[linkIndex] ?? "") + (node.textContent ?? "");
                continue;
            }
            if (node.nodeType !== Node.ELEMENT_NODE) continue;
            const element = node;
            if (element.hasAttribute("data-flt-generated")) continue;
            if (element !== root && DYNAMIC_TIME_TAGS.has(element.tagName)) continue;
            if (element !== root && isElementEffectivelyHidden(element, visibilityCache, root)) continue;
            if (element !== root && isNestedOwnerBoundary(element, root)) continue;
            if (element.tagName === "A") {
                linkIndex += 1;
                if (gaps[linkIndex] === undefined) gaps[linkIndex] = "";
                continue;
            }
            walk(element);
        }
    }
    walk(root);
    return gaps;
}
export function serializeRichSegment(root, {fixedTextSlots = false, captureOwnership = false, collapseNewlines = false} = {}): RichSegment {
    if (captureOwnership && !fixedTextSlots) throw new Error("Source ownership requires fixed text slots");
    const links = [];
    const opaque = [];
    const textSlots = fixedTextSlots ? [] : undefined;
    const parts = captureOwnership ? [] : undefined;
    const visibilityCache = new WeakMap();
    visibilityCache.set(root, false);
    const hiddenElements = fixedTextSlots ? new Set<Element>() : undefined;
    const untrimmed = serializeChildren(root, root, links, opaque, textSlots, parts, collapseNewlines, visibilityCache, hiddenElements);
    let html = untrimmed.trim();
    if (root.tagName === "A") {
        links.unshift(snapshotLink(root, !fixedTextSlots));
        const labelHtml = html || escapeHtml(root.textContent ?? "");
        html = `<a data-flt-link-id="0" href="${LINK_TRANSPORT_PREFIX}0"><code>__FLT_LINK_START_0__</code>${labelHtml}<code>__FLT_LINK_END_0__</code></a>`;
    }
    return {
        html,
        links,
        opaque,
        linkGaps: !fixedTextSlots && links.length > 0 && root.tagName !== "A" ? snapshotLinkGaps(root, visibilityCache) : [],
        fingerprint: sourceFingerprint(root, {excludeNestedRoots: fixedTextSlots}),
        textSlots,
        ...(hiddenElements ? {hiddenElements} : {}),
        ...(parts ? {sourceTrace: {parts, trimStart: untrimmed.length - untrimmed.trimStart().length,
            trimEnd: untrimmed.length - untrimmed.trimEnd().length}} : {}),
    };
}
// PageLingo v21 terminology layer. Protect-only terms may be shielded before
// translation; preferred translations are corrected after the whole sentence has
// been translated so they never contaminate the source sentence with mixed languages.
function builtInTerminology(sourceLanguage, targetLanguage) {
    const catalog = globalThis.__PAGELINGO_BUILTIN_GLOSSARY__ ?? {};
    const entries = [];
    const hardProtect = [
        ...(Array.isArray(catalog.hardPreserve) ? catalog.hardPreserve : []),
        ...(Array.isArray(catalog.hardProtect) ? catalog.hardProtect : (Array.isArray(catalog.protect) ? catalog.protect : [])),
    ];
    for (const source of hardProtect) {
        if (typeof source === "string" && source.trim()) entries.push({ source, target: source, mode: "protect", caseSensitive: true, origin: "builtin", aliases: [] });
    }
    for (const source of Array.isArray(catalog.preserve) ? catalog.preserve : []) {
        if (typeof source === "string" && source.trim()) entries.push({ source, target: source, mode: "replace", caseSensitive: false, origin: "builtin", aliases: [] });
    }
    const pairKey = `${sourceLanguage}->${targetLanguage}`;
    for (const pair of Array.isArray(catalog.pairs?.[pairKey]) ? catalog.pairs[pairKey] : []) {
        if (!Array.isArray(pair) || typeof pair[0] !== "string" || typeof pair[1] !== "string") continue;
        entries.push({ source: pair[0], target: pair[1], mode: "replace", caseSensitive: false, origin: "builtin", aliases: [pair[1]] });
    }
    return entries;
}
export function parseTerminology(collections, sourceLanguage = "en", targetLanguage = "zh-Hans", builtinEnabled = true) {
    const map = new Map();
    if (builtinEnabled) {
        for (const entry of builtInTerminology(sourceLanguage, targetLanguage)) map.set(entry.source.toLocaleLowerCase(), entry);
    }
    for (const collection of Array.isArray(collections) ? collections : []) {
        if (!collection || collection.enabled === false || !Array.isArray(collection.entries)) continue;
        for (const rawEntry of collection.entries) {
            const normalized = normalizeGlossaryEntry(rawEntry);
            if (!normalized) continue;
            const key = normalized.source.toLocaleLowerCase();
            const previous = map.get(key);
            const aliases = new Set([normalized.source]);
            if (previous?.target) aliases.add(previous.target);
            for (const alias of previous?.aliases ?? []) aliases.add(alias);
            aliases.delete(normalized.target);
            map.set(key, { ...normalized, origin: "user", aliases: Array.from(aliases) });
        }
    }
    return Array.from(map.values()).sort((a, b) => b.source.length - a.source.length);
}
function termBoundaryOkay(text, start, end, source) {
    if (!/^[A-Za-z0-9_.-]+$/.test(source)) return true;
    const before = start > 0 ? text[start - 1] : "";
    const after = end < text.length ? text[end] : "";
    return !/[A-Za-z0-9_]/.test(before) && !/[A-Za-z0-9_]/.test(after);
}
export function termOccurrenceCount(text, source, caseSensitive = false) {
    const raw = String(text || "");
    const haystack = caseSensitive ? raw : raw.toLocaleLowerCase();
    const needle = caseSensitive ? source : source.toLocaleLowerCase();
    let count = 0, cursor = 0;
    while (cursor <= raw.length - needle.length) {
        const at = haystack.indexOf(needle, cursor);
        if (at < 0) break;
        if (termBoundaryOkay(raw, at, at + needle.length, source)) count += 1;
        cursor = at + Math.max(needle.length, 1);
    }
    return count;
}
export function terminologyForText(entries, text) {
    return (entries ?? [])
        .filter((entry) => termOccurrenceCount(text, entry.source, entry.caseSensitive === true) > 0)
        .map((entry) => ({ source: entry.source, target: entry.target, mode: entry.mode }));
}
export function protectTerminologyHtml(doc, html, entries) {
    const protectedEntries = (entries ?? []).filter((entry) => entry.mode === "protect");
    if (!protectedEntries.length) return { html, replacements: [] };
    const content = parseHtmlFragment(doc, html);
    const replacements = protectTerminologyInFragment(content, protectedEntries);
    const holder = doc.createElement("div");
    holder.append(content.cloneNode(true));
    return { html: holder.innerHTML, replacements };
}
export function protectTerminologyInFragment(content, protectedEntries) {
    const doc = content.ownerDocument;
    const replacements = [];
    const walker = doc.createTreeWalker(content, NodeFilter.SHOW_TEXT);
    const nodes = [];
    let current = walker.nextNode();
    while (current) {
        const text = current;
        // Link labels now travel through the whole-sentence request. Protect hard terms
        // inside anchors as well so skipping standalone link inference cannot corrupt brands.
        if (!text.parentElement?.closest("code,kbd,samp,var")) nodes.push(text);
        current = walker.nextNode();
    }
    for (const textNode of nodes) {
        const raw = textNode.data;
        const hits = [];
        let cursor = 0;
        while (cursor < raw.length) {
            let found = null;
            for (const entry of protectedEntries) {
                const haystack = entry.caseSensitive === true ? raw : raw.toLocaleLowerCase();
                const needle = entry.caseSensitive === true ? entry.source : entry.source.toLocaleLowerCase();
                const at = haystack.indexOf(needle, cursor);
                if (at < 0 || !termBoundaryOkay(raw, at, at + needle.length, entry.source)) continue;
                if (!found || at < found.at || (at === found.at && needle.length > found.length)) found = { at, length: needle.length, entry };
            }
            if (!found) break;
            hits.push(found);
            cursor = found.at + found.length;
        }
        if (!hits.length) continue;
        const fragment = doc.createDocumentFragment();
        let offset = 0;
        for (const hit of hits) {
            if (hit.at < offset) continue;
            if (hit.at > offset) fragment.append(doc.createTextNode(raw.slice(offset, hit.at)));
            const span = doc.createElement("span");
            const id = replacements.length;
            span.setAttribute("data-flt-term-id", String(id));
            span.textContent = raw.slice(hit.at, hit.at + hit.length);
            replacements.push(hit.entry.target);
            fragment.append(span);
            offset = hit.at + hit.length;
        }
        if (offset < raw.length) fragment.append(doc.createTextNode(raw.slice(offset)));
        textNode.replaceWith(fragment);
    }
    return replacements;
}
// Marian output can glue a restored Latin name to a neighbouring Latin word
// ("Bergamot</span>WASM"). The term boundary check guarantees the source had a
// separator there, so restore a single space only between two Latin word characters.
function restoredTermNode(span, target, replacements = []) {
    const latin = /[A-Za-z0-9]/;
    // Soft alignment can pull neighbouring source words into the span
    // ("Translator、Google Cloud"). Keep them only when the name survived exactly once
    // and the extra text is neither Han output nor another protected name, so
    // duplicated renderings such as "ClaudeGPT克劳德" still collapse to the target.
    const spanText = span.textContent ?? "";
    const at = target ? spanText.indexOf(target) : -1;
    const extra = at >= 0 ? spanText.slice(0, at) + " " + spanText.slice(at + target.length) : "";
    const keepSpanText = at >= 0 && spanText.trim() !== target
        && spanText.indexOf(target, at + target.length) < 0
        && !/\p{Script=Han}/u.test(extra)
        && !replacements.some((other) => typeof other === "string" && other && other !== target && extra.includes(other));
    const content = keepSpanText ? spanText : target;
    const before = span.previousSibling?.textContent ?? "";
    const after = span.nextSibling?.textContent ?? "";
    const lead = latin.test(before.slice(-1)) && latin.test(content.charAt(0)) ? " " : "";
    const trail = latin.test(content.slice(-1)) && latin.test(after.charAt(0)) ? " " : "";
    return span.ownerDocument.createTextNode(`${lead}${content}${trail}`);
}
export function restoreTerminology(container, replacements) {
    const spans = Array.from(container.querySelectorAll("span[data-flt-term-id]"));
    if (!spans.length) return;
    const byScope = new Map();
    for (const span of spans) {
        const scope = span.parentElement ?? container;
        let list = byScope.get(scope);
        if (!list) {
            list = [];
            byScope.set(scope, list);
        }
        list.push(span);
    }
    for (const [scope, scopeSpans] of byScope) {
        const outsideText = Array.from(scope.childNodes)
            .filter((node) => node.nodeType === Node.TEXT_NODE)
            .map((node) => node.textContent ?? "")
            .join("");
        const surplusByTarget = new Map();
        const emptySpans = [];
        for (const span of scopeSpans) {
            const rawId = span.getAttribute("data-flt-term-id");
            const id = rawId && /^\d+$/.test(rawId) ? Number.parseInt(rawId, 10) : -1;
            const target = replacements[id];
            if (typeof target !== "string") {
                span.removeAttribute("data-flt-term-id");
                continue;
            }
            if (!span.textContent?.trim() && target) {
                if (!surplusByTarget.has(target)) {
                    surplusByTarget.set(target, termOccurrenceCount(outsideText, target, true));
                }
                emptySpans.push({ span, target });
            } else {
                span.replaceWith(restoredTermNode(span, target, replacements));
            }
        }
        // Pass 1: drop empty markers immediately adjacent to an already-present target.
        const remaining = [];
        for (const item of emptySpans) {
            const { span, target } = item;
            const surplus = surplusByTarget.get(target) ?? 0;
            const prevText = span.previousSibling?.nodeType === Node.TEXT_NODE ? (span.previousSibling.textContent ?? "") : "";
            const nextText = span.nextSibling?.nodeType === Node.TEXT_NODE ? (span.nextSibling.textContent ?? "") : "";
            if (surplus > 0 && (prevText.endsWith(target) || nextText.startsWith(target))) {
                surplusByTarget.set(target, surplus - 1);
                span.remove();
            } else {
                remaining.push(item);
            }
        }
        // Pass 2: drop stacked/non-adjacent empty markers if the exact target already
        // survives in the same scope's text; otherwise restore the protected target.
        for (const { span, target } of remaining) {
            const surplus = surplusByTarget.get(target) ?? 0;
            if (surplus > 0) {
                surplusByTarget.set(target, surplus - 1);
                span.remove();
            } else {
                span.replaceWith(restoredTermNode(span, target, replacements));
            }
        }
    }
}
export function restoreTerminologyHtml(doc, html, replacements) {
    if (!Array.isArray(replacements) || replacements.length === 0) return html;
    const content = parseHtmlFragment(doc, html);
    const holder = doc.createElement("div");
    holder.append(content);
    restoreTerminology(holder, replacements);
    return holder.innerHTML;
}
function replaceTextAlias(value, alias, target, limit) {
    if (!alias || alias === target || limit <= 0) return { value, count: 0 };
    const lower = value.toLocaleLowerCase();
    const needle = alias.toLocaleLowerCase();
    let cursor = 0, used = 0, output = "";
    while (used < limit && cursor <= value.length - needle.length) {
        const at = lower.indexOf(needle, cursor);
        if (at < 0) break;
        if (!termBoundaryOkay(value, at, at + needle.length, alias)) { cursor = at + Math.max(needle.length, 1); continue; }
        output += value.slice(cursor, at) + target;
        cursor = at + needle.length;
        used += 1;
    }
    if (!used) return { value, count: 0 };
    return { value: output + value.slice(cursor), count: used };
}
export function applyTerminologyCorrectionsHtml(doc, html, sourceText, entries, dynamicAliases = new Map()) {
    const active = (entries ?? []).filter((entry) => entry.mode === "replace" && termOccurrenceCount(sourceText, entry.source, entry.caseSensitive === true) > 0);
    if (!active.length) return html;
    const content = parseHtmlFragment(doc, html);
    for (const entry of active) {
        let remaining = termOccurrenceCount(sourceText, entry.source, entry.caseSensitive === true);
        if (!remaining) continue;
        const aliases = new Set([entry.source, ...(entry.aliases ?? [])]);
        const dynamic = dynamicAliases.get(entry.source.toLocaleLowerCase());
        if (dynamic) aliases.add(dynamic);
        const orderedAliases = Array.from(aliases).filter(Boolean).sort((a, b) => b.length - a.length);
        const walker = doc.createTreeWalker(content, NodeFilter.SHOW_TEXT);
        let current = walker.nextNode();
        while (current && remaining > 0) {
            const text = current;
            if (!text.parentElement?.closest("code,kbd,samp,var")) {
                let value = text.data;
                for (const alias of orderedAliases) {
                    const result = replaceTextAlias(value, alias, entry.target, remaining);
                    value = result.value;
                    remaining -= result.count;
                    if (remaining <= 0) break;
                }
                text.data = value;
            }
            current = walker.nextNode();
        }
    }
    const holder = doc.createElement("div");
    holder.append(content);
    return holder.innerHTML;
}
