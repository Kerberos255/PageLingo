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
let navigationLayoutHolds = 0;

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
    navigationLayoutHolds = 0;
    for (const [element, snapshot] of navigationLayoutSnapshots) {
        restoreProperty(element, "box-sizing", snapshot.boxSizing);
        restoreProperty(element, "min-inline-size", snapshot.minInlineSize);
        restoreProperty(element, "flex-shrink", snapshot.flexShrink);
        if (!element.getAttribute("style")?.trim()) element.removeAttribute("style");
    }
    navigationLayoutSnapshots.clear();
}

export function freezeNavigationLayout(resetExisting = true): void {
    if (resetExisting) restoreNavigationLayout();
    else cancelScheduledRelease();
    navigationLayoutHolds += 1;

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

        let item: HTMLElement = anchor;
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
        const horizontalLayout =
            ((parentStyle.display === "flex" || parentStyle.display === "inline-flex") && parentStyle.flexDirection.startsWith("row")) ||
            parentStyle.display === "grid" ||
            parentStyle.display === "inline-grid";
        if (!horizontalLayout) continue;
        if (navigationLayoutSnapshots.has(item)) continue;

        const width = itemRect.width;
        if (!(width > 1)) continue;
        navigationLayoutSnapshots.set(item, {
            boxSizing: captureProperty(item, "box-sizing"),
            minInlineSize: captureProperty(item, "min-inline-size"),
            flexShrink: captureProperty(item, "flex-shrink"),
        });

        const guardedWidth = `${Math.ceil(width * 100) / 100}px`;
        item.style.setProperty("box-sizing", "border-box", "important");
        // This is only a temporary anti-jank guard while asynchronous translation is
        // in flight. Once translated DOM is mounted, release the source-language width
        // so the target language can use its natural layout.
        item.style.setProperty("min-inline-size", guardedWidth, "important");
        if (parentStyle.display === "flex" || parentStyle.display === "inline-flex") {
            item.style.setProperty("flex-shrink", "0", "important");
        }
    }
}

export function releaseNavigationLayoutAfterPaint(): void {
    cancelScheduledRelease();
    if (navigationLayoutHolds > 0) navigationLayoutHolds -= 1;
    if (navigationLayoutHolds > 0) return;
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
