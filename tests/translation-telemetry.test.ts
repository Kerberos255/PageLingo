import { describe, expect, it } from "vitest";
import { collectTranslationTelemetry } from "../src/core/translation-telemetry";

describe("translation root telemetry", () => {
  it("counts source inline structure while excluding synthetic link boundary sentinels", () => {
    document.body.innerHTML = `<p>Read <a href="/docs">documentation</a> and <strong>important</strong> <code>npm</code>.</p>`;
    const telemetry = collectTranslationTelemetry(document.body);

    expect(telemetry.rootCount).toBeGreaterThanOrEqual(1);
    const paragraph = telemetry.roots.find((root) => root.rootTag === "p");
    expect(paragraph).toMatchObject({
      rootTag: "p",
      markerCandidateCount: 3,
      maxMarkerDepth: 1,
      linkCount: 1,
      opaqueProtectedCount: 1,
      protectedSlotCandidateCount: 1,
      linkBoundarySentinelCount: 2,
      tagCounts: { a: 1, strong: 1, code: 1 },
    });
  });

  it("does not wrap or change original nodes when gathering diagnostics", () => {
    document.body.innerHTML = '<nav><a href="/docs">Documentation</a></nav><p>Read <a href="/guide">the guide</a>.</p>';
    const before = document.body.innerHTML;
    const anchor = document.querySelector('a')!;
    const text = anchor.firstChild;
    collectTranslationTelemetry(document.body);
    expect(document.body.innerHTML).toBe(before);
    expect(anchor.firstChild).toBe(text);
  });

  it("measures nested inline depth without recording source text", () => {
    document.body.innerHTML = `<p>Keep <strong>this <em>nested phrase</em></strong> private telemetry only.</p>`;
    const telemetry = collectTranslationTelemetry(document.body);
    const serialized = JSON.stringify(telemetry);

    expect(telemetry.roots[0]?.markerCandidateCount).toBe(2);
    expect(telemetry.roots[0]?.maxMarkerDepth).toBe(2);
    expect(serialized).not.toContain("nested phrase");
    expect(serialized).not.toContain("private telemetry only");
  });

  it("reports marker distribution buckets for actual PageLingo roots", () => {
    document.body.innerHTML = `
      <p>Plain paragraph for translation.</p>
      <p><strong>One</strong> and <em>two</em> markers.</p>
    `;
    const telemetry = collectTranslationTelemetry(document.body);

    expect(telemetry.rootCount).toBe(2);
    expect(telemetry.summary.markerBuckets["0"]).toBe(1);
    expect(telemetry.summary.markerBuckets["1-2"]).toBe(1);
    expect(telemetry.summary.markerCount.p50).toBe(0);
    expect(telemetry.summary.markerCount.p99).toBe(2);
  });
});
