import { writeFile } from "node:fs/promises";

const REGISTRY_URL = "https://storage.googleapis.com/moz-fx-translations-data--303e-prod-translations-data/db/models.json";
const REMOTE_SETTINGS_URL = "https://firefox.settings.services.mozilla.com/v1/buckets/main/collections/translations-models-v2/records";
const ATTACHMENT_BASE_URL = "https://firefox-settings-attachments.cdn.mozilla.net/";
const OUTPUT = new URL("../src/providers/bergamot/model-catalog.generated.ts", import.meta.url);

function normalizeLanguage(code) {
  if (code === "zh") return "zh-Hans";
  if (code === "zh_hant") return "zh-Hant";
  return code.replaceAll("_", "-");
}

const releasePriority = { "Release Desktop": 3, Release: 2 };
const architecturePriority = { base: 3, "base-memory": 2, tiny: 1 };

function selectDesktopRelease(entries) {
  return entries
    .filter((entry) => entry.releaseStatus === "Release" || entry.releaseStatus === "Release Desktop")
    .sort((a, b) =>
      (releasePriority[b.releaseStatus] ?? 0) - (releasePriority[a.releaseStatus] ?? 0) ||
      (architecturePriority[b.architecture] ?? 0) - (architecturePriority[a.architecture] ?? 0)
    )[0] ?? null;
}

function isDesktopRecord(record) {
  return !(record.filter_expression ?? "").includes("OS == 'Android'");
}

function requiredFileTypes(entry) {
  const types = ["model", "lex"];
  if (entry.files?.vocab?.path) types.push("vocab");
  else if (entry.files?.srcVocab?.path && entry.files?.trgVocab?.path) types.push("srcvocab", "trgvocab");
  return types;
}

function quote(value) {
  return JSON.stringify(value);
}

const [registryResponse, remoteResponse] = await Promise.all([
  fetch(REGISTRY_URL),
  fetch(REMOTE_SETTINGS_URL),
]);
if (!registryResponse.ok) throw new Error(`Model registry HTTP ${registryResponse.status}`);
if (!remoteResponse.ok) throw new Error(`Remote Settings HTTP ${remoteResponse.status}`);

const registry = await registryResponse.json();
const remote = await remoteResponse.json();
const records = remote.data ?? [];
const selected = [];

for (const [registryPair, entries] of Object.entries(registry.models ?? {})) {
  const entry = selectDesktopRelease(entries);
  if (!entry) continue;

  const sourceLanguage = normalizeLanguage(entry.sourceLanguage);
  const targetLanguage = normalizeLanguage(entry.targetLanguage);
  const modelHash = entry.files?.model?.uncompressedHash;
  const modelRecord = records.find((record) =>
    record.fileType === "model" &&
    normalizeLanguage(record.sourceLanguage) === sourceLanguage &&
    normalizeLanguage(record.targetLanguage) === targetLanguage &&
    record.architecture === entry.architecture &&
    record.decompressedHash === modelHash &&
    isDesktopRecord(record)
  );
  if (!modelRecord?.version) {
    console.warn(`Skipping ${registryPair}: stable registry model is not deployed by Firefox Remote Settings`);
    continue;
  }

  const version = modelRecord.version;
  const filter = modelRecord.filter_expression ?? "";
  const assets = [];
  for (const type of requiredFileTypes(entry)) {
    const record = records.find((candidate) =>
      candidate.fileType === type &&
      normalizeLanguage(candidate.sourceLanguage) === sourceLanguage &&
      normalizeLanguage(candidate.targetLanguage) === targetLanguage &&
      candidate.architecture === entry.architecture &&
      candidate.version === version &&
      (candidate.filter_expression ?? "") === filter &&
      isDesktopRecord(candidate)
    );
    if (!record?.decompressedHash || !record?.decompressedSize || !record?.attachment?.location) {
      console.warn(`Skipping ${registryPair}: missing deployed ${type} record for ${version}`);
      assets.length = 0;
      break;
    }
    assets.push({
      type,
      url: `${ATTACHMENT_BASE_URL}${record.attachment.location}`,
      bytes: record.decompressedSize,
      sha256: record.decompressedHash,
      alignment: type === "model" ? 256 : 64,
      compression: "zstd",
    });
  }

  if (assets.length === 0) continue;
  const hasModel = assets.some((asset) => asset.type === "model");
  const hasLex = assets.some((asset) => asset.type === "lex");
  const hasSharedVocab = assets.some((asset) => asset.type === "vocab");
  const hasSplitVocabs = assets.some((asset) => asset.type === "srcvocab") && assets.some((asset) => asset.type === "trgvocab");
  if (!hasModel || !hasLex || (!hasSharedVocab && !hasSplitVocabs)) {
    console.warn(`Skipping ${registryPair}: incomplete deployed bundle`);
    continue;
  }

  selected.push({
    key: `${sourceLanguage}->${targetLanguage}`,
    sourceLanguage,
    targetLanguage,
    architecture: entry.architecture,
    releaseStatus: entry.releaseStatus,
    version,
    installedBytes: assets.reduce((sum, asset) => sum + asset.bytes, 0),
    assets,
  });
}

selected.sort((a, b) => a.key.localeCompare(b.key));

const lines = [];
lines.push("// GENERATED FILE. Run `node tools/update-model-catalog.mjs` to refresh from Mozilla.");
lines.push(`// Registry generated: ${registry.generated ?? "unknown"}`);
lines.push(`export const MODEL_CATALOG_GENERATED_AT = ${quote(registry.generated ?? "unknown")} as const;`);
lines.push("export const MODEL_CATALOG = [");
for (const entry of selected) {
  lines.push("  {");
  lines.push(`    key: ${quote(entry.key)},`);
  lines.push(`    sourceLanguage: ${quote(entry.sourceLanguage)},`);
  lines.push(`    targetLanguage: ${quote(entry.targetLanguage)},`);
  lines.push(`    architecture: ${quote(entry.architecture)},`);
  lines.push(`    releaseStatus: ${quote(entry.releaseStatus)},`);
  lines.push(`    version: ${quote(entry.version)},`);
  lines.push(`    installedBytes: ${entry.installedBytes},`);
  lines.push("    assets: [");
  for (const asset of entry.assets) {
    lines.push(`      { type: ${quote(asset.type)}, url: ${quote(asset.url)}, bytes: ${asset.bytes}, sha256: ${quote(asset.sha256)}, alignment: ${asset.alignment}, compression: "zstd" },`);
  }
  lines.push("    ],");
  lines.push("  },");
}
lines.push("] as const;");

await writeFile(OUTPUT, `${lines.join("\n")}\n`, "utf8");
console.log(`Wrote ${selected.length} stable desktop model pairs to ${OUTPUT.pathname}`);
