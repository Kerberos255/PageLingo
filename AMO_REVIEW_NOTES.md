# AMO Reviewer Notes — PageLingo 0.1.30

## Purpose

PageLingo is a Firefox webpage-translation extension. Its default translation path is fully local: Bergamot WebAssembly plus Mozilla translation model data cached in Firefox.

## Build

Reference environment and reproducible commands are documented in `BUILDING.md`.

```bash
npm ci
npm run verify
npm run package
```

The extension is intentionally built without minification or source maps.

## Remote code

PageLingo does not download or execute remote JavaScript or WebAssembly.

- Bergamot JavaScript and WebAssembly are bundled with the extension.
- ONNX Runtime Web code and WebAssembly are bundled at build time from the pinned npm dependency.
- Translation model files and OCR model files downloaded at runtime are data files only. They are verified by expected size and SHA-256 before use.
- The model updater changes model data only; it never updates extension JavaScript or WebAssembly.

## Data transmission

The Firefox/Bergamot engine is the default and does not transmit webpage text to a translation service.

External translation engines are optional. The production manifest declares `websiteContent` and `authenticationInfo` as optional Firefox data-collection permissions. The extension requests them only from a user action when the user selects/tests an external engine. Background translation refuses to use an external engine if the permission is missing or later revoked.

External-engine endpoints must use HTTPS. Plain HTTP is accepted only for loopback/local-host addresses.

See `PRIVACY.md`.

## External engines

Supported presets are Microsoft Translator, Google Cloud Translation, DeepL API, Gemini, OpenRouter, OpenAI-compatible endpoints, LibreTranslate, and a constrained custom REST integration.

Custom REST accepts declarative JSON header templates, JSON body templates (object or array), and a JSON response path. It does not execute user-provided JavaScript.

Translated HTML is structure-checked and is then parsed through PageLingo's allowlist renderer, which strips unapproved tags/attributes and restores link destinations from the source DOM.

## Permissions

- `storage`: settings, terminology, engine configuration, update state.
- `alarms`: periodic translation-model metadata/update checks.
- `contextMenus`: page/image translation commands.
- `scripting`: load the bundled content script in the selected page or image frame if a translation command has no receiver.
- `unlimitedStorage`: locally cached model data.
- HTTP/HTTPS host permissions: PageLingo is a webpage translator and its content script must operate on arbitrary user-selected sites; the background also downloads user-selected image/model data and can call user-configured translation endpoints.

`activeTab` is not requested.

## Third-party code and data

Exact dependency versions are pinned in `package-lock.json`. Bundled/runtime third-party notices and source links are in `THIRD_PARTY_NOTICES.md`.

Key review references:

- Mozilla/Bergamot generated runtime: embedded version `v0.6.0+eea6e5a8`, generated from Mozilla Translations source commit `eea6e5a80aa4ddd86d9cc35ce9a65b79aa3ab96d`; MPL-2.0. The full MPL-2.0 text is bundled at `vendor/bergamot/LICENSE`.
- Mozilla Firefox translation models: downloaded as data at runtime; Mozilla's translations repository states that the model files are MPL-2.0.
- `onnxruntime-web` 1.30.0: MIT, pinned by `package-lock.json`.
- `paddleocr` 1.2.0: MIT, pinned by `package-lock.json`.
- PP-OCRv5 ONNX model data: official PaddlePaddle model repositories publish the model assets as Apache-2.0; model payloads are downloaded as data and integrity-pinned.
- `fzstd` 0.1.1: MIT.

PageLingo does not relicense third-party code or model assets under its PolyForm license.

## Testing

`npm run verify` runs TypeScript checks, Vitest, a production-dependency audit, the build, and `web-ext lint`.

A separate manually controlled Firefox/Selenium workflow exercises real GitHub dynamic-page translation. Its test-only XPI changes only Firefox's data-permission grant for a localhost deterministic translation fixture; the production XPI retains optional data permissions.
