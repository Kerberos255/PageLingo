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

export interface CheckedTranslationResult {
  html: string;
  accepted: boolean;
  reason?: string;
}

export interface TranslationProvider {
  translateHtml(request: TranslationRequest): Promise<string>;
  /**
   * Optional guarded translation path for engines that can validate their own
   * structured output (for example marker/slot integrity plus language-quality
   * checks). PageTranslator uses this only for risky rich roots/chunks.
   */
  translateHtmlChecked?(request: TranslationRequest): Promise<CheckedTranslationResult>;
  supportsStructuralSplitting?(): Promise<boolean>;
}
