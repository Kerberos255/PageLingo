import { isMissingReceiver } from "./runtime-message";

const pendingInjections = new Map<string, Promise<unknown>>();

export async function sendFrameMessage<T>(tabId: number, frameId: number, message: unknown): Promise<T> {
  const send = () => browser.tabs.sendMessage(tabId, message, {frameId}) as Promise<T>;
  try {
    return await send();
  } catch (error) {
    if (!isMissingReceiver(error)) throw error;
  }
  // Pages opened before the add-on was enabled can lack its content script.
  const key = `${tabId}:${frameId}`;
  const injection = pendingInjections.get(key) ?? browser.scripting.executeScript({
    target: {tabId, frameIds: [frameId]}, files: ["builtin-glossary.js", "content.js"], injectImmediately: true,
  });
  pendingInjections.set(key, injection);
  try {
    await injection;
  } catch {
    throw new Error("Firefox 无法在当前页面加载 PageLingo");
  } finally {
    if (pendingInjections.get(key) === injection) pendingInjections.delete(key);
  }
  try {
    return await send();
  } catch (error) {
    if (isMissingReceiver(error)) throw new Error("PageLingo 无法连接当前页面，请刷新后重试");
    throw error;
  }
}

export function sendMainFrameMessage<T>(tabId: number, message: unknown): Promise<T> {
  return sendFrameMessage(tabId, 0, message);
}
