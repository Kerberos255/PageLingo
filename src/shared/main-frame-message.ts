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

export interface FrameMessageResult<T> {
  frameId: number;
  response?: T;
  error?: unknown;
}

/**
 * Discovers visible subframes via MV3 scripting (without requiring webNavigation permission)
 * and sends `message` to frame 0 plus all visible subframes (e.g. webmail reading-pane iframes).
 */
export async function sendAllVisibleFramesMessage<T>(
  tabId: number,
  message: unknown,
): Promise<FrameMessageResult<T>[]> {
  let frameIds = [0];
  try {
    const executeScript = browser.scripting?.executeScript;
    if (typeof executeScript === "function") {
      const results = await executeScript({
        target: { tabId, allFrames: true },
        func: (() => {
          if (window === window.top) return { visible: true, hasText: true };
          const visible = window.innerWidth >= 80 && window.innerHeight >= 40;
          if (!visible || !document.body) return { visible, hasText: false };
          const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
            acceptNode(node) {
              if (node.nodeType === Node.ELEMENT_NODE) {
                const tag = (node as Element).tagName;
                if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT" || tag === "TEMPLATE") {
                  return NodeFilter.FILTER_REJECT;
                }
                return NodeFilter.FILTER_SKIP;
              }
              return /\S/.test((node as Text).data) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
            },
          });
          return { visible, hasText: Boolean(walker.nextNode()) };
        }) as unknown as () => void,
      });
      const discovered = new Set<number>([0]);
      for (const entry of results ?? []) {
        const fid = typeof entry.frameId === "number" ? entry.frameId : -1;
        const val = entry.result as { visible?: boolean; hasText?: boolean } | undefined;
        if (fid > 0 && val?.visible && val?.hasText) {
          discovered.add(fid);
        }
      }
      frameIds = Array.from(discovered);
    }
  } catch {
    frameIds = [0];
  }

  return Promise.all(
    frameIds.map(async (frameId): Promise<FrameMessageResult<T>> => {
      try {
        const response = await sendFrameMessage<T>(tabId, frameId, message);
        return { frameId, response };
      } catch (error) {
        return { frameId, error };
      }
    }),
  );
}
