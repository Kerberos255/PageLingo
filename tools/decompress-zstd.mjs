import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { decompress } from "fzstd";

const [inputPath, outputPath, expectedSha256] = process.argv.slice(2);
if (!inputPath || !outputPath) {
  throw new Error("Usage: node tools/decompress-zstd.mjs <input.zst> <output> [sha256]");
}

const compressed = new Uint8Array(await readFile(inputPath));
const decompressed = decompress(compressed);
const actualSha256 = createHash("sha256").update(decompressed).digest("hex");

if (expectedSha256 && actualSha256 !== expectedSha256.toLowerCase()) {
  throw new Error(`SHA-256 mismatch: expected ${expectedSha256}, got ${actualSha256}`);
}

await writeFile(outputPath, decompressed);
console.log(JSON.stringify({ bytes: decompressed.byteLength, sha256: actualSha256 }));
