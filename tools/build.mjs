import { build } from "esbuild";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";

await rm("dist", { recursive: true, force: true });
await mkdir("dist", { recursive: true });
await cp("public", "dist", { recursive: true });
await mkdir("dist/vendor/bergamot", { recursive: true });
await mkdir("dist/vendor/onnxruntime", { recursive: true });
await Promise.all([
  cp("vendor/bergamot/bergamot-translator.js", "dist/vendor/bergamot/bergamot-translator.js"),
  cp("vendor/bergamot/bergamot-translator-v4.wasm", "dist/vendor/bergamot/bergamot-translator.wasm"),
  cp("vendor/bergamot/LICENSE", "dist/vendor/bergamot/LICENSE"),
  cp("node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm", "dist/vendor/onnxruntime/ort-wasm-simd-threaded.wasm"),
  cp("THIRD_PARTY_NOTICES.md", "dist/THIRD_PARTY_NOTICES.md"),
  cp("LICENSE.md", "dist/LICENSE.md"),
  cp("PRIVACY.md", "dist/PRIVACY.md"),
  cp("node_modules/onnxruntime-web/LICENSE", "dist/vendor/onnxruntime/LICENSE"),
]);

await build({
  entryPoints: {
    background: "src/background.ts",
    content: "src/content.ts",
    popup: "src/popup.ts",
    options: "src/options.ts",
    "bergamot-worker": "src/workers/bergamot-worker.ts",
  },
  bundle: true,
  format: "iife",
  target: ["firefox142"],
  outdir: "dist",
  sourcemap: false,
  minify: false,
  legalComments: "none",
});

await build({
  entryPoints: { "image-ocr-worker": "src/workers/image-ocr-worker.ts" },
  bundle: true,
  platform: "browser",
  format: "iife",
  target: ["firefox142"],
  define: { require: "undefined" },
  outdir: "dist",
  sourcemap: false,
  minify: false,
  legalComments: "none",
});

const ocrWorkerPath = "dist/image-ocr-worker.js";
let ocrWorkerSource = await readFile(ocrWorkerPath, "utf8");
const dynamicImports = [...ocrWorkerSource.matchAll(/\bimport\(\s*[^)]*\s*\)/g)];
if (dynamicImports.length !== 1) {
  throw new Error(`Expected exactly one unreachable ORT dynamic import fallback, found ${dynamicImports.length}`);
}
ocrWorkerSource = ocrWorkerSource.replace(
  /\bimport\(\s*[^)]*\s*\)/,
  'Promise.reject(new Error("Dynamic WASM module loading is disabled in the PageLingo OCR worker"))',
);
await writeFile(ocrWorkerPath, ocrWorkerSource);
