import { describe, expect, test } from "bun:test";
import { API_VERSION_HEADER } from "../../src/server/api/http";
import { networkHandler } from "../../src/server/api/network";
import { createNetworkService, METRIC_DEFINITIONS } from "../../src/server/network";
import { RegistryUpstreamError, resolveRegistryConfig } from "../../src/server/registry";
import { createRegistryReader } from "../../src/server/registry/reader";
import { constructedRead, EXCLUDED_SEED_ACCOUNT, recordedNetwork, stubNetwork, TEAM } from "../network/support";
import { get } from "./support";

const NOW = 1_800_000_000;

function handler(network = stubNetwork(constructedRead())) {
  return networkHandler({ network, mode: () => "replay", now: () => NOW });
}

/** The real service on Base mainnet, where the registry is not deployed: no request is made. */
function notDeployed() {
  const config = resolveRegistryConfig({});
  const service = createNetworkService({
    reader: createRegistryReader({ config }),
    config,
    client: () => {
      throw new Error("no request is expected");
    },
    exclusions: [],
    now: () => NOW,
  });
  return networkHandler({ network: () => service, mode: () => "live", now: () => NOW });
}

describe("GET /api/v1/network on the recorded local chain", () => {
  test("classifies each example attestation of the seed from its logs, receipts and reads at its block", async () => {
    const { data } = await (await recordedNetwork()(get("/api/v1/network"), undefined)).json();
    const rows = [...data.attestations].reverse().map(({ account, tier, reason, valueUsdE8, tracking, excluded }) => ({
      account,
      tier,
      reason,
      valueUsdE8,
      tracking: tracking?.status ?? null,
      excluded,
    }));
    expect(rows).toEqual([
      {
        account: "0x5eed00000000000000000000000000000000000a",
        tier: "a",
        reason: null,
        valueUsdE8: "100000000000",
        tracking: "within",
        excluded: false,
      },
      {
        account: "0x5eed00000000000000000000000000000000000b",
        tier: "a",
        reason: null,
        valueUsdE8: "30000000000",
        tracking: "outside",
        excluded: false,
      },
      {
        account: "0x70997970c51812dc3a010c7d01b50e0d17dc79c8",
        tier: "b",
        reason: "no_constituent_flows",
        valueUsdE8: "10000000000",
        tracking: null,
        excluded: false,
      },
      {
        account: "0x5eed00000000000000000000000000000000000d",
        tier: "unmatched",
        reason: "below_minimum_notional",
        valueUsdE8: null,
        tracking: null,
        excluded: false,
      },
      {
        account: "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc",
        tier: "unmatched",
        reason: "no_constituent_flows",
        valueUsdE8: null,
        tracking: null,
        excluded: false,
      },
      {
        account: EXCLUDED_SEED_ACCOUNT,
        tier: "a",
        reason: null,
        valueUsdE8: "100000000000",
        tracking: "within",
        excluded: true,
      },
    ]);
    const value = (name: string) => data.metrics[name].value;
    expect(["indexesPublished", "versionsPublished", "distinctCreators", "indexesDeprecated"].map(value)).toEqual([
      5, 6, 1, 1,
    ]);
    expect(["attestations", "attestationsTierA", "attestationsTierB", "attestationsUnmatched"].map(value)).toEqual([
      5, 2, 1, 2,
    ]);
    expect(["accountsTierA", "accountsWithinTolerance", "tierAReferenceValueUsdE8"].map(value)).toEqual([
      2,
      1,
      "130000000000",
    ]);
    expect(value("excludedActivity")).toEqual({
      indexes: 0,
      versions: 0,
      attestations: { tierA: 1, tierB: 0, unmatched: 0 },
    });
    expect(data.metrics.attestations).toMatchObject({ chainId: 31_337, fromBlock: "0", toBlock: "29" });
  });

  test("a deployed registry without activity answers zeros, which are the true counts", async () => {
    const { data } = await (await recordedNetwork("registry-empty")(get("/api/v1/network"), undefined)).json();
    expect(data.scan).toEqual({
      fromBlock: "0",
      scannedToBlock: "2",
      targetBlock: "2",
      complete: true,
      usageComplete: true,
    });
    expect(data.metrics.indexesPublished.value).toBe(0);
    expect(data.metrics.attestations.value).toBe(0);
    expect(data.metrics.byIndex.value).toEqual([]);
    expect(data.attestations).toEqual([]);
  });
});

describe("GET /api/v1/network", () => {
  test("returns every metric with its definition id, chain, block range and computation time", async () => {
    const response = await handler()(get("/api/v1/network"), undefined);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=10");
    expect(response.headers.get(API_VERSION_HEADER)).toBe("1.3.0");
    const { data, meta } = await response.json();
    expect(meta).toEqual({
      asOf: "2027-01-15T08:00:00Z",
      registry: { chainId: 31_337, address: "0x4bd4d49a9c88f75fb97674488e23a7fa59f9506c", mode: "replay" },
    });
    expect(data.metrics.indexesPublished).toEqual({
      id: "registry.indexes_published",
      value: 2,
      chainId: 31_337,
      fromBlock: "50",
      toBlock: "500",
      computedAt: "2027-01-15T08:00:00Z",
    });
    expect(data.metrics.tierAReferenceValueUsdE8.value).toBe("750000000");
    expect(
      Object.values(data.metrics)
        .map((metric) => (metric as { id: string }).id)
        .sort(),
    ).toEqual(METRIC_DEFINITIONS.map(({ id }) => id).sort());
    expect(data.definitions).toHaveLength(METRIC_DEFINITIONS.length);
    expect(data.thresholds).toEqual({
      minimumNotionalUsdE8: "100000000",
      tierBWindowSeconds: 900,
      toleranceMarginBps: 200,
    });
    expect(data.exclusions).toEqual([{ address: TEAM, label: "Team test account" }]);
  });

  test("lists attestations newest first, with their tier, evidence and whether they are excluded", async () => {
    const { data } = await (await handler()(get("/api/v1/network"), undefined)).json();
    expect(data.attestations).toHaveLength(7);
    expect(data.attestations[0]).toMatchObject({ account: TEAM, tier: "unmatched", excluded: true, tracking: null });
    expect(data.attestations.at(-1)).toMatchObject({
      tier: "a",
      reason: null,
      valueUsdE8: "250000000",
      excluded: false,
      tracking: { status: "within", reason: null, maxDriftBps: 10, toleranceBps: 700 },
    });
    expect(data.attestations[4].tracking).toEqual({
      status: "not_assessed",
      reason: "not_static",
      maxDriftBps: null,
      toleranceBps: null,
    });
  });

  test("answers the not-deployed state as the index endpoints do", async () => {
    const response = await notDeployed()(get("/api/v1/network"), undefined);
    expect(response.status).toBe(409);
    expect((await response.json()).error).toMatchObject({
      code: "registry_not_deployed",
      details: { chainId: 8453, reason: "not_configured" },
    });
  });

  test("refuses any query parameter and reports a failed read as unavailable", async () => {
    expect((await handler()(get("/api/v1/network?days=7"), undefined)).status).toBe(400);
    const down = await handler(stubNetwork(new RegistryUpstreamError("eth_getLogs failed")))(
      get("/api/v1/network"),
      undefined,
    );
    expect(down.status).toBe(503);
    expect((await down.json()).error.details).toEqual({ source: "registry_rpc" });
  });
});
