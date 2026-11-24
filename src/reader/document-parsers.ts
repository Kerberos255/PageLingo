import { parseHtmlDocument } from "../shared/html-parser";
import { MATHML_NS, latexToMathMl, ommlToMathMl } from "./math-renderer";
import { ZipArchive } from "./zip-reader";

export interface ParsedDocumentTocItem {
  id: string;
  label: string;
  level: number;
}

export interface ParsedDocumentResult {
  title: string;
  kind: "markdown" | "html" | "epub" | "docx" | "text";
  fragment: DocumentFragment;
  toc: ParsedDocumentTocItem[];
  formulaCount: number;
}

const SAFE_HTML_TAGS = new Set([
  "ARTICLE", "SECTION", "MAIN", "HEADER", "FOOTER", "NAV", "ASIDE", "DIV", "P",
  "H1", "H2", "H3", "H4", "H5", "H6",
  "UL", "OL", "LI", "DL", "DT", "DD",
  "BLOCKQUOTE", "PRE", "CODE", "KBD", "SAMP", "VAR",
  "TABLE", "THEAD", "TBODY", "TFOOT", "TR", "TH", "TD", "CAPTION",
  "A", "SPAN", "STRONG", "B", "EM", "I", "U", "S", "DEL", "INS", "MARK", "SMALL", "SUB", "SUP", "ABBR", "Q", "CITE", "TIME", "BR", "HR",
  "FIGURE", "FIGCAPTION", "DETAILS", "SUMMARY", "IMG",
  "MATH", "MI", "MO", "MN", "MS", "MTEXT", "MROW", "MFRAC", "MSQRT", "MROOT", "MSUP", "MSUB", "MSUBSUP", "MUNDER", "MOVER", "MUNDEROVER", "MTABLE", "MTR", "MTD", "MFENCED", "MPADDED", "MSPACE", "SEMANTICS", "ANNOTATION",
]);

const MATHML_TAGS = new Set([
  "MATH", "MI", "MO", "MN", "MS", "MTEXT", "MROW", "MFRAC", "MSQRT", "MROOT",
  "MSUP", "MSUB", "MSUBSUP", "MUNDER", "MOVER", "MUNDEROVER", "MTABLE", "MTR",
  "MTD", "MFENCED", "MPADDED", "MSPACE", "SEMANTICS", "ANNOTATION",
]);

const SAFE_IMAGE_EXT_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
};

const BLOCK_LATEX_ENV_RE = /^\\begin\{(equation\*?|align\*?|aligned|gather\*?|multline\*?|cases|dcases|pmatrix|bmatrix|Bmatrix|vmatrix|Vmatrix)\}/;

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const slice = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
}

function imageMimeForPath(filePath: string): string | null {
  const clean = filePath.split(/[?#]/)[0] ?? "";
  const ext = clean.includes(".") ? clean.slice(clean.lastIndexOf(".") + 1).toLowerCase() : "";
  return SAFE_IMAGE_EXT_MIME[ext] ?? null;
}

function safeImageSrc(raw: string | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (/^data:image\/(?:png|jpeg|jpg|gif|webp|avif);base64,[A-Za-z0-9+/=\s]+$/i.test(trimmed)) {
    return trimmed;
  }
  try {
    const parsed = new URL(trimmed, "https://pagelingo.invalid/");
    if ((parsed.protocol === "https:" || parsed.protocol === "http:") && parsed.origin !== "https://pagelingo.invalid") {
      return trimmed;
    }
  } catch {
    return null;
  }
  return null;
}

function safeHref(raw: string | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("#")) return trimmed;
  try {
    const parsed = new URL(trimmed, "https://pagelingo.invalid/");
    if (parsed.protocol === "http:" || parsed.protocol === "https:" || parsed.protocol === "mailto:") {
      return trimmed;
    }
  } catch {
    return null;
  }
  return null;
}

function isProtectedMathElement(el: Element): boolean {
  const tag = el.tagName.toUpperCase();
  if (tag === "MATH" || tag === "MJX-CONTAINER") return true;
  const cls = typeof el.className === "string" ? el.className : "";
  return /\b(?:katex|katex-display|MathJax|math-inline|math-display|equation)\b/i.test(cls);
}

function createDisplayFormulaBox(doc: Document, mathEl: Element, latexSource?: string): HTMLElement {
  const block = doc.createElement("div");
  block.className = "reader-formula";
  block.setAttribute("translate", "no");
  if (latexSource) block.setAttribute("data-latex", latexSource);
  block.append(mathEl);
  return block;
}

function createInlineFormulaSpan(doc: Document, mathEl: Element, latexSource?: string): HTMLElement {
  const span = doc.createElement("span");
  span.className = "reader-inline-math";
  span.setAttribute("translate", "no");
  span.setAttribute("data-flt-fixed", "formula");
  if (latexSource) span.setAttribute("data-latex", latexSource);
  span.append(mathEl);
  return span;
}

function sanitizeMathChild(doc: Document, source: Node): Node | null {
  if (source.nodeType === Node.TEXT_NODE) {
    return doc.createTextNode(source.textContent ?? "");
  }
  if (source.nodeType !== Node.ELEMENT_NODE) return null;
  const el = source as Element;
  const tag = el.tagName.toUpperCase();
  // Drop raw TeX <annotation> children when cloning native MathML so browsers don't show duplicate TeX text.
  if (tag === "ANNOTATION") return null;
  if (!MATHML_TAGS.has(tag)) return doc.createTextNode(el.textContent ?? "");
  const out = doc.createElementNS(MATHML_NS, tag.toLowerCase());
  for (const attrName of ["mathvariant", "display", "stretchy", "linethickness", "columnalign", "rowalign"]) {
    const val = el.getAttribute(attrName);
    if (val) out.setAttribute(attrName, val);
  }
  for (const child of Array.from(el.childNodes)) {
    const imported = sanitizeMathChild(doc, child);
    if (imported) out.append(imported);
  }
  return out;
}

function cloneSafeMathMl(doc: Document, mathSource: Element): Element {
  const mathEl = doc.createElementNS(MATHML_NS, "math");
  mathEl.setAttribute("translate", "no");
  mathEl.setAttribute("data-flt-fixed", "formula");
  const display = mathSource.getAttribute("display");
  if (display === "block" || display === "inline") mathEl.setAttribute("display", display);
  for (const child of Array.from(mathSource.childNodes)) {
    const imported = sanitizeMathChild(doc, child);
    if (imported) mathEl.append(imported);
  }
  return mathEl;
}

function sanitizeImportNode(
  doc: Document,
  source: Node,
  state: { formulaCount: number },
  resolveImage?: (rawSrc: string) => string | null,
): Node | null {
  if (source.nodeType === Node.TEXT_NODE) {
    return doc.createTextNode(source.textContent ?? "");
  }
  if (source.nodeType !== Node.ELEMENT_NODE) return null;
  const el = source as Element;
  const tag = el.tagName.toUpperCase();
  if (["SCRIPT", "STYLE", "NOSCRIPT", "IFRAME", "OBJECT", "EMBED", "FORM", "INPUT", "BUTTON", "META", "LINK", "TITLE", "HEAD"].includes(tag)) {
    return null;
  }

  if (isProtectedMathElement(el)) {
    state.formulaCount += 1;
    if (tag === "MATH") {
      return cloneSafeMathMl(doc, el);
    }
    const cls = typeof el.className === "string" ? el.className : "";
    const isDisplay = /\b(?:display|block|equation)\b/i.test(cls)
      || el.getAttribute("display") === "block"
      || el.getAttribute("display") === "true";

    // Prefer TeX annotation (KaTeX / MathJax) -> crisp native MathML, or embedded native <math>
    const texAnnotation = el.querySelector('annotation[encoding*="tex" i]')?.textContent?.trim()
      ?? el.querySelector("annotation")?.textContent?.trim();
    if (texAnnotation) {
      const mathEl = latexToMathMl(doc, texAnnotation, isDisplay);
      return isDisplay
        ? createDisplayFormulaBox(doc, mathEl, texAnnotation)
        : createInlineFormulaSpan(doc, mathEl, texAnnotation);
    }

    const nestedMath = el.querySelector("math");
    if (nestedMath) {
      const mathEl = cloneSafeMathMl(doc, nestedMath);
      if (isDisplay) {
        mathEl.setAttribute("display", "block");
        return createDisplayFormulaBox(doc, mathEl);
      }
      return createInlineFormulaSpan(doc, mathEl);
    }

    const formulaText = (el.textContent ?? "").replace(/\s+/g, " ").trim();
    if (!formulaText) return null;
    const mathEl = latexToMathMl(doc, formulaText, isDisplay);
    return isDisplay
      ? createDisplayFormulaBox(doc, mathEl, formulaText)
      : createInlineFormulaSpan(doc, mathEl, formulaText);
  }

  if (tag === "IMG") {
    const rawSrc = el.getAttribute("src");
    const resolved = rawSrc ? (resolveImage?.(rawSrc) ?? safeImageSrc(rawSrc)) : null;
    if (!resolved) return null;
    const img = doc.createElement("img");
    img.src = resolved;
    const alt = el.getAttribute("alt");
    if (alt) img.alt = alt;
    img.className = "reader-doc-image";
    img.loading = "lazy";
    return img;
  }

  if (!SAFE_HTML_TAGS.has(tag)) {
    const frag = doc.createDocumentFragment();
    for (const child of Array.from(el.childNodes)) {
      const imported = sanitizeImportNode(doc, child, state, resolveImage);
      if (imported) frag.append(imported);
    }
    return frag;
  }

  const out = MATHML_TAGS.has(tag)
    ? doc.createElementNS(MATHML_NS, tag.toLowerCase())
    : doc.createElement(tag.toLowerCase());

  if (tag === "A") {
    const href = safeHref(el.getAttribute("href"));
    if (href) {
      out.setAttribute("href", href);
      if (!href.startsWith("#")) {
        out.setAttribute("target", "_blank");
        out.setAttribute("rel", "noopener noreferrer");
      }
    }
  }
  if (tag === "TD" || tag === "TH") {
    const colspan = el.getAttribute("colspan");
    const rowspan = el.getAttribute("rowspan");
    if (colspan && /^\d+$/.test(colspan)) out.setAttribute("colspan", colspan);
    if (rowspan && /^\d+$/.test(rowspan)) out.setAttribute("rowspan", rowspan);
  }
  if (tag === "PRE" || tag === "CODE") {
    out.setAttribute("translate", "no");
  }

  for (const child of Array.from(el.childNodes)) {
    const imported = sanitizeImportNode(doc, child, state, resolveImage);
    if (imported) out.append(imported);
  }
  return out;
}

/** Distinguishes real inline LaTeX `$x^2 + 1$` from currency spans like `$100 and $200`. */
function isLikelyCurrencyBetweenDollars(inner: string, fullText: string, matchStart: number, matchEnd: number): boolean {
  const trimmed = inner.trim();
  if (!trimmed) return true;
  // Backslash command or explicit math operator/script strongly indicates LaTeX
  if (/[\\^_{}=<>±×÷∑∫∂∇α-ωΑ-Ω]/.test(trimmed)) return false;
  // Trailing digit right after closing `$` (e.g. `$100 and $200` -> after closing `$` is `200`)
  const charAfter = fullText[matchEnd] ?? "";
  if (/[0-9]/.test(charAfter)) return true;
  // Preceded by word/digit without space (e.g. `US$10`)
  const charBefore = matchStart > 0 ? fullText[matchStart - 1]! : "";
  if (/[A-Za-z0-9]/.test(charBefore)) return true;
  // Starts with currency digits followed by prose words (e.g. `100 per month and `)
  if (/^\d[\d,.]*(?:\s*(?:k|m|b|million|billion|usd|eur|gbp|per|to|and|or|for|in|at|of|with|each|a|the)\b|\s+[a-z]{2,})/i.test(trimmed)) {
    return true;
  }
  // Multi-word lowercase English prose inside `$...$` with no math operators
  if (/\b[a-z]{3,}\s+[a-z]{3,}\b/.test(trimmed) && !/[+\-*/()[\]|]/.test(trimmed)) {
    return true;
  }
  return false;
}

function appendInlineMarkdown(
  doc: Document,
  parent: HTMLElement,
  text: string,
  state: { formulaCount: number },
): void {
  // Tokenize inline math ($...$, \(...\)), inline code (`...`), images ![alt](url), links [label](url), bold **...**, italic *...*
  const tokenRe = /(\\\([\s\S]+?\\\)|\$(?!\s)(?:\\\$|[^$\n])+?(?<!\s)\$|`[^`\n]+`|!\[[^\]]*\]\([^)]+\)|\[[^\]]+\]\([^)]+\)|\*\*[^*\n]+\*\*|\*[^*\n]+\*)/g;
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = tokenRe.exec(text)) !== null) {
    const raw = match[0];
    if (raw.startsWith("$") && raw.endsWith("$")) {
      const inner = raw.slice(1, -1);
      if (isLikelyCurrencyBetweenDollars(inner, text, match.index, match.index + raw.length)) {
        // Rewind regex right past the opening '$' so a later valid `$math$` on the same line still matches
        tokenRe.lastIndex = match.index + 1;
        continue;
      }
    }

    if (match.index > cursor) {
      parent.append(doc.createTextNode(text.slice(cursor, match.index)));
    }
    if ((raw.startsWith("$") && raw.endsWith("$")) || (raw.startsWith("\\(") && raw.endsWith("\\)"))) {
      const inner = raw.startsWith("$") ? raw.slice(1, -1).trim() : raw.slice(2, -2).trim();
      const mathEl = latexToMathMl(doc, inner, false);
      parent.append(createInlineFormulaSpan(doc, mathEl, inner));
      state.formulaCount += 1;
    } else if (raw.startsWith("`") && raw.endsWith("`")) {
      const code = doc.createElement("code");
      code.setAttribute("translate", "no");
      code.textContent = raw.slice(1, -1);
      parent.append(code);
    } else if (raw.startsWith("![")) {
      const imgMatch = raw.match(/^!\[([^\]]*)\]\(([^)]+)\)$/);
      const safeSrc = imgMatch ? safeImageSrc(imgMatch[2] ?? "") : null;
      if (imgMatch && safeSrc) {
        const img = doc.createElement("img");
        img.src = safeSrc;
        img.alt = imgMatch[1] ?? "";
        img.className = "reader-doc-image";
        img.loading = "lazy";
        parent.append(img);
      } else {
        parent.append(doc.createTextNode(raw));
      }
    } else if (raw.startsWith("[")) {
      const linkMatch = raw.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      if (linkMatch) {
        const href = safeHref(linkMatch[2] ?? "");
        const anchor = doc.createElement("a");
        anchor.textContent = linkMatch[1] ?? "";
        if (href) {
          anchor.setAttribute("href", href);
          if (!href.startsWith("#")) {
            anchor.setAttribute("target", "_blank");
            anchor.setAttribute("rel", "noopener noreferrer");
          }
        }
        parent.append(anchor);
      } else {
        parent.append(doc.createTextNode(raw));
      }
    } else if (raw.startsWith("**") && raw.endsWith("**")) {
      const strong = doc.createElement("strong");
      appendInlineMarkdown(doc, strong, raw.slice(2, -2), state);
      parent.append(strong);
    } else if (raw.startsWith("*") && raw.endsWith("*")) {
      const em = doc.createElement("em");
      appendInlineMarkdown(doc, em, raw.slice(1, -1), state);
      parent.append(em);
    }
    cursor = match.index + raw.length;
  }
  if (cursor < text.length) {
    parent.append(doc.createTextNode(text.slice(cursor)));
  }
}

export function parseMarkdownDocument(
  doc: Document,
  markdown: string,
  fallbackTitle = "Markdown 文档",
): ParsedDocumentResult {
  const fragment = doc.createDocumentFragment();
  const toc: ParsedDocumentTocItem[] = [];
  const state = { formulaCount: 0 };
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  let title = fallbackTitle;
  let headingIdx = 0;

  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();
    if (!trimmed) {
      i += 1;
      continue;
    }

    // Fenced code block
    const fenceMatch = trimmed.match(/^(`{3,}|~{3,})(.*)$/);
    if (fenceMatch) {
      const fence = fenceMatch[1]![0]!.repeat(fenceMatch[1]!.length);
      const codeLines: string[] = [];
      i += 1;
      while (i < lines.length && !(lines[i] ?? "").trim().startsWith(fence)) {
        codeLines.push(lines[i] ?? "");
        i += 1;
      }
      if (i < lines.length) i += 1;
      const pre = doc.createElement("pre");
      pre.setAttribute("translate", "no");
      const code = doc.createElement("code");
      code.textContent = codeLines.join("\n");
      pre.append(code);
      fragment.append(pre);
      continue;
    }

    // Display math block ($$...$$ or \[...\])
    if (trimmed.startsWith("$$") || trimmed.startsWith("\\[")) {
      const isBracket = trimmed.startsWith("\\[");
      const endToken = isBracket ? "\\]" : "$$";
      const mathLines: string[] = [];
      const strippedFirst = trimmed.slice(2);
      if (strippedFirst.endsWith(endToken) && strippedFirst.length >= endToken.length) {
        mathLines.push(strippedFirst.slice(0, -endToken.length).trim());
        i += 1;
      } else {
        if (strippedFirst.trim()) mathLines.push(strippedFirst.trim());
        i += 1;
        while (i < lines.length) {
          const nextTrim = (lines[i] ?? "").trim();
          if (nextTrim.endsWith(endToken)) {
            const before = nextTrim.slice(0, -endToken.length).trim();
            if (before) mathLines.push(before);
            i += 1;
            break;
          }
          mathLines.push(lines[i] ?? "");
          i += 1;
        }
      }
      const latexSource = mathLines.join("\n").trim();
      const mathEl = latexToMathMl(doc, latexSource, true);
      fragment.append(createDisplayFormulaBox(doc, mathEl, latexSource));
      state.formulaCount += 1;
      continue;
    }

    // Standalone LaTeX math environment (\begin{align}...\end{align}, \begin{equation}..., etc.)
    const envMatch = trimmed.match(BLOCK_LATEX_ENV_RE);
    if (envMatch) {
      const envName = envMatch[1]!;
      const endMarker = `\\end{${envName}}`;
      const envLines: string[] = [line];
      i += 1;
      if (!trimmed.includes(endMarker)) {
        while (i < lines.length) {
          const nextLine = lines[i] ?? "";
          envLines.push(nextLine);
          i += 1;
          if (nextLine.includes(endMarker)) break;
        }
      }
      const latexSource = envLines.join("\n").trim();
      const mathEl = latexToMathMl(doc, latexSource, true);
      fragment.append(createDisplayFormulaBox(doc, mathEl, latexSource));
      state.formulaCount += 1;
      continue;
    }

    // Headings
    const headingMatch = trimmed.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      const level = headingMatch[1]!.length;
      const text = headingMatch[2]!.replace(/\s+#+\s*$/, "").trim();
      const h = doc.createElement(`h${level}`);
      const id = `doc-h-${++headingIdx}`;
      h.id = id;
      appendInlineMarkdown(doc, h, text, state);
      fragment.append(h);
      if (level === 1 && title === fallbackTitle) title = text;
      if (level <= 3) toc.push({ id, label: text, level });
      i += 1;
      continue;
    }

    // Horizontal rule
    if (/^(?:[-*_]\s*){3,}$/.test(trimmed)) {
      fragment.append(doc.createElement("hr"));
      i += 1;
      continue;
    }

    // Markdown table
    if (
      trimmed.includes("|")
      && i + 1 < lines.length
      && /^\s*\|?[\s:-]+\|[\s|:-]*$/.test((lines[i + 1] ?? "").trim())
    ) {
      const splitRow = (row: string) => row.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
      const headers = splitRow(trimmed);
      i += 2;
      const table = doc.createElement("table");
      const thead = doc.createElement("thead");
      const headTr = doc.createElement("tr");
      for (const hCell of headers) {
        const th = doc.createElement("th");
        appendInlineMarkdown(doc, th, hCell, state);
        headTr.append(th);
      }
      thead.append(headTr);
      table.append(thead);

      const tbody = doc.createElement("tbody");
      while (i < lines.length && (lines[i] ?? "").trim().includes("|")) {
        const rowCells = splitRow(lines[i] ?? "");
        const tr = doc.createElement("tr");
        for (const cell of rowCells) {
          const td = doc.createElement("td");
          appendInlineMarkdown(doc, td, cell, state);
          tr.append(td);
        }
        tbody.append(tr);
        i += 1;
      }
      table.append(tbody);
      fragment.append(table);
      continue;
    }

    // Blockquote
    if (trimmed.startsWith(">")) {
      const quoteLines: string[] = [];
      while (i < lines.length && (lines[i] ?? "").trim().startsWith(">")) {
        quoteLines.push((lines[i] ?? "").trim().replace(/^>\s?/, ""));
        i += 1;
      }
      const bq = doc.createElement("blockquote");
      const p = doc.createElement("p");
      appendInlineMarkdown(doc, p, quoteLines.join(" ").trim(), state);
      bq.append(p);
      fragment.append(bq);
      continue;
    }

    // Unordered or ordered list
    const ulMatch = trimmed.match(/^[-*+]\s+(.+)$/);
    const olMatch = trimmed.match(/^\d+\.\s+(.+)$/);
    if (ulMatch || olMatch) {
      const isOrdered = Boolean(olMatch);
      const listEl = doc.createElement(isOrdered ? "ol" : "ul");
      const itemRe = isOrdered ? /^\d+\.\s+(.+)$/ : /^[-*+]\s+(.+)$/;
      while (i < lines.length) {
        const m = (lines[i] ?? "").trim().match(itemRe);
        if (!m) break;
        const li = doc.createElement("li");
        appendInlineMarkdown(doc, li, m[1]!.trim(), state);
        listEl.append(li);
        i += 1;
      }
      fragment.append(listEl);
      continue;
    }

    // Paragraph (join contiguous non-structural lines)
    const paraLines: string[] = [trimmed];
    i += 1;
    while (i < lines.length) {
      const next = (lines[i] ?? "").trim();
      if (
        !next
        || /^(?:#{1,6}\s|```|~~~|\$\$|\\\[|>|[-*+]\s|\d+\.\s|(?:[-*_]\s*){3,}$)/.test(next)
        || BLOCK_LATEX_ENV_RE.test(next)
      ) {
        break;
      }
      paraLines.push(next);
      i += 1;
    }
    const p = doc.createElement("p");
    appendInlineMarkdown(doc, p, paraLines.join(" "), state);
    fragment.append(p);
  }

  return { title, kind: "markdown", fragment, toc, formulaCount: state.formulaCount };
}

export function parseHtmlFileDocument(
  doc: Document,
  html: string,
  fallbackTitle = "HTML 文档",
): ParsedDocumentResult {
  const parsed = parseHtmlDocument(html);
  const title = parsed.title?.trim() || fallbackTitle;
  const sourceRoot = parsed.querySelector("article, main, [role='main']") ?? parsed.body;
  const fragment = doc.createDocumentFragment();
  const state = { formulaCount: 0 };
  for (const child of Array.from(sourceRoot.childNodes)) {
    const imported = sanitizeImportNode(doc, child, state);
    if (imported) fragment.append(imported);
  }
  const toc: ParsedDocumentTocItem[] = [];
  let idx = 0;
  for (const h of Array.from(fragment.querySelectorAll("h1, h2, h3"))) {
    const label = (h.textContent ?? "").replace(/\s+/g, " ").trim();
    if (!label) continue;
    const id = h.id || `doc-h-${++idx}`;
    h.id = id;
    toc.push({ id, label, level: Number.parseInt(h.tagName.slice(1), 10) || 2 });
  }
  return { title, kind: "html", fragment, toc, formulaCount: state.formulaCount };
}

function resolveZipPath(baseFile: string, relativePath: string): string {
  const cleanRel = relativePath.split(/[?#]/)[0] ?? "";
  const baseDir = baseFile.includes("/") ? baseFile.slice(0, baseFile.lastIndexOf("/") + 1) : "";
  const combined = (cleanRel.startsWith("/") ? cleanRel.slice(1) : baseDir + cleanRel).split("/");
  const stack: string[] = [];
  for (const seg of combined) {
    if (!seg || seg === ".") continue;
    if (seg === "..") stack.pop();
    else stack.push(seg);
  }
  return stack.join("/");
}

async function readZipImageDataUrl(zip: ZipArchive, entryPath: string, cache: Map<string, string | null>): Promise<string | null> {
  if (cache.has(entryPath)) return cache.get(entryPath) ?? null;
  const mime = imageMimeForPath(entryPath);
  if (!mime) {
    cache.set(entryPath, null);
    return null;
  }
  const bytes = await zip.readBytes(entryPath);
  if (!bytes || bytes.byteLength === 0 || bytes.byteLength > 8 * 1024 * 1024) {
    cache.set(entryPath, null);
    return null;
  }
  const url = `data:${mime};base64,${bytesToBase64(bytes)}`;
  cache.set(entryPath, url);
  return url;
}

export async function parseEpubDocument(
  doc: Document,
  buffer: ArrayBuffer,
  fallbackTitle = "EPUB 电子书",
): Promise<ParsedDocumentResult> {
  const zip = ZipArchive.open(buffer);
  const containerXml = await zip.readText("META-INF/container.xml");
  if (!containerXml) throw new Error("EPUB 缺少 META-INF/container.xml");

  const parser = new DOMParser();
  const containerDoc = parser.parseFromString(containerXml, "application/xml");
  const rootfile = containerDoc.querySelector("rootfile");
  const opfPath = rootfile?.getAttribute("full-path");
  if (!opfPath) throw new Error("EPUB 缺少 OPF 清单路径");

  const opfXml = await zip.readText(opfPath);
  if (!opfXml) throw new Error(`无法读取 EPUB 清单：${opfPath}`);
  const opfDoc = parser.parseFromString(opfXml, "application/xml");
  const title = opfDoc.querySelector("title")?.textContent?.trim() || fallbackTitle;

  const manifestMap = new Map<string, string>();
  for (const item of Array.from(opfDoc.querySelectorAll("manifest > item"))) {
    const id = item.getAttribute("id");
    const href = item.getAttribute("href");
    if (id && href) manifestMap.set(id, decodeURIComponent(href));
  }

  const spineIds = Array.from(opfDoc.querySelectorAll("spine > itemref"))
    .map((ref) => ref.getAttribute("idref"))
    .filter((id): id is string => Boolean(id));

  const fragment = doc.createDocumentFragment();
  const toc: ParsedDocumentTocItem[] = [];
  const state = { formulaCount: 0 };
  const imageCache = new Map<string, string | null>();

  let chapterNum = 0;
  for (const idref of spineIds) {
    const href = manifestMap.get(idref);
    if (!href) continue;
    const entryPath = resolveZipPath(opfPath, href);
    const chapterHtml = await zip.readText(entryPath);
    if (!chapterHtml) continue;
    const parsedChapter = parseHtmlDocument(chapterHtml);

    // Preload any local chapter images referenced by <img> so sanitization stays synchronous.
    const chapterImages = new Map<string, string>();
    for (const imgEl of Array.from(parsedChapter.body.querySelectorAll("img[src]"))) {
      const rawSrc = imgEl.getAttribute("src") ?? "";
      if (!rawSrc || /^https?:|^data:/i.test(rawSrc)) continue;
      const imgEntry = resolveZipPath(entryPath, decodeURIComponent(rawSrc));
      const dataUrl = await readZipImageDataUrl(zip, imgEntry, imageCache);
      if (dataUrl) chapterImages.set(rawSrc, dataUrl);
    }

    const section = doc.createElement("section");
    section.className = "reader-chapter";
    const sectionId = `epub-ch-${++chapterNum}`;
    section.id = sectionId;

    const resolveImage = (rawSrc: string) => chapterImages.get(rawSrc) ?? safeImageSrc(rawSrc);
    for (const child of Array.from(parsedChapter.body.childNodes)) {
      const imported = sanitizeImportNode(doc, child, state, resolveImage);
      if (imported) section.append(imported);
    }
    if (!(section.textContent ?? "").trim() && !section.querySelector("img,math")) continue;
    const firstHeading = section.querySelector("h1, h2, h3");
    const label = (firstHeading?.textContent ?? "").replace(/\s+/g, " ").trim() || `第 ${chapterNum} 节`;
    toc.push({ id: sectionId, label, level: 1 });
    fragment.append(section);
  }

  return { title, kind: "epub", fragment, toc, formulaCount: state.formulaCount };
}

function findBlipEmbedId(el: Element): string | null {
  for (const node of Array.from(el.getElementsByTagName("*"))) {
    if (node.localName !== "blip") continue;
    for (const attr of Array.from(node.attributes)) {
      if (attr.localName === "embed" || attr.name === "r:embed") return attr.value;
    }
  }
  return null;
}

export async function parseDocxDocument(
  doc: Document,
  buffer: ArrayBuffer,
  fallbackTitle = "Word 文档",
): Promise<ParsedDocumentResult> {
  const zip = ZipArchive.open(buffer);
  const documentXml = await zip.readText("word/document.xml");
  if (!documentXml) throw new Error("DOCX 缺少 word/document.xml");

  const parser = new DOMParser();
  const xmlDoc = parser.parseFromString(documentXml, "application/xml");
  const body = Array.from(xmlDoc.getElementsByTagName("*")).find((el) => el.localName === "body");
  if (!body) throw new Error("无法解析 DOCX 正文结构");

  // Load image relationships (word/_rels/document.xml.rels) for embedded figures & equation pictures
  const relImages = new Map<string, string>();
  const imageCache = new Map<string, string | null>();
  const relsXml = await zip.readText("word/_rels/document.xml.rels");
  if (relsXml) {
    const relsDoc = parser.parseFromString(relsXml, "application/xml");
    for (const rel of Array.from(relsDoc.getElementsByTagName("*")).filter((el) => el.localName === "Relationship")) {
      const id = rel.getAttribute("Id");
      const target = rel.getAttribute("Target");
      const type = rel.getAttribute("Type") ?? "";
      if (!id || !target || !type.toLowerCase().includes("image")) continue;
      const entryPath = resolveZipPath("word/document.xml", target);
      const dataUrl = await readZipImageDataUrl(zip, entryPath, imageCache);
      if (dataUrl) relImages.set(id, dataUrl);
    }
  }

  const fragment = doc.createDocumentFragment();
  const toc: ParsedDocumentTocItem[] = [];
  const state = { formulaCount: 0 };
  let title = fallbackTitle;
  let headingIdx = 0;

  const renderParagraph = (pEl: Element, container: DocumentFragment | HTMLElement): void => {
    const pPr = Array.from(pEl.children).find((c) => c.localName === "pPr");
    const pStyle = pPr
      ? (Array.from(pPr.children).find((c) => c.localName === "pStyle")?.getAttribute("w:val") ?? "")
      : "";
    const headingMatch = pStyle.match(/^Heading([1-6])$/i) ?? pStyle.match(/^([1-6])$/);
    const isTitle = /^Title$/i.test(pStyle);
    const isList = Boolean(pPr && Array.from(pPr.children).some((c) => c.localName === "numPr"));

    // Check if paragraph contains only display Office Math blocks (m:oMathPara)
    const directChildren = Array.from(pEl.children);
    const hasOnlyDisplayMath = directChildren.some((c) => c.localName === "oMathPara")
      && !directChildren.some((c) => c.localName === "r" && (c.textContent ?? "").trim().length > 0);
    if (hasOnlyDisplayMath) {
      for (const child of directChildren) {
        if (child.localName === "oMathPara") {
          const mathEl = ommlToMathMl(doc, child, true);
          if (mathEl) {
            container.append(createDisplayFormulaBox(doc, mathEl));
            state.formulaCount += 1;
          }
        }
      }
      return;
    }

    const level = isTitle ? 1 : headingMatch ? Number.parseInt(headingMatch[1]!, 10) : 0;
    const target = doc.createElement(level > 0 ? `h${Math.min(6, level)}` : "p");
    if (isList && level === 0) target.className = "pdf-list-item";

    const appendRunElement = (runEl: Element, host: HTMLElement): void => {
      const embedId = findBlipEmbedId(runEl);
      if (embedId && relImages.has(embedId)) {
        const img = doc.createElement("img");
        img.src = relImages.get(embedId)!;
        img.className = "reader-doc-image";
        img.loading = "lazy";
        host.append(img);
      }

      const text = Array.from(runEl.getElementsByTagName("*"))
        .filter((el) => el.localName === "t" || el.localName === "tab" || el.localName === "br")
        .map((el) => (el.localName === "tab" ? " " : el.localName === "br" ? "\n" : (el.textContent ?? "")))
        .join("");
      if (!text) return;

      const rPr = Array.from(runEl.children).find((c) => c.localName === "rPr");
      const isBold = Boolean(rPr && Array.from(rPr.children).some((c) => c.localName === "b" && c.getAttribute("w:val") !== "0" && c.getAttribute("w:val") !== "false"));
      const isItalic = Boolean(rPr && Array.from(rPr.children).some((c) => c.localName === "i" && c.getAttribute("w:val") !== "0" && c.getAttribute("w:val") !== "false"));
      if (isBold && isItalic) {
        const strong = doc.createElement("strong");
        const em = doc.createElement("em");
        em.textContent = text;
        strong.append(em);
        host.append(strong);
      } else if (isBold) {
        const strong = doc.createElement("strong");
        strong.textContent = text;
        host.append(strong);
      } else if (isItalic) {
        const em = doc.createElement("em");
        em.textContent = text;
        host.append(em);
      } else {
        host.append(doc.createTextNode(text));
      }
    };

    for (const child of directChildren) {
      if (child.localName === "oMath" || child.localName === "oMathPara") {
        const mathEl = ommlToMathMl(doc, child, false);
        if (mathEl) {
          target.append(createInlineFormulaSpan(doc, mathEl));
          state.formulaCount += 1;
        }
      } else if (child.localName === "r") {
        appendRunElement(child, target);
      } else if (child.localName === "hyperlink") {
        const span = doc.createElement("span");
        for (const sub of Array.from(child.children)) {
          if (sub.localName === "r") appendRunElement(sub, span);
        }
        if ((span.textContent ?? "").trim()) target.append(span);
      }
    }

    const plain = (target.textContent ?? "").replace(/\s+/g, " ").trim();
    if (!plain && !target.querySelector("img,math")) return;
    if (level > 0) {
      const id = `doc-h-${++headingIdx}`;
      target.id = id;
      if (level === 1 && title === fallbackTitle) title = plain;
      if (level <= 3) toc.push({ id, label: plain, level });
    }
    container.append(target);
  };

  for (const child of Array.from(body.children)) {
    if (child.localName === "p") {
      renderParagraph(child, fragment);
    } else if (child.localName === "tbl") {
      const table = doc.createElement("table");
      const tbody = doc.createElement("tbody");
      for (const row of Array.from(child.children).filter((c) => c.localName === "tr")) {
        const tr = doc.createElement("tr");
        for (const cell of Array.from(row.children).filter((c) => c.localName === "tc")) {
          const td = doc.createElement("td");
          const tcPr = Array.from(cell.children).find((c) => c.localName === "tcPr");
          const gridSpan = tcPr ? Array.from(tcPr.children).find((c) => c.localName === "gridSpan")?.getAttribute("w:val") : null;
          if (gridSpan && /^\d+$/.test(gridSpan) && Number(gridSpan) > 1) td.setAttribute("colspan", gridSpan);
          for (const p of Array.from(cell.children).filter((c) => c.localName === "p")) {
            renderParagraph(p, td);
          }
          tr.append(td);
        }
        tbody.append(tr);
      }
      table.append(tbody);
      fragment.append(table);
    }
  }

  return { title, kind: "docx", fragment, toc, formulaCount: state.formulaCount };
}

export function parsePlainTextDocument(
  doc: Document,
  text: string,
  fallbackTitle = "纯文本文档",
): ParsedDocumentResult {
  const fragment = doc.createDocumentFragment();
  const paragraphs = text.replace(/\r\n?/g, "\n").split(/\n\s*\n+/);
  for (const raw of paragraphs) {
    const cleaned = raw.replace(/\s+/g, " ").trim();
    if (!cleaned) continue;
    const p = doc.createElement("p");
    p.textContent = cleaned;
    fragment.append(p);
  }
  return { title: fallbackTitle, kind: "text", fragment, toc: [], formulaCount: 0 };
}
