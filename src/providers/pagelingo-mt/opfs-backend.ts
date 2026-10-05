export interface PageLingoStorageBackend {
  isSupported(): boolean;
  read(key: string): Promise<Blob | null>;
  write(key: string, stream: ReadableStream): Promise<void>;
  getSize(key: string): Promise<number>;
  list(): Promise<Array<{ key: string; size: number }>>;
  delete(key: string): Promise<void>;
}

const CACHE_DIR = "pagelingo-mt-cache";

function errorText(error: unknown): string {
  if (error instanceof DOMException) return `${error.name}: ${error.message || "DOM storage error"}`;
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  if (typeof Event !== "undefined" && error instanceof Event) {
    return `browser event "${error.type || "error"}"`;
  }
  if (error && typeof error === "object") {
    const value = error as { name?: unknown; message?: unknown; type?: unknown };
    const name = typeof value.name === "string" ? value.name : "";
    const message = typeof value.message === "string" ? value.message : "";
    const type = typeof value.type === "string" ? value.type : "";
    const text = [name, message || type].filter(Boolean).join(": ");
    if (text) return text;
  }
  return String(error);
}

async function cacheDirectory(): Promise<FileSystemDirectoryHandle> {
  if (!navigator.storage?.getDirectory) {
    throw new Error("当前 Firefox 环境不支持 OPFS，本地 MT 模型无法保存");
  }
  try {
    const root = await navigator.storage.getDirectory();
    return await root.getDirectoryHandle(CACHE_DIR, { create: true });
  } catch (error) {
    throw new Error(`无法打开 Firefox 本地模型存储：${errorText(error)}`);
  }
}

export class PageLingoOpfsBackend implements PageLingoStorageBackend {
  isSupported(): boolean {
    return typeof navigator !== "undefined" && Boolean(navigator.storage?.getDirectory);
  }

  async read(key: string): Promise<Blob | null> {
    try {
      const dir = await cacheDirectory();
      const handle = await dir.getFileHandle(key);
      return await handle.getFile();
    } catch (error) {
      if (error instanceof DOMException && error.name === "NotFoundError") return null;
      throw error;
    }
  }

  async write(key: string, stream: ReadableStream): Promise<void> {
    const dir = await cacheDirectory();
    let writable: FileSystemWritableFileStream | null = null;
    const reader = stream.getReader();
    try {
      const handle = await dir.getFileHandle(key, { create: true });
      writable = await handle.createWritable();
      await writable.truncate(0);
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        await writable.write(value);
      }
      await writable.close();
      writable = null;
    } catch (error) {
      try {
        await writable?.abort();
      } catch {}
      throw new Error(`PageLingo MT 写入本地缓存失败：${errorText(error)}`);
    } finally {
      reader.releaseLock();
    }
  }

  async getSize(key: string): Promise<number> {
    try {
      const blob = await this.read(key);
      return blob?.size ?? -1;
    } catch (error) {
      if (error instanceof DOMException && error.name === "NotFoundError") return -1;
      throw error;
    }
  }

  async list(): Promise<Array<{ key: string; size: number }>> {
    const dir = await cacheDirectory();
    const result: Array<{ key: string; size: number }> = [];
    // FileSystemDirectoryHandle.entries() is implemented by Firefox but is still
    // missing from parts of TypeScript's DOM declarations.
    for await (const [key, handle] of (dir as any).entries()) {
      if (handle?.kind !== "file") continue;
      const file = await handle.getFile();
      result.push({ key, size: file.size });
    }
    return result;
  }

  async delete(key: string): Promise<void> {
    try {
      const dir = await cacheDirectory();
      await dir.removeEntry(key);
    } catch (error) {
      if (error instanceof DOMException && error.name === "NotFoundError") return;
      throw error;
    }
  }
}

export async function ensureMtStorageCapacity(requiredBytes: number): Promise<void> {
  if (!navigator.storage?.estimate) return;
  try {
    const estimate = await navigator.storage.estimate();
    if (typeof estimate.quota !== "number" || typeof estimate.usage !== "number") return;
    const available = Math.max(0, estimate.quota - estimate.usage);
    if (available < requiredBytes) {
      const gb = (available / 1024 / 1024 / 1024).toFixed(2);
      throw new Error(`Firefox 可用本地存储约 ${gb} GiB，不足以保存 PageLingo MT 模型`);
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes("不足以保存")) throw error;
  }
}

export function describeMtError(error: unknown): string {
  const text = errorText(error);
  if (/fetch|network|load failed|failed to fetch/i.test(text)) {
    return `PageLingo MT 下载请求失败：${text}`;
  }
  return text.startsWith("PageLingo MT") || text.startsWith("无法打开")
    ? text
    : `PageLingo MT 操作失败：${text}`;
}
