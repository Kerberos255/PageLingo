import type { BergamotModelFileType } from "./model-manifest";

export interface WorkerModelFile {
  type: BergamotModelFileType;
  alignment: 64 | 256;
  buffer: ArrayBuffer;
}

export type BergamotWorkerRequest =
  | {
      type: "initialize";
      sourceLanguage: "en";
      targetLanguage: "zh-Hans";
      files: WorkerModelFile[];
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
