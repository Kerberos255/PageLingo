export interface TranslationRequest {
  html: string;
  sourceLanguage: string;
  targetLanguage: string;
  signal?: AbortSignal;
}

export interface TranslationProvider {
  translateHtml(request: TranslationRequest): Promise<string>;
}
