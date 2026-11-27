/**
 * Lighthouse budgets of the web app, and the pure functions that check a Lighthouse result against them. The
 * runner is `scripts/check-lighthouse.ts`; this module has no side effects so the checks are unit tested.
 */

/** The routes measured: the landing page, the index explorer and an index page of the recorded registry. */
export const LIGHTHOUSE_ROUTES = ["/", "/indexes", "/indexes/diversified-equity-d622e2a5"] as const;

/** Minimum category scores, from 0 to 1. */
export const CATEGORY_FLOORS = {
  performance: 0.95,
  accessibility: 1,
  "best-practices": 1,
  seo: 1,
} as const;

export type Category = keyof typeof CATEGORY_FLOORS;
export const CATEGORIES = Object.keys(CATEGORY_FLOORS) as Category[];

/**
 * Lab metric ceilings. Total blocking time stands in for interaction to next paint, which a page load without
 * interaction cannot measure.
 */
export const METRIC_CEILINGS = {
  "largest-contentful-paint": { max: 2000, unit: "ms", label: "LCP" },
  "cumulative-layout-shift": { max: 0.05, unit: "", label: "CLS" },
  "total-blocking-time": { max: 200, unit: "ms", label: "TBT" },
} as const;

export type Metric = keyof typeof METRIC_CEILINGS;
export const METRICS = Object.keys(METRIC_CEILINGS) as Metric[];

/** The part of a Lighthouse result (LHR) these checks read. */
export interface LighthouseResult {
  readonly categories: Readonly<Record<string, { readonly score: number | null }>>;
  readonly audits: Readonly<Record<string, { readonly numericValue?: number }>>;
  readonly runtimeError?: { readonly code: string; readonly message: string };
}

export interface RouteSummary {
  readonly route: string;
  readonly scores: Readonly<Record<Category, number | null>>;
  readonly metrics: Readonly<Record<Metric, number | null>>;
  readonly failures: readonly string[];
}

/** Reads the scores and metrics of one result and lists every budget it misses. A missing value is a failure. */
export function summarize(route: string, result: LighthouseResult): RouteSummary {
  const failures: string[] = [];
  if (result.runtimeError !== undefined) {
    failures.push(`Lighthouse could not measure the page: ${result.runtimeError.code} ${result.runtimeError.message}`);
  }
  const scores = {} as Record<Category, number | null>;
  for (const category of CATEGORIES) {
    const score = result.categories[category]?.score ?? null;
    scores[category] = score;
    const floor = CATEGORY_FLOORS[category];
    if (score === null) failures.push(`${category}: no score`);
    else if (score < floor) failures.push(`${category}: ${percent(score)}, below ${percent(floor)}`);
  }
  const metrics = {} as Record<Metric, number | null>;
  for (const metric of METRICS) {
    const value = result.audits[metric]?.numericValue ?? null;
    metrics[metric] = value;
    const { max, unit, label } = METRIC_CEILINGS[metric];
    if (value === null) failures.push(`${label}: not measured`);
    else if (value >= max)
      failures.push(`${label}: ${formatMetric(value, unit)}, at or above ${formatMetric(max, unit)}`);
  }
  return { route, scores, metrics, failures };
}

/**
 * The run with the median performance score, the result Lighthouse recommends reading when a page is measured
 * several times: one slow run on a shared machine does not fail the build, and one fast run does not hide a
 * regression. A run without a performance score counts as the lowest.
 */
export function medianRun<T extends LighthouseResult>(runs: readonly T[]): T {
  if (runs.length === 0) throw new Error("no Lighthouse run to choose from");
  const sorted = [...runs].sort(
    (a, b) => (a.categories.performance?.score ?? -1) - (b.categories.performance?.score ?? -1),
  );
  return sorted[Math.floor((sorted.length - 1) / 2)] as T;
}

/** One line per route for the job log. */
export function formatSummary(summary: RouteSummary): string {
  const scores = CATEGORIES.map((category) => {
    const score = summary.scores[category];
    return `${category} ${score === null ? "-" : percent(score)}`;
  }).join(", ");
  const metrics = METRICS.map((metric) => {
    const value = summary.metrics[metric];
    const { unit, label } = METRIC_CEILINGS[metric];
    return `${label} ${value === null ? "-" : formatMetric(value, unit)}`;
  }).join(", ");
  const verdict = summary.failures.length === 0 ? "ok" : `FAIL (${summary.failures.join("; ")})`;
  return `${summary.route}: ${scores}; ${metrics}: ${verdict}`;
}

function percent(score: number): string {
  return String(Math.round(score * 100));
}

function formatMetric(value: number, unit: string): string {
  return unit === "ms" ? `${Math.round(value)} ms` : value.toFixed(3);
}
