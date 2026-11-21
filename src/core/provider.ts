export interface TranslationTerminologyEntry {
  source: string;
  target: string;
  mode: "protect" | "replace";
}

export interface TranslationRequest {
  html: string;
  sourceLanguage: string;
  targetLanguage: string;
  terminology?: TranslationTerminologyEntry[];
  signal?: AbortSignal;
}

export interface TranslationExecutionProfile {
  isExternal: boolean;
  isLlm: boolean;
  supportsBatch: boolean;
  supportsPromptTerminology: boolean;
  recommendedConcurrency: number;
  batchMaxItems: number;
  batchMaxChars: number;
  batchConcurrency: number;
}

export interface TranslationProvider {
  translateHtml(request: TranslationRequest): Promise<string>;
  translateHtmlChecked?(request: TranslationRequest): Promise<CheckedTranslationResult>;
  supportsStructuralSplitting?(): Promise<boolean>;
  supportsPromptTerminology?(): Promise<boolean>;
  getExecutionProfile?(): Promise<TranslationExecutionProfile>;
}


export interface CheckedTranslationResult {
  html: string;
  accepted: boolean;
  reason?: string;
}
