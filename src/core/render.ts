// @ts-nocheck
import { restoreTerminology } from "./rich-segment";
var ALLOWED_TAGS = new Set([
    "A", "SPAN", "STRONG", "EM", "B", "I", "U", "S", "SMALL",
    "SUB", "SUP", "MARK", "ABBR", "CITE", "Q", "DEL", "INS",
    "CODE", "KBD", "SAMP", "VAR", "BR", "WBR",
]);
function setOrRemove(element, name, value) {
    if (value === null)
        element.removeAttribute(name);
    else
        element.setAttribute(name, value);
}
var LINK_TRANSPORT_PREFIX = "https://pagelingo.invalid/__link/";
function transportLinkId(anchor) {
    const dataId = anchor.getAttribute("data-flt-link-id");
    if (dataId && /^\d+$/.test(dataId)) return Number.parseInt(dataId, 10);
    const href = anchor.getAttribute("href") || "";
    const match = href.match(/^https:\/\/pagelingo\.invalid\/__link\/(\d+)$/);
    return match ? Number.parseInt(match[1], 10) : null;
}
function sanitizeTree(container) {
    const elements = Array.from(container.querySelectorAll("*"));
    for (const element of elements) {
        if (!ALLOWED_TAGS.has(element.tagName)) {
            element.replaceWith(...Array.from(element.childNodes));
            continue;
        }
        if (element.tagName === "A") {
            const linkId = transportLinkId(element);
            if (linkId !== null) element.setAttribute("data-flt-link-id", String(linkId));
        }
        for (const attribute of Array.from(element.attributes)) {
            if (element.tagName === "A" && attribute.name === "data-flt-link-id" && /^\d+$/.test(attribute.value)) continue;
            if (element.tagName === "SPAN" && attribute.name === "data-flt-term-id" && /^\d+$/.test(attribute.value)) continue;
            element.removeAttribute(attribute.name);
        }
    }
}
function configureRestoredLink(anchor, source) {
    anchor.removeAttribute("data-flt-link-id");
    setOrRemove(anchor, "href", source.href);
    setOrRemove(anchor, "target", source.target);
    setOrRemove(anchor, "rel", source.rel);
    setOrRemove(anchor, "title", source.title);
    setOrRemove(anchor, "class", source.className || null);
    if (source.linkStyle) {
        if (source.linkStyle.color) anchor.style.color = source.linkStyle.color;
        if (source.linkStyle.textDecorationLine) anchor.style.textDecorationLine = source.linkStyle.textDecorationLine;
        if (source.linkStyle.textDecorationStyle) anchor.style.textDecorationStyle = source.linkStyle.textDecorationStyle;
        if (source.linkStyle.textDecorationColor) anchor.style.textDecorationColor = source.linkStyle.textDecorationColor;
        if (source.linkStyle.textDecorationThickness) anchor.style.textDecorationThickness = source.linkStyle.textDecorationThickness;
        if (source.linkStyle.textUnderlineOffset) anchor.style.textUnderlineOffset = source.linkStyle.textUnderlineOffset;
    }
    anchor.addEventListener("click", (event) => {
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey ||
            !source.sourceElement.isConnected)
            return;
        event.preventDefault();
        source.sourceElement.click();
    });
}
function normalizeLinkMatchText(value) {
    let normalized = "";
    for (const char of value.normalize("NFKC").toLocaleLowerCase()) {
        if (/[\p{White_Space}\p{P}]/u.test(char))
            continue;
        normalized += char;
    }
    return normalized;
}
function buildLinkTextIndex(container) {
    const normalized = [];
    const positions = [];
    const rawPositions = [];
    const walker = container.ownerDocument.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    let current = walker.nextNode();
    while (current) {
        const node = current;
        const text = node.data;
        for (let offset = 0; offset < text.length;) {
            const codePoint = text.codePointAt(offset);
            if (codePoint === undefined)
                break;
            const char = String.fromCodePoint(codePoint);
            const width = char.length;
            const rawIndex = rawPositions.length;
            rawPositions.push({ node, startOffset: offset, endOffset: offset + width, char });
            for (const part of char.normalize("NFKC").toLocaleLowerCase()) {
                if (/[\p{White_Space}\p{P}]/u.test(part))
                    continue;
                normalized.push(part);
                positions.push({
                    node,
                    startOffset: offset,
                    endOffset: offset + width,
                    anchor: node.parentElement?.closest("a") ?? null,
                    rawIndex,
                });
            }
            offset += width;
        }
        current = walker.nextNode();
    }
    return { text: normalized.join(""), positions, rawPositions };
}
var CLOSING_LINK_PUNCTUATION = new Set([")", "）", "]", "】", "}", "》", "〉", "」", "』", "”", "’"]);
function trailingClosingPunctuationCount(value) {
    let count = 0;
    const chars = Array.from(value.trim());
    for (let index = chars.length - 1; index >= 0; index -= 1) {
        if (!CLOSING_LINK_PUNCTUATION.has(chars[index])) break;
        count += 1;
    }
    return count;
}
function extendMatchOverClosingPunctuation(index, last, label) {
    let remaining = trailingClosingPunctuationCount(label);
    if (!remaining || typeof last.rawIndex !== "number") return last;
    let extended = last;
    for (let cursor = last.rawIndex + 1; cursor < index.rawPositions.length && remaining > 0; cursor += 1) {
        const next = index.rawPositions[cursor];
        if (/\p{White_Space}/u.test(next.char)) continue;
        if (!CLOSING_LINK_PUNCTUATION.has(next.char)) break;
        extended = next;
        remaining -= 1;
    }
    return extended;
}
function findLinkMatch(index, label) {
    const needle = normalizeLinkMatchText(label);
    if (!needle)
        return null;
    const candidates = [];
    let from = 0;
    while (from <= index.text.length - needle.length) {
        const start = index.text.indexOf(needle, from);
        if (start < 0)
            break;
        const end = start + needle.length;
        candidates.push({ start, end });
        from = start + 1;
    }
    if (candidates.length === 1)
        return candidates[0];
    const anchored = candidates.filter(({ start, end }) => {
        const first = index.positions[start]?.anchor;
        if (!first)
            return false;
        for (let cursor = start + 1; cursor < end; cursor += 1) {
            if (index.positions[cursor]?.anchor !== first)
                return false;
        }
        return true;
    });
    return anchored.length === 1 ? anchored[0] : null;
}
function rawTextMatch(value, label) {
    const normalized = [];
    const map = [];
    for (let offset = 0; offset < value.length;) {
        const codePoint = value.codePointAt(offset);
        if (codePoint === undefined) break;
        const char = String.fromCodePoint(codePoint);
        const width = char.length;
        for (const part of char.normalize("NFKC").toLocaleLowerCase()) {
            if (/[\p{White_Space}\p{P}]/u.test(part)) continue;
            normalized.push(part);
            map.push({ start: offset, end: offset + width });
        }
        offset += width;
    }
    const needle = normalizeLinkMatchText(label);
    if (!needle) return null;
    const haystack = normalized.join("");
    const first = haystack.indexOf(needle);
    if (first < 0 || haystack.indexOf(needle, first + 1) >= 0) return null;
    const firstMap = map[first];
    const lastMap = map[first + needle.length - 1];
    if (!firstMap || !lastMap) return null;
    return { start: firstMap.start, end: lastMap.end };
}
var LINK_OPEN_QUOTES = /^[\s\u00a0]*[“‘「『《〈«‹"']+/u;
var LINK_CLOSE_QUOTES = /^[\s\u00a0]*[”’」』》〉»›"']+/u;
var LINK_OPEN_QUOTES_END = /[“‘「『《〈«‹"']+[\s\u00a0]*$/u;
function sourceHasAdjacentQuote(source, side) {
    const sibling = side === "before" ? source.sourceElement.previousSibling : source.sourceElement.nextSibling;
    const text = sibling?.textContent ?? "";
    return side === "before" ? LINK_OPEN_QUOTES_END.test(text) : LINK_CLOSE_QUOTES.test(text);
}
function stripIntroducedLinkQuotes(value, source, side) {
    if (sourceHasAdjacentQuote(source, side)) return value;
    return side === "before" ? value.replace(LINK_OPEN_QUOTES_END, "") : value.replace(LINK_CLOSE_QUOTES, "");
}
function edgeTextNode(node, side) {
    if (node instanceof Text) return node;
    if (!(node instanceof Element) || node.tagName === "A") return null;
    const walker = node.ownerDocument.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    const texts = [];
    let current = walker.nextNode();
    while (current) { texts.push(current); current = walker.nextNode(); }
    return side === "before" ? (texts.at(-1) ?? null) : (texts[0] ?? null);
}
function adjacentTextNode(anchor, side) {
    let root = anchor;
    while (root.parentNode && root.parentNode.nodeType !== Node.DOCUMENT_NODE) root = root.parentNode;
    const scope = root.nodeType === Node.ELEMENT_NODE || root.nodeType === Node.DOCUMENT_FRAGMENT_NODE ? root : anchor.parentNode;
    if (!scope) return null;
    const walker = anchor.ownerDocument.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
    let current = walker.nextNode();
    let previous = null;
    while (current) {
        const text = current;
        if (!anchor.contains(text)) {
            if (side === "after" && (anchor.compareDocumentPosition(text) & Node.DOCUMENT_POSITION_FOLLOWING)) return text;
            if (side === "before" && (text.compareDocumentPosition(anchor) & Node.DOCUMENT_POSITION_FOLLOWING)) previous = text;
        }
        current = walker.nextNode();
    }
    return side === "before" ? previous : null;
}
function stripIntroducedAnchorEdgeQuotes(anchor, source) {
    const text = anchor.textContent ?? "";
    let clean = text;
    if (!/^[“‘「『《〈«‹"']/.test(source.sourceText.trim())) clean = clean.replace(/^[“‘「『《〈«‹"']+/, "");
    if (!/[”’」』》〉»›"']$/.test(source.sourceText.trim())) clean = clean.replace(/[”’」』》〉»›"']+$/, "");
    if (clean !== text) anchor.textContent = clean;
}
function removeAdjacentAddedLinkQuotes(anchor, source) {
    stripIntroducedAnchorEdgeQuotes(anchor, source);
    const previous = adjacentTextNode(anchor, "before");
    if (previous && !sourceHasAdjacentQuote(source, "before")) previous.data = previous.data.replace(LINK_OPEN_QUOTES_END, "");
    const next = adjacentTextNode(anchor, "after");
    if (next && !sourceHasAdjacentQuote(source, "after")) next.data = next.data.replace(LINK_CLOSE_QUOTES, "");
}
function trimIdentifiedAnchor(anchor, label, source) {
    const raw = anchor.textContent ?? "";
    const marker = raw.match(/__FLT_LINK_LABEL_\d+__/u);
    if (marker) {
        // Clean quotes while the original translated anchor is still in place. If the
        // model pulled surrounding words inside the anchor, removing quotes only after
        // splitting would miss a quote separated from the final link by that moved text.
        removeAdjacentAddedLinkQuotes(anchor, source);
        const start = marker.index ?? 0;
        const prefix = stripIntroducedLinkQuotes(raw.slice(0, start), source, "before");
        const suffix = stripIntroducedLinkQuotes(raw.slice(start + marker[0].length), source, "after");
        const cleanAnchor = anchor.ownerDocument.createElement("a");
        cleanAnchor.textContent = label || source.sourceText;
        configureRestoredLink(cleanAnchor, source);
        const nodes = [];
        if (prefix) nodes.push(anchor.ownerDocument.createTextNode(prefix));
        nodes.push(cleanAnchor);
        if (suffix) nodes.push(anchor.ownerDocument.createTextNode(suffix));
        anchor.replaceWith(...nodes);
        removeAdjacentAddedLinkQuotes(cleanAnchor, source);
        removeAdjacentDuplicateLinkText(cleanAnchor, cleanAnchor.textContent ?? "");
        return cleanAnchor;
    }
    if (!label) {
        configureRestoredLink(anchor, source);
        removeAdjacentAddedLinkQuotes(anchor, source);
        return anchor;
    }
    const match = rawTextMatch(raw, label);
    if (match) {
        const prefix = stripIntroducedLinkQuotes(raw.slice(0, match.start), source, "before");
        const matched = raw.slice(match.start, match.end) || label;
        const suffix = stripIntroducedLinkQuotes(raw.slice(match.end), source, "after");
        const cleanAnchor = anchor.ownerDocument.createElement("a");
        cleanAnchor.textContent = matched;
        configureRestoredLink(cleanAnchor, source);
        const nodes = [];
        if (prefix) nodes.push(anchor.ownerDocument.createTextNode(prefix));
        nodes.push(cleanAnchor);
        if (suffix) nodes.push(anchor.ownerDocument.createTextNode(suffix));
        anchor.replaceWith(...nodes);
        removeAdjacentAddedLinkQuotes(cleanAnchor, source);
        removeAdjacentDuplicateLinkText(cleanAnchor, label);
        return cleanAnchor;
    }

    // If the engine preserved the identified anchor but mistranslated a short label
    // (for example Why -> When), prefer the separately translated stable label.
    const rawNorm = normalizeLinkMatchText(raw);
    const labelNorm = normalizeLinkMatchText(label);
    if (label && rawNorm.length <= Math.max(40, labelNorm.length * 2)) anchor.textContent = label;
    configureRestoredLink(anchor, source);
    removeAdjacentAddedLinkQuotes(anchor, source);
    removeAdjacentDuplicateLinkText(anchor, label);
    return anchor;
}
function cleanupLegacyLinkMarkers(container) {
    const walker = container.ownerDocument.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    let current = walker.nextNode();
    while (current) {
        const text = current;
        text.data = text.data.replace(/__FLT_LINK(?:_\d+)?__/g, "").replace(/__FLT_LINK_LABEL_\d+__/g, "");
        current = walker.nextNode();
    }
}
function escapeRegex(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function trailingLinkDuplicateCandidates(label) {
    const trimmed = label.trim();
    if (!trimmed) return [];
    const candidates = [trimmed];
    const latinTail = trimmed.match(/([A-Za-z][A-Za-z0-9._-]*)\s*$/)?.[1];
    if (latinTail && latinTail !== trimmed && latinTail.length >= 2) candidates.push(latinTail);
    return candidates.sort((a, b) => b.length - a.length);
}
function removeAdjacentDuplicateLinkText(anchor, label) {
    const next = anchor.nextSibling;
    if (!(next instanceof Text)) return;
    for (const candidate of trailingLinkDuplicateCandidates(label)) {
        const pattern = new RegExp(`^\\s*${escapeRegex(candidate)}(?=\\s*(?:$|[\\p{P}]))`, "u");
        if (!pattern.test(next.data)) continue;
        next.data = next.data.replace(pattern, "");
        break;
    }
}
function fragmentPlainText(fragment) {
    return (fragment.textContent ?? "").replace(/\s+/g, " ").trim();
}
function hasMeaningfulText(value) {
    return /[\p{L}\p{N}]/u.test(value);
}
function textBetweenNodes(container, left, right) {
    try {
        const range = container.ownerDocument.createRange();
        if (left) range.setStartAfter(left);
        else range.setStart(container, 0);
        if (right) range.setEndBefore(right);
        else range.setEnd(container, container.childNodes.length);
        return fragmentPlainText(range.cloneContents());
    }
    catch {
        return "";
    }
}
function restoreMissingLinkGaps(container, translatedGapTexts, resolvedByIndex) {
    if (!Array.isArray(translatedGapTexts) || translatedGapTexts.length === 0 || resolvedByIndex.size < 2) return;
    const ordered = Array.from(resolvedByIndex.entries()).sort((a, b) => a[0] - b[0]);
    for (let position = 0; position < ordered.length; position += 1) {
        const [linkIndex, anchor] = ordered[position];
        const nextEntry = ordered[position + 1];
        const gapIndex = linkIndex + 1;
        if (!nextEntry || nextEntry[0] !== linkIndex + 1) continue;
        const nextAnchor = nextEntry[1];
        if (!(anchor.compareDocumentPosition(nextAnchor) & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
        const fallback = translatedGapTexts[gapIndex]?.trim();
        if (!fallback || !hasMeaningfulText(fallback)) continue;
        const existing = textBetweenNodes(container, anchor, nextAnchor);
        if (hasMeaningfulText(existing)) continue;
        nextAnchor.parentNode?.insertBefore(container.ownerDocument.createTextNode(` ${fallback} `), nextAnchor);
    }
    const firstEntry = ordered[0];
    if (firstEntry && firstEntry[0] === 0) {
        const fallback = translatedGapTexts[0]?.trim();
        if (fallback && hasMeaningfulText(fallback)) {
            const existing = textBetweenNodes(container, null, firstEntry[1]);
            if (!hasMeaningfulText(existing)) {
                firstEntry[1].parentNode?.insertBefore(container.ownerDocument.createTextNode(`${fallback} `), firstEntry[1]);
            }
        }
    }
    const lastEntry = ordered[ordered.length - 1];
    if (lastEntry && lastEntry[0] === translatedGapTexts.length - 2) {
        const fallback = translatedGapTexts[translatedGapTexts.length - 1]?.trim();
        if (fallback && hasMeaningfulText(fallback)) {
            const existing = textBetweenNodes(container, lastEntry[1], null);
            if (!hasMeaningfulText(existing)) {
                lastEntry[1].parentNode?.insertBefore(container.ownerDocument.createTextNode(` ${fallback}`), lastEntry[1].nextSibling);
            }
        }
    }
}
function restoreBareLinkMarker(container, linkIndex, label, source) {
    const token = `__FLT_LINK_LABEL_${linkIndex}__`;
    const walker = container.ownerDocument.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    let current = walker.nextNode();
    while (current) {
        const text = current;
        const at = text.data.indexOf(token);
        if (at >= 0) {
            const parent = text.parentElement;
            if (parent?.closest("a")) return null;
            const anchor = container.ownerDocument.createElement("a");
            anchor.textContent = label || source.sourceText;
            configureRestoredLink(anchor, source);
            if (parent && ["CODE", "KBD", "SAMP", "VAR"].includes(parent.tagName) && parent.textContent === token) {
                parent.replaceWith(anchor);
            }
            else {
                const before = text.data.slice(0, at);
                const after = text.data.slice(at + token.length);
                const nodes = [];
                if (before) nodes.push(container.ownerDocument.createTextNode(before));
                nodes.push(anchor);
                if (after) nodes.push(container.ownerDocument.createTextNode(after));
                text.replaceWith(...nodes);
            }
            removeAdjacentAddedLinkQuotes(anchor, source);
            return anchor;
        }
        current = walker.nextNode();
    }
    return null;
}
function restoreLinks(container, links, translatedLinkTexts = [], translatedGapTexts = []) {
    cleanupLegacyLinkMarkers(container);
    const resolvedLinks = new Set();
    const resolvedAnchors = new Set();
    const resolvedByIndex = new Map();

    // Primary path: identity travels as an HTML attribute, not visible text. Translation
    // engines can reorder anchors freely without leaking any transport token to the page.
    for (const anchor of Array.from(container.querySelectorAll("a[data-flt-link-id]"))) {
        const rawId = anchor.getAttribute("data-flt-link-id");
        const linkIndex = rawId && /^\d+$/.test(rawId) ? Number.parseInt(rawId, 10) : -1;
        const source = links[linkIndex];
        if (!source || resolvedLinks.has(linkIndex)) {
            anchor.removeAttribute("data-flt-link-id");
            continue;
        }
        const label = translatedLinkTexts[linkIndex]?.trim() || "";
        const restored = trimIdentifiedAnchor(anchor, label, source);
        resolvedLinks.add(linkIndex);
        resolvedAnchors.add(restored);
        resolvedByIndex.set(linkIndex, restored);
    }

    // If the engine stripped transport attributes but preserved the same number of <a>
    // elements, the whole-sentence anchors are authoritative. Rebind them in source order
    // instead of translating link labels a second time. This avoids semantic/quote conflicts.
    const unresolvedBeforeFallback = links.map((_, i) => i).filter((i) => !resolvedLinks.has(i));
    const anonymousBeforeFallback = Array.from(container.querySelectorAll("a")).filter((a) => !resolvedAnchors.has(a));
    if (unresolvedBeforeFallback.length > 0 && unresolvedBeforeFallback.length === anonymousBeforeFallback.length) {
        unresolvedBeforeFallback.forEach((linkIndex, position) => {
            const anchor = anonymousBeforeFallback[position];
            const source = links[linkIndex];
            if (!anchor || !source) return;
            configureRestoredLink(anchor, source);
            removeAdjacentAddedLinkQuotes(anchor, source);
            resolvedLinks.add(linkIndex);
            resolvedAnchors.add(anchor);
            resolvedByIndex.set(linkIndex, anchor);
        });
    }

    // If an engine stripped the <a> wrapper but preserved the opaque code token, the
    // token itself is still a perfect identity anchor. Rebuild the link directly around
    // it before attempting any fuzzy text matching.
    for (let linkIndex = 0; linkIndex < links.length; linkIndex += 1) {
        if (resolvedLinks.has(linkIndex)) continue;
        const source = links[linkIndex];
        if (!source) continue;
        const restored = restoreBareLinkMarker(container, linkIndex, translatedLinkTexts[linkIndex]?.trim() || source.sourceText, source);
        if (!restored) continue;
        resolvedLinks.add(linkIndex);
        resolvedAnchors.add(restored);
        resolvedByIndex.set(linkIndex, restored);
    }

    // True last-resort fallback for engines that removed/recreated only some anchors.
    const index = buildLinkTextIndex(container);
    const matches = [];
    for (let linkIndex = 0; linkIndex < links.length; linkIndex += 1) {
        if (resolvedLinks.has(linkIndex)) continue;
        const source = links[linkIndex];
        const label = translatedLinkTexts[linkIndex]?.trim() || "";
        if (!source || !label) continue;
        const match = findLinkMatch(index, label);
        if (!match || matches.some((item) => match.start < item.end && match.end > item.start)) continue;
        const first = index.positions[match.start];
        const last = index.positions[match.end - 1];
        if (!first || !last) continue;
        const extendedLast = extendMatchOverClosingPunctuation(index, last, label);
        matches.push({
            ...match,
            linkIndex,
            source,
            startNode: first.node,
            startOffset: first.startOffset,
            endNode: extendedLast.node,
            endOffset: extendedLast.endOffset,
        });
    }

    // Remove only unresolved anonymous anchors before recreating them. Identified/restored
    // anchors remain untouched.
    for (const anchor of Array.from(container.querySelectorAll("a"))) {
        if (resolvedAnchors.has(anchor)) continue;
        if (anchor.hasAttribute("href")) continue;
        anchor.replaceWith(...Array.from(anchor.childNodes));
    }
    matches.sort((a, b) => b.start - a.start);
    for (const match of matches) {
        if (!container.contains(match.startNode) || !container.contains(match.endNode)) continue;
        const range = container.ownerDocument.createRange();
        try {
            range.setStart(match.startNode, match.startOffset);
            range.setEnd(match.endNode, match.endOffset);
            const anchor = container.ownerDocument.createElement("a");
            configureRestoredLink(anchor, match.source);
            anchor.append(range.extractContents());
            range.insertNode(anchor);
            removeAdjacentDuplicateLinkText(anchor, anchor.textContent ?? "");
            resolvedLinks.add(match.linkIndex);
            resolvedAnchors.add(anchor);
            resolvedByIndex.set(match.linkIndex, anchor);
        } catch (error) {
            console.warn("[PageLingo] Link restoration skipped", error);
        }
    }

    // Last-resort one-to-one mapping if an engine kept an anchor but stripped the ID and
    // translated its label differently from the standalone label request.
    const unresolvedIndexes = links.map((_, i) => i).filter((i) => !resolvedLinks.has(i));
    const anonymousAnchors = Array.from(container.querySelectorAll("a")).filter((a) => !resolvedAnchors.has(a));
    if (unresolvedIndexes.length === 1 && anonymousAnchors.length === 1) {
        const i = unresolvedIndexes[0];
        const source = links[i];
        const label = translatedLinkTexts[i]?.trim() || "";
        if (source) {
            const restored = trimIdentifiedAnchor(anonymousAnchors[0], label, source);
            resolvedLinks.add(i);
            resolvedAnchors.add(restored);
            resolvedByIndex.set(i, restored);
        }
    }

    restoreMissingLinkGaps(container, translatedGapTexts, resolvedByIndex);
    // Gap fallback translations are inserted after individual links have already been
    // normalized. Some engines add a decorative quote while translating a tiny gap
    // (for example a Chinese closing quote after an unquoted link). Re-run the
    // source-aware quote cleanup as a final punctuation-skeleton pass so transport
    // recovery cannot leave an unmatched quote behind.
    for (const [linkIndex, anchor] of resolvedByIndex) {
        const source = links[linkIndex];
        if (source && anchor.isConnected) removeAdjacentAddedLinkQuotes(anchor, source);
    }
    for (const anchor of Array.from(container.querySelectorAll("a[data-flt-link-id]"))) {
        anchor.removeAttribute("data-flt-link-id");
    }
    cleanupLegacyLinkMarkers(container);
}
function restoreOpaque(container, opaque) {
    const nodes = Array.from(container.querySelectorAll("code,kbd,samp,var"));
    nodes.forEach((node, index) => {
        const source = opaque[index];
        if (!source)
            return;
        node.textContent = source.text;
    });
}
export function createSafeTranslatedFragment(doc, translatedHtml, links, opaque, translatedLinkTexts = [], translatedGapTexts = [], terminologyReplacements = []) {
    const parsed = new DOMParser().parseFromString(translatedHtml, "text/html");
    const holder = doc.createElement("div");
    for (const child of Array.from(parsed.body.childNodes)) {
        holder.append(doc.importNode(child, true));
    }
    sanitizeTree(holder);
    restoreTerminology(holder, terminologyReplacements);
    restoreLinks(holder, links, translatedLinkTexts, translatedGapTexts);
    restoreOpaque(holder, opaque);
    const fragment = doc.createDocumentFragment();
    while (holder.firstChild)
        fragment.append(holder.firstChild);
    return fragment;
}
function copySourceLayout(root, node) {
    const computed = root.ownerDocument.defaultView?.getComputedStyle(root);
    if (!computed)
        return;
    const properties = [
        "color", "font-family", "font-size", "font-weight", "font-style", "font-variant",
        "line-height", "letter-spacing", "word-spacing", "text-transform",
        "text-align", "text-align-last", "text-indent", "direction", "writing-mode",
        "text-decoration-line", "text-decoration-style", "text-decoration-color", "text-decoration-thickness",
        "text-underline-offset",
        "margin-inline-start", "margin-inline-end", "padding-inline-start", "padding-inline-end",
    ];
    for (const property of properties) {
        const value = computed.getPropertyValue(property);
        if (value)
            node.style.setProperty(property, value, "important");
    }
}
export function mountTranslation(root, fragment, targetLanguage) {
    const node = root.ownerDocument.createElement("span");
    node.className = "flt-translation";
    node.dataset.fltGenerated = "translation";
    node.lang = targetLanguage;
    node.append(fragment);
    copySourceLayout(root, node);
    if (root.tagName === "SPAN" && root.closest("a")) {
        node.style.setProperty("display", "inline", "important");
        node.style.setProperty("margin-block-start", "0", "important");
        node.style.removeProperty("margin-inline-start");
        node.style.removeProperty("margin-inline-end");
        node.style.removeProperty("padding-inline-start");
        node.style.removeProperty("padding-inline-end");
    }
    if (["LI", "TD", "TH"].includes(root.tagName)) {
        root.append(node);
    }
    else {
        root.insertAdjacentElement("afterend", node);
    }
    return node;
}
