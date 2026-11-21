import "server-only";
import type { Address } from "viem";

/** Decimals of every reference feed in the map. A feed that reports anything else is rejected at read time. */
export const FEED_DECIMALS = 8;

export interface ReferenceFeed {
  /** Chainlink feed proxy on Base mainnet. */
  readonly proxy: Address;
  /** Exact `description()` of the feed. Checked on every read, so a repointed proxy cannot pass unnoticed. */
  readonly description: string;
}

/** Whether a feed proxy answered with the identity recorded for it. */
export function isExpectedFeed(feed: ReferenceFeed, read: { decimals: number; description: string }): boolean {
  return read.decimals === FEED_DECIMALS && read.description === feed.description;
}

/**
 * Reference feed of each feed-covered token, keyed by lowercase token address. Never keyed by symbol: symbols
 * are mutable onchain.
 *
 * These are the "Coinbase <ticker>" tokenized equity feeds of Chainlink's Base mainnet feed listing
 * (market hours "us_equities_24/5", 8 decimals, 0.5% deviation, 24 hour heartbeat). The answer is the price of
 * one token in USD and already includes the token's share multiplier.
 *
 * Every entry was confirmed with onchain reads at Base mainnet block 60490615 (2026-11-21): `description()` and
 * `decimals()` of the proxy, `symbol()` of the token, and equality of `latestRoundData().answer` with the
 * issuer API's `nav_price` for the token. `test/market/live.test.ts` repeats the whole verification.
 *
 * The same listing also carries "(24/7)" variants for some tickers. They are a different product and are not
 * used here.
 */
export const REFERENCE_FEEDS: ReadonlyMap<Address, ReferenceFeed> = new Map<Address, ReferenceFeed>([
  [
    "0xb20000000000000000000016e38fd364d271ba28",
    { proxy: "0xeEDc7412E991a3F2BD693eb2aC7fB0F27d4660dA", description: "Coinbase ANT / USD" },
  ],
  [
    "0xb20000000000000000000019f6e7c675b73c2e4d",
    { proxy: "0x0231cF2635D1E17bB5c2462cc7504Ba1fBd61f33", description: "Coinbase CRCL" },
  ],
  [
    "0xb2000000000000000000001e800a7f5189430cd0",
    { proxy: "0xFaf869185383a24F8cb00e27BdA6b63B9905DCb4", description: "Coinbase TSLA" },
  ],
  [
    "0xb2000000000000000000002d0ba3164cc74f58b7",
    { proxy: "0x5bF49E0ffA937CE2FfF033c739aD7C634c4D34F2", description: "Coinbase GOOGL" },
  ],
  [
    "0xb200000000000000000000397293cb8cda9a10c5",
    { proxy: "0x388b0dC46C0Fb05A74BeE0994fa5b02c6Fcca2eA", description: "Coinbase SNDK" },
  ],
  [
    "0xb2000000000000000000004884b426556b92883d",
    { proxy: "0xB3cE282CD188b35DA0E38D8Bc7d58e33173D202a", description: "Coinbase MSTR" },
  ],
  [
    "0xb2000000000000000000004aff16039ba04bdfbc",
    { proxy: "0xAB657C39bac0D5886250D70849e2E3E008F2EECB", description: "Coinbase INTC" },
  ],
  [
    "0xb20000000000000000000078ee7ce2fe4908108c",
    { proxy: "0x04689a41629776563E6822F76f2e57D148d28513", description: "Coinbase NVDA" },
  ],
  [
    "0xb2000000000000000000007b9fcbd005511acbd5",
    { proxy: "0x6A634B235903C4ad6376892180d6fF8612e3Fa68", description: "Coinbase SPCX" },
  ],
  [
    "0xb2000000000000000000008bc8786b856e61707c",
    { proxy: "0x6526aE6797A76123638b863AeE4dD27Ba4E4b27D", description: "Coinbase META" },
  ],
  [
    "0xb200000000000000000000ab99cfa739e253872b",
    { proxy: "0xeB10A6c9aa7E537aEd766C08c35Dae35B321b18c", description: "Coinbase MSFT" },
  ],
  [
    "0xb200000000000000000000c2e324d24d7eecd1fb",
    { proxy: "0x787f13dEa48Db0897CbCDD985de77809D837F988", description: "Coinbase AAPL" },
  ],
  [
    "0xb200000000000000000000d9192b6b456483c2e8",
    { proxy: "0x06A8E4b3aBB3B7543d8396FB2B763d22820cB295", description: "Coinbase AMZN" },
  ],
]);
