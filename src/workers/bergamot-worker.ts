/// <reference lib="webworker" />

import type {
  BergamotWorkerRequest,
  BergamotWorkerResponse,
  WorkerModelFile,
} from "../providers/bergamot/protocol";

declare function importScripts(...urls: string[]): void;
declare function loadBergamot(options: Record<string, unknown>): any;

const scope = globalThis as unknown as DedicatedWorkerGlobalScope;
importScripts("vendor/bergamot/bergamot-translator.js");

interface Engine {
  bergamot: any;
  model: any;
  service: any;
}

let engine: Engine | null = null;

function post(message: BergamotWorkerResponse): void {
  scope.postMessage(message);
}

function textConfig(entries: Record<string, string>): string {
  const indent = "            ";
  let result = "\n";
  for (const [key, value] of Object.entries(entries)) {
    result += `${indent}${key}: ${value}\n`;
  }
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
      onAbort: () => reject(new Error("Bergamot WASM aborted during initialization")),
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

async function initialize(request: Extract<BergamotWorkerRequest, { type: "initialize" }>): Promise<void> {
  if (engine) return;
  const bergamot = await loadRuntime();
  const byType = new Map(request.files.map((file) => [file.type, file] as const));

  const modelFile = byType.get("model");
  const lexFile = byType.get("lex");
  const srcvocabFile = byType.get("srcvocab");
  const trgvocabFile = byType.get("trgvocab");
  if (!modelFile || !lexFile || !srcvocabFile || !trgvocabFile) {
    throw new Error("Bergamot model bundle is incomplete");
  }

  const modelMemory = allocate(bergamot, modelFile);
  const lexMemory = allocate(bergamot, lexFile);
  const srcvocabMemory = allocate(bergamot, srcvocabFile);
  const trgvocabMemory = allocate(bergamot, trgvocabFile);

  const vocabList = new bergamot.AlignedMemoryList();
  vocabList.push_back(srcvocabMemory);
  vocabList.push_back(trgvocabMemory);

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

  const model = new bergamot.TranslationModel(
    request.sourceLanguage,
    request.targetLanguage,
    config,
    modelMemory,
    lexMemory,
    vocabList,
    null,
  );
  const service = new bergamot.BlockingService({ cacheSize: 0 });
  engine = { bergamot, model, service };
}

function translateHtml(html: string): { html: string; inferenceMilliseconds: number } {
  if (!engine) throw new Error("Bergamot worker is not initialized");
  const { bergamot, model, service } = engine;
  const messages = new bergamot.VectorString();
  const options = new bergamot.VectorResponseOptions();
  let responses: any = null;

  try {
    messages.push_back(html);
    options.push_back({ qualityScores: false, alignment: true, html: true });
    const started = performance.now();
    responses = service.translate(model, messages, options);
    const inferenceMilliseconds = performance.now() - started;
    const translated = responses.get(0).getTranslatedText();
    return { html: translated, inferenceMilliseconds };
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
      const result = translateHtml(message.html);
      post({ type: "result", id: message.id, ...result });
    }
  } catch (error) {
    post({
      type: "error",
      ...(message.type === "translate" ? { id: message.id } : {}),
      error: error instanceof Error ? error.message : String(error),
    });
  }
});
