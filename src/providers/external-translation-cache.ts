import type { RuntimeExternalEngineConfig } from "../shared/translation-engine-settings";
import type { ExternalTranslationTerminologyEntry } from "./external-translation";

const CACHE_DB_NAME = "pagelingo-external-translation-cache-v1";
const CACHE_DB_STORE = "entries";
const CACHE_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_IDB_ENTRIES = 8000;

interface StoredCacheRecord {
  key: string;
  html: string;
  updatedAt: number;
}

function fnv1aHex(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function terminologySignature(entries: readonly ExternalTranslationTerminologyEntry[] | undefined): string {
  if (!entries?.length) return "";
  return entries
    .map((entry) => `${entry.mode}:${entry.source}=>${entry.target}`)
    .sort()
    .join("|");
}

export function externalEngineScopeKey(config: RuntimeExternalEngineConfig): string {
  const promptHash = fnv1aHex(config.prompt || "");
  const customHash = config.type === "custom-rest"
    ? fnv1aHex(`${config.baseUrl}|${config.bodyJson}|${config.responsePath}`)
    : "";
  return [
    config.id,
    config.type,
    config.baseUrl,
    config.model,
    config.region,
    config.disableThinking === false ? "think" : "fast",
    promptHash,
    customHash,
  ].join("\u001f");
}

export function externalTranslationCacheKey(
  config: RuntimeExternalEngineConfig,
  sourceLanguage: string,
  targetLanguage: string,
  html: string,
  terminology?: readonly ExternalTranslationTerminologyEntry[],
): string {
  const scope = externalEngineScopeKey(config);
  const terms = terminologySignature(terminology);
  return `${scope}\u0000${sourceLanguage}>${targetLanguage}\u0000${terms ? fnv1aHex(terms) : ""}\u0000${html}`;
}

export class ExternalTranslationCache {
  readonly #maxMemoryEntries: number;
  readonly #maxInputCharacters: number;
  readonly #memory = new Map<string, string>();
  readonly #inFlight = new Map<string, Promise<string>>();
  readonly #durableEnabled: boolean;
  #dbPromise: Promise<IDBDatabase | null> | null = null;
  #writeCount = 0;

  constructor(options: {
    maxMemoryEntries?: number;
    maxInputCharacters?: number;
    durable?: boolean;
  } = {}) {
    this.#maxMemoryEntries = Math.max(1, options.maxMemoryEntries ?? 4096);
    this.#maxInputCharacters = Math.max(1, options.maxInputCharacters ?? 4096);
    this.#durableEnabled = options.durable !== false && typeof indexedDB !== "undefined";
  }

  isCacheable(html: string): boolean {
    return html.length > 0 && html.length <= this.#maxInputCharacters;
  }

  getMemory(key: string): string | undefined {
    const value = this.#memory.get(key);
    if (value === undefined) return undefined;
    this.#memory.delete(key);
    this.#memory.set(key, value);
    return value;
  }

  setMemory(key: string, html: string): void {
    if (this.#memory.has(key)) this.#memory.delete(key);
    this.#memory.set(key, html);
    while (this.#memory.size > this.#maxMemoryEntries) {
      const oldest = this.#memory.keys().next();
      if (oldest.done) break;
      this.#memory.delete(oldest.value);
    }
  }

  async get(key: string): Promise<string | undefined> {
    const inMemory = this.getMemory(key);
    if (inMemory !== undefined) return inMemory;
    if (!this.#durableEnabled) return undefined;
    const record = await this.#idbGet(key);
    if (!record) return undefined;
    if (Date.now() - record.updatedAt > CACHE_TTL_MS) {
      void this.#idbDelete(key);
      return undefined;
    }
    this.setMemory(key, record.html);
    return record.html;
  }

  async getMany(keys: readonly string[]): Promise<Map<string, string>> {
    const hits = new Map<string, string>();
    const missing: string[] = [];
    for (const key of keys) {
      const mem = this.getMemory(key);
      if (mem !== undefined) hits.set(key, mem);
      else missing.push(key);
    }
    if (missing.length === 0 || !this.#durableEnabled) return hits;
    const db = await this.#openDb();
    if (!db) return hits;
    const now = Date.now();
    try {
      await new Promise<void>((resolve) => {
        const tx = db.transaction(CACHE_DB_STORE, "readonly");
        const store = tx.objectStore(CACHE_DB_STORE);
        let remaining = missing.length;
        for (const key of missing) {
          const request = store.get(key);
          request.onsuccess = () => {
            const record = request.result as StoredCacheRecord | undefined;
            if (record && typeof record.html === "string" && now - record.updatedAt <= CACHE_TTL_MS) {
              this.setMemory(key, record.html);
              hits.set(key, record.html);
            }
            remaining -= 1;
            if (remaining === 0) resolve();
          };
          request.onerror = () => {
            remaining -= 1;
            if (remaining === 0) resolve();
          };
        }
        tx.onerror = () => resolve();
        tx.onabort = () => resolve();
      });
    } catch {
      // Cache read failure must never fail translation.
    }
    return hits;
  }

  set(key: string, html: string): void {
    this.setMemory(key, html);
    if (!this.#durableEnabled) return;
    void this.#idbPut({ key, html, updatedAt: Date.now() });
  }

  getInFlight(key: string): Promise<string> | undefined {
    return this.#inFlight.get(key);
  }

  trackInFlight(key: string, promise: Promise<string>): Promise<string> {
    this.#inFlight.set(key, promise);
    void promise.finally(() => {
      if (this.#inFlight.get(key) === promise) this.#inFlight.delete(key);
    });
    return promise;
  }

  clearMemory(): void {
    this.#memory.clear();
  }

  async clearAll(): Promise<void> {
    this.#memory.clear();
    if (!this.#durableEnabled) return;
    const db = await this.#openDb();
    if (!db) return;
    try {
      await new Promise<void>((resolve) => {
        const tx = db.transaction(CACHE_DB_STORE, "readwrite");
        tx.objectStore(CACHE_DB_STORE).clear();
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
        tx.onabort = () => resolve();
      });
    } catch {}
  }

  size(): number {
    return this.#memory.size;
  }

  async count(): Promise<number> {
    if (!this.#durableEnabled) return this.#memory.size;
    const db = await this.#openDb();
    if (!db) return this.#memory.size;
    try {
      const idbCount = await new Promise<number>((resolve) => {
        const tx = db.transaction(CACHE_DB_STORE, "readonly");
        const request = tx.objectStore(CACHE_DB_STORE).count();
        request.onsuccess = () => resolve(typeof request.result === "number" ? request.result : 0);
        request.onerror = () => resolve(0);
      });
      return Math.max(idbCount, this.#memory.size);
    } catch {
      return this.#memory.size;
    }
  }

  #openDb(): Promise<IDBDatabase | null> {
    if (!this.#durableEnabled) return Promise.resolve(null);
    if (!this.#dbPromise) {
      this.#dbPromise = new Promise<IDBDatabase | null>((resolve) => {
        try {
          const request = indexedDB.open(CACHE_DB_NAME, 1);
          request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(CACHE_DB_STORE)) {
              const store = db.createObjectStore(CACHE_DB_STORE, { keyPath: "key" });
              store.createIndex("updatedAt", "updatedAt");
            }
          };
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => resolve(null);
        } catch {
          resolve(null);
        }
      });
    }
    return this.#dbPromise;
  }

  async #idbGet(key: string): Promise<StoredCacheRecord | null> {
    const db = await this.#openDb();
    if (!db) return null;
    try {
      return await new Promise<StoredCacheRecord | null>((resolve) => {
        const tx = db.transaction(CACHE_DB_STORE, "readonly");
        const request = tx.objectStore(CACHE_DB_STORE).get(key);
        request.onsuccess = () => resolve((request.result as StoredCacheRecord | undefined) ?? null);
        request.onerror = () => resolve(null);
      });
    } catch {
      return null;
    }
  }

  async #idbPut(record: StoredCacheRecord): Promise<void> {
    const db = await this.#openDb();
    if (!db) return;
    try {
      await new Promise<void>((resolve) => {
        const tx = db.transaction(CACHE_DB_STORE, "readwrite");
        tx.objectStore(CACHE_DB_STORE).put(record);
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
        tx.onabort = () => resolve();
      });
      this.#writeCount += 1;
      if (this.#writeCount % 250 === 0) void this.#pruneOldEntries(db);
    } catch {}
  }

  async #idbDelete(key: string): Promise<void> {
    const db = await this.#openDb();
    if (!db) return;
    try {
      await new Promise<void>((resolve) => {
        const tx = db.transaction(CACHE_DB_STORE, "readwrite");
        tx.objectStore(CACHE_DB_STORE).delete(key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
        tx.onabort = () => resolve();
      });
    } catch {}
  }

  async #pruneOldEntries(db: IDBDatabase): Promise<void> {
    try {
      await new Promise<void>((resolve) => {
        const tx = db.transaction(CACHE_DB_STORE, "readwrite");
        const store = tx.objectStore(CACHE_DB_STORE);
        const countReq = store.count();
        countReq.onsuccess = () => {
          const total = countReq.result;
          const excess = total - MAX_IDB_ENTRIES;
          if (excess <= 0) {
            resolve();
            return;
          }
          const index = store.index("updatedAt");
          let deleted = 0;
          const cursorReq = index.openCursor();
          cursorReq.onsuccess = () => {
            const cursor = cursorReq.result;
            if (!cursor || deleted >= excess) {
              resolve();
              return;
            }
            cursor.delete();
            deleted += 1;
            cursor.continue();
          };
          cursorReq.onerror = () => resolve();
        };
        countReq.onerror = () => resolve();
        tx.onerror = () => resolve();
        tx.onabort = () => resolve();
      });
    } catch {}
  }
}
