// Exact short-term UI label mapping and CJK punctuation normalization for image translation.

const UI_SHORT_TERM_MAP: Readonly<Record<string, readonly [zhHans: string, zhHant: string]>> = {
  // Single-word high-frequency UI buttons & labels
  open: ["打开", "開啟"],
  cancel: ["取消", "取消"],
  close: ["关闭", "關閉"],
  allow: ["允许", "允許"],
  deny: ["拒绝", "拒絕"],
  continue: ["继续", "繼續"],
  back: ["返回", "返回"],
  next: ["下一步", "下一步"],
  done: ["完成", "完成"],
  ok: ["确定", "確定"],
  confirm: ["确认", "確認"],
  apply: ["应用", "套用"],
  save: ["保存", "儲存"],
  delete: ["删除", "刪除"],
  remove: ["移除", "移除"],
  settings: ["设置", "設定"],
  skip: ["跳过", "略過"],
  retry: ["重试", "重試"],
  install: ["安装", "安裝"],
  update: ["更新", "更新"],
  download: ["下载", "下載"],
  upload: ["上传", "上傳"],
  edit: ["编辑", "編輯"],
  copy: ["复制", "複製"],
  paste: ["粘贴", "貼上"],
  search: ["搜索", "搜尋"],
  refresh: ["刷新", "重新整理"],
  reload: ["重新加载", "重新載入"],
  reset: ["重置", "重設"],
  dismiss: ["忽略", "略過"],
  accept: ["接受", "接受"],
  decline: ["拒绝", "拒絕"],
  enable: ["启用", "啟用"],
  disable: ["停用", "停用"],
  submit: ["提交", "提交"],
  send: ["发送", "傳送"],
  share: ["分享", "分享"],
  more: ["更多", "更多"],
  help: ["帮助", "說明"],
  yes: ["是", "是"],
  no: ["否", "否"],
  // Two-word high-frequency UI buttons & actions
  "sign in": ["登录", "登入"],
  "log in": ["登录", "登入"],
  "sign out": ["退出登录", "登出"],
  "log out": ["退出登录", "登出"],
  "sign up": ["注册", "註冊"],
  "learn more": ["了解更多", "瞭解更多"],
  "try again": ["重试", "重試"],
  "get started": ["开始使用", "開始使用"],
  "not now": ["暂不", "暫時不要"],
  "got it": ["知道了", "知道了"],
  "allow once": ["仅允许一次", "僅允許一次"],
  "always allow": ["始终允许", "始終允許"],
  "don't allow": ["不允许", "不允許"],
  "dont allow": ["不允许", "不允許"],
  "show more": ["展开更多", "顯示更多"],
  "show less": ["收起", "顯示較少"],
  "view all": ["查看全部", "檢視全部"],
  "copy link": ["复制链接", "複製連結"],
  "save changes": ["保存更改", "儲存變更"],
  "open settings": ["打开设置", "開啟設定"],
};

const CJK_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
const HALF_TO_FULL_PUNCT: Readonly<Record<string, string>> = {
  ",": "，",
  "?": "？",
  "!": "！",
  ";": "；",
  ":": "：",
};

/**
 * Exact-match mapping for standalone short English UI labels/buttons inside images.
 * Only triggers when the entire OCR block (stripped of outer punctuation/whitespace)
 * has at most 2 English words and matches the dictionary case-insensitively.
 */
export function matchImageUiShortTerm(text: string, targetLanguage: string): string | null {
  const normalizedTarget = String(targetLanguage || "").toLowerCase();
  const isTraditional = normalizedTarget === "zh-hant" || normalizedTarget === "zh-tw" || normalizedTarget === "zh-hk";
  const isChinese = isTraditional || normalizedTarget === "zh-hans" || normalizedTarget === "zh" || normalizedTarget === "zh-cn";
  if (!isChinese) return null;

  const trimmed = String(text ?? "").normalize("NFKC").trim();
  if (!trimmed || trimmed.includes("\n")) return null;

  const hasEllipsis = /(?:\.{3}|…)\s*$/u.test(trimmed);
  // Strip outer decorative punctuation/symbols while keeping internal apostrophes/spaces.
  const core = trimmed
    .replace(/^[\s\p{P}\p{S}]+|[\s\p{P}\p{S}]+$/gu, "")
    .replace(/\s+/g, " ")
    .toLowerCase();
  if (!core) return null;

  // Strictly limit to <= 2 English words so sentences/phrases are never intercepted.
  if (!/^[a-z]+(?:'[a-z]+)?(?:\s+[a-z]+(?:'[a-z]+)?)?$/u.test(core)) return null;

  const hit = UI_SHORT_TERM_MAP[core];
  if (!hit) return null;
  const label = isTraditional ? hit[1] : hit[0];
  return hasEllipsis ? `${label}…` : label;
}

/**
 * Normalizes stray half-width punctuation adjacent to CJK characters in translated
 * image text while strictly preserving digit-to-digit colons (e.g. `7:43`) and numbers.
 */
export function normalizeImagePunctuation(text: string): string {
  const value = String(text ?? "");
  if (!value || !CJK_RE.test(value)) return value;

  return value
    // Half-width , ? ! ; immediately after CJK or Chinese closing punctuation -> full-width.
    .replace(
      /(?<=[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}”’）》」』】])[ \t]*([,?!;])[ \t]*(?=[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}“‘（《「『【]|$)/gu,
      (_m, p: string) => HALF_TO_FULL_PUNCT[p] ?? p,
    )
    .replace(
      /(?<=[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}”’）》」』】])[ \t]*([,?!;])/gu,
      (_m, p: string) => HALF_TO_FULL_PUNCT[p] ?? p,
    )
    // Half-width , ? ! ; immediately before CJK -> full-width (e.g. "OpenClaw, 沙盒" -> "OpenClaw，沙盒").
    .replace(
      /([,?!;])[ \t]*(?=[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}])/gu,
      (_m, p: string) => HALF_TO_FULL_PUNCT[p] ?? p,
    )
    // Half-width colon adjacent to CJK -> full-width, NEVER touching digit:digit (e.g. 7:43) or URLs (://).
    .replace(
      /(?<=[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}”’）》」』】])[ \t]*:(?!\/\/)[ \t]*/gu,
      "：",
    )
    .replace(
      /(?<!\d):[ \t]*(?=[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}])/gu,
      "：",
    );
}
