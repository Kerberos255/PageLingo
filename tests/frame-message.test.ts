import { afterEach, expect, it, vi } from "vitest";
import { sendFrameMessage } from "../src/shared/main-frame-message";

afterEach(() => vi.unstubAllGlobals());

it("loads a missing receiver only in the image's frame and retries the same message", async () => {
  const sendMessage = vi.fn().mockRejectedValueOnce(new Error("Receiving end does not exist"))
    .mockResolvedValueOnce({ok: true});
  const executeScript = vi.fn().mockResolvedValue([]);
  vi.stubGlobal("browser", {tabs: {sendMessage}, scripting: {executeScript}});
  const message = {type: "toggle-image-translation", srcUrl: "https://example.org/image.png"};
  await expect(sendFrameMessage(6, 12, message)).resolves.toEqual({ok: true});
  expect(executeScript).toHaveBeenCalledExactlyOnceWith({
    target: {tabId: 6, frameIds: [12]}, files: ["builtin-glossary.js", "content.js"], injectImmediately: true,
  });
  expect(sendMessage.mock.calls).toEqual([[6, message, {frameId: 12}], [6, message, {frameId: 12}]]);
});
