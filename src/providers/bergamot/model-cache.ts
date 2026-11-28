import { decompress as decompressZstd } from "fzstd";
import type { BergamotModelAsset, BergamotModelPair } from "./model-manifest";
import type { WorkerModelBundle, WorkerModelFile } from "./protocol";

const CACHE_NAME = "pagelingo-models-v3";
const MODEL_ASSET_TIMEOUT_MS = 60_000;

const inFlightAssetDownloads = new Map<string, Promise<ArrayBuffer>>();

async function sha256Hex(buffer: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
}

async function verify(buffer: ArrayBuffer, asset: BergamotModelAsset): Promise<void> {
  if (buffer.byteLength !== asset.bytes) {
    throw new Error(`Model asset size mismatch for ${asset.type}: expected ${asset.bytes}, got ${buffer.byteLength}`);
  }
  const actual = await sha256Hex(buffer);
  if (actual !== asset.sha256) {
    throw new Error(`Model asset SHA-256 mismatch for ${asset.type}`);
  }
}

async function decompressZstandard(response: Response, expectedBytes: number): Promise<ArrayBuffer> {
  const compressed = new Uint8Array(await response.arrayBuffer());
  if (compressed.byteLength === 0) throw new Error("Model download returned an empty response body");
  const output = decompressZstd(compressed, new Uint8Array(expectedBytes));
  return output.buffer.slice(output.byteOffset, output.byteOffset + output.byteLength) as ArrayBuffer;
}

async function downloadAndCacheAsset(
  asset: BergamotModelAsset,
  cache: Cache,
  timeoutMs = MODEL_ASSET_TIMEOUT_MS,
): Promise<ArrayBuffer> {
  const controller = new AbortController();
  const timer = globalThis.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(asset.url, { signal: controller.signal });
    if (!response.ok) throw new Error(`Model download failed (${asset.type}): HTTP ${response.status}`);
    const buffer = asset.compression === "zstd"
      ? await decompressZstandard(response, asset.bytes)
      : await response.arrayBuffer();
    await verify(buffer, asset);
    await cache.put(asset.url, new Response(buffer, {
      headers: {
        "content-type": "application/octet-stream",
        "x-pagelingo-sha256": asset.sha256,
      },
    }));
    return buffer;
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`Model download timed out (${asset.type})`);
    }
    throw error;
  } finally {
    globalThis.clearTimeout(timer);
  }
}

export async function loadModelAsset(
  asset: BergamotModelAsset,
  timeoutMs = MODEL_ASSET_TIMEOUT_MS,
): Promise<ArrayBuffer> {
  const existingDownload = inFlightAssetDownloads.get(asset.url);
  if (existingDownload) {
    // Return an isolated ArrayBuffer copy so one caller transferring to a Worker cannot detach another's buffer.
    return (await existingDownload).slice(0);
  }

  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(asset.url);
  if (cached) {
    const buffer = await cached.arrayBuffer();
    try {
      await verify(buffer, asset);
      return buffer;
    } catch {
      await cache.delete(asset.url);
    }
  }

  const racingDownload = inFlightAssetDownloads.get(asset.url);
  if (racingDownload) {
    return (await racingDownload).slice(0);
  }

  const downloadPromise = downloadAndCacheAsset(asset, cache, timeoutMs).finally(() => {
    if (inFlightAssetDownloads.get(asset.url) === downloadPromise) {
      inFlightAssetDownloads.delete(asset.url);
    }
  });
  inFlightAssetDownloads.set(asset.url, downloadPromise);
  return (await downloadPromise).slice(0);
}

export async function loadModelPair(pair: BergamotModelPair): Promise<WorkerModelBundle> {
  const files: WorkerModelFile[] = await Promise.all(
    pair.assets.map(async (asset) => ({
      type: asset.type,
      alignment: asset.alignment,
      buffer: await loadModelAsset(asset),
    })),
  );
  return {
    sourceLanguage: pair.sourceLanguage,
    targetLanguage: pair.targetLanguage,
    files,
  };
}

export async function isModelPairCached(pair: BergamotModelPair): Promise<boolean> {
  const cache = await caches.open(CACHE_NAME);
  const matches = await Promise.all(pair.assets.map((asset) => cache.match(asset.url)));
  return matches.every(Boolean);
}

export async function deleteModelPair(pair: BergamotModelPair): Promise<void> {
  const cache = await caches.open(CACHE_NAME);
  await Promise.all(pair.assets.map((asset) => cache.delete(asset.url)));
}

export async function downloadModelPair(pair: BergamotModelPair): Promise<void> {
  await loadModelPair(pair);
}

export async function pruneModelPair(oldPair: BergamotModelPair, replacement: BergamotModelPair): Promise<void> {
  const keep = new Set(replacement.assets.map((asset) => asset.url));
  const cache = await caches.open(CACHE_NAME);
  await Promise.all(oldPair.assets.filter((asset) => !keep.has(asset.url)).map((asset) => cache.delete(asset.url)));
}
