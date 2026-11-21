import { sendRuntimeMessage } from "./shared/runtime-message";
import { requestExternalAuthenticationConsent, requestExternalTranslationConsent } from "./shared/data-consent";
import {
  LOCAL_TRANSLATION_ENGINE_ID,
  PAGELINGO_MT_ENGINE_ID,
  NATIVE_MT_ENGINE_ID,
  NATIVE_MT_MESSAGING_PERMISSION,
  OPENCODE_GO_BASE_URL,
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

interface ModelInfo {
  id: string;
  name?: string | undefined;
  ownedBy?: string | undefined;
  contextWindow?: number | undefined;
  maxOutputTokens?: number | undefined;
}

interface EngineResponse {
  ok?: boolean;
  state?: EngineUiState;
  preview?: string;
  models?: ModelInfo[];
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

type AddableEngineType = Exclude<ExternalTranslationEngineType, "pagelingo-mt-native">;
const PRESETS: Record<AddableEngineType, EnginePreset> = {
  microsoft: { name: "Microsoft Translator", baseUrl: "https://api.cognitive.microsofttranslator.com" },
  google: { name: "Google Cloud Translation", baseUrl: "https://translation.googleapis.com/language/translate/v2" },
  deepl: { name: "DeepL API", baseUrl: "https://api.deepl.com/v2" },
  gemini: { name: "Gemini API", baseUrl: "https://generativelanguage.googleapis.com/v1beta", model: "gemini-3.8-flash" },
  openrouter: { name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", model: "openrouter/free" },
  "opencode-go": { name: "OpenCode Go", baseUrl: OPENCODE_GO_BASE_URL, model: "deepseek-v4.1-flash" },
  deepseek: { name: "DeepSeek", baseUrl: "https://api.deepseek.com", model: "deepseek-flash" },
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
  "opencode-go": "OpenCode Go",
  deepseek: "DeepSeek",
  "openai-compatible": "OpenAI Compatible",
  "pagelingo-mt-native": "本机加速（旧配置）",
  libretranslate: "LibreTranslate",
  "custom-rest": "自定义 REST",
};

const activeSelect = document.querySelector<HTMLSelectElement>("#active-engine-select");
const nativeMtStatus = document.querySelector<HTMLElement>("#native-mt-status");
const nativeMtButton = document.querySelector<HTMLButtonElement>("#connect-native-mt");
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
const getModelsButton = document.querySelector<HTMLButtonElement>("#get-engine-models");
const modelPickerDialog = document.querySelector<HTMLDialogElement>("#model-picker-dialog");
const modelPickerCount = document.querySelector<HTMLElement>("#model-picker-count");
const modelPickerSearch = document.querySelector<HTMLInputElement>("#model-picker-search");
const modelPickerList = document.querySelector<HTMLElement>("#model-picker-list");
const modelPickerEmpty = document.querySelector<HTMLElement>("#model-picker-empty");
const refreshModelPickerButton = document.querySelector<HTMLButtonElement>("#refresh-model-picker");
const cancelModelPickerButton = document.querySelector<HTMLButtonElement>("#cancel-model-picker");
const closeModelPickerButton = document.querySelector<HTMLButtonElement>("#close-model-picker");
const selectModelPickerButton = document.querySelector<HTMLButtonElement>("#select-model-picker");

let engineState: EngineUiState = { activeEngineId: LOCAL_TRANSLATION_ENGINE_ID, engines: [] };
let nativeMtReady = false;
let nativeMtStatusCheck = 0;
let connectingNativeMt = false;
let modelPickerModels: ModelInfo[] = [];
let selectedPickerModel = "";
let modelPickerLoading = false;
let modelPickerError = "";

function notify(message: string, timeout = 2200): void {
  if (!saveStatus) return;
  saveStatus.textContent = message;
  window.setTimeout(() => {
    if (saveStatus.textContent === message) saveStatus.textContent = "设置会自动保存并立即生效";
  }, timeout);
}

function currentType(): AddableEngineType {
  const value = typeSelect?.value as AddableEngineType | undefined;
  return value && Object.hasOwn(PRESETS, value) ? value : "microsoft";
}

function supportsModelDiscovery(type: ExternalTranslationEngineType): boolean {
  return type === "openrouter" || type === "opencode-go" || type === "deepseek" || type === "openai-compatible";
}

function updateConditionalFields(): void {
  const type = currentType();
  const llm = type === "gemini" || type === "openrouter" || type === "opencode-go" || type === "deepseek" || type === "openai-compatible";
  for (const field of conditionalFields) {
    const kind = field.dataset.engineField;
    const visible = kind === "model" ? llm || type === "custom-rest"
      : kind === "prompt" ? llm
        : kind === "region" ? type === "microsoft"
          : kind === "custom" ? type === "custom-rest"
            : true;
    field.hidden = !visible;
  }
  if (getModelsButton) getModelsButton.hidden = !supportsModelDiscovery(type);
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
  const apiKey = apiKeyInput?.value.trim() ?? "";
  return {
    id: `engine-${crypto.randomUUID()}`,
    name,
    type,
    enabled: true,
    baseUrl: baseUrlInput?.value.trim() ?? "",
    apiKey,
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
  local.textContent = "Firefox 本地翻译";
  activeSelect.append(local);
  const mt = document.createElement("option");
  mt.value = PAGELINGO_MT_ENGINE_ID;
  mt.textContent = engineState.mt?.installed
    ? "PageLingo MT · 本地 1.8B"
    : "PageLingo MT · 未下载";
  mt.disabled = engineState.mt?.installed !== true;
  activeSelect.append(mt);
  const native = document.createElement("option");
  native.value = NATIVE_MT_ENGINE_ID;
  native.textContent = "PageLingo MT · 本机加速";
  activeSelect.append(native);
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
    const native = engine.type === "pagelingo-mt-native";
    const model = !native && engine.model ? ` · ${engine.model}` : "";
    const keyState = engine.hasApiKey ? (native ? " · 已设置连接码" : " · Key 已配置") : "";
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
  renderNativeMtButton();
}

function renderNativeMtButton(): void {
  if (!nativeMtButton) return;
  const using = nativeMtReady && engineState.activeEngineId === NATIVE_MT_ENGINE_ID;
  nativeMtButton.disabled = connectingNativeMt || using;
  nativeMtButton.textContent = connectingNativeMt ? "正在连接…" : using ? "使用中" : nativeMtReady ? "使用" : "连接";
}

function showNativeMtStatus(ready: boolean, message: string): void {
  nativeMtReady = ready;
  if (nativeMtStatus) nativeMtStatus.textContent = message;
  renderNativeMtButton();
}

async function refreshNativeMtStatus(): Promise<void> {
  if (connectingNativeMt) return;
  const check = ++nativeMtStatusCheck;
  if (!await browser.permissions.contains(NATIVE_MT_MESSAGING_PERMISSION)) {
    if (check === nativeMtStatusCheck) showNativeMtStatus(false, "启动本机组件后连接。");
    return;
  }
  const reply = await sendRuntimeMessage<EngineResponse>({ type: "get-native-mt-status" });
  if (check !== nativeMtStatusCheck) return;
  showNativeMtStatus(reply?.ok === true, reply?.ok ? "已连接本机服务" : reply?.error ?? "暂时无法连接本机服务");
}

async function requestState(message: Record<string, unknown>): Promise<void> {
  const response = await sendRuntimeMessage<EngineResponse>(message);
  if (!response?.ok || !response.state) throw new Error(response?.error ?? "翻译引擎操作失败");
  applyState(response.state);
}

async function setActive(id: string): Promise<void> {
  const native = id === NATIVE_MT_ENGINE_ID;
  if (native && connectingNativeMt) return;
  try {
    if (native) {
      connectingNativeMt = true;
      nativeMtStatusCheck += 1;
      renderNativeMtButton();
      if (!await browser.permissions.request(NATIVE_MT_MESSAGING_PERMISSION)) throw new Error("需要授权 Firefox 连接本机加速组件");
    } else if (id !== LOCAL_TRANSLATION_ENGINE_ID && id !== PAGELINGO_MT_ENGINE_ID) {
      const engine = engineState.engines.find((item) => item.id === id);
      if (!engine) throw new Error("找不到翻译引擎");
      const granted = await requestExternalTranslationConsent(engine.hasApiKey);
      if (!granted) throw new Error("未授权向外部翻译服务发送网页内容");
    }
    await requestState({ type: "set-active-translation-engine", id });
    if (native) showNativeMtStatus(true, "已连接本机服务");
    notify(native ? "已启用本机加速" : id === LOCAL_TRANSLATION_ENGINE_ID
      ? "已切换到 Firefox 本地翻译"
      : id === PAGELINGO_MT_ENGINE_ID
        ? "已切换到 PageLingo MT"
        : "翻译引擎已切换");
  } catch (error) {
    renderActiveSelect();
    const message = error instanceof Error ? error.message : String(error);
    if (native) showNativeMtStatus(false, message);
    else notify(message, 5000);
  } finally {
    if (native) {
      connectingNativeMt = false;
      renderNativeMtButton();
    }
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


function renderModelPicker(): void {
  if (!modelPickerList || !modelPickerCount || !modelPickerEmpty || !selectModelPickerButton) return;
  const query = modelPickerSearch?.value.trim().toLocaleLowerCase() ?? "";
  const filtered = query
    ? modelPickerModels.filter((model) => model.id.toLocaleLowerCase().includes(query) || model.ownedBy?.toLocaleLowerCase().includes(query))
    : modelPickerModels;

  modelPickerCount.textContent = modelPickerLoading
    ? "正在获取模型…"
    : modelPickerError
      ? "获取失败"
      : query
        ? `已加载 ${modelPickerModels.length} 个 · 显示 ${filtered.length} 个`
        : `已加载 ${modelPickerModels.length} 个`;
  modelPickerList.replaceChildren();

  for (const model of filtered) {
    const row = document.createElement("label");
    row.className = `model-picker-item${selectedPickerModel === model.id ? " selected" : ""}`;
    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = "pagelingo-model-picker";
    radio.value = model.id;
    radio.checked = selectedPickerModel === model.id;
    const copy = document.createElement("span");
    copy.className = "model-picker-item-copy";
    const title = document.createElement("strong");
    title.textContent = model.name || model.id;
    const idLine = document.createElement("small");
    idLine.textContent = model.name && model.name !== model.id ? model.id : (model.ownedBy ? `提供方：${model.ownedBy}` : "可用模型");
    copy.append(title, idLine);
    if (model.contextWindow || model.maxOutputTokens) {
      const details = document.createElement("small");
      const parts: string[] = [];
      if (model.contextWindow) parts.push(`上下文 ${model.contextWindow.toLocaleString()}`);
      if (model.maxOutputTokens) parts.push(`最大输出 ${model.maxOutputTokens.toLocaleString()}`);
      details.textContent = parts.join(" · ");
      copy.append(details);
    }
    row.append(radio, copy);
    if (model.id === modelInput?.value.trim()) {
      const current = document.createElement("span");
      current.className = "model-picker-current";
      current.textContent = "当前";
      row.append(current);
    }
    radio.addEventListener("change", () => {
      selectedPickerModel = model.id;
      renderModelPicker();
    });
    modelPickerList.append(row);
  }

  modelPickerEmpty.hidden = modelPickerLoading || filtered.length > 0;
  if (!modelPickerLoading && filtered.length === 0) {
    modelPickerEmpty.textContent = modelPickerError || (query ? "没有匹配的模型" : "没有可用模型");
  }
  selectModelPickerButton.disabled = !selectedPickerModel;
  if (refreshModelPickerButton) refreshModelPickerButton.disabled = modelPickerLoading;
}

async function loadModelPickerModels(): Promise<void> {
  if (!modelPickerDialog) return;
  modelPickerLoading = true;
  modelPickerError = "";
  modelPickerModels = [];
  selectedPickerModel = modelInput?.value.trim() ?? "";
  if (modelPickerSearch) modelPickerSearch.value = "";
  renderModelPicker();
  try {
    const config = collectConfig();
    if (!supportsModelDiscovery(config.type)) throw new Error("当前类型不支持自动获取模型");
    if (config.apiKey) {
      const granted = await requestExternalAuthenticationConsent();
      if (!granted) throw new Error("未授权向模型服务发送 API Key");
    }
    const response = await sendRuntimeMessage<EngineResponse>({ type: "list-translation-models", config });
    if (!response?.ok || !Array.isArray(response.models)) throw new Error(response?.error ?? "获取模型失败");
    modelPickerModels = response.models;
    if (!modelPickerModels.some((model) => model.id === selectedPickerModel)) selectedPickerModel = "";
  } catch (error) {
    modelPickerModels = [];
    modelPickerError = error instanceof Error ? error.message : String(error);
  } finally {
    modelPickerLoading = false;
    renderModelPicker();
  }
}

function openModelPicker(): void {
  if (!modelPickerDialog || !supportsModelDiscovery(currentType())) return;
  if (!modelPickerDialog.open) modelPickerDialog.showModal();
  void loadModelPickerModels();
}

function closeModelPicker(): void {
  modelPickerDialog?.close();
}

function chooseModelPicker(): void {
  if (!selectedPickerModel || !modelInput) return;
  modelInput.value = selectedPickerModel;
  closeModelPicker();
  notify(`已选择模型 · ${selectedPickerModel}`);
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
  getModelsButton?.addEventListener("click", openModelPicker);
  refreshModelPickerButton?.addEventListener("click", () => void loadModelPickerModels());
  cancelModelPickerButton?.addEventListener("click", closeModelPicker);
  closeModelPickerButton?.addEventListener("click", closeModelPicker);
  selectModelPickerButton?.addEventListener("click", chooseModelPicker);
  modelPickerSearch?.addEventListener("input", renderModelPicker);
  modelPickerDialog?.addEventListener("click", (event) => {
    if (event.target === modelPickerDialog) closeModelPicker();
  });
  activeSelect?.addEventListener("change", () => void setActive(activeSelect.value));
  nativeMtButton?.addEventListener("click", () => void setActive(NATIVE_MT_ENGINE_ID));
  testButton?.addEventListener("click", () => void testConfig());
  addButton?.addEventListener("click", () => void addConfig());
  window.addEventListener("pagelingo-mt-changed", () => void refreshTranslationEngines().catch((error) => notify(error instanceof Error ? error.message : String(error), 5000)));
  applyPreset();
  await refreshTranslationEngines();
  const detectNativeMt = () => void refreshNativeMtStatus().catch(() => showNativeMtStatus(false, "暂时无法连接本机服务"));
  window.addEventListener("focus", detectNativeMt);
  detectNativeMt();
}
