import { describe, expect, it } from "vitest";
import {
  automaticTranslationSettingsSignature,
} from "../src/shared/automatic-translation-state";
import { DEFAULT_SETTINGS } from "../src/shared/settings";

describe("automatic translation settings signature", () => {
  it("changes when route or translation-affecting settings change", () => {
    const base = { ...DEFAULT_SETTINGS };
    const signature = automaticTranslationSettingsSignature(base, "en");

    expect(automaticTranslationSettingsSignature({ ...base, targetLanguage: "zh-Hant" }, "en"))
      .not.toBe(signature);
    expect(automaticTranslationSettingsSignature({ ...base, autoTranslateEnabled: true }, "en"))
      .not.toBe(signature);
    expect(automaticTranslationSettingsSignature({ ...base, neverTranslateSites: ["github.com"] }, "en"))
      .not.toBe(signature);
    expect(automaticTranslationSettingsSignature(base, "fr"))
      .not.toBe(signature);
  });

  it("is stable for equivalent settings and route", () => {
    const base = {
      ...DEFAULT_SETTINGS,
      autoTranslateEnabled: true,
      neverTranslateSites: ["example.com"],
    };
    expect(automaticTranslationSettingsSignature(base, "en"))
      .toBe(automaticTranslationSettingsSignature({ ...base }, "en"));
  });
});
