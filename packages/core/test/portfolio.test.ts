import { describe, expect, test } from "bun:test";
import {
  CalculationInputError,
  type CalculationInputErrorCode,
  computeDrift,
  type PortfolioInput,
  QUOTE_DECIMALS,
  QUOTE_PRICE_E8,
  QUOTE_UNIT_VALUE_USD_E8,
  USD_E8,
  valuePortfolio,
} from "../src/index.ts";
import { address, price } from "./helpers.ts";

const A = address(0xa1);
const B = address(0xb2);
const C = address(0xc3);
const D = address(0xd4);

/** A (8 decimals, 1,250.00 USD) at 60% and B (18 decimals, 0.50 USD) at 40%: 0.8 A and 1,000 B. */
const TWO_TOKENS: PortfolioInput = {
  constituents: [
    { token: A, weightBps: 6_000, decimals: 8 },
    { token: B, weightBps: 4_000, decimals: 18 },
  ],
  holdings: [
    { token: A, balance: 80_000_000n, decimals: 8 },
    { token: B, balance: 1_000n * 10n ** 18n, decimals: 18 },
  ],
  prices: [price(A, 1_250n * USD_E8), price(B, 50_000_000n)],
  quoteBalance: 0n,
};

/** `count` tokens of 6 decimals at 1.00 USD holding `balances` whole tokens, with the given target weights. */
function dollars(weightsBps: number[], balances: bigint[], quoteBalance = 0n): PortfolioInput {
  const tokens = [A, B, C, D].slice(0, weightsBps.length);
  return {
    constituents: tokens.map((token, i) => ({ token, weightBps: weightsBps[i] ?? 0, decimals: 6 })),
    holdings: tokens.map((token, i) => ({ token, balance: (balances[i] ?? 0n) * 1_000_000n, decimals: 6 })),
    prices: tokens.map((token) => price(token, USD_E8)),
    quoteBalance,
  };
}

function errorCode(run: () => unknown): CalculationInputErrorCode | "no error" {
  try {
    run();
  } catch (error) {
    if (error instanceof CalculationInputError) return error.code;
    throw error;
  }
  return "no error";
}

describe("quote asset assumption", () => {
  test("the quote asset has 6 decimals and is valued at exactly 1 USD", () => {
    expect(QUOTE_DECIMALS).toBe(6);
    expect(QUOTE_PRICE_E8).toBe(USD_E8);
    expect(QUOTE_UNIT_VALUE_USD_E8 * 10n ** BigInt(QUOTE_DECIMALS)).toBe(QUOTE_PRICE_E8);
  });
});

describe("valuePortfolio", () => {
  test("values each constituent at its reference price and weighs it against the invested value", () => {
    const valuation = valuePortfolio(TWO_TOKENS);
    // 0.8 * 1,250.00 = 1,000.00 USD and 1,000 * 0.50 = 500.00 USD.
    expect(valuation.positions).toEqual([
      {
        token: A,
        balance: 80_000_000n,
        decimals: 8,
        targetWeightBps: 6_000,
        priceE8: 125_000_000_000n,
        priceStatus: "live",
        valueUsdE8: 100_000_000_000n,
        // 1,000 / 1,500 = 6,666.67 bps: floor 6,666, and the larger remainder takes the missing basis point.
        weightBps: 6_667,
      },
      {
        token: B,
        balance: 1_000n * 10n ** 18n,
        decimals: 18,
        targetWeightBps: 4_000,
        priceE8: 50_000_000n,
        priceStatus: "live",
        valueUsdE8: 50_000_000_000n,
        weightBps: 3_333,
      },
    ]);
    expect(valuation.investedValueUsdE8).toBe(150_000_000_000n);
    expect(valuation.deployableValueUsdE8).toBe(150_000_000_000n);
    expect(valuation.cashShareBps).toBe(0);
    expect(valuation.outsideIndex).toEqual([]);
    expect(valuation.issues).toEqual([]);
  });

  test("a position value rounds down", () => {
    // 1.5 tokens at 1,333.33333333 USD is 1,999.999999995 USD.
    const valuation = valuePortfolio({
      constituents: [{ token: A, weightBps: 10_000, decimals: 8 }],
      holdings: [{ token: A, balance: 150_000_000n, decimals: 8 }],
      prices: [price(A, 133_333_333_333n)],
      quoteBalance: 0n,
    });
    expect(valuation.positions[0]?.valueUsdE8).toBe(199_999_999_999n);
  });

  test("the quote asset is cash to deploy: outside the weights, inside the deployable value", () => {
    // 500 USDC next to 1,500 USD of constituents.
    const valuation = valuePortfolio({ ...TWO_TOKENS, quoteBalance: 500_000_000n });
    expect(valuation.positions.map(({ weightBps }) => weightBps)).toEqual([6_667, 3_333]);
    expect(valuation.investedValueUsdE8).toBe(150_000_000_000n);
    expect(valuation.quoteBalance).toBe(500_000_000n);
    expect(valuation.quoteValueUsdE8).toBe(50_000_000_000n);
    expect(valuation.quotePriceE8).toBe(USD_E8);
    expect(valuation.deployableValueUsdE8).toBe(200_000_000_000n);
    expect(valuation.cashShareBps).toBe(2_500);
  });

  test("the uninvested share rounds down", () => {
    // 1 USDC of 3 USD deployable is 3,333.33 bps.
    expect(valuePortfolio(dollars([10_000], [2n], 1_000_000n)).cashShareBps).toBe(3_333);
    // 2 USDC of 3 USD deployable is 6,666.67 bps.
    expect(valuePortfolio(dollars([10_000], [1n], 2_000_000n)).cashShareBps).toBe(6_666);
  });

  test("weights sum to 10,000 by largest remainder", () => {
    // 1/7, 2/7 and 4/7: floors 1,428, 2,857 and 5,714 with remainders 4/7, 1/7 and 2/7.
    expect(valuePortfolio(dollars([3_334, 3_333, 3_333], [1n, 2n, 4n])).positions.map((p) => p.weightBps)).toEqual([
      1_429, 2_857, 5_714,
    ]);
    // 4/7, 2/7 and 1/7: the largest remainder is the last token.
    expect(valuePortfolio(dollars([3_334, 3_333, 3_333], [4n, 2n, 1n])).positions.map((p) => p.weightBps)).toEqual([
      5_714, 2_857, 1_429,
    ]);
  });

  test("equal remainders go to the lowest addresses", () => {
    expect(valuePortfolio(dollars([3_334, 3_333, 3_333], [5n, 5n, 5n])).positions.map((p) => p.weightBps)).toEqual([
      3_334, 3_333, 3_333,
    ]);
    // 1/6 three times and 3/6: two basis points are missing and the three remainders tie.
    const four = valuePortfolio(dollars([2_500, 2_500, 2_500, 2_500], [1n, 1n, 1n, 3n]));
    expect(four.positions.map((p) => p.weightBps)).toEqual([1_667, 1_667, 1_666, 5_000]);
  });

  test("without invested value there are no weights, and zero is not substituted", () => {
    const cashOnly = valuePortfolio(dollars([5_000, 5_000], [0n, 0n], 20_000_000n));
    expect(cashOnly.positions.map(({ weightBps }) => weightBps)).toEqual([null, null]);
    expect(cashOnly.positions.map(({ valueUsdE8 }) => valueUsdE8)).toEqual([0n, 0n]);
    expect(cashOnly.investedValueUsdE8).toBe(0n);
    expect(cashOnly.cashShareBps).toBe(10_000);
    const empty = valuePortfolio(dollars([5_000, 5_000], [0n, 0n]));
    expect(empty.deployableValueUsdE8).toBe(0n);
    expect(empty.cashShareBps).toBeNull();
  });

  test("a constituent without a holding has a zero balance", () => {
    const valuation = valuePortfolio({ ...TWO_TOKENS, holdings: [{ token: A, balance: 80_000_000n, decimals: 8 }] });
    expect(valuation.positions.map(({ balance, weightBps }) => [balance, weightBps])).toEqual([
      [80_000_000n, 10_000],
      [0n, 0],
    ]);
  });

  test("a token outside the index is reported apart and counted nowhere", () => {
    const valuation = valuePortfolio({
      ...TWO_TOKENS,
      holdings: [
        ...TWO_TOKENS.holdings,
        { token: D, balance: 3_000_000n, decimals: 6 },
        { token: C, balance: 7n, decimals: 0 },
      ],
      prices: [...TWO_TOKENS.prices, price(D, 2n * USD_E8, "last_close")],
    });
    expect(valuation.outsideIndex).toEqual([
      { token: C, balance: 7n, decimals: 0, priceE8: null, priceStatus: "missing", valueUsdE8: null },
      {
        token: D,
        balance: 3_000_000n,
        decimals: 6,
        priceE8: 200_000_000n,
        priceStatus: "last_close",
        valueUsdE8: 600_000_000n,
      },
    ]);
    expect(valuation.investedValueUsdE8).toBe(150_000_000_000n);
    expect(valuation.deployableValueUsdE8).toBe(150_000_000_000n);
    expect(valuation.positions.map(({ weightBps }) => weightBps)).toEqual([6_667, 3_333]);
    expect(valuation.issues).toEqual([]);
  });

  test("an outside token with an unusable price has no value", () => {
    const outside = (status: "unavailable" | "live", priceE8: bigint) =>
      valuePortfolio({
        ...TWO_TOKENS,
        holdings: [...TWO_TOKENS.holdings, { token: C, balance: 5n, decimals: 0 }],
        prices: [...TWO_TOKENS.prices, price(C, priceE8, status)],
      }).outsideIndex[0];
    expect(outside("unavailable", 9n * USD_E8)).toMatchObject({ priceE8: null, valueUsdE8: null });
    expect(outside("live", 0n)).toMatchObject({ priceE8: 0n, valueUsdE8: null });
  });

  test("the order of constituents, holdings and prices does not change the result", () => {
    const reversed: PortfolioInput = {
      constituents: [...TWO_TOKENS.constituents].reverse(),
      holdings: [...TWO_TOKENS.holdings].reverse(),
      prices: [...TWO_TOKENS.prices].reverse(),
      quoteBalance: TWO_TOKENS.quoteBalance,
    };
    expect(valuePortfolio(reversed)).toEqual(valuePortfolio(TWO_TOKENS));
  });
});

describe("valuePortfolio: data-quality findings", () => {
  test("a missing constituent price blocks the totals and every weight", () => {
    const valuation = valuePortfolio({ ...TWO_TOKENS, prices: [price(A, 1_250n * USD_E8)] });
    expect(valuation.issues).toEqual([{ code: "missing_price", severity: "blocker", token: B }]);
    expect(
      valuation.positions.map(({ priceStatus, priceE8, valueUsdE8, weightBps }) => [
        priceStatus,
        priceE8,
        valueUsdE8,
        weightBps,
      ]),
    ).toEqual([
      ["live", 125_000_000_000n, 100_000_000_000n, null],
      ["missing", null, null, null],
    ]);
    expect(valuation.investedValueUsdE8).toBeNull();
    expect(valuation.deployableValueUsdE8).toBeNull();
    expect(valuation.cashShareBps).toBeNull();
  });

  test("a price is needed even for a constituent the wallet does not hold", () => {
    const valuation = valuePortfolio({
      ...TWO_TOKENS,
      holdings: TWO_TOKENS.holdings.slice(0, 1),
      prices: [price(A, USD_E8)],
    });
    expect(valuation.issues).toEqual([{ code: "missing_price", severity: "blocker", token: B }]);
    expect(valuation.investedValueUsdE8).toBeNull();
  });

  test("an unavailable price is not a value", () => {
    const valuation = valuePortfolio({
      ...TWO_TOKENS,
      prices: [price(A, 1_250n * USD_E8, "unavailable"), price(B, 50_000_000n)],
    });
    expect(valuation.issues).toEqual([{ code: "price_unavailable", severity: "blocker", token: A }]);
    expect(valuation.positions[0]).toMatchObject({ priceE8: null, priceStatus: "unavailable", valueUsdE8: null });
    expect(valuation.investedValueUsdE8).toBeNull();
  });

  test("a zero price is a blocker, not a position worth nothing", () => {
    const valuation = valuePortfolio({ ...TWO_TOKENS, prices: [price(A, 0n), price(B, 50_000_000n)] });
    expect(valuation.issues).toEqual([{ code: "zero_price", severity: "blocker", token: A }]);
    expect(valuation.positions[0]).toMatchObject({ priceE8: 0n, valueUsdE8: null });
    expect(valuation.investedValueUsdE8).toBeNull();
  });

  test("a holding whose decimals differ from the constituent is a blocker", () => {
    const valuation = valuePortfolio({
      ...TWO_TOKENS,
      holdings: [
        { token: A, balance: 80_000_000n, decimals: 6 },
        { token: B, balance: 1_000n * 10n ** 18n, decimals: 18 },
      ],
    });
    expect(valuation.issues).toEqual([{ code: "decimals_mismatch", severity: "blocker", token: A }]);
    expect(valuation.positions[0]).toMatchObject({ decimals: 8, valueUsdE8: null, weightBps: null });
    expect(valuation.investedValueUsdE8).toBeNull();
  });

  test("last_close and delayed prices are warnings and still value the position", () => {
    const valuation = valuePortfolio({
      ...TWO_TOKENS,
      prices: [price(A, 1_250n * USD_E8, "last_close"), price(B, 50_000_000n, "delayed")],
    });
    expect(valuation.issues).toEqual([
      { code: "market_closed", severity: "warning", token: A },
      { code: "price_delayed", severity: "warning", token: B },
    ]);
    expect(valuation.investedValueUsdE8).toBe(150_000_000_000n);
    expect(valuation.positions.map(({ weightBps }) => weightBps)).toEqual([6_667, 3_333]);
  });

  test("findings are listed in ascending token order", () => {
    const valuation = valuePortfolio({
      ...TWO_TOKENS,
      constituents: [...TWO_TOKENS.constituents].reverse(),
      prices: [],
    });
    expect(valuation.issues.map(({ token }) => token)).toEqual([A, B]);
  });
});

describe("valuePortfolio: input errors", () => {
  const cases: [string, CalculationInputErrorCode, PortfolioInput][] = [
    ["no constituent", "invalid_weights", { ...TWO_TOKENS, constituents: [] }],
    ["weights below 10,000", "invalid_weights", dollars([5_000, 4_999], [1n, 1n])],
    ["a zero weight", "invalid_weights", dollars([10_000, 0], [1n, 1n])],
    ["a fractional weight", "invalid_weights", dollars([5_000.5, 4_999.5], [1n, 1n])],
    [
      "a repeated constituent",
      "duplicate_token",
      { ...TWO_TOKENS, constituents: [...TWO_TOKENS.constituents, { token: A, weightBps: 1, decimals: 8 }] },
    ],
    [
      "a checksummed constituent address",
      "invalid_address",
      {
        ...TWO_TOKENS,
        constituents: [{ token: "0xAbcdef0000000000000000000000000000000001", weightBps: 10_000, decimals: 8 }],
      },
    ],
    [
      "constituent decimals out of range",
      "invalid_decimals",
      { ...TWO_TOKENS, constituents: [{ token: A, weightBps: 10_000, decimals: 37 }] },
    ],
    ["a negative balance", "negative_amount", { ...TWO_TOKENS, holdings: [{ token: A, balance: -1n, decimals: 8 }] }],
    [
      "a repeated holding",
      "duplicate_token",
      { ...TWO_TOKENS, holdings: [...TWO_TOKENS.holdings, { token: B, balance: 1n, decimals: 18 }] },
    ],
    [
      "a malformed holding address",
      "invalid_address",
      { ...TWO_TOKENS, holdings: [{ token: "0x12", balance: 1n, decimals: 8 }] },
    ],
    [
      "fractional holding decimals",
      "invalid_decimals",
      { ...TWO_TOKENS, holdings: [{ token: A, balance: 1n, decimals: 1.5 }] },
    ],
    ["a negative price", "negative_amount", { ...TWO_TOKENS, prices: [price(A, -1n)] }],
    ["a repeated price", "duplicate_token", { ...TWO_TOKENS, prices: [...TWO_TOKENS.prices, price(A, USD_E8)] }],
    ["a malformed price address", "invalid_address", { ...TWO_TOKENS, prices: [price("0xzz", USD_E8)] }],
    ["a negative quote balance", "negative_amount", { ...TWO_TOKENS, quoteBalance: -1n }],
  ];
  for (const [name, code, input] of cases) {
    test(`${name} throws ${code}`, () => {
      expect(errorCode(() => valuePortfolio(input))).toBe(code);
    });
  }
});

describe("computeDrift", () => {
  test("drift is current minus target, positive above target", () => {
    const drift = computeDrift(valuePortfolio(TWO_TOKENS).positions, 500);
    expect(drift).toEqual({
      constituents: [
        { token: A, currentWeightBps: 6_667, targetWeightBps: 6_000, driftBps: 667 },
        { token: B, currentWeightBps: 3_333, targetWeightBps: 4_000, driftBps: -667 },
      ],
      maxAbsDriftBps: 667,
      maxDriftToken: A,
      turnoverBps: 667,
      driftThresholdBps: 500,
      thresholdReached: true,
    });
  });

  test("the maximum is over absolute drifts and turnover is half their sum", () => {
    // Targets 40/30/20/10, holdings 30/30/30/10 USD: drifts -1,000, 0, +1,000 and 0.
    const even = computeDrift(valuePortfolio(dollars([4_000, 3_000, 2_000, 1_000], [30n, 30n, 30n, 10n])).positions, 1);
    expect(even?.constituents.map(({ driftBps }) => driftBps)).toEqual([-1_000, 0, 1_000, 0]);
    expect(even?.maxAbsDriftBps).toBe(1_000);
    expect(even?.maxDriftToken).toBe(A);
    expect(even?.turnoverBps).toBe(1_000);
    // Holdings 20/35/25/20 USD: drifts -2,000, +500, +500 and +1,000.
    const skewed = computeDrift(
      valuePortfolio(dollars([4_000, 3_000, 2_000, 1_000], [20n, 35n, 25n, 20n])).positions,
      1,
    );
    expect(skewed?.constituents.map(({ driftBps }) => driftBps)).toEqual([-2_000, 500, 500, 1_000]);
    expect(skewed?.maxAbsDriftBps).toBe(2_000);
    expect(skewed?.turnoverBps).toBe(2_000);
  });

  test("the widest drift can be a constituent below target, and the lowest address wins a tie", () => {
    const drift = computeDrift(valuePortfolio(dollars([2_000, 4_000, 4_000], [30n, 20n, 50n])).positions, 1);
    expect(drift?.constituents.map(({ driftBps }) => driftBps)).toEqual([1_000, -2_000, 1_000]);
    expect(drift?.maxDriftToken).toBe(B);
    const tie = computeDrift(valuePortfolio(dollars([5_000, 5_000], [40n, 60n])).positions, 1);
    expect(tie?.maxDriftToken).toBe(A);
  });

  test("a drift equal to the threshold reaches it, one basis point less does not", () => {
    const positions = valuePortfolio(dollars([5_000, 5_000], [52n, 48n])).positions;
    expect(computeDrift(positions, 199)?.thresholdReached).toBe(true);
    expect(computeDrift(positions, 200)?.thresholdReached).toBe(true);
    expect(computeDrift(positions, 201)?.thresholdReached).toBe(false);
  });

  test("a portfolio on target has no drift and no turnover", () => {
    const drift = computeDrift(valuePortfolio(dollars([7_500, 2_500], [75n, 25n])).positions, 1);
    expect(drift).toMatchObject({ maxAbsDriftBps: 0, turnoverBps: 0, thresholdReached: false });
  });

  test("drift is undefined without weights", () => {
    expect(computeDrift(valuePortfolio(dollars([5_000, 5_000], [0n, 0n], 5_000_000n)).positions, 500)).toBeNull();
    expect(computeDrift(valuePortfolio({ ...TWO_TOKENS, prices: [] }).positions, 500)).toBeNull();
  });

  test("the threshold must be an integer between 1 and 10,000", () => {
    const positions = valuePortfolio(TWO_TOKENS).positions;
    for (const threshold of [0, -1, 10_001, 2.5, Number.NaN]) {
      expect(errorCode(() => computeDrift(positions, threshold))).toBe("invalid_bps");
    }
    expect(computeDrift(positions, 10_000)?.thresholdReached).toBe(false);
  });
});
