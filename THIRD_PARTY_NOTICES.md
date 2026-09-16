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

## fzstd

PageLingo bundles `fzstd` to decompress Mozilla's Zstandard-compressed Firefox translation model attachments locally in the extension.

- Project: fzstd
- Copyright: Copyright (c) 2020 Arjun Barrett
- License: MIT

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
