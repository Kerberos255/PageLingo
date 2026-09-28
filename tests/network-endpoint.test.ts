import { describe, expect, it } from "vitest";

import {
  isLoopbackHostname,
  isLoopbackTranslationEndpoint,
  normalizeHostname,
} from "../src/shared/network-endpoint";

describe("loopback endpoint detection", () => {
  it("normalizes bracketed IPv6 hostnames", () => {
    expect(normalizeHostname("[::1]")).toBe("::1");
    expect(isLoopbackHostname("[::1]")).toBe(true);
    expect(isLoopbackHostname("::1")).toBe(true);
  });

  it("accepts IPv4, localhost subdomains, and bracketed IPv6 loopback URLs", () => {
    expect(isLoopbackTranslationEndpoint("http://127.0.0.1:5000")).toBe(true);
    expect(isLoopbackTranslationEndpoint("http://localhost:5000")).toBe(true);
    expect(isLoopbackTranslationEndpoint("https://api.localhost/v1")).toBe(true);
    expect(isLoopbackTranslationEndpoint("http://[::1]:5000/v1")).toBe(true);
    expect(isLoopbackTranslationEndpoint("https://[::1]/v1")).toBe(true);
  });

  it("rejects remote and malformed endpoints", () => {
    expect(isLoopbackTranslationEndpoint("https://example.com/v1")).toBe(false);
    expect(isLoopbackTranslationEndpoint("http://192.168.1.10:5000")).toBe(false);
    expect(isLoopbackTranslationEndpoint("not a url")).toBe(false);
  });
});
