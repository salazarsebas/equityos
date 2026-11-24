import { describe, expect, test } from "bun:test";
import type { ReferenceFeed } from "../../src/server/market/feeds";
import type { FeedRead } from "../../src/server/market/onchain";
import { buildReferencePrice, type ReferencePrice } from "../../src/server/market/reference-price";

const feed: ReferenceFeed = { proxy: "0x04689a41629776563E6822F76f2e57D148d28513", description: "Coinbase NVDA" };

/** The recorded NVDA round: published Friday 2026-11-20 23:42:40 UTC, 18:42:40 ET, in the post-market session. */
const UPDATED_AT = 1_795_218_160;
const ROUND = {
  roundId: 36_893_488_147_419_104_856n,
  answer: 12_982_480_034n,
  updatedAt: UPDATED_AT,
  answeredInRound: 36_893_488_147_419_104_856n,
};
const read = { status: "ok", decimals: 8, description: "Coinbase NVDA", round: ROUND } satisfies FeedRead;
const FRIDAY_CLOSE = Date.parse("2026-11-21T01:00:00Z") / 1000;
const SATURDAY = 1_795_288_255;

function price(now: number, overrides: Partial<Parameters<typeof buildReferencePrice>[0]> = {}) {
  return buildReferencePrice({ feed, read, now, servedStale: false, recorded: false, ...overrides });
}

function withRound(round: Partial<typeof ROUND>): FeedRead {
  return { ...read, round: { ...ROUND, ...round } };
}

describe("buildReferencePrice", () => {
  test("the price is the feed answer, unchanged, with its round and timestamp", () => {
    expect(price(UPDATED_AT + 60)).toEqual({
      status: "live",
      source: "chainlink",
      priceE8: 12_982_480_034n,
      updatedAt: UPDATED_AT,
      roundId: 36_893_488_147_419_104_856n,
      marketPhase: "extended",
    });
  });

  test("live up to thirty minutes, then delayed, while the session is open", () => {
    expect(price(UPDATED_AT + 1_800).status).toBe("live");
    expect(price(UPDATED_AT + 1_801).status).toBe("delayed");
    expect(price(FRIDAY_CLOSE - 1)).toMatchObject({ status: "delayed", marketPhase: "extended" });
  });

  test("last_close from the Friday close through the weekend", () => {
    expect(price(FRIDAY_CLOSE)).toMatchObject({ status: "last_close", marketPhase: "closed" });
    expect(price(SATURDAY)).toMatchObject({ status: "last_close", marketPhase: "closed", priceE8: 12_982_480_034n });
  });

  test("a feed that missed its heartbeat is unavailable and carries no usable price", () => {
    // Tuesday 2026-11-24 15:00 UTC: 39 hours of trading time after the round.
    const result = price(Date.parse("2026-11-24T15:00:00Z") / 1000);
    expect(result).toEqual({
      status: "unavailable",
      source: "chainlink",
      reason: "stale_feed",
      lastObserved: { priceE8: 12_982_480_034n, updatedAt: UPDATED_AT, roundId: 36_893_488_147_419_104_856n },
    });
    expect("priceE8" in result).toBe(false);
  });

  test("outside the market calendar the price degrades to last_close", () => {
    const now = Date.parse("2028-03-01T16:00:00Z") / 1000;
    expect(price(now, { read: withRound({ updatedAt: now - 30 }) })).toMatchObject({
      status: "last_close",
      marketPhase: "unknown",
    });
  });

  test("a read served stale from cache is never live", () => {
    expect(price(UPDATED_AT + 60, { servedStale: true }).status).toBe("delayed");
    expect(price(UPDATED_AT + 3_600, { servedStale: true }).status).toBe("delayed");
    expect(price(SATURDAY, { servedStale: true }).status).toBe("last_close");
  });

  test("a replayed recording is never live or delayed: it is a recorded value, reported as last_close", () => {
    expect(price(UPDATED_AT + 60).status).toBe("live");
    expect(price(UPDATED_AT + 60, { recorded: true })).toMatchObject({ status: "last_close", priceE8: ROUND.answer });
    expect(price(UPDATED_AT + 3_600, { recorded: true }).status).toBe("last_close");
    expect(price(UPDATED_AT + 60, { recorded: true, servedStale: true }).status).toBe("last_close");
    // An unusable round stays unavailable: the cap never makes a price usable.
    expect(price(UPDATED_AT + 60, { recorded: true, read: withRound({ answer: 0n }) }).status).toBe("unavailable");
  });

  test("a failed or absent feed read is unavailable, with nothing substituted", () => {
    const expected: ReferencePrice = {
      status: "unavailable",
      source: "chainlink",
      reason: "feed_read_failed",
      lastObserved: null,
    };
    expect(price(SATURDAY, { read: { status: "read_failed" } })).toEqual(expected);
    expect(price(SATURDAY, { read: undefined })).toEqual(expected);
  });

  test("a proxy that answers with another identity is unavailable", () => {
    expect(price(SATURDAY, { read: { ...read, decimals: 18 } })).toMatchObject({ reason: "feed_mismatch" });
    expect(price(SATURDAY, { read: { ...read, description: "Coinbase NVDA (24/7)" } })).toMatchObject({
      status: "unavailable",
      reason: "feed_mismatch",
      lastObserved: null,
    });
  });

  test("an invalid round is unavailable: zero, negative, incomplete, carried over or from the future", () => {
    const invalid: ReferencePrice = {
      status: "unavailable",
      source: "chainlink",
      reason: "invalid_round",
      lastObserved: null,
    };
    expect(price(SATURDAY, { read: withRound({ answer: 0n }) })).toEqual(invalid);
    expect(price(SATURDAY, { read: withRound({ answer: -1n }) })).toEqual(invalid);
    expect(price(SATURDAY, { read: withRound({ updatedAt: 0 }) })).toEqual(invalid);
    expect(price(SATURDAY, { read: withRound({ answeredInRound: ROUND.roundId - 1n }) })).toEqual(invalid);
    expect(price(UPDATED_AT - 121)).toEqual(invalid);
    expect(price(UPDATED_AT - 120).status).toBe("live");
    expect(price(SATURDAY, { read: withRound({ answer: 1n }) })).toMatchObject({ status: "last_close", priceE8: 1n });
  });
});
