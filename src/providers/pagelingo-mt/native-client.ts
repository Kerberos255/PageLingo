import type {TranslationRequest} from "../../core/provider";
import {NATIVE_MT_BASE_URL, NATIVE_MT_MODEL_ID} from "../../shared/translation-engine-settings";
import {inferMtHtml} from "./inference";
import {mtRouteSupported} from "./protocol";

async function requestNativeMt(apiKey: string, path: "models" | "chat/completions", body?: unknown): Promise<unknown> {
  if (!apiKey) throw new Error("请填写本机 MT 的连接码");
  const headers: Record<string, string> = {Authorization: `Bearer ${apiKey}`};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  let response: Response;
  try {
    response = await fetch(`${NATIVE_MT_BASE_URL}/${path}`, {
      headers,
      credentials: "omit",
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(path === "models" ? 2500 : 120_000),
      ...(body === undefined ? {} : {method: "POST", body: JSON.stringify(body)}),
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "TimeoutError" && path !== "models") {
      throw new Error("本机 MT 翻译超时，已保留原文");
    }
    throw new Error("无法连接本机 MT，请确认服务已启动");
  }
  if (response.status === 401 || response.status === 403) throw new Error("本机 MT 连接码无效");
  if (!response.ok) throw new Error(`本机 MT 服务返回 HTTP ${response.status}`);
  try {
    return await response.json();
  } catch {
    throw new Error("本机 MT 服务返回了无法读取的结果");
  }
}

export async function checkNativeMt(apiKey: string): Promise<void> {
  const models = await requestNativeMt(apiKey, "models") as {data?: Array<{id?: string}>} | null;
  if (!Array.isArray(models?.data) || !models.data.some(item => item?.id === NATIVE_MT_MODEL_ID)) {
    throw new Error("本机 MT 服务没有加载支持的 PageLingo 模型");
  }
}

export async function translateNativeMt(apiKey: string, request: TranslationRequest): Promise<string> {
  if (!mtRouteSupported(request)) throw new Error("本机 MT 支持英语 → 简体中文");
  const result = await inferMtHtml(request, async options => {
    const response = await requestNativeMt(apiKey, "chat/completions", {
      ...options, model: NATIVE_MT_MODEL_ID,
    }) as {model?: string} | null;
    if (response?.model !== NATIVE_MT_MODEL_ID) throw new Error("本机 MT 服务返回了其它模型的结果");
    return response;
  }, {clarifyReturnConditions: true});
  if (!result.accepted) throw new Error(result.reason ?? "本机 MT 译文未通过校验，已保留原文");
  return result.html;
}
