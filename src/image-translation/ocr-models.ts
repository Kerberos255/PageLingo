export type OcrModelPreset = "PP-OCRv6_small" | "PP-OCRv5_mobile" | "PP-OCRv6_tiny";
export type OcrDictionaryFormat = "plain" | "paddle-yml";

export interface OcrModelAsset {
  id: string;
  label: string;
  url: string;
  bytes: number;
  sha256: string;
}

export interface DocLayoutModelAsset extends OcrModelAsset {
  preset: "PP-DocLayout-M" | "PP-DocLayout-S";
}

export interface OcrProfile {
  id: string;
  label: string;
  languagesLabel: string;
  modelPreset: OcrModelPreset;
  dictionaryFormat?: OcrDictionaryFormat;
  detection: OcrModelAsset;
  recognition: OcrModelAsset;
  dictionary: OcrModelAsset;
}

export const MAX_OCR_IMAGE_SIDE = 2200;

/**
 * Official PaddlePaddle PP-OCRv6_small text detector (~9.9 MB, Apache-2.0).
 * Replaces PP-OCRv5_mobile det with +8.9 pp detection Hmean and unified 50-language coverage.
 */
export const SHARED_OCR_V6_DETECTION: OcrModelAsset = {
  id: "pp-ocrv6-small-det",
  label: "PP-OCRv6 文字检测模型",
  url: "https://huggingface.co/PaddlePaddle/PP-OCRv6_small_det_onnx/resolve/main/inference.onnx",
  bytes: 9_880_512,
  sha256: "d73e0058b7a8086bbd57f3d10b8bcd4ff95363f67e06e2762b5e814fe9c9410e",
};

/**
 * Language-agnostic PP-OCRv5 text detector (~4.8 MB).
 * Shared across the optional v5 extension packs (Korean, Cyrillic, Thai).
 */
export const SHARED_OCR_V5_DETECTION: OcrModelAsset = {
  id: "pp-ocrv5-mobile-det",
  label: "扩展语系文字检测模型（v5）",
  url: "https://huggingface.co/PaddlePaddle/PP-OCRv5_mobile_det_onnx/resolve/main/inference.onnx",
  bytes: 4_826_518,
  sha256: "a431985659dc921974177a95adcfbb90fd9e51989a5e04d70d0b75f597b6e61d",
};

/** Default detection model alias kept for backward compatibility. */
export const SHARED_OCR_DETECTION: OcrModelAsset = SHARED_OCR_V6_DETECTION;

/**
 * Document layout detector (PP-DocLayout-M, 640x640, 23 classes, Apache-2.0).
 * Downloaded on demand when running scanned-PDF OCR or visual layout analysis so
 * formulas, dense tables, figures, charts, headers, and footers are detected before OCR.
 */
export const DOC_LAYOUT_MODEL: DocLayoutModelAsset = {
  id: "pp-doclayout-m",
  preset: "PP-DocLayout-M",
  label: "文档版面检测模型（PP-DocLayout-M）",
  url: "https://huggingface.co/X3ZvaWQ/paddleocr-js-onnx/resolve/main/pp_doclayout_m/PP-DocLayout-M_infer.onnx",
  bytes: 23_496_395,
  sha256: "c5032bdae772887e9de4d2e955c05c42ac7f38c8c8eb6bdc1b4560dc5cf1c786",
};

export const DEFAULT_OCR_PROFILE: OcrProfile = {
  id: "pp-ocrv6-small",
  label: "多语种通用 · PP-OCRv6（默认）",
  languagesLabel: "简体中文、繁體中文、English、日语及 46 种拉丁语系（法/德/西/葡/意/越/印尼/土耳其等）",
  modelPreset: "PP-OCRv6_small",
  dictionaryFormat: "paddle-yml",
  detection: SHARED_OCR_V6_DETECTION,
  recognition: {
    id: "pp-ocrv6-small-rec",
    label: "PP-OCRv6 多语种文字识别模型",
    url: "https://huggingface.co/PaddlePaddle/PP-OCRv6_small_rec_onnx/resolve/main/inference.onnx",
    bytes: 21_159_378,
    sha256: "5435fd747c9e0efe15a96d0b378d5bd157e9492ed8fd80edf08f30d02fa24634",
  },
  dictionary: {
    id: "pp-ocrv6-small-yml",
    label: "PP-OCRv6 多语种字符字典",
    url: "https://huggingface.co/PaddlePaddle/PP-OCRv6_small_rec_onnx/resolve/main/inference.yml",
    bytes: 150_579,
    sha256: "ab078671bb49f06228eadccd34f1bb501e157f7a047095ffb943ba81512c77d1",
  },
};

export const KOREAN_OCR_PROFILE: OcrProfile = {
  id: "pp-ocrv5-korean",
  label: "韩语 + 英语",
  languagesLabel: "韩语、English",
  modelPreset: "PP-OCRv5_mobile",
  dictionaryFormat: "plain",
  detection: SHARED_OCR_V5_DETECTION,
  recognition: {
    id: "pp-ocrv5-korean-rec",
    label: "韩语识别模型",
    url: "https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.10.0/onnx/PP-OCRv5/rec/korean_PP-OCRv5_rec_mobile.onnx",
    bytes: 13_488_748,
    sha256: "cd6e2ea50f6943ca7271eb8c56a877a5a90720b7047fe9c41a2e541a25773c9b",
  },
  dictionary: {
    id: "pp-ocrv5-korean-dict",
    label: "韩语字符字典",
    url: "https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.10.0/paddle/PP-OCRv5/rec/korean_PP-OCRv5_rec_mobile/ppocrv5_korean_dict.txt",
    bytes: 47_451,
    sha256: "a88071c68c01707489baa79ebe0405b7beb5cca229f4fc94cc3ef992328802d7",
  },
};

export const CYRILLIC_OCR_PROFILE: OcrProfile = {
  id: "pp-ocrv5-cyrillic",
  label: "西里尔语系（俄 / 乌等）",
  languagesLabel: "俄语、乌克兰语、白俄罗斯语、保加利亚语、塞尔维亚语、哈萨克语等",
  modelPreset: "PP-OCRv5_mobile",
  dictionaryFormat: "plain",
  detection: SHARED_OCR_V5_DETECTION,
  recognition: {
    id: "pp-ocrv5-cyrillic-rec",
    label: "西里尔语系识别模型",
    url: "https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.10.0/onnx/PP-OCRv5/rec/cyrillic_PP-OCRv5_rec_mobile.onnx",
    bytes: 8_074_092,
    sha256: "90f761b4bfcce0c8c561c0cb5c887b0971d3ec01c32164bdf7374a35b0982711",
  },
  dictionary: {
    id: "pp-ocrv5-cyrillic-dict",
    label: "西里尔语系字符字典",
    url: "https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.10.0/paddle/PP-OCRv5/rec/cyrillic_PP-OCRv5_rec_mobile/ppocrv5_cyrillic_dict.txt",
    bytes: 2_781,
    sha256: "db40aa52ceb112055be80c694afdf655d5d2c4f7873704524cc16a447ca913ba",
  },
};

export const THAI_OCR_PROFILE: OcrProfile = {
  id: "pp-ocrv5-th",
  label: "泰语 + 英语",
  languagesLabel: "泰语、English",
  modelPreset: "PP-OCRv5_mobile",
  dictionaryFormat: "plain",
  detection: SHARED_OCR_V5_DETECTION,
  recognition: {
    id: "pp-ocrv5-th-rec",
    label: "泰语识别模型",
    url: "https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.10.0/onnx/PP-OCRv5/rec/th_PP-OCRv5_rec_mobile.onnx",
    bytes: 7_915_294,
    sha256: "de541dd83161c241ff426f7ecfd602a0ba77d686cf3ab9a6c255ea82fd08006e",
  },
  dictionary: {
    id: "pp-ocrv5-th-dict",
    label: "泰语字符字典",
    url: "https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.10.0/paddle/PP-OCRv5/rec/th_PP-OCRv5_rec_mobile/ppocrv5_th_dict.txt",
    bytes: 1_767,
    sha256: "57f5406f94bb6688fb7077f7be65f08bbd71cecf48c01ea26c522cb5c4836b7a",
  },
};

export const OCR_PROFILES: readonly OcrProfile[] = [
  DEFAULT_OCR_PROFILE,
  KOREAN_OCR_PROFILE,
  CYRILLIC_OCR_PROFILE,
  THAI_OCR_PROFILE,
];

const LEGACY_PROFILE_ALIASES: Record<string, string> = {
  "pp-ocrv5-mobile": DEFAULT_OCR_PROFILE.id,
  "pp-ocrv5-latin": DEFAULT_OCR_PROFILE.id,
};

export function normalizeOcrProfileId(id?: string | null): string {
  const trimmed = id?.trim();
  if (!trimmed) return DEFAULT_OCR_PROFILE.id;
  const aliased = LEGACY_PROFILE_ALIASES[trimmed] ?? trimmed;
  return OCR_PROFILES.some((profile) => profile.id === aliased) ? aliased : DEFAULT_OCR_PROFILE.id;
}

export function getOcrProfile(id?: string | null): OcrProfile {
  const normalized = normalizeOcrProfileId(id);
  return OCR_PROFILES.find((profile) => profile.id === normalized) ?? DEFAULT_OCR_PROFILE;
}

export function ocrProfileRecognitionBytes(profile: OcrProfile = DEFAULT_OCR_PROFILE): number {
  return profile.recognition.bytes + profile.dictionary.bytes;
}

export function ocrProfileTotalBytes(profile: OcrProfile = DEFAULT_OCR_PROFILE): number {
  return profile.detection.bytes + profile.recognition.bytes + profile.dictionary.bytes;
}

/**
 * Parses either a newline-delimited PaddleOCR dictionary file or a PaddleX `inference.yml`
 * containing `PostProcess.character_dict:` YAML list items, appending `" "` if absent.
 */
export function parseOcrDictionaryText(raw: string, format?: OcrDictionaryFormat): string[] {
  const normalized = raw.replace(/\r/g, "");
  const isYaml = format === "paddle-yml" || (!format && /^\s*character_dict:\s*$/m.test(normalized));
  let dictionary: string[];

  if (isYaml) {
    const marker = normalized.match(/^[ \t]*character_dict:[ \t]*$/m);
    if (!marker || marker.index === undefined) {
      throw new Error("OCR 字典配置缺少 character_dict 字段");
    }
    const after = normalized.slice(marker.index + marker[0].length);
    const lines = after.split("\n");
    dictionary = [];
    for (const line of lines) {
      const itemMatch = line.match(/^[ \t]*- (.*)$/);
      if (!itemMatch) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        if (/^[A-Za-z_][A-Za-z0-9_]*:/.test(trimmed)) break;
        continue;
      }
      const value = itemMatch[1]!;
      if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
        dictionary.push(value.slice(1, -1).replace(/''/g, "'"));
      } else if (value.startsWith("\"") && value.endsWith("\"") && value.length >= 2) {
        try {
          const parsed = JSON.parse(value);
          dictionary.push(typeof parsed === "string" ? parsed : value.slice(1, -1));
        } catch {
          dictionary.push(value.slice(1, -1));
        }
      } else {
        dictionary.push(value);
      }
    }
  } else {
    dictionary = normalized.replace(/\n+$/, "").split("\n");
  }

  if (!dictionary.includes(" ")) dictionary.push(" ");
  return dictionary;
}
