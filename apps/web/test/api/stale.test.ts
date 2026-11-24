import { describe, expect, spyOn, test } from "bun:test";
import { assetHandler, assetsHandler } from "../../src/server/api/assets";
import { indexCompositionHandler, indexesHandler } from "../../src/server/api/indexes";
import {
  comparisonCache,
  loadComparison,
  portfolioHandler,
  portfolioPlanHandler,
} from "../../src/server/api/portfolio";
import {
  ASSET_LIST_CACHE,
  BALANCE_CACHE,
  type MarketData,
  ONCHAIN_CACHE,
  UpstreamError,
} from "../../src/server/market";
import { createRegistryReader } from "../../src/server/registry/reader";
import { TOKENS } from "../market/support";
import { buildSpec, FakeChain, testConfig } from "../registry/support";
import { addressContext, body, fixtureService, get, identifierContext, recordedRegistry } from "./support";

const INDEX = "diversified-equity-d622e2a5";
/** A constructed account of `test/fixtures/market/balances.json`. */
const ABOVE = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";

type Service = ReturnType<typeof fixtureService>;

/** Loads every dataset once, then makes `source` unreachable and moves the clock past its TTL, within its window. */
async function staleAfterLoad(service: Service, source: "api" | "rpc"): Promise<void> {
  const marketData = service.marketData();
  await marketData.getSnapshot();
  await marketData.getBalances(ABOVE);
  service.outage[source] = true;
  service.clock.now += source === "api" ? ASSET_LIST_CACHE.ttlSeconds + 60 : ONCHAIN_CACHE.ttlSeconds + 60;
}

/** Every route that answers with a cacheable response, given the market data it reads. */
function cachingRoutes(marketData: () => MarketData) {
  const registry = recordedRegistry();
  const options = {
    registry: () => registry,
    mode: () => "replay" as const,
    marketData,
    marketMode: () => "replay" as const,
  };
  const comparison = `address=${ABOVE}&index=${INDEX}`;
  return {
    "/assets": () => assetsHandler({ marketData, mode: () => "live" })(get("/api/v1/assets"), undefined),
    "/assets/{address}": () => assetHandler({ marketData, mode: () => "live" })(get("/"), addressContext(TOKENS.NVDA)),
    "/indexes/{identifier}/composition": () => indexCompositionHandler(options)(get("/"), identifierContext(INDEX)),
    "/portfolio": () => portfolioHandler(options)(get(`/api/v1/portfolio?${comparison}`), undefined),
    "/portfolio/plan": () =>
      portfolioPlanHandler(options)(get(`/api/v1/portfolio/plan?${comparison}&mode=rebalance`), undefined),
  };
}

describe("a response with any input served stale is never cacheable", () => {
  test("every caching route is cacheable while its inputs are fresh", async () => {
    for (const [path, request] of Object.entries(cachingRoutes(fixtureService().marketData))) {
      const response = await request();
      expect([path, response.status]).toEqual([path, 200]);
      expect([path, response.headers.get("Cache-Control")]).toEqual([path, expect.stringMatching(/^public, max-age=/)]);
    }
  });

  for (const source of ["api", "rpc"] as const) {
    const dataset = source === "api" ? "assetList" : "onchain";
    test(`the ${dataset} dataset served stale makes every caching route no-store`, async () => {
      const service = fixtureService();
      await staleAfterLoad(service, source);
      const routes = cachingRoutes(service.marketData);
      for (const [path, request] of Object.entries(routes)) {
        if (source === "rpc" && path.startsWith("/portfolio")) continue;
        const response = await request();
        expect([path, response.status]).toEqual([path, 200]);
        expect([path, response.headers.get("Cache-Control")]).toEqual([path, "no-store"]);
        expect((await body(response)).meta?.datasets).toMatchObject({ [dataset]: { servedStale: true } });
      }
    });
  }

  test("with the RPC down the portfolio routes answer 503: balances are never served stale", async () => {
    const log = spyOn(console, "error").mockImplementation(() => {});
    try {
      const service = fixtureService();
      await staleAfterLoad(service, "rpc");
      const routes = cachingRoutes(service.marketData);
      for (const path of ["/portfolio", "/portfolio/plan"] as const) {
        const response = await routes[path]();
        expect([path, response.status]).toEqual([path, 503]);
        expect(response.headers.get("Cache-Control")).toBe("no-store");
      }
    } finally {
      log.mockRestore();
    }
  });

  test("balances exactly at their TTL whose reload fails are an error, not an older read", async () => {
    const log = spyOn(console, "error").mockImplementation(() => {});
    try {
      const service = fixtureService();
      const marketData = service.marketData();
      await marketData.getBalances(ABOVE);
      service.outage.rpc = true;
      service.clock.now += BALANCE_CACHE.ttlSeconds;
      await expect(marketData.getBalances(ABOVE)).rejects.toBeInstanceOf(UpstreamError);
      const response = await cachingRoutes(service.marketData)["/portfolio"]();
      expect(response.status).toBe(503);
    } finally {
      log.mockRestore();
    }
  });

  test("a service that serves balances stale anyway is refused, never presented as current", async () => {
    const log = spyOn(console, "error").mockImplementation(() => {});
    try {
      const inner = fixtureService().marketData();
      const lenient: MarketData = {
        getSnapshot: () => inner.getSnapshot(),
        getBalances: async (account) => ({
          ...(await inner.getBalances(account)),
          servedStale: true,
          error: new UpstreamError("base_rpc", "simulated failure"),
        }),
      };
      const routes = cachingRoutes(() => lenient);
      for (const path of ["/portfolio", "/portfolio/plan"] as const) {
        const response = await routes[path]();
        expect([path, response.status]).toEqual([path, 503]);
        expect(response.headers.get("Cache-Control")).toBe("no-store");
        expect((await body(response)).error).toMatchObject({
          code: "upstream_unavailable",
          details: { source: "base_rpc" },
        });
      }
    } finally {
      log.mockRestore();
    }
  });

  test("the cache lifetime of a comparison is no-store as soon as any of its three inputs is stale", async () => {
    const registry = recordedRegistry();
    const options = {
      registry: () => registry,
      mode: () => "replay" as const,
      marketData: fixtureService().marketData,
      marketMode: () => "replay" as const,
    };
    const fresh = await loadComparison(options, ABOVE, INDEX, undefined);
    expect(comparisonCache(fresh)).toMatch(/^public, max-age=/);
    const { snapshot, balances } = fresh;
    const stale = [
      { ...fresh, snapshot: { ...snapshot, assetList: { ...snapshot.assetList, servedStale: true } } },
      { ...fresh, snapshot: { ...snapshot, onchain: { ...snapshot.onchain, servedStale: true } } },
      { ...fresh, balances: { ...balances, servedStale: true } },
    ];
    for (const comparison of stale) expect(comparisonCache(comparison)).toBe("no-store");
  });

  test("the registry routes are never stale: a head read that fails at its TTL is an error, not a cached page", async () => {
    const log = spyOn(console, "error").mockImplementation(() => {});
    try {
      const chain = new FakeChain();
      chain.createIndex(buildSpec());
      const clock = { now: 1_000 };
      const reader = createRegistryReader({ config: testConfig(), client: chain.client(), now: () => clock.now });
      const handler = indexesHandler({ registry: () => reader, mode: () => "live", now: () => clock.now });
      expect((await handler(get("/api/v1/indexes"), undefined)).status).toBe(200);
      chain.fail = (method) => method === "eth_call";
      clock.now += 10;
      const response = await handler(get("/api/v1/indexes"), undefined);
      expect(response.status).toBe(503);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
    } finally {
      log.mockRestore();
    }
  });
});
