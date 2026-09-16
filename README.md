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

## Status

The DOM-preservation core and automated regression tests are the first milestone. Bergamot runtime/model loading is integrated separately so page integrity is testable independently from model inference.

## Development

```bash
npm install
npm run verify
```

Build output is written to `dist/`.
