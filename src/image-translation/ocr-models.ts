export interface OcrModelAsset {
  id: string;
  label: string;
  url: string;
  bytes: number;
  sha256: string;
}

export interface OcrProfile {
  id: string;
  label: string;
  languagesLabel: string;
  modelPreset: "PP-OCRv5_mobile" | "PP-OCRv6_tiny";
  detection: OcrModelAsset;
  recognition: OcrModelAsset;
  dictionary: OcrModelAsset;
}

export const MAX_OCR_IMAGE_SIDE = 2200;

/**
 * Language-agnostic PP-OCRv5 text detector (~4.8 MB).
 * Downloaded once and shared across all installed OCR recognition language packs.
 */
export const SHARED_OCR_DETECTION: OcrModelAsset = {
  id: "pp-ocrv5-mobile-det",
  label: "通用文字检测模型",
  url: "https://huggingface.co/PaddlePaddle/PP-OCRv5_mobile_det_onnx/resolve/main/inference.onnx",
  bytes: 4_826_518,
  sha256: "a431985659dc921974177a95adcfbb90fd9e51989a5e04d70d0b75f597b6e61d",
};

export const DEFAULT_OCR_PROFILE: OcrProfile = {
  id: "pp-ocrv5-mobile",
  label: "中日英（默认）",
  languagesLabel: "简体中文、繁體中文、English、日语",
  modelPreset: "PP-OCRv5_mobile",
  detection: SHARED_OCR_DETECTION,
  recognition: {
    id: "pp-ocrv5-mobile-rec",
    label: "中日英文字识别模型",
    url: "https://huggingface.co/PaddlePaddle/PP-OCRv5_mobile_rec_onnx/resolve/main/inference.onnx",
    bytes: 16_534_782,
    sha256: "da72dc72ca4dc220df0dfde68c1dedc31c58d3e76a25871122e5056227d50092",
  },
  dictionary: {
    id: "pp-ocrv5-dict",
    label: "中日英字符字典",
    url: "https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.9.0/paddle/PP-OCRv5/rec/ch_PP-OCRv5_rec_server/ppocrv5_dict.txt",
    bytes: 74_012,
    sha256: "d1979e9f794c464c0d2e0b70a7fe14dd978e9dc644c0e71f14158cdf8342af1b",
  },
};

export const LATIN_OCR_PROFILE: OcrProfile = {
  id: "pp-ocrv5-latin",
  label: "拉丁语系（欧洲 / 东南亚）",
  languagesLabel: "法语、德语、西班牙语、葡萄牙语、意大利语、荷兰语、波兰语、越南语、印尼语、土耳其语等",
  modelPreset: "PP-OCRv5_mobile",
  detection: SHARED_OCR_DETECTION,
  recognition: {
    id: "pp-ocrv5-latin-rec",
    label: "拉丁语系识别模型",
    url: "https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.10.0/onnx/PP-OCRv5/rec/latin_PP-OCRv5_rec_mobile.onnx",
    bytes: 7_904_513,
    sha256: "b20bd37c168a570f583afbc8cd7925603890efbcdc000a59e22c269d160b5f5a",
  },
  dictionary: {
    id: "pp-ocrv5-latin-dict",
    label: "拉丁语系字符字典",
    url: "https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.10.0/paddle/PP-OCRv5/rec/latin_PP-OCRv5_rec_mobile/ppocrv5_latin_dict.txt",
    bytes: 1_634,
    sha256: "3c0a8a79b612653c25f765271714f71281e4e955962c153e272b7b8c1d2b13ff",
  },
};

export const KOREAN_OCR_PROFILE: OcrProfile = {
  id: "pp-ocrv5-korean",
  label: "韩语 + 英语",
  languagesLabel: "韩语、English",
  modelPreset: "PP-OCRv5_mobile",
  detection: SHARED_OCR_DETECTION,
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
  detection: SHARED_OCR_DETECTION,
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
  detection: SHARED_OCR_DETECTION,
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
  LATIN_OCR_PROFILE,
  KOREAN_OCR_PROFILE,
  CYRILLIC_OCR_PROFILE,
  THAI_OCR_PROFILE,
];

export function getOcrProfile(id?: string | null): OcrProfile {
  if (!id) return DEFAULT_OCR_PROFILE;
  return OCR_PROFILES.find((profile) => profile.id === id) ?? DEFAULT_OCR_PROFILE;
}

export function ocrProfileRecognitionBytes(profile: OcrProfile = DEFAULT_OCR_PROFILE): number {
  return profile.recognition.bytes + profile.dictionary.bytes;
}

export function ocrProfileTotalBytes(profile: OcrProfile = DEFAULT_OCR_PROFILE): number {
  return profile.detection.bytes + profile.recognition.bytes + profile.dictionary.bytes;
}
