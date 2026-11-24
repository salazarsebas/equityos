import { describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  CALCULATION_ISSUE_CODES,
  PLAN_STATEMENT,
  type PortfolioApiOptions,
  portfolioHandler,
  portfolioPlanHandler,
} from "../../src/server/api/portfolio";
import type { MarketData } from "../../src/server/market";
import { resolveRegistryConfig } from "../../src/server/registry/config";
import { createRegistryReader, type RegistryReader } from "../../src/server/registry/reader";
import { TOKENS } from "../market/support";
import { body, fixtureService, get, RECORDED_AT, recordedRegistry } from "./support";

const INDEX = "diversified-equity-d622e2a5";
const MISMATCHED = "0x50f8aacd30bddc6f9e0fbca1501526b2ac01106e626678eab50a7867eb94d759";
/** Constructed accounts of `test/fixtures/market/balances.json`. */
const ABOVE = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
const ON_TARGET = "0x0000000000000000000000000000000000001001";
const EMPTY = "0x0000000000000000000000000000000000001003";
const ONLY_USDC = "0x0000000000000000000000000000000000001004";
const META = "0xb2000000000000000000008bc8786b856e61707c";
const MSFT = "0xb200000000000000000000ab99cfa739e253872b";

function options(registry: RegistryReader = recordedRegistry(), service = fixtureService()): PortfolioApiOptions {
  return {
    registry: () => registry,
    mode: () => "replay" as const,
    marketMode: () => "replay" as const,
    now: () => RECORDED_AT,
    marketData: service.marketData,
  };
}

type Row = { token: string; symbol: string; currentWeightBps: number | null; driftBps: number | null };
type Portfolio = {
  constituents: Row[];
  outsideIndex: Row[];
  totals: Record<string, string | number | null>;
  drift: Record<string, unknown> | null;
  issues: { code: string; severity: string; token: string | null }[];
  index: Record<string, unknown>;
};

async function portfolio(query: string, opts = options()) {
  const response = await portfolioHandler(opts)(get(`/api/v1/portfolio?${query}`), undefined);
  const parsed = await body(response);
  return { response, data: parsed.data as Portfolio, meta: parsed.meta, error: parsed.error };
}

async function plan(query: string, opts = options()) {
  const response = await portfolioPlanHandler(opts)(get(`/api/v1/portfolio/plan?${query}`), undefined);
  const parsed = await body(response);
  return {
    response,
    data: parsed.data as Record<string, unknown> & { plan: Record<string, unknown> },
    error: parsed.error,
  };
}

describe("GET /api/v1/portfolio", () => {
  test("compares a wallet above the threshold, every constituent included, in ascending token order", async () => {
    const { response, data, meta } = await portfolio(`address=${ABOVE}&index=${INDEX}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=15");
    expect(data.index).toMatchObject({ identifier: INDEX, name: "Diversified Equity", version: 2, isLatest: true });
    expect(data.index.driftThresholdBps).toBe(500);
    expect(
      data.constituents.map(({ symbol, currentWeightBps, driftBps }) => [symbol, currentWeightBps, driftBps]),
    ).toEqual([
      ["TSLAc", 2000, -500],
      ["MSTRc", 500, -500],
      ["NVDAc", 4000, 1500],
      ["AAPLc", 2000, -500],
      ["AMZNc", 1500, 0],
    ]);
    expect(data.totals).toEqual({
      investedValueUsdE8: "799999999461",
      quoteBalance: "250500000",
      quoteValueUsdE8: "25050000000",
      quotePriceE8: "100000000",
      deployableValueUsdE8: "825049999461",
      cashShareBps: 303,
    });
    expect(data.drift).toEqual({
      maxAbsDriftBps: 1500,
      maxDriftToken: TOKENS.NVDA,
      turnoverBps: 1500,
      driftThresholdBps: 500,
      thresholdReached: true,
    });
    // The market is closed at the recorded block: every price is a last close, reported as a warning.
    expect(new Set(data.issues.map(({ code, severity }) => `${code}:${severity}`))).toEqual(
      new Set(["market_closed:warning"]),
    );
    expect(meta).toMatchObject({
      mode: "replay",
      registry: { chainId: 31_337, mode: "replay" },
      balances: { chainId: 8453, blockNumber: "60489401", blockTimestamp: "2026-11-21T19:10:55Z", mode: "replay" },
      marketPhase: "closed",
    });
  });

  test("reports eligible holdings outside the index without counting them", async () => {
    const { data } = await portfolio(`address=${ABOVE}&index=${INDEX}`);
    expect(data.outsideIndex.map(({ token, symbol }) => [token, symbol])).toEqual([
      [META, "METAc"],
      [MSFT, "MSFTc"],
    ]);
    expect(data.outsideIndex[0]).toMatchObject({ balance: "300000000", valueUsdE8: "170153376066" });
    expect(data.totals.investedValueUsdE8).toBe("799999999461");
  });

  test("a wallet on target has no drift and does not reach the threshold", async () => {
    const { data } = await portfolio(`address=${ON_TARGET}&index=${INDEX}`);
    expect(data.constituents.every(({ driftBps }) => driftBps === 0)).toBe(true);
    expect(data.drift).toMatchObject({ maxAbsDriftBps: 0, thresholdReached: false });
    expect(data.outsideIndex).toEqual([]);
  });

  test("an empty wallet lists every constituent at zero, with no weight and no drift", async () => {
    const { data } = await portfolio(`address=${EMPTY}&index=${INDEX}`);
    expect(data.constituents).toHaveLength(5);
    for (const row of data.constituents)
      expect(row).toMatchObject({ balance: "0", currentWeightBps: null, driftBps: null });
    expect(data.totals).toMatchObject({ investedValueUsdE8: "0", quoteBalance: "0", cashShareBps: null });
    expect(data.drift).toBeNull();
  });

  test("an older version is compared when asked, and says that a newer one exists", async () => {
    const { data } = await portfolio(`address=${ONLY_USDC}&index=${INDEX}&version=1`);
    expect(data.index).toMatchObject({ version: 1, latestVersion: 2, isLatest: false, driftThresholdBps: 500 });
    expect(data.constituents).toHaveLength(4);
  });

  test("a price that is not usable blocks the valuation instead of producing a partial total", async () => {
    const { data } = await portfolio(
      `address=${ABOVE}&index=${INDEX}`,
      options(recordedRegistry(), fixtureService(RECORDED_AT + 198_000)),
    );
    expect(data.totals.investedValueUsdE8).toBeNull();
    expect(data.drift).toBeNull();
    expect(data.issues.filter(({ severity }) => severity === "blocker").map(({ code }) => code)).toContain(
      "price_unavailable",
    );
    expect(data.constituents.every(({ currentWeightBps }) => currentWeightBps === null)).toBe(true);
  });

  test("balances are cached per address: one address never answers with the data of another", async () => {
    const shared = options();
    const first = await portfolio(`address=${ABOVE}&index=${INDEX}`, shared);
    const second = await portfolio(`address=${ON_TARGET}&index=${INDEX}`, shared);
    const again = await portfolio(`address=${ABOVE}&index=${INDEX}`, shared);
    expect(second.data.totals.quoteBalance).toBe("120000000");
    expect(again.data.totals).toEqual(first.data.totals);
  });

  test("each request error has its status and code", async () => {
    const cases: [string, number, string][] = [
      [`index=${INDEX}`, 400, "invalid_parameter"],
      [`address=0x12&index=${INDEX}`, 400, "invalid_address"],
      [`address=${ABOVE}`, 400, "invalid_parameter"],
      [`address=${ABOVE}&index=${INDEX}&version=0`, 400, "invalid_parameter"],
      [`address=${ABOVE}&index=${INDEX}&limit=1`, 400, "invalid_parameter"],
      [`address=${ABOVE}&index=not%20an%20identifier`, 400, "invalid_identifier"],
      [`address=${ABOVE}&index=0x${"1".repeat(64)}`, 404, "index_not_found"],
      [`address=${ABOVE}&index=${INDEX}&version=3`, 404, "version_not_found"],
      [`address=${ABOVE}&index=${MISMATCHED}`, 409, "version_not_conformant"],
    ];
    for (const [query, status, code] of cases) {
      const { response, error } = await portfolio(query);
      expect([query, response.status, error?.code]).toEqual([query, status, code]);
    }
  });

  test("a chain without the registry answers 409 registry_not_deployed", async () => {
    const base = createRegistryReader({ config: resolveRegistryConfig({}) });
    const { response, error } = await portfolio(`address=${ABOVE}&index=${INDEX}`, options(base));
    expect(response.status).toBe(409);
    expect(error).toMatchObject({
      code: "registry_not_deployed",
      details: { chainId: 8453, reason: "not_configured" },
    });
  });

  test("a balance read that fails answers 503, never an empty wallet", async () => {
    const log = spyOn(console, "error").mockImplementation(() => {});
    try {
      const { response, error } = await portfolio(`address=0x${"9".repeat(40)}&index=${INDEX}`);
      expect(response.status).toBe(503);
      expect(error).toMatchObject({ code: "upstream_unavailable", details: { source: "base_rpc" } });
    } finally {
      log.mockRestore();
    }
  });
});

describe("a balance read that does not cover the snapshot", () => {
  test("a constituent missing from the balance read answers 502, never a zero balance or a plan to buy it", async () => {
    const log = spyOn(console, "error").mockImplementation(() => {});
    try {
      const inner = fixtureService().marketData();
      // The balance read was made for an older asset list that did not hold NVDAc yet.
      const partial: MarketData = {
        getSnapshot: () => inner.getSnapshot(),
        getBalances: async (account) => {
          const read = await inner.getBalances(account);
          const balances = new Map(read.value.balances);
          balances.delete(TOKENS.NVDA);
          return { ...read, value: { ...read.value, balances } };
        },
      };
      const opts = { ...options(), marketData: () => partial };
      const compared = await portfolio(`address=${ABOVE}&index=${INDEX}`, opts);
      expect(compared.response.status).toBe(502);
      expect(compared.error).toMatchObject({ code: "upstream_malformed", details: { source: "base_rpc" } });
      const planned = await plan(`address=${ABOVE}&index=${INDEX}&mode=rebalance`, opts);
      expect(planned.response.status).toBe(502);
      expect(planned.error?.code).toBe("upstream_malformed");
      // The same read with NVDAc present is a valid comparison.
      expect((await portfolio(`address=${ABOVE}&index=${INDEX}`)).response.status).toBe(200);
    } finally {
      log.mockRestore();
    }
  });
});

describe("meta.mode of the portfolio and the plan", () => {
  test("is replay as soon as the registry or the market data is replayed, live only when neither is", async () => {
    const query = `address=${ABOVE}&index=${INDEX}`;
    for (const [registry, market, expected] of [
      ["live", "live", "live"],
      ["replay", "live", "replay"],
      ["live", "replay", "replay"],
    ] as const) {
      const opts = { ...options(), mode: () => registry, marketMode: () => market };
      expect((await portfolio(query, opts)).meta).toMatchObject({ mode: expected, balances: { mode: market } });
      const response = await portfolioPlanHandler(opts)(
        get(`/api/v1/portfolio/plan?${query}&mode=rebalance`),
        undefined,
      );
      expect((await body(response)).meta).toMatchObject({ mode: expected, registry: { mode: registry } });
    }
  });
});

describe("GET /api/v1/portfolio/plan", () => {
  test("a ready rebalance sells what is above target, then buys, and states that it is not a quote", async () => {
    const { response, data } = await plan(`address=${ABOVE}&index=${INDEX}&mode=rebalance`);
    expect(response.status).toBe(200);
    expect(data).toMatchObject({
      priceBasis: "reference",
      executable: false,
      statement: PLAN_STATEMENT,
      mode: "rebalance",
      depositUsdE8: "0",
      reserveBps: 50,
      minLegValueUsdE8: "100000000",
    });
    expect(PLAN_STATEMENT).toContain("no executable quote, no slippage and no gas");
    const ready = data.plan as {
      status: string;
      legs: { side: string; symbol: string }[];
      currentMaxAbsDriftBps: number;
    };
    expect(ready.status).toBe("ready");
    expect(ready.legs.map(({ side, symbol }) => `${side} ${symbol}`)).toEqual([
      "sell NVDAc",
      "buy TSLAc",
      "buy MSTRc",
      "buy AAPLc",
      "buy AMZNc",
    ]);
    expect(ready.currentMaxAbsDriftBps).toBe(1500);
  });

  test("buy only never sells, and a deposit too small for a first replication is blocked with the minimum", async () => {
    const buyOnly = await plan(`address=${ABOVE}&index=${INDEX}&mode=buy_only`);
    const legs = (buyOnly.data.plan as { legs: { side: string }[] }).legs;
    expect(legs.every(({ side }) => side === "buy")).toBe(true);
    const blocked = await plan(`address=${EMPTY}&index=${INDEX}&mode=buy_only&depositUsdE8=200000000`);
    expect(blocked.data.plan).toMatchObject({
      status: "blocked",
      blockers: [{ code: "below_minimum_portfolio_value", minimumDeployableValueUsdE8: "1005033970" }],
    });
    expect("legs" in blocked.data.plan).toBe(false);
    const nothing = await plan(`address=${EMPTY}&index=${INDEX}&mode=rebalance`);
    expect(nothing.data.plan).toMatchObject({ status: "blocked", blockers: [{ code: "zero_deployable_value" }] });
  });

  test("options outside their documented bounds answer 400", async () => {
    const base = `address=${ABOVE}&index=${INDEX}`;
    for (const query of [
      base,
      `${base}&mode=sell`,
      `${base}&mode=rebalance&reserveBps=2001`,
      `${base}&mode=rebalance&reserveBps=-1`,
      `${base}&mode=rebalance&depositUsdE8=100000000000000001`,
      `${base}&mode=rebalance&depositUsdE8=1.5`,
      `${base}&mode=rebalance&minLegValueUsdE8=100000000000001`,
      `${base}&mode=rebalance&exitTokens=${META}`,
    ]) {
      const { response, error } = await plan(query);
      expect([query, response.status, error?.code]).toEqual([query, 400, "invalid_parameter"]);
    }
    const bounds = await plan(
      `${base}&mode=rebalance&reserveBps=2000&minLegValueUsdE8=0&depositUsdE8=100000000000000000`,
    );
    expect(bounds.response.status).toBe(200);
  });

  test("the response schema lists exactly the findings of the calculation specification", () => {
    const specification = readFileSync(
      new URL("../../../../docs/architecture/calculation.md", import.meta.url),
      "utf8",
    );
    const table = specification.slice(specification.indexOf("## Blockers and warnings"));
    const documented = [...table.matchAll(/^\| `([a-z_]+)` +\| (?:Blocker|Warning) /gm)].flatMap(
      (match) => match[1] ?? [],
    );
    expect(documented.length).toBeGreaterThan(10);
    expect(CALCULATION_ISSUE_CODES.map(String).sort()).toEqual(documented.sort());
  });
});
