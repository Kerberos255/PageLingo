import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  freezeNavigationLayout,
  releaseNavigationLayoutAfterPaint,
  restoreNavigationLayout,
} from "../src/core/navigation-layout";

function rect(width: number, height = 24): DOMRect {
  return {
    x: 0,
    y: 0,
    width,
    height,
    top: 0,
    right: width,
    bottom: height,
    left: 0,
    toJSON: () => ({}),
  } as DOMRect;
}

describe("temporary navigation layout guard", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
      window.setTimeout(() => callback(performance.now()), 1));
    vi.stubGlobal("cancelAnimationFrame", (id: number) => window.clearTimeout(id));
    document.body.innerHTML = `
      <nav style="display:flex;flex-direction:row">
        <a id="start" href="/start">GET STARTED</a>
        <a id="overview" href="/overview">Overview</a>
      </nav>
    `;
    const start = document.querySelector<HTMLElement>("#start")!;
    const overview = document.querySelector<HTMLElement>("#overview")!;
    start.getBoundingClientRect = () => rect(132.25);
    overview.getBoundingClientRect = () => rect(72.5);
  });

  afterEach(() => {
    restoreNavigationLayout();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  it("holds the source width only while translation is in flight", async () => {
    const start = document.querySelector<HTMLElement>("#start")!;
    freezeNavigationLayout();

    expect(start.style.getPropertyValue("min-inline-size")).toBe("132.25px");
    expect(start.style.getPropertyPriority("min-inline-size")).toBe("important");
    expect(start.style.getPropertyValue("flex-shrink")).toBe("0");

    // Simulate translated text becoming much shorter while the async guard is active.
    start.textContent = "开始";
    expect(start.style.getPropertyValue("min-inline-size")).toBe("132.25px");

    releaseNavigationLayoutAfterPaint();
    await vi.advanceTimersByTimeAsync(3);

    expect(start.style.getPropertyValue("min-inline-size")).toBe("");
    expect(start.style.getPropertyValue("flex-shrink")).toBe("");
    expect(start.textContent).toBe("开始");
  });

  it("restores pre-existing inline layout properties instead of deleting them", async () => {
    const start = document.querySelector<HTMLElement>("#start")!;
    start.style.setProperty("min-inline-size", "44px");
    start.style.setProperty("flex-shrink", "1");

    freezeNavigationLayout();
    expect(start.style.getPropertyValue("min-inline-size")).toBe("132.25px");

    releaseNavigationLayoutAfterPaint();
    await vi.advanceTimersByTimeAsync(3);

    expect(start.style.getPropertyValue("min-inline-size")).toBe("44px");
    expect(start.style.getPropertyValue("flex-shrink")).toBe("1");
  });
  it("keeps the guard until every overlapping holder releases it", async () => {
    const start = document.querySelector<HTMLElement>("#start")!;
    freezeNavigationLayout();
    freezeNavigationLayout(false);

    releaseNavigationLayoutAfterPaint();
    await vi.advanceTimersByTimeAsync(3);
    expect(start.style.getPropertyValue("min-inline-size")).toBe("132.25px");

    releaseNavigationLayoutAfterPaint();
    await vi.advanceTimersByTimeAsync(3);
    expect(start.style.getPropertyValue("min-inline-size")).toBe("");
  });

});
