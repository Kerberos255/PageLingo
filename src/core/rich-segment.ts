// @ts-nocheck
import { isElementEffectivelyHidden, isTranslationRootElement, isEligibleTextNode } from "./dom-policy";
import type { SourceTextSlot } from "./fixed-text-render";
import { normalizeGlossaryEntry } from "../shared/settings";

export interface LinkStyleSnapshot { color:string; textDecorationLine:string; textDecorationStyle:string; textDecorationColor:string; textDecorationThickness:string; textUnderlineOffset:string }
export interface LinkSnapshot { href:string|null; target:string|null; rel:string|null; title:string|null; className:string; sourceElement:HTMLAnchorElement; sourceText:string; linkStyle:LinkStyleSnapshot|null }
export interface OpaqueSnapshot { tagName:string; text:string }
export interface TerminologyEntry { source:string; target:string; mode:"protect"|"replace"; caseSensitive?:boolean; origin?:"builtin"|"user"; aliases?:string[] }
export interface RichSegment { html:string; links:LinkSnapshot[]; opaque:OpaqueSnapshot[]; linkGaps:string[]; fingerprint:string; textSlots?:SourceTextSlot[] }

const LINK_TRANSPORT_PREFIX = "https://pagelingo.invalid/__link/";
var INLINE_TAGS = new Set([
    "A", "SPAN", "STRONG", "EM", "B", "I", "U", "S", "SMALL",
    "SUB", "SUP", "MARK", "ABBR", "CITE", "Q", "DEL", "INS",
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
    const parsed = new DOMParser().parseFromString(html, "text/html");
    const fragment = doc.createDocumentFragment();
    for (const child of Array.from(parsed.body.childNodes)) fragment.append(doc.importNode(child, true));
    return fragment;
}
function snapshotLink(element) {
    const computed = element.ownerDocument.defaultView?.getComputedStyle(element);
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
function serializeChildren(parent, root, links, opaque, textSlots) {
    let html = "";
    for (const node of parent.childNodes) {
        if (node.nodeType === Node.TEXT_NODE) {
            const text = escapeHtml(node.textContent ?? "");
            if (textSlots && (node.textContent ?? "").trim()) {
                if (isEligibleTextNode(node)) {
                    const id = textSlots.length;
                    textSlots.push({id, node, parent: node.parentNode, source: node.data});
                    html += `<span data-flt-text-id="${id}">${text}</span>`;
                } else html += `<span data-flt-fixed="true">${text}</span>`;
            } else html += text;
            continue;
        }
        if (node.nodeType !== Node.ELEMENT_NODE)
            continue;
        const element = node;
        if (element.hasAttribute("data-flt-generated"))
            continue;
        if (element !== root && DYNAMIC_TIME_TAGS.has(element.tagName))
            continue;
        if (element !== root && isElementEffectivelyHidden(element))
            continue;
        if (element !== root && isTranslationRootElement(element))
            continue;
        const tag = element.tagName;
        if (!INLINE_TAGS.has(tag)) {
            html += serializeChildren(element, root, links, opaque, textSlots);
            continue;
        }
        const lower = tag.toLowerCase();
        if (tag === "BR" || tag === "WBR") {
            html += `<${lower}>`;
            continue;
        }
        if (tag === "A") {
            const linkIndex = links.length;
            links.push(snapshotLink(element));
            // Legacy providers use link sentinels for recovery. MT additionally maps
            // each original text node to a fixed slot; link topology is application-owned.
            const labelHtml = serializeChildren(element, root, links, opaque, textSlots) || escapeHtml(element.textContent ?? "");
            html += `<a data-flt-link-id="${linkIndex}" href="${LINK_TRANSPORT_PREFIX}${linkIndex}"><code>__FLT_LINK_START_${linkIndex}__</code>${labelHtml}<code>__FLT_LINK_END_${linkIndex}__</code></a>`;
            continue;
        }
        if (OPAQUE_TAGS.has(tag)) {
            const index = opaque.length;
            opaque.push({ tagName: tag, text: element.textContent ?? "" });
            html += `<${lower}>__FLT_OPAQUE_${index}__</${lower}>`;
            continue;
        }
        html += `<${lower}>${serializeChildren(element, root, links, opaque, textSlots)}</${lower}>`;
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
                if (isTranslationRootElement(parent)) { nested = true; break; }
            }
        }
        if (!nested && !node.parentElement?.closest("[data-flt-generated]") && !node.parentElement?.closest("[hidden],[aria-hidden='true'],tool-tip,[role='tooltip'],[inert]")) text += node.data;
        current = walker.nextNode();
    }
    return text;
}
function snapshotLinkGaps(root) {
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
            if (element !== root && isElementEffectivelyHidden(element)) continue;
            if (element !== root && isTranslationRootElement(element)) continue;
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
export function serializeRichSegment(root, {fixedTextSlots = false} = {}): RichSegment {
    const links = [];
    const opaque = [];
    const textSlots = fixedTextSlots ? [] : undefined;
    let html = serializeChildren(root, root, links, opaque, textSlots).trim();
    if (root.tagName === "A") {
        links.unshift(snapshotLink(root));
        const labelHtml = html || escapeHtml(root.textContent ?? "");
        html = `<a data-flt-link-id="0" href="${LINK_TRANSPORT_PREFIX}0"><code>__FLT_LINK_START_0__</code>${labelHtml}<code>__FLT_LINK_END_0__</code></a>`;
    }
    return {
        html,
        links,
        opaque,
        linkGaps: links.length > 0 && root.tagName !== "A" ? snapshotLinkGaps(root) : [],
        fingerprint: sourceFingerprint(root, {excludeNestedRoots: fixedTextSlots}),
        textSlots,
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
    const holder = doc.createElement("div");
    holder.append(content.cloneNode(true));
    return { html: holder.innerHTML, replacements };
}
export function restoreTerminology(container, replacements) {
    for (const span of Array.from(container.querySelectorAll("span[data-flt-term-id]"))) {
        const rawId = span.getAttribute("data-flt-term-id");
        const id = rawId && /^\d+$/.test(rawId) ? Number.parseInt(rawId, 10) : -1;
        const target = replacements[id];
        if (typeof target === "string") span.replaceWith(container.ownerDocument.createTextNode(target));
        else span.removeAttribute("data-flt-term-id");
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
