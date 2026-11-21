import { describe, expect, it } from "vitest";
import { mergeOcrRegions } from "../src/image-translation/ocr-layout";
import {
  analyzeRegionAppearance,
  clampBoxToUniformBackground,
  contrastRatio,
  inferTextAlignment,
  wrapTranslatedParagraphs,
} from "../src/image-translation/image-renderer";

function makeCanvasPixels(
  width: number,
  height: number,
  fill: [number, number, number],
  paint?: (setPixel: (x: number, y: number, rgb: [number, number, number]) => void) => void,
): Uint8ClampedArray {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    pixels[i * 4] = fill[0];
    pixels[i * 4 + 1] = fill[1];
    pixels[i * 4 + 2] = fill[2];
    pixels[i * 4 + 3] = 255;
  }
  const setPixel = (x: number, y: number, rgb: [number, number, number]) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const off = (y * width + x) * 4;
    pixels[off] = rgb[0];
    pixels[off + 1] = rgb[1];
    pixels[off + 2] = rgb[2];
    pixels[off + 3] = 255;
  };
  paint?.(setPixel);
  return pixels;
}

function fillRect(
  setPixel: (x: number, y: number, rgb: [number, number, number]) => void,
  x: number,
  y: number,
  w: number,
  h: number,
  rgb: [number, number, number],
): void {
  for (let py = y; py < y + h; py += 1) {
    for (let px = x; px < x + w; px += 1) setPixel(px, py, rgb);
  }
}

describe("image translation layout and renderer", () => {
  it("extracts bubble background color and real foreground stroke color with readable contrast", () => {
    // Light green WhatsApp-style bubble (#dcf8c6 = 220,248,198) on beige background, with dark blue text strokes.
    const pixels = makeCanvasPixels(160, 80, [236, 229, 221], (setPixel) => {
      fillRect(setPixel, 10, 10, 140, 60, [220, 248, 198]);
      // Simulate text strokes inside box (24, 26, 110, 24)
      for (let x = 28; x < 128; x += 4) {
        fillRect(setPixel, x, 30, 2, 16, [20, 60, 140]);
      }
    });

    const box = { x: 24, y: 26, width: 110, height: 24 };
    const appearance = analyzeRegionAppearance(pixels, 160, 80, box, [box]);

    expect(appearance.isUniform).toBe(true);
    expect(appearance.bgRgb[0]).toBeGreaterThanOrEqual(214);
    expect(appearance.bgRgb[1]).toBeGreaterThanOrEqual(242);
    expect(appearance.bgRgb[2]).toBeGreaterThanOrEqual(190);
    // Foreground retains its blue hue and satisfies WCAG contrast >= 4.5
    expect(appearance.fgRgb[2]).toBeGreaterThan(appearance.fgRgb[0]);
    expect(contrastRatio(appearance.fgRgb, appearance.bgRgb)).toBeGreaterThanOrEqual(4.5);
  });

  it("clamps uniform erase padding at chat bubble borders so patches never bleed outside", () => {
    const pixels = makeCanvasPixels(120, 60, [40, 40, 40], (setPixel) => {
      // White bubble spanning x=[20..100), y=[12..48)
      fillRect(setPixel, 20, 12, 80, 36, [255, 255, 255]);
    });

    // Text box sits 2px inside the left/top edge of the bubble, while maxPadX=10, maxPadY=8.
    const clamped = clampBoxToUniformBackground(
      pixels,
      120,
      60,
      { x: 22, y: 14, width: 60, height: 20 },
      [255, 255, 255],
      10,
      8,
    );

    expect(clamped.x).toBeGreaterThanOrEqual(20);
    expect(clamped.y).toBeGreaterThanOrEqual(12);
    expect(clamped.x + clamped.width).toBeLessThanOrEqual(100);
    expect(clamped.y + clamped.height).toBeLessThanOrEqual(48);
  });

  it("keeps separate stacked bubbles apart when background color or divider gap differs", () => {
    const pixels = makeCanvasPixels(240, 140, [230, 222, 212], (setPixel) => {
      // Top white bubble y=[10..56)
      fillRect(setPixel, 10, 10, 200, 46, [255, 255, 255]);
      // Bottom white bubble y=[66..112), separated by a 10px beige gap
      fillRect(setPixel, 10, 66, 200, 46, [255, 255, 255]);
    });

    const regions = mergeOcrRegions(
      [
        { text: "First line in bubble one", confidence: 0.95, box: { x: 20, y: 16, width: 170, height: 14 } },
        { text: "Second line in bubble one", confidence: 0.95, box: { x: 20, y: 34, width: 170, height: 14 } },
        { text: "Line in bubble two", confidence: 0.95, box: { x: 20, y: 72, width: 150, height: 14 } },
      ],
      { pixels, width: 240, height: 140 },
    );

    expect(regions).toHaveLength(2);
    expect(regions[0]?.text).toBe("First line in bubble one Second line in bubble one");
    expect(regions[0]?.lineBoxes).toHaveLength(2);
    expect(regions[1]?.text).toBe("Line in bubble two");
  });

  it("preserves explicit paragraph breaks and honors Chinese kinsoku punctuation wrapping", () => {
    const measure = (value: string) => Array.from(value).length * 10;
    const paragraphs = wrapTranslatedParagraphs(
      measure,
      "你好世界，这是一段测试。\n第二段开始！",
      50,
    );

    expect(paragraphs).toHaveLength(2);
    const allLines = paragraphs.flat();
    for (const line of allLines) {
      expect(/^[，。！？；：、）】》」]/.test(line)).toBe(false);
    }
    expect(paragraphs[1]?.join("")).toBe("第二段开始！");
  });

  it("infers centered alignment for centered multi-line headings and left alignment for body paragraphs", () => {
    expect(inferTextAlignment(
      { x: 10, y: 10, width: 200, height: 60 },
      [
        { x: 10, y: 10, width: 200, height: 24 },
        { x: 60, y: 40, width: 100, height: 24 },
      ],
    )).toBe("center");

    expect(inferTextAlignment(
      { x: 10, y: 10, width: 200, height: 60 },
      [
        { x: 10, y: 10, width: 200, height: 24 },
        { x: 10, y: 40, width: 110, height: 24 },
      ],
    )).toBe("left");
  });
});
