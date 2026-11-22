# Changelog

## 0.1.30 — 2026-11-22

First public release candidate.

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

### Hardened

- Preserve links, code, controls, SVG icons, identifiers, counters, hidden accessibility text, and decorated layout containers across translation-only and bilingual modes.
- Preserve GitHub repository/user/path/commit identifiers and SPA navigation layout.
- Keep dynamic relative-time elements localized instead of converting them into fixed dates.
- Recover unmatched cross-slot brackets in local Bergamot models, collapse non-preformatted mid-sentence hard newlines, and protect brand lists from false language-mismatch rejections.
- Reject damaged translation output containing Unicode replacement characters.
- Achieve 0 errors and 0 warnings under `web-ext lint`.
