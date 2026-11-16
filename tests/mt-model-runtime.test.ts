import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";

const sdk = vi.hoisted(() => ({
  context: {} as any,
  model: null as any,
  load: vi.fn(),
  exit: vi.fn(),
  instances: [] as any[],
}));

vi.mock("@wllama/wllama/esm/index.js", () => ({
  CacheManager: class {},
  ModelManager: class { async getModels() { return [sdk.model]; } },
  ModelValidationStatus: {VALID: "valid"},
  LoggerWithoutDebug: {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()},
  Wllama: class {
    logger: any;
    constructor(_paths: unknown, config: any) { this.logger = config.logger; sdk.instances.push(this); }
    loadModel = vi.fn(async (...args: any[]) => sdk.load(this, ...args));
    getLoadedContextInfo = vi.fn(() => sdk.context);
    getNumThreads = vi.fn(() => 2);
    isModelLoaded = vi.fn(() => true);
    exit = vi.fn(async () => sdk.exit());
    createChatCompletion = vi.fn(async () => ({choices: [{finish_reason: "stop", message: {content: "⟦0⟧阅读这份文档。⟦/0⟧"}}]}));
  },
}));

import {PageLingoMtClient, PAGELINGO_MT_MODEL_SHA256, PAGELINGO_MT_MODEL_SIZE, PAGELINGO_MT_MODEL_URL} from "../src/providers/pagelingo-mt/client";

const healthy = () => ({n_ctx: 3072, n_vocab: 120818, n_layer: 32, metadata: {"general.architecture": "hunyuan-dense"}});
const request = () => ({html: "Read this document.", sourceLanguage: "en", targetLanguage: "zh-Hans"});
let client: PageLingoMtClient;

beforeEach(() => {
  sdk.context = healthy(); sdk.instances.length = 0;
  sdk.load.mockReset(); sdk.load.mockResolvedValue(undefined);
  sdk.exit.mockReset(); sdk.exit.mockResolvedValue(undefined);
  sdk.model = {url: PAGELINGO_MT_MODEL_URL, size: PAGELINGO_MT_MODEL_SIZE,
    files: [{metadata: {sha256: PAGELINGO_MT_MODEL_SHA256}}], validate: () => "valid",
    open: vi.fn(async () => [new Blob(["SDK test fixture, not model weights"])]), remove: vi.fn()};
  vi.stubGlobal("browser", {runtime: {getURL: (path: string) => "moz-extension://test/" + path}});
  vi.stubGlobal("navigator", {hardwareConcurrency: 4});
  client = new PageLingoMtClient();
});
afterEach(async () => { await client.close(); vi.unstubAllGlobals(); });

describe("MT model load readiness and worker ownership", () => {
  it("rejects a resolved native load failure, preserves its cause and keeps the verified cache", async () => {
    sdk.context = {success: false, n_ctx: 0, n_vocab: 0, n_layer: 0, metadata: {}};
    sdk.load.mockImplementation(async engine => engine.logger.error("unknown tokenizer: 'example-tokenizer'"));
    await expect(client.translateHtmlChecked(request())).rejects.toThrow("unknown tokenizer: 'example-tokenizer'");
    expect(sdk.instances[0].createChatCompletion).not.toHaveBeenCalled();
    expect(sdk.instances[0].exit).toHaveBeenCalledOnce();
    expect(sdk.model.remove).not.toHaveBeenCalled();
    expect(await client.status()).toMatchObject({installed: true, valid: true, runtimePhase: "error", actualThreads: 0});
  });

  it("can retry a failed load and becomes ready only with a valid runtime", async () => {
    sdk.context = {success: false, n_ctx: 0, n_vocab: 0, n_layer: 0, metadata: {}};
    await expect(client.translateHtmlChecked(request())).rejects.toThrow("未获得有效");
    sdk.context = healthy();
    expect((await client.translateHtmlChecked(request())).accepted).toBe(true);
    expect(sdk.instances).toHaveLength(2);
    expect(sdk.instances[0].createChatCompletion).not.toHaveBeenCalled();
    expect(sdk.instances[1].loadModel).toHaveBeenCalledWith(expect.any(Array), {n_ctx: 3072, n_threads: 2, n_gpu_layers: 0});
    expect(await client.status()).toMatchObject({runtimePhase: "ready", actualThreads: 2});
    expect((await client.status()).error).toBeUndefined();
    await client.close();
    expect(sdk.instances[1].exit).toHaveBeenCalledOnce();
    expect(await client.status()).toMatchObject({runtimePhase: "idle", actualThreads: 0});
  });

  it("releases a thrown load failure without replacing its original error with an exit error", async () => {
    sdk.load.mockRejectedValue(new Error("model allocation failed"));
    sdk.exit.mockRejectedValue(new Error("worker exit failed"));
    await expect(client.translateHtmlChecked(request())).rejects.toThrow("model allocation failed");
    expect(sdk.instances[0].exit).toHaveBeenCalledOnce();
    expect(sdk.instances[0].createChatCompletion).not.toHaveBeenCalled();
  });

  it.each([
    {n_ctx: 0}, {n_vocab: 0}, {n_layer: 0}, {n_ctx: Number.NaN},
    {metadata: {}}, {success: false},
  ])("rejects incomplete context information: %j", async incomplete => {
    sdk.context = {...healthy(), ...incomplete};
    await expect(client.translateHtmlChecked(request())).rejects.toThrow("未获得有效");
    expect(sdk.instances[0].exit).toHaveBeenCalledOnce();
    expect(sdk.instances[0].createChatCompletion).not.toHaveBeenCalled();
    expect((await client.status()).runtimePhase).toBe("error");
  });

  it("does not resurrect a worker or ready state after close during loading", async () => {
    let release!: () => void;
    sdk.load.mockImplementation(() => new Promise<void>(resolve => { release = resolve; }));
    const pending = client.translateHtmlChecked(request()).catch(error => error);
    await vi.waitFor(() => expect(sdk.load).toHaveBeenCalledOnce());
    await client.close();
    expect((await client.status()).runtimePhase).toBe("idle");
    release();
    expect((await pending).name).toBe("AbortError");
    expect(sdk.instances[0].exit).toHaveBeenCalledOnce();
    expect(sdk.instances[0].createChatCompletion).not.toHaveBeenCalled();
    expect((await client.status()).runtimePhase).toBe("idle");
  });

  it("does not start WASM after close while cached files are opening", async () => {
    let release!: (blobs: Blob[]) => void;
    sdk.model.open.mockImplementation(() => new Promise<Blob[]>(resolve => { release = resolve; }));
    const pending = client.translateHtmlChecked(request()).catch(error => error);
    await vi.waitFor(() => expect(sdk.model.open).toHaveBeenCalledOnce());
    await client.close(); release([new Blob(["fixture"])]);
    expect((await pending).name).toBe("AbortError");
    expect(sdk.instances).toHaveLength(0);
    expect((await client.status()).runtimePhase).toBe("idle");
  });

  it("reuses the validated model for a different paragraph", async () => {
    expect((await client.translateHtmlChecked(request())).accepted).toBe(true);
    expect((await client.translateHtmlChecked({...request(), html: "Open another document."})).accepted).toBe(true);
    expect(sdk.instances).toHaveLength(1);
    expect(sdk.instances[0].loadModel).toHaveBeenCalledOnce();
    expect(sdk.instances[0].createChatCompletion).toHaveBeenCalledTimes(2);
  });
});
