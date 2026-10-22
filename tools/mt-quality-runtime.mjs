import {build} from "esbuild";
import {JSDOM} from "jsdom";
import {mkdir, readFile} from "node:fs/promises";
import {fileURLToPath, pathToFileURL} from "node:url";
import path from "node:path";

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export async function qualityRuntime() {
  const directory = path.join(projectRoot, "artifacts/mt-quality");
  await mkdir(directory, {recursive: true});
  const outfile = path.join(directory, "runtime.mjs");
  await build({stdin: {contents: ["eval/mt-quality/protocol.ts", "src/providers/pagelingo-mt/inference.ts", "src/core/page-translator.ts"]
    .map(file => `export * from ${JSON.stringify("./" + file)};`).join("\n"), resolveDir: projectRoot},
    bundle: true, platform: "node", format: "esm", outfile, logLevel: "silent"});
  return import(pathToFileURL(outfile).href + "?t=" + Date.now());
}
export async function readCases(relativePath) {
  const value = JSON.parse(await readFile(path.resolve(projectRoot, relativePath), "utf8"));
  if (value.schema_version !== 1 || !Array.isArray(value.cases)) throw new Error("Unsupported quality corpus");
  return value.cases;
}
export function fixtureDom(url) {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {url, pretendToBeVisual: true});
  for (const key of ["document", "Node", "Text", "NodeFilter", "DOMParser", "Document", "Element", "HTMLElement", "HTMLAnchorElement", "HTMLInputElement", "MutationObserver", "MouseEvent"])
    globalThis[key] = dom.window[key];
  return dom;
}
