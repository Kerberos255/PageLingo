import type { TranslationProvider, TranslationRequest } from "../core/provider";

interface TranslationResponse {
  ok: boolean;
  html?: string;
  error?: string;
}

export class RuntimeMessageProvider implements TranslationProvider {
  async translateHtml(request: TranslationRequest): Promise<string> {
    const response = await browser.runtime.sendMessage({ type: "translate-html", request }) as TranslationResponse;
    if (!response?.ok || typeof response.html !== "string") {
      throw new Error(response?.error ?? "Translation backend unavailable");
    }
    return response.html;
  }
}
