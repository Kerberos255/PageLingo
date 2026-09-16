import type { TranslationProvider, TranslationRequest } from "../core/provider";

interface TranslationResponse {
  ok?: boolean;
  html?: string;
  error?: string;
}

async function sendWithTransientRetry(message: unknown): Promise<TranslationResponse> {
  try {
    return await browser.runtime.sendMessage(message) as TranslationResponse;
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    if (!/Receiving end does not exist/i.test(text)) throw error;
    await new Promise((resolve) => setTimeout(resolve, 50));
    return await browser.runtime.sendMessage(message) as TranslationResponse;
  }
}

export class RuntimeMessageProvider implements TranslationProvider {
  async translateHtml(request: TranslationRequest): Promise<string> {
    const response = await sendWithTransientRetry({ type: "translate-html", request });
    if (!response?.ok || typeof response.html !== "string") {
      throw new Error(response?.error ?? "Translation backend unavailable");
    }
    return response.html;
  }
}
