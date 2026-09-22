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

## ONNX Runtime Web

PageLingo bundles the ONNX Runtime Web WASM runtime used by the optional image OCR worker.

- Project: Microsoft ONNX Runtime
- Package: `onnxruntime-web` 1.30.0
- License: MIT
- Runtime code and WASM are bundled with the extension; no executable code is loaded remotely.

MIT License

Copyright (c) Microsoft Corporation

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## paddleocr.js

PageLingo uses the `paddleocr` browser/runtime library to run the PP-OCR detection and recognition pipeline over ONNX Runtime.

- Project: paddleocr.js by X3ZvaWQ
- Package: `paddleocr` 1.2.0
- License: MIT
- Package author metadata: x3zvawq

MIT License

Copyright (c) x3zvawq

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## PP-OCRv5 model data

Image OCR model payloads are not redistributed in this repository. When image translation is enabled and first used, PageLingo downloads the official PaddlePaddle PP-OCRv5 Mobile ONNX detection and recognition models and a compatible PP-OCRv5 dictionary as data files, verifies pinned byte sizes and SHA-256 hashes, and caches them locally. These files are model/data payloads only and are never executed as extension code.

PP-OCRv5 model assets are released by PaddlePaddle under the terms published with their upstream model repositories (Apache-2.0 at the time this notice was written).

## fzstd

PageLingo bundles `fzstd` to decompress Mozilla's Zstandard-compressed Firefox translation model attachments locally in the extension.

- Project: fzstd
- Package: `fzstd` 0.1.1
- Copyright: Copyright (c) 2020 Arjun Barrett
- License: MIT

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.


## Dependency versions

The exact npm dependency graph used for release builds is pinned by `package-lock.json`. Build-time tools are not shipped as executable extension dependencies unless their output is explicitly copied or bundled by `tools/build.mjs`.
