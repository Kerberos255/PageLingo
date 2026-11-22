const RESET_IDLE_INTERVAL_MS = 10_000;
const KEY_PREFIX = "pagelingo:keepalive";

function sessionArea(): any {
  return (browser.storage as any)?.session ?? null;
}

export async function keepEventPageAlive<T>(task: Promise<T>, label: string): Promise<T> {
  const session = sessionArea();
  if (!session?.set || !session?.remove) {
    console.warn("[PageLingo] storage.session unavailable; long task keepalive disabled", { label });
    return await task;
  }

  const key = `${KEY_PREFIX}:${label}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
  let sequence = 0;
  let stopped = false;

  const pulse = async () => {
    if (stopped) return;
    try {
      sequence += 1;
      await session.set({ [key]: sequence });
    } catch (error) {
      console.warn("[PageLingo] keepalive pulse failed", { label, error });
    }
  };

  await pulse();
  const interval = setInterval(() => {
    void pulse();
  }, RESET_IDLE_INTERVAL_MS);

  try {
    return await task;
  } finally {
    stopped = true;
    clearInterval(interval);
    try {
      await session.remove(key);
    } catch {}
  }
}

// Registering a storage change listener ensures the keepalive pulse is delivered
// as a WebExtension event in Firefox's MV3 event-page context.
const session = sessionArea();
if (session?.onChanged?.addListener) {
  session.onChanged.addListener(() => {});
}
