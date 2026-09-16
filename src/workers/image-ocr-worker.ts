import { PaddleOcrService, type OrtModule } from "paddleocr";
import * as ort from "onnxruntime-web/wasm";
import type { OcrRegion } from "../image-translation/ocr-layout";

interface WorkerRecognizeRequest {
  type: "recognize";
  id: number;
  profileId: string;
  modelPreset: "PP-OCRv5_mobile" | "PP-OCRv6_tiny";
  width: number;
  height: number;
  pixels: ArrayBuffer;
  detectionModel?: ArrayBuffer;
  recognitionModel?: ArrayBuffer;
  dictionary?: string;
}

interface WorkerResetRequest {
  type: "reset";
}

type WorkerRequest = WorkerRecognizeRequest | WorkerResetRequest;

interface WorkerProgress {
  type?: string;
  stage?: string;
  progress?: { current?: number; total?: number };
  detectedCount?: number;
}

const scope = globalThis as unknown as {
  postMessage(message: unknown): void;
  addEventListener(type: "message", listener: (event: MessageEvent<WorkerRequest>) => void): void;
};

ort.env.wasm.numThreads = 1;
ort.env.wasm.simd = true;
ort.env.wasm.proxy = false;
ort.env.logLevel = "error";

const paddleOrt = ort as unknown as OrtModule;
let ortRuntimeReady: Promise<void> | null = null;
let service: PaddleOcrService | null = null;
let activeProfileId = "";

function report(id: number, status: string): void {
  scope.postMessage({ type: "progress", id, status });
}

function progressLabel(progress: WorkerProgress): string | null {
  if (progress.type === "det") {
    if (progress.stage === "preprocess") return "正在检测文字 · 预处理完成";
    if (progress.stage === "infer") return "正在检测文字 · 模型推理完成";
    if (progress.stage === "postprocess") return `正在识别文字 · 0/${progress.detectedCount ?? 0}`;
  }
  if (progress.type === "rec") {
    const current = progress.progress?.current ?? 0;
    const total = progress.progress?.total ?? 0;
    if (progress.stage === "item") return `正在识别文字 · ${current}/${total}`;
    if (progress.stage === "complete") return "文字识别完成 · 正在翻译";
  }
  return null;
}

async function ensureOrtRuntime(): Promise<void> {
  if (!ortRuntimeReady) {
    ortRuntimeReady = (async () => {
      const wasmUrl = new URL("vendor/onnxruntime/ort-wasm-simd-threaded.wasm", globalThis.location.href).href;
      const response = await fetch(wasmUrl, { credentials: "same-origin" });
      if (!response.ok) throw new Error(`ONNX Runtime WASM 加载失败：HTTP ${response.status}`);
      const wasmFlags = ort.env.wasm as typeof ort.env.wasm & { wasmBinary?: Uint8Array };
      wasmFlags.wasmBinary = new Uint8Array(await response.arrayBuffer());
    })().catch((error) => {
      ortRuntimeReady = null;
      throw error;
    });
  }
  await ortRuntimeReady;
}

async function reset(): Promise<void> {
  await service?.destroy();
  service = null;
  activeProfileId = "";
}

async function ensureService(request: WorkerRecognizeRequest): Promise<PaddleOcrService> {
  if (service && activeProfileId === request.profileId) return service;
  if (!request.detectionModel || !request.recognitionModel || request.dictionary === undefined) {
    throw new Error("OCR models are required to initialize the worker");
  }
  await reset();
  await ensureOrtRuntime();
  const dictionary = request.dictionary.replace(/\r/g, "").replace(/\n+$/, "").split("\n");
  if (!dictionary.includes(" ")) dictionary.push(" ");
  report(request.id, "正在创建 OCR 推理会话…");
  service = await PaddleOcrService.createInstance({
    ort: paddleOrt,
    modelPreset: request.modelPreset,
    detection: { modelBuffer: request.detectionModel },
    recognition: {
      modelBuffer: request.recognitionModel,
      charactersDictionary: dictionary,
    },
  });
  activeProfileId = request.profileId;
  return service;
}

async function recognize(request: WorkerRecognizeRequest): Promise<void> {
  try {
    const ocr = await ensureService(request);
    const raw = await ocr.recognize({
      width: request.width,
      height: request.height,
      data: new Uint8Array(request.pixels),
    }, {
      onProgress(progress: WorkerProgress) {
        const label = progressLabel(progress);
        if (label) report(request.id, label);
      },
    });
    const regions: OcrRegion[] = raw.map((item) => ({
      text: item.text,
      confidence: item.confidence,
      box: {
        x: item.box.x,
        y: item.box.y,
        width: item.box.width,
        height: item.box.height,
      },
    }));
    scope.postMessage({ type: "result", id: request.id, regions });
  } catch (error) {
    scope.postMessage({ type: "error", id: request.id, error: error instanceof Error ? error.message : String(error) });
  }
}

scope.addEventListener("message", (event) => {
  const request = event.data;
  if (request.type === "reset") {
    void reset();
    return;
  }
  void recognize(request);
});
