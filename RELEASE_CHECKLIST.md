# PageLingo Public / AMO Release Checklist

Reusable checklist for tagging a public release and submitting to Firefox Add-ons (AMO).

## Version & Build Integrity

- [ ] Version aligned across `public/manifest.json`, `package.json`, and `package-lock.json`, with matching release notes in `CHANGELOG.md`.
- [ ] `npm run verify` passes with 0 TypeScript errors, all Vitest suites passing, `npm audit --omit=dev --audit-level=high` 0 vulnerabilities, clean `npm run build`, and `web-ext lint --source-dir dist` 0 errors.
- [ ] Unmodified third-party vendor files (`onnxruntime-web`, `pdfjs-dist` worker/cmaps/standard_fonts, `bergamot` WASM) match upstream npm packages byte-for-byte with zero build-time patching.
- [ ] `AMO_REVIEW_NOTES.md` stays within AMO's 3,000-character Notes to Reviewer limit (CRLF-counted) and reflects exact Node/build commands.
- [ ] `PRIVACY.md` matches all runtime data flows, incognito bypass behavior, and optional data permissions (`websiteContent`, `authenticationInfo`).

## Public-Tree Hygiene & Licensing

- [ ] Tracked source tree contains zero secrets, private keys, local paths, or runtime logs/artifacts.
- [ ] Project-owned source retains PolyForm Noncommercial License 1.0.0 (`LICENSE.md`); third-party attributions and licenses remain intact in `THIRD_PARTY_NOTICES.md` (`Bergamot` MPL-2.0, `ONNX Runtime Web` MIT, `pdfjs-dist` Apache-2.0, `paddleocr.js` MIT, `PP-OCRv5/v6` & `PP-DocLayout-M` Apache-2.0, `fzstd` MIT).

## Reproducible Packaging

- [ ] Build clean production XPI from `dist/` (`pagelingo-<version>.xpi`).
- [ ] Export matching source archive from the release tag (`git archive --format=zip --output pagelingo-<version>-source.zip v<version>`).
- [ ] Unpack `pagelingo-<version>-source.zip` into a clean directory, run `npm ci && npm run build`, and verify 100% file-by-file SHA-256 parity against `pagelingo-<version>.xpi`.
- [ ] Record SHA-256 checksums for both archives.

## Browser & Feature Smoke Checks

- [ ] Desktop Firefox manual smoke check: bilingual / translation-only / restore on multi-layout sites, incognito translation cache isolation, PDF reader (lazy scroll, zoom, overlay mode, scanned-page OCR), image translation, and video subtitles.
- [ ] Automated real-browser regression (dynamic SPA detach/prune/re-insert restore, long PDF lazy canvas memory budget, mid-load zoom & document-switch isolation, unmodified ORT WASM worker).

## GitHub & AMO Submission

- [ ] Push release commit and annotated tag `v<version>` to `main` and confirm GitHub Actions CI is green.
- [ ] Upload `pagelingo-<version>.xpi` and matching `pagelingo-<version>-source.zip` to AMO.
- [ ] Paste `AMO_REVIEW_NOTES.md` into Notes for Reviewers and verify `PRIVACY.md` matches the listing privacy policy.
