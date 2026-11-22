import { describe, expect, it } from "vitest";
import {
  DEFAULT_OCR_PROFILE,
  OCR_PROFILES,
  SHARED_OCR_DETECTION,
  getOcrProfile,
  ocrProfileRecognitionBytes,
  ocrProfileTotalBytes,
} from "../src/image-translation/ocr-models";
import { wrapTranslatedParagraphs } from "../src/image-translation/image-renderer";

describe("multilingual OCR model catalog", () => {
  it("shares one universal detector across all 5 language-family OCR packs with valid SHA-256 pins", () => {
    expect(OCR_PROFILES.map((p) => p.id)).toEqual([
      "pp-ocrv5-mobile",
      "pp-ocrv5-latin",
      "pp-ocrv5-korean",
      "pp-ocrv5-cyrillic",
      "pp-ocrv5-th",
    ]);

    for (const profile of OCR_PROFILES) {
      expect(profile.detection).toBe(SHARED_OCR_DETECTION);
      for (const asset of [profile.detection, profile.recognition, profile.dictionary]) {
        expect(asset.url).toMatch(/^https:\/\//);
        expect(asset.bytes).toBeGreaterThan(0);
        expect(asset.sha256).toMatch(/^[a-f0-9]{64}$/);
      }
      expect(ocrProfileTotalBytes(profile)).toBe(
        SHARED_OCR_DETECTION.bytes + ocrProfileRecognitionBytes(profile),
      );
    }

    expect(getOcrProfile("pp-ocrv5-latin").id).toBe("pp-ocrv5-latin");
    expect(getOcrProfile("unknown-id")).toBe(DEFAULT_OCR_PROFILE);
  });
});

describe("multilingual image text word-boundary wrapping", () => {
  const monoMeasure = (value: string) => value.length * 10;

  it("wraps European accented Latin words cleanly at spaces without splitting mid-word", () => {
    const wrapped = wrapTranslatedParagraphs(
      monoMeasure,
      "Télécharger la configuration über die Einstellungen",
      190,
    );
    expect(wrapped).toHaveLength(1);
    const lines = wrapped[0]!;
    expect(lines.join(" ")).toBe("Télécharger la configuration über die Einstellungen");
    // Ensure no word with accented characters was split across lines
    expect(lines.some((line) => line.includes("Télécharger"))).toBe(true);
    expect(lines.some((line) => line.includes("configuration"))).toBe(true);
    expect(lines.some((line) => line.includes("Einstellungen"))).toBe(true);
  });

  it("wraps Cyrillic and Korean words cleanly at space boundaries", () => {
    const ru = wrapTranslatedParagraphs(monoMeasure, "Открыть настройки приложения", 160)[0]!;
    expect(ru.join(" ")).toBe("Открыть настройки приложения");
    expect(ru.some((line) => line.includes("настройки"))).toBe(true);

    const ko = wrapTranslatedParagraphs(monoMeasure, "언어 설정을 지금 업데이트하세요", 130)[0]!;
    expect(ko.join(" ")).toBe("언어 설정을 지금 업데이트하세요");
    expect(ko.some((line) => line.includes("업데이트하세요"))).toBe(true);
  });
});
