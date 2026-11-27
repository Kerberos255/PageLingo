import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "..");

describe("AMO build readability & provenance guards", () => {
  it("configures esbuild for readable UTF-8 output, preserved legal comments, and unminified ORT", async () => {
    const buildScript = await readFile(resolve(ROOT, "tools/build.mjs"), "utf8");
    expect((buildScript.match(/charset:\s*"utf8"/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect((buildScript.match(/legalComments:\s*"inline"/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(buildScript).not.toContain('legalComments: "none"');
    expect(buildScript).toContain("node_modules/onnxruntime-web/dist/ort.wasm.mjs");
    expect(buildScript).toContain("node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.mjs");
    expect(buildScript).toContain('format: "esm"');
  });

  it("spawns image-ocr-worker.js as a module Worker", async () => {
    const service = await readFile(resolve(ROOT, "src/image-translation/background-service.ts"), "utf8");
    expect(service).toContain('new Worker(browser.runtime.getURL("image-ocr-worker.js"), { type: "module" })');
  });

  it("keeps public/settings.css free of single-line minified CSS blocks", async () => {
    const css = await readFile(resolve(ROOT, "public/settings.css"), "utf8");
    const longLines = css.split(/\r?\n/).filter((line) => line.length > 260);
    expect(longLines).toEqual([]);
  });

  it("declares all runtime-bundled npm packages in package.json dependencies", async () => {
    const pkg = JSON.parse(await readFile(resolve(ROOT, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    expect(pkg.dependencies?.fzstd).toBeTruthy();
    expect(pkg.dependencies?.["onnxruntime-web"]).toBeTruthy();
    expect(pkg.dependencies?.paddleocr).toBeTruthy();
    expect(pkg.dependencies?.["pdfjs-dist"]).toBeTruthy();
    expect(pkg.devDependencies?.fzstd).toBeUndefined();
  });

  it("does not include custom Bilibili WBI key-permutation signing code", async () => {
    const { access } = await import("node:fs/promises");
    await expect(access(resolve(ROOT, "src/video-translation/bilibili-wbi.ts"))).rejects.toThrow();
  });

  it("keeps AMO_REVIEW_NOTES.md within AMO's 3,000-character Notes to Reviewer limit", async () => {
    const notes = await readFile(resolve(ROOT, "AMO_REVIEW_NOTES.md"), "utf8");
    expect(notes.length).toBeLessThanOrEqual(2950);
  });
});
