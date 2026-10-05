import { LoggerWithoutDebug, Wllama } from "@wllama/wllama/esm/index.js";

declare global {
  interface Window {
    __mtRuntimeDiag?: unknown;
  }
}

async function run(): Promise<void> {
  const started = performance.now();
  try {
    const engine = new Wllama(
      { default: browser.runtime.getURL("vendor/wllama/wllama.wasm") },
      { logger: LoggerWithoutDebug },
    );
    await engine.loadModelFromUrl(
      "https://huggingface.co/ggml-org/tiny-llamas/resolve/main/stories260K.gguf",
      { n_ctx: 128, n_threads: 1, n_gpu_layers: 0, useCache: false },
    );
    window.__mtRuntimeDiag = {
      ok: true,
      loadMs: performance.now() - started,
      threads: engine.getNumThreads(),
      multithread: engine.isMultithread(),
    };
    await engine.exit();
  } catch (error) {
    window.__mtRuntimeDiag = {
      ok: false,
      elapsedMs: performance.now() - started,
      error: error instanceof Error ? error.message : String(error),
      name: error instanceof Error ? error.name : undefined,
    };
  }
}

void run();
