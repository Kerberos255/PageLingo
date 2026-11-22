import { describe, expect, it } from "vitest";
import { mergeOcrRegions } from "../src/image-translation/ocr-layout";
import {
  analyzeRegionAppearance,
  clampBoxToUniformBackground,
  contrastRatio,
  fitRegionTypography,
  hasOrphanLastLine,
  inferTextAlignment,
  isStandaloneShortBox,
  renderTranslatedImageToCanvas,
  wrapTranslatedParagraphs,
} from "../src/image-translation/image-renderer";
import {
  matchImageUiShortTerm,
  normalizeImagePunctuation,
} from "../src/image-translation/ui-short-terms";

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
    const pixels = makeCanvasPixels(160, 80, [236, 229, 221], (setPixel) => {
      fillRect(setPixel, 10, 10, 140, 60, [220, 248, 198]);
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
    expect(appearance.fgRgb[2]).toBeGreaterThan(appearance.fgRgb[0]);
    expect(contrastRatio(appearance.fgRgb, appearance.bgRgb)).toBeGreaterThanOrEqual(4.5);
  });

  it("clamps uniform erase padding at chat bubble borders and adjacent timestamp strokes", () => {
    const pixels = makeCanvasPixels(120, 60, [40, 40, 40], (setPixel) => {
      fillRect(setPixel, 20, 12, 80, 36, [255, 255, 255]);
      // Small dark timestamp stroke sitting 2px below the message box on the same bubble
      fillRect(setPixel, 74, 36, 18, 8, [120, 120, 120]);
    });

    const clamped = clampBoxToUniformBackground(
      pixels,
      120,
      60,
      { x: 22, y: 14, width: 70, height: 20 },
      [255, 255, 255],
      10,
      8,
    );

    expect(clamped.x).toBeGreaterThanOrEqual(20);
    expect(clamped.y).toBeGreaterThanOrEqual(12);
    expect(clamped.x + clamped.width).toBeLessThanOrEqual(100);
    // Must stop before overlapping the timestamp at y=36
    expect(clamped.y + clamped.height).toBeLessThanOrEqual(36);
  });

  it("keeps separate stacked bubbles apart when background color or divider gap differs", () => {
    const pixels = makeCanvasPixels(240, 140, [230, 222, 212], (setPixel) => {
      fillRect(setPixel, 10, 10, 200, 46, [255, 255, 255]);
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

  it("preserves light-gray secondary captions and white-on-blue button text while enforcing a 3.0 readability floor", () => {
    const grayPixels = makeCanvasPixels(180, 60, [255, 255, 255], (setPixel) => {
      for (let x = 20; x < 150; x += 6) {
        fillRect(setPixel, x, 20, 2, 16, [138, 138, 142]);
      }
    });
    const grayAppearance = analyzeRegionAppearance(
      grayPixels,
      180,
      60,
      { x: 16, y: 16, width: 140, height: 24 },
      [{ x: 16, y: 16, width: 140, height: 24 }],
    );
    expect(grayAppearance.fgRgb).toEqual([138, 138, 142]);
    expect(contrastRatio(grayAppearance.fgRgb, grayAppearance.bgRgb)).toBeGreaterThanOrEqual(3.0);

    const blueBtnPixels = makeCanvasPixels(140, 60, [245, 245, 247], (setPixel) => {
      fillRect(setPixel, 20, 12, 100, 36, [0, 122, 255]);
      for (let x = 44; x < 96; x += 5) {
        fillRect(setPixel, x, 22, 2, 14, [255, 255, 255]);
      }
    });
    const blueAppearance = analyzeRegionAppearance(
      blueBtnPixels,
      140,
      60,
      { x: 40, y: 20, width: 60, height: 18 },
      [{ x: 40, y: 20, width: 60, height: 18 }],
    );
    expect(blueAppearance.fgRgb).toEqual([255, 255, 255]);
    expect(contrastRatio(blueAppearance.fgRgb, blueAppearance.bgRgb)).toBeGreaterThanOrEqual(3.0);

    const faintPixels = makeCanvasPixels(140, 50, [255, 255, 255], (setPixel) => {
      for (let x = 20; x < 110; x += 5) {
        fillRect(setPixel, x, 16, 2, 14, [215, 215, 215]);
      }
    });
    const faintAppearance = analyzeRegionAppearance(
      faintPixels,
      140,
      50,
      { x: 16, y: 14, width: 100, height: 20 },
      [{ x: 16, y: 14, width: 100, height: 20 }],
    );
    expect(contrastRatio(faintAppearance.fgRgb, faintAppearance.bgRgb)).toBeGreaterThanOrEqual(3.0);
  });

  it("distinguishes bold headings from regular body text using tight glyph bounding-box stroke density", () => {
    const boldPixels = makeCanvasPixels(220, 70, [255, 255, 255], (setPixel) => {
      // Dense 3px-wide stems with 2px gaps inside a generously padded OCR box
      for (let x = 24; x < 184; x += 5) {
        fillRect(setPixel, x, 24, 3, 18, [20, 22, 26]);
      }
    });
    const regularPixels = makeCanvasPixels(220, 70, [255, 255, 255], (setPixel) => {
      // Thin 1px-wide stems with 4px gaps inside the same padded OCR box
      for (let x = 24; x < 184; x += 5) {
        fillRect(setPixel, x, 24, 1, 18, [20, 22, 26]);
      }
    });
    const box = { x: 14, y: 12, width: 186, height: 42 };
    const boldApp = analyzeRegionAppearance(boldPixels, 220, 70, box, [box]);
    const regApp = analyzeRegionAppearance(regularPixels, 220, 70, box, [box]);
    expect(boldApp.fontWeight).toBeGreaterThanOrEqual(600);
    expect(regApp.fontWeight).toBe(400);
  });

  it("identifies standalone buttons and side-by-side dialog buttons for centering while keeping inline and heading text left-aligned", () => {
    const cancelBtn = { text: "取消", confidence: 0.98, box: { x: 160, y: 180, width: 58, height: 18 }, lineHeight: 18 };
    const openBtn = { text: "打开", confidence: 0.98, box: { x: 248, y: 180, width: 52, height: 18 }, lineHeight: 18 };
    const inlineLeft = { text: "打开", confidence: 0.98, box: { x: 40, y: 120, width: 40, height: 18 }, lineHeight: 18 };
    const inlineRight = { text: "设置", confidence: 0.98, box: { x: 86, y: 120, width: 42, height: 18 }, lineHeight: 18 };
    const sectionHeading = { text: "权限", confidence: 0.98, box: { x: 40, y: 20, width: 96, height: 22 }, lineHeight: 22 };
    const bodyPara = {
      text: "允许此应用访问您的桌面文件夹中的文件。",
      confidence: 0.98,
      box: { x: 40, y: 50, width: 280, height: 42 },
      lineBoxes: [
        { x: 40, y: 50, width: 280, height: 18 },
        { x: 40, y: 74, width: 180, height: 18 },
      ],
      lineHeight: 18,
    };
    const heroHeading = { text: "智能工作区同步", confidence: 0.98, box: { x: 48, y: 44, width: 280, height: 30 }, lineHeight: 30 };
    const heroSubtitle = { text: "让本地文件与扩展插件始终保持无缝同步。", confidence: 0.98, box: { x: 48, y: 82, width: 320, height: 20 }, lineHeight: 20 };
    const all = [heroHeading, heroSubtitle, sectionHeading, bodyPara, inlineLeft, inlineRight, cancelBtn, openBtn];
    const bgMap = new Map([
      [heroHeading, [24, 24, 32] as [number, number, number]],
      [heroSubtitle, [24, 24, 32] as [number, number, number]],
      [sectionHeading, [255, 255, 255] as [number, number, number]],
      [bodyPara, [255, 255, 255] as [number, number, number]],
      [cancelBtn, [232, 232, 237] as [number, number, number]],
      [openBtn, [0, 122, 255] as [number, number, number]],
    ]);

    expect(isStandaloneShortBox(cancelBtn, all, cancelBtn.text, bgMap)).toBe(true);
    expect(isStandaloneShortBox(openBtn, all, openBtn.text, bgMap)).toBe(true);
    expect(isStandaloneShortBox(inlineLeft, all, inlineLeft.text, bgMap)).toBe(false);
    expect(isStandaloneShortBox(bodyPara, all, bodyPara.text, bgMap)).toBe(false);
    expect(isStandaloneShortBox(sectionHeading, all, sectionHeading.text, bgMap)).toBe(false);
    expect(isStandaloneShortBox(heroHeading, all, heroHeading.text, bgMap)).toBe(false);
  });

  it("pulls a 1-2 character CJK orphan last line onto the previous line via slack or 5%-8% font shrink", () => {
    let activeFontSize = 14;
    const mockCtx = {
      set font(value: string) {
        const match = /(\d+(?:\.\d+)?)px/.exec(value);
        if (match) activeFontSize = Number(match[1]);
      },
      get font() {
        return `400 ${activeFontSize}px sans-serif`;
      },
      measureText(value: string) {
        return { width: Array.from(value).length * activeFontSize };
      },
    } as unknown as CanvasRenderingContext2D;

    // 13 chars at 14px = 182px -> in 168px box (12 chars), kinsoku prevents leading '。'
    // and pulls '序' down, creating a 2-char orphan line "序。".
    const text = "系统正在启动您的应用程序。";
    const rawWrapped = wrapTranslatedParagraphs((v) => Array.from(v).length * 14, text, 168);
    expect(hasOrphanLastLine(rawWrapped)).toBe(true);

    const fitted = fitRegionTypography(
      mockCtx,
      text,
      { x: 0, y: 0, width: 168, height: 60 },
      14,
      9,
      400,
      3,
    );
    expect(hasOrphanLastLine(fitted.paragraphs)).toBe(false);
    expect(fitted.paragraphs[0]).toHaveLength(1);
    expect(fitted.fontSize).toBeGreaterThanOrEqual(14 * 0.91);
  });

  it("preserves per-block dynamic font size hierarchy and centers standalone buttons at geometric center", () => {
    const pixels = makeCanvasPixels(400, 260, [255, 255, 255], (setPixel) => {
      // Heading strokes
      for (let x = 28; x < 240; x += 5) fillRect(setPixel, x, 24, 3, 20, [20, 22, 26]);
      // Body strokes
      for (let x = 28; x < 340; x += 5) fillRect(setPixel, x, 72, 1, 14, [60, 62, 68]);
      // Secondary caption strokes
      for (let x = 28; x < 260; x += 5) fillRect(setPixel, x, 118, 1, 10, [138, 138, 142]);
      // Blue Open button
      fillRect(setPixel, 260, 180, 90, 34, [0, 122, 255]);
      for (let x = 284; x < 326; x += 5) fillRect(setPixel, x, 189, 2, 14, [255, 255, 255]);
    });

    const drawnCalls: Array<{
      text: string;
      x: number;
      y: number;
      font: string;
      fontSize: number;
      textAlign: string;
      textBaseline: string;
      fillStyle: string;
    }> = [];

    let fontSize = 14;
    const mockCtx = {
      font: "400 14px sans-serif",
      fillStyle: "#000",
      textAlign: "left",
      textBaseline: "top",
      imageSmoothingEnabled: true,
      imageSmoothingQuality: "high",
      clearRect() {},
      save() {},
      restore() {},
      beginPath() {},
      rect() {},
      roundRect() {},
      fill() {},
      createLinearGradient() {
        return { addColorStop() {} };
      },
      measureText(value: string) {
        const m = /(\d+(?:\.\d+)?)px/.exec(this.font);
        fontSize = m ? Number(m[1]) : 14;
        return { width: Array.from(value).length * fontSize };
      },
      fillText(text: string, x: number, y: number) {
        const m = /(\d+(?:\.\d+)?)px/.exec(this.font);
        drawnCalls.push({
          text,
          x,
          y,
          font: this.font,
          fontSize: m ? Number(m[1]) : 0,
          textAlign: this.textAlign,
          textBaseline: this.textBaseline,
          fillStyle: String(this.fillStyle),
        });
      },
    };
    const mockCanvas = {
      width: 400,
      height: 260,
      getContext: () => mockCtx,
    } as unknown as HTMLCanvasElement;

    const ok = renderTranslatedImageToCanvas(mockCanvas, {
      regions: [
        { text: "应用权限确认", confidence: 0.98, box: { x: 24, y: 20, width: 220, height: 28 }, lineHeight: 28 },
        {
          text: "请确认是否允许此应用读取桌面文件。",
          confidence: 0.98,
          box: { x: 24, y: 68, width: 320, height: 40 },
          lineBoxes: [
            { x: 24, y: 68, width: 320, height: 20 },
            { x: 24, y: 90, width: 180, height: 18 },
          ],
          lineHeight: 20,
        },
        { text: "稍后可在系统设置中修改。", confidence: 0.96, box: { x: 24, y: 114, width: 240, height: 15 }, lineHeight: 15 },
        { text: "打开", confidence: 0.99, box: { x: 280, y: 187, width: 50, height: 20 }, lineHeight: 20 },
      ],
      ocrWidth: 400,
      ocrHeight: 260,
      pixels: pixels.buffer as ArrayBuffer,
    });
    expect(ok).toBe(true);

    const headingCall = drawnCalls.find((c) => c.text.includes("应用权限"));
    const bodyCall = drawnCalls.find((c) => c.text.includes("请确认"));
    const captionCall = drawnCalls.find((c) => c.text.includes("系统设置"));
    const openBtnCall = drawnCalls.find((c) => c.text === "打开");

    expect(headingCall).toBeDefined();
    expect(bodyCall).toBeDefined();
    expect(captionCall).toBeDefined();
    expect(openBtnCall).toBeDefined();

    // Dynamic per-block font hierarchy must not flatten heading, body, and caption into one size
    expect(headingCall!.fontSize).toBeGreaterThan(bodyCall!.fontSize);
    expect(bodyCall!.fontSize).toBeGreaterThan(captionCall!.fontSize);
    // Standalone button is centered at geometric center (280+25, 187+10)
    expect(openBtnCall!.textAlign).toBe("center");
    expect(openBtnCall!.textBaseline).toBe("middle");
    expect(openBtnCall!.x).toBeCloseTo(305, 1);
    expect(openBtnCall!.y).toBeCloseTo(197, 1);
    // Body stays left-aligned
    expect(bodyCall!.textAlign).toBe("left");
  });

  it("maps standalone short English UI button terms accurately without affecting full sentences", () => {
    expect(matchImageUiShortTerm("Open", "zh-Hans")).toBe("打开");
    expect(matchImageUiShortTerm("OPEN", "zh-Hans")).toBe("打开");
    expect(matchImageUiShortTerm("Open...", "zh-Hans")).toBe("打开…");
    expect(matchImageUiShortTerm("Open", "zh-Hant")).toBe("開啟");
    expect(matchImageUiShortTerm("Cancel", "zh-Hans")).toBe("取消");
    expect(matchImageUiShortTerm("Allow", "zh-Hans")).toBe("允许");
    expect(matchImageUiShortTerm("Deny", "zh-Hans")).toBe("拒绝");
    expect(matchImageUiShortTerm("Continue", "zh-Hans")).toBe("继续");
    expect(matchImageUiShortTerm("Learn more", "zh-Hans")).toBe("了解更多");
    expect(matchImageUiShortTerm("Allow once", "zh-Hans")).toBe("仅允许一次");
    expect(matchImageUiShortTerm("Don't allow", "zh-Hans")).toBe("不允许");

    // Must not intercept multi-word sentences or non-Chinese targets
    expect(matchImageUiShortTerm("Open the settings page", "zh-Hans")).toBeNull();
    expect(matchImageUiShortTerm("Cancel all downloads", "zh-Hans")).toBeNull();
    expect(matchImageUiShortTerm("Open", "en")).toBeNull();
    expect(matchImageUiShortTerm("Open", "ja")).toBeNull();
  });

  it("normalizes half-width punctuation next to CJK while preserving times like 7:43 and numbers", () => {
    expect(normalizeImagePunctuation("你好,世界! 真的吗?")).toBe("你好，世界！真的吗？");
    expect(normalizeImagePunctuation("OpenClaw, 沙盒模式; 请确认:")).toBe("OpenClaw，沙盒模式；请确认：");
    expect(normalizeImagePunctuation("请于 7:43 前确认, 共 1,000 项!")).toBe("请于 7:43 前确认，共 1,000 项！");
    expect(normalizeImagePunctuation("时间:7:43")).toBe("时间：7:43");
    expect(normalizeImagePunctuation("访问 https://example.com 确认")).toBe("访问 https://example.com 确认");
    expect(normalizeImagePunctuation("7:43")).toBe("7:43");
  });
});
