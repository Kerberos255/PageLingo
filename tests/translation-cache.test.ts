import { describe, expect, it } from "vitest";
import { ShortTranslationCache } from "../src/providers/bergamot/translation-cache";

describe("ShortTranslationCache", () => {
  it("isolates identical HTML by translation route", () => {
    const cache = new ShortTranslationCache();
    cache.set("en>zh", "Settings", "设置");
    cache.set("en>ja", "Settings", "設定");

    expect(cache.get("en>zh", "Settings")).toBe("设置");
    expect(cache.get("en>ja", "Settings")).toBe("設定");
  });

  it("does not retain long HTML", () => {
    const cache = new ShortTranslationCache(8, 8);
    cache.set("en>zh", "123456789", "x");
    expect(cache.get("en>zh", "123456789")).toBeUndefined();
    expect(cache.size()).toBe(0);
  });

  it("evicts the least recently used entry", () => {
    const cache = new ShortTranslationCache(2, 64);
    cache.set("r", "one", "一");
    cache.set("r", "two", "二");
    expect(cache.get("r", "one")).toBe("一");

    cache.set("r", "three", "三");

    expect(cache.get("r", "two")).toBeUndefined();
    expect(cache.get("r", "one")).toBe("一");
    expect(cache.get("r", "three")).toBe("三");
  });

  it("caches empty translated output without confusing it with a miss", () => {
    const cache = new ShortTranslationCache();
    cache.set("r", "x", "");
    expect(cache.get("r", "x")).toBe("");
  });
});
