type StylePropertySnapshot = {
    value: string;
    priority: string;
};

type NavigationLayoutSnapshot = {
    boxSizing: StylePropertySnapshot;
    minInlineSize: StylePropertySnapshot;
    flexShrink: StylePropertySnapshot;
};

const navigationLayoutSnapshots = new Map<HTMLElement, NavigationLayoutSnapshot>();
let releaseFrameOne: number | null = null;
let releaseFrameTwo: number | null = null;
const navigationLayoutHolds = new Set<symbol>();

function captureProperty(element: HTMLElement, property: string): StylePropertySnapshot {
    return {
        value: element.style.getPropertyValue(property),
        priority: element.style.getPropertyPriority(property),
    };
}

function restoreProperty(element: HTMLElement, property: string, snapshot: StylePropertySnapshot): void {
    if (snapshot.value) element.style.setProperty(property, snapshot.value, snapshot.priority);
    else element.style.removeProperty(property);
}

function cancelScheduledRelease(): void {
    const view = document.defaultView;
    if (!view) return;
    if (releaseFrameOne !== null) view.cancelAnimationFrame(releaseFrameOne);
    if (releaseFrameTwo !== null) view.cancelAnimationFrame(releaseFrameTwo);
    releaseFrameOne = null;
    releaseFrameTwo = null;
}

export function restoreNavigationLayout(): void {
    cancelScheduledRelease();
    navigationLayoutHolds.clear();
    for (const [element, snapshot] of navigationLayoutSnapshots) {
        restoreProperty(element, "box-sizing", snapshot.boxSizing);
        restoreProperty(element, "min-inline-size", snapshot.minInlineSize);
        restoreProperty(element, "flex-shrink", snapshot.flexShrink);
        if (!element.getAttribute("style")?.trim()) element.removeAttribute("style");
    }
    navigationLayoutSnapshots.clear();
}

export function freezeNavigationLayout(resetExisting = true): symbol {
    if (resetExisting) restoreNavigationLayout();
    else cancelScheduledRelease();
    const hold = Symbol("navigation-layout-hold");
    navigationLayoutHolds.add(hold);

    const styleCache = new Map<Element, CSSStyleDeclaration>();
    const cachedStyle = (el: Element): CSSStyleDeclaration => {
        let style = styleCache.get(el);
        if (!style) {
            style = getComputedStyle(el);
            styleCache.set(el, style);
        }
        return style;
    };

    const isHorizontalContainer = (style: CSSStyleDeclaration): boolean =>
        ((style.display === "flex" || style.display === "inline-flex") && style.flexDirection.startsWith("row")) ||
        style.display === "grid" ||
        style.display === "inline-grid";

    // Phase 1: Pure READ pass (zero inline style writes so browser never forces repeated reflows).
    const planned: Array<{ item: HTMLElement; width: number; isFlexParent: boolean }> = [];
    const seenItems = new Set<HTMLElement>();
    const candidates = document.querySelectorAll("nav a, [role='navigation'] a");
    for (const anchor of candidates) {
        if (!(anchor instanceof HTMLElement) || !anchor.isConnected) continue;

        // First locate a horizontal flex-row/grid parent BEFORE touching getBoundingClientRect().
        // Vertical doc sidebars (e.g. 1,300+ links on Mintlify/OpenClaw) exit here with zero reflows.
        let item: HTMLElement = anchor;
        let horizontalParent: HTMLElement | null = null;
        let horizontalParentStyle: CSSStyleDeclaration | null = null;
        let insideClosedDetails = false;
        for (let depth = 0; item.parentElement && depth < 4; depth += 1) {
            const parentEl = item.parentElement;
            if (parentEl.tagName === "DETAILS" && !parentEl.hasAttribute("open") && item.tagName !== "SUMMARY") {
                insideClosedDetails = true;
                break;
            }
            const pStyle = cachedStyle(parentEl);
            if (isHorizontalContainer(pStyle)) {
                horizontalParent = parentEl;
                horizontalParentStyle = pStyle;
                break;
            }
            item = parentEl;
            if (item.tagName === "NAV") break;
        }
        if (insideClosedDetails || !horizontalParent || !horizontalParentStyle) continue;
        if (seenItems.has(item) || navigationLayoutSnapshots.has(item)) continue;

        const anchorStyle = cachedStyle(anchor);
        if (
            anchorStyle.display === "none" ||
            anchorStyle.visibility === "hidden" ||
            Number.parseFloat(anchorStyle.opacity || "1") === 0
        ) continue;

        const itemStyle = item === anchor ? anchorStyle : cachedStyle(item);
        if (
            itemStyle.display === "none" ||
            itemStyle.visibility === "hidden" ||
            Number.parseFloat(itemStyle.opacity || "1") === 0
        ) continue;

        const anchorRect = anchor.getBoundingClientRect();
        if (anchorRect.width <= 1 || anchorRect.height <= 1) continue;
        const itemRect = item === anchor ? anchorRect : item.getBoundingClientRect();
        if (itemRect.width <= 1 || itemRect.height <= 1) continue;

        seenItems.add(item);
        planned.push({
            item,
            width: itemRect.width,
            isFlexParent: horizontalParentStyle.display === "flex" || horizontalParentStyle.display === "inline-flex",
        });
    }

    // Phase 2: Pure WRITE pass (single batched layout invalidation).
    for (const { item, width, isFlexParent } of planned) {
        navigationLayoutSnapshots.set(item, {
            boxSizing: captureProperty(item, "box-sizing"),
            minInlineSize: captureProperty(item, "min-inline-size"),
            flexShrink: captureProperty(item, "flex-shrink"),
        });
        const guardedWidth = `${Math.ceil(width * 100) / 100}px`;
        item.style.setProperty("box-sizing", "border-box", "important");
        item.style.setProperty("min-inline-size", guardedWidth, "important");
        if (isFlexParent) {
            item.style.setProperty("flex-shrink", "0", "important");
        }
    }
    return hold;
}

export function releaseNavigationLayoutAfterPaint(hold: symbol): void {
    if (!navigationLayoutHolds.has(hold)) return;
    navigationLayoutHolds.delete(hold);
    cancelScheduledRelease();
    if (navigationLayoutHolds.size > 0) return;
    if (navigationLayoutSnapshots.size === 0) return;
    const view = document.defaultView;
    if (!view) {
        restoreNavigationLayout();
        return;
    }
    releaseFrameOne = view.requestAnimationFrame(() => {
        releaseFrameOne = null;
        releaseFrameTwo = view.requestAnimationFrame(() => {
            releaseFrameTwo = null;
            restoreNavigationLayout();
        });
    });
}
