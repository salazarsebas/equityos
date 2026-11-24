import { describe, expect, test } from "bun:test";
import { canonicalize, specHash, validateSpec } from "@equityos/core";
import type { Draft } from "../../src/lib/studio/draft";
import { buildCandidate, evaluateDraft, issuesFor } from "../../src/lib/studio/evaluate";
import { ASSETS, CHAIN_ID, TOKENS, validDraft } from "./support";

const [T1, T2, T3, T4] = TOKENS as [`0x${string}`, `0x${string}`, `0x${string}`, `0x${string}`];
const issues = (overrides: Partial<Draft>) => evaluateDraft(validDraft(overrides), ASSETS).issues;
const fixed = (weights: Record<string, string>, more: Partial<Draft> = {}) =>
  issues({ weighting: "fixed", weights, ...more });

describe("evaluateDraft on a valid draft", () => {
  test("produces the spec, its canonical bytes, the hash and the constituents with core", () => {
    const { valid, issues: none, candidate } = evaluateDraft(validDraft(), ASSETS);
    expect(none).toEqual([]);
    if (valid === null) throw new Error("expected a valid draft");
    expect(valid.spec.universe.tokens).toEqual([T1, T2, T3]);
    expect(valid.spec.pricing.feeds).toEqual(ASSETS.slice(0, 3).map(({ feed }) => feed ?? "0x"));
    expect(valid.spec.chainId).toBe(CHAIN_ID);
    expect(valid.spec.rebalance).toEqual({ trigger: "drift", driftThresholdBps: 500, minIntervalSeconds: 604_800 });
    expect(valid.specBytes).toEqual(canonicalize(candidate));
    expect(valid.specHash).toBe(specHash(valid.specBytes));
    expect(valid.constituents.map(({ weightBps }) => weightBps)).toEqual([3334, 3333, 3333]);
  });

  test("the outcome is exactly what validateSpec says about the candidate", () => {
    for (const draft of [validDraft(), validDraft({ name: "" }), validDraft({ weighting: "fixed" })]) {
      const evaluation = evaluateDraft(draft, ASSETS);
      const result = validateSpec(buildCandidate(draft, new Map(ASSETS.map((asset) => [asset.address, asset]))));
      expect(evaluation.valid !== null).toBe(result.ok);
      expect(evaluation.issues.map(({ path, code }) => ({ path, code }))).toEqual(
        result.ok ? [] : result.errors.map(({ path, code }) => ({ path, code })),
      );
    }
  });

  test("fixed weights, bounds, hours and the description reach the spec as integers", () => {
    const { valid } = evaluateDraft(
      validDraft({
        weighting: "fixed",
        weights: { [T1]: "50", [T2]: "29.99", [T3]: "20.01" },
        maxWeight: "50",
        minWeight: "20.01",
        driftThreshold: "2.5",
        minInterval: "36",
        minIntervalUnit: "hours",
        description: "Three names.",
      }),
      ASSETS,
    );
    expect(valid?.spec.weighting).toEqual({ type: "fixed", weightsBps: [5000, 2999, 2001] });
    expect(valid?.spec.constraints).toEqual({ maxWeightBps: 5000, minWeightBps: 2001 });
    expect(valid?.spec.rebalance).toMatchObject({ driftThresholdBps: 250, minIntervalSeconds: 129_600 });
  });
});

describe("every error of core lands on the field that fixes it", () => {
  test("identity", () => {
    expect(issues({ name: "" })).toMatchObject([{ field: "name", code: "invalid_name", incomplete: true }]);
    expect(issues({ name: "Café" })).toMatchObject([{ field: "name", incomplete: false }]);
    expect(issues({ name: "x".repeat(65) })).toMatchObject([{ field: "name", path: "/name" }]);
    expect(issues({ slug: "" })).toMatchObject([{ field: "slug", incomplete: true }]);
    expect(issues({ slug: "Not A Slug" })).toMatchObject([{ field: "slug", code: "invalid_slug", incomplete: false }]);
    expect(issues({ description: "\ud800" })).toMatchObject([{ field: "description", code: "lone_surrogate" }]);
  });

  test("universe", () => {
    expect(issues({ tokens: [] })).toMatchObject([{ field: "universe", code: "too_few_items", incomplete: true }]);
    const many = Array.from({ length: 65 }, (_, i): `0x${string}` => `0xb2${(i + 1).toString(16).padStart(38, "0")}`);
    const tooMany = evaluateDraft(validDraft({ tokens: many }), ASSETS).issues;
    expect(issuesFor(tooMany, "universe").map(({ code }) => code)).toContain("too_many_items");
  });

  test("a selected token that is no longer in the asset list is reported on the universe by its address", () => {
    const [issue] = evaluateDraft(validDraft(), ASSETS.slice(0, 2)).issues;
    expect(issue).toMatchObject({ field: "universe", code: "invalid_address", path: "/pricing/feeds/2" });
    expect(issue?.message).toContain(T3);
  });

  test("weights", () => {
    const sum = fixed({ [T1]: "50", [T2]: "30", [T3]: "18.5" });
    expect(sum).toMatchObject([{ field: "weights", code: "invalid_weight_sum" }]);
    expect(sum[0]?.message).toBe("Weights add up to 98.50%. 1.50% is not assigned.");
    expect(fixed({ [T1]: "50", [T2]: "30", [T3]: "21" })[0]?.message).toBe(
      "Weights add up to 101.00%, 1.00% over 100.00%.",
    );
    expect(fixed({ [T1]: "50", [T2]: "50" })).toMatchObject([
      { field: "weight", token: T3, code: "out_of_range", incomplete: true },
    ]);
    expect(fixed({ [T1]: "50", [T2]: "49.999", [T3]: "0.001" })).toMatchObject([
      { field: "weight", token: T2, code: "invalid_type", incomplete: false },
      { field: "weight", token: T3, code: "invalid_type" },
    ]);
    expect(fixed({ [T1]: "150", [T2]: "30", [T3]: "20" })).toMatchObject([
      { field: "weight", token: T1, code: "out_of_range", incomplete: false },
    ]);
  });

  test("bounds on fixed weights name the constituent and both numbers", () => {
    const above = fixed({ [T1]: "50", [T2]: "30", [T3]: "20" }, { maxWeight: "40" });
    expect(above).toMatchObject([{ field: "weight", token: T1, code: "weight_above_max" }]);
    expect(above[0]?.message).toBe("AAAc is at 50.00%, above the maximum weight of 40%.");
    const below = fixed({ [T1]: "50", [T2]: "45", [T3]: "5" }, { minWeight: "10.00" });
    expect(below).toMatchObject([{ field: "weight", token: T3, code: "weight_below_min" }]);
  });

  test("bounds on equal weights state the fix with the numbers", () => {
    const cap = issues({ maxWeight: "15" });
    expect(cap).toMatchObject([{ field: "maxWeight", code: "cap_infeasible" }]);
    expect(cap[0]?.message).toBe(
      "3 equal weights cannot all stay at or under 15.00%. Raise it to at least 33.34% or select at least 7 constituents.",
    );
    const floor = issues({ minWeight: "40", tokens: [T1, T2, T3, T4] });
    expect(floor).toMatchObject([{ field: "minWeight", code: "floor_infeasible" }]);
    expect(floor[0]?.message).toBe(
      "4 equal weights cannot all reach 40.00%. Lower it to at most 25.00% or select at most 2 constituents.",
    );
    expect(issues({ maxWeight: "abc" })).toMatchObject([{ field: "maxWeight", code: "invalid_type" }]);
    expect(issues({ minWeight: "0" })).toMatchObject([{ field: "minWeight", code: "out_of_range" }]);
  });

  test("rebalance rule", () => {
    expect(issues({ driftThreshold: "" })).toMatchObject([{ field: "driftThreshold", incomplete: true }]);
    expect(issues({ driftThreshold: "0" })).toMatchObject([{ field: "driftThreshold", code: "out_of_range" }]);
    expect(issues({ driftThreshold: "5.123" })).toMatchObject([{ field: "driftThreshold", code: "invalid_type" }]);
    expect(issues({ minInterval: "" })).toMatchObject([{ field: "minInterval", incomplete: true }]);
    expect(issues({ minInterval: "1.5" })).toMatchObject([{ field: "minInterval", code: "invalid_type" }]);
    expect(issues({ minInterval: "0" })).toEqual([]);
  });

  test("a spec over the size limit is reported on the spec", () => {
    expect(issues({ description: "d".repeat(8_192) })).toMatchObject([{ field: "spec", code: "spec_too_large" }]);
  });

  test("no message leaks a JSON pointer or the wording of core for a known field", () => {
    const all = [
      ...issues({ name: "", slug: "", tokens: [], driftThreshold: "x", minInterval: "x", maxWeight: "x" }),
      ...fixed({ [T1]: "x" }),
    ];
    expect(all.length).toBeGreaterThan(6);
    for (const { field, message } of all) {
      expect(field).not.toBe("spec");
      expect(message).not.toMatch(/\/|must match|expected an? /);
    }
  });
});

describe("preview weights", () => {
  test("are shown before the draft is valid, and withheld when a weight is not a number", () => {
    expect(evaluateDraft(validDraft({ name: "" }), ASSETS).previewWeights?.map((c) => c.weightBps)).toEqual([
      3334, 3333, 3333,
    ]);
    const partial = evaluateDraft(validDraft({ weighting: "fixed", weights: { [T1]: "50" } }), ASSETS);
    expect(partial.previewWeights?.map((c) => c.weightBps)).toEqual([5000, 0, 0]);
    expect(evaluateDraft(validDraft({ weighting: "fixed", weights: { [T1]: "x" } }), ASSETS).previewWeights).toBeNull();
    expect(evaluateDraft(validDraft({ tokens: [] }), ASSETS).previewWeights).toEqual([]);
  });
});
