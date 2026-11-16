import type {Wllama} from "@wllama/wllama/esm/index.js";

type ModelRuntime = Pick<Wllama, "loadModel" | "getLoadedContextInfo" | "exit">;

/** wllama 3.6.1 can resolve loadModel after the native loader reports failure.
 * Never infer readiness from promise resolution alone, and release failed workers. */
export async function loadMtModel(
  engine: ModelRuntime,
  blobs: Blob[],
  options: Parameters<Wllama["loadModel"]>[1],
  loadError: () => string = () => "",
): Promise<void> {
  try {
    await engine.loadModel(blobs, options);
    const info = engine.getLoadedContextInfo() as ReturnType<Wllama["getLoadedContextInfo"]> & {success?: boolean};
    if (!info || info.success === false
      || ![info.n_ctx, info.n_vocab, info.n_layer].every(value => Number.isInteger(value) && value > 0)
      || !info.metadata?.["general.architecture"]?.trim()) {
      const detail = loadError().trim().slice(0, 2000);
      throw new Error(`PageLingo MT 模型加载失败：${detail || "未获得有效的模型上下文"}`);
    }
  } catch (error) {
    try { await engine.exit(); } catch {}
    throw error;
  }
}
