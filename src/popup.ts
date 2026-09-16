const statusEl = document.querySelector<HTMLElement>("#status");
const translate = document.querySelector<HTMLButtonElement>("#translate");
const restore = document.querySelector<HTMLButtonElement>("#restore");

async function activeTabId(): Promise<number> {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("找不到当前标签页");
  return tab.id;
}

async function send(type: "translate-page" | "restore-page"): Promise<void> {
  if (statusEl) statusEl.textContent = type === "translate-page" ? "翻译中…" : "恢复中…";
  try {
    const id = await activeTabId();
    const response = await browser.tabs.sendMessage(id, { type }) as { ok?: boolean; count?: number };
    if (statusEl) {
      statusEl.textContent = type === "translate-page"
        ? `完成：${response?.count ?? 0} 个段落`
        : "已恢复原文";
    }
  } catch (error) {
    if (statusEl) statusEl.textContent = error instanceof Error ? error.message : String(error);
  }
}

translate?.addEventListener("click", () => void send("translate-page"));
restore?.addEventListener("click", () => void send("restore-page"));
