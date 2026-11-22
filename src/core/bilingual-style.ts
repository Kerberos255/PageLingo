// Shared CSS generator for webpage bilingual styling (order, theme preset, scale, color, learning mode).

import { DEFAULT_BILINGUAL_STYLE, type BilingualStyleSettings } from "../shared/settings";

export function buildBilingualRulesCss(
  style: BilingualStyleSettings = DEFAULT_BILINGUAL_STYLE,
  rootSelector: ":root" | ":host" = ":root",
): string {
  const scale = (style.fontScale / 100).toFixed(2);
  const colorVar = style.translationColor !== "inherit"
    ? `--pagelingo-bilingual-color: ${style.translationColor};`
    : "";

  const colorRule = style.translationColor !== "inherit"
    ? `
      .flt-translation:not([data-flt-display-mode="translation"]) {
        color: var(--pagelingo-bilingual-color) !important;
      }`
    : "";

  let themeCss = "";
  if (style.theme === "muted") {
    themeCss = `
      .flt-translation:not([data-flt-display-mode="translation"]) {
        opacity: 0.78 !important;
      }`;
  } else if (style.theme === "border-left") {
    themeCss = `
      .flt-translation:not([data-flt-display-mode="translation"]):not([data-flt-control="true"]) {
        border-inline-start: 2.5px solid color-mix(in srgb, currentColor 58%, transparent) !important;
        --pagelingo-bilingual-pad-start: 0.65em;
        padding-inline-start: 0.65em !important;
      }
      .flt-translation[data-flt-control="true"]:not([data-flt-display-mode="translation"]) {
        opacity: 0.84 !important;
      }`;
  } else if (style.theme === "highlight") {
    themeCss = `
      .flt-translation:not([data-flt-display-mode="translation"]):not([data-flt-control="true"]) {
        padding-block: 0.2em !important;
        --pagelingo-bilingual-pad-start: 0.5em;
        --pagelingo-bilingual-pad-end: 0.5em;
        padding-inline: 0.5em !important;
        border-radius: 5px !important;
        background: color-mix(in srgb, currentColor 8%, transparent) !important;
      }
      .flt-translation[data-flt-control="true"]:not([data-flt-display-mode="translation"]) {
        opacity: 0.86 !important;
      }`;
  } else if (style.theme === "underline") {
    themeCss = `
      .flt-translation:not([data-flt-display-mode="translation"]) {
        --pagelingo-bilingual-deco-line: underline;
        --pagelingo-bilingual-deco-style: dashed;
        --pagelingo-bilingual-deco-color: color-mix(in srgb, currentColor 45%, transparent);
        --pagelingo-bilingual-underline-offset: 0.24em;
        text-decoration-line: underline !important;
        text-decoration-style: dashed !important;
        text-decoration-color: color-mix(in srgb, currentColor 45%, transparent) !important;
        text-underline-offset: 0.24em !important;
      }`;
  }

  const learningCss = style.learningMode
    ? `
      .flt-translation:not([data-flt-display-mode="translation"]) {
        filter: blur(5.5px) !important;
        opacity: 0.45 !important;
        cursor: pointer !important;
        transition: filter 160ms ease, opacity 160ms ease !important;
      }
      .flt-translation:not([data-flt-display-mode="translation"]):hover,
      .flt-translation:not([data-flt-display-mode="translation"])[data-pagelingo-revealed="true"] {
        filter: none !important;
        opacity: 1 !important;
      }`
    : "";

  return `
    ${rootSelector} {
      --pagelingo-bilingual-scale: ${scale};
      ${colorVar}
    }
    .flt-translation[data-flt-order="translation-top"] {
      margin-block-start: 0 !important;
      margin-block-end: 0.28em !important;
    }
    .flt-translation[data-flt-display-mode="translation"] {
      --pagelingo-bilingual-scale: 1 !important;
      --pagelingo-bilingual-color: initial !important;
      --pagelingo-bilingual-pad-start: 0px !important;
      --pagelingo-bilingual-pad-end: 0px !important;
      --pagelingo-bilingual-deco-line: initial !important;
      --pagelingo-bilingual-deco-style: initial !important;
      --pagelingo-bilingual-deco-color: initial !important;
      --pagelingo-bilingual-underline-offset: initial !important;
    }${colorRule}${themeCss}${learningCss}
  `;
}
