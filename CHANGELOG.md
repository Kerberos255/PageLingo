# Changelog

## 1.1.7 — 2026-11-28

### Performance & Memory

- **Viewport-driven lazy PDF rendering with dual count & byte memory budgets (`src/reader/pdf-lazy-render.ts`, `src/reader.ts`)**:
  - Opening multi-page PDFs now renders page 1 immediately while building exact-size placeholder shells for remaining pages and rasterizing canvases lazily via `IntersectionObserver` on scroll, keeping initial memory low and time-to-translate fast.
  - Enforced dual eviction limits (`MAX_RENDERED_PDF_CANVASES = 10` and `MAX_PDF_CANVAS_BUDGET_BYTES = 96 MiB` covering base canvases, translation overlays, and right-pane cropped formula/figure/table snapshots) with pre-allocation eviction to prevent transient spikes on HiDPI displays.
  - Removed the redundant full-PDF `activePdfBytes` fallback copy and limited overlay repaints (`renderAllPdfOverlays`) to currently visible rendered pages.
  - Added targeted `page.getOperatorList()` font metadata discovery (capped at 12 pages with unresolved fonts, skipping scanned/shared-font pages) so unique bold/math fonts on unrendered pages are recognized before translation without offscreen canvas rasterization.
- **Long-lived SPA, video subtitle, model loader & UI efficiency**:
  - Added throttled detached-node pruning and ancestor deduplication to `RelativeTimeLocalizer` (`src/shared/relative-time.ts`).
  - Filtered `VideoSubtitleManager`'s `MutationObserver` to ignore `[data-flt-generated]` and non-video DOM churn, and paused route polling while the tab is hidden.
  - Deduplicated concurrent Bergamot model asset downloads per URL (returning isolated `ArrayBuffer` copies), parallelized per-pair asset downloads, added asset/metadata fetch timeouts (60s / 15s), and guarded against stale worker teardown races.
  - Skipped `[data-flt-generated]` elements and empty probe timers in `TooltipController`, coalesced image overlay repositioning on scroll/resize with `requestAnimationFrame`, and added missing `keepEventPageAlive` wrappers for PDF page OCR, language-pack downloads/updates, and single-item external fallbacks.

### Fixed

- **PDF Reader async race conditions**:
  - Isolated document open (`activeOpenGeneration`), loaded document (`activeDocumentGeneration`), translation (`activeTranslationGeneration`), and zoom (`activePdfRenderGeneration`) lifetimes so mid-load zooming completes all pages cleanly, slow remote URLs never overwrite a newer local document or its status bar, switching documents mid-translation never marks the new document as translated, and zooming preserves existing OCR results and translations.
  - Verified unscrolled scanned PDF pages participate in batch OCR while blank white pages are automatically excluded via visual ink checks.
- **Dynamic webpage restoration accuracy**:
  - Restored detached translated entries (`#records`, `#fixedRecords`, tooltips, placeholders, source-text wrappers, and hidden links) during 4-second pruning so virtualized SPA rows reinserted later never stay stuck in translated text on restore.
  - Narrowed hidden `<a>` link restoration (`#restoreSourceLinkDisplay`) to revert only PageLingo's `display: none !important`, preserving subsequent website style, color, layout, text, placeholder, and relative-time `lang` updates.

### Changed

- Removed the unused runtime `terminologyText` field from `PageLingoSettings` while keeping legacy `terminologyText` and `excludedSites` storage-key migration intact.
- Simplified user-facing Settings, OCR, and Reader copy to remove internal model codenames and verification jargon, replaced glossary modal placeholder examples with neutral technical terms, and updated `RELEASE_CHECKLIST.md`.

## 1.1.6 — 2026-11-28

### Security & Privacy

- **Private Browsing isolation & policy alignment**:
  - Translation requests from Firefox Private Browsing tabs (`sender.tab?.incognito`) now bypass both reading and writing shared IndexedDB (`pagelingo-external-translation-cache-v1`) and in-memory Bergamot caches, and never attach normal-profile cookies to background subtitle fetches.
  - Updated `PRIVACY.md` to accurately document the normal-window local translation caches, retention limits, Settings clear-cache control, and Private Browsing bypass.
- **Hardened background fetches (`src/shared/bounded-fetch.ts`)**:
  - `fetch-subtitle-track` now requires HTTPS (or loopback HTTP for local testing), defaults to `credentials: "omit"`, grants `credentials: "include"` only to allowlisted HTTPS subtitle API hosts in non-incognito windows, and enforces a streaming 5 MB limit with timeout.
  - `fetch-document-bytes` and `fetch-image-bytes` now enforce request timeouts (60s / 30s), upfront `Content-Length` rejection, and streaming byte limits (64 MB / 32 MB) before buffering.
- **Zero-mutation third-party build**:
  - Removed all post-build patching of `pdfjs-dist` and `onnxruntime-web` in `tools/build.mjs`: `vendor/pdfjs/pdf.worker.mjs` and `vendor/onnxruntime/ort-wasm-simd-threaded.{mjs,wasm}` are copied byte-for-byte unmodified from npm, `image-ocr-worker.js` configures ORT via public `ort.env.wasm.wasmPaths`, and `THIRD_PARTY_NOTICES.md` / `BUILDING.md` / `AMO_REVIEW_NOTES.md` record exact upstream Firefox Bergamot blob SHA-1/SHA-256 provenance.

### Performance & Stability

- **OCR Worker & model memory lifecycle**:
  - Serialized `ImageOcrWorkerClient` requests in a FIFO queue with worker-generation guards, post-success initialization tracking, clean timeout/crash recovery onto fresh workers, and automatic idle worker termination (3 min) plus worker-side sequential message chaining.
  - Avoided pinning tens of MB of OCR model `ArrayBuffer`s in memory during Settings status checks (`hasCachedAsset`) and added idle memory eviction (5 min) while preserving verified IndexedDB copies.
- **PDF Reader lifecycle, memory & zoom**:
  - Added document/render generation cancellation, explicit `PDFDocumentProxy.destroy()` and canvas backing release on document switch and `pagehide`, and reused the loaded PDF document when zooming so zoom is fast and preserves existing translations and OCR results.
  - Allocated `overlayCanvas` lazily only when in-place overlay mode renders and freed its bitmap immediately on switch back to split mode or restore.
  - Replaced full high-DPI bitmap `getImageData` readbacks in `canvasHasVisualInk` with a reusable 64×64 probe canvas (`src/reader/pdf-ink.ts`).
- **Bergamot cache & worker lifecycle**:
  - Prevented per-item fallback errors inside multi-item batches from poisoning `ShortTranslationCache` with untranslated source text, and added idle Bergamot worker eviction (5 min) while preserving cumulative telemetry.
- **Long-lived SPA, settings & video subtitle efficiency**:
  - Added throttled detached-DOM and disconnected shadow-root observer pruning (`pruneDetachedEntries`) and O(depth) ancestor deduplication for `MutationObserver` batches in `PageTranslator`.
  - Coalesced concurrent `rescanAfterRouteChange` runs in `src/content.ts`, skipped hidden-tab 400ms URL polls with immediate `visibilitychange` catch-up, and updated `loadSettings()` to query explicit storage keys with a `storage.onChanged`-invalidated in-memory cache.
  - Capped livestream `liveFailed` entries to `MAX_LIVE_TRANSLATION_CACHE` and skipped Bilibili `<bwp-video>` 200ms sync ticks when hidden or subtitles are off.

### Fixed

- **Bilingual layout regressions on real documentation, code, and interactive-fiction sites**:
  - Stripped `<pre>` code blocks when cloning containers in bilingual mode so code blocks inside list items are never duplicated.
  - Mounted bilingual labels for standalone `<a>` controls/nav links inside the original anchor (matching `<button>` controls) instead of cloning button/pill classes as extra flex siblings.
  - Rendered multi-line `white-space: pre-wrap`/`pre-line` inline story/dialog spans as block translations in bilingual mode instead of gluing translations inline onto the final sentence.

## 1.1.5 — 2026-11-25

### Changed

- **Unminified, UTF-8, review-transparent extension build**:
  - Enabled `charset: "utf8"` and `legalComments: "inline"` in `tools/build.mjs` so built scripts preserve readable UTF-8 strings (eliminating Unicode `\uXXXX` escape sequences) and keep upstream third-party license and version headers intact.
  - Switched `image-ocr-worker.js` to an ES module Web Worker bundling the official unminified `onnxruntime-web/dist/ort.wasm.mjs` runtime and statically importing the unmodified official `vendor/onnxruntime/ort-wasm-simd-threaded.mjs` Emscripten glue alongside `ort-wasm-simd-threaded.wasm` (replacing the pre-minified `ort.wasm.bundle.min.mjs` inline bundle).
  - Removed custom Bilibili WBI key-permutation/MD5 query signing (`bilibili-wbi.ts`), querying Bilibili subtitle metadata directly with player subtitle resource-capture fallback.
  - Formatted compressed rules in `public/settings.css` into standard multi-line CSS, moved runtime-bundled `fzstd` into `package.json` `dependencies`, and expanded third-party source provenance in `AMO_REVIEW_NOTES.md`, `BUILDING.md`, and `THIRD_PARTY_NOTICES.md`.

## 1.1.2 — 2026-11-25

### Added

- **Scanned-PDF OCR & upgraded document reader (`reader.html`)**:
  - Upgraded local OCR to `PP-OCRv6_small` (50 languages in one default pack: CJK, English, Japanese, and 46 Latin scripts, alongside optional Korean, Cyrillic, and Thai extension packs).
  - Added on-demand scanned-PDF OCR powered by `PP-DocLayout-M` layout detection + `PP-OCRv6_small`.
  - Added an **in-place overlay reading mode** alongside side-by-side view, two-tier PDF table and figure preservation (HiDPI snapshots for dense numeric/formula tables and translatable HTML tables for prose tables), upgraded PDF formula cropping and 2D math layout, and native MathML rendering for Markdown, DOCX, EPUB, and HTML.
- **Redesigned video soft-subtitle workflow**:
  - Added an explicit **Auto-show foreign subtitles** option (off by default): players display a calm on-demand quick toggle button (`off → default mode → alternate mode → off`) without interfering with playback until clicked, with per-video temporary overrides separate from global defaults.
  - Added same-language auto-skip with on-demand secondary-language bilingual fallback when the user manually clicks the player toggle (for example, Chinese-only videos translate into CN/EN bilingual on click), plus clear missing offline language-pack hints.
  - Added lightweight in-overlay translating and cooldown-retry status indicators with exponential backoff for transient translation errors.
  - Added a top-level dismiss button to inline selection translation blocks and kept page/selection context menu actions directly at top level.

### Fixed

- **Video player & multi-language track selection**:
  - Ranked YouTube and Bilibili subtitle tracks using original-language signals (audio track metadata, ASR language, original track labels, title script, and active player track) instead of selecting the alphabetically first track (such as `ar`).
  - Hardened YouTube PO-token recovery, live DOM caption bridging, Shorts targeting, Bilibili `bpx-player` / `<bwp-video>` / WBI subtitle discovery, universal HTML5 player controls (`Video.js`, `Plyr`, `Shaka`, `JW Player`, `DPlayer`, `ArtPlayer`, `xgplayer`, async HLS `TextTrack`s, fullscreen reparenting), and Firefox Xray compartment safety.
- **Webpage translation accuracy & edge cases**:
  - Normalized standalone terminal ASCII punctuation (`.` / `!` / `?`) after inline links and tags to fullwidth punctuation in Chinese translations while preserving version numbers, code dots, and leading list ordinals.
  - Fixed unmatched cross-slot CJK brackets (`《》`, `〈〉`, `「」`, `『』`), cross-boundary inline wrappers, and dropped closing em-dash predicates in local Bergamot translations.
  - Bypassed blanket page-level `translate="no"` wrappers while keeping localized exclusions, and prevented missed form labels, icon buttons, prose placeholders, and worker stalls.
- **Settings & Popup ergonomics**:
  - Scoped all toggle switches and checkboxes in Settings and Popup strictly to the switch control itself so clicking or selecting label text no longer toggles settings accidentally.

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
