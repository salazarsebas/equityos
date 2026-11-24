import { describe, expect, test } from "bun:test";
import type { Address, Hex } from "viem";
import {
  assessFlows,
  assessTracking,
  type BlockPrice,
  isLinkable,
  type LinkCandidate,
  type TokenTransfer,
  tierOf,
} from "../../src/server/network/classify";
import { MIN_NOTIONAL_USD_E8, TIER_B_WINDOW_SECONDS } from "../../src/server/network/definitions";

const ACCOUNT: Address = "0x00000000000000000000000000000000000000aa";
const OTHER: Address = "0x00000000000000000000000000000000000000bb";
const ZERO: Address = "0x0000000000000000000000000000000000000000";
const TOKEN_A: Address = "0xb200000000000000000000000000000000000001";
const TOKEN_B: Address = "0xb200000000000000000000000000000000000002";
const NOT_CONSTITUENT: Address = "0xb200000000000000000000000000000000000003";
const CONSTITUENTS = new Set([TOKEN_A, TOKEN_B]);
const ONE_TOKEN = 10n ** 18n;

/** 100.00 USD per token for A, 20.00 USD for B, both with 18 decimals. */
const PRICES = new Map<Address, BlockPrice>([
  [TOKEN_A, { status: "ok", priceE8: 100n * 10n ** 8n, decimals: 18, staleness: "live" }],
  [TOKEN_B, { status: "ok", priceE8: 20n * 10n ** 8n, decimals: 18, staleness: "last_close" }],
]);

function transfer(token: Address, from: Address, to: Address, amount: bigint): TokenTransfer {
  return { token, from, to, amount };
}

describe("assessFlows", () => {
  test("only constituent transfers to or from the account count, in either direction", () => {
    const transfers = [
      transfer(TOKEN_A, ZERO, ACCOUNT, ONE_TOKEN),
      transfer(TOKEN_B, ACCOUNT, OTHER, 5n * ONE_TOKEN),
      transfer(NOT_CONSTITUENT, ZERO, ACCOUNT, 1_000n * ONE_TOKEN),
      transfer(TOKEN_A, OTHER, ZERO, 9n * ONE_TOKEN),
    ];
    expect(assessFlows(transfers, ACCOUNT, CONSTITUENTS, PRICES)).toEqual({
      status: "matched",
      valueUsdE8: 200n * 10n ** 8n,
    });
  });

  test("a transfer to itself moves nothing", () => {
    const transfers = [transfer(TOKEN_A, ACCOUNT, ACCOUNT, 10n * ONE_TOKEN)];
    expect(assessFlows(transfers, ACCOUNT, CONSTITUENTS, PRICES)).toEqual({ status: "no_constituent_flows" });
    expect(assessFlows([], ACCOUNT, CONSTITUENTS, PRICES)).toEqual({ status: "no_constituent_flows" });
  });

  test("exactly the minimum notional matches, one unit below it does not", () => {
    // 0.01 token at 100.00 USD is exactly 1.00 USD.
    const exact = [transfer(TOKEN_A, ZERO, ACCOUNT, ONE_TOKEN / 100n)];
    expect(assessFlows(exact, ACCOUNT, CONSTITUENTS, PRICES)).toEqual({
      status: "matched",
      valueUsdE8: MIN_NOTIONAL_USD_E8,
    });
    const below = [transfer(TOKEN_A, ZERO, ACCOUNT, ONE_TOKEN / 100n - 1n)];
    expect(assessFlows(below, ACCOUNT, CONSTITUENTS, PRICES)).toEqual({
      status: "below_minimum_notional",
      valueUsdE8: MIN_NOTIONAL_USD_E8 - 1n,
    });
  });

  test("a flow without a usable reference price is never valued at zero", () => {
    const prices = new Map<Address, BlockPrice>([...PRICES, [TOKEN_B, { status: "unavailable" }]]);
    const transfers = [transfer(TOKEN_A, ZERO, ACCOUNT, ONE_TOKEN), transfer(TOKEN_B, ZERO, ACCOUNT, ONE_TOKEN)];
    expect(assessFlows(transfers, ACCOUNT, CONSTITUENTS, prices)).toEqual({
      status: "price_unavailable",
      token: TOKEN_B,
    });
  });
});

const MATCHED = { status: "matched", valueUsdE8: 5n * MIN_NOTIONAL_USD_E8 } as const;
const ATTESTATION = { account: ACCOUNT, blockNumber: 100n, transactionIndex: 2, blockTimestamp: 10_000n };

function candidate(overrides: Partial<LinkCandidate> = {}): LinkCandidate {
  return {
    hash: `0x${"1".repeat(64)}`,
    sender: ACCOUNT,
    blockNumber: 90n,
    transactionIndex: 0,
    blockTimestamp: ATTESTATION.blockTimestamp - 60n,
    assessment: MATCHED,
    ...overrides,
  };
}

describe("isLinkable", () => {
  test("the window edge is included, one second past it is not", () => {
    const edge = ATTESTATION.blockTimestamp - TIER_B_WINDOW_SECONDS;
    expect(isLinkable(ATTESTATION, candidate({ blockTimestamp: edge }), new Set())).toBe(true);
    expect(isLinkable(ATTESTATION, candidate({ blockTimestamp: edge - 1n }), new Set())).toBe(false);
  });

  test("the candidate must come first, be sent by the account, match and be unused", () => {
    const used = new Set<Hex>([candidate().hash]);
    expect(isLinkable(ATTESTATION, candidate(), used)).toBe(false);
    expect(isLinkable(ATTESTATION, candidate({ sender: OTHER }), new Set())).toBe(false);
    expect(isLinkable(ATTESTATION, candidate({ blockNumber: 100n, transactionIndex: 2 }), new Set())).toBe(false);
    expect(isLinkable(ATTESTATION, candidate({ blockNumber: 100n, transactionIndex: 1 }), new Set())).toBe(true);
    expect(isLinkable(ATTESTATION, candidate({ blockNumber: 101n }), new Set())).toBe(false);
    const below = { status: "below_minimum_notional", valueUsdE8: 1n } as const;
    expect(isLinkable(ATTESTATION, candidate({ assessment: below }), new Set())).toBe(false);
  });
});

describe("tierOf", () => {
  test("its own flows make tier A, a link makes tier B, nothing else is unmatched", () => {
    expect(tierOf(MATCHED, null)).toEqual({
      tier: "a",
      reason: null,
      valueUsdE8: 5n * MIN_NOTIONAL_USD_E8,
      linkedTransaction: null,
    });
    expect(tierOf({ status: "no_constituent_flows" }, candidate())).toEqual({
      tier: "b",
      reason: "no_constituent_flows",
      valueUsdE8: 5n * MIN_NOTIONAL_USD_E8,
      linkedTransaction: candidate().hash,
    });
    expect(tierOf({ status: "below_minimum_notional", valueUsdE8: 3n }, null)).toEqual({
      tier: "unmatched",
      reason: "below_minimum_notional",
      valueUsdE8: null,
      linkedTransaction: null,
    });
  });
});

describe("assessTracking", () => {
  const constituents = [
    { token: TOKEN_A, weightBps: 5_000 },
    { token: TOKEN_B, weightBps: 5_000 },
  ];
  const unitPrices = new Map<Address, BlockPrice>([
    [TOKEN_A, { status: "ok", priceE8: 10n ** 8n, decimals: 0, staleness: "live" }],
    [TOKEN_B, { status: "ok", priceE8: 10n ** 8n, decimals: 0, staleness: "live" }],
  ]);
  const track = (a: bigint, b: bigint, overrides: Partial<Parameters<typeof assessTracking>[0]> = {}) =>
    assessTracking({
      composition: "static",
      constituents,
      driftThresholdBps: 500,
      balances: new Map([
        [TOKEN_A, a],
        [TOKEN_B, b],
      ]),
      prices: unitPrices,
      ...overrides,
    });

  test("a drift equal to the threshold plus 200 bps is within, one basis point more is outside", () => {
    expect(track(5_700n, 4_300n)).toEqual({ status: "within", maxDriftBps: 700, toleranceBps: 700 });
    expect(track(5_701n, 4_299n)).toEqual({ status: "outside", maxDriftBps: 701, toleranceBps: 700 });
  });

  test("holdings that cannot be valued, or a version without onchain targets, are not assessed", () => {
    expect(track(0n, 0n)).toEqual({ status: "not_assessed", reason: "not_valued" });
    expect(track(1n, 1n, { prices: new Map([[TOKEN_A, { status: "unavailable" }]]) })).toEqual({
      status: "not_assessed",
      reason: "not_valued",
    });
    expect(track(1n, 1n, { composition: "dynamic_weights" })).toEqual({ status: "not_assessed", reason: "not_static" });
    expect(track(1n, 1n, { driftThresholdBps: null })).toEqual({ status: "not_assessed", reason: "not_verified" });
    expect(track(1n, 1n, { balances: new Map([[TOKEN_A, null]]) })).toEqual({
      status: "not_assessed",
      reason: "not_valued",
    });
  });
});
