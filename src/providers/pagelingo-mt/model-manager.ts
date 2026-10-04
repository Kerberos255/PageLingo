import { ModelManager, ModelValidationStatus, type Model } from "@wllama/wllama";

export const PAGELINGO_MT_REPO = "kerberos255/PageLingo-Translate-1.8B";
export const PAGELINGO_MT_VERSION = "v0.2.2";
export const PAGELINGO_MT_QUANT = "Q5_K_M";
export const PAGELINGO_MT_FILE = "PageLingo-Translate-1.8B-v0.2.2-Q5_K_M.gguf";
export const PAGELINGO_MT_SIZE = 1_298_755_616;
export const PAGELINGO_MT_SHA256 = "8f8734198ad9332db97101de3ae7216daa3b59218522c4e0beebdfb4999924cc";
export const PAGELINGO_MT_URL =
  `https://huggingface.co/${PAGELINGO_MT_REPO}/resolve/main/${PAGELINGO_MT_FILE}`;

const manager = new ModelManager({ parallelDownloads: 1 });

function exactModel(models: Model[]): Model | null {
  return models.find((model) => model.url === PAGELINGO_MT_URL) ?? null;
}

export function pageLingoMtModelVerified(model: Model): boolean {
  if (model.validate() !== ModelValidationStatus.VALID) return false;
  if (model.size !== PAGELINGO_MT_SIZE || model.files.length !== 1) return false;
  const metadata = model.files[0]?.metadata;
  return Boolean(
    metadata
    && metadata.originalURL === PAGELINGO_MT_URL
    && metadata.originalSize === PAGELINGO_MT_SIZE
    && metadata.sha256 === PAGELINGO_MT_SHA256
  );
}

export async function getCachedPageLingoMtModel(includeInvalid = true): Promise<Model | null> {
  const models = await manager.getModels({ includeInvalid });
  return exactModel(models);
}

export async function getVerifiedPageLingoMtModel(): Promise<Model> {
  const model = await getCachedPageLingoMtModel(true);
  if (!model || !pageLingoMtModelVerified(model)) {
    throw new Error("PageLingo MT 模型尚未下载或完整性校验未通过");
  }
  return model;
}

export async function downloadPageLingoMtModel(
  progressCallback?: (state: { loaded: number; total: number }) => void,
): Promise<Model> {
  const cached = await getCachedPageLingoMtModel(true);
  if (cached && pageLingoMtModelVerified(cached)) {
    progressCallback?.({ loaded: PAGELINGO_MT_SIZE, total: PAGELINGO_MT_SIZE });
    return cached;
  }
  if (cached) await cached.remove();

  const model = await manager.downloadModel(PAGELINGO_MT_URL, { progressCallback });
  if (!pageLingoMtModelVerified(model)) {
    await model.remove().catch(() => undefined);
    throw new Error("PageLingo MT 下载完成，但固定大小或 Hugging Face LFS SHA-256 校验失败；已删除该文件");
  }
  return model;
}

export async function deletePageLingoMtModel(): Promise<void> {
  const model = await getCachedPageLingoMtModel(true);
  if (model) await model.remove();
}

export async function pageLingoMtModelStatus(): Promise<{
  installed: boolean;
  verified: boolean;
  totalBytes: number;
  version: string;
  quant: string;
  sha256: string;
}> {
  const model = await getCachedPageLingoMtModel(true).catch(() => null);
  const verified = Boolean(model && pageLingoMtModelVerified(model));
  return {
    installed: verified,
    verified,
    totalBytes: PAGELINGO_MT_SIZE,
    version: PAGELINGO_MT_VERSION,
    quant: PAGELINGO_MT_QUANT,
    sha256: PAGELINGO_MT_SHA256,
  };
}
