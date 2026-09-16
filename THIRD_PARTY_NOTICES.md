# Third-party notices

## Mozilla Bergamot Translator

This project bundles the Bergamot JavaScript glue and WebAssembly runtime used by Mozilla Firefox Translations.

- Project: Bergamot Translator / Mozilla Translations
- Release: v0.6.0
- Firefox runtime generation: Bergamot WASM v4
- License: Mozilla Public License 2.0 (MPL-2.0)
- Bundled license: `vendor/bergamot/LICENSE`
- Upstream source: Mozilla Firefox / Mozilla Translations repositories

The bundled raw v4 WebAssembly file is produced from Mozilla's current `translations-wasm-v2` artifact and is verified against Mozilla's published decompressed SHA-256:

`f38ef807636a7c994afedaab7ff8ffe0d590d21897f05139f747b80fd7bbe926`

## Translation model data

Translation model payloads are not redistributed in this repository or extension package. The extension downloads model data directly from Mozilla's Firefox Settings attachment CDN when needed and verifies pinned byte sizes and SHA-256 hashes before use.
