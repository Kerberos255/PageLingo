import { build } from "esbuild";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";

await rm("dist", { recursive: true, force: true });
await mkdir("dist", { recursive: true });
await cp("public", "dist", { recursive: true });
await mkdir("dist/vendor/bergamot", { recursive: true });
await mkdir("dist/vendor/onnxruntime", { recursive: true });
await mkdir("dist/vendor/pdfjs", { recursive: true });
await Promise.all([
  cp("vendor/bergamot/bergamot-translator.js", "dist/vendor/bergamot/bergamot-translator.js"),
  cp("vendor/bergamot/bergamot-translator-v4.wasm", "dist/vendor/bergamot/bergamot-translator.wasm"),
  cp("vendor/bergamot/LICENSE", "dist/vendor/bergamot/LICENSE"),
  cp("node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm", "dist/vendor/onnxruntime/ort-wasm-simd-threaded.wasm"),
  cp("node_modules/pdfjs-dist/cmaps", "dist/vendor/pdfjs/cmaps", { recursive: true }),
  cp("node_modules/pdfjs-dist/standard_fonts", "dist/vendor/pdfjs/standard_fonts", { recursive: true }),
  cp("THIRD_PARTY_NOTICES.md", "dist/THIRD_PARTY_NOTICES.md"),
  cp("LICENSE.md", "dist/LICENSE.md"),
  cp("PRIVACY.md", "dist/PRIVACY.md"),
]);

await build({
  entryPoints: {
    background: "src/background.ts",
    content: "src/content-entry.ts",
    popup: "src/popup.ts",
    options: "src/options.ts",
    reader: "src/reader.ts",
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

// Disable unreachable ORT dynamic import fallback so web-ext lint stays 0 warnings.
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

// Neutralize CSP-blocked new Function("") eval probes and dynamic import() fallbacks in pdfjs-dist
// (under MV3 CSP script-src 'self' 'wasm-unsafe-eval', PDF.js already runs with isEvalSupported=false).
function hardenPdfJsForMv3(source, label) {
  let out = source;
  // 1. Replace isEvalSupported() probe body with constant false.
  const evalProbeRe = /function isEvalSupported\(\)\s*\{\s*try\s*\{\s*new Function\(""\);\s*return true;\s*\}\s*catch\s*\{\s*return false;\s*\}\s*\}/g;
  if (!evalProbeRe.test(out)) {
    throw new Error(`Expected isEvalSupported() probe in ${label}`);
  }
  out = out.replace(evalProbeRe, "function isEvalSupported() { return false; }");

  // 2. Replace unreachable compiled PostScript Function constructor in pdf.worker.mjs (only called if isEvalSupported).
  out = out.replace(
    /return new Function\("src",\s*"srcOffset",\s*"dest",\s*"destOffset",\s*compiled\);/g,
    "return null;",
  );

  // 3. Replace unreachable dynamic import(...) fallbacks (real same-origin Web Worker is always bundled).
  out = out.replace(
    /await import\(\s*(?:\/\*[\s\S]*?\*\/\s*)*[^)]+\)/g,
    'await Promise.reject(new Error("Dynamic module import is disabled in PageLingo PDF reader"))',
  );
  return out;
}

const readerBundlePath = "dist/reader.js";
const hardenedReader = hardenPdfJsForMv3(await readFile(readerBundlePath, "utf8"), "dist/reader.js");
await writeFile(readerBundlePath, hardenedReader);

const rawPdfWorker = await readFile("node_modules/pdfjs-dist/build/pdf.worker.mjs", "utf8");
const hardenedPdfWorker = hardenPdfJsForMv3(rawPdfWorker, "pdf.worker.mjs");
await writeFile("dist/vendor/pdfjs/pdf.worker.mjs", hardenedPdfWorker);
