import { describe, expect, test } from "bun:test";
import { createClient, RegistryNotDeployedError, ResponseShapeError } from "../src/index.ts";
import { example, exampleFetch, mockFetch } from "./support.ts";

describe("getNetworkMetrics", () => {
  test("GETs /network and decodes the recorded metrics, block numbers and values as bigint", async () => {
    const mock = exampleFetch("getNetworkMetrics");
    const client = createClient({ baseUrl: "https://equityos.example", fetch: mock.fetch });
    const { data, meta } = await client.getNetworkMetrics();
    expect(mock.calls[0]?.url).toBe("https://equityos.example/api/v1/network");
    expect(meta.registry).toEqual({ chainId: 31_337, address: data.registry, mode: "replay" });
    expect(data.metrics.attestationsTierA).toMatchObject({ id: "usage.attestations_tier_a", value: 3, fromBlock: 0n });
    expect(data.metrics.tierAReferenceValueUsdE8.value).toBe(230_000_000_000n);
    expect(data.thresholds.minimumNotionalUsdE8).toBe(100_000_000n);
    expect(data.attestations.map(({ tier }) => tier)).toEqual(["a", "unmatched", "unmatched", "b", "a", "a"]);
    expect(typeof data.attestations[0]?.blockNumber).toBe("bigint");
    expect(data.definitions.map(({ id }) => id)).toContain("volume.tier_a_reference_value");
  });

  test("a chain without the registry is a typed RegistryNotDeployedError", async () => {
    const client = createClient({
      baseUrl: "https://equityos.example",
      fetch: exampleFetch("getNetworkMetrics.registryNotDeployed").fetch,
    });
    const error = await client.getNetworkMetrics().catch((rejection: unknown) => rejection);
    expect(error).toBeInstanceOf(RegistryNotDeployedError);
    expect(error).toMatchObject({ status: 409, chainId: 8453, reason: "not_configured" });
  });

  test("a metric without its block range is refused, never returned half decoded", async () => {
    const { body } = example("getNetworkMetrics");
    const broken = structuredClone(body) as { data: { metrics: { attestations: Record<string, unknown> } } };
    delete broken.data.metrics.attestations.toBlock;
    const client = createClient({
      baseUrl: "https://equityos.example",
      fetch: mockFetch(() => Response.json(broken)).fetch,
    });
    await expect(client.getNetworkMetrics()).rejects.toBeInstanceOf(ResponseShapeError);
  });
});
