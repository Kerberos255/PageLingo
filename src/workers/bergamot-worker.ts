/// <reference lib="webworker" />

import type {
  BergamotWorkerRequest,
  BergamotWorkerResponse,
  WorkerModelBundle,
  WorkerModelFile,
} from "../providers/bergamot/protocol";

declare function importScripts(...urls: string[]): void;
declare function loadBergamot(options: Record<string, unknown>): any;

const scope = globalThis as unknown as DedicatedWorkerGlobalScope;
importScripts("vendor/bergamot/bergamot-translator.js");

interface Engine {
  bergamot: any;
  models: any[];
  service: any;
  routeKind: "direct" | "pivot";
}

let engine: Engine | null = null;

function post(message: BergamotWorkerResponse): void {
  scope.postMessage(message);
}

function textConfig(entries: Record<string, string>): string {
  const indent = "            ";
  let result = "\n";
  for (const [key, value] of Object.entries(entries)) result += `${indent}${key}: ${value}\n`;
  return result + indent;
}

async function loadRuntime(): Promise<any> {
  const wasmUrl = new URL("vendor/bergamot/bergamot-translator.wasm", scope.location.href);
  const response = await fetch(wasmUrl);
  if (!response.ok) throw new Error(`Bergamot WASM load failed: HTTP ${response.status}`);
  const wasmBinary = await response.arrayBuffer();

  return new Promise((resolve, reject) => {
    let module: any;
    module = loadBergamot({
      INITIAL_MEMORY: 41_943_040,
      wasmBinary,
      print: () => undefined,
      printErr: (...args: unknown[]) => console.warn("[Bergamot]", ...args),
      onAbort: (reason: unknown) => reject(new Error(`Bergamot WASM aborted during initialization: ${String(reason)}`)),
      onRuntimeInitialized: async () => {
        await Promise.resolve();
        resolve(module);
      },
    });
  });
}

function allocate(bergamot: any, file: WorkerModelFile): any {
  const memory = new bergamot.AlignedMemory(file.buffer.byteLength, file.alignment);
  memory.getByteArrayView().set(new Uint8Array(file.buffer));
  return memory;
}

function createModel(bergamot: any, bundle: WorkerModelBundle): any {
  const byType = new Map(bundle.files.map((file) => [file.type, file] as const));
  const modelFile = byType.get("model");
  const lexFile = byType.get("lex");
  if (!modelFile || !lexFile) throw new Error(`Incomplete Bergamot model bundle: ${bundle.sourceLanguage} → ${bundle.targetLanguage}`);

  const vocabList = new bergamot.AlignedMemoryList();
  const sharedVocab = byType.get("vocab");
  if (sharedVocab) {
    vocabList.push_back(allocate(bergamot, sharedVocab));
    vocabList.push_back(allocate(bergamot, sharedVocab));
  } else {
    const sourceVocab = byType.get("srcvocab");
    const targetVocab = byType.get("trgvocab");
    if (!sourceVocab || !targetVocab) throw new Error(`Missing vocab files: ${bundle.sourceLanguage} → ${bundle.targetLanguage}`);
    vocabList.push_back(allocate(bergamot, sourceVocab));
    vocabList.push_back(allocate(bergamot, targetVocab));
  }

  const config = textConfig({
    "beam-size": "1",
    normalize: "1.0",
    "word-penalty": "0",
    "max-length-break": "128",
    "mini-batch-words": "1024",
    workspace: "128",
    "max-length-factor": "2.0",
    "skip-cost": "true",
    "cpu-threads": "0",
    quiet: "true",
    "quiet-translation": "true",
    "gemm-precision": "int8shiftAlphaAll",
    alignment: "soft",
  });

  return new bergamot.TranslationModel(
    bundle.sourceLanguage,
    bundle.targetLanguage,
    config,
    allocate(bergamot, modelFile),
    allocate(bergamot, lexFile),
    vocabList,
    null,
  );
}

async function initialize(request: Extract<BergamotWorkerRequest, { type: "initialize" }>): Promise<void> {
  if (engine) return;
  if (request.routeKind === "direct" && request.models.length !== 1) throw new Error("Direct route requires one model");
  if (request.routeKind === "pivot" && request.models.length !== 2) throw new Error("Pivot route requires two models");

  const bergamot = await loadRuntime();
  const models = request.models.map((bundle) => createModel(bergamot, bundle));
  const service = new bergamot.BlockingService({ cacheSize: 0 });
  engine = { bergamot, models, service, routeKind: request.routeKind };
}

function translateHtml(html: string): { html: string; inferenceMilliseconds: number } {
  if (!engine) throw new Error("Bergamot worker is not initialized");
  const { bergamot, models, service, routeKind } = engine;
  const messages = new bergamot.VectorString();
  const options = new bergamot.VectorResponseOptions();
  let responses: any = null;

  try {
    messages.push_back(html);
    options.push_back({ qualityScores: false, alignment: true, html: true });
    const started = performance.now();
    responses = routeKind === "pivot"
      ? service.translateViaPivoting(models[0], models[1], messages, options)
      : service.translate(models[0], messages, options);
    const inferenceMilliseconds = performance.now() - started;
    return { html: responses.get(0).getTranslatedText(), inferenceMilliseconds };
  } finally {
    responses?.delete?.();
    messages.delete();
    options.delete();
  }
}

scope.addEventListener("message", async (event: MessageEvent<BergamotWorkerRequest>) => {
  const message = event.data;
  try {
    if (message.type === "initialize") {
      await initialize(message);
      post({ type: "ready" });
      return;
    }
    if (message.type === "translate") {
      post({ type: "result", id: message.id, ...translateHtml(message.html) });
    }
  } catch (error) {
    post({
      type: "error",
      ...(message.type === "translate" ? { id: message.id } : {}),
      error: error instanceof Error ? error.message : String(error),
    });
  }
});
