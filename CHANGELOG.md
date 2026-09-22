# Changelog

## 0.1.30 — 2026-09-23

First public release candidate.

### Added

- Local Firefox/Bergamot webpage translation with offline language packs.
- Translation-only and bilingual display modes.
- Automatic translation rules for sites and languages.
- Layout-preserving rich-text translation for dynamic/SPA pages.
- Built-in and user terminology protection.
- Optional external translation engines and custom REST integration.
- Optional local image OCR and translation.
- Model download, integrity verification, cache management, and update checks.

### Hardened

- Preserve links, code, controls, identifiers, icons, counters, hidden accessibility text, and decorated layout containers.
- Preserve GitHub repository/user/path/commit identifiers and SPA navigation layout.
- Keep dynamic relative-time elements localized instead of converting them into fixed dates.
- Reject damaged translation output containing Unicode replacement characters.
- Protect immutable proper names before translation.
