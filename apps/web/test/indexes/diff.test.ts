import { describe, expect, test } from "bun:test";
import type { IndexSpec } from "@equityos/core";
import { buildSeedIndexes } from "../../scripts/seed/indexes";
import { diffSpecs, summarizeDiff } from "../../src/lib/indexes/diff";
import { buildSpec } from "../registry/support";

const T1 = "0xb200000000000000000000000000000000000001";
const T2 = "0xb200000000000000000000000000000000000002";
const T3 = "0xb200000000000000000000000000000000000003";
const T4 = "0xb200000000000000000000000000000000000004";

describe("diffSpecs", () => {
  test("two identical specs have no difference", () => {
    const { spec } = buildSpec();
    const diff = diffSpecs(spec, structuredClone(spec));
    expect(diff).toEqual({ added: [], removed: [], reweighted: [], rules: [] });
    expect(summarizeDiff(diff)).toEqual([]);
  });

  test("a constituent added to an equal-weight index reweights the others", () => {
    const diff = diffSpecs(buildSpec({ tokenCount: 3 }).spec, buildSpec({ tokenCount: 4 }).spec);
    expect(diff.added).toEqual([T4]);
    expect(diff.removed).toEqual([]);
    expect(diff.reweighted).toEqual([
      { token: T1, fromBps: 3_334, toBps: 2_500 },
      { token: T2, fromBps: 3_333, toBps: 2_500 },
      { token: T3, fromBps: 3_333, toBps: 2_500 },
    ]);
    expect(summarizeDiff(diff)).toEqual(["1 constituent added", "3 weights changed"]);
  });

  test("a constituent removed and a change of weighting are both reported", () => {
    const diff = diffSpecs(buildSpec({ tokenCount: 4 }).spec, buildSpec({ weightsBps: [2_500, 7_500] }).spec);
    expect(diff.removed).toEqual([T3, T4]);
    expect(diff.reweighted).toEqual([{ token: T2, fromBps: 2_500, toBps: 7_500 }]);
    expect(summarizeDiff(diff)).toEqual([
      "2 constituents removed",
      "1 weight changed",
      "Weighting changed from equal to fixed",
    ]);
  });

  test("every rule change is one fixed sentence", () => {
    const { spec } = buildSpec({ tokenCount: 2 });
    const next: IndexSpec = {
      ...spec,
      name: "Renamed",
      slug: "renamed",
      description: "Another description.",
      constraints: { maxWeightBps: 6_000, minWeightBps: 4_000 },
      pricing: { ...spec.pricing, feeds: [spec.pricing.feeds[0] ?? T1, "0xfeed0000000000000000000000000000000000ff"] },
      rebalance: { trigger: "drift", driftThresholdBps: 250, minIntervalSeconds: 0 },
    };
    expect(diffSpecs(spec, next).rules).toEqual([
      "Maximum weight changed from none to 60.00%",
      "Minimum weight changed from none to 40.00%",
      "Drift threshold changed from 5.00 pp to 2.50 pp",
      "Minimum rebalance interval changed from 1 day to none",
      "Price feed changed for 1 constituent",
      'Name changed from "Test Index" to "Renamed"',
      "Slug changed from test-index to renamed",
      "Description changed",
    ]);
    expect(diffSpecs(next, spec).rules[0]).toBe("Maximum weight changed from 60.00% to none");
  });

  test("the two versions of the seeded index: one constituent added, one weight changed, rules changed", () => {
    const [first, second] = buildSeedIndexes(31_337).at(-1)?.versions ?? [];
    if (first === undefined || second === undefined) throw new Error("the seed has no index with two versions");
    const diff = diffSpecs(first.spec, second.spec);
    expect(diff.added).toHaveLength(1);
    expect(diff.removed).toEqual([]);
    expect(diff.reweighted).toHaveLength(1);
    expect(diff.reweighted[0]).toMatchObject({ fromBps: 2_500, toBps: 1_000 });
    expect(summarizeDiff(diff)).toEqual([
      "1 constituent added",
      "1 weight changed",
      "Weighting changed from equal to fixed",
      "Maximum weight changed from none to 25.00%",
      "Description changed",
    ]);
  });
});
