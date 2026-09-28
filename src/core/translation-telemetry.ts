// @ts-nocheck
import { collectTranslationRoots } from "./dom-policy";
import { serializeRichSegment } from "./rich-segment";

const LINK_BOUNDARY_RE = /^__FLT_LINK_(?:START|END)_\d+__$/;

function isSyntheticLinkBoundary(element: Element): boolean {
  return element.tagName === "CODE" && LINK_BOUNDARY_RE.test((element.textContent ?? "").trim());
}

function normalizeTextChars(value: string): number {
  return value.replace(/\s+/g, " ").trim().length;
}

function inspectSerializedHtml(html: string) {
  const parsed = new DOMParser().parseFromString(html, "text/html");
  const allElements = Array.from(parsed.body.querySelectorAll("*"));
  const markerElements = allElements.filter((element) => !isSyntheticLinkBoundary(element));
  const markerSet = new Set(markerElements);
  const tagCounts: Record<string, number> = {};
  let maxMarkerDepth = 0;

  for (const element of markerElements) {
    const tag = element.tagName.toLowerCase();
    tagCounts[tag] = (tagCounts[tag] ?? 0) + 1;
    let depth = 1;
    let parent = element.parentElement;
    while (parent && parent !== parsed.body) {
      if (markerSet.has(parent)) depth += 1;
      parent = parent.parentElement;
    }
    maxMarkerDepth = Math.max(maxMarkerDepth, depth);
  }

  return {
    markerCandidateCount: markerElements.length,
    maxMarkerDepth,
    tagCounts,
  };
}

function percentile(values: number[], q: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.max(0, Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1));
  return sorted[index] ?? 0;
}

function distribution(values: number[]) {
  return {
    p50: percentile(values, 0.50),
    p90: percentile(values, 0.90),
    p95: percentile(values, 0.95),
    p99: percentile(values, 0.99),
    max: values.length ? Math.max(...values) : 0,
  };
}

function markerBucket(markerCount: number): string {
  if (markerCount === 0) return "0";
  if (markerCount <= 2) return "1-2";
  if (markerCount <= 4) return "3-4";
  if (markerCount <= 7) return "5-7";
  if (markerCount <= 11) return "8-11";
  if (markerCount <= 15) return "12-15";
  return "16+";
}

export function collectTranslationTelemetry(scope: Document | Element) {
  const roots = collectTranslationRoots(scope);
  const rows = roots.map((root, index) => {
    const segment = serializeRichSegment(root);
    const inspected = inspectSerializedHtml(segment.html);
    const textChars = normalizeTextChars(segment.fingerprint);
    const markerDensityPer100Chars = textChars > 0
      ? Number((inspected.markerCandidateCount * 100 / textChars).toFixed(3))
      : 0;

    return {
      rootIndex: index,
      rootTag: root.tagName.toLowerCase(),
      textChars,
      serializedHtmlChars: segment.html.length,
      markerCandidateCount: inspected.markerCandidateCount,
      markerDensityPer100Chars,
      maxMarkerDepth: inspected.maxMarkerDepth,
      linkCount: segment.links.length,
      opaqueProtectedCount: segment.opaque.length,
      protectedSlotCandidateCount: segment.opaque.length,
      linkBoundarySentinelCount: segment.links.length * 2,
      tagCounts: inspected.tagCounts,
    };
  });

  const aggregateTags: Record<string, number> = {};
  const markerBuckets: Record<string, number> = {
    "0": 0,
    "1-2": 0,
    "3-4": 0,
    "5-7": 0,
    "8-11": 0,
    "12-15": 0,
    "16+": 0,
  };
  for (const row of rows) {
    markerBuckets[markerBucket(row.markerCandidateCount)] += 1;
    for (const [tag, count] of Object.entries(row.tagCounts)) {
      aggregateTags[tag] = (aggregateTags[tag] ?? 0) + count;
    }
  }

  const markerCounts = rows.map((row) => row.markerCandidateCount);
  const markerDensities = rows.map((row) => row.markerDensityPer100Chars);
  const textChars = rows.map((row) => row.textChars);
  const depths = rows.map((row) => row.maxMarkerDepth);

  return {
    version: "dom-marker-telemetry-v1",
    url: scope.ownerDocument?.location?.href ?? (scope instanceof Document ? scope.location.href : ""),
    rootCount: rows.length,
    summary: {
      markerCount: distribution(markerCounts),
      markerDensityPer100Chars: distribution(markerDensities),
      textChars: distribution(textChars),
      maxMarkerDepth: distribution(depths),
      rootsWithAtLeast8Markers: markerCounts.filter((value) => value >= 8).length,
      rootsWithAtLeast12Markers: markerCounts.filter((value) => value >= 12).length,
      rootsWithAtLeast16Markers: markerCounts.filter((value) => value >= 16).length,
      markerBuckets,
      tagCounts: aggregateTags,
    },
    roots: rows,
  };
}
