# PageLingo

PageLingo is a local-first Firefox translation extension built to preserve the structure and interaction of real webpages instead of replacing page HTML.

## Highlights

- **Local by default** — webpage translation runs in Firefox with Bergamot WASM and Mozilla Marian translation models.
- **Layout-preserving & mixed-language translation** — links, buttons, forms, icons, code, IDs, event listeners, accessibility-only content, dynamic SPA structure, and multi-frame webmail (`<iframe>` / `about:blank`) are handled cleanly while skipping target-language UI labels.
- **Translation-only or customizable bilingual mode** — switch between translated text only and bilingual view with configurable order, themes, scale, color, learning blur mode, and live preview.
- **Selection translation & redesigned dual-tab popup** — right-click selected text (or enable the optional floating quick button) for an isolated Shadow DOM popover with auto-pivot CN↔EN, copy, cache-bypass retranslate, and inline bilingual insert; use the dedicated `网页翻译 | 文本翻译` popup tabs with independent text language controls.
- **Built-in local PDF & document reader** — open local or online PDF, Markdown, HTML, EPUB, DOCX, and TXT files in `reader.html` with synchronized HiDPI PDF canvas, side-by-side & in-place overlay reading modes, 2-column reading-order reconstruction, formula protection (HiDPI canvas crops, MathML, LaTeX, DOCX OMML), two-tier table handling (HiDPI snapshots for dense numeric/formula tables + translatable HTML tables for prose tables), and on-demand scanned-PDF OCR powered by `PP-DocLayout-M` + `PP-OCRv6_small`.
- **Automatic translation rules** — manage site and language rules cleanly, and keep top-level context-menu actions one click away.
- **Offline language packs** — download supported Firefox translation models (103 directional pairs across 54 non-English languages, with automatic local English pivot) and use them without a translation API.
- **Terminology protection** — built-in proper names are protected before translation; custom terminology collections can preserve names or specify preferred translations.
- **Optional multilingual image translation** — local `PP-OCRv6_small` (50 languages in one unified default pack: CJK/EN/JA + 46 Latin scripts) plus optional Korean, Cyrillic, and Thai packs via ONNX Runtime Web WASM, with visual hierarchy preservation, Unicode word-boundary wrapping, and standalone button centering.
- **Optional video soft-subtitle translation** — disabled by default; translates soft subtitle tracks (YouTube, Bilibili, HTML5 `<track>`) with customizable bilingual overlay styling and live preview.
- **Optional external engines** — built-in keyless Microsoft Translator and Google Translate, plus API integrations for Microsoft Translator, Google Cloud Translation, DeepL API, OpenAI, Anthropic (Claude), Gemini, DeepSeek, xAI, OpenRouter, Groq, Mistral, DashScope, Moonshot, Zhipu, SiliconFlow, Volcengine, Ollama, LibreTranslate, OpenAI-compatible endpoints (with live model discovery), and a constrained custom REST integration.

## Privacy

The default Firefox/Bergamot engine does not send page text to a translation service.

External engines (including the built-in keyless Microsoft and Google options) are optional and never enabled by default. Before PageLingo can use one, Firefox asks for optional permission to transmit website content (and authentication information when an API key is used). Remote endpoints must use HTTPS; plain HTTP is accepted only for loopback/local-host services.

PageLingo contains no analytics, advertising, affiliate injection, or PageLingo-operated telemetry backend.

See [PRIVACY.md](PRIVACY.md) for details.

## Translation architecture

PageLingo does not replace the page's `innerHTML`. It identifies safe translation roots and text islands, serializes only translatable inline content, and mounts removable generated translation nodes.

The renderer:

- restores original link targets and interaction,
- preserves inline code and technical identifiers,
- sanitizes translated HTML through a small tag/attribute allowlist,
- keeps structural UI containers intact when hiding them would remove icons, borders, controls, or layout,
- incrementally translates dynamic content with `MutationObserver`,
- protects immutable proper names before translation,
- rejects visibly damaged output containing Unicode replacement characters.

Restoring the page removes PageLingo-generated translation nodes and source wrappers without replacing the original application DOM.

## Terminology

The built-in terminology list is intentionally limited to proper names such as brands, organizations, products, platforms, and named projects. Built-in protected names use **case-sensitive matching** so a name such as `Signal`, `Matrix`, `Render`, or `Windows` does not freeze the corresponding ordinary lowercase word.

Custom terminology collections support:

- `Slack` — preserve the source spelling exactly.
- `Gateway = 网关` — request a preferred translation.

Protect-only entries are shielded before translation while the complete surrounding sentence is still sent to the translation engine. Preferred translations remain contextual and are corrected after translation when necessary.

## Language models

The pinned Mozilla desktop catalog currently contains 103 stable directional model pairs. Direct pairs are used when available; two non-English languages can use a fully local English pivot when both required directions exist.

Model files are downloaded as data from Mozilla infrastructure, decompressed locally, verified by decompressed size and SHA-256, and cached in Firefox.

## Image translation

Image translation is disabled by default. When enabled, right-click an image and choose **PageLingo · 翻译图片**.

PageLingo downloads and verifies PP-OCRv6 Small model data on first use (covering 50 languages including CJK, English, Japanese, and 46 Latin scripts, with optional Korean/Cyrillic/Thai extension packs), runs OCR locally in a dedicated ONNX Runtime WASM worker, and sends recognized text through the currently selected translation engine. With the default Firefox engine, OCR translation stays local.

## Development

Requirements and reproducible build steps are documented in [BUILDING.md](BUILDING.md).

Quick verification:

```bash
npm ci
npm run verify
```

Build output is written to `dist/`. An unsigned Firefox package can be produced with:

```bash
npm run package
```

## Security

See [SECURITY.md](SECURITY.md) for vulnerability reporting.

## Third-party software

See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## License

PageLingo-authored source code is available under the **PolyForm Noncommercial License 1.0.0** (`PolyForm-Noncommercial-1.0.0`). Noncommercial use, modification, and redistribution are permitted under its terms; commercial use requires separate permission from the licensor.

Third-party code, runtimes, and model/data assets remain under their own licenses. In particular, the bundled Mozilla/Bergamot runtime and Mozilla Firefox translation models are subject to **MPL-2.0**. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

No trademark license is granted for the **PageLingo** name, logo, or other project branding. Forks and redistributed builds must not imply that they are official PageLingo releases or are endorsed by the PageLingo project.

See [LICENSE.md](LICENSE.md).
