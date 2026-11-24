import { describe, expect, test } from "bun:test";
import { buildNetworkMetrics, spansEnoughDays } from "../../src/server/network/aggregate";
import { METRIC_DEFINITIONS } from "../../src/server/network/definitions";
import { parseExcludedAccounts } from "../../src/server/network/exclusions";
import { RegistryConfigurationError } from "../../src/server/registry";
import { ALICE, BOB, INDEX_1, INDEX_2, metricsInput } from "./support";

describe("buildNetworkMetrics", () => {
  const metrics = buildNetworkMetrics(metricsInput());

  test("registry counts leave out the indexes of excluded accounts", () => {
    expect(metrics.indexesPublished.value).toBe(2);
    expect(metrics.versionsPublished.value).toBe(2);
    expect(metrics.distinctCreators.value).toBe(1);
    expect(metrics.indexesDeprecated.value).toBe(1);
    expect(metrics.versionsPerDay.value).toEqual([
      { day: "2026-11-16", count: 1 },
      { day: "2026-11-18", count: 1 },
    ]);
  });

  test("usage counts each tier, and distinct accounts and value come from tier A only", () => {
    expect(metrics.attestations.value).toBe(5);
    expect(metrics.attestationsTierA.value).toBe(3);
    expect(metrics.attestationsTierB.value).toBe(1);
    expect(metrics.attestationsUnmatched.value).toBe(1);
    expect(metrics.accountsTierA.value).toBe(2);
    expect(metrics.accountsWithinTolerance.value).toBe(1);
    expect(metrics.tierAReferenceValueUsdE8.value).toBe(750_000_000n);
    expect(metrics.tierAPerDay.value).toEqual([{ day: "2026-11-17", count: 3 }]);
  });

  test("excluded activity is counted apart and nowhere else", () => {
    expect(metrics.excludedActivity.value).toEqual({
      indexes: 1,
      versions: 1,
      attestations: { tierA: 1, tierB: 0, unmatched: 1 },
    });
    expect(metrics.byIndex.value.map(({ indexId }) => indexId)).toEqual([INDEX_1, INDEX_2]);
  });

  test("indexes are ordered by distinct tier A accounts, with their labels", () => {
    expect(metrics.byIndex.value).toEqual([
      {
        indexId: INDEX_1,
        label: { identifier: "first-11111111", name: "First" },
        attestations: { tierA: 3, tierB: 0, unmatched: 0 },
        accountsTierA: 2,
      },
      { indexId: INDEX_2, label: null, attestations: { tierA: 0, tierB: 1, unmatched: 1 }, accountsTierA: 0 },
    ]);
  });

  test("every metric carries its definition, chain, block range and computation time", () => {
    for (const metric of Object.values(metrics)) {
      expect(metric).toMatchObject({ chainId: 31_337, fromBlock: 50n, toBlock: 500n, computedAt: 1_800_000_000 });
    }
    const ids = Object.values(metrics).map(({ id }) => id);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(METRIC_DEFINITIONS.map(({ id }) => id).sort());
  });

  test("usage metrics stop at the last block whose attestations are all classified", () => {
    const partial = buildNetworkMetrics({ ...metricsInput(), usageToBlock: 120n });
    expect(partial.attestations.toBlock).toBe(120n);
    expect(partial.indexesPublished.toBlock).toBe(500n);
  });
});

describe("spansEnoughDays", () => {
  test("a series is drawn from seven UTC days, first to last inclusive", () => {
    expect(spansEnoughDays([])).toBe(false);
    expect(spansEnoughDays([{ day: "2026-11-16", count: 4 }])).toBe(false);
    expect(
      spansEnoughDays([
        { day: "2026-11-16", count: 1 },
        { day: "2026-11-21", count: 1 },
      ]),
    ).toBe(false);
    expect(
      spansEnoughDays([
        { day: "2026-11-16", count: 1 },
        { day: "2026-11-22", count: 1 },
      ]),
    ).toBe(true);
  });
});

describe("parseExcludedAccounts", () => {
  test("reads address and label pairs, lowercased, and nothing when unset", () => {
    expect(parseExcludedAccounts(undefined)).toEqual([]);
    expect(parseExcludedAccounts("  ")).toEqual([]);
    expect(
      parseExcludedAccounts(`0x00000000000000000000000000000000000A11CE=Team wallet, ${BOB}=Test account`),
    ).toEqual([
      { address: ALICE, label: "Team wallet" },
      { address: BOB, label: "Test account" },
    ]);
  });

  test("refuses a malformed entry or a repeated address instead of cutting the list short", () => {
    for (const raw of [ALICE, `${ALICE}=`, "0x123=Short", `${ALICE}=a=b`, `${ALICE}=One,${ALICE}=Two`]) {
      expect(() => parseExcludedAccounts(raw)).toThrow(RegistryConfigurationError);
    }
  });
});
