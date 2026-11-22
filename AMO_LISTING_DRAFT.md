# AMO Listing Draft — PageLingo 0.1.30

This file is a submission draft, not runtime configuration.

## Name

PageLingo

## Summary

Local-first webpage translation for Firefox with layout preservation, offline Mozilla models, terminology protection, and optional local image OCR.

## Category

- Language Support

## Description

PageLingo translates webpages while trying to preserve the page structure, links, controls, icons, code, identifiers, and dynamic SPA behavior that ordinary text replacement can disturb.

The default translation engine runs locally in Firefox using Bergamot WebAssembly and Mozilla Firefox translation models. Page text is not sent to a translation service when the local engine is selected.

Features include:

- local webpage translation with downloadable offline language packs (103 directional pairs, plus automatic local English pivot);
- translation-only and customizable bilingual display modes (order, themes, scale, color, learning blur mode, and live preview);
- automatic translation rules for selected sites and languages, plus right-click single-paragraph cache-bypass re-translation;
- layout-preserving translation for dynamic and SPA-style pages;
- built-in proper-name protection and user terminology collections;
- optional local image OCR and translation with visual hierarchy preservation and button centering;
- optional video soft-subtitle translation (YouTube, Bilibili, HTML5 tracks) with customizable bilingual overlay styling;
- optional external translation engines (built-in keyless Microsoft / Google plus user-configured API and LLM providers with live model discovery).

External engines are not required and never enabled by default. If a user chooses one, PageLingo requests Firefox's optional data-transmission permission before sending website content to that provider. Remote external endpoints must use HTTPS, except loopback services such as localhost.

PageLingo contains no analytics, advertising, affiliate injection, or PageLingo-operated telemetry backend.

## Payment / non-free services

PageLingo itself does not require payment and its default local translation path does not require a paid service.

Optional third-party API providers may require their own account, API key, quota, or payment. Those services are user-configured and are not required for the extension's core local translation functionality.

## Privacy policy

Use the repository `PRIVACY.md` text in the AMO privacy-policy field after the repository becomes public.

## Support website

Use the public PageLingo GitHub repository / Issues page after publication.

## License

Use an AMO **custom license**:

- Name: PolyForm Noncommercial License 1.0.0
- Text: the complete contents of `LICENSE.md`
- Canonical URL: https://polyformproject.org/licenses/noncommercial/1.0.0/

AMO's predefined non-theme license list does not currently include PolyForm Noncommercial, but the AMO API supports custom licenses for extensions.

Third-party components remain under their own licenses as documented in `THIRD_PARTY_NOTICES.md`.

## Reviewer notes

Use `AMO_REVIEW_NOTES.md`.

## Source code submission

PageLingo uses TypeScript plus esbuild bundling, so submit matching source code for every AMO version.

Recommended release source archive after tagging the release:

```bash
git archive --format=zip --output pagelingo-0.1.30-source.zip v0.1.30
```

The archive should contain the tracked source tree, lockfile, build tools, bundled Bergamot source/runtime material, licenses, and build instructions. Do not include `node_modules/`, `dist/`, browser profiles, caches, credentials, or local artifacts.

## Compatibility

Initial submission target: Firefox desktop.

Do not mark Firefox for Android support until the full PageLingo UI, model storage, WASM/OCR behavior, and page translation flow have been separately tested on Android.

## Screenshot plan

Use clean release screenshots rather than CI/debug captures:

1. A real webpage before/after translation showing preserved layout.
2. Bilingual mode on a content-heavy page.
3. Settings page showing local Firefox/Bergamot as the default engine and language-pack management.
4. Terminology example with a protected proper name.
5. Optional image translation result.

Avoid screenshots containing personal account information, private repositories, API keys, local filesystem paths, or test-only labels.
