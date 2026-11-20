import { describe, expect, it } from "vitest";
import { mergeOcrRegions } from "../src/image-translation/ocr-layout";

describe("mergeOcrRegions", () => {
  it("merges adjacent OCR boxes on the same visual line", () => {
    const merged = mergeOcrRegions([
      { text: "OPEN", confidence: 0.9, box: { x: 10, y: 20, width: 70, height: 28 } },
      { text: "SETTINGS", confidence: 0.8, box: { x: 92, y: 21, width: 110, height: 27 } },
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.text).toBe("OPEN SETTINGS");
    expect(merged[0]?.box).toEqual({ x: 10, y: 20, width: 192, height: 28 });
  });

  it("keeps different lines separate and orders them top-to-bottom", () => {
    const merged = mergeOcrRegions([
      { text: "SECOND", confidence: 0.9, box: { x: 12, y: 90, width: 100, height: 24 } },
      { text: "FIRST", confidence: 0.9, box: { x: 14, y: 18, width: 88, height: 24 } },
    ]);
    expect(merged.map((item) => item.text)).toEqual(["FIRST", "SECOND"]);
  });

  it("keeps a gateway setup heading separate from the smaller nearby description", () => {
    const merged = mergeOcrRegions([
      { text: "Choose your Gateway", confidence: 0.99, box: { x: 355, y: 353, width: 549, height: 59 } },
      { text: "OpenClaw uses a single Gateway that stays running.", confidence: 0.99, box: { x: 127, y: 426, width: 977, height: 28 } },
      { text: "Discover a gateway nearby.", confidence: 0.99, box: { x: 323, y: 462, width: 616, height: 28 } },
    ]);
    expect(merged.map((item) => item.text)).toEqual([
      "Choose your Gateway",
      "OpenClaw uses a single Gateway that stays running.\nDiscover a gateway nearby.",
    ]);
    expect(merged[0]?.box).toEqual({ x: 355, y: 353, width: 549, height: 59 });
  });
});
