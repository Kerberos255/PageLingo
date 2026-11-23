# Changelog

## 1.1.1 — 2026-11-23

### Performance

- **Eliminate main-thread freezes on very large DOM pages** (e.g. 5+ MB / 50,000+ element documentation and release-note pages with thousands of collapsed `<details>` panels):
  - Skip collapsed `<details>` bodies, `<svg>`, code blocks, and `[hidden]`/`[aria-hidden]` subtrees in O(1) before calling `getComputedStyle()`, and stream newly revealed accordions with time-sliced async root collection (`collectTranslationRootsAsync`) and early viewport-first dispatch.
  - Enable viewport-driven lazy off-screen translation (`IntersectionObserver`) for the local Bergamot engine as well as external engines.
  - Stop invoking `element.getAnimations()` on non-fading elements (`display: none`, `sr-only`, `<svg>`, collapsed `<details>`) and replace `:scope > pre` `querySelector` calls with direct child iteration.
  - Split bilingual DOM mounting, CJK-spacing validation, and display-mode switching (`translation` ↔ `bilingual`) into batched pure-READ then pure-WRITE passes with frame-coalesced bilingual commits and post-paint read gating, preventing cascading forced style/layout recalculations.
  - Batch `freezeNavigationLayout()` and `TranslationProgress` reads before writes, skip vertical sidebars and collapsed `<details>`, and remove full-document `innerText` serialization from page language sampling and subframe discovery.

## 1.1.0 — 2026-11-22

### Added

- **Built-in local PDF & document reader (`reader.html`)**: open local or online PDF, Markdown, HTML, EPUB, DOCX, and TXT files inside Firefox using bundled `pdfjs-dist` and native `DecompressionStream` ZIP extraction (zero remote code). Includes HiDPI PDF canvas synchronized with structured 2-column reading-order reconstruction, hyphenation repair, margin page-number filtering, and formula preservation (PDF display/inline math, Markdown LaTeX `$...$`/`$$...$$`, HTML MathML/KaTeX, and DOCX Office Math `m:oMath`/`m:oMathPara`).
- **Selection translation**: right-click selected text (`PageLingo · 翻译所选内容`, shown only on text selection) or enable the optional floating quick-translate button in Settings to open an isolated Shadow DOM popover with CN↔EN auto-pivot, copy, cache-bypass retranslate, and inline bilingual insertion.
- **Multilingual local image OCR**: reuse one shared 4.8 MB PP-OCRv5 Mobile text detector across 5 on-demand SHA-256-verified recognition packs (CJK/EN/JA default, Latin European/SEA, Korean + English, Cyrillic, and Thai + English) with Unicode word-boundary wrapping and safe horizontal button expansion.
- **Redesigned dual-tab popup**: dedicated `网页翻译 | 文本翻译` tabs, header shortcut to the PDF/document reader, automatic PDF-tab quick-open banner, spacious auto-growing text input with independent `自动检测 ⇄ 简体中文` language bar, and always-visible copy/retranslate actions.

### Fixed

- **Mixed-language webpages and webmail iframes**: extract non-target foreign text samples on mixed-language pages (such as Chinese webmail displaying English emails), prevent `<html lang>` from overriding English blocks, skip short target-language UI labels (`删除`, `回复`, `收件箱`), broadcast popup translation/restore across visible frames, and enable `match_about_blank` for `about:blank`/`srcdoc` email body iframes.

## 1.0.0 — 2026-11-22

First stable public release.

### Added

- Local Firefox/Bergamot webpage translation with downloadable offline language packs (103 directional pairs + local English pivot).
- Translation-only and customizable bilingual display modes (source/translation order, theme presets, scale, color, learning mode, and live preview).
- Automatic translation rules for sites and languages with tag-chip overview and modal rule manager.
- Right-click single-paragraph force re-translation with cache bypass.
- Layout-preserving rich-text translation for dynamic/SPA pages.
- Built-in and user terminology protection.
- Optional built-in keyless Microsoft Translator and Google Translate engines, plus API and LLM presets with live model discovery (including OpenAI, Anthropic, Gemini, DeepSeek, OpenRouter, Ollama, and custom REST).
- Optional local image OCR and translation with per-block visual hierarchy (dynamic font size, stroke-weight estimation, foreground color sampling), standalone button centering, paragraph merging, orphan control, punctuation normalization, and UI short-term mapping.
- Optional video soft-subtitle translation (YouTube, Bilibili, HTML5 `<track>`) with customizable overlay styles and live preview.
- Model download, integrity verification, cache management, and update checks.

### Hardened & Optimized

- Preserve links, code, controls, SVG icons, identifiers, counters, hidden accessibility text, and decorated layout containers across translation-only and bilingual modes.
- Preserve GitHub repository/user/path/commit identifiers and SPA navigation layout.
- Keep dynamic relative-time elements localized instead of converting them into fixed dates.
- Recover unmatched cross-slot brackets in local Bergamot models, collapse non-preformatted mid-sentence hard newlines, and protect brand lists from false language-mismatch rejections.
- Reject damaged translation output containing Unicode replacement characters.
- Reuse a shared `DOMParser` singleton across translation pipelines, short-circuit screen-reader visibility checks, and cache computed visibility across fallback DOM root collection.
- Achieve 0 errors, 0 warnings, and 0 notices under `web-ext lint`.
