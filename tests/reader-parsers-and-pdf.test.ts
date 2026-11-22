import { describe, expect, it } from "vitest";
import {
  parseDocxDocument,
  parseHtmlFileDocument,
  parseMarkdownDocument,
} from "../src/reader/document-parsers";
import { extractPdfPageBlocks, type PdfRawTextItem } from "../src/reader/pdf-layout";
import { ZipArchive } from "../src/reader/zip-reader";

/** Builds a minimal uncompressed (STORE) valid ZIP ArrayBuffer for unit testing ZipArchive / DOCX / EPUB. */
function buildStoredZip(files: Record<string, string>): ArrayBuffer {
  const enc = new TextEncoder();
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;

  for (const [name, content] of Object.entries(files)) {
    const nameBytes = enc.encode(name);
    const dataBytes = enc.encode(content);
    const lfh = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(lfh.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(8, 0, true); // STORE
    lv.setUint32(18, dataBytes.length, true);
    lv.setUint32(22, dataBytes.length, true);
    lv.setUint16(26, nameBytes.length, true);
    lfh.set(nameBytes, 30);

    const cdh = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(cdh.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(10, 0, true); // STORE
    cv.setUint32(20, dataBytes.length, true);
    cv.setUint32(24, dataBytes.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    cdh.set(nameBytes, 46);

    localParts.push(lfh, dataBytes);
    centralParts.push(cdh);
    offset += lfh.length + dataBytes.length;
  }

  const cdStart = offset;
  let cdSize = 0;
  for (const part of centralParts) cdSize += part.length;

  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, Object.keys(files).length, true);
  ev.setUint16(10, Object.keys(files).length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, cdStart, true);

  const total = cdStart + cdSize + eocd.length;
  const out = new Uint8Array(total);
  let cursor = 0;
  for (const part of [...localParts, ...centralParts, eocd]) {
    out.set(part, cursor);
    cursor += part.length;
  }
  return out.buffer;
}

describe("document parsers with structure & formula protection", () => {
  it("parses Markdown with headings, TOC, code blocks, tables, and protected LaTeX formulas", () => {
    const md = [
      "# Attention Mechanisms",
      "",
      "The complexity is $O(n^2 \\cdot d)$ for sequence length $n$.",
      "",
      "$$",
      "\\text{Attention}(Q, K, V) = \\text{softmax}\\left(\\frac{QK^T}{\\sqrt{d_k}}\\right)V",
      "$$",
      "",
      "## Architecture",
      "",
      "| Layer | Complexity |",
      "| --- | --- |",
      "| Self-Attention | $O(n^2)$ |",
      "",
      "```ts",
      "const x = 42;",
      "```",
    ].join("\n");

    const parsed = parseMarkdownDocument(document, md);
    expect(parsed.title).toBe("Attention Mechanisms");
    expect(parsed.toc.map((t) => t.label)).toEqual(["Attention Mechanisms", "Architecture"]);
    expect(parsed.formulaCount).toBe(4);

    const holder = document.createElement("div");
    holder.append(parsed.fragment);
    const displayFormula = holder.querySelector(".reader-formula");
    expect(displayFormula?.getAttribute("translate")).toBe("no");
    expect(displayFormula?.textContent).toContain("\\text{softmax}");
    const inlineMaths = Array.from(holder.querySelectorAll("code.reader-inline-math"));
    expect(inlineMaths).toHaveLength(3);
    expect(inlineMaths.every((el) => el.getAttribute("translate") === "no")).toBe(true);
    expect(holder.querySelector("pre")?.getAttribute("translate")).toBe("no");
    expect(holder.querySelectorAll("table td")).toHaveLength(2);
  });

  it("sanitizes HTML scripts while preserving MathML equations", () => {
    const html = `
      <html><head><title>Paper</title></head><body>
        <script>window.pwned = true;</script>
        <p>Energy satisfies <math><mi>E</mi><mo>=</mo><mi>m</mi><msup><mi>c</mi><mn>2</mn></msup></math>.</p>
        <a href="javascript:alert(1)">Bad link</a>
      </body></html>
    `;
    const parsed = parseHtmlFileDocument(document, html);
    const holder = document.createElement("div");
    holder.append(parsed.fragment);
    expect(holder.querySelector("script")).toBeNull();
    expect(holder.querySelector("a")?.getAttribute("href")).toBeNull();
    expect(parsed.formulaCount).toBe(1);
    const math = holder.querySelector("math");
    expect(math?.getAttribute("translate")).toBe("no");
    expect(math?.textContent).toBe("E=mc2");
  });

  it("unpacks DOCX ZIP archive locally and preserves headings, tables, and Office Math formulas", async () => {
    const docxXml = `<?xml version="1.0" encoding="UTF-8"?>
      <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
                  xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math">
        <w:body>
          <w:p>
            <w:pPr><w:pStyle w:val="Heading1"/></w:pPr>
            <w:r><w:t>Local Translation Paper</w:t></w:r>
          </w:p>
          <w:p>
            <w:r><w:t>Given learning rate </w:t></w:r>
            <m:oMath><m:r><m:t>α = 0.001</m:t></m:r></m:oMath>
            <w:r><w:t>, the loss converges.</w:t></w:r>
          </w:p>
          <w:p>
            <m:oMathPara><m:oMath><m:f><m:num><m:r><m:t>1</m:t></m:r></m:num><m:den><m:r><m:t>N</m:t></m:r></m:den></m:f></m:oMath></m:oMathPara>
          </w:p>
        </w:body>
      </w:document>`;

    const zipBuf = buildStoredZip({ "word/document.xml": docxXml });
    const archive = ZipArchive.open(zipBuf);
    expect(archive.has("word/document.xml")).toBe(true);

    const parsed = await parseDocxDocument(document, zipBuf, "paper.docx");
    expect(parsed.title).toBe("Local Translation Paper");
    expect(parsed.formulaCount).toBe(2);

    const holder = document.createElement("div");
    holder.append(parsed.fragment);
    expect(holder.querySelector("h1")?.textContent).toBe("Local Translation Paper");
    expect(holder.querySelector("code.reader-inline-math")?.textContent).toBe("α = 0.001");
    expect(holder.querySelector(".reader-formula")?.textContent).toBe("(1)/(N)");
  });
});

describe("PDF layout & formula-preserving block extraction", () => {
  const mkItem = (
    str: string,
    x: number,
    yTop: number,
    fontSize: number,
    width: number,
    fontName = "Helvetica",
    pageHeight = 842,
  ): PdfRawTextItem => ({
    str,
    transform: [fontSize, 0, 0, fontSize, x, pageHeight - yTop],
    width,
    height: fontSize,
    fontName,
  });

  it("orders 2-column academic papers cleanly, repairs soft hyphenation, filters page numbers, and protects formulas", () => {
    const W = 595;
    const H = 842;
    const items: PdfRawTextItem[] = [
      // Full-width title
      mkItem("Neural Machine Translation Without Cloud Servers", 90, 68, 18, 410, "Helvetica-Bold"),
      // Left column (x ~ 50..275)
      mkItem("1. Introduction", 50, 120, 13, 100, "Helvetica-Bold"),
      mkItem("Local translation enables private trans-", 50, 144, 10.5, 215),
      mkItem("formation of technical documents with", 50, 158, 10.5, 210),
      mkItem("complexity ", 50, 172, 10.5, 58),
      mkItem("O(n log n)", 110, 172, 10.5, 52, "CMMI10"),
      mkItem(" per paragraph.", 164, 172, 10.5, 78),
      // Display equation in left column
      mkItem("Attention(Q, K, V) = softmax(QK^T / √d_k) V   (1)", 58, 204, 10.5, 210, "CMMI10"),
      mkItem("Extra left column sentence one.", 50, 232, 10.5, 195),
      mkItem("Extra left column sentence two.", 50, 246, 10.5, 195),
      mkItem("Extra left column sentence three.", 50, 260, 10.5, 195),
      // Right column (x ~ 318..545)
      mkItem("2. Experiments", 318, 120, 13, 105, "Helvetica-Bold"),
      mkItem("We evaluate across 103 directional pairs.", 318, 144, 10.5, 215),
      mkItem("Every language pack is verified offline.", 318, 158, 10.5, 210),
      mkItem("Latency stays below 40ms per segment.", 318, 172, 10.5, 205),
      mkItem("Memory footprint remains compact.", 318, 186, 10.5, 195),
      mkItem("Right column closing remark.", 318, 200, 10.5, 185),
      mkItem("Right column final note.", 318, 214, 10.5, 180),
      // Bottom page number (should be filtered)
      mkItem("- 1 -", 285, 818, 9, 24),
    ];

    const blocks = extractPdfPageBlocks(items, undefined, W, H, 1);
    const texts = blocks.map((b) => b.plainText);

    // 1. Page number filtered out
    expect(texts.some((t) => t === "- 1 -")).toBe(false);
    // 2. Full-width title first, then left column, then right column!
    expect(blocks[0]!.kind).toBe("heading");
    expect(blocks[0]!.column).toBe("full");
    const introIdx = texts.findIndex((t) => t.includes("1. Introduction"));
    const expIdx = texts.findIndex((t) => t.includes("2. Experiments"));
    expect(introIdx).toBeGreaterThan(0);
    expect(expIdx).toBeGreaterThan(introIdx);

    // 3. Soft hyphenation repaired: "trans-" + "formation" -> "transformation"
    const introPara = blocks.find((b) => b.plainText.includes("transformation"));
    expect(introPara).toBeTruthy();
    expect(introPara!.segments.some((s) => s.kind === "math" && s.text.includes("O(n log n)"))).toBe(true);

    // 4. Display equation isolated as non-translatable formula block
    const formulaBlock = blocks.find((b) => b.kind === "formula");
    expect(formulaBlock).toBeTruthy();
    expect(formulaBlock!.plainText).toContain("Attention(Q, K, V)");
  });

  it("handles centered multi-line headers, opaque subset font headings, and Unicode superscript/subscript equations", () => {
    const W = 595;
    const H = 842;
    const items: PdfRawTextItem[] = [
      // Two centered header lines crossing the middle gutter
      mkItem("Sparse Local Attention for Document Translation", 110, 62, 16, 375, "g_d0_f1"),
      mkItem("A. Lin, B. Chen · Systems Research", 190, 84, 9.5, 215, "g_d0_f2"),
      // Left column (x ~ 48..275)
      mkItem("Abstract", 48, 122, 11.5, 48, "g_d0_f1"),
      mkItem("Modern browser extensions run neural translation locally.", 48, 140, 10.5, 220, "g_d0_f3"),
      mkItem("Multi-column documents require layout reconstruction.", 48, 155, 10.5, 215, "g_d0_f3"),
      mkItem("1. Introduction", 48, 182, 11.5, 82, "g_d0_f1"),
      mkItem("Academic PDFs place prose in two narrow columns.", 48, 200, 10.5, 215, "g_d0_f3"),
      mkItem("Naive extraction scrambles cross-column order.", 48, 215, 10.5, 210, "g_d0_f3"),
      // Right column (x ~ 318..545)
      mkItem("2. Formulation", 318, 122, 11.5, 82, "g_d0_f1"),
      mkItem("Scaled dot-product attention is defined as:", 318, 140, 10.5, 215, "g_d0_f3"),
      mkItem("Attention(Q, K, V) = softmax(QKᵀ / √dₖ) V  (1)", 330, 168, 10.5, 200, "g_d0_f3"),
      mkItem("This preserves exact algebraic notation.", 318, 196, 10.5, 210, "g_d0_f3"),
      mkItem("Evaluation confirms 99.4% retention.", 318, 211, 10.5, 200, "g_d0_f3"),
      // Bottom page number at ~92% height (standard A4 footer margin)
      mkItem("1", 294, 785, 9, 8, "g_d0_f3"),
    ];

    const blocks = extractPdfPageBlocks(items, undefined, W, H, 1);
    const texts = blocks.map((b) => b.plainText);
    expect(texts.includes("1")).toBe(false);
    expect(blocks.find((b) => b.plainText === "Abstract")?.kind).toBe("heading");
    const introIdx = texts.findIndex((t) => t === "1. Introduction");
    const formIdx = texts.findIndex((t) => t === "2. Formulation");
    expect(introIdx).toBeGreaterThan(0);
    expect(formIdx).toBeGreaterThan(introIdx);
    const eqBlock = blocks.find((b) => b.kind === "formula");
    expect(eqBlock?.plainText).toContain("QKᵀ / √dₖ");
  });
});
