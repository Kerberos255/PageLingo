import { build } from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";

await rm("dist", { recursive: true, force: true });
await mkdir("dist", { recursive: true });
await cp("public", "dist", { recursive: true });
await mkdir("dist/vendor/bergamot", { recursive: true });
await Promise.all([
  cp("vendor/bergamot/bergamot-translator.js", "dist/vendor/bergamot/bergamot-translator.js"),
  cp("vendor/bergamot/bergamot-translator-v4.wasm", "dist/vendor/bergamot/bergamot-translator.wasm"),
  cp("vendor/bergamot/LICENSE", "dist/vendor/bergamot/LICENSE"),
  cp("THIRD_PARTY_NOTICES.md", "dist/THIRD_PARTY_NOTICES.md"),
]);

await build({
  entryPoints: {
    background: "src/background.ts",
    content: "src/content.ts",
    popup: "src/popup.ts",
    "bergamot-worker": "src/workers/bergamot-worker.ts",
  },
  bundle: true,
  format: "iife",
  target: ["firefox128"],
  outdir: "dist",
  sourcemap: false,
  minify: false,
  legalComments: "none",
});
