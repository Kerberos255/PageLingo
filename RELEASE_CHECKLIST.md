# PageLingo 0.1.30 Public / AMO Release Checklist

## Release candidate

- [x] Version aligned to 0.1.30 in the Firefox manifest and npm metadata.
- [x] Production dependency audit is part of `npm run verify`.
- [x] `web-ext lint` is part of `npm run verify`.
- [x] Latest release-candidate CI completed successfully.
- [x] Live Firefox + real GitHub regression completed successfully.
- [x] External translation is gated by Firefox optional data permissions.
- [x] Remote external engines require HTTPS; HTTP is limited to loopback hosts.
- [x] Built-in terminology defaults to proper names and uses exact-case protection.
- [x] Hard-coded Chinese `Why ...` title generation was removed.
- [x] Privacy, build, security, changelog, reviewer-notes, and third-party notice documents exist.
- [x] Project-owned code uses PolyForm Noncommercial 1.0.0.
- [x] Third-party components retain their own licenses.

## Public-history audit

- [x] Enumerated all 173 commits reachable from `fix/github-font-size`.
- [x] Reviewed commit file metadata for credential/private-key style filenames.
- [x] Scanned commit patches for common API-token/private-key signatures.
- [x] Scanned commit patches for common local Windows/macOS/Linux home/workspace paths.
- [x] No matching secrets, private-key files, or local-machine paths were found by that scan.
- [x] Re-checked the release-candidate tree after the licensing/listing documentation changes.
- [ ] Decide whether to preserve the existing history or publish a squashed release history.

The patch scan is a release-safety check, not a mathematical guarantee that arbitrary historical binary/blob content can never contain an unknown secret format.

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

- Controlled release verification marker: 2026-11-22.
- [x] `npm run verify` passes with 0 TypeScript errors, all Vitest suites passing, production audit 0 vulnerabilities, and `web-ext lint` 0 errors / 0 warnings / 0 notices.
- [x] Real Bergamot WASM direct and pivot language-pack check + Mozilla CDN 313/313 URL verification completed.
- [x] Bilingual DOM/layout structure check (`source-top` / `translation-top` / mode switching / restore) and image-translation visual self-test completed in Chromium.
- [ ] Run the manually controlled live Firefox regression from the exact final `main` release commit.
- [ ] Inspect the production XPI contents and manifest.
- [ ] Confirm production XPI keeps `websiteContent` / `authenticationInfo` optional.
- [ ] Create the matching source archive from the exact same release tag (`git archive --format=zip --output pagelingo-<version>-source.zip v<version>`).
- [ ] Record SHA-256 for production XPI and source archive.

## Public repository

Do not perform these until explicitly approved:

- [ ] Merge/squash the release candidate into `main` (recommended: publish a clean squashed history so earlier private research/MT-training commits are excluded).
- [ ] Close obsolete pre-release PRs (#13, #15, #19).
- [ ] Change repository visibility from private to public.
- [ ] Set repository description/topics/homepage.
- [ ] Enable appropriate branch protection for `main`.
- [ ] Create signed/annotated release tag (`v0.1.30` or `v1.0.0`).
- [ ] Create GitHub Release and attach release artifacts.

## AMO submission

- [ ] Create/confirm AMO developer account.
- [ ] Upload production XPI.
- [ ] Upload matching source archive because PageLingo uses esbuild.
- [ ] Category: Language Support.
- [ ] Add summary and description from `AMO_LISTING_DRAFT.md`.
- [ ] Add privacy policy.
- [ ] Use a custom PolyForm Noncommercial 1.0.0 license entry.
- [ ] Add `AMO_REVIEW_NOTES.md` to Notes for Reviewers.
- [ ] Provide clean listing screenshots.
- [ ] Mark optional third-party services accurately; PageLingo itself does not require payment.
- [ ] Submit Firefox desktop first; do not claim Android support until separately validated.
