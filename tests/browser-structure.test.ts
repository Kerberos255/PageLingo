import { afterEach, describe, expect, it } from "vitest";
import { runBrowserStructureRegressions } from "./browser-structure";

afterEach(() => document.body.replaceChildren());

describe("original-node browser structure regressions", () => {
  it("passes all deterministic DOM structure and restore checks", async () => {
    const result = await runBrowserStructureRegressions();
    expect(result.rows.length).toBeGreaterThanOrEqual(9);
    expect(result.rows.every((row) => row.passed)).toBe(true);
  });
});
