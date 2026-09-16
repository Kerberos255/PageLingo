# PageLingo

PageLingo is a fast, local, layout-preserving immersive translation extension for Firefox.

## V0.1 design rules

- Firefox-first local translation: Bergamot WASM + Mozilla Marian models.
- Never replace the page's `innerHTML` or wrap existing text nodes.
- Keep original links, buttons, forms, event listeners, IDs, styles and node identity intact.
- Render bilingual translation as removable generated nodes.
- Translate rich inline HTML so links/emphasis stay aligned; restore original link targets from the source DOM.
- Preserve inline code exactly and skip form controls / preformatted code / scripts.
- Incrementally translate SPA/dynamic content with MutationObserver while ignoring our own generated DOM.
- Restoring removes only extension-generated nodes.
- Optional image translation keeps the original `<img>` node untouched and renders translated OCR regions in a generated overlay.

## Status

PageLingo combines the DOM-preservation core with real Firefox-local Bergamot inference, automatic page-language detection, translation-only/bilingual display modes, automatic-translation rules, offline language-pack management and optional image translation.

The pinned Mozilla desktop catalog currently contains 103 stable directional model pairs. Direct pairs are used when available; translations between two non-English languages can use a fully local English pivot when both required directions exist. Model payloads are downloaded from Firefox Remote Settings attachments, decompressed locally, and verified by decompressed size and SHA-256 before being cached.

On first install, PageLingo chooses the default target from Firefox's UI/preferred languages and prepares the corresponding English-to-target model when available. Additional language packs can be downloaded or removed from Settings. Model data supports automatic, notification-only, or manual update policies; extension JavaScript and the Bergamot WASM runtime are never remotely updated by the model updater.

Image translation is disabled by default. When enabled, right-click an image and choose `PageLingo · 翻译图片`. PageLingo downloads and verifies PP-OCRv5 Mobile detection/recognition data on first use, runs OCR in a dedicated ONNX Runtime WASM worker, then reuses the existing local Bergamot translation route. The default OCR profile supports Simplified Chinese, Traditional Chinese, English and Japanese.

## Development

```bash
npm install
npm run verify
```

Build output is written to `dist/`.
