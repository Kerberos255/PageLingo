# Building PageLingo for Firefox

PageLingo is built from source with Node.js and npm.

## Reference environment

- Node.js 24.x
- npm from the Node.js 24 distribution
- Python 3.x only for the optional Firefox/Selenium end-to-end tests

## Reproducible source build

From a clean source checkout:

```bash
npm ci
npm run verify
```

`npm ci` installs the exact dependency graph pinned by `package-lock.json`. `npm run verify` runs the TypeScript checks, unit tests, builds `dist/`, and runs the Firefox add-on linter.

To create the same unsigned extension archive used for pre-release testing:

```bash
npm run package
```

The archive is written under `artifacts/`.

## Important build details

- Extension JavaScript is bundled with esbuild from the TypeScript source in `src/`.
- The bundled Bergamot JavaScript/WASM runtime comes from `vendor/bergamot/`.
- ONNX Runtime Web is installed through npm and its WASM runtime is copied from `node_modules` during the build.
- Translation model files and OCR model files are data assets downloaded at runtime; they are not executable extension code.
- No remote JavaScript is downloaded or executed by the extension.

## AMO source submission

For Mozilla review, submit the clean source tree including `package.json`, `package-lock.json`, `src/`, `public/`, `tools/`, `vendor/`, tests, this file, and third-party notices. Do not include `node_modules/`, `dist/`, `artifacts/`, caches, browser profiles, or credentials.
