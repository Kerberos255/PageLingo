import { build } from "esbuild";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

await rm("dist", { recursive: true, force: true });
await mkdir("dist", { recursive: true });
await cp("public", "dist", { recursive: true });
await mkdir("dist/vendor/bergamot", { recursive: true });
await mkdir("dist/vendor/onnxruntime", { recursive: true });
await mkdir("dist/vendor/wllama", { recursive: true });

const wllamaSourceRoot = resolve("node_modules/@wllama/wllama/src");
const wllamaUtilsPath = resolve(wllamaSourceRoot, "utils.ts");
const wllamaIndexPath = resolve(wllamaSourceRoot, "index.ts");

const originalCreateWorker = `export const createWorker = (workerCode: string | Blob): Worker => {
  const workerURL = URL.createObjectURL(
    isString(workerCode)
      ? new Blob([workerCode], { type: 'text/javascript' })
      : (workerCode as Blob)
  );
  return new Worker(workerURL, { type: 'module' });
};`;

const staticCreateWorker = `export const createWorker = (_workerCode: string | Blob): Worker => {
  const runtime = (globalThis as any).browser;
  if (!runtime?.runtime?.getURL) {
    throw new Error("PageLingo static wllama worker requires browser.runtime.getURL");
  }
  return new Worker(runtime.runtime.getURL("vendor/wllama/pagelingo-worker.js"), { type: 'module' });
};`;

const wllamaFirefoxPlugin = {
  name: "pagelingo-wllama-firefox-worker",
  setup(ctx) {
    ctx.onResolve({ filter: /^@wllama\/wllama\/esm\/index\.js$/ }, () => ({
      path: wllamaIndexPath,
    }));
    ctx.onLoad({ filter: /@wllama[\\/]wllama[\\/]src[\\/]utils\.ts$/ }, async (args) => {
      const source = await readFile(args.path, "utf8");
      if (!source.includes(originalCreateWorker)) {
        throw new Error("wllama createWorker source changed; review the Firefox static-worker patch");
      }
      return {
        contents: source.replace(originalCreateWorker, staticCreateWorker),
        loader: "ts",
      };
    });
  },
};

const jspiStub = `
if (!WebAssembly.Suspending) {
  WebAssembly.Suspending = function (fn) { return fn; };
  WebAssembly.promising = function (fn) {
    return function (...args) {
      try { return Promise.resolve(fn(...args)); }
      catch (e) { return Promise.reject(e); }
    };
  };
}
`;

const noWebGpuStub =
  'try{Object.defineProperty(WorkerNavigator.prototype,"gpu",{get:()=>({requestAdapter:async()=>null})});}catch(e){}';

async function writeStaticWllamaWorker() {
  const [emscriptenSource, llamaWorkerSource] = await Promise.all([
    readFile("node_modules/@wllama/wllama/src/wasm/wllama.js", "utf8"),
    readFile("node_modules/@wllama/wllama/src/workers-code/llama-cpp.js", "utf8"),
  ]);
  const moduleCode = noWebGpuStub + jspiStub + emscriptenSource;
  const mainModuleCode = moduleCode.replace("var Module", "var ___Module");
  if (mainModuleCode === moduleCode) {
    throw new Error("wllama Emscripten source no longer contains the expected 'var Module' declaration");
  }
  const runOptions =
    `const RUN_OPTIONS={pathConfig:{"wllama.wasm":new URL("./wllama.wasm",self.location.href).href},nbThread:0,compat:false};`;
  const workerSource = [
    runOptions,
    `function wModuleInit(){ ${mainModuleCode}; return Module; }`,
    llamaWorkerSource,
  ].join(";\n\n");
  await writeFile("dist/vendor/wllama/pagelingo-worker.js", workerSource);
}

await Promise.all([
  cp("vendor/bergamot/bergamot-translator.js", "dist/vendor/bergamot/bergamot-translator.js"),
  cp("vendor/bergamot/bergamot-translator-v4.wasm", "dist/vendor/bergamot/bergamot-translator.wasm"),
  cp("vendor/bergamot/LICENSE", "dist/vendor/bergamot/LICENSE"),
  cp("node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm", "dist/vendor/onnxruntime/ort-wasm-simd-threaded.wasm"),
  cp("node_modules/@wllama/wllama/esm/wasm/wllama.wasm", "dist/vendor/wllama/wllama.wasm"),
  cp("node_modules/@wllama/wllama/LICENCE", "dist/vendor/wllama/LICENSE"),
  cp("THIRD_PARTY_NOTICES.md", "dist/THIRD_PARTY_NOTICES.md"),
  cp("LICENSE.md", "dist/LICENSE.md"),
  cp("PRIVACY.md", "dist/PRIVACY.md"),
]);
await writeStaticWllamaWorker();

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
  plugins: [wllamaFirefoxPlugin],
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
