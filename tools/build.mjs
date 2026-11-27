import { build } from "esbuild";
import { cp, mkdir, readFile, rm } from "node:fs/promises";
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
  cp("node_modules/pdfjs-dist/build/pdf.worker.mjs", "dist/vendor/pdfjs/pdf.worker.mjs"),
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
// instead of pre-minified ort.wasm.bundle.min.mjs. All third-party files remain
// completely unmodified; image-ocr-worker.ts loads the unmodified official
// vendor/onnxruntime/ort-wasm-simd-threaded.{mjs,wasm} via public ort.env.wasm.wasmPaths.
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

const ocrWorkerSource = await readFile("dist/image-ocr-worker.js", "utf8");
if (/sourceMappingURL=data:/i.test(ocrWorkerSource)) {
  throw new Error("Unexpected inline data sourceMappingURL in dist/image-ocr-worker.js");
}
