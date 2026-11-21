import { describe, expect, spyOn, test } from "bun:test";
import { assetHandler, assetsHandler } from "../../src/server/api/assets";
import { REFERENCE_FEEDS } from "../../src/server/market/feeds";
import { TOKENS } from "../market/support";
import { addressContext, body, fixtureService, get, RECORDED_AT, supplyOf, wrongChain } from "./support";

/** Publication time of the recorded NVDA round: Friday 23:42:40 UTC, in the post-market session. */
const NVDA_UPDATED_AT = 1_795_218_160;

const NVDA = {
  address: TOKENS.NVDA,
  symbol: "NVDAc",
  name: "NVIDIA Corporation",
  decimals: 8,
  isin: "US67066G1040",
  onchain: {
    status: "ok",
    decimals: 8,
    totalSupply: "6201973777574",
    multiplierWad: "1000537939576369481",
    pendingMultiplier: null,
    transfersPaused: false,
  },
  eligibility: { eligible: true, reasons: [] },
  referencePrice: {
    status: "last_close",
    priceE8: "12982480034",
    updatedAt: "2026-11-20T23:42:40Z",
    roundId: "36893488147419104856",
    unavailableReason: null,
    lastObserved: null,
    feedProxy: REFERENCE_FEEDS.get(TOKENS.NVDA)?.proxy.toLowerCase(),
  },
};

const RECORDED_META = {
  asOf: "2026-11-21T19:10:55Z",
  marketPhase: "closed",
  referencePriceSource: "chainlink",
  datasets: {
    assetList: {
      source: "coinbase_api",
      fetchedAt: "2026-11-21T19:10:55Z",
      ageSeconds: 0,
      servedStale: false,
      failure: null,
    },
    onchain: {
      source: "base_rpc",
      fetchedAt: "2026-11-21T19:10:55Z",
      ageSeconds: 0,
      servedStale: false,
      failure: null,
      blockNumber: "60489401",
      blockTimestamp: "2026-11-21T19:10:55Z",
    },
  },
};

function symbols(data: unknown): string[] {
  return Array.isArray(data) ? data.map((asset: { symbol: string }) => asset.symbol) : [];
}

describe("GET /api/v1/assets", () => {
  test("returns every listed asset ordered by symbol, with the snapshot it was built from", async () => {
    const response = await assetsHandler(fixtureService().marketData)(get("/api/v1/assets"), undefined);
    const { data, meta } = await body(response);
    expect(response.status).toBe(200);
    expect(meta).toEqual({ ...RECORDED_META, count: 17, total: 17 });
    expect(symbols(data)).toEqual([...symbols(data)].sort());
    expect(data).toContainEqual(NVDA);
  });

  test("eligible=true keeps the thirteen eligible assets and eligible=false the other four", async () => {
    const handler = assetsHandler(fixtureService().marketData);
    const eligible = await body(await handler(get("/api/v1/assets?eligible=true"), undefined));
    const others = await body(await handler(get("/api/v1/assets?eligible=false"), undefined));
    expect(eligible.meta).toMatchObject({ count: 13, total: 17 });
    expect(others.meta).toMatchObject({ count: 4, total: 17 });
    expect(eligible.data).toContainEqual(NVDA);
    expect(symbols(others.data)).toContain("RKTc");
  });

  test("an asset without supply or feed has null values with the reason for each, never zero", async () => {
    const { data } = await body(await assetsHandler(fixtureService().marketData)(get("/api/v1/assets"), undefined));
    const rkt = Array.isArray(data) ? data.find((asset: { address: string }) => asset.address === TOKENS.RKT) : null;
    expect(rkt).toMatchObject({
      onchain: { status: "ok", totalSupply: "0" },
      eligibility: { eligible: false, reasons: ["not_minted", "missing_feed"] },
      referencePrice: {
        status: "unavailable",
        priceE8: null,
        updatedAt: null,
        roundId: null,
        unavailableReason: "not_eligible",
        lastObserved: null,
        feedProxy: null,
      },
    });
  });

  test("a feed past its heartbeat has no price, the reason, and its last round for display", async () => {
    // Tuesday 2026-11-24 02:00 UTC: more than a day of trading time after the Friday rounds.
    const service = fixtureService(RECORDED_AT + 198_000);
    const { data } = await body(
      await assetsHandler(service.marketData)(get("/api/v1/assets?eligible=true"), undefined),
    );
    const nvda = Array.isArray(data) ? data.find((asset: { address: string }) => asset.address === TOKENS.NVDA) : null;
    expect(nvda.referencePrice).toEqual({
      ...NVDA.referencePrice,
      status: "unavailable",
      priceE8: null,
      updatedAt: null,
      roundId: null,
      unavailableReason: "stale_feed",
      lastObserved: { priceE8: "12982480034", updatedAt: "2026-11-20T23:42:40Z", roundId: "36893488147419104856" },
    });
  });

  test("a supply as large as uint256 is serialized exactly", async () => {
    const max = 2n ** 256n - 1n;
    const service = fixtureService(RECORDED_AT, { override: supplyOf(TOKENS.NVDA, max) });
    const response = await assetsHandler(service.marketData)(get("/api/v1/assets?eligible=true"), undefined);
    const text = await response.text();
    expect(text).toContain(`"totalSupply":"${max}"`);
    // Every JSON number in the body is a small integer: nothing financial is a number.
    JSON.parse(text, (_key, value: unknown) => {
      if (typeof value === "number") expect(Number.isInteger(value) && value < 1_000_000).toBe(true);
      return value;
    });
  });

  test("a fresh snapshot is cacheable for what is left of the 15 second onchain TTL", async () => {
    const { marketData, clock } = fixtureService(NVDA_UPDATED_AT + 60);
    const handler = assetsHandler(marketData);
    expect((await handler(get("/api/v1/assets"), undefined)).headers.get("Cache-Control")).toBe("public, max-age=15");
    clock.now += 11;
    const later = await handler(get("/api/v1/assets"), undefined);
    expect(later.headers.get("Cache-Control")).toBe("public, max-age=4");
    expect((await body(later)).meta?.datasets).toMatchObject({ onchain: { ageSeconds: 11, servedStale: false } });
  });

  test("a snapshot served past its TTL because the RPC is down is flagged and not cacheable", async () => {
    const { marketData, clock, outage } = fixtureService(NVDA_UPDATED_AT + 60);
    const handler = assetsHandler(marketData);
    await handler(get("/api/v1/assets"), undefined);
    outage.rpc = true;
    clock.now += 120;
    const response = await handler(get("/api/v1/assets?eligible=true"), undefined);
    const { data, meta } = await body(response);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(meta?.datasets).toMatchObject({
      onchain: { ageSeconds: 120, servedStale: true, failure: "upstream_failure" },
      assetList: { servedStale: false, failure: null },
    });
    expect(data).toContainEqual({ ...NVDA, referencePrice: { ...NVDA.referencePrice, status: "delayed" } });
  });

  test("sources that are down with nothing cached answer 503", async () => {
    for (const source of ["api", "rpc"] as const) {
      const service = fixtureService();
      service.outage[source] = true;
      const response = await assetsHandler(service.marketData)(get("/api/v1/assets"), undefined);
      expect(response.status).toBe(503);
      expect((await body(response)).error).toMatchObject({
        code: "upstream_unavailable",
        details: { source: source === "api" ? "coinbase_api" : "base_rpc" },
      });
    }
  });

  test("an asset list of the wrong shape answers 502", async () => {
    const service = fixtureService(RECORDED_AT, { apiBody: { tokens: "none" } });
    const response = await assetsHandler(service.marketData)(get("/api/v1/assets"), undefined);
    expect(response.status).toBe(502);
    expect((await body(response)).error).toMatchObject({
      code: "upstream_malformed",
      details: { source: "coinbase_api" },
    });
  });

  test("an endpoint that is not Base mainnet answers 500 without naming the configuration", async () => {
    const log = spyOn(console, "error").mockImplementation(() => {});
    try {
      const service = fixtureService(RECORDED_AT, { override: wrongChain });
      const response = await assetsHandler(service.marketData)(get("/api/v1/assets"), undefined);
      const text = await response.text();
      expect(response.status).toBe(500);
      expect(JSON.parse(text).error.code).toBe("service_misconfigured");
      expect(text).not.toMatch(/BASE_RPC_URL|chain id/);
    } finally {
      log.mockRestore();
    }
  });

  test("a misspelled or malformed filter answers 400 and reads nothing", async () => {
    const service = fixtureService();
    service.outage.api = true;
    const handler = assetsHandler(service.marketData);
    for (const search of ["?eligble=true", "?eligible=yes", "?eligible=true&eligible=true", "?page=2"]) {
      const response = await handler(get(`/api/v1/assets${search}`), undefined);
      expect(response.status).toBe(400);
      expect((await body(response)).error?.code).toBe("invalid_parameter");
    }
  });
});

describe("GET /api/v1/assets/{address}", () => {
  test("returns one asset for an address in any letter case", async () => {
    const handler = assetHandler(fixtureService().marketData);
    for (const address of [TOKENS.NVDA, TOKENS.NVDA.toUpperCase().replace("0X", "0x")]) {
      const response = await handler(get(`/api/v1/assets/${address}`), addressContext(address));
      expect(response.status).toBe(200);
      expect(response.headers.get("Cache-Control")).toBe("public, max-age=15");
      expect(await body(response)).toEqual({ data: NVDA, meta: RECORDED_META });
    }
  });

  test("a token with a share multiplier of 8 reports it without applying it to the price", async () => {
    const response = await assetHandler(fixtureService().marketData)(get("/"), addressContext(TOKENS.SNDK));
    expect((await body(response)).data).toMatchObject({
      onchain: { multiplierWad: "8000000000000000000" },
      referencePrice: { priceE8: "64944000000" },
    });
  });

  test("a malformed address answers 400 before anything is read", async () => {
    const service = fixtureService();
    service.outage.rpc = true;
    for (const address of ["0x1234", "nvda", `${TOKENS.NVDA}0`]) {
      const response = await assetHandler(service.marketData)(get("/"), addressContext(address));
      expect(response.status).toBe(400);
      expect((await body(response)).error).toMatchObject({
        code: "invalid_address",
        details: { parameter: "address" },
      });
    }
  });

  test("an address that is not listed answers 404 with the lowercase address", async () => {
    const unknown = "0x00000000000000000000000000000000000000AB";
    const response = await assetHandler(fixtureService().marketData)(get("/"), addressContext(unknown));
    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect((await body(response)).error).toEqual({
      code: "asset_not_found",
      message: "No listed asset has this token address.",
      details: { address: unknown.toLowerCase() },
    });
  });

  test("a query parameter answers 400", async () => {
    const handler = assetHandler(fixtureService().marketData);
    const response = await handler(get(`/api/v1/assets/${TOKENS.NVDA}?eligible=true`), addressContext(TOKENS.NVDA));
    expect(response.status).toBe(400);
  });
});
