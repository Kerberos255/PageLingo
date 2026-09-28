export function normalizeHostname(hostname: string): string {
  const host = hostname.trim().toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) {
    return host.slice(1, -1);
  }
  return host;
}

export function isLoopbackHostname(hostname: string): boolean {
  const host = normalizeHostname(hostname);
  return host === "localhost"
    || host.endsWith(".localhost")
    || host === "127.0.0.1"
    || host === "::1";
}

export function isLoopbackTranslationEndpoint(value: string): boolean {
  if (!value) return false;
  try {
    return isLoopbackHostname(new URL(value).hostname);
  } catch {
    return false;
  }
}
