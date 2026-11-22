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
      "OpenClaw uses a single Gateway that stays running. Discover a gateway nearby.",
    ]);
    expect(merged[0]?.box).toEqual({ x: 355, y: 353, width: 549, height: 59 });
  });

  it("merges consecutive same-style title lines within 1.5x line height and keeps >=20% height differences apart", () => {
    const merged = mergeOcrRegions([
      { text: "OpenClaw wants to access", confidence: 0.98, box: { x: 40, y: 20, width: 280, height: 26 } },
      { text: "files in your Desktop folder.", confidence: 0.98, box: { x: 40, y: 58, width: 270, height: 25 } },
      { text: "You can change this in System Settings.", confidence: 0.96, box: { x: 40, y: 98, width: 290, height: 18 } },
    ]);
    expect(merged).toHaveLength(2);
    expect(merged[0]?.text).toBe("OpenClaw wants to access files in your Desktop folder.");
    expect(merged[0]?.lineBoxes).toHaveLength(2);
    expect(merged[1]?.text).toBe("You can change this in System Settings.");
  });

  it("splits same-height lines when foreground text colors differ significantly", () => {
    const width = 260;
    const height = 100;
    const pixels = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < width * height; i += 1) {
      pixels[i * 4] = 255;
      pixels[i * 4 + 1] = 255;
      pixels[i * 4 + 2] = 255;
      pixels[i * 4 + 3] = 255;
    }
    const paint = (x: number, y: number, w: number, h: number, rgb: [number, number, number]) => {
      for (let py = y; py < y + h; py += 1) {
        for (let px = x; px < x + w; px += 1) {
          const off = (py * width + px) * 4;
          pixels[off] = rgb[0];
          pixels[off + 1] = rgb[1];
          pixels[off + 2] = rgb[2];
        }
      }
    };
    // Dark heading strokes on line 1
    for (let x = 22; x < 200; x += 6) paint(x, 18, 3, 14, [20, 20, 24]);
    // Muted light-gray caption strokes on line 2 (same height & left edge)
    for (let x = 22; x < 200; x += 6) paint(x, 46, 2, 14, [152, 152, 158]);

    const merged = mergeOcrRegions(
      [
        { text: "Primary title line", confidence: 0.98, box: { x: 20, y: 16, width: 190, height: 18 } },
        { text: "Secondary muted note", confidence: 0.98, box: { x: 20, y: 44, width: 190, height: 18 } },
      ],
      { pixels, width, height },
    );
    expect(merged).toHaveLength(2);
    expect(merged.map((item) => item.text)).toEqual(["Primary title line", "Secondary muted note"]);
  });

  it("keeps a multi-line body paragraph separate from a following caption when vertical spacing jumps", () => {
    const merged = mergeOcrRegions([
      { text: "Granting permission lets this workspace app", confidence: 0.98, box: { x: 40, y: 80, width: 320, height: 20 } },
      { text: "sync your local notes and desktop files", confidence: 0.98, box: { x: 40, y: 102, width: 300, height: 20 } },
      { text: "after 7:43 automatically.", confidence: 0.98, box: { x: 40, y: 124, width: 170, height: 20 } },
      { text: "You can change folder permissions in Settings.", confidence: 0.97, box: { x: 40, y: 158, width: 310, height: 18 } },
    ]);
    expect(merged).toHaveLength(2);
    expect(merged[0]?.lineBoxes).toHaveLength(3);
    expect(merged[1]?.text).toBe("You can change folder permissions in Settings.");
  });
});
