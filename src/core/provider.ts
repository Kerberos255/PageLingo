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
  context?: import("./translation-context").TranslationContext | undefined;
  bypassCache?: boolean;
}

export interface TranslationProvider {
  translateHtml(request: TranslationRequest): Promise<string>;
  translateHtmlChecked?(request: TranslationRequest): Promise<CheckedTranslationResult>;
  supportsStructuralSplitting?(): Promise<boolean>;
  /** Original-node contract: preserve transport text slots and whole-paragraph context. */
  prefersWholeSentenceHtml?(): Promise<boolean>;
  concurrentSegments?(): Promise<number>;
  /** Defer off-screen roots until near viewport via IntersectionObserver. */
  prefersLazyOffscreen?(): Promise<boolean>;
}


export interface CheckedTranslationResult {
  html: string;
  accepted: boolean;
  reason?: string;
}
