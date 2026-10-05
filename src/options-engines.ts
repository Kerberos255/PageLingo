import { sendRuntimeMessage } from "./shared/runtime-message";
import { requestExternalTranslationConsent } from "./shared/data-consent";
import {
  LOCAL_TRANSLATION_ENGINE_ID,
  PAGELINGO_MT_ENGINE_ID,
  type ExternalTranslationEngineType,
  type TranslationEngineConfig,
} from "./shared/translation-engine-settings";

interface EngineView {
  id: string;
  name: string;
  type: ExternalTranslationEngineType;
  enabled: boolean;
  model: string;
  hasApiKey: boolean;
}

interface EngineUiState {
  activeEngineId: string;
  engines: EngineView[];
  mt?: {
    installed?: boolean;
    downloading?: boolean;
    modelBytes?: number;
  };
}

interface EngineResponse {
  ok?: boolean;
  state?: EngineUiState;
  preview?: string;
  error?: string;
}

interface EnginePreset {
  name: string;
  baseUrl: string;
  model?: string;
  bodyJson?: string;
  headersJson?: string;
  responsePath?: string;
}

const PRESETS: Record<ExternalTranslationEngineType, EnginePreset> = {
  microsoft: { name: "Microsoft Translator", baseUrl: "https://api.cognitive.microsofttranslator.com" },
  google: { name: "Google Cloud Translation", baseUrl: "https://translation.googleapis.com/language/translate/v2" },
  deepl: { name: "DeepL API", baseUrl: "https://api.deepl.com/v2" },
  gemini: { name: "Gemini API", baseUrl: "https://generativelanguage.googleapis.com/v1beta", model: "gemini-3.8-flash" },
  openrouter: { name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", model: "openrouter/free" },
  "openai-compatible": { name: "OpenAI Compatible", baseUrl: "", model: "" },
  libretranslate: { name: "LibreTranslate", baseUrl: "https://libretranslate.com" },
  "custom-rest": {
    name: "Custom REST",
    baseUrl: "",
    headersJson: "{\n  \"Authorization\": \"Bearer {{apiKey}}\"\n}",
    bodyJson: "{\n  \"text\": \"{{html}}\",\n  \"source\": \"{{source}}\",\n  \"target\": \"{{target}}\"\n}",
    responsePath: "data.translatedText",
  },
};

const TYPE_LABELS: Record<ExternalTranslationEngineType, string> = {
  microsoft: "Microsoft Translator",
  google: "Google Cloud Translation",
  deepl: "DeepL API",
  gemini: "Gemini API",
  openrouter: "OpenRouter",
  "openai-compatible": "OpenAI Compatible",
  libretranslate: "LibreTranslate",
  "custom-rest": "自定义 REST",
};

const activeSelect = document.querySelector<HTMLSelectElement>("#active-engine-select");
const engineList = document.querySelector<HTMLElement>("#translation-engine-list");
const typeSelect = document.querySelector<HTMLSelectElement>("#engine-type");
const nameInput = document.querySelector<HTMLInputElement>("#engine-name");
const baseUrlInput = document.querySelector<HTMLInputElement>("#engine-base-url");
const apiKeyInput = document.querySelector<HTMLInputElement>("#engine-api-key");
const modelInput = document.querySelector<HTMLInputElement>("#engine-model");
const regionInput = document.querySelector<HTMLInputElement>("#engine-region");
const promptInput = document.querySelector<HTMLTextAreaElement>("#engine-prompt");
const headersInput = document.querySelector<HTMLTextAreaElement>("#engine-headers-json");
const bodyInput = document.querySelector<HTMLTextAreaElement>("#engine-body-json");
const responsePathInput = document.querySelector<HTMLInputElement>("#engine-response-path");
const testButton = document.querySelector<HTMLButtonElement>("#test-translation-engine");
const addButton = document.querySelector<HTMLButtonElement>("#add-translation-engine");
const conditionalFields = Array.from(document.querySelectorAll<HTMLElement>("[data-engine-field]"));
const saveStatus = document.querySelector<HTMLElement>("#save-status");

let engineState: EngineUiState = { activeEngineId: LOCAL_TRANSLATION_ENGINE_ID, engines: [] };

function notify(message: string, timeout = 2200): void {
  if (!saveStatus) return;
  saveStatus.textContent = message;
  window.setTimeout(() => {
    if (saveStatus.textContent === message) saveStatus.textContent = "设置会自动保存并立即生效";
  }, timeout);
}

function currentType(): ExternalTranslationEngineType {
  const value = typeSelect?.value as ExternalTranslationEngineType | undefined;
  return value && value in PRESETS ? value : "microsoft";
}

function updateConditionalFields(): void {
  const type = currentType();
  const llm = type === "gemini" || type === "openrouter" || type === "openai-compatible";
  for (const field of conditionalFields) {
    const kind = field.dataset.engineField;
    const visible = kind === "model" ? llm || type === "custom-rest"
      : kind === "prompt" ? llm
        : kind === "region" ? type === "microsoft"
          : kind === "custom" ? type === "custom-rest"
            : true;
    field.hidden = !visible;
  }
}

function applyPreset(): void {
  const preset = PRESETS[currentType()];
  if (nameInput) nameInput.value = preset.name;
  if (baseUrlInput) baseUrlInput.value = preset.baseUrl;
  if (modelInput) modelInput.value = preset.model ?? "";
  if (regionInput) regionInput.value = "";
  if (promptInput) promptInput.value = "";
  if (headersInput) headersInput.value = preset.headersJson ?? "";
  if (bodyInput) bodyInput.value = preset.bodyJson ?? "";
  if (responsePathInput) responsePathInput.value = preset.responsePath ?? "";
  if (apiKeyInput) apiKeyInput.value = "";
  updateConditionalFields();
}

function collectConfig(): TranslationEngineConfig {
  const name = nameInput?.value.trim() ?? "";
  if (!name) throw new Error("请填写引擎名称");
  const type = currentType();
  return {
    id: `engine-${crypto.randomUUID()}`,
    name,
    type,
    enabled: true,
    baseUrl: baseUrlInput?.value.trim() ?? "",
    apiKey: apiKeyInput?.value.trim() ?? "",
    model: modelInput?.value.trim() ?? "",
    region: regionInput?.value.trim() ?? "",
    prompt: promptInput?.value.trim() ?? "",
    headersJson: headersInput?.value.trim() ?? "",
    bodyJson: bodyInput?.value.trim() ?? "",
    responsePath: responsePathInput?.value.trim() ?? "",
  };
}

function renderActiveSelect(): void {
  if (!activeSelect) return;
  activeSelect.replaceChildren();
  const local = document.createElement("option");
  local.value = LOCAL_TRANSLATION_ENGINE_ID;
  local.textContent = "Firefox 本地 · Bergamot WASM";
  activeSelect.append(local);
  const mt = document.createElement("option");
  mt.value = PAGELINGO_MT_ENGINE_ID;
  mt.textContent = engineState.mt?.installed
    ? "PageLingo MT · 本地 1.8B"
    : "PageLingo MT · 未下载";
  mt.disabled = engineState.mt?.installed !== true;
  activeSelect.append(mt);
  for (const engine of engineState.engines.filter((item) => item.enabled)) {
    const option = document.createElement("option");
    option.value = engine.id;
    option.textContent = `${engine.name} · ${TYPE_LABELS[engine.type]}`;
    activeSelect.append(option);
  }
  activeSelect.value = engineState.activeEngineId;
  if (activeSelect.value !== engineState.activeEngineId) activeSelect.value = LOCAL_TRANSLATION_ENGINE_ID;
}

function renderEngineList(): void {
  if (!engineList) return;
  engineList.replaceChildren();
  if (engineState.engines.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "暂无外部翻译引擎";
    engineList.append(empty);
    return;
  }
  for (const engine of engineState.engines) {
    const row = document.createElement("div");
    row.className = "engine-item";
    const copy = document.createElement("div");
    copy.className = "engine-copy";
    const title = document.createElement("strong");
    title.textContent = engine.name;
    const detail = document.createElement("small");
    const model = engine.model ? ` · ${engine.model}` : "";
    const keyState = engine.hasApiKey ? " · Key 已配置" : "";
    detail.textContent = `${TYPE_LABELS[engine.type]}${model}${keyState}`;
    copy.append(title, detail);

    const badge = document.createElement("span");
    badge.className = `engine-state ${engine.enabled ? "enabled" : ""}`;
    badge.textContent = engineState.activeEngineId === engine.id ? "当前" : engine.enabled ? "已启用" : "已停用";

    const actions = document.createElement("div");
    actions.className = "engine-actions";
    if (engine.enabled && engineState.activeEngineId !== engine.id) {
      const use = document.createElement("button");
      use.type = "button";
      use.textContent = "使用";
      use.addEventListener("click", () => void setActive(engine.id));
      actions.append(use);
    } else if (engine.enabled && engineState.activeEngineId === engine.id) {
      const consent = document.createElement("button");
      consent.type = "button";
      consent.textContent = "数据权限";
      consent.title = "查看或重新请求此外部引擎所需的数据传输权限";
      consent.addEventListener("click", () => void requestExternalTranslationConsent(engine.hasApiKey)
        .then((granted) => notify(granted ? "外部翻译数据权限已授权" : "未授予外部翻译数据权限", 5000))
        .catch((error) => notify(error instanceof Error ? error.message : String(error), 5000)));
      actions.append(consent);
    }
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.textContent = engine.enabled ? "停用" : "启用";
    toggle.addEventListener("click", () => void setEnabled(engine.id, !engine.enabled));
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "danger";
    remove.textContent = "删除";
    remove.addEventListener("click", () => void removeEngine(engine.id));
    actions.append(toggle, remove);
    row.append(copy, badge, actions);
    engineList.append(row);
  }
}

function applyState(state: EngineUiState): void {
  engineState = state;
  renderActiveSelect();
  renderEngineList();
}

async function requestState(message: Record<string, unknown>): Promise<void> {
  const response = await sendRuntimeMessage<EngineResponse>(message);
  if (!response?.ok || !response.state) throw new Error(response?.error ?? "翻译引擎操作失败");
  applyState(response.state);
}

async function setActive(id: string): Promise<void> {
  try {
    if (id !== LOCAL_TRANSLATION_ENGINE_ID && id !== PAGELINGO_MT_ENGINE_ID) {
      const engine = engineState.engines.find((item) => item.id === id);
      if (!engine) throw new Error("找不到翻译引擎");
      const granted = await requestExternalTranslationConsent(engine.hasApiKey);
      if (!granted) {
        renderActiveSelect();
        throw new Error("未授权向外部翻译服务发送网页内容");
      }
    }
    await requestState({ type: "set-active-translation-engine", id });
    notify(id === LOCAL_TRANSLATION_ENGINE_ID
      ? "已切换到 Firefox 本地翻译"
      : id === PAGELINGO_MT_ENGINE_ID
        ? "已切换到 PageLingo MT"
        : "翻译引擎已切换");
  } catch (error) {
    notify(error instanceof Error ? error.message : String(error), 5000);
  }
}

async function setEnabled(id: string, enabled: boolean): Promise<void> {
  try {
    await requestState({ type: "set-translation-engine-enabled", id, enabled });
    notify(enabled ? "翻译引擎已启用" : "翻译引擎已停用");
  } catch (error) {
    notify(error instanceof Error ? error.message : String(error), 5000);
  }
}

async function removeEngine(id: string): Promise<void> {
  try {
    await requestState({ type: "delete-translation-engine", id });
    notify("翻译引擎已删除");
  } catch (error) {
    notify(error instanceof Error ? error.message : String(error), 5000);
  }
}

async function testConfig(): Promise<void> {
  if (!testButton) return;
  testButton.disabled = true;
  testButton.textContent = "测试中…";
  try {
    const config = collectConfig();
    const granted = await requestExternalTranslationConsent(Boolean(config.apiKey));
    if (!granted) throw new Error("未授权向外部翻译服务发送测试内容");
    const response = await sendRuntimeMessage<EngineResponse>({ type: "test-translation-engine", config });
    if (!response?.ok) throw new Error(response?.error ?? "连接测试失败");
    notify(`测试成功 · ${response.preview ?? "翻译服务可用"}`, 5000);
  } catch (error) {
    notify(error instanceof Error ? error.message : String(error), 6000);
  } finally {
    testButton.disabled = false;
    testButton.textContent = "测试连接";
  }
}

async function addConfig(): Promise<void> {
  if (!addButton) return;
  addButton.disabled = true;
  addButton.textContent = "添加中…";
  try {
    const config = collectConfig();
    await requestState({ type: "save-translation-engine", config });
    if (apiKeyInput) apiKeyInput.value = "";
    notify(`${config.name} 已添加`);
  } catch (error) {
    notify(error instanceof Error ? error.message : String(error), 6000);
  } finally {
    addButton.disabled = false;
    addButton.textContent = "添加引擎";
  }
}

async function refreshTranslationEngines(): Promise<void> {
  const response = await sendRuntimeMessage<EngineResponse>({ type: "get-translation-engines" });
  if (!response?.ok || !response.state) throw new Error(response?.error ?? "无法读取翻译引擎");
  applyState(response.state);
}

export async function initializeTranslationEngines(): Promise<void> {
  typeSelect?.addEventListener("change", applyPreset);
  activeSelect?.addEventListener("change", () => void setActive(activeSelect.value));
  testButton?.addEventListener("click", () => void testConfig());
  addButton?.addEventListener("click", () => void addConfig());
  window.addEventListener("pagelingo-mt-changed", () => void refreshTranslationEngines().catch((error) => notify(error instanceof Error ? error.message : String(error), 5000)));
  applyPreset();
  await refreshTranslationEngines();
}
