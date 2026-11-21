import { languageLabel } from "../shared/settings";
import { isLoopbackHostname } from "../shared/network-endpoint";
import type { ExternalTranslationEngineType, TranslationEngineConfig } from "../shared/translation-engine-settings";

export interface ExternalTranslationTerminologyEntry {
  source: string;
  target: string;
  mode: "protect" | "replace";
}

export interface ExternalTranslationRequest {
  html: string;
  sourceLanguage: string;
  targetLanguage: string;
  terminology?: ExternalTranslationTerminologyEntry[];
}

const DEFAULT_LLM_PROMPT = "Translate only the human-readable text inside the HTML from {{source}} to {{target}}. Preserve every HTML tag, tag order, placeholder, URL, and attribute exactly. Output only the translated HTML. Do not use Markdown or add explanations.";
const DEFAULT_LLM_BATCH_PROMPT = "Translate each numbered HTML segment from {{source}} to {{target}}. Preserve every HTML tag, attribute (including id), placeholder (such as __FLT_OPAQUE_0__), and segment wrapper [[SEG_N]]...[[/SEG_N]] exactly. Translate only human-readable text. Output only the translated segments in the exact same [[SEG_N]]...[[/SEG_N]] format without Markdown fences or explanations.";
const EXTERNAL_REQUEST_TIMEOUT_MS = 35_000;
const OPENCODE_GO_SESSION_ID = "pagelingo";
const RETRYABLE_HTTP_STATUSES = new Set([429, 502, 503, 504]);
const MAX_HTTP_RETRIES = 2;
const VOID_HTML_TAGS = new Set(["br", "wbr", "hr", "img", "input", "meta", "link"]);

const COMPACT_LINK_PATTERN = /<a\s+data-flt-link-id="(\d+)"\s+href="https:\/\/pagelingo\.invalid\/__link\/\1"><code>__FLT_LINK_START_\1__<\/code>([\s\S]*?)<code>__FLT_LINK_END_\1__<\/code><\/a>/g;

type OpenAiThinkingMode = "none" | "low" | "off";
type GeminiThinkingMode = "zero" | "off";

const openAiThinkingCache = new Map<string, OpenAiThinkingMode>();
const geminiThinkingCache = new Map<string, GeminiThinkingMode>();

export function resetThinkingModeCache(): void {
  openAiThinkingCache.clear();
  geminiThinkingCache.clear();
}

export function externalEngineIsLlm(type: ExternalTranslationEngineType): boolean {
  return type === "gemini"
    || type === "openrouter"
    || type === "opencode-go"
    || type === "deepseek"
    || type === "openai-compatible";
}

export function externalEngineSupportsBatch(type: ExternalTranslationEngineType): boolean {
  return type === "microsoft"
    || type === "google"
    || type === "deepl"
    || externalEngineIsLlm(type);
}

function trimSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function apiLanguage(code: string, type: TranslationEngineConfig["type"]): string {
  if (type === "google") {
    if (code === "zh-Hans") return "zh-CN";
    if (code === "zh-Hant") return "zh-TW";
    if (code === "nb") return "no";
  }
  if (type === "libretranslate") {
    if (code === "zh-Hans") return "zh";
    if (code === "zh-Hant") return "zt";
  }
  return code;
}

function deepLLanguage(code: string, direction: "source" | "target"): string {
  if (code === "zh-Hans") return direction === "target" ? "ZH-HANS" : "ZH";
  if (code === "zh-Hant") return direction === "target" ? "ZH-HANT" : "ZH";
  if (code === "en" && direction === "target") return "EN-US";
  return code.toUpperCase();
}

interface ParsedTagToken {
  closing: boolean;
  selfClosing: boolean;
  name: string;
}

function parseTagTokens(html: string): ParsedTagToken[] {
  return Array.from(
    html.matchAll(/<\s*(\/?)\s*([a-zA-Z0-9-]+)(?:\s[^>]*)?(\/?)\s*>/g),
    (match) => ({
      closing: Boolean(match[1]),
      selfClosing: Boolean(match[3]),
      name: (match[2] ?? "").toLowerCase(),
    }),
  );
}

function tagTokensBalanced(tokens: readonly ParsedTagToken[]): boolean {
  const stack: string[] = [];
  for (const token of tokens) {
    if (VOID_HTML_TAGS.has(token.name) || token.selfClosing) continue;
    if (!token.closing) {
      stack.push(token.name);
      continue;
    }
    const top = stack.pop();
    if (top !== token.name) return false;
  }
  return stack.length === 0;
}

function sortedTagMultiset(tokens: readonly ParsedTagToken[]): string[] {
  return tokens
    .map((token) => `${token.closing ? "/" : ""}${token.name}`)
    .sort();
}

function opaquePlaceholders(html: string): string[] {
  return Array.from(html.matchAll(/__FLT_OPAQUE_\d+__/g), (match) => match[0]);
}

export function validateTranslatedHtml(sourceHtml: string, translatedHtml: string): string {
  const normalized = translatedHtml.trim();
  if (!normalized) throw new Error("翻译服务返回了空内容");
  const sourceTokens = parseTagTokens(sourceHtml);
  const translatedTokens = parseTagTokens(normalized);
  const sourceMultiset = sortedTagMultiset(sourceTokens);
  const translatedMultiset = sortedTagMultiset(translatedTokens);
  if (
    sourceMultiset.length !== translatedMultiset.length
    || sourceMultiset.some((tag, index) => tag !== translatedMultiset[index])
    || (tagTokensBalanced(sourceTokens) && !tagTokensBalanced(translatedTokens))
  ) {
    throw new Error("翻译服务改变了 HTML 结构，已拒绝写入页面");
  }
  const sourceOpaque = opaquePlaceholders(sourceHtml).sort();
  const translatedOpaque = opaquePlaceholders(normalized).sort();
  if (sourceOpaque.length !== translatedOpaque.length || sourceOpaque.some((token, index) => token !== translatedOpaque[index])) {
    throw new Error("翻译服务改变了代码占位符，已拒绝写入页面");
  }
  return normalized;
}

function stripCodeFence(value: string): string {
  const trimmed = value.trim();
  const match = trimmed.match(/^```(?:html|xml|text)?\s*([\s\S]*?)\s*```$/i);
  return match?.[1]?.trim() ?? trimmed;
}

interface CompactedLinkHtml {
  html: string;
  compactedIds: string[];
}

export function compactLinkTransportForLlm(html: string): CompactedLinkHtml {
  const compactedIds: string[] = [];
  const compacted = html.replace(COMPACT_LINK_PATTERN, (_match, id: string, label: string) => {
    compactedIds.push(id);
    return `<a id="${id}">${label}</a>`;
  });
  return { html: compacted, compactedIds };
}

export function expandLinkTransportFromLlm(html: string, compactedIds: readonly string[]): string {
  if (compactedIds.length === 0) return html;
  const idSet = new Set(compactedIds);
  const matchedIds = new Set<string>();
  let expanded = html.replace(
    /<a\b[^>]*\b(?:id|data-flt-link-id)=["']?(\d+)["']?[^>]*>([\s\S]*?)<\/a>/gi,
    (full, id: string, label: string) => {
      if (!idSet.has(id) || matchedIds.has(id)) return full;
      matchedIds.add(id);
      return `<a data-flt-link-id="${id}" href="https://pagelingo.invalid/__link/${id}"><code>__FLT_LINK_START_${id}__</code>${label}<code>__FLT_LINK_END_${id}__</code></a>`;
    },
  );
  // If a single compacted link lost its id attribute but survived as the sole <a>, restore it safely.
  if (matchedIds.size === 0 && compactedIds.length === 1) {
    const bareLinks = expanded.match(/<a\b[^>]*>[\s\S]*?<\/a>/gi);
    if (bareLinks?.length === 1) {
      const onlyId = compactedIds[0]!;
      expanded = expanded.replace(/<a\b[^>]*>([\s\S]*?)<\/a>/i, (_full, label: string) =>
        `<a data-flt-link-id="${onlyId}" href="https://pagelingo.invalid/__link/${onlyId}"><code>__FLT_LINK_START_${onlyId}__</code>${label}<code>__FLT_LINK_END_${onlyId}__</code></a>`,
      );
    }
  }
  return expanded;
}

function terminologyPrompt(entries: ExternalTranslationTerminologyEntry[] | undefined): string {
  if (!entries?.length) return "";
  const hard = entries.filter((entry) => entry.mode === "protect");
  const preferred = entries.filter((entry) => entry.mode === "replace");
  const lines = [
    "",
    "Terminology rules for this segment:",
    ...hard.map((entry) => `- KEEP EXACTLY, character-for-character: ${entry.source}`),
    ...preferred.map((entry) => `- PREFERRED TRANSLATION: ${entry.source} => ${entry.target}`),
    "Apply these rules while translating the complete sentence; do not omit surrounding context.",
  ];
  return lines.join("\n");
}

function mergeBatchTerminology(requests: readonly ExternalTranslationRequest[]): ExternalTranslationTerminologyEntry[] {
  const unique = new Map<string, ExternalTranslationTerminologyEntry>();
  for (const request of requests) {
    for (const entry of request.terminology ?? []) {
      const key = `${entry.mode}\u0000${entry.source.toLocaleLowerCase()}`;
      if (!unique.has(key)) unique.set(key, entry);
    }
  }
  return Array.from(unique.values());
}

function renderPrompt(config: TranslationEngineConfig, request: ExternalTranslationRequest): string {
  const template = config.prompt || DEFAULT_LLM_PROMPT;
  return template
    .replaceAll("{{source}}", languageLabel(request.sourceLanguage))
    .replaceAll("{{target}}", languageLabel(request.targetLanguage))
    + terminologyPrompt(request.terminology);
}

function renderBatchSystemPrompt(config: TranslationEngineConfig, sourceLanguage: string, targetLanguage: string): string {
  const source = languageLabel(sourceLanguage);
  const target = languageLabel(targetLanguage);
  const base = DEFAULT_LLM_BATCH_PROMPT
    .replaceAll("{{source}}", source)
    .replaceAll("{{target}}", target);
  if (!config.prompt?.trim()) return base;
  const custom = config.prompt
    .replaceAll("{{source}}", source)
    .replaceAll("{{target}}", target);
  return `${base}\n\nAdditional style/translation instructions:\n${custom}`;
}

function responseErrorDetail(raw: string): string {
  const compact = raw.replace(/\s+/g, " ").trim();
  if (!compact) return "";
  try {
    const parsed = JSON.parse(compact) as {
      message?: unknown;
      error?: unknown;
    };
    const nested = parsed?.error;
    if (nested && typeof nested === "object") {
      const outer = nested as { message?: unknown; error?: unknown };
      if (typeof outer.message === "string" && outer.message.trim()) return outer.message.trim().slice(0, 600);
      if (outer.error && typeof outer.error === "object") {
        const inner = outer.error as { message?: unknown };
        if (typeof inner.message === "string" && inner.message.trim()) return inner.message.trim().slice(0, 600);
      }
    }
    if (typeof parsed?.message === "string" && parsed.message.trim()) return parsed.message.trim().slice(0, 600);
  } catch {}
  return compact.slice(0, 600);
}

class HttpRequestError extends Error {
  readonly status: number;
  readonly detail: string;

  constructor(status: number, detail: string) {
    super(`翻译服务请求失败：HTTP ${status}${detail ? ` · ${detail}` : ""}`);
    this.status = status;
    this.detail = detail;
  }
}

function parseRetryAfterMs(headerValue: string | null, attempt: number): number {
  if (headerValue) {
    const seconds = Number(headerValue);
    if (Number.isFinite(seconds) && seconds > 0) {
      return Math.min(3000, Math.round(seconds * 1000));
    }
  }
  return Math.min(2000, 350 * (2 ** attempt));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, ms));
}

async function jsonRequest(url: string, init: RequestInit): Promise<unknown> {
  for (let attempt = 0; attempt <= MAX_HTTP_RETRIES; attempt += 1) {
    const controller = new AbortController();
    const timeout = globalThis.setTimeout(() => controller.abort(), EXTERNAL_REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(url, { ...init, signal: controller.signal });
      if (!response.ok) {
        const detail = responseErrorDetail(await response.text());
        if (RETRYABLE_HTTP_STATUSES.has(response.status) && attempt < MAX_HTTP_RETRIES) {
          const waitMs = parseRetryAfterMs(response.headers?.get("retry-after") ?? null, attempt);
          await delay(waitMs);
          continue;
        }
        throw new HttpRequestError(response.status, detail);
      }
      try {
        return await response.json();
      } catch {
        throw new Error("翻译服务返回了无效 JSON");
      }
    } catch (error) {
      if (controller.signal.aborted) throw new Error("翻译服务请求超时，请稍后重试");
      throw error;
    } finally {
      globalThis.clearTimeout(timeout);
    }
  }
  throw new Error("翻译服务请求失败");
}

function isThinkingParamRejection(error: unknown): boolean {
  if (!(error instanceof HttpRequestError) || (error.status !== 400 && error.status !== 422)) return false;
  return /\b(?:reasoning|reasoning_effort|thinking|thinkingConfig|thinkingBudget|extra_forbidden|unrecognized|unknown field|unknown name|unsupported.*(?:parameter|value)|invalid.*effort)\b/i.test(error.detail);
}

function requireBaseUrl(config: TranslationEngineConfig, fallback: string): string {
  const value = config.baseUrl || fallback;
  try {
    const url = new URL(value);
    if (url.username || url.password) throw new Error();
    const allowed = url.protocol === "https:" || (url.protocol === "http:" && isLoopbackHostname(url.hostname));
    if (!allowed) throw new Error();
  } catch {
    throw new Error("翻译引擎地址必须使用 HTTPS；仅 localhost/127.0.0.1/[::1] 可使用 HTTP");
  }
  return trimSlash(value);
}

function requireApiKey(config: TranslationEngineConfig): string {
  if (!config.apiKey) throw new Error("请填写 API Key");
  return config.apiKey;
}

function requireModel(config: TranslationEngineConfig): string {
  if (!config.model) throw new Error("请填写模型名称");
  return config.model;
}

async function translateMicrosoftMany(
  config: TranslationEngineConfig,
  requests: readonly ExternalTranslationRequest[],
): Promise<string[]> {
  const first = requests[0]!;
  const base = requireBaseUrl(config, "https://api.cognitive.microsofttranslator.com");
  const key = requireApiKey(config);
  const from = encodeURIComponent(apiLanguage(first.sourceLanguage, config.type));
  const to = encodeURIComponent(apiLanguage(first.targetLanguage, config.type));
  const headers: Record<string, string> = { "Content-Type": "application/json", "Ocp-Apim-Subscription-Key": key };
  if (config.region) headers["Ocp-Apim-Subscription-Region"] = config.region;
  const result = await jsonRequest(`${base}/translate?api-version=3.0&from=${from}&to=${to}&textType=html`, {
    method: "POST",
    headers,
    body: JSON.stringify(requests.map((request) => ({ Text: request.html }))),
  }) as Array<{ translations?: Array<{ text?: string }> }>;
  if (!Array.isArray(result) || result.length !== requests.length) {
    throw new Error("Microsoft Translator 返回格式异常");
  }
  return result.map((entry) => {
    const html = entry?.translations?.[0]?.text;
    if (typeof html !== "string") throw new Error("Microsoft Translator 返回格式异常");
    return html;
  });
}

async function translateMicrosoft(config: TranslationEngineConfig, request: ExternalTranslationRequest): Promise<string> {
  const results = await translateMicrosoftMany(config, [request]);
  return results[0]!;
}

async function translateGoogleMany(
  config: TranslationEngineConfig,
  requests: readonly ExternalTranslationRequest[],
): Promise<string[]> {
  const first = requests[0]!;
  const endpoint = config.baseUrl || "https://translation.googleapis.com/language/translate/v2";
  const q = requests.length === 1 ? first.html : requests.map((request) => request.html);
  const result = await jsonRequest(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": requireApiKey(config) },
    body: JSON.stringify({
      q,
      source: apiLanguage(first.sourceLanguage, config.type),
      target: apiLanguage(first.targetLanguage, config.type),
      format: "html",
    }),
  }) as { data?: { translations?: Array<{ translatedText?: string }> } };
  const translations = result.data?.translations;
  if (!Array.isArray(translations) || translations.length !== requests.length) {
    throw new Error("Google Cloud Translation 返回格式异常");
  }
  return translations.map((entry) => {
    const html = entry?.translatedText;
    if (typeof html !== "string") throw new Error("Google Cloud Translation 返回格式异常");
    return html;
  });
}

async function translateGoogle(config: TranslationEngineConfig, request: ExternalTranslationRequest): Promise<string> {
  const results = await translateGoogleMany(config, [request]);
  return results[0]!;
}

async function translateDeepLMany(
  config: TranslationEngineConfig,
  requests: readonly ExternalTranslationRequest[],
): Promise<string[]> {
  const first = requests[0]!;
  const key = requireApiKey(config);
  const configuredBase = trimSlash(config.baseUrl);
  const defaultBase = key.endsWith(":fx") ? "https://api-free.deepl.com/v2" : "https://api.deepl.com/v2";
  const usesOfficialDefault = !configuredBase
    || configuredBase === "https://api.deepl.com/v2"
    || configuredBase === "https://api-free.deepl.com/v2";
  const base = usesOfficialDefault
    ? requireBaseUrl({ ...config, baseUrl: "" }, defaultBase)
    : requireBaseUrl(config, defaultBase);
  const endpoint = base.endsWith("/translate") ? base : `${base}/translate`;
  const body: Record<string, unknown> = {
    text: requests.map((request) => request.html),
    target_lang: deepLLanguage(first.targetLanguage, "target"),
    tag_handling: "html",
  };
  if (first.sourceLanguage && first.sourceLanguage !== "auto") {
    body.source_lang = deepLLanguage(first.sourceLanguage, "source");
  }
  const result = await jsonRequest(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `DeepL-Auth-Key ${key}`,
    },
    body: JSON.stringify(body),
  }) as { translations?: Array<{ text?: string }> };
  const translations = result.translations;
  if (!Array.isArray(translations) || translations.length !== requests.length) {
    throw new Error("DeepL API 返回格式异常");
  }
  return translations.map((entry) => {
    const html = entry?.text;
    if (typeof html !== "string") throw new Error("DeepL API 返回格式异常");
    return html;
  });
}

async function translateDeepL(config: TranslationEngineConfig, request: ExternalTranslationRequest): Promise<string> {
  const results = await translateDeepLMany(config, [request]);
  return results[0]!;
}

async function translateLibre(config: TranslationEngineConfig, request: ExternalTranslationRequest): Promise<string> {
  const base = requireBaseUrl(config, "https://libretranslate.com");
  const endpoint = base.endsWith("/translate") ? base : `${base}/translate`;
  const body: Record<string, string> = {
    q: request.html,
    source: apiLanguage(request.sourceLanguage, config.type),
    target: apiLanguage(request.targetLanguage, config.type),
    format: "html",
  };
  if (config.apiKey) body.api_key = config.apiKey;
  const result = await jsonRequest(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }) as { translatedText?: string };
  if (typeof result.translatedText !== "string") throw new Error("LibreTranslate 返回格式异常");
  return result.translatedText;
}

function isOpenCodeGoUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.hostname.toLowerCase() === "opencode.ai" && /^\/zen\/go\/v1(?:\/|$)/.test(url.pathname);
  } catch {
    return false;
  }
}

function openAiBaseFallback(type: ExternalTranslationEngineType): string {
  return type === "openrouter"
    ? "https://openrouter.ai/api/v1"
    : type === "opencode-go"
      ? "https://opencode.ai/zen/go/v1"
      : type === "deepseek"
        ? "https://api.deepseek.com"
        : "";
}

function extractOpenAiContent(result: {
  choices?: Array<{ message?: { content?: string | Array<{ type?: string; text?: string }> } }>;
}): string {
  const content = result.choices?.[0]?.message?.content;
  if (typeof content === "string") return stripCodeFence(content);
  if (Array.isArray(content)) {
    const text = content.map((part) => typeof part.text === "string" ? part.text : "").join("").trim();
    if (text) return stripCodeFence(text);
  }
  throw new Error("LLM 返回格式异常");
}

async function callOpenAiCompatibleChat(
  config: TranslationEngineConfig,
  messages: Array<{ role: string; content: string }>,
): Promise<string> {
  const base = requireBaseUrl(config, openAiBaseFallback(config.type));
  const endpoint = base.endsWith("/chat/completions") ? base : `${base}/chat/completions`;
  const model = requireModel(config);
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
  if (config.type === "openrouter") headers["X-OpenRouter-Title"] = "PageLingo";
  if (config.type === "opencode-go" || isOpenCodeGoUrl(base)) headers["x-opencode-session"] = OPENCODE_GO_SESSION_ID;

  const cacheKey = `${endpoint}\u0000${model}`;
  const modes: OpenAiThinkingMode[] = config.disableThinking === false
    ? ["off"]
    : (() => {
        const cached = openAiThinkingCache.get(cacheKey);
        if (cached === "off") return ["off"];
        if (cached === "low") return ["low", "off"];
        return ["none", "low", "off"];
      })();

  let lastError: unknown;
  for (const mode of modes) {
    const payload: Record<string, unknown> = {
      model,
      messages,
      temperature: 0,
    };
    if (mode !== "off") {
      payload.reasoning_effort = mode;
    }
    try {
      const result = await jsonRequest(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      }) as { choices?: Array<{ message?: { content?: string | Array<{ type?: string; text?: string }> } }> };
      if (config.disableThinking !== false) openAiThinkingCache.set(cacheKey, mode);
      return extractOpenAiContent(result);
    } catch (error) {
      lastError = error;
      if (mode !== "off" && isThinkingParamRejection(error)) {
        const nextMode: OpenAiThinkingMode = mode === "none" ? "low" : "off";
        openAiThinkingCache.set(cacheKey, nextMode);
        continue;
      }
      throw error;
    }
  }
  throw lastError;
}

async function translateOpenAiCompatible(config: TranslationEngineConfig, request: ExternalTranslationRequest): Promise<string> {
  const compacted = compactLinkTransportForLlm(request.html);
  const raw = await callOpenAiCompatibleChat(config, [
    { role: "system", content: renderPrompt(config, request) },
    { role: "user", content: compacted.html },
  ]);
  return expandLinkTransportFromLlm(raw, compacted.compactedIds);
}

async function callGeminiPrompt(
  config: TranslationEngineConfig,
  systemInstruction: string | null,
  userContent: string,
): Promise<string> {
  const base = requireBaseUrl(config, "https://generativelanguage.googleapis.com/v1beta");
  const model = encodeURIComponent(requireModel(config));
  const endpoint = `${base}/models/${model}:generateContent`;
  const cacheKey = `${endpoint}`;
  const modes: GeminiThinkingMode[] = config.disableThinking === false
    ? ["off"]
    : geminiThinkingCache.get(cacheKey) === "off"
      ? ["off"]
      : ["zero", "off"];

  let lastError: unknown;
  for (const mode of modes) {
    const body: Record<string, unknown> = {
      contents: [{ role: "user", parts: [{ text: userContent }] }],
      generationConfig: mode === "zero"
        ? { temperature: 0, thinkingConfig: { thinkingBudget: 0 } }
        : { temperature: 0 },
    };
    if (systemInstruction) {
      body.systemInstruction = { parts: [{ text: systemInstruction }] };
    }
    try {
      const result = await jsonRequest(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": requireApiKey(config) },
        body: JSON.stringify(body),
      }) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
      if (config.disableThinking !== false) geminiThinkingCache.set(cacheKey, mode);
      const text = result.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("").trim();
      if (!text) throw new Error("Gemini 返回格式异常");
      return stripCodeFence(text);
    } catch (error) {
      lastError = error;
      if (mode === "zero" && isThinkingParamRejection(error)) {
        geminiThinkingCache.set(cacheKey, "off");
        continue;
      }
      throw error;
    }
  }
  throw lastError;
}

async function translateGemini(config: TranslationEngineConfig, request: ExternalTranslationRequest): Promise<string> {
  const compacted = compactLinkTransportForLlm(request.html);
  const raw = await callGeminiPrompt(
    config,
    null,
    `${renderPrompt(config, request)}\n\nHTML:\n${compacted.html}`,
  );
  return expandLinkTransportFromLlm(raw, compacted.compactedIds);
}

function chooseBatchTagPrefix(inputs: readonly string[]): string {
  let prefix = "SEG";
  let suffix = 0;
  while (inputs.some((input) => input.includes(`[[${prefix}_`) || input.includes(`[[/${prefix}_`))) {
    suffix += 1;
    prefix = `PLSEG${suffix}`;
  }
  return prefix;
}

function parseTaggedBatchOutput(raw: string, prefix: string, expectedCount: number): Map<number, string> {
  const parsed = new Map<number, string>();
  const cleaned = stripCodeFence(raw);
  const pattern = new RegExp(`\\[\\[${prefix}_(\\d+)\\]\\]\\s*([\\s\\S]*?)\\s*\\[\\[\\/${prefix}_\\1\\]\\]`, "g");
  for (const match of cleaned.matchAll(pattern)) {
    const index = Number.parseInt(match[1] ?? "-1", 10);
    if (!Number.isInteger(index) || index < 0 || index >= expectedCount) continue;
    if (parsed.has(index)) {
      parsed.delete(index);
      continue;
    }
    parsed.set(index, (match[2] ?? "").trim());
  }
  return parsed;
}

async function translateLlmBatch(
  config: TranslationEngineConfig,
  requests: readonly ExternalTranslationRequest[],
): Promise<string[]> {
  const first = requests[0]!;
  const compactedItems = requests.map((request) => compactLinkTransportForLlm(request.html));
  const prefix = chooseBatchTagPrefix(compactedItems.map((item) => item.html));

  let systemPrompt = renderBatchSystemPrompt(config, first.sourceLanguage, first.targetLanguage);
  if (prefix !== "SEG") {
    systemPrompt = systemPrompt.replaceAll("SEG_", `${prefix}_`);
  }

  const mergedTerms = mergeBatchTerminology(requests);
  const termBlock = terminologyPrompt(mergedTerms).trim();
  const segmentsBlock = compactedItems
    .map((item, index) => `[[${prefix}_${index}]]\n${item.html}\n[[/${prefix}_${index}]]`)
    .join("\n");
  const userMessage = termBlock ? `${termBlock}\n\n${segmentsBlock}` : segmentsBlock;

  const rawOutput = config.type === "gemini"
    ? await callGeminiPrompt(config, systemPrompt, userMessage)
    : await callOpenAiCompatibleChat(config, [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ]);

  const parsedMap = parseTaggedBatchOutput(rawOutput, prefix, requests.length);
  const results = new Array<string>(requests.length);
  const failedIndexes: number[] = [];

  for (let index = 0; index < requests.length; index += 1) {
    const candidate = parsedMap.get(index);
    if (candidate === undefined) {
      failedIndexes.push(index);
      continue;
    }
    try {
      const expanded = expandLinkTransportFromLlm(candidate, compactedItems[index]!.compactedIds);
      results[index] = validateTranslatedHtml(requests[index]!.html, expanded);
    } catch {
      failedIndexes.push(index);
    }
  }

  if (failedIndexes.length === requests.length) {
    throw new Error("批量翻译返回格式无法解析，将自动降级为单段翻译");
  }

  if (failedIndexes.length > 0) {
    await Promise.all(failedIndexes.map(async (index) => {
      results[index] = await translateWithExternalEngine(config, requests[index]!);
    }));
  }

  return results;
}

function parseJson(value: string, label: string): unknown {
  if (!value.trim()) return {};
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`${label} 不是有效 JSON`);
  }
}

function parseObjectJson(value: string, label: string): Record<string, unknown> {
  const parsed = parseJson(value, label);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${label} 必须是 JSON 对象`);
  return parsed as Record<string, unknown>;
}

function replaceTemplate(value: unknown, values: Record<string, string>): unknown {
  if (typeof value === "string") {
    if (Object.prototype.hasOwnProperty.call(values, value.slice(2, -2)) && /^\{\{[a-zA-Z]+\}\}$/.test(value)) {
      return values[value.slice(2, -2)] ?? "";
    }
    let next = value;
    for (const [key, replacement] of Object.entries(values)) next = next.replaceAll(`{{${key}}}`, replacement);
    return next;
  }
  if (Array.isArray(value)) return value.map((item) => replaceTemplate(item, values));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, replaceTemplate(item, values)]));
  }
  return value;
}

function valueAtPath(value: unknown, path: string): unknown {
  let current = value;
  for (const part of path.split(".").filter(Boolean)) {
    if (Array.isArray(current) && /^\d+$/.test(part)) current = current[Number(part)];
    else if (current && typeof current === "object") current = (current as Record<string, unknown>)[part];
    else return undefined;
  }
  return current;
}

async function translateCustomRest(config: TranslationEngineConfig, request: ExternalTranslationRequest): Promise<string> {
  const endpoint = requireBaseUrl(config, "");
  if (!config.bodyJson || !config.responsePath) throw new Error("自定义 REST 需要请求体模板和响应路径");
  const values = {
    html: request.html,
    source: request.sourceLanguage,
    target: request.targetLanguage,
    sourceLabel: languageLabel(request.sourceLanguage),
    targetLabel: languageLabel(request.targetLanguage),
    terminology: (request.terminology ?? [])
      .map((entry) => entry.mode === "protect" ? `${entry.source} = ${entry.source}` : `${entry.source} = ${entry.target}`)
      .join("\n"),
    apiKey: config.apiKey,
    model: config.model,
  };
  const rawHeaders = parseObjectJson(config.headersJson, "请求头");
  const headersValue = replaceTemplate(rawHeaders, values) as Record<string, unknown>;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  for (const [key, value] of Object.entries(headersValue)) if (typeof value === "string") headers[key] = value;
  const bodyTemplate = parseJson(config.bodyJson, "请求体模板");
  const result = await jsonRequest(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(replaceTemplate(bodyTemplate, values)),
  });
  const html = valueAtPath(result, config.responsePath);
  if (typeof html !== "string") throw new Error("自定义 REST 响应路径没有得到字符串");
  return html;
}


export interface ExternalModelInfo {
  id: string;
  name?: string | undefined;
  ownedBy?: string | undefined;
  contextWindow?: number | undefined;
  maxOutputTokens?: number | undefined;
}

function modelListEndpoint(base: string): string {
  const trimmed = trimSlash(base);
  if (trimmed.endsWith("/models")) return trimmed;
  if (trimmed.endsWith("/chat/completions")) return `${trimmed.slice(0, -"/chat/completions".length)}/models`;
  return `${trimmed}/models`;
}

export async function listExternalTranslationModels(config: TranslationEngineConfig): Promise<ExternalModelInfo[]> {
  if (!["openrouter", "opencode-go", "deepseek", "openai-compatible"].includes(config.type)) {
    throw new Error("当前翻译引擎不支持自动获取模型");
  }
  const base = requireBaseUrl(config, openAiBaseFallback(config.type));
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
  if (config.type === "opencode-go" || isOpenCodeGoUrl(base)) headers["x-opencode-session"] = OPENCODE_GO_SESSION_ID;
  if (config.type === "openrouter") headers["X-OpenRouter-Title"] = "PageLingo";
  const result = await jsonRequest(modelListEndpoint(base), { method: "GET", headers }) as {
    data?: Array<{
      id?: unknown;
      name?: unknown;
      owned_by?: unknown;
      ownedBy?: unknown;
      context_window?: unknown;
      contextWindow?: unknown;
      max_output_tokens?: unknown;
      maxOutputTokens?: unknown;
    }>;
  };
  const models = Array.isArray(result.data)
    ? result.data
        .map((item) => ({
          id: typeof item?.id === "string" ? item.id.trim() : "",
          name: typeof item?.name === "string" ? item.name.trim() : undefined,
          ownedBy: typeof item?.owned_by === "string"
            ? item.owned_by
            : typeof item?.ownedBy === "string"
              ? item.ownedBy
              : undefined,
          contextWindow: typeof item?.context_window === "number"
            ? item.context_window
            : typeof item?.contextWindow === "number"
              ? item.contextWindow
              : undefined,
          maxOutputTokens: typeof item?.max_output_tokens === "number"
            ? item.max_output_tokens
            : typeof item?.maxOutputTokens === "number"
              ? item.maxOutputTokens
              : undefined,
        }))
        .filter((item) => item.id)
    : [];
  if (!models.length) throw new Error("模型列表为空或返回格式不兼容");
  return models.sort((a, b) => a.id.localeCompare(b.id));
}

export async function translateWithExternalEngine(
  config: TranslationEngineConfig,
  request: ExternalTranslationRequest,
): Promise<string> {
  let translated: string;
  switch (config.type) {
    case "microsoft": translated = await translateMicrosoft(config, request); break;
    case "google": translated = await translateGoogle(config, request); break;
    case "deepl": translated = await translateDeepL(config, request); break;
    case "libretranslate": translated = await translateLibre(config, request); break;
    case "gemini": translated = await translateGemini(config, request); break;
    case "openrouter":
    case "opencode-go":
    case "deepseek":
    case "openai-compatible": translated = await translateOpenAiCompatible(config, request); break;
    case "custom-rest": translated = await translateCustomRest(config, request); break;
  }
  return validateTranslatedHtml(request.html, translated);
}

export async function translateBatchWithExternalEngine(
  config: TranslationEngineConfig,
  requests: readonly ExternalTranslationRequest[],
): Promise<string[]> {
  if (requests.length === 0) return [];
  if (requests.length === 1) {
    return [await translateWithExternalEngine(config, requests[0]!)];
  }
  if (!externalEngineSupportsBatch(config.type)) {
    throw new Error("当前外部引擎不支持批量请求");
  }
  if (externalEngineIsLlm(config.type)) {
    return translateLlmBatch(config, requests);
  }
  let rawList: string[];
  switch (config.type) {
    case "microsoft": rawList = await translateMicrosoftMany(config, requests); break;
    case "google": rawList = await translateGoogleMany(config, requests); break;
    case "deepl": rawList = await translateDeepLMany(config, requests); break;
    default: throw new Error("当前外部引擎不支持批量请求");
  }
  const validated = new Array<string>(requests.length);
  const failedIndexes: number[] = [];
  for (let index = 0; index < requests.length; index += 1) {
    try {
      validated[index] = validateTranslatedHtml(requests[index]!.html, rawList[index] ?? "");
    } catch {
      failedIndexes.push(index);
    }
  }
  if (failedIndexes.length > 0) {
    await Promise.all(failedIndexes.map(async (index) => {
      validated[index] = await translateWithExternalEngine(config, requests[index]!);
    }));
  }
  return validated;
}
