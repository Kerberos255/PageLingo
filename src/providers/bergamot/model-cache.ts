import {
  EN_TO_ZH_HANS_MODEL,
  type BergamotModelAsset,
  type BergamotModelFileType,
} from "./model-manifest";

const CACHE_NAME = "firefox-local-translate-models-v1";

export interface CachedModelFile {
  type: BergamotModelFileType;
  alignment: 64 | 256;
  buffer: ArrayBuffer;
}

function bytesToHex(bytes: Uint8Array): string {
  let value = "";
  for (const byte of bytes) value += byte.toString(16).padStart(2, "0");
  return value;
}

async function sha256(buffer: ArrayBuffer): Promise<string> {
  return bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", buffer)));
}

async function verify(asset: BergamotModelAsset, buffer: ArrayBuffer): Promise<void> {
  if (buffer.byteLength !== asset.bytes) {
    throw new Error(
      `Model ${asset.type} has wrong size: expected ${asset.bytes}, got ${buffer.byteLength}`,
    );
  }
  const actual = await sha256(buffer);
  if (actual !== asset.sha256) {
    throw new Error(`Model ${asset.type} failed SHA-256 verification`);
  }
}

async function readCached(cache: Cache, asset: BergamotModelAsset): Promise<ArrayBuffer | null> {
  const response = await cache.match(asset.url);
  if (!response) return null;

  const buffer = await response.arrayBuffer();
  try {
    await verify(asset, buffer);
    return buffer;
  } catch {
    await cache.delete(asset.url);
    return null;
  }
}

async function download(cache: Cache, asset: BergamotModelAsset): Promise<ArrayBuffer> {
  const response = await fetch(asset.url, { cache: "force-cache" });
  if (!response.ok) {
    throw new Error(`Model ${asset.type} download failed with HTTP ${response.status}`);
  }

  const buffer = await response.arrayBuffer();
  await verify(asset, buffer);

  await cache.put(
    asset.url,
    new Response(buffer.slice(0), {
      headers: {
        "content-type": "application/octet-stream",
        "x-flt-sha256": asset.sha256,
      },
    }),
  );
  return buffer;
}

async function loadAsset(cache: Cache, asset: BergamotModelAsset): Promise<CachedModelFile> {
  const buffer = (await readCached(cache, asset)) ?? (await download(cache, asset));
  return { type: asset.type, alignment: asset.alignment, buffer };
}

export async function loadEnglishToChineseModel(): Promise<CachedModelFile[]> {
  const cache = await caches.open(CACHE_NAME);
  const files: CachedModelFile[] = [];

  // Load sequentially to keep peak memory lower while the 44 MB model is verified/cached.
  for (const asset of EN_TO_ZH_HANS_MODEL) {
    files.push(await loadAsset(cache, asset));
  }
  return files;
}
