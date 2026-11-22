import { MODEL_CATALOG, MODEL_CATALOG_GENERATED_AT } from "./model-catalog.generated";

export type BergamotModelFileType = "model" | "lex" | "vocab" | "srcvocab" | "trgvocab";

export interface BergamotModelAsset {
  type: BergamotModelFileType;
  url: string;
  bytes: number;
  sha256: string;
  alignment: 64 | 256;
  compression: "zstd";
}

export interface BergamotModelPair {
  key: string;
  sourceLanguage: string;
  targetLanguage: string;
  architecture: string;
  releaseStatus: string;
  version: string;
  installedBytes: number;
  assets: readonly BergamotModelAsset[];
}

export interface TranslationRoute {
  key: string;
  kind: "direct" | "pivot";
  sourceLanguage: string;
  targetLanguage: string;
  models: readonly BergamotModelPair[];
}

export { MODEL_CATALOG_GENERATED_AT };

const pairs = MODEL_CATALOG as unknown as readonly BergamotModelPair[];
const byKey = new Map(pairs.map((pair) => [pair.key, pair] as const));

export function modelPairKey(sourceLanguage: string, targetLanguage: string): string {
  return `${sourceLanguage}->${targetLanguage}`;
}

export function getModelPair(sourceLanguage: string, targetLanguage: string): BergamotModelPair | null {
  return byKey.get(modelPairKey(sourceLanguage, targetLanguage)) ?? null;
}

export function listModelPairs(): readonly BergamotModelPair[] {
  return pairs;
}

export function listSourceLanguages(): string[] {
  return Array.from(new Set([
    "en",
    ...pairs.filter((pair) => pair.targetLanguage === "en").map((pair) => pair.sourceLanguage),
  ])).sort();
}

export function listTargetLanguages(): string[] {
  return Array.from(new Set([
    "en",
    ...pairs.filter((pair) => pair.sourceLanguage === "en").map((pair) => pair.targetLanguage),
  ])).sort();
}

export function listPackLanguages(): string[] {
  return Array.from(new Set([
    ...listSourceLanguages(),
    ...listTargetLanguages(),
  ])).filter((language) => language !== "en").sort();
}

export type ModelPairResolver = (sourceLanguage: string, targetLanguage: string) => BergamotModelPair | null;

export function planTranslationRouteWithResolver(
  sourceLanguage: string,
  targetLanguage: string,
  resolvePair: ModelPairResolver,
): TranslationRoute | null {
  if (sourceLanguage === targetLanguage) return null;

  const direct = resolvePair(sourceLanguage, targetLanguage);
  if (direct) {
    return {
      key: direct.key,
      kind: "direct",
      sourceLanguage,
      targetLanguage,
      models: [direct],
    };
  }

  if (sourceLanguage !== "en" && targetLanguage !== "en") {
    const intoEnglish = resolvePair(sourceLanguage, "en");
    const outOfEnglish = resolvePair("en", targetLanguage);
    if (intoEnglish && outOfEnglish) {
      return {
        key: `${intoEnglish.key}|${outOfEnglish.key}`,
        kind: "pivot",
        sourceLanguage,
        targetLanguage,
        models: [intoEnglish, outOfEnglish],
      };
    }
  }

  return null;
}

export function planTranslationRoute(sourceLanguage: string, targetLanguage: string): TranslationRoute | null {
  return planTranslationRouteWithResolver(sourceLanguage, targetLanguage, getModelPair);
}
