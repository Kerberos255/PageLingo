import { BergamotClient } from "./providers/bergamot/bergamot-client";

const bergamot = new BergamotClient();

interface TranslateHtmlMessage {
  type?: string;
  request?: {
    html?: unknown;
    sourceLanguage?: unknown;
    targetLanguage?: unknown;
  };
}

browser.runtime.onMessage.addListener(async (message: TranslateHtmlMessage) => {
  if (message.type !== "translate-html") return undefined;

  try {
    const request = message.request;
    if (!request || typeof request.html !== "string") {
      throw new Error("Invalid translation request");
    }
    if (request.sourceLanguage !== "en" || request.targetLanguage !== "zh-Hans") {
      throw new Error("V0.1 currently supports en → zh-Hans only");
    }

    const html = await bergamot.translateHtml(request.html);
    return { ok: true, html };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
});
