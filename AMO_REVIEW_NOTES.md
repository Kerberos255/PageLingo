PageLingo — Reviewer Notes (full provenance & SHA-256 inventory in BUILDING.md, THIRD_PARTY_NOTICES.md, PRIVACY.md in source zip)

1. Reproducible Build (Ubuntu 24.04 x86_64/ARM64, Node 22.x/24.x; built on Node v22.23.5 / npm 12.2.2):
  npm ci
  npm run build
dist/ matches the uploaded XPI byte-for-byte. `npm run verify` runs tsc, Vitest, prod audit, build, and `web-ext lint` (0 errors; only 6 warnings inside unmodified official pdfjs-dist/onnxruntime-web).

2. No Obfuscation, No Minification, Zero Modified Third-Party Libraries:
- tools/build.mjs uses `minify: false`, `charset: "utf8"` (zero \uXXXX string escapes), `legalComments: "inline"`, and performs zero post-build edits to any third-party library.
- Removed `src/video-translation/bilibili-wbi.ts` completely (no key-permutation table, no remote image-URL key extraction, no custom MD5).
- `image-ocr-worker.js` is an ES module Worker bundling unmodified UNMINIFIED `onnxruntime-web/dist/ort.wasm.mjs` and `paddleocr/dist/index.mjs`, loading unmodified `vendor/onnxruntime/ort-wasm-simd-threaded.mjs` (SHA-256 e13f7f94fc51b4ca72b12faeb1ee95f4ace6dfbc8939bc718aabdc0a27c4299b) and `.wasm` (SHA-256 3398c10d07d229bd91b364548e130e0e51a8e5704b88c7c083ebbeb78842dee2) via public `ort.env.wasm.wasmPaths`.
- `pdfjs-dist` 5.4.624 (`reader.js`, unmodified `vendor/pdfjs/pdf.worker.mjs` SHA-256 a6a52b63b21b901a70c28d662c72716df14ffbfc4b54436747df333add0649cb) uses public `getDocument({ isEvalSupported: false })`.
- `wrappedJSObject` in src/video-translation/ is read-only Xray access to YouTube/Bilibili player caption tracks and playback time.

3. No Remote Code & Optional Data Transmission:
- Default translation is 100% local (Bergamot WASM + Mozilla models). Runtime-downloaded OCR/layout/translation models are SHA-256-verified static data files only; zero remote JS/WASM is executed.
- Optional external engines require explicit user action + Firefox optional `websiteContent`/`authenticationInfo` permissions (HTTPS only; HTTP loopback only).

4. Unmodified Third-Party Libraries (pinned in package.json dependencies & package-lock.json):
- Bergamot JS (MPL-2.0, exact blob 4cc89e7b56dfa6d33e9b85deea3fdb9c8c11cffa): https://github.com/mozilla-firefox/firefox/blob/48d55cf7ec80093903e2ef7f58b61a84a22ef716/toolkit/components/translations/bergamot-translator/bergamot-translator.js
- Bergamot source (v0.6.0+eea6e5a8): https://github.com/mozilla/translations/commit/eea6e5a80aa4ddd86d9cc35ce9a65b79aa3ab96d
- onnxruntime-web 1.30.0 (MIT): https://registry.npmjs.org/onnxruntime-web/-/onnxruntime-web-1.30.0.tgz
- paddleocr 1.2.0 (MIT): https://registry.npmjs.org/paddleocr/-/paddleocr-1.2.0.tgz
- pdfjs-dist 5.4.624 (Apache-2.0): https://registry.npmjs.org/pdfjs-dist/-/pdfjs-dist-5.4.624.tgz
- fzstd 0.1.1 (MIT): https://registry.npmjs.org/fzstd/-/fzstd-0.1.1.tgz
