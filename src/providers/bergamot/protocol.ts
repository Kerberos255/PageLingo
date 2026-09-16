import type { BergamotModelFileType } from "./model-manifest";

export interface WorkerModelFile {
  type: BergamotModelFileType;
  alignment: 64 | 256;
  buffer: ArrayBuffer;
}

export interface WorkerModelBundle {
  sourceLanguage: string;
  targetLanguage: string;
  files: WorkerModelFile[];
}

export type BergamotWorkerRequest =
  | {
      type: "initialize";
      routeKind: "direct" | "pivot";
      models: WorkerModelBundle[];
    }
  | {
      type: "translate";
      id: number;
      html: string;
    };

export type BergamotWorkerResponse =
  | { type: "ready" }
  | { type: "result"; id: number; html: string; inferenceMilliseconds: number }
  | { type: "error"; id?: number; error: string };
