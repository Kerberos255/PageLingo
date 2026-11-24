import { describe, expect, it } from "vitest";
import { extractPdfPageBlocks, type PdfFontStyleInfo, type PdfRawTextItem } from "../src/reader/pdf-layout";
import {
  buildPdfBlocksFromOcr,
  maskImageRgbaForOcr,
  prepareLayoutMaskPlan,
  type DocLayoutBox,
} from "../src/reader/pdf-ocr-layout";
import type { OcrRegion } from "../src/image-translation/ocr-layout";

function makePdfItem(
  str: string,
  x: number,
  topY: number,
  width: number,
  fontSize = 10,
  fontName = "F_BODY",
  pageHeight = 792,
): PdfRawTextItem {
  const baselineY = topY + fontSize * 0.85;
  return {
    str,
    transform: [fontSize, 0, 0, fontSize, x, pageHeight - baselineY],
    width,
    height: fontSize,
    fontName,
    hasEOL: false,
  };
}

const DEFAULT_STYLES: Record<string, PdfFontStyleInfo> = {
  F_BODY: { fontFamily: "serif", realFontName: "CMR10" },
  F_BOLD: { fontFamily: "serif", realFontName: "CMBX10" },
  F_MATH: { fontFamily: "serif", realFontName: "CMMI10" },
};

describe("two-tier PDF table detection in pdf-layout.ts", () => {
  it("classifies a dense multi-column numeric/architecture table as snapshot while keeping its caption translatable", () => {
    const items: PdfRawTextItem[] = [
      makePdfItem("Table 1: Benchmark results across model depths on validation set.", 72, 60, 380, 10, "F_BODY"),
      // Header row (5 columns)
      makePdfItem("Model", 80, 90, 42, 9, "F_BOLD"),
      makePdfItem("Params", 180, 90, 42, 9, "F_BOLD"),
      makePdfItem("FLOPs", 260, 90, 40, 9, "F_BOLD"),
      makePdfItem("Top-1", 340, 90, 38, 9, "F_BOLD"),
      makePdfItem("Top-5", 420, 90, 38, 9, "F_BOLD"),
      // Data rows
      makePdfItem("ResNet-18", 80, 106, 52, 9),
      makePdfItem("11.7M", 180, 106, 36, 9),
      makePdfItem("1.8G", 260, 106, 30, 9),
      makePdfItem("69.8%", 340, 106, 34, 9),
      makePdfItem("89.1%", 420, 106, 34, 9),

      makePdfItem("ResNet-34", 80, 122, 52, 9),
      makePdfItem("21.8M", 180, 122, 36, 9),
      makePdfItem("3.6G", 260, 122, 30, 9),
      makePdfItem("73.3%", 340, 122, 34, 9),
      makePdfItem("91.4%", 420, 122, 34, 9),

      makePdfItem("ResNet-50", 80, 138, 52, 9),
      makePdfItem("25.6M", 180, 138, 36, 9),
      makePdfItem("4.1G", 260, 138, 30, 9),
      makePdfItem("76.1%", 340, 138, 34, 9),
      makePdfItem("92.9%", 420, 138, 34, 9),

      // Normal paragraph below
      makePdfItem("As shown in the table above, deeper residual networks steadily improve accuracy.", 72, 180, 420, 10),
    ];

    const blocks = extractPdfPageBlocks(items, DEFAULT_STYLES, 612, 792, 2);
    const tables = blocks.filter((b) => b.kind === "table");
    expect(tables).toHaveLength(1);
    expect(tables[0]!.tableMode).toBe("snapshot");
    expect(tables[0]!.plainText).toContain("ResNet-50");
    expect(tables[0]!.plainText).not.toContain("Table 1:");

    const caption = blocks.find((b) => b.kind === "paragraph" && b.plainText.startsWith("Table 1:"));
    expect(caption).toBeDefined();
    expect(caption!.lineBoxes?.length).toBe(1);
  });

  it("keeps a full-width compact-font table intact above two-column prose (ResNet Page 5 pattern)", () => {
    const items: PdfRawTextItem[] = [];
    // Top full-width 6-column compact 7pt table straddling x=306
    const cols = [120, 175, 235, 295, 355, 420];
    const rows = [
      ["layer", "output", "18-layer", "34-layer", "50-layer", "101-layer"],
      ["conv1", "112x112", "7x7, 64", "7x7, 64", "7x7, 64", "7x7, 64"],
      ["conv2_x", "56x56", "3x3, 64", "3x3, 64", "1x1, 64", "1x1, 64"],
      ["conv3_x", "28x28", "3x3, 128", "3x3, 128", "1x1, 128", "1x1, 128"],
      ["conv4_x", "14x14", "3x3, 256", "3x3, 256", "1x1, 256", "1x1, 256"],
    ];
    rows.forEach((row, r) => {
      row.forEach((cell, c) => {
        items.push(makePdfItem(cell, cols[c]!, 70 + r * 14, 42, 7));
      });
    });

    // Two-column prose below (body font = 10pt)
    for (let i = 0; i < 8; i += 1) {
      items.push(makePdfItem("Left column paragraph sentence explaining residual shortcuts in depth.", 50, 220 + i * 13, 235, 10));
      items.push(makePdfItem("Right column paragraph sentence evaluating ImageNet validation results.", 325, 220 + i * 13, 235, 10));
    }

    const blocks = extractPdfPageBlocks(items, DEFAULT_STYLES, 612, 792, 5);
    const tables = blocks.filter((b) => b.kind === "table");
    expect(tables).toHaveLength(1);
    expect(tables[0]!.column).toBe("full");
    expect(tables[0]!.tableMode).toBe("snapshot");
    expect(tables[0]!.plainText).toContain("18-layer");
    expect(tables[0]!.plainText).toContain("101-layer");

    const leftPara = blocks.find((b) => b.column === "left" && b.kind === "paragraph");
    const rightPara = blocks.find((b) => b.column === "right" && b.kind === "paragraph");
    expect(leftPara).toBeDefined();
    expect(rightPara).toBeDefined();
  });

  it("reconstructs a clean 3-column prose comparison table as translatable HTML with cell boxes", () => {
    const items: PdfRawTextItem[] = [
      makePdfItem("Table 2: Comparison of local translation strategies.", 72, 60, 320, 10),
      // Bold header row
      makePdfItem("Approach", 72, 90, 70, 10, "F_BOLD"),
      makePdfItem("Primary Advantage", 200, 90, 120, 10, "F_BOLD"),
      makePdfItem("Main Limitation", 370, 90, 110, 10, "F_BOLD"),
      // Prose rows
      makePdfItem("Side-by-side", 72, 110, 80, 10),
      makePdfItem("Clear bilingual reading flow", 200, 110, 140, 10),
      makePdfItem("Uses wider horizontal space", 370, 110, 145, 10),

      makePdfItem("In-place overlay", 72, 130, 88, 10),
      makePdfItem("Preserves original page layout", 200, 130, 145, 10),
      makePdfItem("Needs compact target wording", 370, 130, 150, 10),

      makePdfItem("Hybrid OCR", 72, 150, 68, 10),
      makePdfItem("Handles pure scanned documents", 200, 150, 150, 10),
      makePdfItem("Requires local model download", 370, 150, 150, 10),
    ];

    const blocks = extractPdfPageBlocks(items, DEFAULT_STYLES, 612, 792, 3);
    const tables = blocks.filter((b) => b.kind === "table");
    expect(tables).toHaveLength(1);
    const table = tables[0]!;
    expect(table.tableMode).toBe("html");
    expect(table.tableHasHeader).toBe(true);
    expect(table.tableRows).toHaveLength(4);
    expect(table.tableRows![0]!.map((cell) => cell.map((s) => s.text).join(""))).toEqual([
      "Approach",
      "Primary Advantage",
      "Main Limitation",
    ]);
    expect(table.tableCellBoxes?.length).toBe(12);
  });

  it("does not misclassify Page 1 author affiliations or bullet lists as tables", () => {
    const items: PdfRawTextItem[] = [
      // Page 1 multi-column authors & affiliations
      makePdfItem("Alice Smith*", 100, 90, 70, 10),
      makePdfItem("Bob Jones*", 260, 90, 65, 10),
      makePdfItem("Carol Lee*", 410, 90, 65, 10),
      makePdfItem("Google Research", 100, 106, 85, 9),
      makePdfItem("MIT University", 260, 106, 80, 9),
      makePdfItem("Stanford Lab", 410, 106, 75, 9),
      makePdfItem("alice@example.org", 100, 120, 95, 9),
      makePdfItem("bob@example.org", 260, 120, 90, 9),
      makePdfItem("carol@example.org", 410, 120, 95, 9),
      // Bulleted list with wide gap after bullet
      makePdfItem("•", 72, 220, 6, 10),
      makePdfItem("First bullet point describing system behavior cleanly.", 102, 220, 260, 10),
      makePdfItem("•", 72, 238, 6, 10),
      makePdfItem("Second bullet point describing fallback rules cleanly.", 102, 238, 265, 10),
      makePdfItem("•", 72, 256, 6, 10),
      makePdfItem("Third bullet point describing evaluation metrics cleanly.", 102, 256, 270, 10),
    ];

    const blocks = extractPdfPageBlocks(items, DEFAULT_STYLES, 612, 792, 1);
    expect(blocks.filter((b) => b.kind === "table")).toHaveLength(0);
    expect(blocks.filter((b) => b.kind === "list-item").length).toBe(3);
  });
});

describe("scanned PDF layout + OCR fusion (pdf-ocr-layout.ts)", () => {
  it("merges formula_number with display formula, preserves inline formulas inside text, deduplicates overlapping visuals, and masks paper background", () => {
    const rawLayout: DocLayoutBox[] = [
      // Overlapping image + chart -> should merge into 1 figure
      { label: "image", score: 0.68, box: { x: 100, y: 80, width: 800, height: 240 } },
      { label: "chart", score: 0.55, box: { x: 110, y: 76, width: 780, height: 248 } },
      // Table + overlapping low-score formula -> table wins
      { label: "table", score: 0.92, box: { x: 120, y: 360, width: 760, height: 220 } },
      { label: "formula", score: 0.50, box: { x: 125, y: 365, width: 750, height: 210 } },
      // Text container containing a small inline formula -> inline formula must NOT be masked!
      { label: "text", score: 0.94, box: { x: 100, y: 620, width: 800, height: 140 } },
      { label: "formula", score: 0.62, box: { x: 420, y: 650, width: 80, height: 24 } },
      // Standalone display formula + aligned formula_number -> unified display formula box
      { label: "formula", score: 0.88, box: { x: 240, y: 800, width: 500, height: 60 } },
      { label: "formula_number", score: 0.82, box: { x: 860, y: 818, width: 40, height: 24 } },
      // Duplicate table_title + text on same box -> table_title wins
      { label: "table_title", score: 0.72, box: { x: 120, y: 585, width: 760, height: 30 } },
      { label: "text", score: 0.50, box: { x: 120, y: 585, width: 760, height: 30 } },
      // Page header to skip
      { label: "header", score: 0.78, box: { x: 100, y: 15, width: 300, height: 22 } },
    ];

    const plan = prepareLayoutMaskPlan(rawLayout, 1000, 1400);
    expect(plan.visualBlocks.filter((v) => v.kind === "figure")).toHaveLength(1);
    expect(plan.visualBlocks.filter((v) => v.kind === "table")).toHaveLength(1);

    const formulas = plan.visualBlocks.filter((v) => v.kind === "formula");
    expect(formulas).toHaveLength(1);
    // Display formula merged with formula_number (240..900)
    expect(formulas[0]!.box.x).toBe(240);
    expect(formulas[0]!.box.x + formulas[0]!.box.width).toBe(900);

    // Inline formula inside text was NOT masked
    expect(plan.maskRects.some((r) => r.x === 420 && r.y === 650)).toBe(false);
    // table_title won over duplicate text
    expect(plan.textContainers.filter((c) => c.label === "table_title")).toHaveLength(1);
    expect(plan.textContainers).toHaveLength(2);
    // header went into skipRects & maskRects
    expect(plan.skipRects).toHaveLength(1);

    // Masking fills with sampled cream paper background (250, 245, 230)
    const w = 100;
    const h = 100;
    const pixels = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i += 1) {
      pixels[i * 4] = 250;
      pixels[i * 4 + 1] = 245;
      pixels[i * 4 + 2] = 230;
      pixels[i * 4 + 3] = 255;
    }
    // Paint black ink inside [20..50, 20..50]
    for (let y = 25; y < 45; y += 1) {
      for (let x = 25; x < 45; x += 1) {
        const off = (y * w + x) * 4;
        pixels[off] = 10;
        pixels[off + 1] = 10;
        pixels[off + 2] = 10;
      }
    }
    const masked = maskImageRgbaForOcr(pixels, w, h, [{ x: 20, y: 20, width: 30, height: 30 }]);
    const centerOff = (35 * w + 35) * 4;
    expect([masked[centerOff], masked[centerOff + 1], masked[centerOff + 2]]).toEqual([250, 245, 230]);
    // Original buffer untouched
    expect(pixels[centerOff]).toBe(10);
  });

  it("orders two-column scanned blocks via XY-Cut, filters margin page numbers, and recovers orphan prose lines", () => {
    const plan = prepareLayoutMaskPlan([
      { label: "doc_title", score: 0.91, box: { x: 100, y: 80, width: 800, height: 60 } },
      { label: "table", score: 0.90, box: { x: 100, y: 170, width: 800, height: 220 } },
      { label: "text", score: 0.92, box: { x: 60, y: 440, width: 410, height: 240 } },
      { label: "text", score: 0.91, box: { x: 530, y: 440, width: 410, height: 240 } },
    ], 1000, 1400);

    const ocrRegions: OcrRegion[] = [
      { text: "Deep Residual Learning", confidence: 0.98, box: { x: 220, y: 92, width: 520, height: 32 } },
      // Left column text
      { text: "Left column first line of trans-", confidence: 0.95, box: { x: 70, y: 460, width: 380, height: 20 } },
      { text: "formation study.", confidence: 0.95, box: { x: 70, y: 486, width: 220, height: 20 } },
      // Right column text
      { text: "Right column evaluation results.", confidence: 0.96, box: { x: 540, y: 460, width: 380, height: 20 } },
      // Orphan paragraph missed by PP-DocLayout in left column below
      { text: "Recovered orphan paragraph line one.", confidence: 0.94, box: { x: 70, y: 740, width: 370, height: 20 } },
      { text: "Recovered orphan paragraph line two.", confidence: 0.94, box: { x: 70, y: 766, width: 370, height: 20 } },
      // Isolated bottom margin page number -> should be filtered out
      { text: "5", confidence: 0.97, box: { x: 492, y: 1320, width: 16, height: 20 } },
    ];

    const blocks = buildPdfBlocksFromOcr(plan, ocrRegions, 1000, 1400, 500, 700, 5);
    expect(blocks.some((b) => b.plainText === "5")).toBe(false);
    expect(blocks.map((b) => `${b.kind}:${b.column}`)).toEqual([
      "heading:full",
      "table:full",
      "paragraph:left",
      "paragraph:left",
      "paragraph:right",
    ]);
    // Hyphenated wrap joined cleanly
    expect(blocks[2]!.plainText).toBe("Left column first line of transformation study.");
    expect(blocks[2]!.lineBoxes).toHaveLength(2);
    // Coordinates scaled cleanly from 1000x1400 -> 500x700
    expect(blocks[0]!.box.x).toBeCloseTo(110, 1);
    expect(blocks[0]!.box.y).toBeCloseTo(46, 1);
    expect(blocks[3]!.plainText).toContain("Recovered orphan paragraph line one. Recovered orphan paragraph line two.");
    expect(blocks[3]!.source).toBe("ocr");
  });

  it("groups horizontally split inline-fraction OCR lines in strict left-to-right row order and merges row erase boxes safely", () => {
    const plan = prepareLayoutMaskPlan([
      { label: "text", score: 0.90, box: { x: 200, y: 360, width: 800, height: 64 } },
      { label: "formula", score: 0.88, box: { x: 240, y: 440, width: 680, height: 52 } },
      { label: "formula_number", score: 0.80, box: { x: 960, y: 454, width: 38, height: 22 } },
    ], 1200, 1600);

    const ocrRegions: OcrRegion[] = [
      // Row 1 split around an inline fraction (deliberately out of reading order in input)
      { text: "β", confidence: 0.92, box: { x: 670, y: 366, width: 22, height: 18 } },
      { text: "given xt. Since xt is available as", confidence: 0.98, box: { x: 730, y: 370, width: 268, height: 22 } },
      { text: "Equation (10) reveals that μθ must predict", confidence: 0.97, box: { x: 206, y: 372, width: 350, height: 22 } },
      // Row 2
      { text: "input to the model, we may choose the parameterization", confidence: 0.99, box: { x: 206, y: 402, width: 450, height: 20 } },
    ];

    const blocks = buildPdfBlocksFromOcr(plan, ocrRegions, 1200, 1600, 600, 800, 4);
    const para = blocks.find((b) => b.kind === "paragraph")!;
    expect(para).toBeDefined();
    expect(para.plainText.startsWith("Equation (10) reveals that")).toBe(true);
    expect(para.plainText).toContain("given xt. Since xt is available as input to the model");
    // Merged into 2 full visual row erase boxes (not 4 fragmented boxes with un-erased holes!)
    expect(para.lineBoxes).toHaveLength(2);
    expect(para.lineBoxes![0]!.x).toBeLessThanOrEqual(105);
    expect(para.lineBoxes![0]!.x + para.lineBoxes![0]!.width).toBeGreaterThanOrEqual(495);

    // Display formula below stays completely separate and protected
    const formula = blocks.find((b) => b.kind === "formula")!;
    expect(formula).toBeDefined();
    expect(formula.box.y).toBeGreaterThanOrEqual(para.box.y + para.box.height);
  });
});

describe("multi-line HTML tables & digital vector figure detection regressions", () => {
  it("keeps multi-line wrapped prose cells and vertically centered labels unified in a 4x3 HTML table without false 2-column splitting", () => {
    const items: PdfRawTextItem[] = [
      makePdfItem("Evaluating Local Document Translation Modes", 56, 70, 260, 16, "F_BOLD"),
      makePdfItem("Modern browser extensions can translate structured research documents entirely on the user's device without", 56, 108, 490, 10),
      makePdfItem("sending private files to remote servers. Selecting the right presentation mode balances layout fidelity against", 56, 122, 490, 10),
      makePdfItem("Table 1: Qualitative comparison of three document translation workflows for researchers.", 56, 155, 360, 9.5),
      // Header row (bold)
      makePdfItem("Workflow Mode", 65, 188, 70, 10, "F_BOLD"),
      makePdfItem("Primary Strength", 157, 188, 76, 10, "F_BOLD"),
      makePdfItem("Engineering Trade-off", 362, 188, 95, 10, "F_BOLD"),
      // Row 1: all 3 columns wrap onto 2 lines (baseline diff = 15pt, vGap = 5pt)
      makePdfItem("Side-by-side", 65, 216, 51, 10),
      makePdfItem("Clear bilingual paragraph alignment for", 157, 216, 159, 10),
      makePdfItem("Requires extra horizontal viewport width on", 362, 216, 177, 10),
      makePdfItem("reader", 65, 231, 25, 10),
      makePdfItem("careful study", 157, 231, 52, 10),
      makePdfItem("laptops", 362, 231, 29, 10),
      // Row 2: col 0 vertically centered between line 1 & line 2 of cols 1-2
      makePdfItem("Preserves original figures and formulas pixel-", 157, 259, 183, 10),
      makePdfItem("Longer target languages must fit inside", 362, 259, 156, 10),
      makePdfItem("In-place overlay", 65, 266.5, 65, 10),
      makePdfItem("for-pixel", 157, 274, 35, 10),
      makePdfItem("source boxes", 362, 274, 52, 10),
      // Row 3: all 3 columns wrap onto 2 lines
      makePdfItem("Layout-guided", 65, 301, 59, 10),
      makePdfItem("Extracts readable text from pure scanned", 157, 301, 164, 10),
      makePdfItem("Adds local neural inference time per scanned", 362, 301, 180, 10),
      makePdfItem("OCR", 65, 316, 21, 10),
      makePdfItem("archives", 157, 316, 33, 10),
      makePdfItem("page", 362, 316, 19, 10),
      // Table 2: 5-col dense numeric table below (must NOT trigger false 2-col page gutter!)
      makePdfItem("Table 2: Measured single-thread WebAssembly latency and accuracy metrics across model tiers.", 56, 380, 365, 9.5),
      makePdfItem("Model Tier", 65, 412, 48, 10, "F_BOLD"),
      makePdfItem("Size", 204, 412, 18, 10, "F_BOLD"),
      makePdfItem("Det Hmean", 282, 412, 48, 10, "F_BOLD"),
      makePdfItem("Rec Acc", 380, 412, 34, 10, "F_BOLD"),
      makePdfItem("WASM Time", 456, 412, 55, 10, "F_BOLD"),
      makePdfItem("PP-OCRv5 Mobile", 65, 434, 72, 10),
      makePdfItem("21.4 MB", 204, 434, 38, 10),
      makePdfItem("75.2%", 282, 434, 28, 10),
      makePdfItem("76.8%", 380, 434, 28, 10),
      makePdfItem("2.4 s", 456, 434, 22, 10),
      makePdfItem("PP-OCRv6 Small", 65, 456, 68, 10),
      makePdfItem("31.2 MB", 204, 456, 38, 10),
      makePdfItem("84.1%", 282, 456, 28, 10),
      makePdfItem("81.3%", 380, 456, 28, 10),
      makePdfItem("2.3 s", 456, 456, 22, 10),
      makePdfItem("Combining a fast text-layer parser for digital PDFs with on-demand layout detection gives broad coverage.", 56, 500, 480, 10),
    ];

    const blocks = extractPdfPageBlocks(items, DEFAULT_STYLES, 612, 792, 1);
    const tables = blocks.filter((b) => b.kind === "table");
    expect(tables).toHaveLength(2);
    expect(tables[0]!.tableMode).toBe("html");
    expect(tables[0]!.tableHasHeader).toBe(true);
    expect(tables[0]!.tableRows).toHaveLength(4);
    expect(tables[0]!.tableCellBoxes).toHaveLength(12);
    const rowTexts = tables[0]!.tableRows!.map((r) => r.map((c) => c.map((s) => s.text).join("")));
    expect(rowTexts[1]![0]).toBe("Side-by-side reader");
    expect(rowTexts[1]![1]).toBe("Clear bilingual paragraph alignment for careful study");
    expect(rowTexts[2]![0]).toBe("In-place overlay");
    expect(rowTexts[2]![2]).toBe("Longer target languages must fit inside source boxes");
    expect(rowTexts[3]![0]).toBe("Layout-guided OCR");
    expect(tables[1]!.tableMode).toBe("snapshot");
    // No escaped cell text outside Table 1
    expect(blocks.some((b) => b.kind === "paragraph" && (b.plainText === "In-place overlay" || b.plainText === "for-pixel"))).toBe(false);
  });

  it("coalesces digital PDF vector chart axis ticks and rotated labels above Figure captions into a protected figure block", () => {
    const H = 792;
    const items: PdfRawTextItem[] = [
      makePdfItem("Table 1. Architectures for ImageNet with stacked residual building blocks.", 50, 222, 480, 9),
      // Vector chart ticks, legends, and rotated 90-deg y-axis label
      makePdfItem("60", 94, 258, 7, 6.9),
      makePdfItem("50", 94, 286, 7, 6.9),
      makePdfItem("40", 94, 314, 7, 6.9),
      { str: "error (%)", transform: [0, 6.9, -6.9, 0, 91, H - 326], width: 25, height: 6.9, fontName: "F_BODY" },
      makePdfItem("plain-18", 116, 353, 27, 8.1),
      makePdfItem("plain-34", 116, 363, 27, 8.1),
      makePdfItem("iter. (1e4)", 180, 381, 27, 6.9),
      // Mirror right panel
      makePdfItem("60", 318, 258, 7, 6.9),
      makePdfItem("50", 318, 286, 7, 6.9),
      { str: "error (%)", transform: [0, 6.9, -6.9, 0, 315, H - 326], width: 25, height: 6.9, fontName: "F_BODY" },
      makePdfItem("ResNet-18", 340, 353, 34, 8.1),
      makePdfItem("iter. (1e4)", 404, 381, 27, 6.9),
      // Caption immediately below the chart
      makePdfItem("Figure 4. Training on ImageNet. Thin curves denote training error and bold curves denote validation error.", 50, 392, 490, 9),
      // Normal prose below
      makePdfItem("We have three major observations from Figure 4 regarding residual learning convergence.", 50, 440, 440, 9),
    ];

    const blocks = extractPdfPageBlocks(items, DEFAULT_STYLES, 612, H, 5);
    const figures = blocks.filter((b) => b.kind === "figure");
    expect(figures).toHaveLength(1);
    // Axis ticks and rotated labels must NOT leak as translatable paragraphs
    expect(blocks.some((b) => b.kind === "paragraph" && (b.plainText.includes("error (%)") || b.plainText === "60" || b.plainText === "plain-18"))).toBe(false);
    const figIdx = blocks.findIndex((b) => b.kind === "figure");
    const capIdx = blocks.findIndex((b) => b.plainText.startsWith("Figure 4."));
    expect(figIdx).toBeGreaterThanOrEqual(0);
    expect(capIdx).toBe(figIdx + 1);
  });
});
