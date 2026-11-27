# PageLingo Privacy Policy

Last updated: 2026-11-28

PageLingo is local-first. The default Firefox/Bergamot translation engine runs inside Firefox and does not send the text of pages you translate to PageLingo or to a translation service.

## Data PageLingo does not collect

PageLingo does not include analytics, advertising, telemetry, tracking pixels, affiliate tags, or a PageLingo-operated backend. PageLingo does not sell user data.

## Local data

PageLingo stores settings, language-pack metadata, optional external-engine configuration, and user-created terminology in Firefox local extension storage. Translation and OCR model files are cached locally.

In normal browsing windows, PageLingo also caches short translated text segments locally to avoid redundant translation work:
- For the default local Firefox/Bergamot engine, short segment translations are held in temporary in-memory background cache only and cleared when the background page unloads or when you clear the cache.
- For optional external engines, short segment translations (up to 8,000 entries, expiring after 14 days) are cached locally in Firefox IndexedDB (`pagelingo-external-translation-cache-v1`) on your device.
- You can view the local cache entry count and clear all translation caches at any time from PageLingo Settings.

API keys for external engines are stored in Firefox `browser.storage.local`. They are not written to the PageLingo source tree or logs, and are not returned to ordinary web pages.

## Local translation models

When a language pack is downloaded or checked for updates, PageLingo connects to Mozilla model registry / Firefox Remote Settings infrastructure to obtain model metadata and model-data files. Model payloads are verified by pinned size and SHA-256 before use. Page content is not sent with these model-download requests.

## Image translation

Image translation is disabled by default. When enabled and invoked by the user, PageLingo may retrieve the selected image URL so Firefox can read its bytes for local OCR. OCR runs locally in a WebAssembly worker.

On first use (or when the user downloads an optional multilingual OCR recognition pack), OCR model-data files are downloaded from the upstream model hosts identified in the source code and verified by pinned size and SHA-256. PageLingo does not send OCR output to a remote service when the Firefox local translation engine is selected.

## Local PDF & document reader

When you open a local PDF, Markdown, HTML, EPUB, DOCX, or TXT file—or choose to open an online PDF/document URL inside PageLingo's built-in reader (`reader.html`)—parsing and rendering run entirely inside Firefox using bundled `pdfjs-dist` and native Web APIs. If you trigger on-demand OCR for scanned PDF pages, the layout and OCR model-data files are downloaded once, verified by pinned size and SHA-256, and run locally in a WebAssembly worker. With the default Firefox local translation engine, document text stays on your device.

## Video subtitle translation

Video soft-subtitle translation is disabled by default. When enabled by the user on a video page (such as YouTube, Bilibili, or standard HTML5 `<track>` videos), PageLingo reads the video's soft subtitle track on the active page and translates cues using the user's chosen translation engine. With the default Firefox local engine, subtitle text stays on your device.

## External translation engines

External translation engines—including the built-in keyless Microsoft Translator (`edge.microsoft.com`) and Google Translate (`translate.googleapis.com`) options as well as user-configured API providers—are optional and are never the default.

If you explicitly select an external engine, text or HTML needed for translation is sent directly from Firefox to that service. Depending on the page, this website content can include text that is personal or sensitive. If an API key is configured, the key is sent only as needed to authenticate translation or live model-list requests to that service.

PageLingo asks Firefox for the relevant optional data-transmission permission (`websiteContent`, and `authenticationInfo` when an API key is used) before an external engine can be used. You can revoke optional data permissions in Firefox and switch back to the local engine at any time.

The external service's own privacy policy and data-retention practices apply to data sent to that service. PageLingo does not proxy these requests through a PageLingo server.

For security, remote external-engine endpoints must use HTTPS. Plain HTTP is allowed only for loopback/local-host endpoints.

## Custom REST engines

Custom REST is an advanced feature. PageLingo substitutes only declared template values into JSON headers/body and reads a configured JSON response path. It does not execute user-provided JavaScript.

## Private browsing

When translating inside a Firefox Private Browsing window (`tab.incognito`), PageLingo bypasses both reading and writing its shared in-memory and IndexedDB translation caches, and does not attach normal-profile cookies to background subtitle requests. Firefox controls whether the extension is allowed to operate in private windows.

## Changes

Material privacy changes will be documented in the repository and reflected in the extension's data-permission declarations when required.
