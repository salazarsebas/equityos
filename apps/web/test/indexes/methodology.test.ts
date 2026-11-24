import { describe, expect, test } from "bun:test";
import {
  describeMethodology,
  rebalanceRules,
  formatDuration,
  formatPoints,
  largestWeightBps,
  METHODOLOGY_LIMITS,
  rebalanceSummary,
  weightingLabel,
} from "../../src/lib/indexes/methodology";
import { buildSpec } from "../registry/support";

describe("formatDuration", () => {
  test("uses at most the two largest whole units", () => {
    expect(formatDuration(604_800)).toBe("7 days");
    expect(formatDuration(86_400)).toBe("1 day");
    expect(formatDuration(129_600)).toBe("1 day 12 hours");
    expect(formatDuration(3_661)).toBe("1 hour 1 minute");
    expect(formatDuration(90)).toBe("1 minute 30 seconds");
    expect(formatDuration(0)).toBe("0 seconds");
    expect(formatDuration(86_400_000)).toBe("1,000 days");
  });

  test("rejects a value that is not a non-negative integer", () => {
    expect(() => formatDuration(-1)).toThrow(RangeError);
    expect(() => formatDuration(1.5)).toThrow(RangeError);
  });
});

describe("describeMethodology", () => {
  test("an equal-weight spec without bounds reads with fixed wording", () => {
    const { spec } = buildSpec();
    expect(describeMethodology(spec)).toEqual([
      {
        rule: "Universe",
        value: "Static, 4 tokens",
        reading:
          "The index holds a fixed list of 4 tokens, named by contract address on chain 84532. The list changes only when the creator publishes a new version.",
      },
      { rule: "Weighting", value: "Equal", reading: "Every constituent has the same target weight, 25.00%." },
      {
        rule: "Weight bounds",
        value: "None",
        reading: "The methodology declares no minimum and no maximum weight for a constituent.",
      },
      {
        rule: "Rebalance trigger",
        value: "Drift of 5.00 pp",
        reading:
          "A rebalance is due when the weight of a constituent in a replicating wallet is 5.00 pp or more away from its target weight.",
      },
      {
        rule: "Minimum interval",
        value: "1 day",
        reading: "A rebalance is not due sooner than 1 day after the previous one, whatever the drift.",
      },
      {
        rule: "Pricing source",
        value: "One oracle feed per token",
        reading:
          'Weights in a wallet are measured with reference prices read from one price feed contract per constituent (source "chainlink-aggregator-v3"), named by address in the methodology. A reference price is an indication of value, not a price a trade executes at.',
      },
    ]);
  });

  test("equal weights that do not divide evenly state both weights", () => {
    const [, weighting] = describeMethodology(buildSpec({ tokenCount: 3 }).spec);
    expect(weighting?.reading).toBe(
      "Every constituent has the same target weight, rounded to a whole basis point: 33.34% for the lowest token addresses and 33.33% for the others, so that the weights sum to exactly 100.00%.",
    );
  });

  test("fixed weights state their range and that they are not derived from data", () => {
    const { spec } = buildSpec({ weightsBps: [5_000, 3_000, 2_000] });
    const rules = describeMethodology({ ...spec, constraints: { maxWeightBps: 5_000, minWeightBps: 1_000 } });
    expect(rules.map(({ rule, value }) => [rule, value])).toEqual([
      ["Universe", "Static, 3 tokens"],
      ["Weighting", "Fixed"],
      ["Maximum weight", "50.00%"],
      ["Minimum weight", "10.00%"],
      ["Rebalance trigger", "Drift of 5.00 pp"],
      ["Minimum interval", "1 day"],
      ["Pricing source", "One oracle feed per token"],
    ]);
    expect(rules[1]?.reading).toBe(
      "Each constituent has the target weight its creator wrote in the methodology, from 20.00% to 50.00%. Weights are not derived from prices, market value or any other data.",
    );
    expect(rules[2]?.reading).toBe(
      "No constituent may have a target weight above 50.00%. The published weights of this version respect it.",
    );
    expect(rules[3]?.reading).toBe(
      "No constituent may have a target weight below 10.00%. The published weights of this version respect it.",
    );
  });

  test("a single constituent and no minimum interval read correctly", () => {
    const { spec } = buildSpec({ tokenCount: 1 });
    const rules = describeMethodology({
      ...spec,
      constraints: { maxWeightBps: 10_000 },
      rebalance: { ...spec.rebalance, minIntervalSeconds: 0 },
    });
    expect(rules[0]?.value).toBe("Static, 1 token");
    expect(rules[1]?.reading).toBe("Every constituent has the same target weight, 100.00%.");
    expect(rules[2]?.reading).toContain("The equal weights of this version respect it.");
    expect(rules[4]).toEqual({
      rule: "Minimum interval",
      value: "None",
      reading: "The methodology sets no minimum time between two rebalances.",
    });
  });

  test("the same spec always produces the same text, with no advice in it", () => {
    const { spec } = buildSpec({ weightsBps: [6_000, 4_000] });
    expect(describeMethodology(spec)).toEqual(describeMethodology(structuredClone(spec)));
    const text = [...describeMethodology(spec).map(({ reading }) => reading), ...METHODOLOGY_LIMITS].join(" ");
    expect(text).not.toMatch(/should|recommend|invest|profit|outperform|guarantee|\bbuy\b|\bsell\b/i);
    expect(METHODOLOGY_LIMITS).toHaveLength(4);
    for (const limit of METHODOLOGY_LIMITS) expect(limit).toMatch(/^It does not /);
  });
});

describe("summaries", () => {
  test("label the weighting, the rebalance rule and the largest weight", () => {
    const { spec, constituents } = buildSpec({ weightsBps: [5_000, 3_000, 2_000] });
    expect(weightingLabel(spec)).toBe("Fixed weights");
    expect(weightingLabel(buildSpec().spec)).toBe("Equal weight");
    expect(rebalanceSummary(spec)).toBe("5.00 pp drift, 1 day apart");
    expect(rebalanceSummary({ ...spec, rebalance: { ...spec.rebalance, minIntervalSeconds: 0 } })).toBe(
      "5.00 pp drift",
    );
    expect(formatPoints(25)).toBe("0.25 pp");
    expect(largestWeightBps(constituents)).toBe(5_000);
    expect(largestWeightBps([])).toBe(0);
  });
});

describe("rebalanceRules", () => {
  test("are the rebalance rules of the full description, from the two values alone", () => {
    const { spec } = buildSpec({ tokenCount: 3 });
    const fromSpec = describeMethodology(spec).filter(
      ({ rule }) => rule.startsWith("Rebalance") || rule === "Minimum interval",
    );
    expect(rebalanceRules(spec.rebalance)).toEqual(fromSpec);
    expect(rebalanceRules({ driftThresholdBps: 250, minIntervalSeconds: 0 }).map(({ reading }) => reading)).toEqual([
      "A rebalance is due when the weight of a constituent in a replicating wallet is 2.50 pp or more away from its target weight.",
      "The methodology sets no minimum time between two rebalances.",
    ]);
  });
});
