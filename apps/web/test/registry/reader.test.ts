import { describe, expect, test } from "bun:test";
import { BASE_MAINNET_CHAIN_ID, BASE_SEPOLIA_CHAIN_ID } from "@equityos/contracts-abi";
import { specHash } from "@equityos/core";
import { bytesToHex } from "viem";
import {
  createRegistryCaches,
  createRegistryReader,
  HEADS_CACHE,
  type IndexSummary,
  MAX_PAGE_SIZE,
  RegistryConfigurationError,
  type RegistryReader,
  RegistryUpstreamError,
  resolveRegistryConfig,
} from "../../src/server/registry";
import {
  buildSpec,
  CHAIN_ID,
  CREATOR,
  FakeChain,
  indexIdOf,
  OTHER_CREATOR,
  REGISTRY,
  testClock,
  testConfig,
} from "./support";

function setup(chain = new FakeChain()) {
  const clock = testClock();
  const reader = createRegistryReader({ config: testConfig(), client: chain.client(), now: clock.now });
  return { chain, clock, reader };
}

async function listAll(reader: RegistryReader): Promise<readonly IndexSummary[]> {
  const page = await reader.listIndexes({ limit: MAX_PAGE_SIZE });
  if (page.status !== "ok") throw new Error(`unexpected status ${page.status}`);
  return page.indexes;
}

async function resolve(reader: RegistryReader, identifier: string): Promise<IndexSummary | string> {
  const result = await reader.getIndex(identifier);
  return result.status === "ok" ? result.index : result.status;
}

const NOT_JSON = new TextEncoder().encode("not a spec");

describe("a chain without the registry", () => {
  test.each([BASE_MAINNET_CHAIN_ID, BASE_SEPOLIA_CHAIN_ID])(
    "chain %d has no deploy block, so every read is registry_not_deployed and no request is made",
    async (chainId) => {
      const chain = new FakeChain({ chainId });
      chain.createIndex(buildSpec());
      const config = resolveRegistryConfig({ EQUITYOS_CHAIN_ID: String(chainId) });
      const reader = createRegistryReader({ config, client: chain.client() });
      const absent = {
        status: "registry_not_deployed",
        chainId,
        registry: config.deployment.registry,
        reason: "not_configured",
      } as const;
      expect(await reader.listIndexes()).toEqual(absent);
      expect(await reader.getIndex(indexIdOf("ab"))).toEqual(absent);
      expect(await reader.getVersion(indexIdOf("ab"), 1)).toEqual(absent);
      expect(await reader.listVersions(indexIdOf("ab"))).toEqual(absent);
      expect(await reader.getEvents()).toEqual(absent);
      expect(chain.methods).toEqual([]);
    },
  );

  test("the default production environment, without any RPC endpoint, is registry_not_deployed", async () => {
    const reader = createRegistryReader({ config: resolveRegistryConfig({ NODE_ENV: "production" }) });
    expect(await reader.listIndexes()).toMatchObject({ status: "registry_not_deployed", chainId: 8453 });
    expect(await reader.getEvents()).toMatchObject({ status: "registry_not_deployed", reason: "not_configured" });
  });

  test("an address without code is registry_not_deployed, never an empty list", async () => {
    const { chain, reader } = setup();
    chain.deployed = false;
    const absent = {
      status: "registry_not_deployed",
      chainId: CHAIN_ID,
      registry: REGISTRY,
      reason: "no_code",
    } as const;
    expect(await reader.listIndexes()).toEqual(absent);
    expect(await reader.getIndex(indexIdOf("ab"))).toEqual(absent);
    expect(await reader.getVersion(indexIdOf("ab"), 1)).toEqual(absent);
    expect(await reader.listVersions(indexIdOf("ab"))).toEqual(absent);
    expect(await reader.getEvents()).toEqual(absent);
    expect(chain.methods).toEqual(["eth_chainId", "eth_getCode"]);
    expect(chain.calls).toEqual([]);
  });

  test("the absence is asked again after the TTL and the presence is never asked again", async () => {
    const { chain, clock, reader } = setup();
    chain.deployed = false;
    expect((await reader.listIndexes()).status).toBe("registry_not_deployed");
    chain.deployed = true;
    clock.advance(HEADS_CACHE.ttlSeconds - 1);
    expect((await reader.listIndexes()).status).toBe("registry_not_deployed");
    clock.advance(1);
    expect(await reader.listIndexes()).toEqual({ status: "ok", total: 0, offset: 0, indexes: [] });
    clock.advance(10 * HEADS_CACHE.ttlSeconds);
    await reader.listIndexes();
    expect(chain.methods.filter((method) => method === "eth_getCode")).toHaveLength(2);
    expect(chain.methods.filter((method) => method === "eth_chainId")).toHaveLength(1);
  });

  test("an endpoint of another chain is a configuration error", async () => {
    const chain = new FakeChain({ chainId: 8453 });
    const reader = createRegistryReader({ config: testConfig(), client: chain.client() });
    const error = await reader.listIndexes().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RegistryConfigurationError);
    expect(error).toMatchObject({ code: "missing_configuration", variable: "EQUITYOS_CHAIN_ID" });
    expect(chain.calls).toEqual([]);
  });
});

describe("listIndexes", () => {
  test("a deployed registry without indexes is an empty page", async () => {
    const { chain, reader } = setup();
    expect(await reader.listIndexes()).toEqual({ status: "ok", total: 0, offset: 0, indexes: [] });
    expect(chain.calls).toEqual(["indexCount"]);
  });

  test("returns the onchain facts, the verified spec and the report of each index", async () => {
    const { chain, reader } = setup();
    const published = buildSpec({ slug: "alpha", weightsBps: [6_000, 4_000] });
    const indexId = chain.createIndex({ ...published, indexId: indexIdOf("a1b2c3d4e5") });
    const [index] = await listAll(reader);
    expect(index).toEqual({
      position: 0,
      identifier: "alpha-a1b2c3d4",
      head: {
        indexId,
        creator: CREATOR,
        latestVersion: 1,
        createdAt: chain.timestampOf(chain.blockNumber),
        deprecatedAt: null,
      },
      latest: {
        chainId: CHAIN_ID,
        registry: REGISTRY,
        indexId,
        version: 1,
        creator: CREATOR,
        specHash: specHash(published.specBytes),
        publishedAt: chain.timestampOf(chain.blockNumber),
        publishedBlock: chain.blockNumber,
        composition: "static",
        specBytes: bytesToHex(published.specBytes),
        constituents: published.constituents,
        conformant: true,
        spec: published.spec,
        verification: { checks: expect.any(Array), specErrors: [] },
      },
    });
    expect(index?.latest.verification.checks.map(({ id, status }) => `${id}:${status}`)).toEqual([
      "C1:pass",
      "C2:pass",
      "C3:pass",
      "C4:pass",
      "C5:pass",
    ]);
  });

  test("pages through the indexes in creation order", async () => {
    const { chain, reader } = setup();
    const ids = Array.from({ length: 7 }, () => chain.createIndex(buildSpec()));
    const page = async (offset: number, limit: number) => {
      const result = await reader.listIndexes({ offset, limit });
      if (result.status !== "ok") throw new Error(result.status);
      expect(result.total).toBe(7);
      expect(result.offset).toBe(offset);
      return result.indexes.map(({ head, position }) => [position, head.indexId]);
    };
    const expected = ids.map((indexId, position) => [position, indexId]);
    expect(await page(0, 3)).toEqual(expected.slice(0, 3));
    expect(await page(3, 3)).toEqual(expected.slice(3, 6));
    expect(await page(6, 3)).toEqual(expected.slice(6));
    expect(await page(7, 3)).toEqual([]);
    expect(await page(100, 3)).toEqual([]);
  });

  test("reads only the heads and versions of the requested page", async () => {
    const { chain, reader } = setup();
    for (let i = 0; i < 7; i += 1) chain.createIndex(buildSpec());
    await reader.listIndexes({ offset: 2, limit: 2 });
    const count = (name: string) => chain.calls.filter((call) => call === name).length;
    expect(count("indexIdAt")).toBe(7);
    expect(count("getIndex")).toBe(2);
    expect(count("getVersion")).toBe(2);
    expect(count("specOf")).toBe(2);
    expect(count("constituentsOf")).toBe(2);
  });

  test("reads the ids of a large registry in several multicall requests and only once", async () => {
    const { chain, clock, reader } = setup();
    for (let i = 0; i < 500; i += 1) chain.createIndex(buildSpec());
    const first = await reader.listIndexes({ limit: 1 });
    expect(first).toMatchObject({ status: "ok", total: 500 });
    expect(chain.calls.filter((call) => call === "indexIdAt")).toHaveLength(500);
    // indexCount, two requests of ids, then the head and the three parts of one version.
    expect(chain.methods.filter((method) => method === "eth_call")).toHaveLength(1 + 2 + 1 + 3);
    chain.createIndex(buildSpec());
    clock.advance(HEADS_CACHE.ttlSeconds);
    expect(await reader.listIndexes({ offset: 500 })).toMatchObject({ total: 501, indexes: [{ position: 500 }] });
    expect(chain.calls.filter((call) => call === "indexIdAt")).toHaveLength(501);
  });

  test.each([{ offset: -1 }, { offset: 1.5 }, { limit: 0 }, { limit: MAX_PAGE_SIZE + 1 }, { limit: Number.NaN }])(
    "rejects the page %o",
    async (page) => {
      const { reader } = setup();
      await expect(reader.listIndexes(page)).rejects.toBeInstanceOf(RangeError);
    },
  );
});

describe("a version that is not conformant", () => {
  test("bytes that are not a spec are listed with their report, without a spec", async () => {
    const { chain, reader } = setup();
    const indexId = chain.createIndex({ specBytes: NOT_JSON, constituents: buildSpec().constituents });
    const [index] = await listAll(reader);
    expect(index?.identifier).toBe(indexId);
    expect(index?.latest).toMatchObject({ conformant: false, spec: null, specBytes: bytesToHex(NOT_JSON) });
    expect(index?.latest.verification.checks.map(({ id, status }) => `${id}:${status}`)).toEqual([
      "C1:pass",
      "C2:fail",
      "C3:skipped",
      "C4:skipped",
      "C5:skipped",
    ]);
  });

  test("a schema-valid spec for another chain is not exposed", async () => {
    const { chain, reader } = setup();
    chain.createIndex(buildSpec({ chainId: 8453 }));
    const [index] = await listAll(reader);
    expect(index?.latest.conformant).toBe(false);
    expect(index?.latest.spec).toBeNull();
    expect(index?.latest.verification.checks[3]).toMatchObject({ id: "C4", status: "fail", code: "chain_mismatch" });
    expect(JSON.stringify(index, (_, value) => (typeof value === "bigint" ? String(value) : value))).not.toContain(
      '"slug"',
    );
  });

  test("a spec whose stored composition differs is not exposed", async () => {
    const { chain, reader } = setup();
    const published = buildSpec({ weightsBps: [6_000, 4_000] });
    const constituents = published.constituents.map(({ token }) => ({ token, weightBps: 5_000 }));
    const indexId = chain.createIndex({ specBytes: published.specBytes, constituents });
    const [index] = await listAll(reader);
    expect(index?.identifier).toBe(indexId);
    expect(index?.latest).toMatchObject({ conformant: false, spec: null, constituents });
    expect(index?.latest.verification.checks[4]).toMatchObject({ id: "C5", status: "fail", code: "weight_mismatch" });
  });

  test("a dynamic-weights mirror of a valid spec is not conformant", async () => {
    const { chain, reader } = setup();
    const published = buildSpec();
    const constituents = published.constituents.map(({ token }) => ({ token, weightBps: 0 }));
    chain.createIndex({ specBytes: published.specBytes, constituents, composition: 1 });
    const [index] = await listAll(reader);
    expect(index?.latest).toMatchObject({ conformant: false, spec: null, composition: "dynamic_weights" });
  });

  test("it is returned next to conformant indexes, not dropped", async () => {
    const { chain, reader } = setup();
    chain.createIndex(buildSpec({ slug: "first" }));
    chain.createIndex({ specBytes: NOT_JSON, constituents: [], composition: 0 });
    chain.createIndex(buildSpec({ slug: "third" }));
    expect((await listAll(reader)).map(({ latest }) => latest.conformant)).toEqual([true, false, true]);
  });
});

describe("getIndex", () => {
  test("resolves the canonical identifier and the index id, in any letter case", async () => {
    const { chain, reader } = setup();
    const indexId = chain.createIndex({ ...buildSpec({ slug: "alpha" }), indexId: indexIdOf("a1b2c3d4e5") });
    const expected = { position: 0, identifier: "alpha-a1b2c3d4", head: expect.objectContaining({ indexId }) };
    expect(await resolve(reader, "alpha-a1b2c3d4")).toMatchObject(expected);
    expect(await resolve(reader, indexId)).toMatchObject(expected);
    expect(await resolve(reader, `0x${indexId.slice(2).toUpperCase()}`)).toMatchObject(expected);
  });

  test("requires both the slug and the prefix to match", async () => {
    const { chain, reader } = setup();
    chain.createIndex({ ...buildSpec({ slug: "alpha" }), indexId: indexIdOf("a1b2c3d4e5") });
    chain.createIndex({ ...buildSpec({ slug: "beta" }), indexId: indexIdOf("ffff0000") });
    expect(await resolve(reader, "beta-a1b2c3d4")).toBe("index_not_found");
    expect(await resolve(reader, "alpha-ffff0000")).toBe("index_not_found");
    expect(await resolve(reader, "alpha-a1b2c3d5")).toBe("index_not_found");
    expect(await resolve(reader, "alpha-a1b2c3d4e")).toBe("index_not_found");
    expect(await resolve(reader, "alpha-a1b2c3d4")).toMatchObject({ position: 0 });
    expect(await resolve(reader, "beta-ffff0000")).toMatchObject({ position: 1 });
  });

  test("a later index with the same leading digits and slug cannot take or blur an identifier", async () => {
    const { chain, reader } = setup();
    const first = chain.createIndex({ ...buildSpec({ slug: "alpha" }), indexId: indexIdOf("a1b2c3d4e5") });
    const squatter = chain.createIndex({
      ...buildSpec({ slug: "alpha" }),
      indexId: indexIdOf("a1b2c3d4e6"),
      creator: OTHER_CREATOR,
    });
    const [original, later] = await listAll(reader);
    expect(original?.identifier).toBe("alpha-a1b2c3d4");
    expect(later?.identifier).toBe("alpha-a1b2c3d4e6");
    expect(await resolve(reader, "alpha-a1b2c3d4")).toMatchObject({ head: { indexId: first, creator: CREATOR } });
    expect(await resolve(reader, "alpha-a1b2c3d4e6")).toMatchObject({ head: { indexId: squatter } });
    expect(await resolve(reader, "alpha-a1b2c3d4e5")).toBe("index_not_found");
  });

  test("an index whose latest version is not conformant resolves by index id only", async () => {
    const { chain, reader } = setup();
    const indexId = chain.createIndex({
      ...buildSpec({ slug: "alpha", chainId: 8453 }),
      indexId: indexIdOf("a1b2c3d4"),
    });
    expect(await resolve(reader, "alpha-a1b2c3d4")).toBe("index_not_found");
    expect(await resolve(reader, indexId)).toMatchObject({ identifier: indexId });
  });

  test("the identifier follows the slug of the latest version", async () => {
    const { chain, clock, reader } = setup();
    const indexId = chain.createIndex({ ...buildSpec({ slug: "alpha" }), indexId: indexIdOf("a1b2c3d4") });
    expect(await resolve(reader, "alpha-a1b2c3d4")).toMatchObject({ position: 0 });
    chain.publishVersion(indexId, buildSpec({ slug: "renamed" }));
    clock.advance(HEADS_CACHE.ttlSeconds);
    expect(await resolve(reader, "alpha-a1b2c3d4")).toBe("index_not_found");
    expect(await resolve(reader, "renamed-a1b2c3d4")).toMatchObject({ head: { latestVersion: 2 } });
    expect(await resolve(reader, indexId)).toMatchObject({ identifier: "renamed-a1b2c3d4" });
  });

  test("an unknown index id is index_not_found and a malformed identifier is invalid_identifier", async () => {
    const { chain, reader } = setup();
    chain.createIndex(buildSpec());
    expect(await resolve(reader, indexIdOf("00"))).toBe("index_not_found");
    for (const identifier of ["", "alpha", "alpha-123", "Alpha-a1b2c3d4", "alpha-A1B2C3D4", "0x1234", "-a1b2c3d4"]) {
      expect(await resolve(reader, identifier)).toBe("invalid_identifier");
    }
  });
});

describe("getVersion and listVersions", () => {
  test("read each version of an index", async () => {
    const { chain, reader } = setup();
    const v1 = buildSpec({ slug: "alpha" });
    const v2 = buildSpec({ slug: "alpha", weightsBps: [7_000, 3_000] });
    const indexId = chain.createIndex(v1);
    chain.publishVersion(indexId, v2);
    expect(await reader.getVersion(indexId, 1)).toMatchObject({
      status: "ok",
      version: { version: 1, specHash: specHash(v1.specBytes), spec: v1.spec, publishedBlock: chain.blockNumber - 1n },
    });
    expect(await reader.getVersion(indexId, 2)).toMatchObject({
      status: "ok",
      version: { version: 2, specHash: specHash(v2.specBytes), spec: v2.spec, publishedBlock: chain.blockNumber },
    });
    const all = await reader.listVersions(indexId);
    expect(all).toMatchObject({ status: "ok", total: 2, offset: 0, versions: [{ version: 1 }, { version: 2 }] });
    expect(await reader.listVersions(indexId, { offset: 1, limit: 1 })).toMatchObject({
      total: 2,
      offset: 1,
      versions: [{ version: 2, conformant: true }],
    });
  });

  test("a version outside 1 to latestVersion is version_not_found without a read", async () => {
    const { chain, reader } = setup();
    const indexId = chain.createIndex(buildSpec());
    for (const version of [0, 2, -1, 1.5, Number.NaN]) {
      expect(await reader.getVersion(indexId, version)).toEqual({ status: "version_not_found" });
    }
    expect(chain.calls).not.toContain("getVersion");
    expect(await reader.getVersion(indexIdOf("00"), 1)).toEqual({ status: "index_not_found" });
    expect(await reader.listVersions(indexIdOf("00"))).toEqual({ status: "index_not_found" });
  });
});

describe("caching", () => {
  test("a version is read once, the head again after its TTL", async () => {
    const { chain, clock, reader } = setup();
    const indexId = chain.createIndex(buildSpec());
    await reader.getVersion(indexId, 1);
    const callsAfterFirstRead = chain.calls.length;
    clock.advance(HEADS_CACHE.ttlSeconds - 1);
    await reader.getVersion(indexId, 1);
    await reader.listIndexes();
    expect(chain.calls).toHaveLength(callsAfterFirstRead);
    clock.advance(1);
    await reader.getVersion(indexId, 1);
    expect(chain.calls.slice(callsAfterFirstRead)).toEqual(["indexCount", "getIndex"]);
    clock.advance(1_000_000);
    await reader.listIndexes();
    expect(chain.calls.filter((call) => call === "specOf")).toHaveLength(1);
  });

  test("a new version and a deprecation are seen after the head TTL", async () => {
    const { chain, clock, reader } = setup();
    const indexId = chain.createIndex(buildSpec());
    expect(await reader.getVersion(indexId, 2)).toEqual({ status: "version_not_found" });
    chain.publishVersion(indexId, buildSpec({ weightsBps: [10_000] }));
    chain.deprecate(indexId);
    expect(await reader.getVersion(indexId, 2)).toEqual({ status: "version_not_found" });
    clock.advance(HEADS_CACHE.ttlSeconds);
    expect(await reader.getVersion(indexId, 2)).toMatchObject({ status: "ok", version: { version: 2 } });
    expect(await resolve(reader, indexId)).toMatchObject({
      head: { latestVersion: 2, deprecatedAt: chain.timestampOf(chain.blockNumber) },
    });
  });

  test("concurrent reads share one load of the count, the head and the version", async () => {
    const { chain, reader } = setup();
    const indexId = chain.createIndex(buildSpec());
    await Promise.all([reader.getVersion(indexId, 1), reader.getVersion(indexId, 1), reader.getIndex(indexId)]);
    expect([...chain.calls].sort()).toEqual(
      ["constituentsOf", "getIndex", "getVersion", "indexCount", "indexIdAt", "specOf"].sort(),
    );
  });

  test("shared caches never serve one chain or one registry with the data of another", async () => {
    const clock = testClock();
    const caches = createRegistryCaches(clock.now);
    const indexId = indexIdOf("a1b2c3d4");
    const otherRegistry = "0x00000000000000000000000000000000000000aa";
    const chains = [
      new FakeChain(),
      new FakeChain({ chainId: 31_337 }),
      new FakeChain({ registry: otherRegistry }),
    ] as const;
    const slugs = ["on-sepolia", "on-local", "other-registry"];
    const readers = chains.map((chain, i) => {
      chain.createIndex({ ...buildSpec({ slug: slugs[i] ?? "", chainId: chain.chainId }), indexId });
      const deployment = { ...testConfig().deployment, registry: chain.registry };
      const config = testConfig({ chainId: chain.chainId, deployment });
      return createRegistryReader({ config, client: chain.client(), now: clock.now, caches });
    });
    for (const [i, reader] of readers.entries()) {
      expect(await reader.getVersion(indexId, 1)).toMatchObject({ version: { spec: { slug: slugs[i] } } });
      expect(await resolve(reader, indexId)).toMatchObject({ identifier: `${slugs[i]}-a1b2c3d4` });
    }
    for (const chain of chains) expect(chain.calls.filter((call) => call === "specOf")).toHaveLength(1);
  });
});

describe("upstream failures", () => {
  test("a failed request is a typed error and is not cached", async () => {
    const { chain, reader } = setup();
    chain.createIndex(buildSpec());
    chain.fail = (method) => method === "eth_call";
    const error = await reader.listIndexes().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RegistryUpstreamError);
    expect(error).toMatchObject({ code: "upstream_failure" });
    chain.fail = () => false;
    expect(await reader.listIndexes()).toMatchObject({ status: "ok", total: 1 });
  });

  test("a failed presence check is an error, not registry_not_deployed", async () => {
    const { chain, reader } = setup();
    chain.fail = (method) => method === "eth_getCode";
    await expect(reader.listIndexes()).rejects.toBeInstanceOf(RegistryUpstreamError);
  });

  test("a head past its TTL is not served when the reload fails", async () => {
    const { chain, clock, reader } = setup();
    const indexId = chain.createIndex(buildSpec());
    await reader.getVersion(indexId, 1);
    clock.advance(HEADS_CACHE.ttlSeconds + 1);
    chain.fail = (method) => method === "eth_call";
    await expect(reader.getVersion(indexId, 1)).rejects.toBeInstanceOf(RegistryUpstreamError);
  });
});
