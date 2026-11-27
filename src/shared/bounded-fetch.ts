import { isLoopbackTranslationEndpoint } from "./network-endpoint";

const SUBTITLE_CREDENTIAL_HOSTS = new Set([
  "api.bilibili.com",
  "www.bilibili.com",
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "www.youtube-nocookie.com",
]);

export function isSubtitleCredentialHostAllowed(hostname: string): boolean {
  return SUBTITLE_CREDENTIAL_HOSTS.has(hostname.trim().toLowerCase());
}

export interface SubtitleFetchPolicy {
  url: string;
  credentials: RequestCredentials;
}

export function resolveSubtitleFetchPolicy(
  rawUrl: unknown,
  requestedCredentials: unknown,
  isIncognito = false,
): SubtitleFetchPolicy {
  const trimmed = typeof rawUrl === "string" ? rawUrl.trim() : "";
  if (!trimmed) throw new Error("字幕地址无效");

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("字幕地址格式无效");
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("仅支持 HTTPS 字幕地址");
  }
  if (parsed.protocol === "http:" && !isLoopbackTranslationEndpoint(parsed.href)) {
    throw new Error("仅支持 HTTPS 字幕地址（本机调试地址除外）");
  }

  const allowCredentials =
    requestedCredentials === "include"
    && parsed.protocol === "https:"
    && !isIncognito
    && isSubtitleCredentialHostAllowed(parsed.hostname);

  return {
    url: parsed.href,
    credentials: allowCredentials ? "include" : "omit",
  };
}

export async function readResponseBytesWithLimit(
  response: Response,
  maxBytes: number,
  tooLargeMessage: string,
): Promise<Uint8Array> {
  const rawLength = response.headers?.get("content-length");
  if (rawLength) {
    const parsedLength = Number.parseInt(rawLength, 10);
    if (Number.isFinite(parsedLength) && parsedLength > maxBytes) {
      await response.body?.cancel?.().catch(() => {});
      throw new Error(tooLargeMessage);
    }
  }

  const body = response.body;
  if (body && typeof body.getReader === "function") {
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value || value.byteLength === 0) continue;
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel().catch(() => {});
          throw new Error(tooLargeMessage);
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return merged;
  }

  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > maxBytes) {
    throw new Error(tooLargeMessage);
  }
  return new Uint8Array(buffer);
}

export interface BoundedFetchOptions {
  maxBytes: number;
  timeoutMs: number;
  credentials?: RequestCredentials;
  cache?: RequestCache;
  tooLargeMessage: string;
  timeoutMessage: string;
  httpErrorPrefix: string;
  fetchFn?: typeof fetch;
}

export interface BoundedFetchResult {
  bytes: Uint8Array;
  contentType: string;
  finalUrl: string;
}

export async function fetchBoundedBytes(
  url: string,
  options: BoundedFetchOptions,
): Promise<BoundedFetchResult> {
  const fetchImpl = options.fetchFn ?? fetch;
  const controller = new AbortController();
  let timedOut = false;
  const timeoutId = globalThis.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, options.timeoutMs);

  try {
    const init: RequestInit = {
      credentials: options.credentials ?? "omit",
      signal: controller.signal,
      ...(options.cache ? { cache: options.cache } : {}),
    };
    const response = await fetchImpl(url, init);
    if (!response.ok) {
      await response.body?.cancel?.().catch(() => {});
      throw new Error(`${options.httpErrorPrefix}（HTTP ${response.status}）`);
    }
    const bytes = await readResponseBytesWithLimit(response, options.maxBytes, options.tooLargeMessage);
    return {
      bytes,
      contentType: response.headers?.get("content-type") ?? "",
      finalUrl: response.url || url,
    };
  } catch (error) {
    if (timedOut || controller.signal.aborted) {
      throw new Error(options.timeoutMessage);
    }
    throw error;
  } finally {
    globalThis.clearTimeout(timeoutId);
  }
}
