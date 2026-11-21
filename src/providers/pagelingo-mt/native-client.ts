import type {TranslationRequest} from "../../core/provider";
import {NATIVE_MT_BASE_URL, NATIVE_MT_MESSAGING_PERMISSION, NATIVE_MT_MODEL_ID} from "../../shared/translation-engine-settings";
import {inferMtHtml} from "./inference";
import {mtRouteSupported} from "./protocol";

const HOST_NAME = "org.pagelingo.mt";
class NativeMtAuthenticationError extends Error {}
let connectionCode: Promise<string> | undefined;

async function discoverConnectionCode(): Promise<string> {
  // Only the extension named in the host's Firefox manifest can open this port.
  const missing = "未找到本机加速组件，请运行新版启动器";
  let port: browser.runtime.Port | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    port = browser.runtime.connectNative(HOST_NAME);
    const channel = port;
    const reply = await new Promise<{protocol?: unknown; token?: unknown} | null>((resolve, reject) => {
      channel.onMessage.addListener(resolve);
      channel.onDisconnect.addListener(() => reject(new Error(missing)));
      timeout = setTimeout(() => reject(new Error("连接本机加速组件超时")), 3500);
      channel.postMessage({protocol: 1});
    });
    if (reply?.protocol !== 1) throw new Error("请更新本机加速组件");
    if (typeof reply.token !== "string" || reply.token.length !== 64 || !/^[\da-f]+$/i.test(reply.token)) {
      throw new Error("请先启动本机加速服务");
    }
    return reply.token;
  } finally {
    clearTimeout(timeout);
    port?.disconnect();
  }
}

function readConnectionCode(): Promise<string> {
  connectionCode ??= discoverConnectionCode().catch(error => {
    connectionCode = undefined;
    throw error;
  });
  return connectionCode;
}

async function withNativeMt<T>(apiKey: string | undefined, request: (code: string) => Promise<T>): Promise<T> {
  if (apiKey !== undefined) return request(apiKey);
  if (!await browser.permissions.contains(NATIVE_MT_MESSAGING_PERMISSION)) throw new Error("请在设置中连接本机加速");
  const connection = readConnectionCode();
  try {
    return await request(await connection);
  } catch (error) {
    if (!(error instanceof NativeMtAuthenticationError)) throw error;
    if (connectionCode === connection) connectionCode = undefined;
    try {
      return await request(await readConnectionCode());
    } catch (retryError) {
      if (retryError instanceof NativeMtAuthenticationError) throw new Error("无法验证本机服务，请重新启动本机加速组件");
      throw retryError;
    }
  }
}

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
  if (response.status === 401 || response.status === 403) throw new NativeMtAuthenticationError("本机 MT 连接码无效");
  if (!response.ok) throw new Error(`本机 MT 服务返回 HTTP ${response.status}`);
  try {
    return await response.json();
  } catch {
    throw new Error("本机 MT 服务返回了无法读取的结果");
  }
}

export async function checkNativeMt(apiKey?: string): Promise<void> {
  const models = await withNativeMt(apiKey, code => requestNativeMt(code, "models")) as {data?: Array<{id?: string}>} | null;
  if (!Array.isArray(models?.data) || !models.data.some(item => item?.id === NATIVE_MT_MODEL_ID)) {
    throw new Error("本机 MT 服务没有加载支持的 PageLingo 模型");
  }
}

export async function translateNativeMt(request: TranslationRequest, apiKey?: string): Promise<string> {
  if (!mtRouteSupported(request)) throw new Error("本机 MT 支持英语 → 简体中文");
  const result = await inferMtHtml(request, async options => {
    const response = await withNativeMt(apiKey, code => requestNativeMt(code, "chat/completions", {
      ...options, model: NATIVE_MT_MODEL_ID,
    })) as {model?: string} | null;
    if (response?.model !== NATIVE_MT_MODEL_ID) throw new Error("本机 MT 服务返回了其它模型的结果");
    return response;
  }, {clarifyReturnConditions: true});
  if (!result.accepted) throw new Error(result.reason ?? "本机 MT 译文未通过校验，已保留原文");
  return result.html;
}
