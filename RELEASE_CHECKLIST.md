# PageLingo 1.0.0 Public / AMO Release Checklist

## Release baseline

- [x] Version aligned to `1.0.0` in `public/manifest.json`, `package.json`, and `package-lock.json`.
- [x] Production dependency audit (`npm audit --omit=dev --audit-level=high`) is part of `npm run verify`.
- [x] `web-ext lint` is part of `npm run verify` and passes with 0 errors / 0 warnings / 0 notices.
- [x] External translation is gated by Firefox optional data permissions (`websiteContent`, `authenticationInfo`).
- [x] Remote external engines require HTTPS; HTTP is limited to loopback hosts.
- [x] Built-in terminology defaults to proper names and uses exact-case protection.
- [x] Privacy, build, security, changelog, reviewer-notes, and third-party notice documents exist.
- [x] Project-owned code uses PolyForm Noncommercial 1.0.0.
- [x] Third-party components retain their own licenses.

## Public-tree hygiene

- [x] Release tree published as a clean squashed `1.0.0` history on `main` (`v1.0.0`).
- [x] Tracked source tree audited for secrets, private keys, and local machine paths.

## Licensing

- [x] PageLingo license: PolyForm Noncommercial License 1.0.0.
- [x] README states that the PolyForm license covers PageLingo-authored code, not third-party components.
- [x] README states that no license is granted to PageLingo branding.
- [x] Mozilla/Bergamot MPL-2.0 provenance documented.
- [x] Mozilla Firefox translation-model MPL-2.0 provenance documented.
- [x] ONNX Runtime Web MIT provenance documented.
- [x] paddleocr.js MIT provenance documented.
- [x] PP-OCRv5 / RapidOCR model provenance documented.
- [x] fzstd MIT notice included.

## Final validation

- Release verification date: 2026-11-22.
- [x] `npm run verify` passes with 0 TypeScript errors, all Vitest suites passing, production audit 0 vulnerabilities, and `web-ext lint` 0 errors / 0 warnings / 0 notices.
- [x] Real Bergamot WASM direct and pivot language-pack check + Mozilla CDN 313/313 URL verification completed.
- [x] Bilingual DOM/layout structure check (`source-top` / `translation-top` / mode switching / restore) and image-translation visual self-test completed.
- [x] Production XPI manifest verified (`version: "1.0.0"`, optional `websiteContent` / `authenticationInfo`).
- [x] Matching source archive created from tag `v1.0.0` (`git archive --format=zip --output pagelingo-1.0.0-source.zip v1.0.0`).
- [x] SHA-256 checksums recorded for production XPI and source archive.

## Public repository

- [x] Publish clean squashed `1.0.0` commit on `main` and annotated tag `v1.0.0`.
- [x] Verify CI green on `main`.
- [ ] Confirm repository visibility (Private → Public, or clean public mirror if historical closed PRs should not be exposed).
- [ ] Set repository description/topics/homepage and enable branch protection for `main`.
- [ ] Create GitHub Release `v1.0.0` and attach release artifacts.

## AMO submission

- [ ] Create/confirm AMO developer account.
- [ ] Upload production `pagelingo-1.0.0.xpi`.
- [ ] Upload matching `pagelingo-1.0.0-source.zip` (required because PageLingo bundles with esbuild).
- [ ] Category: Language Support.
- [ ] Add summary and description from `AMO_LISTING_DRAFT.md`.
- [ ] Add privacy policy from `PRIVACY.md`.
- [ ] Use a custom PolyForm Noncommercial 1.0.0 license entry (`LICENSE.md`).
- [ ] Add `AMO_REVIEW_NOTES.md` to Notes for Reviewers.
- [ ] Upload the 5 clean release screenshots.
- [ ] Mark optional third-party services accurately; PageLingo itself does not require payment.
- [ ] Submit Firefox desktop first; do not claim Android support until separately validated.
