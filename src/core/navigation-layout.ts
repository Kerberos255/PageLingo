// @ts-nocheck
var navigationLayoutSnapshots = new Map();
export function restoreNavigationLayout() {
    for (const [element, styleAttribute] of navigationLayoutSnapshots) {
        if (styleAttribute === null) element.removeAttribute("style");
        else element.setAttribute("style", styleAttribute);
    }
    navigationLayoutSnapshots.clear();
}
export function freezeNavigationLayout(resetExisting = true) {
    if (resetExisting) restoreNavigationLayout();
    const candidates = Array.from(document.querySelectorAll("nav a, [role='navigation'] a"));
    for (const anchor of candidates) {
        if (!(anchor instanceof HTMLElement) || !anchor.isConnected) continue;
        const anchorStyle = getComputedStyle(anchor);
        const anchorRect = anchor.getBoundingClientRect();
        if (
            anchorStyle.display === "none" ||
            anchorStyle.visibility === "hidden" ||
            Number.parseFloat(anchorStyle.opacity || "1") === 0 ||
            anchorRect.width <= 1 ||
            anchorRect.height <= 1
        ) continue;
        let item = anchor;
        for (let depth = 0; item.parentElement && depth < 4; depth += 1) {
            const parentStyle = getComputedStyle(item.parentElement);
            if ((parentStyle.display === "flex" || parentStyle.display === "inline-flex") && parentStyle.flexDirection.startsWith("row")) break;
            if (parentStyle.display === "grid" || parentStyle.display === "inline-grid") break;
            item = item.parentElement;
            if (item.tagName === "NAV") break;
        }
        const parent = item.parentElement;
        if (!parent) continue;
        const itemStyle = getComputedStyle(item);
        const itemRect = item.getBoundingClientRect();
        if (
            itemStyle.display === "none" ||
            itemStyle.visibility === "hidden" ||
            Number.parseFloat(itemStyle.opacity || "1") === 0 ||
            itemRect.width <= 1 ||
            itemRect.height <= 1
        ) continue;
        const parentStyle = getComputedStyle(parent);
        const horizontalLayout = ((parentStyle.display === "flex" || parentStyle.display === "inline-flex") && parentStyle.flexDirection.startsWith("row")) || parentStyle.display === "grid" || parentStyle.display === "inline-grid";
        if (!horizontalLayout) continue;
        if (navigationLayoutSnapshots.has(item)) continue;
        const width = item.getBoundingClientRect().width;
        if (!(width > 1)) continue;
        navigationLayoutSnapshots.set(item, item.getAttribute("style"));
        const frozenWidth = `${Math.ceil(width * 100) / 100}px`;
        item.style.setProperty("box-sizing", "border-box", "important");
        // Preserve the original slot as a minimum so shorter translations do not
        // collapse navigation spacing, but allow longer translations to grow instead
        // of overlapping neighboring items.
        item.style.setProperty("min-inline-size", frozenWidth, "important");
        if (parentStyle.display === "flex" || parentStyle.display === "inline-flex") {
            item.style.setProperty("flex-shrink", "0", "important");
        }
    }
}
