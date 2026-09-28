import type { PageLingoSettings } from "./settings";

export function automaticTranslationSettingsSignature(
  settings: PageLingoSettings,
  routeLanguage: string | null,
  sourceLanguage: string | null = null,
): string {
  return JSON.stringify({
    routeLanguage,
    sourceLanguage,
    displayMode: settings.displayMode,
    autoTranslateEnabled: settings.autoTranslateEnabled,
    targetLanguage: settings.targetLanguage,
    neverTranslateSites: settings.neverTranslateSites,
    alwaysTranslateSites: settings.alwaysTranslateSites,
    neverTranslateLanguages: settings.neverTranslateLanguages,
    alwaysTranslateLanguages: settings.alwaysTranslateLanguages,
    builtinGlossaryEnabled: settings.builtinGlossaryEnabled,
    glossaryCollections: settings.glossaryCollections,
  });
}
