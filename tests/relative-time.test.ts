import { afterEach, describe, expect, it, vi } from "vitest";
import { RelativeTimeLocalizer, relativeTimeElements } from "../src/shared/relative-time";

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = "";
});

describe("relative time element collection", () => {
  it("collects relative-time, time-ago, and local-time", () => {
    document.body.innerHTML = `
      <relative-time id="r"></relative-time>
      <time-ago id="a"></time-ago>
      <local-time id="l"></local-time>
    `;

    expect(relativeTimeElements(document).map((element) => element.id).sort())
      .toEqual(["a", "l", "r"]);
  });

  it("includes the scoped custom element itself", () => {
    const element = document.createElement("time-ago");
    document.body.append(element);
    expect(relativeTimeElements(element)).toEqual([element]);
  });
});

describe("RelativeTimeLocalizer lifecycle and detached pruning", () => {
  it("prunes detached relative-time nodes on a timer, restores original lang on prune, and stays clean if re-inserted", async () => {
    vi.useFakeTimers();
    document.body.innerHTML = `
      <ul id="feed">
        <li><relative-time id="keep" lang="en">2m ago</relative-time></li>
        <li><time-ago id="drop">5m ago</time-ago></li>
        <li><local-time id="site-edited" lang="en">10m ago</local-time></li>
      </ul>
    `;

    const localizer = new RelativeTimeLocalizer(document, 4000);
    localizer.start("zh-CN");

    const keep = document.getElementById("keep")!;
    const drop = document.getElementById("drop")!;
    const siteEdited = document.getElementById("site-edited")!;
    expect(localizer.trackedCount).toBe(3);
    expect(keep.getAttribute("lang")).toBe("zh-CN");
    expect(drop.getAttribute("lang")).toBe("zh-CN");

    // Simulate site updating lang on an element before removal, and detaching two feed items.
    siteEdited.setAttribute("lang", "fr");
    drop.parentElement!.remove();
    siteEdited.parentElement!.remove();

    // Flush MutationObserver microtasks, then advance past the 4s prune timer.
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(4100);

    expect(localizer.trackedCount).toBe(1);
    // Detached node without original lang had lang removed cleanly when pruned.
    expect(drop.hasAttribute("lang")).toBe(false);
    // Website-driven lang change ("fr") is preserved, never overwritten.
    expect(siteEdited.getAttribute("lang")).toBe("fr");

    // Re-insert the previously pruned node while active -> re-localizes and re-tracks, then restores cleanly on stop().
    document.getElementById("feed")!.append(drop);
    await Promise.resolve();
    expect(drop.getAttribute("lang")).toBe("zh-CN");
    expect(localizer.trackedCount).toBe(2);

    localizer.stop();
    expect(localizer.trackedCount).toBe(0);
    expect(keep.getAttribute("lang")).toBe("en");
    expect(drop.hasAttribute("lang")).toBe(false);
  });

  it("restores detached nodes even if stop() runs after prune and node is re-inserted later", () => {
    document.body.innerHTML = `<div id="wrap"><relative-time id="item" lang="en-US">just now</relative-time></div>`;
    const localizer = new RelativeTimeLocalizer(document, 4000);
    localizer.start("zh-CN");

    const item = document.getElementById("item")!;
    expect(item.getAttribute("lang")).toBe("zh-CN");

    item.remove();
    expect(localizer.pruneDetached()).toBe(1);
    expect(localizer.trackedCount).toBe(0);
    // Original lang was restored before dropping the reference, so re-inserting later never leaves stale zh-CN.
    document.getElementById("wrap")!.append(item);
    localizer.stop();
    expect(item.getAttribute("lang")).toBe("en-US");
  });
});
