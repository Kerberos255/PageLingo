import { PageTranslator } from "./core/page-translator";
import { RuntimeMessageProvider } from "./providers/runtime-message-provider";

let translator: PageTranslator | null = null;

function ensureStyle(): void {
  if (document.getElementById("flt-style")) return;
  const style = document.createElement("style");
  style.id = "flt-style";
  style.dataset.fltGenerated = "style";
  style.textContent = `
    .flt-translation {
      display: block !important;
      margin-block-start: 0.28em !important;
      font: inherit !important;
      line-height: inherit !important;
      letter-spacing: inherit !important;
      text-transform: none !important;
    }
  `;
  document.documentElement.append(style);
}

browser.runtime.onMessage.addListener(async (message: { type?: string }) => {
  if (message.type === "translate-page") {
    ensureStyle();
    translator?.restore();
    translator = new PageTranslator(document, new RuntimeMessageProvider(), {
      sourceLanguage: "en",
      targetLanguage: "zh-Hans",
      concurrency: 4,
    });
    const count = await translator.translateAll();
    translator.observe();
    return { ok: true, count };
  }

  if (message.type === "restore-page") {
    translator?.restore();
    translator = null;
    document.getElementById("flt-style")?.remove();
    return { ok: true };
  }

  return undefined;
});
