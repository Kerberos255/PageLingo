# AMO Listing Draft — PageLingo 1.1.2

This file is a submission draft, not runtime configuration.

## Name

PageLingo

## Category

- Language Support

## Summary (English)

Local-first, layout-preserving Firefox translator with offline models, bilingual mode, selection & text translation, local PDF/document reader, multilingual image OCR, and video soft-subtitle translation.

## Description (English)

PageLingo is a local-first translation extension for Firefox designed to preserve the layout, links, controls, code, and interactive behavior of real webpages.

By default, translation runs locally inside Firefox using offline language packs, without sending your webpage text to any external translation service.

Key features:

- **Offline-first webpage translation**: download offline language packs (100+ directional pairs across 50+ languages, with automatic local bridging) and translate webpages cleanly without an API key or account.
- **Translation-only & customizable bilingual mode**: switch effortlessly between translated-only and bilingual views, with configurable reading order, visual themes, font scale, accent colors, hover-to-reveal learning mode, and live preview.
- **Selection & standalone text translation**: right-click selected text (or enable the optional floating translate button) for instant translation, copy, re-translate, and inline bilingual insertion; use the built-in Text Translation tab in the popup for quick two-way snippets.
- **Built-in local PDF & document reader**: open local or online PDF, Markdown, HTML, EPUB, DOCX, and TXT files directly in Firefox with side-by-side and in-place overlay reading modes, formula and table preservation, and on-demand local OCR for scanned PDFs.
- **Optional multilingual image translation**: right-click any webpage image to recognize and translate text locally across 50+ languages (including Chinese, English, Japanese, Latin scripts, plus optional Korean, Cyrillic, and Thai packs) while preserving visual layout.
- **Optional video soft-subtitle translation**: disabled by default; adds a clean on-demand quick toggle to YouTube, Bilibili, and standard HTML5 video players to switch between bilingual, translation-only, and off, with customizable subtitle styling and live preview.
- **Terminology & site/language rules**: built-in proper-name protection plus custom glossaries (preserve exact terms or specify preferred translations), alongside automatic site and language translation rules.
- **Optional external & LLM engines**: optionally switch to built-in keyless Microsoft / Google translation or configure your own API / LLM provider (such as DeepL, OpenAI, Claude, Gemini, DeepSeek, Ollama, OpenAI-compatible, or custom REST) with live model discovery.

Privacy & permissions:

- The default local engine does not transmit webpage text to external servers.
- External translation engines are disabled by default and never required; before using one, Firefox asks for explicit optional data-transmission permission. Remote endpoints must use HTTPS (plain HTTP is allowed only for local loopback services).
- No analytics, no ads, no affiliate injection, and no tracking backend.

## 概述（简体中文）

本地优先的 Firefox 翻译扩展，完整保留网页排版与交互，内置离线翻译、双语对照、划词与文本翻译、PDF/文档阅读器、多语种图片 OCR 及视频软字幕翻译，并可选外部与大模型引擎。

## 描述（简体中文）

PageLingo 是一款本地优先的 Firefox 翻译扩展，在翻译网页的同时完整保留原有版式、链接、按钮、代码与页面交互。默认采用本地离线引擎运行，无需账号或 API 密钥，也不会将网页内容发送到外部服务器。

核心功能：

- **默认本地离线翻译**：支持按需下载多语种离线语言包（覆盖 50+ 常见语言、100+ 翻译方向，并支持本地自动桥接），断网也能顺畅翻译网页。
- **仅译文与可定制双语对照**：随时在「仅译文」和「双语对照」间切换，支持自定义原文/译文顺序、多种视觉样式、字号比例、译文颜色、模糊译文学习模式与实时预览，并支持长页面流畅滚动翻译与混合语言网页/网页邮箱识别。
- **划词翻译与独立文本翻译**：选中文字右键即可一键翻译（也可按需开启轻量浮动按钮），支持中英自动互译、复制、重译与文内插入双语；扩展弹窗内置「网页翻译 / 文本翻译」双标签，随时粘贴片段快速翻译。
- **内置本地 PDF 与文档阅读器**：直接在 Firefox 内打开本地或在线的 PDF、Markdown、HTML、EPUB、DOCX、TXT 文件，支持左右对照与原位覆盖双阅读模式、数学公式与表格保护，以及按需启用的本地扫描版 PDF OCR 识别翻译。
- **可选多语种图片翻译**：默认关闭；开启后右键图片即可在本地识别并翻译文字（默认支持中、英、日及 46 种拉丁语系，另可选韩语、西里尔语系、泰语包），尽量保持原图排版与视觉层次。
- **可选视频软字幕翻译**：默认关闭；开启后在 YouTube、Bilibili 及标准 HTML5 播放器提供简洁的按需快捷按钮，一键切换双语、仅译文或关闭，支持自定义字幕字号、颜色、背景透明度、学习模式，以及仅在主动点击时对同语种视频自动译为第二语言（如中英双语）。
- **术语库与自动化规则**：内置专有名词保护，支持多组自定义术语库（保留原词或指定译法）；灵活配置网站与语言的「总是翻译 / 跳过翻译」规则。
- **可选外部与大语言模型引擎**：除默认离线引擎外，可按需选用内置免密微软/Google 翻译，或接入 DeepL、OpenAI、Claude、Gemini、DeepSeek、通义千问、Kimi、智谱、Ollama、OpenAI 兼容接口及自定义 REST 服务，并支持在线拉取模型列表。

隐私与权限说明：

- 使用默认本地离线引擎时，待译文字仅在浏览器本地处理，不向外部服务发送内容。
- 所有外部翻译引擎均为可选项且默认关闭；启用前会通过 Firefox 可选数据权限征得你的明确授权。公网接口强制 HTTPS（仅本机回环地址允许 HTTP）。
- 无统计追踪、无广告、无推广劫持，不收集个人浏览记录。

## Payment / non-free services

PageLingo itself does not require payment and its default local translation path does not require a paid service.

Optional third-party API providers may require their own account, API key, quota, or payment. Those services are user-configured and are not required for the extension's core local translation functionality.

## Privacy policy

Use the repository `PRIVACY.md` text in the AMO privacy-policy field.

## Support website

https://github.com/Kerberos255/PageLingo/issues

## License

Use an AMO **custom license**:

- Name: PolyForm Noncommercial License 1.0.0
- Text: the complete contents of `LICENSE.md`
- Canonical URL: https://polyformproject.org/licenses/noncommercial/1.0.0/

Third-party components remain under their own licenses as documented in `THIRD_PARTY_NOTICES.md`.

## Reviewer notes

Use `AMO_REVIEW_NOTES.md`.

## Source code submission

PageLingo uses TypeScript plus esbuild bundling, so submit matching source code for every AMO version.

Recommended release source archive after tagging the release:

```bash
git archive --format=zip --prefix=pagelingo-1.1.2-source/ --output pagelingo-1.1.2-source.zip v1.1.2
```

The archive should contain the tracked source tree, lockfile, build tools, bundled Bergamot source/runtime material, licenses, and build instructions. Do not include `node_modules/`, `dist/`, browser profiles, caches, credentials, or local artifacts.

## Compatibility

Target: Firefox desktop (`strict_min_version: 142.0`).
