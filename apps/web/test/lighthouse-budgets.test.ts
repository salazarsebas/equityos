import { describe, expect, test } from "bun:test";
import { CATEGORIES, formatSummary, type LighthouseResult, medianRun, summarize } from "../scripts/lighthouse-budgets";

function result(
  scores: Partial<Record<string, number | null>> = {},
  metrics: Partial<Record<string, number>> = {},
): LighthouseResult {
  const categories: Record<string, { score: number | null }> = {};
  for (const category of CATEGORIES)
    categories[category] = { score: category in scores ? (scores[category] ?? null) : 1 };
  return {
    categories,
    audits: {
      "largest-contentful-paint": { numericValue: metrics.lcp ?? 900 },
      "cumulative-layout-shift": { numericValue: metrics.cls ?? 0 },
      "total-blocking-time": { numericValue: metrics.tbt ?? 10 },
    },
  };
}

describe("Lighthouse budgets", () => {
  test("a result inside every budget has no failure", () => {
    const summary = summarize("/", result({ performance: 0.95 }, { lcp: 1999, cls: 0.049, tbt: 199 }));
    expect(summary.failures).toEqual([]);
    expect(formatSummary(summary)).toBe(
      "/: performance 95, accessibility 100, best-practices 100, seo 100; LCP 1999 ms, CLS 0.049, TBT 199 ms: ok",
    );
  });

  test("each category below its floor and each metric at its ceiling is a failure", () => {
    const summary = summarize(
      "/indexes",
      result(
        { performance: 0.94, accessibility: 0.99, "best-practices": 0.96, seo: 0.92 },
        { lcp: 2000, cls: 0.05, tbt: 200 },
      ),
    );
    expect(summary.failures).toEqual([
      "performance: 94, below 95",
      "accessibility: 99, below 100",
      "best-practices: 96, below 100",
      "seo: 92, below 100",
      "LCP: 2000 ms, at or above 2000 ms",
      "CLS: 0.050, at or above 0.050",
      "TBT: 200 ms, at or above 200 ms",
    ]);
    expect(formatSummary(summary)).toContain(": FAIL (performance: 94, below 95;");
  });

  test("a missing score, a missing metric and a runtime error are failures, never a pass", () => {
    const missing: LighthouseResult = {
      categories: { ...result().categories, seo: { score: null } },
      audits: { "largest-contentful-paint": { numericValue: 900 }, "total-blocking-time": {} },
      runtimeError: { code: "NO_FCP", message: "The page did not paint any content." },
    };
    const summary = summarize("/", missing);
    expect(summary.failures).toEqual([
      "Lighthouse could not measure the page: NO_FCP The page did not paint any content.",
      "seo: no score",
      "CLS: not measured",
      "TBT: not measured",
    ]);
    expect(formatSummary(summary)).toContain("seo -");
    expect(formatSummary(summary)).toContain("CLS -");
  });

  test("the median run is checked, whatever order the runs come in", () => {
    const slow = result({ performance: 0.7 });
    const middle = result({ performance: 0.96 });
    const fast = result({ performance: 1 });
    expect(medianRun([fast, slow, middle])).toBe(middle);
    expect(medianRun([middle])).toBe(middle);
    expect(medianRun([fast, slow])).toBe(slow);
    expect(medianRun([result({ performance: null }), middle, fast])).toBe(middle);
    expect(() => medianRun([])).toThrow("no Lighthouse run");
  });
});
