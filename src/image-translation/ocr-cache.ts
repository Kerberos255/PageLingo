import { DEFAULT_OCR_PROFILE, ocrProfileTotalBytes } from "./ocr-models";
export interface ImageOcrStatus { installed:boolean; totalBytes:number; runtimeSupported:boolean }
export interface ImageOcrBundle { profile:any; detectionModel:ArrayBuffer; recognitionModel:ArrayBuffer; dictionary:string }
var OCR_CACHE = "pagelingo-image-ocr-v1";
var OCR_DB_NAME = "pagelingo-image-ocr-models-v1";
var OCR_DB_STORE = "assets";
var OCR_DOWNLOAD_TIMEOUT_MS = 60_000;
var ocrAssetMemoryCache = new Map();
var ocrBundlePromise = null;
function cacheKey(asset) {
    return `https://pagelingo.invalid/image-ocr/${encodeURIComponent(asset.id)}`;
}
function openOcrDb() {
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
async function idbGetAsset(asset) {
    try {
        const db = await openOcrDb();
        const value = await new Promise((resolve, reject) => {
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
        }
        catch {
            await idbDeleteAsset(asset).catch(() => {});
            return null;
        }
    }
    catch {
        return null;
    }
}
async function idbPutAsset(asset, buffer) {
    const db = await openOcrDb();
    try {
        await new Promise((resolve, reject) => {
            const tx = db.transaction(OCR_DB_STORE, "readwrite");
            tx.objectStore(OCR_DB_STORE).put(buffer.slice(0), asset.id);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error ?? new Error("OCR 模型数据库写入失败"));
        });
    }
    finally {
        db.close();
    }
}
async function idbDeleteAsset(asset) {
    const db = await openOcrDb();
    try {
        await new Promise((resolve, reject) => {
            const tx = db.transaction(OCR_DB_STORE, "readwrite");
            tx.objectStore(OCR_DB_STORE).delete(asset.id);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    }
    finally {
        db.close();
    }
}
async function sha256Hex(buffer) {
    const digest = await crypto.subtle.digest("SHA-256", buffer);
    return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
}
async function validateAsset(asset, buffer) {
    if (buffer.byteLength !== asset.bytes) {
        throw new Error(`${asset.label} 大小校验失败：${buffer.byteLength} != ${asset.bytes}`);
    }
    const digest = await sha256Hex(buffer);
    if (digest !== asset.sha256)
        throw new Error(`${asset.label} SHA-256 校验失败`);
}
async function cachedAsset(asset) {
    const memory = ocrAssetMemoryCache.get(asset.id);
    if (memory instanceof ArrayBuffer && memory.byteLength === asset.bytes) return memory;
    const durable = await idbGetAsset(asset);
    if (durable) {
        ocrAssetMemoryCache.set(asset.id, durable);
        return durable;
    }
    // One-time migration from the old CacheStorage cache used by v0.1.24 and earlier.
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
    }
    catch {
        // A damaged/evicted legacy cache should not block the durable fallback.
    }
    return null;
}
async function downloadAsset(asset, progress) {
    const cached = await cachedAsset(asset);
    if (cached) {
        progress?.(`${asset.label} · 已缓存`);
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
        if (!response.ok)
            throw new Error(`${asset.label} 下载失败：HTTP ${response.status}`);
        const buffer = await response.arrayBuffer();
        progress?.(`正在校验 ${asset.label}…`);
        await validateAsset(asset, buffer);
        await idbPutAsset(asset, buffer);
        ocrAssetMemoryCache.set(asset.id, buffer);
        return buffer;
    }
    catch (error) {
        if (controller.signal.aborted)
            throw new Error(`${asset.label} 下载超时，请检查网络后重试`);
        throw error;
    }
    finally {
        globalThis.clearTimeout(timeout);
    }
}
async function hasCachedAsset(asset) {
    if (ocrAssetMemoryCache.has(asset.id)) return true;
    const durable = await idbGetAsset(asset);
    if (durable) {
        ocrAssetMemoryCache.set(asset.id, durable);
        return true;
    }
    try {
        const cache = await caches.open(OCR_CACHE);
        return Boolean(await cache.match(cacheKey(asset)));
    }
    catch {
        return false;
    }
}
export async function getImageOcrStatus(profile = DEFAULT_OCR_PROFILE) {
    const assets = [profile.detection, profile.recognition, profile.dictionary];
    const installed = (await Promise.all(assets.map(hasCachedAsset))).every(Boolean);
    return {
        installed,
        totalBytes: ocrProfileTotalBytes(profile),
        runtimeSupported: typeof WebAssembly === "object" && typeof Worker === "function",
    };
}
export async function getImageOcrBundle(profile = DEFAULT_OCR_PROFILE, progress) {
    if (ocrBundlePromise) {
        progress?.("OCR 模型已缓存 · 正在载入…");
        return ocrBundlePromise;
    }
    ocrBundlePromise = (async () => {
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
    try {
        return await ocrBundlePromise;
    }
    catch (error) {
        ocrBundlePromise = null;
        throw error;
    }
}
export async function deleteImageOcrModels(profile = DEFAULT_OCR_PROFILE) {
    ocrBundlePromise = null;
    ocrAssetMemoryCache.clear();
    await Promise.all([profile.detection, profile.recognition, profile.dictionary].map(async (asset) => {
        await idbDeleteAsset(asset).catch(() => {});
        try {
            const cache = await caches.open(OCR_CACHE);
            await cache.delete(cacheKey(asset));
        }
        catch {}
    }));
}
