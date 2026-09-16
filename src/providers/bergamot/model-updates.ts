import {
  getModelPair,
  listModelPairs,
  modelPairKey,
  type BergamotModelAsset,
  type BergamotModelFileType,
  type BergamotModelPair,
} from "./model-manifest";

const REGISTRY_URL = "https://storage.googleapis.com/moz-fx-translations-data--303e-prod-translations-data/db/models.json";
const REMOTE_SETTINGS_URL = "https://firefox.settings.services.mozilla.com/v1/buckets/main/collections/translations-models-v2/records";
const ATTACHMENT_BASE_URL = "https://firefox-settings-attachments.cdn.mozilla.net/";
const OVERRIDES_KEY = "modelCatalogOverridesV1";
const UPDATE_STATE_KEY = "modelUpdateStateV1";

export type ModelCatalogOverrides = Record<string, BergamotModelPair>;

export interface ModelUpdateState {
  checkedAt: number;
  available: ModelCatalogOverrides;
}

interface RegistryFile { path?: string; uncompressedHash?: string; uncompressedSize?: number }
interface RegistryEntry {
  architecture?: string;
  releaseStatus?: string | null;
  sourceLanguage?: string;
  targetLanguage?: string;
  files?: {
    model?: RegistryFile;
    lexicalShortlist?: RegistryFile;
    vocab?: RegistryFile;
    srcVocab?: RegistryFile;
    trgVocab?: RegistryFile;
  };
}
interface RegistryResponse { models?: Record<string, RegistryEntry[]> }
interface RemoteRecord {
  fileType?: string;
  version?: string;
  architecture?: string;
  sourceLanguage?: string;
  targetLanguage?: string;
  decompressedHash?: string;
  decompressedSize?: number;
  filter_expression?: string;
  attachment?: { location?: string };
}
interface RemoteResponse { data?: RemoteRecord[] }

function normalizeLanguage(code: string | undefined): string {
  const raw = (code ?? "").replaceAll("_", "-");
  if (raw === "zh") return "zh-Hans";
  if (raw === "zh-hant") return "zh-Hant";
  return raw;
}

const releasePriority: Record<string, number> = { "Release Desktop": 3, Release: 2 };
const architecturePriority: Record<string, number> = { base: 3, "base-memory": 2, tiny: 1 };

function selectDesktopRelease(entries: RegistryEntry[]): RegistryEntry | null {
  return entries
    .filter((entry) => entry.releaseStatus === "Release" || entry.releaseStatus === "Release Desktop")
    .sort((a, b) =>
      (releasePriority[b.releaseStatus ?? ""] ?? 0) - (releasePriority[a.releaseStatus ?? ""] ?? 0) ||
      (architecturePriority[b.architecture ?? ""] ?? 0) - (architecturePriority[a.architecture ?? ""] ?? 0)
    )[0] ?? null;
}

function isDesktopRecord(record: RemoteRecord): boolean {
  return !(record.filter_expression ?? "").includes("OS == 'Android'");
}

function requiredFileTypes(entry: RegistryEntry): BergamotModelFileType[] {
  const types: BergamotModelFileType[] = ["model", "lex"];
  if (entry.files?.vocab?.path) types.push("vocab");
  else if (entry.files?.srcVocab?.path && entry.files?.trgVocab?.path) types.push("srcvocab", "trgvocab");
  return types;
}

function buildPair(entry: RegistryEntry, records: RemoteRecord[]): BergamotModelPair | null {
  const sourceLanguage = normalizeLanguage(entry.sourceLanguage);
  const targetLanguage = normalizeLanguage(entry.targetLanguage);
  const architecture = entry.architecture ?? "";
  const modelHash = entry.files?.model?.uncompressedHash;
  if (!sourceLanguage || !targetLanguage || !architecture || !modelHash) return null;

  const modelRecord = records.find((record) =>
    record.fileType === "model" &&
    normalizeLanguage(record.sourceLanguage) === sourceLanguage &&
    normalizeLanguage(record.targetLanguage) === targetLanguage &&
    record.architecture === architecture &&
    record.decompressedHash === modelHash &&
    isDesktopRecord(record)
  );
  if (!modelRecord?.version) return null;

  const filter = modelRecord.filter_expression ?? "";
  const assets: BergamotModelAsset[] = [];
  for (const type of requiredFileTypes(entry)) {
    const record = records.find((candidate) =>
      candidate.fileType === type &&
      normalizeLanguage(candidate.sourceLanguage) === sourceLanguage &&
      normalizeLanguage(candidate.targetLanguage) === targetLanguage &&
      candidate.architecture === architecture &&
      candidate.version === modelRecord.version &&
      (candidate.filter_expression ?? "") === filter &&
      isDesktopRecord(candidate)
    );
    if (!record?.decompressedHash || !record.decompressedSize || !record.attachment?.location) return null;
    assets.push({
      type,
      url: `${ATTACHMENT_BASE_URL}${record.attachment.location}`,
      bytes: record.decompressedSize,
      sha256: record.decompressedHash,
      alignment: type === "model" ? 256 : 64,
      compression: "zstd",
    });
  }

  const hasModel = assets.some((asset) => asset.type === "model");
  const hasLex = assets.some((asset) => asset.type === "lex");
  const hasSharedVocab = assets.some((asset) => asset.type === "vocab");
  const hasSplitVocabs = assets.some((asset) => asset.type === "srcvocab") && assets.some((asset) => asset.type === "trgvocab");
  if (!hasModel || !hasLex || (!hasSharedVocab && !hasSplitVocabs)) return null;

  return {
    key: modelPairKey(sourceLanguage, targetLanguage),
    sourceLanguage,
    targetLanguage,
    architecture,
    releaseStatus: entry.releaseStatus ?? "Release",
    version: modelRecord.version,
    installedBytes: assets.reduce((sum, asset) => sum + asset.bytes, 0),
    assets,
  };
}

function pairFingerprint(pair: BergamotModelPair): string {
  return pair.assets.map((asset) => `${asset.type}:${asset.sha256}`).sort().join("|");
}

function compareVersions(left: string, right: string): number {
  const a = left.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const b = right.split(".").map((part) => Number.parseInt(part, 10) || 0);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const delta = (a[index] ?? 0) - (b[index] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

export function isModelUpdate(current: BergamotModelPair, candidate: BergamotModelPair): boolean {
  const versionComparison = compareVersions(candidate.version, current.version);
  if (versionComparison < 0) return false;
  if (versionComparison > 0) return true;
  return pairFingerprint(candidate) !== pairFingerprint(current);
}

function validAsset(value: unknown): value is BergamotModelAsset {
  if (!value || typeof value !== "object") return false;
  const asset = value as Partial<BergamotModelAsset>;
  return ["model", "lex", "vocab", "srcvocab", "trgvocab"].includes(asset.type ?? "") &&
    typeof asset.url === "string" && asset.url.startsWith(ATTACHMENT_BASE_URL) &&
    typeof asset.bytes === "number" && asset.bytes > 0 &&
    typeof asset.sha256 === "string" && /^[a-f0-9]{64}$/.test(asset.sha256) &&
    (asset.alignment === 64 || asset.alignment === 256) && asset.compression === "zstd";
}

function validPair(value: unknown): value is BergamotModelPair {
  if (!value || typeof value !== "object") return false;
  const pair = value as Partial<BergamotModelPair>;
  if (typeof pair.key !== "string" || !getModelPair(...pair.key.split("->", 2) as [string, string])) return false;
  return typeof pair.sourceLanguage === "string" && typeof pair.targetLanguage === "string" &&
    pair.key === modelPairKey(pair.sourceLanguage, pair.targetLanguage) &&
    typeof pair.architecture === "string" && typeof pair.releaseStatus === "string" &&
    typeof pair.version === "string" && typeof pair.installedBytes === "number" && pair.installedBytes > 0 &&
    Array.isArray(pair.assets) && pair.assets.every(validAsset);
}

function sanitizeOverrides(value: unknown): ModelCatalogOverrides {
  if (!value || typeof value !== "object") return {};
  const result: ModelCatalogOverrides = {};
  for (const [key, pair] of Object.entries(value as Record<string, unknown>)) {
    if (validPair(pair) && pair.key === key) result[key] = pair;
  }
  return result;
}

export async function loadModelOverrides(): Promise<ModelCatalogOverrides> {
  const stored = await browser.storage.local.get(OVERRIDES_KEY);
  return sanitizeOverrides(stored[OVERRIDES_KEY]);
}

export async function saveModelOverrides(overrides: ModelCatalogOverrides): Promise<void> {
  await browser.storage.local.set({ [OVERRIDES_KEY]: overrides });
}

export async function loadModelUpdateState(): Promise<ModelUpdateState> {
  const stored = await browser.storage.local.get(UPDATE_STATE_KEY);
  const raw = stored[UPDATE_STATE_KEY] as Partial<ModelUpdateState> | undefined;
  return {
    checkedAt: typeof raw?.checkedAt === "number" ? raw.checkedAt : 0,
    available: sanitizeOverrides(raw?.available),
  };
}

export async function saveModelUpdateState(state: ModelUpdateState): Promise<void> {
  await browser.storage.local.set({ [UPDATE_STATE_KEY]: state });
}

export function effectivePairByKey(key: string, overrides: ModelCatalogOverrides): BergamotModelPair | null {
  return overrides[key] ?? getModelPair(...key.split("->", 2) as [string, string]);
}

export function effectivePair(sourceLanguage: string, targetLanguage: string, overrides: ModelCatalogOverrides): BergamotModelPair | null {
  return overrides[modelPairKey(sourceLanguage, targetLanguage)] ?? getModelPair(sourceLanguage, targetLanguage);
}

export async function fetchLatestPairs(keys: readonly string[]): Promise<Map<string, BergamotModelPair>> {
  const wanted = new Set(keys.filter((key) => listModelPairs().some((pair) => pair.key === key)));
  if (wanted.size === 0) return new Map();

  const [registryResponse, remoteResponse] = await Promise.all([fetch(REGISTRY_URL), fetch(REMOTE_SETTINGS_URL)]);
  if (!registryResponse.ok) throw new Error(`Mozilla model registry HTTP ${registryResponse.status}`);
  if (!remoteResponse.ok) throw new Error(`Firefox Remote Settings HTTP ${remoteResponse.status}`);

  const registry = await registryResponse.json() as RegistryResponse;
  const remote = await remoteResponse.json() as RemoteResponse;
  const records = remote.data ?? [];
  const grouped = new Map<string, RegistryEntry[]>();
  for (const entries of Object.values(registry.models ?? {})) {
    for (const entry of entries) {
      const key = modelPairKey(normalizeLanguage(entry.sourceLanguage), normalizeLanguage(entry.targetLanguage));
      if (!wanted.has(key)) continue;
      const bucket = grouped.get(key) ?? [];
      bucket.push(entry);
      grouped.set(key, bucket);
    }
  }

  const result = new Map<string, BergamotModelPair>();
  for (const key of wanted) {
    const selected = selectDesktopRelease(grouped.get(key) ?? []);
    if (!selected) continue;
    const pair = buildPair(selected, records);
    if (pair?.key === key) result.set(key, pair);
  }
  return result;
}
