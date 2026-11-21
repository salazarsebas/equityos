import { describe, expect, test } from "bun:test";
import { positionValueUsdE8 } from "@equityos/core";
import { createPublicClient, encodeAbiParameters, encodeFunctionData } from "viem";
import { b20AssetAbi } from "../../src/server/market/abis";
import { REFERENCE_FEEDS } from "../../src/server/market/feeds";
import {
  createMarketData,
  IneligibleTokenError,
  MissingFeedError,
  requireReferencePrice,
  requireTransferable,
  StaleFeedError,
  TokenPausedError,
  UpstreamError,
} from "../../src/server/market/index";
import {
  assetListFixture,
  type FixtureTransportOptions,
  fixtureFetch,
  fixtureTransport,
  onchainFixture,
  TOKENS,
} from "./support";

/** Saturday 2026-11-21 19:10:55 UTC: the time of the recorded block. The market is closed. */
const RECORDED_AT = onchainFixture.blockTimestamp;
/** Publication time of the recorded NVDA round: Friday 23:42:40 UTC, in the post-market session. */
const NVDA_UPDATED_AT = 1_795_218_160;

function service(start: number, options: FixtureTransportOptions = {}) {
  const clock = { now: start };
  const outage = { api: false, rpc: false };
  const api = fixtureFetch();
  const rpc = fixtureTransport(onchainFixture, { ...options, failEthCall: () => outage.rpc });
  const fetcher: typeof fetch = Object.assign(
    (...args: Parameters<typeof fetch>) =>
      outage.api ? Promise.resolve(new Response("", { status: 503 })) : api.fetch(...args),
    { preconnect: fetch.preconnect },
  );
  const marketData = createMarketData({
    fetch: fetcher,
    sleep: async () => {},
    client: createPublicClient({ transport: rpc.transport }),
    now: () => clock.now,
  });
  return { marketData, clock, outage, apiRequests: api.urls, rpcRequests: rpc.requests };
}

describe("market snapshot from the recorded API pages and block", () => {
  test("lists every token of the asset list, keyed by lowercase address", async () => {
    const snapshot = await service(RECORDED_AT).marketData.getSnapshot();
    expect(snapshot.assets.size).toBe(17);
    for (const [address, entry] of snapshot.assets) {
      expect(address).toMatch(/^0x[0-9a-f]{40}$/);
      expect(entry.asset.address).toBe(address);
    }
    expect(snapshot.observedAt).toBe(RECORDED_AT);
    expect(snapshot.onchain).toEqual({
      fetchedAt: RECORDED_AT,
      servedStale: false,
      failure: null,
      blockNumber: 60_489_401n,
      blockTimestamp: RECORDED_AT,
    });
    expect(snapshot.assetList).toEqual({ fetchedAt: RECORDED_AT, servedStale: false, failure: null });
  });

  test("the thirteen feed-covered, minted tokens are eligible and nothing else is", async () => {
    const snapshot = await service(RECORDED_AT).marketData.getSnapshot();
    const eligible = [...snapshot.assets.values()].filter((entry) => entry.eligibility.eligible);
    expect(eligible.map((entry) => entry.asset.address).sort()).toEqual([...REFERENCE_FEEDS.keys()].sort());
    expect(snapshot.assets.get(TOKENS.APP)?.eligibility).toEqual({ eligible: false, reasons: ["missing_feed"] });
    expect(snapshot.assets.get(TOKENS.RKT)?.eligibility).toEqual({
      eligible: false,
      reasons: ["not_minted", "missing_feed"],
    });
  });

  test("an ineligible token has no reference price", async () => {
    const snapshot = await service(RECORDED_AT).marketData.getSnapshot();
    for (const entry of snapshot.assets.values()) {
      expect(entry.referencePrice === null).toBe(!entry.eligibility.eligible);
    }
  });

  test("on the Saturday of the recording every reference price is the Friday value, as last_close", async () => {
    const snapshot = await service(RECORDED_AT).marketData.getSnapshot();
    for (const token of REFERENCE_FEEDS.keys()) {
      expect(snapshot.assets.get(token)?.referencePrice).toMatchObject({
        status: "last_close",
        source: "chainlink",
        marketPhase: "closed",
      });
    }
    expect(snapshot.assets.get(TOKENS.NVDA)?.referencePrice).toEqual({
      status: "last_close",
      source: "chainlink",
      priceE8: 12_982_480_034n,
      updatedAt: NVDA_UPDATED_AT,
      roundId: 36_893_488_147_419_104_856n,
      marketPhase: "closed",
    });
  });

  test("every reference price equals the NAV price the issuer API recorded for the same token", async () => {
    const snapshot = await service(RECORDED_AT).marketData.getSnapshot();
    const recorded = assetListFixture.pages.flatMap((page) => page.tokens);
    let compared = 0;
    for (const token of recorded) {
      if (typeof token.nav_price !== "number") continue;
      const price = requireReferencePrice(snapshot, `0x${String(token.contract_address).slice(2).toLowerCase()}`);
      expect(price.priceE8).toBe(BigInt(token.nav_price.toFixed(8).replace(".", "")));
      compared += 1;
    }
    expect(compared).toBe(13);
  });
});

describe("the share multiplier is not applied to the reference price", () => {
  test("a token with multiplier 8 is priced at the feed answer, not at 8 times or one eighth of it", async () => {
    const snapshot = await service(RECORDED_AT).marketData.getSnapshot();
    const entry = snapshot.assets.get(TOKENS.SNDK);
    // The recorded token: one token is 8 shares, and the feed answers 649.44 USD for one token.
    expect(entry?.token).toMatchObject({ status: "ok", state: { multiplierWad: 8_000_000_000_000_000_000n } });
    const price = requireReferencePrice(snapshot, TOKENS.SNDK);
    expect(price.priceE8).toBe(64_944_000_000n);
    expect(price.priceE8).not.toBe(64_944_000_000n * 8n);
    expect(price.priceE8).not.toBe(64_944_000_000n / 8n);
    // One whole token (1e8 base units) is worth exactly the feed answer.
    expect(positionValueUsdE8(100_000_000n, price.priceE8, 8, "down")).toBe(64_944_000_000n);
  });

  test("a fractional multiplier leaves the price untouched as well", async () => {
    const snapshot = await service(RECORDED_AT).marketData.getSnapshot();
    expect(snapshot.assets.get(TOKENS.NVDA)?.token).toMatchObject({
      state: { multiplierWad: 1_000_537_939_576_369_481n },
    });
    expect(requireReferencePrice(snapshot, TOKENS.NVDA).priceE8).toBe(12_982_480_034n);
  });
});

describe("caching", () => {
  test("serves the snapshot from cache within the onchain TTL and recomputes staleness for the new time", async () => {
    const { marketData, clock, apiRequests, rpcRequests } = service(NVDA_UPDATED_AT + 60);
    const first = await marketData.getSnapshot();
    expect(first.assets.get(TOKENS.NVDA)?.referencePrice?.status).toBe("live");
    clock.now += 14;
    const second = await marketData.getSnapshot();
    expect(rpcRequests).toHaveLength(2);
    expect(apiRequests).toHaveLength(3);
    expect(second.observedAt).toBe(NVDA_UPDATED_AT + 74);
    expect(second.onchain.fetchedAt).toBe(NVDA_UPDATED_AT + 60);
  });

  test("reads the chain again after 15 seconds and the asset list again after 10 minutes", async () => {
    const { marketData, clock, apiRequests, rpcRequests } = service(RECORDED_AT);
    await marketData.getSnapshot();
    clock.now += 15;
    const second = await marketData.getSnapshot();
    expect(rpcRequests).toHaveLength(4);
    expect(apiRequests).toHaveLength(3);
    expect(second.onchain.fetchedAt).toBe(RECORDED_AT + 15);
    expect(second.assetList.fetchedAt).toBe(RECORDED_AT);
    clock.now = RECORDED_AT + 600;
    const third = await marketData.getSnapshot();
    expect(apiRequests).toHaveLength(6);
    expect(third.assetList.fetchedAt).toBe(RECORDED_AT + 600);
  });

  test("when the RPC fails, the last read is served with its original time, flagged, and never as live", async () => {
    const start = NVDA_UPDATED_AT + 60;
    const { marketData, clock, outage } = service(start);
    expect((await marketData.getSnapshot()).assets.get(TOKENS.NVDA)?.referencePrice?.status).toBe("live");
    outage.rpc = true;
    clock.now = start + 120;
    const stale = await marketData.getSnapshot();
    expect(stale.onchain).toMatchObject({ fetchedAt: start, servedStale: true, failure: "upstream_failure" });
    expect(stale.observedAt).toBe(start + 120);
    expect(stale.assets.get(TOKENS.NVDA)?.referencePrice).toMatchObject({
      status: "delayed",
      priceE8: 12_982_480_034n,
      updatedAt: NVDA_UPDATED_AT,
    });
  });

  test("when the RPC stays down past the stale window, the failure is thrown", async () => {
    const { marketData, clock, outage } = service(RECORDED_AT);
    await marketData.getSnapshot();
    outage.rpc = true;
    clock.now = RECORDED_AT + 15 + 300;
    expect((await marketData.getSnapshot()).onchain.servedStale).toBe(true);
    clock.now = RECORDED_AT + 15 + 300 + 1;
    await expect(marketData.getSnapshot()).rejects.toBeInstanceOf(UpstreamError);
  });

  test("when the API fails, the last asset list is served with its original time while the chain stays fresh", async () => {
    const { marketData, clock, outage } = service(RECORDED_AT);
    await marketData.getSnapshot();
    outage.api = true;
    clock.now = RECORDED_AT + 3_600;
    const snapshot = await marketData.getSnapshot();
    expect(snapshot.assetList).toEqual({ fetchedAt: RECORDED_AT, servedStale: true, failure: "upstream_failure" });
    expect(snapshot.onchain).toMatchObject({ fetchedAt: RECORDED_AT + 3_600, servedStale: false, failure: null });
    expect(snapshot.assets.size).toBe(17);
  });

  test("with nothing cached, a failing source is an error, not an empty snapshot", async () => {
    const api = service(RECORDED_AT);
    api.outage.api = true;
    await expect(api.marketData.getSnapshot()).rejects.toMatchObject({
      code: "upstream_failure",
      source: "coinbase_api",
    });
    const rpc = service(RECORDED_AT);
    rpc.outage.rpc = true;
    await expect(rpc.marketData.getSnapshot()).rejects.toMatchObject({ code: "upstream_failure", source: "base_rpc" });
  });
});

describe("requireReferencePrice", () => {
  test("returns the usable price of an eligible token", async () => {
    const snapshot = await service(RECORDED_AT).marketData.getSnapshot();
    expect(requireReferencePrice(snapshot, TOKENS.NVDA)).toMatchObject({
      status: "last_close",
      priceE8: 12_982_480_034n,
    });
  });

  test("throws a typed error for an unlisted token, an unminted token and a token without a feed", async () => {
    const snapshot = await service(RECORDED_AT).marketData.getSnapshot();
    const unlisted = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
    expect(() => requireReferencePrice(snapshot, unlisted)).toThrow(IneligibleTokenError);
    expect(() => requireReferencePrice(snapshot, TOKENS.APP)).toThrow(MissingFeedError);
    expect(() => requireReferencePrice(snapshot, TOKENS.RKT)).toThrow(MissingFeedError);
    // Lookups are by lowercase address only: a symbol is not a key.
    expect(() => requireReferencePrice(snapshot, "0xNVDAc")).toThrow(IneligibleTokenError);
  });

  test("throws a stale feed error with the last update time when the feed missed its heartbeat", async () => {
    const tuesday = Date.parse("2026-11-24T15:00:00Z") / 1000;
    const snapshot = await service(tuesday).marketData.getSnapshot();
    let thrown: unknown;
    try {
      requireReferencePrice(snapshot, TOKENS.NVDA);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(StaleFeedError);
    expect(thrown).toMatchObject({ code: "stale_feed", token: TOKENS.NVDA, updatedAt: NVDA_UPDATED_AT });
  });

  test("throws an ineligible token error that lists the reasons", async () => {
    const totalSupply = encodeFunctionData({ abi: b20AssetAbi, functionName: "totalSupply" });
    const snapshot = await service(RECORDED_AT, {
      override: (call) =>
        call.target.toLowerCase() === TOKENS.NVDA && call.callData === totalSupply
          ? { success: true, returnData: encodeAbiParameters([{ type: "uint256" }], [0n]) }
          : undefined,
    }).marketData.getSnapshot();
    expect(snapshot.assets.get(TOKENS.NVDA)?.referencePrice).toBeNull();
    let thrown: unknown;
    try {
      requireReferencePrice(snapshot, TOKENS.NVDA);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ code: "ineligible_token", reasons: ["not_minted"] });
  });
});

describe("requireTransferable", () => {
  const isPaused = encodeFunctionData({ abi: b20AssetAbi, functionName: "isPaused", args: [0] });

  test("passes for a token whose transfers are not paused", async () => {
    const snapshot = await service(RECORDED_AT).marketData.getSnapshot();
    expect(() => requireTransferable(snapshot, TOKENS.NVDA)).not.toThrow();
  });

  test("throws a paused token error, and pausing does not remove the reference price", async () => {
    const snapshot = await service(RECORDED_AT, {
      override: (call) =>
        call.target.toLowerCase() === TOKENS.NVDA && call.callData === isPaused
          ? { success: true, returnData: encodeAbiParameters([{ type: "bool" }], [true]) }
          : undefined,
    }).marketData.getSnapshot();
    expect(() => requireTransferable(snapshot, TOKENS.NVDA)).toThrow(TokenPausedError);
    expect(() => requireTransferable(snapshot, TOKENS.SNDK)).not.toThrow();
    expect(requireReferencePrice(snapshot, TOKENS.NVDA).priceE8).toBe(12_982_480_034n);
  });

  test("fails closed when the token is unlisted or its state was not read", async () => {
    const snapshot = await service(RECORDED_AT, {
      override: (call) =>
        call.target.toLowerCase() === TOKENS.NVDA && call.callData === isPaused
          ? { success: false, returnData: "0x" }
          : undefined,
    }).marketData.getSnapshot();
    expect(() => requireTransferable(snapshot, TOKENS.NVDA)).toThrow(IneligibleTokenError);
    expect(() => requireTransferable(snapshot, "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913")).toThrow(
      IneligibleTokenError,
    );
  });
});
