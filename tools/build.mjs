import { build } from "esbuild";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

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
  cp("node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.mjs", "dist/vendor/onnxruntime/ort-wasm-simd-threaded.mjs"),
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
  charset: "utf8",
  target: ["firefox142"],
  outdir: "dist",
  sourcemap: false,
  minify: false,
  legalComments: "inline",
});

// Resolve onnxruntime-web/wasm to the official unminified dist/ort.wasm.mjs
// instead of pre-minified ort.wasm.bundle.min.mjs so every line of image-ocr-worker.js
// remains human-readable while the unmodified official Emscripten WASM factory is
// statically imported from dist/vendor/onnxruntime/ort-wasm-simd-threaded.mjs.
const unminifiedOrtWasmPlugin = {
  name: "unminified-onnxruntime-web-wasm",
  setup(buildApi) {
    const unminifiedOrtWasmPath = resolve("node_modules/onnxruntime-web/dist/ort.wasm.mjs");
    buildApi.onResolve({ filter: /^onnxruntime-web\/wasm$/ }, () => ({
      path: unminifiedOrtWasmPath,
    }));
  },
};

await build({
  entryPoints: { "image-ocr-worker": "src/workers/image-ocr-worker.ts" },
  bundle: true,
  platform: "browser",
  format: "esm",
  charset: "utf8",
  target: ["firefox142"],
  define: { require: "undefined" },
  plugins: [unminifiedOrtWasmPlugin],
  outdir: "dist",
  sourcemap: false,
  minify: false,
  legalComments: "inline",
});

// Statically bind the unmodified official ONNX Runtime Emscripten WASM factory and
// disable the unreachable dynamic import() fallback so web-ext lint stays at 0 warnings.
const ocrWorkerPath = "dist/image-ocr-worker.js";
let ocrWorkerSource = await readFile(ocrWorkerPath, "utf8");
const embeddedWasmRe = /\bembeddedWasmModule\s*=\s*(?:false\s*\?[\s\S]*?:\s*)?void 0;/g;
const embeddedMatches = [...ocrWorkerSource.matchAll(embeddedWasmRe)];
if (embeddedMatches.length !== 1) {
  throw new Error(`Expected exactly one embeddedWasmModule slot in unminified ORT, found ${embeddedMatches.length}`);
}
ocrWorkerSource =
  'import ortWasmThreadedFactory from "./vendor/onnxruntime/ort-wasm-simd-threaded.mjs";\n'
  + ocrWorkerSource.replace(embeddedWasmRe, "embeddedWasmModule = ortWasmThreadedFactory;");

const dynamicImports = [...ocrWorkerSource.matchAll(/\bimport\(\s*[\s\S]*?\)/g)];
if (dynamicImports.length !== 1) {
  throw new Error(`Expected exactly one unreachable ORT dynamic import fallback, found ${dynamicImports.length}`);
}
ocrWorkerSource = ocrWorkerSource.replace(
  /\bimport\(\s*[\s\S]*?\)/,
  'Promise.reject(new Error("Dynamic WASM module loading is disabled in the PageLingo OCR worker"))',
);
if (/sourceMappingURL=data:/i.test(ocrWorkerSource)) {
  throw new Error("Unexpected inline data sourceMappingURL in dist/image-ocr-worker.js");
}
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
