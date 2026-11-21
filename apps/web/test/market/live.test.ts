/**
 * Live verification against the issuer API and Base mainnet. Read-only: HTTP GET and `eth_call` only.
 * Skipped unless `LIVE_TESTS=1`, so it never runs in CI:
 *
 *   LIVE_TESTS=1 bun test test/market/live.test.ts
 *
 * Uses `BASE_RPC_URL`, or the public endpoint when it is unset.
 */
import { describe, expect, test } from "bun:test";
import { type Address, createPublicClient, http, parseAbi } from "viem";
import { aggregatorAbi } from "../../src/server/market/abis";
import { ASSET_LIST_URL, fetchAssetList } from "../../src/server/market/asset-list";
import { resolveBaseRpcUrl } from "../../src/server/market/config";
import { FEED_DECIMALS, REFERENCE_FEEDS } from "../../src/server/market/feeds";
import { createMarketData } from "../../src/server/market/index";

const live = process.env.LIVE_TESTS === "1";
const symbolAbi = parseAbi(["function symbol() view returns (string)"]);

describe.skipIf(!live)("live: issuer API and Base mainnet", () => {
  test("every entry of the feed map is confirmed by onchain reads and by the issuer API", async () => {
    const client = createPublicClient({ transport: http(resolveBaseRpcUrl()) });
    const assets = await fetchAssetList();
    const response = await fetch(`${ASSET_LIST_URL}?page_size=500`);
    const raw: { tokens: { contract_address: string; nav_price?: number; nav_price_updated_at?: string }[] } =
      await response.json();
    const navByAddress = new Map(raw.tokens.map((token) => [token.contract_address.toLowerCase(), token]));
    const blockNumber = await client.getBlockNumber();
    const rows: string[] = [];
    let navCompared = 0;

    for (const [token, feed] of REFERENCE_FEEDS) {
      const asset = assets.get(token);
      expect(asset, `${token} is in the asset list`).toBeDefined();
      const read = { address: feed.proxy, abi: aggregatorAbi, blockNumber } as const;
      const description = await client.readContract({ ...read, functionName: "description" });
      const decimals = await client.readContract({ ...read, functionName: "decimals" });
      const [, answer, , updatedAt] = await client.readContract({ ...read, functionName: "latestRoundData" });
      const symbol = await client.readContract({ address: token, abi: symbolAbi, functionName: "symbol", blockNumber });

      // The feed is the one recorded, and it names the ticker of the token it is mapped to.
      expect(description).toBe(feed.description);
      expect(decimals).toBe(FEED_DECIMALS);
      expect(symbol).toBe(asset?.symbol ?? "");
      const ticker = symbol.replace(/c$/, "");
      expect([`Coinbase ${ticker}`, `Coinbase ${ticker} / USD`]).toContain(description);

      // The issuer publishes the same value as NAV price for the same token.
      const nav = navByAddress.get(token);
      const navUpdatedAt = Date.parse(nav?.nav_price_updated_at ?? "") / 1000;
      if (nav?.nav_price !== undefined && navUpdatedAt === Number(updatedAt)) {
        expect(BigInt(nav.nav_price.toFixed(8).replace(".", ""))).toBe(answer);
        navCompared += 1;
      }
      rows.push(`${symbol.padEnd(7)} ${token} feed ${feed.proxy} "${description}" answer ${answer} at ${updatedAt}`);
    }
    console.log(
      `feed map verified at Base mainnet block ${blockNumber}, ${navCompared} answers equal to the API NAV price\n${rows.join("\n")}`,
    );
  }, 120_000);

  test("a full snapshot of the real asset list is consistent", async () => {
    const snapshot = await createMarketData().getSnapshot();
    const entries = [...snapshot.assets.values()];
    const count = (predicate: (entry: (typeof entries)[number]) => boolean) => entries.filter(predicate).length;
    const eligible = entries.filter((entry) => entry.eligibility.eligible);
    const statuses = new Map<string, number>();
    for (const entry of eligible) {
      const status = entry.referencePrice?.status ?? "none";
      statuses.set(status, (statuses.get(status) ?? 0) + 1);
    }
    const reasons = new Map<string, number>();
    for (const entry of entries) {
      if (entry.eligibility.eligible) continue;
      for (const reason of entry.eligibility.reasons) reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
    }
    console.log(
      [
        `block ${snapshot.onchain.blockNumber}, block time ${snapshot.onchain.blockTimestamp}, observed ${snapshot.observedAt}`,
        `listed ${entries.length}`,
        `token reads ok ${count((entry) => entry.token.status === "ok")}`,
        `minted ${count((entry) => entry.token.status === "ok" && entry.token.state.totalSupply > 0n)}`,
        `feed-covered ${count((entry) => REFERENCE_FEEDS.has(entry.asset.address))}`,
        `eligible ${eligible.length}`,
        `transfers paused ${count((entry) => entry.token.status === "ok" && entry.token.state.transfersPaused)}`,
        `pending multiplier ${count((entry) => entry.token.status === "ok" && entry.token.state.pendingMultiplier !== null)}`,
        `price status ${JSON.stringify(Object.fromEntries(statuses))}`,
        `ineligibility reasons ${JSON.stringify(Object.fromEntries(reasons))}`,
      ].join("\n"),
    );

    expect(entries.length).toBeGreaterThan(0);
    expect(Math.abs(snapshot.onchain.blockTimestamp - snapshot.observedAt)).toBeLessThan(120);
    // No token read may fail on a healthy endpoint, and every listed token is an initialized B20.
    expect(count((entry) => entry.token.status !== "ok")).toBe(0);
    for (const entry of eligible) {
      expect(REFERENCE_FEEDS.has(entry.asset.address)).toBe(true);
      expect(entry.referencePrice).not.toBeNull();
    }
    // A mapped feed whose proxy changed identity would surface here.
    expect(reasons.get("feed_mismatch") ?? 0).toBe(0);
    expect(reasons.get("decimals_mismatch") ?? 0).toBe(0);
    const addresses: Address[] = entries.map((entry) => entry.asset.address);
    expect(new Set(addresses).size).toBe(addresses.length);
  }, 120_000);
});
