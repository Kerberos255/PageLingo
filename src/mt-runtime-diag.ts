import { Wllama } from "@wllama/wllama/esm/index.js";

declare global {
  interface Window {
    __mtRuntimeDiag?: unknown;
  }
}

function serialize(value: unknown): unknown {
  if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack };
  if (value instanceof Event) return { eventType: value.type };
  if (typeof value === "bigint") return String(value);
  if (value && typeof value === "object") {
    try { return JSON.parse(JSON.stringify(value)); } catch { return String(value); }
  }
  return value;
}

async function run(): Promise<void> {
  const started = performance.now();
  const logs: unknown[] = [];
  const push = (level: string, args: unknown[]) => {
    logs.push({ atMs: Math.round(performance.now() - started), level, args: args.map(serialize) });
    if (logs.length > 100) logs.shift();
  };
  const logger = {
    debug: (...args: unknown[]) => push("debug", args),
    log: (...args: unknown[]) => push("log", args),
    warn: (...args: unknown[]) => push("warn", args),
    error: (...args: unknown[]) => push("error", args),
  } as typeof console;

  window.__mtRuntimeDiag = {
    state: "running",
    crossOriginIsolated: globalThis.crossOriginIsolated,
    workerUrl: browser.runtime.getURL("vendor/wllama/pagelingo-worker.js"),
    wasmUrl: browser.runtime.getURL("vendor/wllama/wllama.wasm"),
    logs,
  };

  const engine = new Wllama(
    { default: browser.runtime.getURL("vendor/wllama/wllama.wasm") },
    { logger },
  );

  try {
    const modelUrl = new URLSearchParams(location.search).get("model");
    if (!modelUrl) throw new Error("missing ?model= diagnostic URL");
    const fetchedAt = performance.now();
    const response = await fetch(modelUrl);
    if (!response.ok) throw new Error(`tiny model fetch failed: HTTP ${response.status}`);
    const blob = await response.blob();
    push("diag", ["tiny-model-fetched", { bytes: blob.size, ms: performance.now() - fetchedAt }]);

    const timeout = new Promise<never>((_, reject) => {
      window.setTimeout(() => reject(new Error("tiny wllama load timed out after 20s")), 20_000);
    });
    await Promise.race([
      engine.loadModel(
        [blob],
        { n_ctx: 128, n_threads: 1, n_gpu_layers: 0 },
      ),
      timeout,
    ]);
    window.__mtRuntimeDiag = {
      state: "done",
      ok: true,
      loadMs: performance.now() - started,
      threads: engine.getNumThreads(),
      multithread: engine.isMultithread(),
      crossOriginIsolated: globalThis.crossOriginIsolated,
      logs,
    };
  } catch (error) {
    window.__mtRuntimeDiag = {
      state: "error",
      ok: false,
      elapsedMs: performance.now() - started,
      error: error instanceof Error ? error.message : String(error),
      name: error instanceof Error ? error.name : undefined,
      crossOriginIsolated: globalThis.crossOriginIsolated,
      logs,
    };
  } finally {
    try { await engine.exit(); } catch {}
  }
}

void run();
