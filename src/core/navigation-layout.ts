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
        const parentStyle = getComputedStyle(parent);
        const horizontalLayout = ((parentStyle.display === "flex" || parentStyle.display === "inline-flex") && parentStyle.flexDirection.startsWith("row")) || parentStyle.display === "grid" || parentStyle.display === "inline-grid";
        if (!horizontalLayout) continue;
        if (navigationLayoutSnapshots.has(item)) continue;
        const width = item.getBoundingClientRect().width;
        if (!(width > 1)) continue;
        navigationLayoutSnapshots.set(item, item.getAttribute("style"));
        const frozenWidth = `${Math.ceil(width * 100) / 100}px`;
        item.style.setProperty("box-sizing", "border-box", "important");
        item.style.setProperty("inline-size", frozenWidth, "important");
        item.style.setProperty("min-inline-size", frozenWidth, "important");
        item.style.setProperty("max-inline-size", frozenWidth, "important");
        if (parentStyle.display === "flex" || parentStyle.display === "inline-flex") item.style.setProperty("flex", `0 0 ${frozenWidth}`, "important");
    }
}
