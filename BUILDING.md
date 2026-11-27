# Building PageLingo for Firefox

PageLingo is built from source with Node.js and npm.

## Reference environment

- OS: Ubuntu 24.04 LTS (works identically on x86_64 and ARM64)
- Node.js: 22.x or 24.x (the release archive was built with Node.js `v22.23.5` and npm `12.2.2`; `esbuild` output is deterministic across Node 22/24 and Linux x86_64/ARM64)
- Python 3.x only for the optional Firefox/Selenium end-to-end tests

## Reproducible source build

From a clean source checkout:

```bash
npm ci
npm run build
```

To run the full verification suite (TypeScript typecheck, Vitest unit tests, production dependency audit, build, and `web-ext lint`):

```bash
npm ci
npm run verify
```

`npm ci` installs the exact dependency graph pinned by `package-lock.json`.

To create the same unsigned extension archive submitted to AMO:

```bash
npm run package
```

The archive is written under `artifacts/` and `dist/` contains the exact unpacked extension files for diff comparison.

## Important build details

- Extension JavaScript is bundled with `esbuild` from the TypeScript source in `src/` with `minify: false`, `charset: "utf8"`, and `legalComments: "inline"` (no minification, no obfuscation, human-readable UTF-8 strings, and preserved upstream license headers).
- The bundled Bergamot JavaScript/WASM runtime comes from `vendor/bergamot/`.
- ONNX Runtime Web (`onnxruntime-web@1.30.0`) is installed through npm: `tools/build.mjs` bundles the unminified `node_modules/onnxruntime-web/dist/ort.wasm.mjs` into the ES module worker `dist/image-ocr-worker.js` and copies the unmodified official `ort-wasm-simd-threaded.mjs` and `ort-wasm-simd-threaded.wasm` files into `dist/vendor/onnxruntime/`.
- Mozilla PDF.js (`pdfjs-dist@5.4.624`), `paddleocr@1.2.0`, and `fzstd@0.1.1` are installed through npm and bundled without minification.
- Translation model files and OCR model files are static data assets downloaded at runtime and verified by expected byte size and SHA-256; they are not executable extension code.
- No remote JavaScript or WebAssembly is downloaded or executed by the extension.

## AMO source submission

For Mozilla review, submit the clean source tree including `package.json`, `package-lock.json`, `src/`, `public/`, `tools/`, `vendor/`, `tests/`, `BUILDING.md`, `AMO_REVIEW_NOTES.md`, and `THIRD_PARTY_NOTICES.md`. Do not include `node_modules/`, `dist/`, `artifacts/`, caches, browser profiles, or credentials.
