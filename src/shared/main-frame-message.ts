/** Page controls and language detection belong to the tab's main document.
 * A broadcast can resolve with an unrelated iframe's earlier response.
 * Frame-specific image/context-menu commands use their own explicit frame ID.
 */
export function sendMainFrameMessage<T>(tabId: number, message: unknown): Promise<T> {
  return browser.tabs.sendMessage(tabId, message, {frameId: 0}) as Promise<T>;
}
