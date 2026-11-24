import { afterEach, describe, expect, it } from "vitest";
import { PageTranslator } from "../src/core/page-translator";
import type { TranslationRequest } from "../src/core/provider";
import {
  parseDocxDocument,
  parseEpubDocument,
  parseHtmlFileDocument,
  parseMarkdownDocument,
} from "../src/reader/document-parsers";
import { extractPdfPageBlocks, type PdfFontStyleInfo, type PdfRawTextItem } from "../src/reader/pdf-layout";
import { ZipArchive } from "../src/reader/zip-reader";

afterEach(() => document.body.replaceChildren());

/** Builds a minimal uncompressed (STORE) valid ZIP ArrayBuffer for unit testing ZipArchive / DOCX / EPUB. */
function buildStoredZip(files: Record<string, string | Uint8Array>): ArrayBuffer {
  const enc = new TextEncoder();
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;

  for (const [name, content] of Object.entries(files)) {
    const nameBytes = enc.encode(name);
    const dataBytes = content instanceof Uint8Array ? content : enc.encode(content);
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

const TINY_PNG_BYTES = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
  0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
]);

describe("document parsers with MathML rendering, structure & formula protection", () => {
  it("parses Markdown with LaTeX environments, MathML output, tables, code blocks, and currency-safe dollar handling", () => {
    const md = [
      "# Attention Mechanisms",
      "",
      "Cloud GPUs cost between $100 and $200 while complexity is $O(n^2 \\cdot d)$ for sequence length $n$.",
      "",
      "$$",
      "\\text{Attention}(Q, K, V) = \\text{softmax}\\left(\\frac{QK^T}{\\sqrt{d_k}}\\right)V",
      "$$",
      "",
      "\\begin{align}",
      "y &= \\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix} x \\\\",
      "f(x) &= \\begin{cases} x & x \\ge 0 \\\\ 0 & x < 0 \\end{cases}",
      "\\end{align}",
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
    expect(parsed.formulaCount).toBe(5);

    const holder = document.createElement("div");
    holder.append(parsed.fragment);

    // Currency "$100 and $200" must remain plain prose text, NOT swallowed as inline math
    const firstP = holder.querySelector("p")!;
    expect(firstP.textContent).toContain("$100 and $200");

    const displayFormulas = Array.from(holder.querySelectorAll(".reader-formula"));
    expect(displayFormulas).toHaveLength(2);
    expect(displayFormulas[0]?.getAttribute("translate")).toBe("no");
    expect(displayFormulas[0]?.getAttribute("data-latex")).toContain("\\text{softmax}");
    expect(displayFormulas[0]?.querySelector("math mfrac")).toBeTruthy();
    expect(displayFormulas[0]?.querySelector("math msqrt")).toBeTruthy();
    // \begin{align} with nested pmatrix & cases produces MathML <mtable>
    expect(displayFormulas[1]?.querySelectorAll("math mtable").length).toBeGreaterThanOrEqual(2);

    const inlineMaths = Array.from(holder.querySelectorAll(".reader-inline-math"));
    expect(inlineMaths).toHaveLength(3);
    expect(inlineMaths.every((el) => el.getAttribute("translate") === "no" && el.querySelector("math") !== null)).toBe(true);
    expect(holder.querySelector("pre")?.getAttribute("translate")).toBe("no");
    expect(holder.querySelectorAll("table td")).toHaveLength(2);
  });

  it("sanitizes HTML scripts, renders KaTeX annotations to MathML, and preserves inline <math> in bilingual translation", async () => {
    const html = `
      <html><head><title>Paper</title></head><body>
        <script>window.pwned = true;</script>
        <p>Energy satisfies <math><mi>E</mi><mo>=</mo><mi>m</mi><msup><mi>c</mi><mn>2</mn></msup></math> everywhere.</p>
        <p>Flux obeys <span class="katex"><annotation encoding="application/x-tex">\\frac{\\rho}{\\varepsilon_0}</annotation></span> locally.</p>
        <a href="javascript:alert(1)">Bad link</a>
      </body></html>
    `;
    const parsed = parseHtmlFileDocument(document, html);
    const holder = document.createElement("div");
    holder.append(parsed.fragment);
    document.body.append(holder);

    expect(holder.querySelector("script")).toBeNull();
    expect(holder.querySelector("a")?.getAttribute("href")).toBeNull();
    expect(parsed.formulaCount).toBe(2);
    expect(holder.querySelector("math msup")).toBeTruthy();
    expect(holder.querySelector(".reader-inline-math math mfrac")).toBeTruthy();

    // Translate in bilingual mode: inline MathML must remain protected as opaque tokens AND survive in bilingual output!
    const requests: string[] = [];
    const translator = new PageTranslator(
      document,
      {
        prefersWholeSentenceHtml: async () => true,
        translateHtml: async (req: TranslationRequest) => {
          requests.push(req.html);
          return req.html
            .replace("Energy satisfies", "能量满足")
            .replace("everywhere.", "在各处。")
            .replace("Flux obeys", "通量遵循")
            .replace("locally.", "在局部。");
        },
      },
      { displayMode: "bilingual" },
    );
    await translator.translateAll(holder, true);
    expect(requests.some((h) => h.includes("__FLT_OPAQUE_0__"))).toBe(true);
    const translations = Array.from(holder.querySelectorAll('[data-flt-generated="translation"]'));
    expect(translations.length).toBeGreaterThanOrEqual(2);
    expect(translations[0]?.querySelector("math msup")).toBeTruthy();
    expect(translations[0]?.textContent).toContain("能量满足");
    expect(translations[1]?.querySelector("math mfrac")).toBeTruthy();
    translator.restore();
  });

  it("unpacks DOCX ZIP locally and converts complex Office Math (fractions, radicals, integrals, matrices) to MathML plus images", async () => {
    const docxXml = `<?xml version="1.0" encoding="UTF-8"?>
      <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
                  xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"
                  xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
                  xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
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
            <m:oMathPara><m:oMath>
              <m:f>
                <m:num><m:rad><m:radPr><m:degHide m:val="1"/></m:radPr><m:deg/><m:e><m:r><m:t>x</m:t></m:r></m:e></m:rad></m:num>
                <m:den><m:r><m:t>N</m:t></m:r></m:den>
              </m:f>
            </m:oMath></m:oMathPara>
          </w:p>
          <w:p>
            <m:oMathPara><m:oMath>
              <m:nary>
                <m:naryPr><m:chr m:val="∫"/></m:naryPr>
                <m:sub><m:r><m:t>0</m:t></m:r></m:sub>
                <m:sup><m:r><m:t>1</m:t></m:r></m:sup>
                <m:e><m:m><m:mr><m:e><m:r><m:t>a</m:t></m:r></m:e><m:e><m:r><m:t>b</m:t></m:r></m:e></m:mr></m:m></m:e>
              </m:nary>
            </m:oMath></m:oMathPara>
          </w:p>
          <w:p><w:r><w:drawing><a:blip r:embed="rId1"/></w:drawing><w:t>Diagram note.</w:t></w:r></w:p>
        </w:body>
      </w:document>`;
    const relsXml = `<?xml version="1.0" encoding="UTF-8"?>
      <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
        <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/fig1.png"/>
      </Relationships>`;

    const zipBuf = buildStoredZip({
      "word/document.xml": docxXml,
      "word/_rels/document.xml.rels": relsXml,
      "word/media/fig1.png": TINY_PNG_BYTES,
    });
    const archive = ZipArchive.open(zipBuf);
    expect(archive.has("word/document.xml")).toBe(true);

    const parsed = await parseDocxDocument(document, zipBuf, "paper.docx");
    expect(parsed.title).toBe("Local Translation Paper");
    expect(parsed.formulaCount).toBe(3);

    const holder = document.createElement("div");
    holder.append(parsed.fragment);
    expect(holder.querySelector("h1")?.textContent).toBe("Local Translation Paper");
    expect(holder.querySelector(".reader-inline-math math")?.textContent).toBe("α=0.001");
    expect(holder.querySelector(".reader-formula math mfrac msqrt")).toBeTruthy();
    expect(holder.querySelector(".reader-formula math msubsup")).toBeTruthy();
    expect(holder.querySelector(".reader-formula math mtable")).toBeTruthy();
    const img = holder.querySelector<HTMLImageElement>("img.reader-doc-image");
    expect(img?.src.startsWith("data:image/png;base64,")).toBe(true);
  });

  it("unpacks EPUB chapters with MathML, KaTeX equations, and embedded local images", async () => {
    const epubBuf = buildStoredZip({
      "META-INF/container.xml": `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`,
      "OEBPS/content.opf": `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Book</dc:title></metadata><manifest><item id="ch1" href="text/ch1.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="ch1"/></spine></package>`,
      "OEBPS/text/ch1.xhtml": `<html><body><h1>Chapter 1</h1><p>Signal <math><mi>f</mi><mo>(</mo><mi>t</mi><mo>)</mo></math>.</p><img src="../images/fig.png" alt="Wave"/></body></html>`,
      "OEBPS/images/fig.png": TINY_PNG_BYTES,
    });
    const parsed = await parseEpubDocument(document, epubBuf, "book.epub");
    const holder = document.createElement("div");
    holder.append(parsed.fragment);
    expect(parsed.formulaCount).toBe(1);
    expect(holder.querySelector("math")).toBeTruthy();
    expect(holder.querySelector<HTMLImageElement>("img.reader-doc-image")?.src.startsWith("data:image/png;base64,")).toBe(true);
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

    expect(texts.some((t) => t === "- 1 -")).toBe(false);
    expect(blocks[0]!.kind).toBe("heading");
    expect(blocks[0]!.column).toBe("full");
    const introIdx = texts.findIndex((t) => t.includes("1. Introduction"));
    const expIdx = texts.findIndex((t) => t.includes("2. Experiments"));
    expect(introIdx).toBeGreaterThan(0);
    expect(expIdx).toBeGreaterThan(introIdx);

    const introPara = blocks.find((b) => b.plainText.includes("transformation"));
    expect(introPara).toBeTruthy();
    expect(introPara!.segments.some((s) => s.kind === "math" && s.text.includes("O(n log n)"))).toBe(true);

    const formulaBlock = blocks.find((b) => b.kind === "formula");
    expect(formulaBlock).toBeTruthy();
    expect(formulaBlock!.plainText).toContain("Attention(Q, K, V)");
  });

  it("handles centered multi-line headers, opaque subset font headings, and Unicode superscript/subscript equations", () => {
    const W = 595;
    const H = 842;
    const items: PdfRawTextItem[] = [
      mkItem("Sparse Local Attention for Document Translation", 110, 62, 16, 375, "g_d0_f1"),
      mkItem("A. Lin, B. Chen · Systems Research", 190, 84, 9.5, 215, "g_d0_f2"),
      mkItem("Abstract", 48, 122, 11.5, 48, "g_d0_f1"),
      mkItem("Modern browser extensions run neural translation locally.", 48, 140, 10.5, 220, "g_d0_f3"),
      mkItem("Multi-column documents require layout reconstruction.", 48, 155, 10.5, 215, "g_d0_f3"),
      mkItem("1. Introduction", 48, 182, 11.5, 82, "g_d0_f1"),
      mkItem("Academic PDFs place prose in two narrow columns.", 48, 200, 10.5, 215, "g_d0_f3"),
      mkItem("Naive extraction scrambles cross-column order.", 48, 215, 10.5, 210, "g_d0_f3"),
      mkItem("2. Formulation", 318, 122, 11.5, 82, "g_d0_f1"),
      mkItem("Scaled dot-product attention is defined as:", 318, 140, 10.5, 215, "g_d0_f3"),
      mkItem("Attention(Q, K, V) = softmax(QKᵀ / √dₖ) V  (1)", 330, 168, 10.5, 200, "g_d0_f3"),
      mkItem("This preserves exact algebraic notation.", 318, 196, 10.5, 210, "g_d0_f3"),
      mkItem("Evaluation confirms 99.4% retention.", 318, 211, 10.5, 200, "g_d0_f3"),
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

  it("attaches superscripts/subscripts inline, merges 2D fractions/matrices and multi-line bullets, filters arXiv stamps & LaTeXiT metadata, and resolves realFontName", () => {
    const W = 612;
    const H = 792;
    const styles: Record<string, PdfFontStyleInfo> = {
      g_f_body: { fontFamily: "sans-serif", realFontName: "LNIZNM+CMR10" },
      g_f_math: { fontFamily: "sans-serif", realFontName: "YQTIJC+CMMI10" },
      g_f_sym: { fontFamily: "sans-serif", realFontName: "ODXXXX+CMSY10" },
      g_f_sub: { fontFamily: "sans-serif", realFontName: "WEQCBI+CMMI7" },
      g_f_bold: { fontFamily: "sans-serif", realFontName: "FTPGGO+CMBX12" },
    };

    const items: PdfRawTextItem[] = [
      // Rotated 90-deg arXiv stamp along left margin (must be ignored)
      { str: "arXiv:1906.08270v1 [cond-mat] 19 Jun 2019", transform: [0, 18, -18, 0, 32, 220], width: 280, height: 18, fontName: "g_f_body" },
      // Embedded LaTeXiT invisible metadata (must be ignored)
      mkItem('<latexit sha1_base64="XVzP503G8Ma8Lkwk3KKGZcZJbZ0=">AAACEnicbVC7SgNBFJ</latexit>', 200, 60, 8, 120, "g_f_body", H),
      // Prose line with inline superscript (must stay inside paragraph, not spawn orphan "2" block!)
      mkItem("Standard attention requires O(N", 72, 120, 10, 155, "g_f_body", H),
      mkItem("2", 227, 116, 6.8, 5, "g_f_sub", H),
      mkItem(") memory in practice.", 233, 120, 10, 110, "g_f_body", H),
      // Stacked 2D display fraction (numerator + main line + denominator -> 1 formula block!)
      mkItem("QK", 350, 154, 10, 16, "g_f_math", H),
      mkItem("T", 366, 150, 6.8, 5, "g_f_sub", H),
      mkItem("Attention(Q, K, V) = softmax(", 200, 161, 10, 145, "g_f_body", H),
      mkItem(") V   (1)", 378, 161, 10, 120, "g_f_body", H),
      mkItem("√d", 352, 170, 10, 14, "g_f_sym", H),
      mkItem("k", 366, 173, 6.8, 5, "g_f_sub", H),
      // Prose paragraph immediately after fraction (must NOT swallow "dk"!)
      mkItem("The scaling factor prevents vanishing gradients.", 72, 194, 10, 240, "g_f_body", H),
      // Multi-line bullet list item (hanging indent continuation must merge into 1 list-item!)
      mkItem("• In encoder-decoder attention layers, the queries", 96, 224, 10, 230, "g_f_body", H),
      mkItem("come from the previous decoder layer.", 105, 237, 10, 190, "g_f_body", H),
    ];

    const blocks = extractPdfPageBlocks(items, styles, W, H, 1);
    const texts = blocks.map((b) => b.plainText);

    expect(texts.some((t) => t.includes("arXiv:"))).toBe(false);
    expect(texts.some((t) => t.includes("latexit"))).toBe(false);
    // No orphan "2" or "T" or "k" paragraph blocks
    expect(texts.some((t) => t === "2" || t === "T" || t === "k")).toBe(false);

    // CMR10 prose was NOT misclassified as math/heading
    const firstPara = blocks[0]!;
    expect(firstPara.kind).toBe("paragraph");
    expect(firstPara.plainText).toContain("Standard attention requires");
    expect(firstPara.plainText).toContain("memory in practice.");

    // 2D fraction collapsed into a single formula block and did not leak into next paragraph
    const formulaBlocks = blocks.filter((b) => b.kind === "formula");
    expect(formulaBlocks).toHaveLength(1);
    expect(formulaBlocks[0]!.plainText).toContain("Attention(Q, K, V)");
    expect(formulaBlocks[0]!.plainText).toContain("QK");

    const afterEq = blocks.find((b) => b.plainText.includes("vanishing gradients"));
    expect(afterEq?.kind).toBe("paragraph");
    expect(afterEq?.plainText.startsWith("The scaling factor")).toBe(true);

    // Multi-line bullet merged cleanly into 1 list-item
    const listItems = blocks.filter((b) => b.kind === "list-item");
    expect(listItems).toHaveLength(1);
    expect(listItems[0]!.plainText).toContain("previous decoder layer.");
  });
});
