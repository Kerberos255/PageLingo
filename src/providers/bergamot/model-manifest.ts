export type BergamotModelFileType = "model" | "lex" | "srcvocab" | "trgvocab";

export interface BergamotModelAsset {
  type: BergamotModelFileType;
  url: string;
  bytes: number;
  sha256: string;
  alignment: 64 | 256;
}

const CDN = "https://firefox-settings-attachments.cdn.mozilla.net/main-workspace/translations-models";

/**
 * Firefox en -> zh-Hans model payloads.
 *
 * These raw v2.2 attachment bytes match the decompressed SHA-256 values of
 * Mozilla's current translations-models-v2 generation-3 records. We fetch the
 * raw data to avoid depending on browser-side Zstandard support.
 */
export const EN_TO_ZH_HANS_MODEL: readonly BergamotModelAsset[] = [
  {
    type: "model",
    url: `${CDN}/a7ff7d5e-e67e-406c-a34b-a7edea35b10e.bin`,
    bytes: 43_849_787,
    sha256: "4e5accc141373565ddc8fa1565bceaa8d0c3482a82cab8131c719ebcc6c2157c",
    alignment: 256,
  },
  {
    type: "lex",
    url: `${CDN}/da8fccc0-31df-4665-9703-96d36606e019.bin`,
    bytes: 6_506_248,
    sha256: "4a5e5827788060f1d718a8132b69440929387514a045796e9b77f935db68c055",
    alignment: 64,
  },
  {
    type: "srcvocab",
    url: `${CDN}/ea98c52c-58dc-45d5-af23-38f2b029d020.spm`,
    bytes: 806_952,
    sha256: "bd9b65504acc6d9726dd281f7defc2adb7c2c22d0688fe2f84697de25197c8c5",
    alignment: 64,
  },
  {
    type: "trgvocab",
    url: `${CDN}/bddbda68-d4d2-4317-a0a1-119caa47525e.spm`,
    bytes: 772_004,
    sha256: "aded6993c36e440284d11cec3f6b8aef9c0e43188a772d80be342a713adf223d",
    alignment: 64,
  },
] as const;
