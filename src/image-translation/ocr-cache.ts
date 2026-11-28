import {
  DEFAULT_OCR_PROFILE,
  DOC_LAYOUT_MODEL,
  OCR_PROFILES,
  SHARED_OCR_DETECTION,
  getOcrProfile,
  ocrProfileRecognitionBytes,
  ocrProfileTotalBytes,
  type DocLayoutModelAsset,
  type OcrModelAsset,
  type OcrProfile,
} from "./ocr-models";

export interface ImageOcrProfileStatus {
  id: string;
  label: string;
  languagesLabel: string;
  installed: boolean;
  detectionInstalled: boolean;
  recognitionBytes: number;
  totalBytes: number;
}

export interface ImageOcrStatus {
  installed: boolean;
  totalBytes: number;
  runtimeSupported: boolean;
  activeProfileId: string;
  detectionInstalled: boolean;
  detectionBytes: number;
  docLayoutInstalled: boolean;
  docLayoutBytes: number;
  profiles: ImageOcrProfileStatus[];
}

export interface ImageOcrBundle {
  profile: OcrProfile;
  detectionModel: ArrayBuffer;
  recognitionModel: ArrayBuffer;
  dictionary: string;
}

export interface DocLayoutBundle {
  asset: DocLayoutModelAsset;
  model: ArrayBuffer;
}

type OcrProgress = (status: string) => void;

const OCR_CACHE = "pagelingo-image-ocr-v1";
const OCR_DB_NAME = "pagelingo-image-ocr-models-v1";
const OCR_DB_STORE = "assets";
const OCR_DOWNLOAD_TIMEOUT_MS = 90_000;
const OCR_MEMORY_IDLE_MS = 5 * 60_000;
const ocrAssetMemoryCache = new Map<string, ArrayBuffer>();
const ocrBundlePromises = new Map<string, Promise<ImageOcrBundle>>();
let docLayoutPromise: Promise<DocLayoutBundle> | null = null;
let ocrDeletion: Promise<void> | null = null;
let ocrMemoryIdleTimer: ReturnType<typeof setTimeout> | null = null;
let activeBundleLoads = 0;

function clearOcrMemoryIdleTimer(): void {
  if (ocrMemoryIdleTimer !== null) {
    globalThis.clearTimeout(ocrMemoryIdleTimer);
    ocrMemoryIdleTimer = null;
  }
}

export function clearOcrMemoryCache(): void {
  clearOcrMemoryIdleTimer();
  ocrAssetMemoryCache.clear();
  ocrBundlePromises.clear();
  docLayoutPromise = null;
}

function scheduleOcrMemoryEviction(): void {
  clearOcrMemoryIdleTimer();
  if (activeBundleLoads > 0 || ocrDeletion) return;
  if (ocrAssetMemoryCache.size === 0 && ocrBundlePromises.size === 0 && !docLayoutPromise) return;
  ocrMemoryIdleTimer = globalThis.setTimeout(() => {
    ocrMemoryIdleTimer = null;
    if (activeBundleLoads > 0 || ocrDeletion) {
      scheduleOcrMemoryEviction();
      return;
    }
    ocrAssetMemoryCache.clear();
    ocrBundlePromises.clear();
    docLayoutPromise = null;
  }, OCR_MEMORY_IDLE_MS);
}

function cacheKey(asset: OcrModelAsset): string {
  return `https://pagelingo.invalid/image-ocr/${encodeURIComponent(asset.id)}`;
}

function openOcrDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(OCR_DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(OCR_DB_STORE)) db.createObjectStore(OCR_DB_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("OCR 模型数据库打开失败"));
  });
}

async function idbGetAsset(asset: OcrModelAsset): Promise<ArrayBuffer | null> {
  try {
    const db = await openOcrDb();
    const value = await new Promise<unknown>((resolve, reject) => {
      const tx = db.transaction(OCR_DB_STORE, "readonly");
      const request = tx.objectStore(OCR_DB_STORE).get(asset.id);
      request.onsuccess = () => resolve(request.result ?? null);
      request.onerror = () => reject(request.error);
    });
    db.close();
    if (!(value instanceof ArrayBuffer)) return null;
    try {
      await validateAsset(asset, value);
      return value;
    } catch {
      await idbDeleteAsset(asset).catch(() => {});
      return null;
    }
  } catch {
    return null;
  }
}

async function idbHasAsset(asset: OcrModelAsset): Promise<boolean> {
  try {
    const db = await openOcrDb();
    const value = await new Promise<unknown>((resolve, reject) => {
      const tx = db.transaction(OCR_DB_STORE, "readonly");
      const request = tx.objectStore(OCR_DB_STORE).get(asset.id);
      request.onsuccess = () => resolve(request.result ?? null);
      request.onerror = () => reject(request.error);
    });
    db.close();
    return value instanceof ArrayBuffer && value.byteLength === asset.bytes;
  } catch {
    return false;
  }
}

async function idbPutAsset(asset: OcrModelAsset, buffer: ArrayBuffer): Promise<void> {
  const db = await openOcrDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(OCR_DB_STORE, "readwrite");
      tx.objectStore(OCR_DB_STORE).put(buffer.slice(0), asset.id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error("OCR 模型数据库写入失败"));
    });
  } finally {
    db.close();
  }
}

async function idbDeleteAsset(asset: OcrModelAsset): Promise<void> {
  const db = await openOcrDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(OCR_DB_STORE, "readwrite");
      tx.objectStore(OCR_DB_STORE).delete(asset.id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
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
  if (digest !== asset.sha256) {
    throw new Error(`${asset.label} SHA-256 校验失败`);
  }
}

async function hasCachedAsset(asset: OcrModelAsset): Promise<boolean> {
  const memory = ocrAssetMemoryCache.get(asset.id);
  if (memory instanceof ArrayBuffer && memory.byteLength === asset.bytes) return true;
  if (await idbHasAsset(asset)) return true;
  try {
    const cache = await caches.open(OCR_CACHE);
    const response = await cache.match(cacheKey(asset));
    if (response) {
      const buffer = await response.arrayBuffer();
      await validateAsset(asset, buffer);
      await idbPutAsset(asset, buffer);
      return true;
    }
  } catch {
    // Ignore damaged legacy cache.
  }
  return false;
}

async function cachedAsset(asset: OcrModelAsset): Promise<ArrayBuffer | null> {
  const memory = ocrAssetMemoryCache.get(asset.id);
  if (memory instanceof ArrayBuffer && memory.byteLength === asset.bytes) return memory;
  const durable = await idbGetAsset(asset);
  if (durable) {
    ocrAssetMemoryCache.set(asset.id, durable);
    return durable;
  }
  try {
    const cache = await caches.open(OCR_CACHE);
    const response = await cache.match(cacheKey(asset));
    if (response) {
      const buffer = await response.arrayBuffer();
      await validateAsset(asset, buffer);
      await idbPutAsset(asset, buffer);
      ocrAssetMemoryCache.set(asset.id, buffer);
      return buffer;
    }
  } catch {
    // Ignore damaged legacy cache.
  }
  return null;
}

async function downloadAsset(asset: OcrModelAsset, progress?: OcrProgress): Promise<ArrayBuffer> {
  const cached = await cachedAsset(asset);
  if (cached) {
    progress?.(`${asset.label} · 已就绪`);
    return cached;
  }
  progress?.(`正在下载 ${asset.label}…`);
  const controller = new AbortController();
  const timeout = globalThis.setTimeout(() => controller.abort(), OCR_DOWNLOAD_TIMEOUT_MS);
  try {
    const response = await fetch(asset.url, {
      cache: "no-store",
      credentials: "omit",
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`${asset.label} 下载失败：HTTP ${response.status}`);
    }
    const buffer = await response.arrayBuffer();
    progress?.(`正在准备 ${asset.label}…`);
    await validateAsset(asset, buffer);
    await idbPutAsset(asset, buffer);
    ocrAssetMemoryCache.set(asset.id, buffer);
    return buffer;
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`${asset.label} 下载超时，请检查网络后重试`);
    }
    throw error;
  } finally {
    globalThis.clearTimeout(timeout);
  }
}

export async function getImageOcrStatus(activeProfile: OcrProfile | string = DEFAULT_OCR_PROFILE): Promise<ImageOcrStatus> {
  if (ocrDeletion) await ocrDeletion;
  const resolved = typeof activeProfile === "string" ? getOcrProfile(activeProfile) : activeProfile;
  const [defaultDetInstalled, docLayoutInstalled] = await Promise.all([
    hasCachedAsset(SHARED_OCR_DETECTION),
    hasCachedAsset(DOC_LAYOUT_MODEL),
  ]);
  const detCache = new Map<string, boolean>([[SHARED_OCR_DETECTION.id, defaultDetInstalled]]);
  const profiles: ImageOcrProfileStatus[] = await Promise.all(
    OCR_PROFILES.map(async (profile) => {
      const [rec, dict] = await Promise.all([hasCachedAsset(profile.recognition), hasCachedAsset(profile.dictionary)]);
      let detOk = detCache.get(profile.detection.id);
      if (detOk === undefined) {
        detOk = await hasCachedAsset(profile.detection);
        detCache.set(profile.detection.id, detOk);
      }
      return {
        id: profile.id,
        label: profile.label,
        languagesLabel: profile.languagesLabel,
        installed: detOk && rec && dict,
        detectionInstalled: detOk,
        recognitionBytes: ocrProfileRecognitionBytes(profile),
        totalBytes: ocrProfileTotalBytes(profile),
      };
    }),
  );
  const activeEntry = profiles.find((entry) => entry.id === resolved.id) ?? profiles[0]!;
  return {
    installed: activeEntry.installed,
    totalBytes: activeEntry.totalBytes,
    runtimeSupported: typeof WebAssembly === "object" && typeof Worker === "function",
    activeProfileId: resolved.id,
    detectionInstalled: activeEntry.detectionInstalled,
    detectionBytes: resolved.detection.bytes,
    docLayoutInstalled,
    docLayoutBytes: DOC_LAYOUT_MODEL.bytes,
    profiles,
  };
}

export async function getDocLayoutBundle(progress?: OcrProgress): Promise<DocLayoutBundle> {
  if (ocrDeletion) await ocrDeletion;
  clearOcrMemoryIdleTimer();
  if (docLayoutPromise) {
    progress?.("正在准备文档版面检测模型…");
    try {
      return await docLayoutPromise;
    } finally {
      scheduleOcrMemoryEviction();
    }
  }
  activeBundleLoads += 1;
  const task = (async (): Promise<DocLayoutBundle> => {
    progress?.("正在检查文档版面检测模型缓存…");
    const model = await downloadAsset(DOC_LAYOUT_MODEL, progress);
    progress?.("文档版面检测模型已准备完成");
    return { asset: DOC_LAYOUT_MODEL, model };
  })();
  docLayoutPromise = task;
  try {
    return await task;
  } catch (error) {
    if (docLayoutPromise === task) docLayoutPromise = null;
    throw error;
  } finally {
    activeBundleLoads = Math.max(0, activeBundleLoads - 1);
    scheduleOcrMemoryEviction();
  }
}

export async function deleteDocLayoutModel(): Promise<void> {
  if (ocrDeletion) return ocrDeletion;
  clearOcrMemoryIdleTimer();
  ocrDeletion = (async () => {
    await docLayoutPromise?.catch(() => {});
    docLayoutPromise = null;
    await deleteSingleAsset(DOC_LAYOUT_MODEL);
  })();
  try {
    await ocrDeletion;
  } finally {
    ocrDeletion = null;
    scheduleOcrMemoryEviction();
  }
}

export async function getImageOcrBundle(
  profileOrId: OcrProfile | string = DEFAULT_OCR_PROFILE,
  progress?: OcrProgress,
): Promise<ImageOcrBundle> {
  if (ocrDeletion) await ocrDeletion;
  clearOcrMemoryIdleTimer();
  const profile = typeof profileOrId === "string" ? getOcrProfile(profileOrId) : profileOrId;
  const existing = ocrBundlePromises.get(profile.id);
  if (existing) {
    progress?.("正在准备 OCR 模型…");
    try {
      return await existing;
    } finally {
      scheduleOcrMemoryEviction();
    }
  }
  activeBundleLoads += 1;
  const task = (async (): Promise<ImageOcrBundle> => {
    progress?.("正在检查 OCR 模型缓存…");
    const detectionModel = await downloadAsset(profile.detection, progress);
    const recognitionModel = await downloadAsset(profile.recognition, progress);
    const dictionaryBuffer = await downloadAsset(profile.dictionary, progress);
    progress?.("OCR 模型已准备完成");
    return {
      profile,
      detectionModel,
      recognitionModel,
      dictionary: new TextDecoder().decode(dictionaryBuffer),
    };
  })();
  ocrBundlePromises.set(profile.id, task);
  try {
    return await task;
  } catch (error) {
    if (ocrBundlePromises.get(profile.id) === task) ocrBundlePromises.delete(profile.id);
    throw error;
  } finally {
    activeBundleLoads = Math.max(0, activeBundleLoads - 1);
    scheduleOcrMemoryEviction();
  }
}

async function deleteSingleAsset(asset: OcrModelAsset): Promise<void> {
  ocrAssetMemoryCache.delete(asset.id);
  await idbDeleteAsset(asset).catch(() => {});
  try {
    const cache = await caches.open(OCR_CACHE);
    await cache.delete(cacheKey(asset));
  } catch {
    // Ignore cache API errors.
  }
}

export async function deleteImageOcrModels(profileOrId: OcrProfile | string = DEFAULT_OCR_PROFILE): Promise<void> {
  if (ocrDeletion) return ocrDeletion;
  clearOcrMemoryIdleTimer();
  const profile = typeof profileOrId === "string" ? getOcrProfile(profileOrId) : profileOrId;
  ocrDeletion = (async () => {
    await ocrBundlePromises.get(profile.id)?.catch(() => {});
    ocrBundlePromises.delete(profile.id);
    await Promise.all([
      deleteSingleAsset(profile.recognition),
      deleteSingleAsset(profile.dictionary),
    ]);
    // Only remove the detector when no other installed OCR language pack shares it.
    const othersInstalled = await Promise.all(
      OCR_PROFILES
        .filter((candidate) => candidate.id !== profile.id && candidate.detection.id === profile.detection.id)
        .map((candidate) => hasCachedAsset(candidate.recognition)),
    );
    if (!othersInstalled.some(Boolean)) {
      await deleteSingleAsset(profile.detection);
    }
  })();
  try {
    await ocrDeletion;
  } finally {
    ocrDeletion = null;
    scheduleOcrMemoryEviction();
  }
}
