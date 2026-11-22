import { describe, expect, it } from "vitest";
import { relativeTimeElements } from "../src/shared/relative-time";

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
