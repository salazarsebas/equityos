import { describe, expect, test } from "bun:test";
import { specHash } from "@equityos/core";
import { hexToBytes } from "viem";
import {
  indexCompositionHandler,
  indexesHandler,
  indexHandler,
  indexVersionHandler,
} from "../../src/server/api/indexes";
import { resolveRegistryConfig } from "../../src/server/registry/config";
import { createRegistryReader, type RegistryReader } from "../../src/server/registry/reader";
import { TOKENS } from "../market/support";
import { buildSpec, FakeChain, REGISTRY } from "../registry/support";
import {
  body,
  fakeRegistry,
  fixtureService,
  get,
  identifierContext,
  RECORDED_AT,
  recordedRegistry,
  supplyOf,
  versionContext,
} from "./support";

/** Index ids of the recorded registry, in creation order. */
const MISMATCHED = "0x50f8aacd30bddc6f9e0fbca1501526b2ac01106e626678eab50a7867eb94d759";
const DIVERSIFIED = "0xd622e2a5c14a9c3da33be82cea76e20adeaf4a26ca46413ee21307d2c850d610";
const CREATOR = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
const AAPL = "0xb200000000000000000000c2e324d24d7eecd1fb";
const REGISTRY_META = { chainId: 31_337, address: REGISTRY, mode: "replay" };

function options(registry: RegistryReader = recordedRegistry(), service = fixtureService()) {
  return {
    registry: () => registry,
    mode: () => "replay" as const,
    marketMode: () => "live" as const,
    now: () => RECORDED_AT,
    ...service,
  };
}

type Item = Record<string, unknown> & { latest: Record<string, unknown> };

function items(data: unknown): Item[] {
  return Array.isArray(data) ? data : [];
}

describe("GET /api/v1/indexes", () => {
  test("lists the recorded indexes in creation order with a summary of the latest version", async () => {
    const response = await indexesHandler(options())(get("/api/v1/indexes"), undefined);
    const { data, meta } = await body(response);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=10");
    expect(meta).toEqual({
      mode: "replay",
      asOf: "2026-11-21T19:10:55Z",
      registry: REGISTRY_META,
      total: 5,
      offset: 0,
      limit: 20,
      count: 5,
      nextOffset: null,
    });
    expect(items(data).map(({ identifier, position }) => [position, identifier])).toEqual([
      [0, MISMATCHED],
      [1, "single-asset-fdc98c0f"],
      [2, "large-technology-equal-a4abb1bd"],
      [3, "semiconductors-fixed-a3e409e2"],
      [4, "diversified-equity-d622e2a5"],
    ]);
    expect(items(data)[4]).toEqual({
      indexId: DIVERSIFIED,
      identifier: "diversified-equity-d622e2a5",
      position: 4,
      creator: CREATOR,
      createdAt: "2026-11-16T14:00:05Z",
      latestVersion: 2,
      deprecated: false,
      deprecatedAt: null,
      latest: {
        version: 2,
        name: "Diversified Equity",
        slug: "diversified-equity",
        weighting: "fixed",
        composition: "static",
        constituentCount: 5,
        specHash: "0x90d5104e4313a341690a14046df6da168cd3c1924f5ceca79cdc8b3b51fe74f6",
        publishedAt: "2026-11-16T14:00:05Z",
        publishedBlock: "9",
        verification: { conformant: true, failedCheck: null },
      },
    });
  });

  test("an index that fails verification is listed with its state and nothing taken from its spec", async () => {
    const { data } = await body(await indexesHandler(options())(get("/api/v1/indexes"), undefined));
    const [mismatched, retired] = items(data);
    expect(mismatched).toMatchObject({ indexId: MISMATCHED, identifier: MISMATCHED, deprecated: false });
    expect(mismatched?.latest).toMatchObject({
      name: null,
      slug: null,
      weighting: null,
      constituentCount: 2,
      verification: { conformant: false, failedCheck: { id: "C5", code: "weight_mismatch" } },
    });
    expect(JSON.stringify(mismatched)).not.toContain("Mismatched");
    expect(retired).toMatchObject({ deprecated: true, deprecatedAt: "2026-11-16T14:00:05Z" });
  });

  test("pages by position, and a page past the end is empty without being an error", async () => {
    const handler = indexesHandler(options());
    const page = await body(await handler(get("/api/v1/indexes?offset=1&limit=2"), undefined));
    expect(items(page.data).map(({ position }) => position)).toEqual([1, 2]);
    expect(page.meta).toMatchObject({ total: 5, offset: 1, limit: 2, count: 2, nextOffset: 3 });
    const last = await body(await handler(get("/api/v1/indexes?offset=4&limit=50"), undefined));
    expect(last.meta).toMatchObject({ count: 1, nextOffset: null });
    const beyond = await body(await handler(get("/api/v1/indexes?offset=9"), undefined));
    expect(beyond).toMatchObject({ data: [], meta: { total: 5, count: 0, nextOffset: null } });
  });

  test("a page that is not an integer in range, or an unknown parameter, answers 400", async () => {
    const handler = indexesHandler(options());
    for (const query of ["limit=0", "limit=51", "limit=ten", "offset=-1", "offset=1.5", "limit=1&limit=2", "page=2"]) {
      const response = await handler(get(`/api/v1/indexes?${query}`), undefined);
      expect(response.status).toBe(400);
      expect((await body(response)).error?.code).toBe("invalid_parameter");
    }
  });

  test("a deployed registry without indexes answers an empty list, which is not the not-deployed answer", async () => {
    const response = await indexesHandler(options(recordedRegistry("registry-empty")))(
      get("/api/v1/indexes"),
      undefined,
    );
    expect(response.status).toBe(200);
    expect(await body(response)).toMatchObject({ data: [], meta: { total: 0, count: 0, nextOffset: null } });
  });
});

describe("a chain without the registry", () => {
  const base = createRegistryReader({ config: resolveRegistryConfig({}) });

  test("every index endpoint answers 409 registry_not_deployed, never an empty list", async () => {
    const shared = options(base);
    const responses = [
      await indexesHandler(shared)(get("/api/v1/indexes"), undefined),
      await indexHandler(shared)(get("/"), identifierContext(DIVERSIFIED)),
      await indexVersionHandler(shared)(get("/"), versionContext(DIVERSIFIED, "1")),
      await indexCompositionHandler(shared)(get("/"), identifierContext("diversified-equity-d622e2a5")),
    ];
    for (const response of responses) {
      expect(response.status).toBe(409);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(await body(response)).toEqual({
        error: {
          code: "registry_not_deployed",
          message: "The index registry is not deployed on the configured chain.",
          details: { chainId: 8453, registry: REGISTRY, reason: "not_configured" },
        },
      });
    }
  });

  test("an address without code is reported with the reason no_code", async () => {
    const chain = new FakeChain();
    chain.deployed = false;
    const response = await indexesHandler(options(fakeRegistry(chain)))(get("/api/v1/indexes"), undefined);
    expect(response.status).toBe(409);
    expect((await body(response)).error?.details).toMatchObject({ reason: "no_code" });
  });

  test("a malformed identifier is still a 400: it is wrong on every chain", async () => {
    const response = await indexHandler(options(base))(get("/"), identifierContext("0x12"));
    expect(response.status).toBe(400);
  });
});

describe("GET /api/v1/indexes/{identifier}", () => {
  test("resolves the canonical identifier and the index id in any letter case to the same index", async () => {
    const handler = indexHandler(options());
    const bySlug = await body(await handler(get("/"), identifierContext("diversified-equity-d622e2a5")));
    const byId = await body(await handler(get("/"), identifierContext(`0x${DIVERSIFIED.slice(2).toUpperCase()}`)));
    expect(byId.data).toEqual(bySlug.data);
    expect(bySlug.meta).toEqual({ mode: "replay", asOf: "2026-11-21T19:10:55Z", registry: REGISTRY_META });
    expect(bySlug.data).toMatchObject({
      indexId: DIVERSIFIED,
      identifier: "diversified-equity-d622e2a5",
      latestVersion: 2,
      versions: [
        {
          version: 2,
          publishedAt: "2026-11-16T14:00:05Z",
          publishedBlock: "9",
          specHash: "0x90d5104e4313a341690a14046df6da168cd3c1924f5ceca79cdc8b3b51fe74f6",
          conformant: true,
        },
        {
          version: 1,
          publishedAt: "2026-11-16T14:00:05Z",
          publishedBlock: "8",
          specHash: "0xe64cf7b3200cae7821979cad14798da5796817439c6a5dd96f1f52946cc87b03",
          conformant: true,
        },
      ],
    });
  });

  test("lists at most the 50 most recent versions of an index with more", async () => {
    const chain = new FakeChain();
    const indexId = chain.createIndex(buildSpec());
    for (let version = 2; version <= 53; version += 1) chain.publishVersion(indexId, buildSpec());
    const { data } = await body(await indexHandler(options(fakeRegistry(chain)))(get("/"), identifierContext(indexId)));
    const versions = (data as { versions: { version: number }[] }).versions.map(({ version }) => version);
    expect(versions).toHaveLength(50);
    expect([versions[0], versions.at(-1)]).toEqual([53, 4]);
    expect(data).toMatchObject({ latestVersion: 53 });
  });

  test("answers 404 for an unknown index or a slug that is not the one of the index, and 400 for a malformed one", async () => {
    const handler = indexHandler(options());
    const unknown = await handler(get("/"), identifierContext(`0x${"1".repeat(64)}`));
    const wrongSlug = await handler(get("/"), identifierContext("another-name-d622e2a5"));
    const malformed = await handler(get("/"), identifierContext("Diversified Equity"));
    expect([unknown.status, wrongSlug.status, malformed.status]).toEqual([404, 404, 400]);
    expect((await body(unknown)).error?.code).toBe("index_not_found");
    expect((await body(malformed)).error).toMatchObject({
      code: "invalid_identifier",
      details: { parameter: "identifier" },
    });
    expect((await handler(get("/?expand=1"), identifierContext(DIVERSIFIED))).status).toBe(400);
  });
});

describe("GET /api/v1/indexes/{identifier}/versions/{version}", () => {
  test("returns the onchain facts, the spec as bytes, text and document, the constituents and every check", async () => {
    const handler = indexVersionHandler(options());
    const { data } = await body(await handler(get("/"), versionContext("diversified-equity-d622e2a5", "1")));
    const version = data as Record<string, unknown> & { specBytes: `0x${string}`; specText: string };
    expect(version).toMatchObject({
      indexId: DIVERSIFIED,
      identifier: "diversified-equity-d622e2a5",
      version: 1,
      latestVersion: 2,
      isLatest: false,
      creator: CREATOR,
      chainId: 31_337,
      registry: REGISTRY,
      specHash: "0xe64cf7b3200cae7821979cad14798da5796817439c6a5dd96f1f52946cc87b03",
      publishedBlock: "8",
      composition: "static",
      specSize: 779,
      spec: { name: "Diversified Equity", weighting: { type: "equal" }, chainId: 31_337 },
      verification: { conformant: true, specErrors: [] },
    });
    // What the page asks a reader to reproduce: the bytes hash to the published hash and are the text shown.
    expect(specHash(hexToBytes(version.specBytes))).toBe(version.specHash as `0x${string}`);
    expect(new TextDecoder().decode(hexToBytes(version.specBytes))).toBe(version.specText);
    expect(JSON.parse(version.specText)).toEqual(version.spec);
    expect(version.constituents).toHaveLength(4);
    expect(version.constituents).toContainEqual({ token: AAPL, weightBps: 2_500 });
    const checks = (version.verification as { checks: Record<string, string>[] }).checks;
    expect(checks.map(({ id, status, code }) => [id, status, code])).toEqual([
      ["C1", "pass", "ok"],
      ["C2", "pass", "ok"],
      ["C3", "pass", "ok"],
      ["C4", "pass", "ok"],
      ["C5", "pass", "ok"],
    ]);
    for (const check of checks) expect(Object.keys(check)).toEqual(["id", "title", "status", "code", "reason"]);
  });

  test("a version that fails verification keeps its stored facts and has no parsed spec", async () => {
    const { data } = await body(await indexVersionHandler(options())(get("/"), versionContext(MISMATCHED, "1")));
    expect(data).toMatchObject({
      identifier: MISMATCHED,
      isLatest: true,
      spec: null,
      constituents: [{ weightBps: 6_000 }, { weightBps: 4_000 }],
      verification: { conformant: false },
    });
    const { verification, specText } = data as {
      verification: { checks: { id: string; status: string; code: string; reason: string }[] };
      specText: string;
    };
    expect(verification.checks.map(({ status }) => status)).toEqual(["pass", "pass", "pass", "pass", "fail"]);
    expect(verification.checks[4]).toMatchObject({ code: "weight_mismatch" });
    expect(verification.checks[4]?.reason).toContain("is published at 6000 bps, the spec implies 5000 bps");
    expect(specText).toContain('"slug":"mismatched-weights"');
  });

  test("stored bytes that are not UTF-8 have no text, and the report says which check failed", async () => {
    const chain = new FakeChain();
    const indexId = chain.createIndex({ specBytes: Uint8Array.of(0xff, 0xfe), constituents: [], composition: 0 });
    const handler = indexVersionHandler(options(fakeRegistry(chain)));
    const { data } = await body(await handler(get("/"), versionContext(indexId, "1")));
    expect(data).toMatchObject({
      specBytes: "0xfffe",
      specSize: 2,
      specText: null,
      spec: null,
      composition: "rule_based",
    });
    expect((data as { verification: { checks: { status: string }[] } }).verification.checks[1]?.status).toBe("fail");
  });

  test("a version that is not a positive integer answers 400, one the index does not have answers 404", async () => {
    const handler = indexVersionHandler(options());
    for (const version of ["0", "01", "-1", "1.0", "latest", "4294967296", "99999999999"]) {
      const response = await handler(get("/"), versionContext(DIVERSIFIED, version));
      expect(response.status).toBe(400);
      expect((await body(response)).error).toMatchObject({
        code: "invalid_parameter",
        details: { parameter: "version" },
      });
    }
    const missing = await handler(get("/"), versionContext(DIVERSIFIED, "3"));
    expect(missing.status).toBe(404);
    expect((await body(missing)).error?.code).toBe("version_not_found");
    expect((await handler(get("/"), versionContext(`0x${"2".repeat(64)}`, "1"))).status).toBe(404);
  });
});

describe("GET /api/v1/indexes/{identifier}/composition", () => {
  test("meta.mode is replay as soon as the registry or the market data is replayed", async () => {
    for (const [registry, market, expected] of [
      ["live", "live", "live"],
      ["replay", "live", "replay"],
      ["live", "replay", "replay"],
    ] as const) {
      const handler = indexCompositionHandler({ ...options(), mode: () => registry, marketMode: () => market });
      const { meta } = await body(await handler(get("/"), identifierContext(DIVERSIFIED)));
      expect(meta).toMatchObject({ mode: expected, registry: { mode: registry } });
    }
  });

  test("joins the constituents of the latest version with the asset universe of one block", async () => {
    const response = await indexCompositionHandler(options())(get("/"), identifierContext(DIVERSIFIED));
    const { data, meta } = await body(response);
    expect(response.status).toBe(200);
    expect(meta).toMatchObject({
      asOf: "2026-11-21T19:10:55Z",
      marketPhase: "closed",
      registry: REGISTRY_META,
      datasets: { onchain: { blockNumber: "60489401" } },
    });
    expect(data).toMatchObject({ indexId: DIVERSIFIED, version: 2, isLatest: true });
    const { constituents } = data as { constituents: Record<string, unknown>[] };
    expect(constituents.map(({ symbol, targetWeightBps }) => [symbol, targetWeightBps])).toEqual([
      ["TSLAc", 2_500],
      ["MSTRc", 1_000],
      ["NVDAc", 2_500],
      ["AAPLc", 2_500],
      ["AMZNc", 1_500],
    ]);
    expect(constituents[2]).toEqual({
      token: TOKENS.NVDA,
      symbol: "NVDAc",
      name: "NVIDIA Corporation",
      targetWeightBps: 2_500,
      eligibility: { eligible: true, reasons: [] },
      transfersPaused: false,
      referencePrice: {
        status: "last_close",
        priceE8: "12982480034",
        updatedAt: "2026-11-20T23:42:40Z",
        roundId: "36893488147419104856",
        unavailableReason: null,
        lastObserved: null,
        feedProxy: expect.stringMatching(/^0x[0-9a-f]{40}$/),
      },
    });
  });

  test("version selects another version of the index", async () => {
    const handler = indexCompositionHandler(options());
    const { data } = await body(await handler(get("/api/v1/x?version=1"), identifierContext(DIVERSIFIED)));
    expect(data).toMatchObject({ version: 1, isLatest: false });
    expect(
      (data as { constituents: { targetWeightBps: number }[] }).constituents.map((c) => c.targetWeightBps),
    ).toEqual([2_500, 2_500, 2_500, 2_500]);
    expect((await handler(get("/api/v1/x?version=3"), identifierContext(DIVERSIFIED))).status).toBe(404);
    expect((await handler(get("/api/v1/x?version=v1"), identifierContext(DIVERSIFIED))).status).toBe(400);
    expect((await handler(get("/api/v1/x?v=1"), identifierContext(DIVERSIFIED))).status).toBe(400);
  });

  test("a constituent that stopped being eligible after publication is reported as it is now", async () => {
    const service = fixtureService(RECORDED_AT, { override: supplyOf(AAPL, 0n) });
    const handler = indexCompositionHandler(options(recordedRegistry(), service));
    const { data } = await body(await handler(get("/"), identifierContext(DIVERSIFIED)));
    const aapl = (data as { constituents: Record<string, unknown>[] }).constituents.find(({ token }) => token === AAPL);
    expect(aapl).toMatchObject({
      symbol: "AAPLc",
      targetWeightBps: 2_500,
      eligibility: { eligible: false, reasons: ["not_minted"] },
      referencePrice: { status: "unavailable", priceE8: null, unavailableReason: "not_eligible" },
    });
  });

  test("a token the asset list does not hold is kept, without a symbol or a price", async () => {
    const chain = new FakeChain();
    const indexId = chain.createIndex(buildSpec({ tokenCount: 2 }));
    const handler = indexCompositionHandler(options(fakeRegistry(chain)));
    const { data } = await body(await handler(get("/"), identifierContext(indexId)));
    expect((data as { constituents: unknown[] }).constituents).toEqual([
      {
        token: "0xb200000000000000000000000000000000000001",
        symbol: null,
        name: null,
        targetWeightBps: 5_000,
        eligibility: { eligible: false, reasons: ["not_listed"] },
        transfersPaused: null,
        referencePrice: {
          status: "unavailable",
          priceE8: null,
          updatedAt: null,
          roundId: null,
          unavailableReason: "not_eligible",
          lastObserved: null,
          feedProxy: null,
        },
      },
      expect.objectContaining({ token: "0xb200000000000000000000000000000000000002", symbol: null }),
    ]);
  });

  test("a version that fails verification has no composition: 409 with the failed check", async () => {
    const response = await indexCompositionHandler(options())(get("/"), identifierContext(MISMATCHED));
    expect(response.status).toBe(409);
    expect((await body(response)).error).toEqual({
      code: "version_not_conformant",
      message: "The version fails verification, so it has no composition.",
      details: { version: 1, failedCheck: "C5", code: "weight_mismatch" },
    });
  });

  test("a source that is down answers 503 and names it", async () => {
    const market = fixtureService();
    market.outage.rpc = true;
    const noPrices = await indexCompositionHandler(options(recordedRegistry(), market))(
      get("/"),
      identifierContext(DIVERSIFIED),
    );
    expect(noPrices.status).toBe(503);
    expect((await body(noPrices)).error?.details).toEqual({ source: "base_rpc" });

    const chain = new FakeChain();
    chain.createIndex(buildSpec());
    chain.fail = (method) => method === "eth_call";
    const noRegistry = await indexesHandler(options(fakeRegistry(chain)))(get("/api/v1/indexes"), undefined);
    expect(noRegistry.status).toBe(503);
    expect(noRegistry.headers.get("Retry-After")).toBe("15");
    expect((await body(noRegistry)).error).toMatchObject({
      code: "upstream_unavailable",
      details: { source: "registry_rpc" },
    });
  });

  test("no financial quantity or block number is a JSON number", async () => {
    const shared = options();
    const texts = [
      await (await indexesHandler(shared)(get("/api/v1/indexes"), undefined)).text(),
      await (await indexVersionHandler(shared)(get("/"), versionContext(DIVERSIFIED, "2"))).text(),
      await (await indexCompositionHandler(shared)(get("/"), identifierContext(DIVERSIFIED))).text(),
    ];
    for (const text of texts) {
      expect(text).toMatch(/"publishedBlock":"\d+"|"priceE8":"\d+"/);
      JSON.parse(text, (key, value: unknown) => {
        // Chain ids, counts, positions, versions, basis points and seconds are the only numbers.
        if (typeof value === "number") expect(Number.isSafeInteger(value) && value <= 31_337_000).toBe(true);
        if (/E8$|Block$|Supply$|Wad$/.test(key)) expect(typeof value === "string" || value === null).toBe(true);
        return value;
      });
    }
  });
});
