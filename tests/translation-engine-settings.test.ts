import { describe, expect, it } from "vitest";
import { normalizeTranslationEngineConfig } from "../src/shared/translation-engine-settings";

describe("translation engine config normalization", () => {
  it("accepts bracketed IPv6 loopback HTTP endpoints", () => {
    const config = normalizeTranslationEngineConfig({
      id: "local-ipv6",
      name: "Local IPv6",
      type: "openai-compatible",
      enabled: true,
      baseUrl: "http://[::1]:5000/v1",
      apiKey: "",
      model: "local",
      region: "",
      prompt: "",
      headersJson: "",
      bodyJson: "",
      responsePath: "",
    });

    expect(config).not.toBeNull();
    expect(config?.baseUrl).toBe("http://[::1]:5000/v1");
  });

  it("still rejects plaintext remote endpoints", () => {
    const config = normalizeTranslationEngineConfig({
      id: "remote",
      name: "Remote",
      type: "openai-compatible",
      enabled: true,
      baseUrl: "http://example.com/v1",
    });
    expect(config).toBeNull();
  });
});
