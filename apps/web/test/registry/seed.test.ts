import { afterEach, describe, expect, test } from "bun:test";
import { verifyVersion } from "@equityos/core";
import { numberToHex } from "viem";
import { buildSeedIndexes } from "../../scripts/seed/indexes";
import { SeedRefusedError, seedLocal } from "../../scripts/seed-local";
import { REFERENCE_FEEDS } from "../../src/server/market/feeds";

/** A local JSON-RPC endpoint that reports a chain id and no code anywhere, and records the methods called. */
function rpcEndpoint(chainId: number) {
  const methods: string[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const { id, method }: { id: number; method: string } = await request.json();
      methods.push(method);
      const results: Record<string, string> = { eth_chainId: numberToHex(chainId), eth_getCode: "0x" };
      const result = results[method];
      return Response.json(
        result === undefined
          ? { jsonrpc: "2.0", id, error: { code: -32601, message: `unexpected method ${method}` } }
          : { jsonrpc: "2.0", id, result },
      );
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, methods, stop: () => server.stop(true) };
}

describe("seedLocal", () => {
  let endpoint: ReturnType<typeof rpcEndpoint> | undefined;
  afterEach(() => endpoint?.stop());

  test.each([8453, 84_532, 1, 31_338])("refuses chain %d before touching an account", async (chainId) => {
    endpoint = rpcEndpoint(chainId);
    const error = await seedLocal(endpoint.url).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SeedRefusedError);
    expect(error).toMatchObject({ chainId });
    expect(endpoint.methods).toEqual(["eth_chainId"]);
  });

  test("sends nothing to a local chain without the registry", async () => {
    endpoint = rpcEndpoint(31_337);
    await expect(seedLocal(endpoint.url)).rejects.toThrow("no IndexRegistry at");
    expect(endpoint.methods).toEqual(["eth_chainId", "eth_getCode"]);
  });
});

describe("buildSeedIndexes", () => {
  const seeds = buildSeedIndexes(31_337);
  const versions = seeds.flatMap((seed) => seed.versions);

  test("is an index that fails verification, a deprecated one, and three conformant ones", () => {
    expect(seeds.map((seed) => seed.versions.map(({ spec }) => spec.weighting.type))).toEqual([
      ["equal"],
      ["equal"],
      ["equal"],
      ["fixed"],
      ["equal", "fixed"],
    ]);
    expect(seeds.map(({ deprecated }) => deprecated)).toEqual([false, true, false, false, false]);
    expect(seeds[1]?.versions[0]?.tokens).toHaveLength(1);
    expect(seeds[3]?.versions[0]?.spec.constraints).toEqual({ maxWeightBps: 5_000, minWeightBps: 1_000 });
    expect(new Set(seeds.map(({ salt }) => salt)).size).toBe(5);
    for (const { salt } of seeds) expect(salt).toMatch(/^0x[0-9a-f]{64}$/);
  });

  test("every version is conformant with the composition the seed publishes, except the mismatched example", () => {
    for (const [position, seed] of seeds.entries()) {
      for (const version of seed.versions) {
        const constituents = version.tokens.map((token, i) => ({ token, weightBps: version.weightsBps[i] ?? 0 }));
        const report = verifyVersion({
          specBytes: version.specBytes,
          specHash: version.specHash,
          constituents,
          chainId: 31_337,
        });
        expect(report.checks.map(({ status }) => status)).toEqual([
          "pass",
          "pass",
          "pass",
          "pass",
          position === 0 ? "fail" : "pass",
        ]);
        // The registry rejects a static composition whose weights do not sum to 10,000 bps.
        expect(version.weightsBps.reduce((sum, weight) => sum + weight, 0)).toBe(10_000);
      }
    }
    expect(seeds[0]?.versions[0]?.weightsBps).toEqual([6_000, 4_000]);
  });

  test("every constituent is a feed-covered token with its own feed proxy", () => {
    for (const { spec } of versions) {
      spec.universe.tokens.forEach((token, i) => {
        expect(REFERENCE_FEEDS.get(token)?.proxy.toLowerCase()).toBe(spec.pricing.feeds[i] ?? "");
      });
    }
  });

  test("a spec is for the chain it is built for, so its hash differs between chains", () => {
    expect(versions.every(({ spec }) => spec.chainId === 31_337)).toBe(true);
    expect(buildSeedIndexes(8453)[0]?.versions[0]?.specHash).not.toBe(versions[0]?.specHash);
  });

  test("descriptions state the composition and nothing else", () => {
    for (const { spec } of versions) {
      expect(spec.description).not.toMatch(/return|profit|buy|sell|invest|recommend|outperform|best|guarantee/i);
    }
  });
});
