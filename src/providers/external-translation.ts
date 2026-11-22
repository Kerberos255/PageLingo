import { languageLabel } from "../shared/settings";
import { isLoopbackHostname } from "../shared/network-endpoint";
import { parseHtmlBody, parseHtmlDocument } from "../shared/html-parser";
import {
  OPENCODE_GO_BASE_URL,
  isLlmEngineType,
  type RuntimeExternalEngineConfig,
  type RuntimeExternalEngineType,
} from "../shared/translation-engine-settings";
import { restoreFixedHtmlTransport } from "../core/fixed-html-transport";
import { assessTranslationQuality } from "../core/translation-quality";
import {
  packGoogleFreeHtml,
  packMicrosoftFreeHtml,
  unpackGoogleFreeHtml,
  unpackMicrosoftFreeHtml,
  type GoogleFreeHtmlPlan,
} from "./google-free-html";

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
const OPENCODE_GO_SESSION_ID = "pagelingo";
const EDGE_TRANSLATE_TEXT_URL = "https://edge.microsoft.com/translate/translatetext";
const GOOGLE_FREE_BATCH_URL = "https://translate.googleapis.com/translate_a/t";
const GOOGLE_FREE_SINGLE_URL = "https://translate.googleapis.com/translate_a/single";
const ANTHROPIC_API_VERSION = "2023-06-01";

const OPENAI_COMPATIBLE_DEFAULT_BASE_URLS: Partial<Record<RuntimeExternalEngineType, string>> = {
  openai: "https://api.openai.com/v1",
  deepseek: "https://api.deepseek.com",
  xai: "https://api.x.ai/v1",
  openrouter: "https://openrouter.ai/api/v1",
  "opencode-go": OPENCODE_GO_BASE_URL,
  groq: "https://api.groq.com/openai/v1",
  mistral: "https://api.mistral.ai/v1",
  dashscope: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  moonshot: "https://api.moonshot.cn/v1",
  zhipu: "https://open.bigmodel.cn/api/paas/v4",
  siliconflow: "https://api.siliconflow.cn/v1",
  volcengine: "https://ark.cn-beijing.volces.com/api/v3",
  ollama: "http://127.0.0.1:11434/v1",
  "openai-compatible": "",
};

const MAX_ACTIVE_REQUESTS = 8;
const MAX_MICROSOFT_FREE_REQUESTS = 4;
const MICROSOFT_FREE_MAX_ITEMS_PER_CALL = 25;
const MICROSOFT_FREE_MAX_CHARS_PER_CALL = 4_800;
const MAX_GOOGLE_FREE_REQUESTS = 3;
const GOOGLE_FREE_MAX_ITEMS_PER_CALL = 20;
const GOOGLE_FREE_MAX_CHARS_PER_CALL = 3_800;

let activeRequests = 0;
const waitingRequests: Array<() => void> = [];
let activeMicrosoftFreeRequests = 0;
const waitingMicrosoftFreeRequests: Array<() => void> = [];
let microsoftFreeCooldownUntil = 0;
let activeGoogleFreeRequests = 0;
const waitingGoogleFreeRequests: Array<() => void> = [];
let googleFreeCooldownUntil = 0;

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
  microsoftFreeCooldownUntil = 0;
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
  if (!config.prompt && isLlmEngineType(config.type)) return 12;
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
  if (code === "pt" && direction === "target") return "PT-PT";
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

async function withMicrosoftFreeSlot<T>(task: () => Promise<T>): Promise<T> {
  if (activeMicrosoftFreeRequests >= MAX_MICROSOFT_FREE_REQUESTS) {
    await new Promise<void>((resolve) => waitingMicrosoftFreeRequests.push(resolve));
  } else {
    activeMicrosoftFreeRequests += 1;
  }
  try {
    return await task();
  } finally {
    const next = waitingMicrosoftFreeRequests.shift();
    if (next) next();
    else activeMicrosoftFreeRequests -= 1;
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
/* Shared template-preserving plain-text batching (Edge Free & Google Free)   */
/* -------------------------------------------------------------------------- */

interface PlainTextSlotRef {
  node: Text;
  leading: string;
  core: string;
  trailing: string;
}

interface PlainTextTermSlotRef {
  element: Element;
  terms: Array<{ id: string; text: string }>;
  leading: string;
  core: string;
  trailing: string;
}

interface PlainTextTemplate {
  doc: Document;
  slots: PlainTextSlotRef[];
  termSlots: PlainTextTermSlotRef[];
  originalHtml: string;
}

type PlainTextPiece =
  | { kind: "literal"; text: string }
  | { kind: "translate"; leading: string; core: string; trailing: string };

const PLAIN_BLANK_LINE_SPLIT_RE = /(\r?\n(?:[ \t]*\r?\n)+)/u;
const PLAIN_SINGLE_LINE_SPLIT_RE = /(\r?\n)/u;

function splitOversizedTextByBoundary(text: string, maxChars: number): Array<{ text: string; separator: string }> {
  if (text.length <= maxChars) return [{ text, separator: "" }];
  const pieces: Array<{ text: string; separator: string }> = [];
  let cursor = 0;
  while (cursor < text.length) {
    if (text.length - cursor <= maxChars) {
      pieces.push({ text: text.slice(cursor), separator: "" });
      break;
    }
    const window = text.slice(cursor, cursor + maxChars);
    let splitAt = -1;
    let sepLen = 0;
    const sentenceMatches = Array.from(window.matchAll(/(?<=[.!?。！？])([ \t]+)/gu));
    const lastSentence = sentenceMatches.at(-1);
    if (lastSentence && typeof lastSentence.index === "number" && lastSentence.index >= Math.floor(maxChars * 0.3)) {
      splitAt = lastSentence.index;
      sepLen = lastSentence[1]!.length;
    } else {
      const wsMatch = window.match(/^([\s\S]*?)([ \t]+)\S*$/u);
      if (wsMatch && wsMatch[1]!.length >= Math.floor(maxChars * 0.3)) {
        splitAt = wsMatch[1]!.length;
        sepLen = wsMatch[2]!.length;
      }
    }
    if (splitAt <= 0) {
      splitAt = maxChars;
      sepLen = 0;
    }
    pieces.push({
      text: text.slice(cursor, cursor + splitAt),
      separator: text.slice(cursor + splitAt, cursor + splitAt + sepLen),
    });
    cursor += splitAt + sepLen;
  }
  return pieces;
}

const PLAIN_BRACKET_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ["(", ")"],
  ["[", "]"],
  ["{", "}"],
  ["【", "】"],
  ["〔", "〕"],
  ["⟬", "⟭"],
];

function peelPlainEdgeBrackets(raw: string): { leading: string; core: string; trailing: string } {
  const leadingWs = raw.match(/^\s*/u)?.[0] ?? "";
  const trailingWs = raw.match(/\s*$/u)?.[0] ?? "";
  let inner = raw.slice(leadingWs.length, raw.length - trailingWs.length);
  if (!inner) return { leading: leadingWs, core: "", trailing: trailingWs };
  let leading = leadingWs;
  let trailing = trailingWs;

  for (const [open, close] of PLAIN_BRACKET_PAIRS) {
    if (inner.length >= 3 && inner.startsWith(open) && inner.endsWith(close)) {
      let depth = 0;
      let wrapsWhole = true;
      for (let i = 0; i < inner.length; i += 1) {
        const ch = inner[i]!.normalize("NFKC");
        if (ch === open) depth += 1;
        else if (ch === close) {
          depth -= 1;
          if ((depth === 0 && i < inner.length - 1) || depth < 0) {
            wrapsWhole = false;
            break;
          }
        }
      }
      if (wrapsWhole && depth === 0) {
        const nextInner = inner.slice(open.length, inner.length - close.length);
        if (nextInner.trim() && /\p{L}/u.test(nextInner)) {
          leading += open;
          trailing = close + trailing;
          inner = nextInner;
        }
      }
    }
  }

  for (const [open, close] of PLAIN_BRACKET_PAIRS) {
    let depth = 0;
    let minDepth = 0;
    for (const ch of inner.normalize("NFKC")) {
      if (ch === open) depth += 1;
      else if (ch === close) {
        depth -= 1;
        if (depth < minDepth) minDepth = depth;
      }
    }
    if (depth < 0 && inner.endsWith(close)) {
      const nextInner = inner.slice(0, inner.length - close.length);
      if (nextInner.trim() && /\p{L}/u.test(nextInner)) {
        trailing = close + trailing;
        inner = nextInner;
      }
    } else if (depth > 0 && minDepth === 0 && inner.startsWith(open)) {
      const nextInner = inner.slice(open.length);
      if (nextInner.trim() && /\p{L}/u.test(nextInner)) {
        leading += open;
        inner = nextInner;
      }
    }
  }

  return { leading, core: inner, trailing };
}

function splitPlainTextPieces(core: string, maxPieceChars: number): PlainTextPiece[] {
  const pushTranslatable = (out: PlainTextPiece[], raw: string) => {
    if (!raw) return;
    if (!raw.trim() || !/\p{L}/u.test(raw)) {
      out.push({ kind: "literal", text: raw });
      return;
    }
    const { leading, core: inner, trailing } = peelPlainEdgeBrackets(raw);
    if (!inner) {
      out.push({ kind: "literal", text: raw });
      return;
    }
    if (inner.length <= maxPieceChars) {
      out.push({ kind: "translate", leading, core: inner, trailing });
      return;
    }
    if (leading) out.push({ kind: "literal", text: leading });
    const lineParts = inner.split(PLAIN_SINGLE_LINE_SPLIT_RE);
    for (let i = 0; i < lineParts.length; i += 1) {
      const part = lineParts[i] ?? "";
      if (i % 2 === 1) {
        out.push({ kind: "literal", text: part });
        continue;
      }
      if (!part.trim() || !/\p{L}/u.test(part)) {
        out.push({ kind: "literal", text: part });
        continue;
      }
      if (part.length <= maxPieceChars) {
        const l = part.match(/^\s*/u)?.[0] ?? "";
        const t = part.match(/\s*$/u)?.[0] ?? "";
        out.push({ kind: "translate", leading: l, core: part.slice(l.length, part.length - t.length), trailing: t });
      } else {
        for (const chunk of splitOversizedTextByBoundary(part, maxPieceChars)) {
          if (chunk.text.trim() && /\p{L}/u.test(chunk.text)) {
            const l = chunk.text.match(/^\s*/u)?.[0] ?? "";
            const t = chunk.text.match(/\s*$/u)?.[0] ?? "";
            out.push({ kind: "translate", leading: l, core: chunk.text.slice(l.length, chunk.text.length - t.length), trailing: t });
          } else if (chunk.text) {
            out.push({ kind: "literal", text: chunk.text });
          }
          if (chunk.separator) out.push({ kind: "literal", text: chunk.separator });
        }
      }
    }
    if (trailing) out.push({ kind: "literal", text: trailing });
  };

  const out: PlainTextPiece[] = [];
  if (PLAIN_BLANK_LINE_SPLIT_RE.test(core)) {
    const parts = core.split(PLAIN_BLANK_LINE_SPLIT_RE);
    for (let i = 0; i < parts.length; i += 1) {
      const part = parts[i] ?? "";
      if (i % 2 === 1) out.push({ kind: "literal", text: part });
      else pushTranslatable(out, part);
    }
    return out;
  }
  pushTranslatable(out, core);
  return out;
}

function isSimpleTermSlotContainer(element: Element): boolean {
  let hasTerm = false;
  let outsideText = "";
  for (const child of Array.from(element.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      outsideText += child.textContent ?? "";
      continue;
    }
    if (child.nodeType === Node.ELEMENT_NODE) {
      const el = child as Element;
      if (
        el.tagName === "SPAN"
        && /^\d+$/u.test(el.getAttribute("data-flt-term-id") ?? "")
        && el.childElementCount === 0
      ) {
        hasTerm = true;
        continue;
      }
    }
    return false;
  }
  return hasTerm && /\p{L}/u.test(outsideText);
}

function countPlainVerbatim(text: string, term: string): number {
  if (!term) return 0;
  const wordLike = /^[A-Za-z0-9_.-]+$/.test(term);
  let count = 0;
  for (let at = text.indexOf(term); at >= 0; at = text.indexOf(term, at + term.length)) {
    if (wordLike) {
      const before = at > 0 ? text[at - 1]! : "";
      const after = text[at + term.length] ?? "";
      if (/[A-Za-z0-9_]/.test(before) || /[A-Za-z0-9_]/.test(after)) continue;
    }
    count += 1;
  }
  return count;
}

function rebuildTermSlotNodes(
  doc: Document,
  translated: string,
  terms: ReadonlyArray<{ id: string; text: string }>,
): Node[] | null {
  const expectedByText = new Map<string, string[]>();
  for (const term of terms) {
    if (!term.text) return null;
    const queue = expectedByText.get(term.text);
    if (queue) queue.push(term.id);
    else expectedByText.set(term.text, [term.id]);
  }
  for (const [termText, ids] of expectedByText) {
    if (countPlainVerbatim(translated, termText) !== ids.length) return null;
  }

  const hits: Array<{ at: number; length: number; id: string; text: string }> = [];
  for (const [termText, ids] of expectedByText) {
    const wordLike = /^[A-Za-z0-9_.-]+$/.test(termText);
    let idx = 0;
    for (let at = translated.indexOf(termText); at >= 0 && idx < ids.length; at = translated.indexOf(termText, at + termText.length)) {
      if (wordLike) {
        const before = at > 0 ? translated[at - 1]! : "";
        const after = translated[at + termText.length] ?? "";
        if (/[A-Za-z0-9_]/.test(before) || /[A-Za-z0-9_]/.test(after)) continue;
      }
      hits.push({ at, length: termText.length, id: ids[idx++]!, text: termText });
    }
    if (idx !== ids.length) return null;
  }

  hits.sort((a, b) => a.at - b.at);
  for (let i = 1; i < hits.length; i += 1) {
    if (hits[i]!.at < hits[i - 1]!.at + hits[i - 1]!.length) return null;
  }

  const nodes: Node[] = [];
  let cursor = 0;
  for (const hit of hits) {
    if (hit.at > cursor) nodes.push(doc.createTextNode(translated.slice(cursor, hit.at)));
    const span = doc.createElement("span");
    span.setAttribute("data-flt-term-id", hit.id);
    span.textContent = hit.text;
    nodes.push(span);
    cursor = hit.at + hit.length;
  }
  if (cursor < translated.length) nodes.push(doc.createTextNode(translated.slice(cursor)));
  return nodes;
}

function extractPlainTextTemplate(html: string, keepTermsInline = true): PlainTextTemplate {
  const doc = parseHtmlDocument(html);
  const slots: PlainTextSlotRef[] = [];
  const termSlots: PlainTextTermSlotRef[] = [];
  const coveredTermContainers = new Set<Element>();

  if (keepTermsInline) {
    const candidates = Array.from(doc.body.querySelectorAll("span[data-flt-text-id]"));
    if (candidates.length === 0 && isSimpleTermSlotContainer(doc.body)) {
      candidates.push(doc.body);
    }
    for (const candidate of candidates) {
      if (!isSimpleTermSlotContainer(candidate)) continue;
      const fullText = candidate.textContent ?? "";
      if (PLAIN_BLANK_LINE_SPLIT_RE.test(fullText)) continue;
      const leading = fullText.match(/^\s*/u)?.[0] ?? "";
      const trailing = fullText.match(/\s*$/u)?.[0] ?? "";
      const core = fullText.slice(leading.length, fullText.length - trailing.length);
      if (!core) continue;
      const terms: Array<{ id: string; text: string }> = [];
      for (const child of Array.from(candidate.children)) {
        const tid = child.getAttribute("data-flt-term-id");
        if (tid !== null) terms.push({ id: tid, text: child.textContent ?? "" });
      }
      if (!terms.length) continue;
      coveredTermContainers.add(candidate);
      termSlots.push({ element: candidate, terms, leading, core, trailing });
    }
  }

  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
  for (let current = walker.nextNode(); current; current = walker.nextNode()) {
    const textNode = current as Text;
    const parent = textNode.parentElement;
    if (parent && coveredTermContainers.has(parent)) continue;
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
  return { doc, slots, termSlots, originalHtml: html };
}

async function runPlainTextChunks(
  uniqueTexts: string[],
  maxItemsPerCall: number,
  maxCharsPerCall: number,
  translateChunk: (texts: string[]) => Promise<Array<string | undefined>>,
): Promise<Map<string, string>> {
  const translatedByText = new Map<string, string>();
  if (uniqueTexts.length === 0) return translatedByText;
  const chunks: string[][] = [];
  let current: string[] = [];
  let currentChars = 0;
  for (const text of uniqueTexts) {
    if (
      current.length > 0
      && (current.length >= maxItemsPerCall || currentChars + text.length > maxCharsPerCall)
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
    const translatedChunk = await translateChunk(chunk);
    for (let i = 0; i < chunk.length; i += 1) {
      const source = chunk[i]!;
      const target = translatedChunk[i];
      if (typeof target === "string") translatedByText.set(source, target);
    }
  }
  return translatedByText;
}

async function translatePlainTextTemplates(
  requests: ExternalTranslationRequest[],
  maxItemsPerCall: number,
  maxCharsPerCall: number,
  translateChunk: (texts: string[]) => Promise<Array<string | undefined>>,
  keepTermsInline = true,
): Promise<Array<string | undefined>> {
  const maxPieceChars = Math.max(400, Math.floor(maxCharsPerCall * 0.75));
  const templates = requests.map((request) => {
    const template = extractPlainTextTemplate(request.html, keepTermsInline);
    return {
      ...template,
      slotPieces: template.slots.map((slot) => splitPlainTextPieces(slot.core, maxPieceChars)),
      termSlotPieces: template.termSlots.map((slot) => splitPlainTextPieces(slot.core, maxPieceChars)),
    };
  });
  const uniqueTexts: string[] = [];
  const textIndex = new Map<string, number>();
  const addText = (text: string) => {
    if (!textIndex.has(text)) {
      textIndex.set(text, uniqueTexts.length);
      uniqueTexts.push(text);
    }
  };
  for (const template of templates) {
    for (const pieces of template.slotPieces) {
      for (const piece of pieces) {
        if (piece.kind === "translate") addText(piece.core);
      }
    }
    for (const pieces of template.termSlotPieces) {
      for (const piece of pieces) {
        if (piece.kind === "translate") addText(piece.core);
      }
    }
  }

  const translatedByText = await runPlainTextChunks(uniqueTexts, maxItemsPerCall, maxCharsPerCall, translateChunk);
  const splitFallbackIndices: number[] = [];

  const outputs = templates.map((template, index) => {
    if (template.slots.length === 0 && template.termSlots.length === 0) return template.originalHtml;
    for (let s = 0; s < template.slots.length; s += 1) {
      const slot = template.slots[s]!;
      const pieces = template.slotPieces[s]!;
      let joined = "";
      for (const piece of pieces) {
        if (piece.kind === "literal") {
          joined += piece.text;
        } else {
          const translated = translatedByText.get(piece.core);
          if (typeof translated !== "string") return undefined;
          joined += `${piece.leading}${translated}${piece.trailing}`;
        }
      }
      slot.node.data = `${slot.leading}${joined}${slot.trailing}`;
    }

    for (let s = 0; s < template.termSlots.length; s += 1) {
      const termSlot = template.termSlots[s]!;
      const pieces = template.termSlotPieces[s]!;
      let joined = "";
      for (const piece of pieces) {
        if (piece.kind === "literal") {
          joined += piece.text;
        } else {
          const translated = translatedByText.get(piece.core);
          if (typeof translated !== "string") return undefined;
          joined += `${piece.leading}${translated}${piece.trailing}`;
        }
      }
      const rebuilt = rebuildTermSlotNodes(template.doc, joined, termSlot.terms);
      if (!rebuilt) {
        if (keepTermsInline) splitFallbackIndices.push(index);
        return undefined;
      }
      const first = rebuilt[0];
      if (first && first.nodeType === Node.TEXT_NODE) {
        first.textContent = termSlot.leading + (first.textContent ?? "");
      } else if (termSlot.leading) {
        rebuilt.unshift(template.doc.createTextNode(termSlot.leading));
      }
      const last = rebuilt[rebuilt.length - 1];
      if (last && last.nodeType === Node.TEXT_NODE) {
        last.textContent = (last.textContent ?? "") + termSlot.trailing;
      } else if (termSlot.trailing) {
        rebuilt.push(template.doc.createTextNode(termSlot.trailing));
      }
      termSlot.element.replaceChildren(...rebuilt);
    }

    return template.doc.body.innerHTML;
  });

  // If the translation service altered or dropped a protected term in any inline
  // term-slot, re-translate ONLY those paragraphs with split term boundaries so
  // terminology protection stays 100% intact.
  if (keepTermsInline && splitFallbackIndices.length > 0) {
    const fallbackRequests = splitFallbackIndices.map((idx) => requests[idx]!);
    const fallbackOutputs = await translatePlainTextTemplates(
      fallbackRequests,
      maxItemsPerCall,
      maxCharsPerCall,
      translateChunk,
      false,
    );
    for (let i = 0; i < splitFallbackIndices.length; i += 1) {
      outputs[splitFallbackIndices[i]!] = fallbackOutputs[i];
    }
  }

  return outputs;
}

/* -------------------------------------------------------------------------- */
/* Built-in Microsoft Translate (Edge translatetext endpoint)                 */
/* -------------------------------------------------------------------------- */

async function translateMicrosoftFreeChunk(
  texts: string[],
  from: string,
  to: string,
): Promise<Array<string | undefined>> {
  const endpoint = `${EDGE_TRANSLATE_TEXT_URL}?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&isEnterpriseClient=false`;
  return withMicrosoftFreeSlot(() => withConcurrencySlot(async () => {
    const waitMs = microsoftFreeCooldownUntil - Date.now();
    if (waitMs > 0) await sleep(waitMs);
    const response = await fetchResponseWithRetry(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(texts),
    }, {
      timeoutMs: EXTERNAL_REQUEST_TIMEOUT_MS,
      maxRetries: 3,
      baseBackoffMs: 500,
      maxBackoffMs: 4_000,
      onRateLimit: (delayMs) => {
        microsoftFreeCooldownUntil = Math.max(microsoftFreeCooldownUntil, Date.now() + delayMs);
      },
    });
    let result: unknown;
    try {
      result = await response.json();
    } catch {
      throw new Error("微软翻译返回了无效 JSON");
    }
    if (!Array.isArray(result) || result.length !== texts.length) {
      throw new Error("微软翻译返回格式异常");
    }
    return (result as Array<{ translations?: Array<{ text?: string }> }>).map((item) => item?.translations?.[0]?.text);
  }));
}

async function translateMicrosoftFree(
  requests: ExternalTranslationRequest[],
): Promise<Array<string | undefined>> {
  const first = requests[0]!;
  const to = apiLanguage(first.targetLanguage, "microsoft-free");
  const from = first.sourceLanguage && first.sourceLanguage !== "auto"
    ? apiLanguage(first.sourceLanguage, "microsoft-free")
    : "";

  const results: Array<string | undefined> = new Array(requests.length).fill(undefined);
  const htmlItems: Array<{ index: number; request: ExternalTranslationRequest; plan: GoogleFreeHtmlPlan }> = [];
  const fallbackIndices: number[] = [];

  for (let index = 0; index < requests.length; index += 1) {
    const request = requests[index]!;
    const plan = packMicrosoftFreeHtml(request.html);
    if (plan) htmlItems.push({ index, request, plan });
    else fallbackIndices.push(index);
  }

  if (htmlItems.length > 0) {
    const chunks: typeof htmlItems[] = [];
    let current: typeof htmlItems = [];
    let currentChars = 0;
    for (const item of htmlItems) {
      const len = item.plan.wireHtml.length;
      if (
        current.length > 0
        && (current.length >= MICROSOFT_FREE_MAX_ITEMS_PER_CALL || currentChars + len > MICROSOFT_FREE_MAX_CHARS_PER_CALL)
      ) {
        chunks.push(current);
        current = [];
        currentChars = 0;
      }
      current.push(item);
      currentChars += len;
    }
    if (current.length > 0) chunks.push(current);

    for (const chunk of chunks) {
      const translatedChunk = await translateMicrosoftFreeChunk(
        chunk.map((item) => item.plan.wireHtml),
        from,
        to,
      );
      for (let i = 0; i < chunk.length; i += 1) {
        const item = chunk[i]!;
        const wireOut = translatedChunk[i];
        let restored: string | undefined;
        if (typeof wireOut === "string") {
          const unpacked = unpackMicrosoftFreeHtml(item.plan, wireOut);
          if (typeof unpacked === "string") {
            try {
              restored = /<span\b[^>]*\bdata-flt-text-id\s*=/iu.test(item.request.html)
                ? restoreFixedHtmlTransport(item.request.html, unpacked)
                : unpacked;
            } catch {
              restored = undefined;
            }
          }
        }
        if (typeof restored === "string") results[item.index] = restored;
        else fallbackIndices.push(item.index);
      }
    }
  }

  if (fallbackIndices.length > 0) {
    fallbackIndices.sort((a, b) => a - b);
    const fallbackOutputs = await translatePlainTextTemplates(
      fallbackIndices.map((index) => requests[index]!),
      MICROSOFT_FREE_MAX_ITEMS_PER_CALL,
      MICROSOFT_FREE_MAX_CHARS_PER_CALL,
      (chunk) => translateMicrosoftFreeChunk(chunk, from, to),
    );
    for (let i = 0; i < fallbackIndices.length; i += 1) {
      results[fallbackIndices[i]!] = fallbackOutputs[i];
    }
  }

  return results;
}

/* -------------------------------------------------------------------------- */
/* Built-in Google Translate (Keyless batch endpoint + single fallback)       */
/* -------------------------------------------------------------------------- */

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
      throw new Error("Google 翻译返回了无效 JSON");
    }
  }));
}

async function translateGoogleFreeSingleText(text: string, sl: string, tl: string): Promise<string> {
  const endpoint = `${GOOGLE_FREE_SINGLE_URL}?client=gtx&sl=${encodeURIComponent(sl)}&tl=${encodeURIComponent(tl)}&dt=t`;
  const params = new URLSearchParams();
  params.append("q", text);
  const data = await googleFreeJsonPost(endpoint, params);
  const translated = parseGoogleFreeSinglePayload(data);
  if (translated === null) throw new Error("Google 翻译返回格式异常");
  return translated;
}

async function translateGoogleFreeBatchOnly(texts: string[], sl: string, tl: string): Promise<string[] | null> {
  const endpoint = `${GOOGLE_FREE_BATCH_URL}?client=dict-chrome-ex&sl=${encodeURIComponent(sl)}&tl=${encodeURIComponent(tl)}`;
  const params = new URLSearchParams();
  for (const text of texts) params.append("q", text);
  try {
    const data = await googleFreeJsonPost(endpoint, params);
    return parseGoogleFreeBatchPayload(data, texts.length);
  } catch (error) {
    if (error instanceof HttpStatusError && error.status === 429) throw error;
    return null;
  }
}

async function translateGoogleFreeChunk(texts: string[], sl: string, tl: string): Promise<string[]> {
  const parsed = await translateGoogleFreeBatchOnly(texts, sl, tl);
  if (parsed) return parsed;
  // Fall back to translate_a/single (client=gtx) when translate_a/t rejects or changes shape.
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

  const results: Array<string | undefined> = new Array(requests.length).fill(undefined);
  const htmlItems: Array<{ index: number; request: ExternalTranslationRequest; plan: GoogleFreeHtmlPlan }> = [];
  const fallbackIndices: number[] = [];

  for (let index = 0; index < requests.length; index += 1) {
    const request = requests[index]!;
    const plan = packGoogleFreeHtml(request.html);
    if (plan) htmlItems.push({ index, request, plan });
    else fallbackIndices.push(index);
  }

  if (htmlItems.length > 0) {
    const chunks: typeof htmlItems[] = [];
    let current: typeof htmlItems = [];
    let currentChars = 0;
    for (const item of htmlItems) {
      const len = item.plan.wireHtml.length;
      if (
        current.length > 0
        && (current.length >= GOOGLE_FREE_MAX_ITEMS_PER_CALL || currentChars + len > GOOGLE_FREE_MAX_CHARS_PER_CALL)
      ) {
        chunks.push(current);
        current = [];
        currentChars = 0;
      }
      current.push(item);
      currentChars += len;
    }
    if (current.length > 0) chunks.push(current);

    for (const chunk of chunks) {
      const translatedChunk = await translateGoogleFreeBatchOnly(
        chunk.map((item) => item.plan.wireHtml),
        sl,
        tl,
      );
      if (!translatedChunk) {
        for (const item of chunk) fallbackIndices.push(item.index);
        continue;
      }
      for (let i = 0; i < chunk.length; i += 1) {
        const item = chunk[i]!;
        const wireOut = translatedChunk[i];
        let restored: string | undefined;
        if (typeof wireOut === "string") {
          const unpacked = unpackGoogleFreeHtml(item.plan, wireOut);
          if (typeof unpacked === "string") {
            try {
              restored = /<span\b[^>]*\bdata-flt-text-id\s*=/iu.test(item.request.html)
                ? restoreFixedHtmlTransport(item.request.html, unpacked)
                : unpacked;
            } catch {
              restored = undefined;
            }
          }
        }
        if (typeof restored === "string") results[item.index] = restored;
        else fallbackIndices.push(item.index);
      }
    }
  }

  if (fallbackIndices.length > 0) {
    fallbackIndices.sort((a, b) => a - b);
    const fallbackOutputs = await translatePlainTextTemplates(
      fallbackIndices.map((index) => requests[index]!),
      GOOGLE_FREE_MAX_ITEMS_PER_CALL,
      GOOGLE_FREE_MAX_CHARS_PER_CALL,
      (chunk) => translateGoogleFreeChunk(chunk, sl, tl),
    );
    for (let i = 0; i < fallbackIndices.length; i += 1) {
      results[fallbackIndices[i]!] = fallbackOutputs[i];
    }
  }

  return results;
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
  const fallback = OPENAI_COMPATIBLE_DEFAULT_BASE_URLS[config.type] ?? "";
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

async function translateAnthropic(
  config: RuntimeExternalEngineConfig,
  request: ExternalTranslationRequest,
  batch?: { instructions: string; input: string },
): Promise<string> {
  const base = requireBaseUrl(config, "https://api.anthropic.com/v1");
  const endpoint = base.endsWith("/messages") ? base : `${base}/messages`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-api-key": requireApiKey(config),
    "anthropic-version": ANTHROPIC_API_VERSION,
    "anthropic-dangerous-direct-browser-access": "true",
  };
  // Extended thinking is off by default in Anthropic Messages API; omit thinking unless explicitly requested.
  const payload: Record<string, unknown> = {
    model: requireModel(config),
    max_tokens: 4096,
    temperature: 0,
    system: batch?.instructions ?? renderPrompt(config, request),
    messages: [{ role: "user", content: batch?.input ?? request.html }],
  };
  const result = await jsonRequest(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  }, LLM_REQUEST_TIMEOUT_MS) as {
    stop_reason?: string | null;
    content?: Array<{ type?: string; text?: string }>;
  };
  if (result?.stop_reason === "max_tokens") {
    throw new Error("模型未完整结束生成，已拒绝写入页面");
  }
  if (result?.stop_reason === "refusal") {
    throw new Error("模型拒绝生成译文，已保留原文");
  }
  const text = Array.isArray(result?.content)
    ? result.content.filter((part) => part?.type === "text" && typeof part.text === "string").map((part) => part.text).join("").trim()
    : "";
  if (!text) throw new Error("Anthropic 返回格式异常");
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
  if (trimmed.endsWith("/messages")) return `${trimmed.slice(0, -"/messages".length)}/models`;
  return `${trimmed}/models`;
}

const KEYLESS_MODEL_LIST_TYPES = new Set<RuntimeExternalEngineType>([
  "openrouter",
  "opencode-go",
  "ollama",
  "openai-compatible",
]);

function isLoopbackUrl(urlValue: string): boolean {
  try {
    return isLoopbackHostname(new URL(urlValue).hostname);
  } catch {
    return false;
  }
}

async function fetchModelListJson(url: string, init: RequestInit): Promise<unknown> {
  try {
    return await jsonRequest(url, init);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/\bHTTP\s*(?:401|403)\b/i.test(message)) {
      throw new Error("当前接口需要有效的 API Key 才能获取模型列表，请先填写正确的 API Key");
    }
    throw error;
  }
}

export async function listExternalTranslationModels(config: RuntimeExternalEngineConfig): Promise<ExternalModelInfo[]> {
  if (config.type === "anthropic") {
    const base = requireBaseUrl(config, "https://api.anthropic.com/v1");
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "x-api-key": requireApiKey(config),
      "anthropic-version": ANTHROPIC_API_VERSION,
      "anthropic-dangerous-direct-browser-access": "true",
    };
    const result = await fetchModelListJson(modelListEndpoint(base), { method: "GET", headers }) as {
      data?: Array<{ id?: unknown; display_name?: unknown; name?: unknown }>;
    };
    const models = Array.isArray(result.data)
      ? result.data
          .map((item) => ({
            id: typeof item?.id === "string" ? item.id.trim() : "",
            name: typeof item?.display_name === "string"
              ? item.display_name.trim()
              : typeof item?.name === "string"
                ? item.name.trim()
                : undefined,
            ownedBy: "anthropic",
          }))
          .filter((item) => item.id)
      : [];
    if (!models.length) throw new Error("模型列表为空或返回格式不兼容");
    return models.sort((a, b) => a.id.localeCompare(b.id));
  }

  if (config.type === "gemini") {
    const base = requireBaseUrl(config, "https://generativelanguage.googleapis.com/v1beta");
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "x-goog-api-key": requireApiKey(config),
    };
    const result = await fetchModelListJson(modelListEndpoint(base), { method: "GET", headers }) as {
      models?: Array<{
        name?: unknown;
        displayName?: unknown;
        supportedGenerationMethods?: unknown;
        inputTokenLimit?: unknown;
        outputTokenLimit?: unknown;
      }>;
    };
    const models = Array.isArray(result.models)
      ? result.models
          .filter((item) => !Array.isArray(item?.supportedGenerationMethods) || item.supportedGenerationMethods.includes("generateContent"))
          .map((item) => {
            const rawName = typeof item?.name === "string" ? item.name.trim() : "";
            const id = rawName.replace(/^models\//u, "");
            return {
              id,
              name: typeof item?.displayName === "string" && item.displayName.trim() ? item.displayName.trim() : undefined,
              ownedBy: "google",
              contextWindow: typeof item?.inputTokenLimit === "number" ? item.inputTokenLimit : undefined,
              maxOutputTokens: typeof item?.outputTokenLimit === "number" ? item.outputTokenLimit : undefined,
            };
          })
          .filter((item) => item.id)
      : [];
    if (!models.length) throw new Error("模型列表为空或返回格式不兼容");
    return models.sort((a, b) => a.id.localeCompare(b.id));
  }

  if (!Object.prototype.hasOwnProperty.call(OPENAI_COMPATIBLE_DEFAULT_BASE_URLS, config.type)) {
    throw new Error("当前翻译引擎不支持自动获取模型");
  }
  const fallback = OPENAI_COMPATIBLE_DEFAULT_BASE_URLS[config.type] ?? "";
  const base = requireBaseUrl(config, fallback);
  if (!config.apiKey.trim() && !KEYLESS_MODEL_LIST_TYPES.has(config.type) && !isLoopbackUrl(base)) {
    throw new Error("当前引擎需要 API Key 才能查看模型列表，请先填写 API Key");
  }
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
  if (config.type === "opencode-go" || isOpenCodeGoUrl(base)) headers["x-opencode-session"] = OPENCODE_GO_SESSION_ID;
  if (config.type === "openrouter") headers["X-OpenRouter-Title"] = "PageLingo";
  const result = await fetchModelListJson(modelListEndpoint(base), { method: "GET", headers }) as {
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
  // Keep the system prompt strictly static per language pair so LLM providers
  // can reuse the prompt-cache KV prefix across every batch on the page.
  const instructions = `Translate each [[SEG_N]]...[[/SEG_N]] HTML block independently from ${languageLabel(first.sourceLanguage)} to ${languageLabel(first.targetLanguage)}. Preserve every HTML tag, attribute, tag order, data-flt-text-id span, data-flt-fixed span, and placeholder exactly. Translate human-readable text using the whole paragraph as context, keeping all translated words inside their original spans. Return only the translated [[SEG_N]]...[[/SEG_N]] blocks in the same IDs with no Markdown fences or explanations.`;

  const mergedTerms = mergeBatchTerminology(requests);
  const termsHeader = mergedTerms.length > 0 ? `${terminologyPrompt(mergedTerms).trim()}\n\n` : "";
  const blocks = requests.map(({ html }, id) => `[[SEG_${id}]]\n${compactLlmTransportHtml(html)}\n[[/SEG_${id}]]`).join("\n");
  const input = `${termsHeader}${blocks}`;

  const result = config.type === "gemini"
    ? await translateGemini(config, first, { instructions, input })
    : config.type === "anthropic"
      ? await translateAnthropic(config, first, { instructions, input })
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
  const plain = (html: string, stripTerms = false) => {
    const body = parseHtmlBody(html);
    const selector = stripTerms ? "code, [data-flt-fixed], span[data-flt-term-id]" : "code, [data-flt-fixed]";
    for (const atom of body.querySelectorAll(selector)) atom.remove();
    return body.textContent ?? "";
  };
  const quality = assessTranslationQuality({
    sourceText: plain(request.html),
    translatedText: plain(validated),
    mismatchSourceText: plain(request.html, true),
    mismatchTranslatedText: plain(validated, true),
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
  const skipWireMark = config.type === "microsoft-free" || config.type === "google-free" || config.type === "custom-rest";
  const wireRequest = skipWireMark ? request : { ...request, html: markHtmlTermsNoTranslate(request.html) };
  let translated: string | undefined;
  switch (config.type) {
    case "microsoft-free": [translated] = await translateMicrosoftFree([wireRequest]); break;
    case "google-free": [translated] = await translateGoogleFree([wireRequest]); break;
    case "microsoft": [translated] = await translateMicrosoft(config, [wireRequest]); break;
    case "google": [translated] = await translateGoogle(config, [wireRequest]); break;
    case "deepl": [translated] = await translateDeepL(config, [wireRequest]); break;
    case "libretranslate": translated = await translateLibre(config, wireRequest); break;
    case "gemini": translated = await translateGemini(config, wireRequest); break;
    case "anthropic": translated = await translateAnthropic(config, wireRequest); break;
    case "openai":
    case "deepseek":
    case "xai":
    case "openrouter":
    case "opencode-go":
    case "groq":
    case "mistral":
    case "dashscope":
    case "moonshot":
    case "zhipu":
    case "siliconflow":
    case "volcengine":
    case "ollama":
    case "openai-compatible": translated = await translateOpenAiCompatible(config, wireRequest); break;
    case "custom-rest": translated = await translateCustomRest(config, wireRequest); break;
  }
  return validateExternalTranslation(request, translated);
}

export async function translateExternalBatch(
  config: RuntimeExternalEngineConfig,
  requests: ExternalTranslationRequest[],
): Promise<Array<string | null>> {
  const skipWireMark = config.type === "microsoft-free" || config.type === "google-free" || config.type === "custom-rest";
  const wireRequests = skipWireMark
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
