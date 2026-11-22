const TRANSIENT_RECEIVER_ERROR = /Receiving end does not exist|Could not establish connection/i;
const RETRY_DELAYS_MS = [50, 150, 300, 600, 1000] as const;

export function isMissingReceiver(error: unknown): boolean {
  return TRANSIENT_RECEIVER_ERROR.test(error instanceof Error ? error.message : String(error));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function sendRuntimeMessage<T>(message: unknown): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await browser.runtime.sendMessage(message) as T;
    } catch (error) {
      const delay = RETRY_DELAYS_MS[attempt];
      if (!isMissingReceiver(error) || delay === undefined) throw error;
      await sleep(delay);
    }
  }
}
