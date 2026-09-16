import { DEFAULT_OCR_PROFILE, ocrProfileTotalBytes, type OcrModelAsset, type OcrProfile } from "./ocr-models";

const OCR_CACHE = "pagelingo-image-ocr-v1";

export interface ImageOcrStatus {
  installed: boolean;
  totalBytes: number;
  runtimeSupported: boolean;
}

export interface ImageOcrBundle {
  profile: OcrProfile;
  detectionModel: ArrayBuffer;
  recognitionModel: ArrayBuffer;
  dictionary: string;
}

function cacheKey(asset: OcrModelAsset): string {
  return `https://pagelingo.invalid/image-ocr/${encodeURIComponent(asset.id)}`;
}

async function sha256Hex(buffer: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
}

async function validateAsset(asset: OcrModelAsset, buffer: ArrayBuffer): Promise<void> {
  if (buffer.byteLength !== asset.bytes) {
    throw new Error(`${asset.label} 大小校验失败：${buffer.byteLength} != ${asset.bytes}`);
  }
  const digest = await sha256Hex(buffer);
  if (digest !== asset.sha256) throw new Error(`${asset.label} SHA-256 校验失败`);
}

async function cachedAsset(asset: OcrModelAsset): Promise<ArrayBuffer | null> {
  const cache = await caches.open(OCR_CACHE);
  const response = await cache.match(cacheKey(asset));
  if (!response) return null;
  const buffer = await response.arrayBuffer();
  try {
    await validateAsset(asset, buffer);
    return buffer;
  } catch {
    await cache.delete(cacheKey(asset));
    return null;
  }
}

async function downloadAsset(asset: OcrModelAsset): Promise<ArrayBuffer> {
  const cached = await cachedAsset(asset);
  if (cached) return cached;
  const response = await fetch(asset.url, { cache: "no-store", credentials: "omit" });
  if (!response.ok) throw new Error(`${asset.label} 下载失败：HTTP ${response.status}`);
  const buffer = await response.arrayBuffer();
  await validateAsset(asset, buffer);
  const cache = await caches.open(OCR_CACHE);
  await cache.put(cacheKey(asset), new Response(buffer.slice(0), { headers: { "content-type": "application/octet-stream" } }));
  return buffer;
}

async function hasCachedAsset(asset: OcrModelAsset): Promise<boolean> {
  const cache = await caches.open(OCR_CACHE);
  return Boolean(await cache.match(cacheKey(asset)));
}

export async function getImageOcrStatus(profile: OcrProfile = DEFAULT_OCR_PROFILE): Promise<ImageOcrStatus> {
  const assets = [profile.detection, profile.recognition, profile.dictionary];
  const installed = (await Promise.all(assets.map(hasCachedAsset))).every(Boolean);
  return {
    installed,
    totalBytes: ocrProfileTotalBytes(profile),
    runtimeSupported: typeof WebAssembly === "object" && typeof Worker === "function",
  };
}

export async function getImageOcrBundle(profile: OcrProfile = DEFAULT_OCR_PROFILE): Promise<ImageOcrBundle> {
  const [detectionModel, recognitionModel, dictionaryBuffer] = await Promise.all([
    downloadAsset(profile.detection),
    downloadAsset(profile.recognition),
    downloadAsset(profile.dictionary),
  ]);
  return {
    profile,
    detectionModel,
    recognitionModel,
    dictionary: new TextDecoder().decode(dictionaryBuffer),
  };
}

export async function deleteImageOcrModels(profile: OcrProfile = DEFAULT_OCR_PROFILE): Promise<void> {
  const cache = await caches.open(OCR_CACHE);
  await Promise.all([profile.detection, profile.recognition, profile.dictionary].map((asset) => cache.delete(cacheKey(asset))));
}
