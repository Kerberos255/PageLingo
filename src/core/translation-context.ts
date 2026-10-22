import type { TranslationTerminologyEntry } from "./provider";

export type TranslationContext = "http" | "javascript" | "sql" | "python";

const catalogs: Record<TranslationContext, Array<[string, string]>> = {
  http: [["headers", "标头"], ["header", "标头"], ["body", "正文"], ["response", "响应"], ["request", "请求"]],
  javascript: [["promise", "Promise"], ["promises", "Promise"], ["fulfill", "兑现"], ["fulfilled", "已兑现"], ["fulfillment value", "兑现值"], ["fulfillment values", "兑现值"], ["reject", "拒绝"]],
  sql: [["Read Committed", "读已提交"], ["Read Uncommitted", "读未提交"], ["Repeatable Read", "可重复读"], ["Serializable", "可串行化"], ["Isolation Level", "隔离级别"], ["dirty read", "脏读"]],
  python: [["thread", "线程"], ["lock", "锁"], ["coroutine", "协程"], ["cancellation", "取消"]],
};

export function translationContextForUrl(url: string): TranslationContext | undefined {
  try {
    const parsed = new URL(url);
    if (parsed.hostname === "developer.mozilla.org") {
      if (parsed.pathname.includes("/Web/HTTP/")) return "http";
      if (parsed.pathname.includes("/Web/JavaScript/")) return "javascript";
    }
    if (parsed.hostname === "www.postgresql.org" && parsed.pathname.startsWith("/docs/")) return "sql";
    if (parsed.hostname === "docs.python.org") return "python";
  } catch {}
  return undefined;
}

export function contextualTerminology(context: TranslationContext | undefined): TranslationTerminologyEntry[] {
  return context ? catalogs[context].map(([source, target]) => ({source, target, mode: "replace"})) : [];
}

export function validTranslationContext(value: unknown): TranslationContext | undefined {
  return typeof value === "string" && Object.hasOwn(catalogs, value) ? value as TranslationContext : undefined;
}
