import { describe, expect, it } from "vitest";
import {
  DEFAULT_OCR_PROFILE,
  DOC_LAYOUT_MODEL,
  OCR_PROFILES,
  SHARED_OCR_V5_DETECTION,
  SHARED_OCR_V6_DETECTION,
  getOcrProfile,
  normalizeOcrProfileId,
  ocrProfileRecognitionBytes,
  ocrProfileTotalBytes,
  parseOcrDictionaryText,
} from "../src/image-translation/ocr-models";
import { wrapTranslatedParagraphs } from "../src/image-translation/image-renderer";

describe("multilingual OCR & document layout model catalog", () => {
  it("defaults to PP-OCRv6_small (50 languages) while keeping Korean/Cyrillic/Thai v5 packs with valid SHA-256 pins", () => {
    expect(DEFAULT_OCR_PROFILE.id).toBe("pp-ocrv6-small");
    expect(DEFAULT_OCR_PROFILE.modelPreset).toBe("PP-OCRv6_small");
    expect(DEFAULT_OCR_PROFILE.detection).toBe(SHARED_OCR_V6_DETECTION);

    expect(OCR_PROFILES.map((p) => p.id)).toEqual([
      "pp-ocrv6-small",
      "pp-ocrv5-korean",
      "pp-ocrv5-cyrillic",
      "pp-ocrv5-th",
    ]);

    for (const profile of OCR_PROFILES) {
      if (profile.id === "pp-ocrv6-small") {
        expect(profile.detection).toBe(SHARED_OCR_V6_DETECTION);
      } else {
        expect(profile.detection).toBe(SHARED_OCR_V5_DETECTION);
      }
      for (const asset of [profile.detection, profile.recognition, profile.dictionary]) {
        expect(asset.url).toMatch(/^https:\/\//);
        expect(asset.bytes).toBeGreaterThan(0);
        expect(asset.sha256).toMatch(/^[a-f0-9]{64}$/);
      }
      expect(ocrProfileTotalBytes(profile)).toBe(
        profile.detection.bytes + ocrProfileRecognitionBytes(profile),
      );
    }

    // Legacy default & Latin profile IDs transparently migrate to PP-OCRv6_small
    expect(normalizeOcrProfileId("pp-ocrv5-mobile")).toBe("pp-ocrv6-small");
    expect(normalizeOcrProfileId("pp-ocrv5-latin")).toBe("pp-ocrv6-small");
    expect(getOcrProfile("pp-ocrv5-mobile")).toBe(DEFAULT_OCR_PROFILE);
    expect(getOcrProfile("pp-ocrv5-latin")).toBe(DEFAULT_OCR_PROFILE);
    expect(getOcrProfile("pp-ocrv5-korean").id).toBe("pp-ocrv5-korean");
    expect(getOcrProfile("unknown-id")).toBe(DEFAULT_OCR_PROFILE);

    // PP-DocLayout-M asset has valid SHA-256 and preset
    expect(DOC_LAYOUT_MODEL.preset).toBe("PP-DocLayout-M");
    expect(DOC_LAYOUT_MODEL.url).toMatch(/^https:\/\//);
    expect(DOC_LAYOUT_MODEL.bytes).toBeGreaterThan(10_000_000);
    expect(DOC_LAYOUT_MODEL.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("parses PaddleX inference.yml character_dict losslessly including escaped quotes and U+3000 ideographic space", () => {
    const sampleYml = [
      "Global:",
      "  model_name: PP-OCRv6_small_rec",
      "PostProcess:",
      "  name: CTCLabelDecode",
      "  character_dict:",
      "  - '!'",
      "  - '\"'",
      "  - ''''",
      "  - \u3000",
      "  - A",
      "  - 中",
      "OtherSection:",
      "  foo: bar",
    ].join("\n");

    const parsed = parseOcrDictionaryText(sampleYml, "paddle-yml");
    expect(parsed).toEqual(["!", '"', "'", "\u3000", "A", "中", " "]);

    const plain = parseOcrDictionaryText("a\nb\nc\n", "plain");
    expect(plain).toEqual(["a", "b", "c", " "]);
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
