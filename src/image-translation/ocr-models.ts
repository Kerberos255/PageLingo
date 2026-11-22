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
  modelPreset: "PP-OCRv5_mobile" | "PP-OCRv6_tiny";
  detection: OcrModelAsset;
  recognition: OcrModelAsset;
  dictionary: OcrModelAsset;
}

export const MAX_OCR_IMAGE_SIDE = 2200;

export const DEFAULT_OCR_PROFILE: OcrProfile = {
  id: "pp-ocrv5-mobile",
  label: "PP-OCRv5 Mobile",
  modelPreset: "PP-OCRv5_mobile",
  detection: {
    id: "pp-ocrv5-mobile-det",
    label: "文字检测模型",
    url: "https://huggingface.co/PaddlePaddle/PP-OCRv5_mobile_det_onnx/resolve/main/inference.onnx",
    bytes: 4_826_518,
    sha256: "a431985659dc921974177a95adcfbb90fd9e51989a5e04d70d0b75f597b6e61d",
  },
  recognition: {
    id: "pp-ocrv5-mobile-rec",
    label: "文字识别模型",
    url: "https://huggingface.co/PaddlePaddle/PP-OCRv5_mobile_rec_onnx/resolve/main/inference.onnx",
    bytes: 16_534_782,
    sha256: "da72dc72ca4dc220df0dfde68c1dedc31c58d3e76a25871122e5056227d50092",
  },
  dictionary: {
    id: "pp-ocrv5-dict",
    label: "字符字典",
    url: "https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.9.0/paddle/PP-OCRv5/rec/ch_PP-OCRv5_rec_server/ppocrv5_dict.txt",
    bytes: 74_012,
    sha256: "d1979e9f794c464c0d2e0b70a7fe14dd978e9dc644c0e71f14158cdf8342af1b",
  },
};

export const OCR_PROFILES: readonly OcrProfile[] = [DEFAULT_OCR_PROFILE];

export function ocrProfileTotalBytes(profile: OcrProfile = DEFAULT_OCR_PROFILE): number {
  return profile.detection.bytes + profile.recognition.bytes + profile.dictionary.bytes;
}
