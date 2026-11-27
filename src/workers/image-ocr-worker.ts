import {
  ObjectDetectionService,
  PaddleOcrService,
  getObjectDetectionPresetOptions,
  type OrtInferenceSession,
  type OrtModule,
} from "paddleocr";
import * as ort from "onnxruntime-web/wasm";
import type { OcrRegion } from "../image-translation/ocr-layout";
import {
  parseOcrDictionaryText,
  type OcrDictionaryFormat,
  type OcrModelPreset,
} from "../image-translation/ocr-models";
import {
  maskImageRgbaForOcr,
  prepareLayoutMaskPlan,
  type DocLayoutBox,
} from "../reader/pdf-ocr-layout";

interface WorkerRecognizeRequest {
  type: "recognize";
  id: number;
  profileId: string;
  modelPreset: OcrModelPreset;
  dictionaryFormat?: OcrDictionaryFormat;
  width: number;
  height: number;
  pixels: ArrayBuffer;
  detectionModel?: ArrayBuffer;
  recognitionModel?: ArrayBuffer;
  dictionary?: string;
}

interface WorkerDocumentPageRequest {
  type: "recognize-document-page";
  id: number;
  profileId: string;
  modelPreset: OcrModelPreset;
  dictionaryFormat?: OcrDictionaryFormat;
  layoutPreset: "PP-DocLayout-M" | "PP-DocLayout-S";
  width: number;
  height: number;
  pixels: ArrayBuffer;
  detectionModel?: ArrayBuffer;
  recognitionModel?: ArrayBuffer;
  dictionary?: string;
  layoutModel?: ArrayBuffer;
}

interface WorkerResetRequest {
  type: "reset";
}

type WorkerRequest = WorkerRecognizeRequest | WorkerDocumentPageRequest | WorkerResetRequest;

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
let layoutSession: OrtInferenceSession | null = null;
let layoutService: ObjectDetectionService | null = null;
let activeLayoutPreset = "";

function report(id: number, status: string, progress?: number): void {
  scope.postMessage({ type: "progress", id, status, progress });
}

function progressInfo(progress: WorkerProgress): { label: string; ratio: number } | null {
  if (progress.type === "det") {
    if (progress.stage === "preprocess") return { label: "检测文字区域", ratio: 0.28 };
    if (progress.stage === "infer") return { label: "分析文字区域", ratio: 0.42 };
    if (progress.stage === "postprocess") {
      const total = progress.detectedCount ?? 0;
      return { label: total > 0 ? `识别文字 0/${total}` : "识别文字中", ratio: 0.48 };
    }
  }
  if (progress.type === "rec") {
    const current = progress.progress?.current ?? 0;
    const total = progress.progress?.total ?? 0;
    if (progress.stage === "item") {
      const fraction = total > 0 ? Math.min(1, current / total) : 0;
      return { label: total > 0 ? `识别文字 ${current}/${total}` : "识别文字中", ratio: 0.48 + fraction * 0.32 };
    }
    if (progress.stage === "complete") return { label: "正在翻译文字", ratio: 0.84 };
  }
  return null;
}

async function ensureOrtRuntime(): Promise<void> {
  if (!ortRuntimeReady) {
    ortRuntimeReady = (async () => {
      const mjsUrl = new URL("vendor/onnxruntime/ort-wasm-simd-threaded.mjs", globalThis.location.href).href;
      const wasmUrl = new URL("vendor/onnxruntime/ort-wasm-simd-threaded.wasm", globalThis.location.href).href;
      const response = await fetch(wasmUrl, { credentials: "same-origin" });
      if (!response.ok) throw new Error(`ONNX Runtime WASM 加载失败：HTTP ${response.status}`);
      const wasmFlags = ort.env.wasm as typeof ort.env.wasm & {
        wasmBinary?: Uint8Array;
        wasmPaths?: { mjs?: string; wasm?: string };
      };
      wasmFlags.wasmPaths = { mjs: mjsUrl, wasm: wasmUrl };
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
  if (layoutSession) {
    await (layoutSession as OrtInferenceSession & { release?: () => Promise<void> }).release?.().catch(() => {});
  }
  layoutSession = null;
  layoutService = null;
  activeLayoutPreset = "";
}

async function ensureService(request: WorkerRecognizeRequest | WorkerDocumentPageRequest): Promise<PaddleOcrService> {
  if (service && activeProfileId === request.profileId) return service;
  if (!request.detectionModel || !request.recognitionModel || request.dictionary === undefined) {
    throw new Error("OCR models are required to initialize the worker");
  }
  await service?.destroy();
  service = null;
  activeProfileId = "";
  await ensureOrtRuntime();
  const dictionary = parseOcrDictionaryText(request.dictionary, request.dictionaryFormat);
  report(request.id, "正在初始化文字识别", 0.22);
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

async function ensureLayoutService(request: WorkerDocumentPageRequest): Promise<ObjectDetectionService> {
  if (layoutService && activeLayoutPreset === request.layoutPreset) return layoutService;
  if (!request.layoutModel) {
    throw new Error("Document layout model is required to initialize layout detection");
  }
  if (layoutSession) {
    await (layoutSession as OrtInferenceSession & { release?: () => Promise<void> }).release?.().catch(() => {});
  }
  layoutSession = null;
  layoutService = null;
  activeLayoutPreset = "";
  await ensureOrtRuntime();
  report(request.id, "正在初始化版面检测", 0.18);
  const session = await ort.InferenceSession.create(new Uint8Array(request.layoutModel), {
    executionProviders: ["wasm"],
  }) as unknown as OrtInferenceSession;
  layoutSession = session;
  layoutService = new ObjectDetectionService(
    paddleOrt,
    session,
    getObjectDetectionPresetOptions(request.layoutPreset),
  );
  activeLayoutPreset = request.layoutPreset;
  return layoutService;
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
        const info = progressInfo(progress);
        if (info) report(request.id, info.label, info.ratio);
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

async function recognizeDocumentPage(request: WorkerDocumentPageRequest): Promise<void> {
  try {
    const layout = await ensureLayoutService(request);
    report(request.id, "正在分析页面版面（公式 / 表格 / 图表）…", 0.26);
    const sourcePixels = new Uint8ClampedArray(request.pixels);
    const dets = await layout.run(
      {
        width: request.width,
        height: request.height,
        data: new Uint8Array(sourcePixels.buffer, sourcePixels.byteOffset, sourcePixels.byteLength),
      },
      { threshold: 0.38 },
    );
    const rawBoxes: DocLayoutBox[] = dets.map((det) => ({
      label: det.label,
      score: det.score,
      box: {
        x: det.coordinate[0] ?? 0,
        y: det.coordinate[1] ?? 0,
        width: Math.max(1, (det.coordinate[2] ?? 0) - (det.coordinate[0] ?? 0)),
        height: Math.max(1, (det.coordinate[3] ?? 0) - (det.coordinate[1] ?? 0)),
      },
    }));
    const plan = prepareLayoutMaskPlan(rawBoxes, request.width, request.height);
    const maskedPixels = maskImageRgbaForOcr(sourcePixels, request.width, request.height, plan.maskRects);

    const ocr = await ensureService(request);
    report(
      request.id,
      plan.visualBlocks.length > 0
        ? `已保护 ${plan.visualBlocks.length} 处公式/图表，正在 OCR 识别正文…`
        : "正在 OCR 识别页面文字…",
      0.42,
    );
    const raw = await ocr.recognize(
      {
        width: request.width,
        height: request.height,
        data: new Uint8Array(maskedPixels.buffer, maskedPixels.byteOffset, maskedPixels.byteLength),
      },
      {
        onProgress(progress: WorkerProgress) {
          const info = progressInfo(progress);
          if (info) report(request.id, info.label, 0.4 + info.ratio * 0.55);
        },
      },
    );
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
    scope.postMessage({ type: "document-result", id: request.id, plan, regions });
  } catch (error) {
    scope.postMessage({ type: "error", id: request.id, error: error instanceof Error ? error.message : String(error) });
  }
}

let workerMessageChain: Promise<void> = Promise.resolve();

scope.addEventListener("message", (event) => {
  const request = event.data;
  workerMessageChain = workerMessageChain.then(async () => {
    if (request.type === "reset") {
      await reset();
      return;
    }
    if (request.type === "recognize-document-page") {
      await recognizeDocumentPage(request);
      return;
    }
    await recognize(request);
  }).catch(() => {
    // Individual handlers already report errors back to the parent thread.
  });
});
