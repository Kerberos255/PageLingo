import type { TranslationProvider, TranslationRequest } from "../core/provider";
import { sendRuntimeMessage } from "../shared/runtime-message";

interface TranslationResponse {
  ok?: boolean;
  html?: string;
  error?: string;
}

export class RuntimeMessageProvider implements TranslationProvider {
  async translateHtml(request: TranslationRequest): Promise<string> {
    const response = await sendRuntimeMessage<TranslationResponse>({ type: "translate-html", request });
    if (!response?.ok || typeof response.html !== "string") {
      throw new Error(response?.error ?? "Translation backend unavailable");
    }
    return response.html;
  }
}
