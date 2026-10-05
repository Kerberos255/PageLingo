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

export interface TranslationProvider {
  translateHtml(request: TranslationRequest): Promise<string>;
  translateHtmlChecked?(request: TranslationRequest): Promise<CheckedTranslationResult>;
  supportsStructuralSplitting?(): Promise<boolean>;
}


export interface CheckedTranslationResult {
  html: string;
  accepted: boolean;
  reason?: string;
}
