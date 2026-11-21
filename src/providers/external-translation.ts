import { languageLabel } from "../shared/settings";
import { isLoopbackHostname } from "../shared/network-endpoint";
import {
  OPENCODE_GO_BASE_URL,
  type RuntimeExternalEngineConfig,
  type RuntimeExternalEngineType,
} from "../shared/translation-engine-settings";
import { restoreFixedHtmlTransport } from "../core/fixed-html-transport";
import { assessTranslationQuality } from "../core/translation-quality";

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

const DEFAULT_LLM_PROMPT = "Translate only the human-readable text inside the HTML from {{source}} to {{target}}. Preserve every HTML tag, tag order, placeholder, URL, and attribute exactly. If numbered data-flt-text-id spans are present, translate their text with the whole paragraph as context, keep each ID exactly once in its original parent and order, and put all translated words inside their original spans. Keep data-flt-fixed content and code placeholders exactly unchanged. Output only the translated HTML. Do not use Markdown or add explanations.";
const EXTERNAL_REQUEST_TIMEOUT_MS = 30_000;
const LLM_REQUEST_TIMEOUT_MS = 120_000;
const EDGE_AUTH_TIMEOUT_MS = 15_000;
const OPENCODE_GO_SESSION_ID = "pagelingo";
const EDGE_AUTH_URL = "https://edge.microsoft.com/translate/auth";
const EDGE_TRANSLATE_URL = "https://api-edge.cognitive.microsofttranslator.com/translate";
const GOOGLE_FREE_BATCH_URL = "https://translate.googleapis.com/translate_a/t";
const GOOGLE_FREE_SINGLE_URL = "https://translate.googleapis.com/translate_a/single";

const MAX_ACTIVE_REQUESTS = 8;
const MAX_GOOGLE_FREE_REQUESTS = 3;
const GOOGLE_FREE_MAX_ITEMS_PER_CALL = 20;
const GOOGLE_FREE_MAX_CHARS_PER_CALL = 3_800;

let activeRequests = 0;
const waitingRequests: Array<() => void> = [];
let activeGoogleFreeRequests = 0;
const waitingGoogleFreeRequests: Array<() => void> = [];
let googleFreeCooldownUntil = 0;

interface CachedEdgeToken {
  token: string;
  expiresAtMs: number;
}
let edgeTokenCache: CachedEdgeToken | null = null;
let edgeTokenPromise: Promise<CachedEdgeToken> | null = null;

type OpenAiReasoningMode = "none" | "low" | "omit";
type GeminiThinkingMode = "budget0" | "omit";
const openAiReasoningModeCache = new Map<string, OpenAiReasoningMode>();
const geminiThinkingModeCache = new Map<string, GeminiThinkingMode>();

class HttpStatusError extends Error {
  readonly status: number;
  readonly detail: string;
  readonly retryAfterMs: number | null;

  constructor(status: number, detail: string, retryAfterMs: number | null = null) {
    super(`翻译服务请求失败：HTTP ${status}${detail ? ` · ${detail}` : ""}`);
    this.name = "HttpStatusError";
    this.status = status;
    this.detail = detail;
    this.retryAfterMs = retryAfterMs;
  }
}

export function resetExternalTranslationStateForTests(): void {
  edgeTokenCache = null;
  edgeTokenPromise = null;
  googleFreeCooldownUntil = 0;
  openAiReasoningModeCache.clear();
  geminiThinkingModeCache.clear();
}

export function isFatalExternalError(error: unknown): boolean {
  if (error instanceof HttpStatusError) {
    return error.status === 401 || error.status === 403 || error.status === 402;
  }
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /数据权限|请填写 API Key|请填写模型名称|必须使用 HTTPS|HTTP (?:401|402|403)\b/u.test(message);
}

export function externalBatchSize(config: RuntimeExternalEngineConfig): number {
  if (config.type === "microsoft-free") return 20;
  if (config.type === "google-free") return 16;
  if (["microsoft", "google", "deepl"].includes(config.type)) return 20;
  if (!config.prompt && ["openai-compatible", "opencode-go", "deepseek", "openrouter", "gemini"].includes(config.type)) return 12;
  return 1;
}

function trimSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function apiLanguage(code: string, type: RuntimeExternalEngineType): string {
  if (type === "google" || type === "google-free") {
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

function tagSkeleton(html: string): string[] {
  return Array.from(html.matchAll(/<\s*(\/?)\s*([a-zA-Z0-9-]+)(?:\s[^>]*)?>/g), (match) => `${match[1] ? "/" : ""}${match[2]?.toLowerCase()}`);
}

function opaquePlaceholders(html: string): string[] {
  return Array.from(html.matchAll(/__FLT_OPAQUE_\d+__/g), (match) => match[0]);
}

export function validateTranslatedHtml(sourceHtml: string, translatedHtml: string): string {
  const normalized = translatedHtml.trim();
  if (!normalized) throw new Error("翻译服务返回了空内容");
  const sourceTags = tagSkeleton(sourceHtml);
  const translatedTags = tagSkeleton(normalized);
  if (sourceTags.length !== translatedTags.length || sourceTags.some((tag, index) => tag !== translatedTags[index])) {
    throw new Error("翻译服务改变了 HTML 结构，已拒绝写入页面");
  }
  const sourceOpaque = opaquePlaceholders(sourceHtml);
  const translatedOpaque = opaquePlaceholders(normalized);
  if (sourceOpaque.length !== translatedOpaque.length || sourceOpaque.some((token, index) => token !== translatedOpaque[index])) {
    throw new Error("翻译服务改变了代码占位符，已拒绝写入页面");
  }
  return normalized;
}

function stripCodeFence(value: string): string {
  const trimmed = value.trim();
  const match = trimmed.match(/^```(?:html|json|xml|text)?\s*([\s\S]*?)\s*```$/i);
  return match?.[1]?.trim() ?? trimmed;
}

function terminologyPrompt(entries: readonly ExternalTranslationTerminologyEntry[] | undefined): string {
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

function renderPrompt(config: RuntimeExternalEngineConfig, request: ExternalTranslationRequest): string {
  const template = config.prompt || DEFAULT_LLM_PROMPT;
  return template
    .replaceAll("{{source}}", languageLabel(request.sourceLanguage))
    .replaceAll("{{target}}", languageLabel(request.targetLanguage))
    + terminologyPrompt(request.terminology);
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

function parseRetryAfterMs(response: Response, maxMs: number): number | null {
  const header = response.headers.get("retry-after");
  if (!header) return null;
  const seconds = Number(header.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(maxMs, Math.round(seconds * 1000));
  const dateMs = Date.parse(header);
  if (Number.isFinite(dateMs)) return Math.max(0, Math.min(maxMs, dateMs - Date.now()));
  return null;
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => globalThis.setTimeout(resolve, ms));
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 502 || status === 503 || status === 504;
}

function isThinkingParamError(error: unknown): boolean {
  if (!(error instanceof HttpStatusError)) return false;
  if (error.status !== 400 && error.status !== 422) return false;
  return /reasoning|thinking|effort|unknown.*(?:field|param|property)|unrecognized.*(?:field|param|property)|unsupported.*(?:param|field|value)|extra inputs/iu.test(error.detail);
}

async function withConcurrencySlot<T>(task: () => Promise<T>): Promise<T> {
  if (activeRequests >= MAX_ACTIVE_REQUESTS) {
    await new Promise<void>((resolve) => waitingRequests.push(resolve));
  } else {
    activeRequests += 1;
  }
  try {
    return await task();
  } finally {
    const next = waitingRequests.shift();
    if (next) next();
    else activeRequests -= 1;
  }
}

async function withGoogleFreeSlot<T>(task: () => Promise<T>): Promise<T> {
  if (activeGoogleFreeRequests >= MAX_GOOGLE_FREE_REQUESTS) {
    await new Promise<void>((resolve) => waitingGoogleFreeRequests.push(resolve));
  } else {
    activeGoogleFreeRequests += 1;
  }
  try {
    return await task();
  } finally {
    const next = waitingGoogleFreeRequests.shift();
    if (next) next();
    else activeGoogleFreeRequests -= 1;
  }
}

interface RawFetchOptions {
  timeoutMs?: number;
  maxRetries?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  onRateLimit?: (delayMs: number) => void;
}

async function fetchResponseWithRetry(
  url: string,
  init: RequestInit,
  options: RawFetchOptions = {},
): Promise<Response> {
  const timeoutMs = options.timeoutMs ?? EXTERNAL_REQUEST_TIMEOUT_MS;
  const maxRetries = options.maxRetries ?? 2;
  const baseBackoffMs = options.baseBackoffMs ?? 400;
  const maxBackoffMs = options.maxBackoffMs ?? 3_000;

  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const controller = new AbortController();
    const timeout = globalThis.setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { ...init, signal: controller.signal });
      if (response.ok) return response;
      const detail = responseErrorDetail(await response.text());
      const retryAfterMs = parseRetryAfterMs(response, maxBackoffMs);
      const httpError = new HttpStatusError(response.status, detail, retryAfterMs);
      if (isRetryableStatus(response.status) && attempt < maxRetries) {
        const delayMs = retryAfterMs ?? Math.min(
          maxBackoffMs,
          baseBackoffMs * (2 ** attempt) + Math.floor(Math.random() * 180),
        );
        if (response.status === 429) options.onRateLimit?.(delayMs);
        lastError = httpError;
        globalThis.clearTimeout(timeout);
        await sleep(delayMs);
        continue;
      }
      throw httpError;
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error("翻译服务请求超时，请稍后重试");
      }
      if (error instanceof HttpStatusError) throw error;
      if (attempt < maxRetries) {
        const delayMs = Math.min(maxBackoffMs, baseBackoffMs * (2 ** attempt) + Math.floor(Math.random() * 150));
        lastError = error;
        globalThis.clearTimeout(timeout);
        await sleep(delayMs);
        continue;
      }
      throw error;
    } finally {
      globalThis.clearTimeout(timeout);
    }
  }
  throw lastError ?? new Error("翻译服务请求失败");
}

async function jsonRequest(
  url: string,
  init: RequestInit,
  timeoutMs = EXTERNAL_REQUEST_TIMEOUT_MS,
  options: Omit<RawFetchOptions, "timeoutMs"> = {},
): Promise<unknown> {
  return withConcurrencySlot(async () => {
    const response = await fetchResponseWithRetry(url, init, { ...options, timeoutMs });
    try {
      return await response.json();
    } catch {
      throw new Error("翻译服务返回了无效 JSON");
    }
  });
}

function requireBaseUrl(config: RuntimeExternalEngineConfig, fallback: string): string {
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

function requireApiKey(config: RuntimeExternalEngineConfig): string {
  if (!config.apiKey) throw new Error("请填写 API Key");
  return config.apiKey;
}

function requireModel(config: RuntimeExternalEngineConfig): string {
  if (!config.model) throw new Error("请填写模型名称");
  return config.model;
}

/* -------------------------------------------------------------------------- */
/* Built-in Microsoft Free (Edge Translate JWT auth + batch HTML translation) */
/* -------------------------------------------------------------------------- */

function parseJwtExpiryMs(jwt: string): number {
  const fallback = Date.now() + 8 * 60_000;
  try {
    const parts = jwt.split(".");
    if (parts.length < 2 || !parts[1]) return fallback;
    const base64 = parts[1].replaceAll("-", "+").replaceAll("_", "/");
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
    const payload = JSON.parse(atob(padded)) as { exp?: unknown };
    if (typeof payload.exp === "number" && Number.isFinite(payload.exp) && payload.exp > 0) {
      return payload.exp * 1000;
    }
  } catch {
    // Non-standard token payload; use safe short fallback TTL.
  }
  return fallback;
}

async function getEdgeAuthToken(forceRefresh = false): Promise<string> {
  const now = Date.now();
  if (!forceRefresh && edgeTokenCache && now < edgeTokenCache.expiresAtMs - 60_000) {
    return edgeTokenCache.token;
  }
  if (!edgeTokenPromise) {
    edgeTokenPromise = (async () => {
      const response = await fetchResponseWithRetry(EDGE_AUTH_URL, { method: "GET" }, {
        timeoutMs: EDGE_AUTH_TIMEOUT_MS,
        maxRetries: 1,
        baseBackoffMs: 300,
      });
      const token = (await response.text()).trim();
      if (!token) throw new Error("微软免费翻译令牌获取失败");
      const entry: CachedEdgeToken = { token, expiresAtMs: parseJwtExpiryMs(token) };
      edgeTokenCache = entry;
      return entry;
    })().finally(() => {
      edgeTokenPromise = null;
    });
  }
  const entry = await edgeTokenPromise;
  return entry.token;
}

async function translateMicrosoftFree(
  requests: ExternalTranslationRequest[],
): Promise<Array<string | undefined>> {
  const request = requests[0]!;
  const to = encodeURIComponent(apiLanguage(request.targetLanguage, "microsoft-free"));
  const from = request.sourceLanguage && request.sourceLanguage !== "auto"
    ? encodeURIComponent(apiLanguage(request.sourceLanguage, "microsoft-free"))
    : "";
  const endpoint = `${EDGE_TRANSLATE_URL}?from=${from}&to=${to}&api-version=3.0&textType=html`;
  const payload = JSON.stringify(requests.map(({ html }) => ({ Text: html })));

  const callWithToken = async (token: string) => jsonRequest(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}`,
    },
    body: payload,
  }) as Promise<Array<{ translations?: Array<{ text?: string }> }>>;

  let token = await getEdgeAuthToken(false);
  let result: Array<{ translations?: Array<{ text?: string }> }>;
  try {
    result = await callWithToken(token);
  } catch (error) {
    if (error instanceof HttpStatusError && (error.status === 401 || error.status === 403)) {
      if (edgeTokenCache?.token === token) edgeTokenCache = null;
      token = await getEdgeAuthToken(true);
      result = await callWithToken(token);
    } else {
      throw error;
    }
  }
  if (!Array.isArray(result) || result.length !== requests.length) {
    throw new Error("微软免费翻译返回格式异常");
  }
  return result.map((item) => item?.translations?.[0]?.text);
}

/* -------------------------------------------------------------------------- */
/* Built-in Google Free (Keyless batch endpoint + template-safe reconstruction)*/
/* -------------------------------------------------------------------------- */

interface GoogleFreeSlotRef {
  node: Text;
  leading: string;
  core: string;
  trailing: string;
}

interface GoogleFreeTemplate {
  doc: Document;
  slots: GoogleFreeSlotRef[];
  originalHtml: string;
}

function extractGoogleFreeTemplate(html: string): GoogleFreeTemplate {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const slots: GoogleFreeSlotRef[] = [];
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
  for (let current = walker.nextNode(); current; current = walker.nextNode()) {
    const textNode = current as Text;
    const parent = textNode.parentElement;
    if (parent?.closest("code,kbd,samp,var,[data-flt-fixed],[data-flt-term-id]")) continue;
    const raw = textNode.data;
    const trimmed = raw.trim();
    if (!trimmed) continue;
    if (/^__FLT_(?:OPAQUE|LINK_START|LINK_END)_\d+__$/u.test(trimmed)) continue;
    if (!/\p{L}/u.test(trimmed)) continue;
    const leading = raw.match(/^\s*/u)?.[0] ?? "";
    const trailing = raw.match(/\s*$/u)?.[0] ?? "";
    const core = raw.slice(leading.length, raw.length - trailing.length);
    if (!core) continue;
    slots.push({ node: textNode, leading, core, trailing });
  }
  return { doc, slots, originalHtml: html };
}

function parseGoogleFreeBatchPayload(data: unknown, expectedCount: number): string[] | null {
  if (typeof data === "string") {
    return expectedCount === 1 ? [data] : null;
  }
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const sentences = (data as { sentences?: Array<{ trans?: unknown }> }).sentences;
    if (expectedCount === 1 && Array.isArray(sentences)) {
      const joined = sentences.map((item) => typeof item?.trans === "string" ? item.trans : "").join("");
      return joined ? [joined] : null;
    }
    return null;
  }
  if (!Array.isArray(data)) return null;

  if (expectedCount === 1 && data.length >= 1) {
    if (typeof data[0] === "string" && data.length === 1) return [data[0]];
    if (Array.isArray(data[0]) && typeof data[0][0] === "string" && data.length === 1) return [data[0][0]];
    if (typeof data[0] === "string" && data.length === 2 && typeof data[1] === "string" && /^[a-zA-Z-]{2,10}$/.test(data[1])) {
      return [data[0]];
    }
  }

  if (data.length !== expectedCount) return null;
  const output: string[] = [];
  for (const entry of data) {
    if (typeof entry === "string") {
      output.push(entry);
    } else if (Array.isArray(entry) && typeof entry[0] === "string") {
      output.push(entry[0]);
    } else {
      return null;
    }
  }
  return output;
}

function parseGoogleFreeSinglePayload(data: unknown): string | null {
  if (!Array.isArray(data) || !Array.isArray(data[0])) return null;
  let joined = "";
  for (const part of data[0] as unknown[]) {
    if (Array.isArray(part) && typeof part[0] === "string") joined += part[0];
  }
  return joined || null;
}

async function googleFreeJsonPost(url: string, params: URLSearchParams): Promise<unknown> {
  return withGoogleFreeSlot(() => withConcurrencySlot(async () => {
    const waitMs = googleFreeCooldownUntil - Date.now();
    if (waitMs > 0) await sleep(waitMs);
    const response = await fetchResponseWithRetry(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
      body: params.toString(),
    }, {
      timeoutMs: EXTERNAL_REQUEST_TIMEOUT_MS,
      maxRetries: 3,
      baseBackoffMs: 600,
      maxBackoffMs: 5_000,
      onRateLimit: (delayMs) => {
        googleFreeCooldownUntil = Math.max(googleFreeCooldownUntil, Date.now() + delayMs);
      },
    });
    try {
      return await response.json();
    } catch {
      throw new Error("Google 免费翻译返回了无效 JSON");
    }
  }));
}

async function translateGoogleFreeSingleText(text: string, sl: string, tl: string): Promise<string> {
  const endpoint = `${GOOGLE_FREE_SINGLE_URL}?client=gtx&sl=${encodeURIComponent(sl)}&tl=${encodeURIComponent(tl)}&dt=t`;
  const params = new URLSearchParams();
  params.append("q", text);
  const data = await googleFreeJsonPost(endpoint, params);
  const translated = parseGoogleFreeSinglePayload(data);
  if (translated === null) throw new Error("Google 免费翻译返回格式异常");
  return translated;
}

async function translateGoogleFreeChunk(texts: string[], sl: string, tl: string): Promise<string[]> {
  const endpoint = `${GOOGLE_FREE_BATCH_URL}?client=dict-chrome-ex&sl=${encodeURIComponent(sl)}&tl=${encodeURIComponent(tl)}`;
  const params = new URLSearchParams();
  for (const text of texts) params.append("q", text);
  try {
    const data = await googleFreeJsonPost(endpoint, params);
    const parsed = parseGoogleFreeBatchPayload(data, texts.length);
    if (parsed) return parsed;
  } catch (error) {
    if (error instanceof HttpStatusError && error.status === 429) throw error;
    // Fall back to translate_a/single (client=gtx) when translate_a/t rejects or changes shape.
  }
  const fallbackResults: string[] = [];
  for (const text of texts) {
    fallbackResults.push(await translateGoogleFreeSingleText(text, sl, tl));
  }
  return fallbackResults;
}

async function translateGoogleFree(
  requests: ExternalTranslationRequest[],
): Promise<Array<string | undefined>> {
  const first = requests[0]!;
  const sl = first.sourceLanguage && first.sourceLanguage !== "auto"
    ? apiLanguage(first.sourceLanguage, "google-free")
    : "auto";
  const tl = apiLanguage(first.targetLanguage, "google-free");

  const templates = requests.map((request) => extractGoogleFreeTemplate(request.html));
  const uniqueTexts: string[] = [];
  const textIndex = new Map<string, number>();
  for (const template of templates) {
    for (const slot of template.slots) {
      if (!textIndex.has(slot.core)) {
        textIndex.set(slot.core, uniqueTexts.length);
        uniqueTexts.push(slot.core);
      }
    }
  }

  const translatedByText = new Map<string, string>();
  if (uniqueTexts.length > 0) {
    const chunks: string[][] = [];
    let current: string[] = [];
    let currentChars = 0;
    for (const text of uniqueTexts) {
      if (
        current.length > 0
        && (current.length >= GOOGLE_FREE_MAX_ITEMS_PER_CALL || currentChars + text.length > GOOGLE_FREE_MAX_CHARS_PER_CALL)
      ) {
        chunks.push(current);
        current = [];
        currentChars = 0;
      }
      current.push(text);
      currentChars += text.length;
    }
    if (current.length > 0) chunks.push(current);

    for (const chunk of chunks) {
      const translatedChunk = await translateGoogleFreeChunk(chunk, sl, tl);
      for (let i = 0; i < chunk.length; i += 1) {
        const source = chunk[i]!;
        const target = translatedChunk[i];
        if (typeof target === "string") translatedByText.set(source, target);
      }
    }
  }

  return templates.map((template) => {
    if (template.slots.length === 0) return template.originalHtml;
    for (const slot of template.slots) {
      const translated = translatedByText.get(slot.core);
      if (typeof translated !== "string") return undefined;
      slot.node.data = `${slot.leading}${translated}${slot.trailing}`;
    }
    return template.doc.body.innerHTML;
  });
}

/* -------------------------------------------------------------------------- */
/* Commercial / API-keyed & LLM External Translation Adapters                 */
/* -------------------------------------------------------------------------- */

async function translateMicrosoft(config: RuntimeExternalEngineConfig, requests: ExternalTranslationRequest[]): Promise<Array<string | undefined>> {
  const request = requests[0]!;
  const base = requireBaseUrl(config, "https://api.cognitive.microsofttranslator.com");
  const key = requireApiKey(config);
  const to = encodeURIComponent(apiLanguage(request.targetLanguage, config.type));
  const from = request.sourceLanguage && request.sourceLanguage !== "auto"
    ? `&from=${encodeURIComponent(apiLanguage(request.sourceLanguage, config.type))}` : "";
  const headers: Record<string, string> = { "Content-Type": "application/json", "Ocp-Apim-Subscription-Key": key };
  if (config.region) headers["Ocp-Apim-Subscription-Region"] = config.region;
  const result = await jsonRequest(`${base}/translate?api-version=3.0${from}&to=${to}&textType=html`, {
    method: "POST",
    headers,
    body: JSON.stringify(requests.map(({ html }) => ({ Text: html }))),
  }) as Array<{ translations?: Array<{ text?: string }> }>;
  if (!Array.isArray(result) || result.length !== requests.length) throw new Error("Microsoft Translator 返回格式异常");
  return result.map((item) => item?.translations?.[0]?.text);
}

async function translateGoogle(config: RuntimeExternalEngineConfig, requests: ExternalTranslationRequest[]): Promise<Array<string | undefined>> {
  const request = requests[0]!;
  const endpoint = requireBaseUrl(config, "https://translation.googleapis.com/language/translate/v2");
  const result = await jsonRequest(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": requireApiKey(config) },
    body: JSON.stringify({
      q: requests.length === 1 ? request.html : requests.map(({ html }) => html),
      ...(request.sourceLanguage && request.sourceLanguage !== "auto"
        ? { source: apiLanguage(request.sourceLanguage, config.type) } : {}),
      target: apiLanguage(request.targetLanguage, config.type),
      format: "html",
    }),
  }) as { data?: { translations?: Array<{ translatedText?: string }> } };
  const translations = result.data?.translations;
  if (!Array.isArray(translations) || translations.length !== requests.length) throw new Error("Google Cloud Translation 返回格式异常");
  return translations.map((item) => item?.translatedText);
}

async function translateDeepL(config: RuntimeExternalEngineConfig, requests: ExternalTranslationRequest[]): Promise<Array<string | undefined>> {
  const request = requests[0]!;
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
    text: requests.map(({ html }) => html),
    target_lang: deepLLanguage(request.targetLanguage, "target"),
    tag_handling: "html",
  };
  if (request.sourceLanguage && request.sourceLanguage !== "auto") {
    body.source_lang = deepLLanguage(request.sourceLanguage, "source");
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
  if (!Array.isArray(translations) || translations.length !== requests.length) throw new Error("DeepL API 返回格式异常");
  return translations.map((item) => item?.text);
}

async function translateLibre(config: RuntimeExternalEngineConfig, request: ExternalTranslationRequest): Promise<string> {
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
    return url.hostname.toLowerCase() === "opencode.ai" && /^\/(?:zen\/go|inference\/go\/openai)\/v1(?:\/|$)/.test(url.pathname);
  } catch {
    return false;
  }
}

async function translateOpenAiCompatible(
  config: RuntimeExternalEngineConfig,
  request: ExternalTranslationRequest,
  batch?: { instructions: string; input: string },
): Promise<string> {
  const fallback = config.type === "openrouter"
    ? "https://openrouter.ai/api/v1"
    : config.type === "opencode-go"
      ? OPENCODE_GO_BASE_URL
      : config.type === "deepseek"
        ? "https://api.deepseek.com"
        : "";
  const base = requireBaseUrl(config, fallback);
  const endpoint = base.endsWith("/chat/completions") ? base : `${base}/chat/completions`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
  if (config.type === "openrouter") headers["X-OpenRouter-Title"] = "PageLingo";
  if (config.type === "opencode-go" || isOpenCodeGoUrl(base)) headers["x-opencode-session"] = OPENCODE_GO_SESSION_ID;

  const model = requireModel(config);
  const cacheKey = `${config.type}\u001f${base}\u001f${model}`;
  const suppressThinking = config.disableThinking !== false;
  const modeSequence: OpenAiReasoningMode[] = !suppressThinking
    ? ["omit"]
    : (() => {
        const cached = openAiReasoningModeCache.get(cacheKey);
        if (cached === "omit") return ["omit"];
        if (cached === "low") return ["low", "omit"];
        return ["none", "low", "omit"];
      })();

  const messages = [
    { role: "system", content: batch?.instructions ?? renderPrompt(config, request) },
    { role: "user", content: batch?.input ?? request.html },
  ];

  let result: {
    choices?: Array<{
      finish_reason?: string | null;
      message?: { refusal?: unknown; content?: string | Array<{ type?: string; text?: string }> };
    }>;
  } | undefined;

  for (let index = 0; index < modeSequence.length; index += 1) {
    const mode = modeSequence[index]!;
    const payload: Record<string, unknown> = {
      model,
      messages,
      temperature: 0,
    };
    if (mode !== "omit") payload.reasoning_effort = mode;
    try {
      result = await jsonRequest(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      }, LLM_REQUEST_TIMEOUT_MS) as typeof result;
      if (suppressThinking) openAiReasoningModeCache.set(cacheKey, mode);
      break;
    } catch (error) {
      if (index < modeSequence.length - 1 && isThinkingParamError(error)) {
        const nextMode = modeSequence[index + 1]!;
        openAiReasoningModeCache.set(cacheKey, nextMode);
        continue;
      }
      throw error;
    }
  }

  const choice = result?.choices?.[0];
  if (choice && Object.prototype.hasOwnProperty.call(choice, "finish_reason") && choice.finish_reason !== "stop") {
    throw new Error("模型未完整结束生成，已拒绝写入页面");
  }
  if (choice?.message?.refusal) throw new Error("模型拒绝生成译文，已保留原文");
  const content = choice?.message?.content;
  if (typeof content === "string") return stripCodeFence(content);
  if (Array.isArray(content)) {
    const text = content.map((part) => typeof part.text === "string" ? part.text : "").join("").trim();
    if (text) return stripCodeFence(text);
  }
  throw new Error("LLM 返回格式异常");
}

async function translateGemini(
  config: RuntimeExternalEngineConfig,
  request: ExternalTranslationRequest,
  batch?: { instructions: string; input: string },
): Promise<string> {
  const base = requireBaseUrl(config, "https://generativelanguage.googleapis.com/v1beta");
  const modelName = requireModel(config);
  const model = encodeURIComponent(modelName);
  const endpoint = `${base}/models/${model}:generateContent`;
  const headers = { "Content-Type": "application/json", "x-goog-api-key": requireApiKey(config) };
  const promptText = batch
    ? `${batch.instructions}\n\n${batch.input}`
    : `${renderPrompt(config, request)}\n\nHTML:\n${request.html}`;

  const cacheKey = `gemini\u001f${base}\u001f${modelName}`;
  const suppressThinking = config.disableThinking !== false;
  const modes: GeminiThinkingMode[] = !suppressThinking
    ? ["omit"]
    : geminiThinkingModeCache.get(cacheKey) === "omit"
      ? ["omit"]
      : ["budget0", "omit"];

  let result: {
    candidates?: Array<{ finishReason?: string; content?: { parts?: Array<{ text?: string }> } }>;
  } | undefined;

  for (let index = 0; index < modes.length; index += 1) {
    const mode = modes[index]!;
    const body: Record<string, unknown> = {
      contents: [{ role: "user", parts: [{ text: promptText }] }],
    };
    if (mode === "budget0") {
      body.generationConfig = { temperature: 0, thinkingConfig: { thinkingBudget: 0 } };
    }
    try {
      result = await jsonRequest(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      }, LLM_REQUEST_TIMEOUT_MS) as typeof result;
      if (suppressThinking) geminiThinkingModeCache.set(cacheKey, mode);
      break;
    } catch (error) {
      if (index < modes.length - 1 && isThinkingParamError(error)) {
        geminiThinkingModeCache.set(cacheKey, "omit");
        continue;
      }
      throw error;
    }
  }

  const candidate = result?.candidates?.[0];
  if (candidate && Object.prototype.hasOwnProperty.call(candidate, "finishReason") && candidate.finishReason !== "STOP") {
    throw new Error("模型未完整结束生成，已拒绝写入页面");
  }
  const text = candidate?.content?.parts?.map((part) => part.text ?? "").join("").trim();
  if (!text) throw new Error("Gemini 返回格式异常");
  return stripCodeFence(text);
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

async function translateCustomRest(config: RuntimeExternalEngineConfig, request: ExternalTranslationRequest): Promise<string> {
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

export async function listExternalTranslationModels(config: RuntimeExternalEngineConfig): Promise<ExternalModelInfo[]> {
  if (!["openrouter", "opencode-go", "deepseek", "openai-compatible"].includes(config.type)) {
    throw new Error("当前翻译引擎不支持自动获取模型");
  }
  const fallback = config.type === "openrouter"
    ? "https://openrouter.ai/api/v1"
    : config.type === "opencode-go"
      ? OPENCODE_GO_BASE_URL
      : config.type === "deepseek"
        ? "https://api.deepseek.com"
        : "";
  const base = requireBaseUrl(config, fallback);
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

/* -------------------------------------------------------------------------- */
/* LLM Compact Link Transport & Delimited Batch Protocol                      */
/* -------------------------------------------------------------------------- */

const COMPACT_LINK_RE = /<a data-flt-link-id="(\d+)" href="https:\/\/pagelingo\.invalid\/__link\/\1"><code>__FLT_LINK_START_\1__<\/code>([\s\S]*?)<code>__FLT_LINK_END_\1__<\/code><\/a>/gu;
const EXPAND_LINK_RE = /<a data-l="(\d+)">([\s\S]*?)<\/a>/gu;

export function compactLlmTransportHtml(html: string): string {
  return html.replace(COMPACT_LINK_RE, (_match, id: string, inner: string) => `<a data-l="${id}">${inner}</a>`);
}

export function expandLlmTransportHtml(html: string): string {
  return html.replace(
    EXPAND_LINK_RE,
    (_match, id: string, inner: string) =>
      `<a data-flt-link-id="${id}" href="https://pagelingo.invalid/__link/${id}"><code>__FLT_LINK_START_${id}__</code>${inner}<code>__FLT_LINK_END_${id}__</code></a>`,
  );
}

export function parseLlmBatchResponse(raw: string, expectedCount: number): Array<string | undefined> {
  const cleaned = stripCodeFence(raw);
  const byId = new Map<number, string | undefined>();
  const segRe = /\[\[SEG_(\d+)\]\]([\s\S]*?)\[\[\/SEG_\1\]\]/gu;
  let foundSegments = 0;
  for (const match of cleaned.matchAll(segRe)) {
    const id = Number(match[1]);
    if (!Number.isInteger(id) || id < 0 || id >= expectedCount) continue;
    foundSegments += 1;
    const content = (match[2] ?? "").trim();
    byId.set(id, byId.has(id) ? undefined : content);
  }
  if (foundSegments > 0) {
    return Array.from({ length: expectedCount }, (_, id) => byId.get(id));
  }

  // Fallback parser if a model returns JSON array format despite delimiter instructions.
  try {
    const parsed = JSON.parse(cleaned) as unknown;
    if (!Array.isArray(parsed)) return [];
    for (const row of parsed) {
      const item = row as { id?: unknown; html?: unknown } | null;
      if (!item || typeof item.id !== "number" || !Number.isInteger(item.id) || item.id < 0 || item.id >= expectedCount) continue;
      byId.set(item.id, byId.has(item.id) || typeof item.html !== "string" ? undefined : item.html);
    }
    return Array.from({ length: expectedCount }, (_, id) => byId.get(id));
  } catch {
    return [];
  }
}

function mergeBatchTerminology(requests: readonly ExternalTranslationRequest[]): ExternalTranslationTerminologyEntry[] {
  const seen = new Map<string, ExternalTranslationTerminologyEntry>();
  for (const request of requests) {
    for (const entry of request.terminology ?? []) {
      const key = `${entry.mode}:${entry.source.toLocaleLowerCase()}`;
      if (!seen.has(key)) seen.set(key, entry);
    }
  }
  return Array.from(seen.values());
}

async function translateLlmBatch(
  config: RuntimeExternalEngineConfig,
  requests: ExternalTranslationRequest[],
): Promise<Array<string | undefined>> {
  const first = requests[0]!;
  // Keep the system prompt strictly static per language pair so OpenCode Go / LLM
  // providers can reuse the prompt-cache KV prefix across every batch on the page.
  const instructions = `Translate each [[SEG_N]]...[[/SEG_N]] HTML block independently from ${languageLabel(first.sourceLanguage)} to ${languageLabel(first.targetLanguage)}. Preserve every HTML tag, attribute, tag order, data-flt-text-id span, data-flt-fixed span, and placeholder exactly. Translate human-readable text using the whole paragraph as context, keeping all translated words inside their original spans. Return only the translated [[SEG_N]]...[[/SEG_N]] blocks in the same IDs with no Markdown fences or explanations.`;

  const mergedTerms = mergeBatchTerminology(requests);
  const termsHeader = mergedTerms.length > 0 ? `${terminologyPrompt(mergedTerms).trim()}\n\n` : "";
  const blocks = requests.map(({ html }, id) => `[[SEG_${id}]]\n${compactLlmTransportHtml(html)}\n[[/SEG_${id}]]`).join("\n");
  const input = `${termsHeader}${blocks}`;

  const result = config.type === "gemini"
    ? await translateGemini(config, first, { instructions, input })
    : await translateOpenAiCompatible(config, first, { instructions, input });

  const parsed = parseLlmBatchResponse(result, requests.length);
  return parsed.map((html) => typeof html === "string" ? expandLlmTransportHtml(html) : undefined);
}

/* -------------------------------------------------------------------------- */
/* Public Translation Entrypoints & Validation                                */
/* -------------------------------------------------------------------------- */

const NOTRANSLATE_TERM_RE = /<span data-flt-term-id="(\d+)">/gu;
const UNMARK_NOTRANSLATE_TERM_RE = /<span\b(?=[^>]*\bdata-flt-term-id=["'](\d+)["'])[^>]*>/gu;

function markHtmlTermsNoTranslate(html: string): string {
  if (!html.includes("data-flt-term-id=")) return html;
  return html.replace(NOTRANSLATE_TERM_RE, '<span data-flt-term-id="$1" translate="no" class="notranslate">');
}

function unmarkHtmlTermsNoTranslate(html: string | undefined): string | undefined {
  if (typeof html !== "string" || !html.includes("data-flt-term-id=")) return html;
  return html.replace(UNMARK_NOTRANSLATE_TERM_RE, '<span data-flt-term-id="$1">');
}

function validateExternalTranslation(request: ExternalTranslationRequest, translated: string | undefined): string {
  translated = unmarkHtmlTermsNoTranslate(translated);
  if (typeof translated !== "string") throw new Error("翻译服务返回格式异常");
  if (/<span\b[^>]*\bdata-flt-text-id\s*=/iu.test(request.html)) {
    translated = restoreFixedHtmlTransport(request.html, translated);
  }
  const validated = validateTranslatedHtml(request.html, translated);
  const plain = (html: string) => {
    const body = new DOMParser().parseFromString(html, "text/html").body;
    for (const atom of body.querySelectorAll("code, [data-flt-fixed]")) atom.remove();
    return body.textContent ?? "";
  };
  const quality = assessTranslationQuality({
    sourceText: plain(request.html),
    translatedText: plain(validated),
    sourceLanguage: request.sourceLanguage,
    targetLanguage: request.targetLanguage,
  });
  if (!quality.accepted) {
    const detail = quality.incompleteAgentClause ? "译文句子可能不完整"
      : quality.suspiciouslyShort ? "译文内容明显过少"
        : "译文完整性检查未通过";
    throw new Error(`${detail}，已保留原文`);
  }
  return validated;
}

export async function translateWithExternalEngine(
  config: RuntimeExternalEngineConfig,
  request: ExternalTranslationRequest,
): Promise<string> {
  const wireRequest = config.type === "google-free" || config.type === "custom-rest"
    ? request
    : { ...request, html: markHtmlTermsNoTranslate(request.html) };
  let translated: string | undefined;
  switch (config.type) {
    case "microsoft-free": [translated] = await translateMicrosoftFree([wireRequest]); break;
    case "google-free": [translated] = await translateGoogleFree([wireRequest]); break;
    case "microsoft": [translated] = await translateMicrosoft(config, [wireRequest]); break;
    case "google": [translated] = await translateGoogle(config, [wireRequest]); break;
    case "deepl": [translated] = await translateDeepL(config, [wireRequest]); break;
    case "libretranslate": translated = await translateLibre(config, wireRequest); break;
    case "gemini": translated = await translateGemini(config, wireRequest); break;
    case "openrouter":
    case "opencode-go":
    case "deepseek":
    case "openai-compatible": translated = await translateOpenAiCompatible(config, wireRequest); break;
    case "custom-rest": translated = await translateCustomRest(config, wireRequest); break;
  }
  return validateExternalTranslation(request, translated);
}

export async function translateExternalBatch(
  config: RuntimeExternalEngineConfig,
  requests: ExternalTranslationRequest[],
): Promise<Array<string | null>> {
  const wireRequests = config.type === "google-free" || config.type === "custom-rest"
    ? requests
    : requests.map((item) => ({ ...item, html: markHtmlTermsNoTranslate(item.html) }));
  let translated: Array<string | undefined>;
  switch (config.type) {
    case "microsoft-free": translated = await translateMicrosoftFree(wireRequests); break;
    case "google-free": translated = await translateGoogleFree(wireRequests); break;
    case "microsoft": translated = await translateMicrosoft(config, wireRequests); break;
    case "google": translated = await translateGoogle(config, wireRequests); break;
    case "deepl": translated = await translateDeepL(config, wireRequests); break;
    default: translated = await translateLlmBatch(config, wireRequests); break;
  }
  // Independently validate each result so a damaged fragment retries on its own.
  return requests.map((request, index) => {
    try {
      return validateExternalTranslation(request, translated[index]);
    } catch {
      return null;
    }
  });
}
