import {
  loadSettings,
  normalizeSitePattern,
  saveAutoTranslateEnabled,
  saveDisplayMode,
  saveExcludedSites,
  saveLanguageRule,
  type DisplayMode,
  type SupportedSourceLanguage,
  type SupportedTargetLanguage,
} from "./shared/settings";

const radios = Array.from(document.querySelectorAll<HTMLInputElement>('input[name="display-mode"]'));
const status = document.querySelector<HTMLElement>("#save-status");
const autoToggle = document.querySelector<HTMLInputElement>("#auto-translate-enabled");
const sourceSelect = document.querySelector<HTMLSelectElement>("#auto-source-language");
const targetSelect = document.querySelector<HTMLSelectElement>("#target-language");
const exceptionInput = document.querySelector<HTMLInputElement>("#exception-site");
const exceptionAdd = document.querySelector<HTMLButtonElement>("#exception-add");
const exceptionList = document.querySelector<HTMLElement>("#exception-list");
let excludedSites: string[] = [];

function setChecked(mode: DisplayMode): void {
  for (const radio of radios) radio.checked = radio.value === mode;
}

function showSaved(message = "已保存"): void {
  if (!status) return;
  status.textContent = message;
  window.setTimeout(() => {
    if (status.textContent === message) status.textContent = "设置会自动保存并立即生效";
  }, 1200);
}

function renderExceptions(): void {
  if (!exceptionList) return;
  exceptionList.replaceChildren();
  if (excludedSites.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "暂无例外网站";
    exceptionList.append(empty);
    return;
  }
  for (const site of excludedSites) {
    const row = document.createElement("div");
    row.className = "exception-item";
    const label = document.createElement("span");
    label.textContent = site;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "移除";
    remove.addEventListener("click", () => {
      excludedSites = excludedSites.filter((item) => item !== site);
      void saveExcludedSites(excludedSites).then(() => {
        renderExceptions();
        showSaved("已移除例外网站");
      });
    });
    row.append(label, remove);
    exceptionList.append(row);
  }
}

async function initialize(): Promise<void> {
  const settings = await loadSettings();
  setChecked(settings.displayMode);
  if (autoToggle) autoToggle.checked = settings.autoTranslateEnabled;
  if (sourceSelect) sourceSelect.value = settings.autoSourceLanguage;
  if (targetSelect) targetSelect.value = settings.targetLanguage;
  excludedSites = [...settings.excludedSites];
  renderExceptions();
}

for (const radio of radios) {
  radio.addEventListener("change", () => {
    if (!radio.checked) return;
    void saveDisplayMode(radio.value as DisplayMode).then(() => showSaved());
  });
}

autoToggle?.addEventListener("change", () => {
  void saveAutoTranslateEnabled(autoToggle.checked).then(() => showSaved());
});

function saveRule(): void {
  if (!sourceSelect || !targetSelect) return;
  void saveLanguageRule(
    sourceSelect.value as SupportedSourceLanguage,
    targetSelect.value as SupportedTargetLanguage,
  ).then(() => showSaved());
}

sourceSelect?.addEventListener("change", saveRule);
targetSelect?.addEventListener("change", saveRule);

function addException(): void {
  if (!exceptionInput) return;
  const site = normalizeSitePattern(exceptionInput.value);
  if (!site) {
    showSaved("网址格式不正确");
    exceptionInput.focus();
    return;
  }
  if (!excludedSites.includes(site)) excludedSites.push(site);
  excludedSites.sort();
  exceptionInput.value = "";
  void saveExcludedSites(excludedSites).then(() => {
    renderExceptions();
    showSaved("已添加例外网站");
  });
}

exceptionAdd?.addEventListener("click", addException);
exceptionInput?.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    addException();
  }
});

void initialize();
