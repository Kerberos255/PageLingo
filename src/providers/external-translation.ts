import { languageLabel } from "../shared/settings";
import { isLoopbackHostname } from "../shared/network-endpoint";
import { OPENCODE_GO_BASE_URL, type TranslationEngineConfig } from "../shared/translation-engine-settings";
import {restoreFixedHtmlTransport} from "../core/fixed-html-transport";

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
  const match = trimmed.match(/^```(?:html)?\s*([\s\S]*?)\s*```$/i);
  return match?.[1]?.trim() ?? trimmed;
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

function renderPrompt(config: TranslationEngineConfig, request: ExternalTranslationRequest): string {
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

async function jsonRequest(url: string, init: RequestInit, timeoutMs = EXTERNAL_REQUEST_TIMEOUT_MS): Promise<unknown> {
  const controller = new AbortController();
  const timeout = globalThis.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (!response.ok) {
      const detail = responseErrorDetail(await response.text());
      throw new Error(`翻译服务请求失败：HTTP ${response.status}${detail ? ` · ${detail}` : ""}`);
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

async function translateMicrosoft(config: TranslationEngineConfig, request: ExternalTranslationRequest): Promise<string> {
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
    body: JSON.stringify([{ Text: request.html }]),
  }) as Array<{ translations?: Array<{ text?: string }> }>;
  const html = result[0]?.translations?.[0]?.text;
  if (typeof html !== "string") throw new Error("Microsoft Translator 返回格式异常");
  return html;
}

async function translateGoogle(config: TranslationEngineConfig, request: ExternalTranslationRequest): Promise<string> {
  const endpoint = requireBaseUrl(config, "https://translation.googleapis.com/language/translate/v2");
  const result = await jsonRequest(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": requireApiKey(config) },
    body: JSON.stringify({
      q: request.html,
      ...(request.sourceLanguage && request.sourceLanguage !== "auto"
        ? {source: apiLanguage(request.sourceLanguage, config.type)} : {}),
      target: apiLanguage(request.targetLanguage, config.type),
      format: "html",
    }),
  }) as { data?: { translations?: Array<{ translatedText?: string }> } };
  const html = result.data?.translations?.[0]?.translatedText;
  if (typeof html !== "string") throw new Error("Google Cloud Translation 返回格式异常");
  return html;
}

async function translateDeepL(config: TranslationEngineConfig, request: ExternalTranslationRequest): Promise<string> {
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
    text: [request.html],
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
  const html = result.translations?.[0]?.text;
  if (typeof html !== "string") throw new Error("DeepL API 返回格式异常");
  return html;
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
    return url.hostname.toLowerCase() === "opencode.ai" && /^\/(?:zen\/go|inference\/go\/openai)\/v1(?:\/|$)/.test(url.pathname);
  } catch {
    return false;
  }
}

async function translateOpenAiCompatible(config: TranslationEngineConfig, request: ExternalTranslationRequest): Promise<string> {
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
  const result = await jsonRequest(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: requireModel(config),
      messages: [
        { role: "system", content: renderPrompt(config, request) },
        { role: "user", content: request.html },
      ],
      temperature: 0,
    }),
  }, LLM_REQUEST_TIMEOUT_MS) as { choices?: Array<{ message?: { content?: string | Array<{ type?: string; text?: string }> } }> };
  const content = result.choices?.[0]?.message?.content;
  if (typeof content === "string") return stripCodeFence(content);
  if (Array.isArray(content)) {
    const text = content.map((part) => typeof part.text === "string" ? part.text : "").join("").trim();
    if (text) return stripCodeFence(text);
  }
  throw new Error("LLM 返回格式异常");
}

async function translateGemini(config: TranslationEngineConfig, request: ExternalTranslationRequest): Promise<string> {
  const base = requireBaseUrl(config, "https://generativelanguage.googleapis.com/v1beta");
  const model = encodeURIComponent(requireModel(config));
  const endpoint = `${base}/models/${model}:generateContent`;
  const result = await jsonRequest(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": requireApiKey(config) },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: `${renderPrompt(config, request)}\n\nHTML:\n${request.html}` }] }],
    }),
  }, LLM_REQUEST_TIMEOUT_MS) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
  const text = result.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("").trim();
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
  if (/<span\b[^>]*\bdata-flt-text-id\s*=/iu.test(request.html)) translated = restoreFixedHtmlTransport(request.html, translated);
  return validateTranslatedHtml(request.html, translated);
}
