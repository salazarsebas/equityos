import { describe, expect, test } from "bun:test";
import { statusHandler } from "../../src/server/api/status";
import { body, fixtureService, get, RECORDED_AT } from "./support";

function handler(service = fixtureService(), mode: "live" | "replay" = "live") {
  return statusHandler({ marketData: service.marketData, mode: () => mode, now: () => service.clock.now });
}

describe("GET /api/v1/status", () => {
  test("reports the version, the chain, the market phase and the age of each dataset", async () => {
    const service = fixtureService();
    await service.marketData().getSnapshot();
    service.clock.now += 9;
    const response = await handler(service)(get("/api/v1/status", { "x-vercel-ip-country": "DE" }), undefined);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await body(response)).toEqual({
      data: {
        apiVersion: "1.0.0",
        chainId: 8453,
        marketPhase: "closed",
        executionAvailable: false,
        executionUnavailableReason: "not_released",
        marketData: {
          mode: "live",
          available: true,
          referencePriceSource: "chainlink",
          datasets: {
            assetList: {
              source: "coinbase_api",
              fetchedAt: "2026-11-21T19:10:55Z",
              ageSeconds: 9,
              servedStale: false,
              failure: null,
            },
            onchain: {
              source: "base_rpc",
              fetchedAt: "2026-11-21T19:10:55Z",
              ageSeconds: 9,
              servedStale: false,
              failure: null,
              blockNumber: "60489401",
              blockTimestamp: "2026-11-21T19:10:55Z",
            },
          },
          error: null,
        },
      },
      meta: { asOf: "2026-11-21T19:11:04Z" },
    });
  });

  test("execution is unavailable to everyone, and the reason reflects the jurisdiction gate first", async () => {
    const reasons = new Map<string | null, string>([
      ["US", "restricted_jurisdiction"],
      ["PR", "restricted_jurisdiction"],
      ["DE", "not_released"],
      ["??", "jurisdiction_unknown"],
      // The unit tests do not run in production mode, where an absent header is also jurisdiction_unknown.
      [null, "not_released"],
    ]);
    for (const [country, reason] of reasons) {
      const request = get("/api/v1/status", country === null ? {} : { "x-vercel-ip-country": country });
      const { data } = await body(await handler()(request, undefined));
      expect(data).toMatchObject({ executionAvailable: false, executionUnavailableReason: reason });
    }
  });

  test("answers 200 and names the failing source when the market data cannot be loaded", async () => {
    const service = fixtureService();
    service.outage.rpc = true;
    const response = await handler(service)(get("/api/v1/status"), undefined);
    const { data, meta } = await body(response);
    expect(response.status).toBe(200);
    expect(meta).toEqual({ asOf: "2026-11-21T19:10:55Z" });
    expect(data).toMatchObject({
      marketPhase: "closed",
      marketData: {
        available: false,
        datasets: null,
        error: { code: "upstream_unavailable", details: { source: "base_rpc" } },
      },
    });
  });

  test("reports a dataset that is served past its TTL", async () => {
    const service = fixtureService();
    await service.marketData().getSnapshot();
    service.outage.api = true;
    service.clock.now = RECORDED_AT + 3_600;
    const { data } = await body(await handler(service)(get("/api/v1/status"), undefined));
    expect(data).toMatchObject({
      marketData: {
        available: true,
        datasets: {
          assetList: { ageSeconds: 3_600, servedStale: true, failure: "upstream_failure" },
          onchain: { ageSeconds: 0, servedStale: false, failure: null },
        },
      },
    });
  });

  test("says so when the server replays a recording", async () => {
    const { data } = await body(await handler(fixtureService(), "replay")(get("/api/v1/status"), undefined));
    expect(data).toMatchObject({ marketData: { mode: "replay" } });
  });

  test("exposes no endpoint URL, country or environment value", async () => {
    const response = await handler()(get("/api/v1/status", { "x-vercel-ip-country": "US" }), undefined);
    const text = await response.text();
    expect(text).not.toMatch(/https?:|BASE_RPC_URL|"country"|"US"/);
  });

  test("a query parameter answers 400", async () => {
    expect((await handler()(get("/api/v1/status?verbose=1"), undefined)).status).toBe(400);
  });
});
