import { describe, expect, test } from "bun:test";
import {
  CalculationInputError,
  type CalculationInputErrorCode,
  computeEqualWeights,
  DEFAULT_MIN_LEG_VALUE_USD_E8,
  DEFAULT_RESERVE_BPS,
  MAX_RESERVE_BPS,
  type PortfolioInput,
  planRebalance,
  type RebalancePlan,
  type RebalancePlanInput,
  type RebalanceRule,
  type ReferencePrice,
  rebalanceEligibility,
  USD_E8,
  valuePortfolio,
} from "../src/index.ts";
import { address, price, range } from "./helpers.ts";

const A = address(0xa1);
const B = address(0xb2);
const C = address(0xc3);
const D = address(0xd4);

/** Tokens of 6 decimals at 1.00 USD holding `balances` whole tokens, with the given target weights. */
function dollars(weightsBps: number[], balances: bigint[], quoteBalance = 0n): PortfolioInput {
  const tokens = [A, B, C, D].slice(0, weightsBps.length);
  return {
    constituents: tokens.map((token, i) => ({ token, weightBps: weightsBps[i] ?? 0, decimals: 6 })),
    holdings: tokens.map((token, i) => ({ token, balance: (balances[i] ?? 0n) * 1_000_000n, decimals: 6 })),
    prices: tokens.map((token) => price(token, USD_E8)),
    quoteBalance,
  };
}

/** A plan without reserve and without a minimum leg value unless stated, so that one rule shows at a time. */
function exact(input: PortfolioInput, options: Partial<RebalancePlanInput> = {}): RebalancePlanInput {
  return { mode: "rebalance", reserveBps: 0, minLegValueUsdE8: 0n, ...input, ...options };
}

function planOf(input: RebalancePlanInput): RebalancePlan {
  const result = planRebalance(input);
  if (result.status === "blocked") throw new Error(`blocked: ${result.blockers.map(({ code }) => code).join(" ")}`);
  return result;
}

function blockersOf(input: RebalancePlanInput): unknown {
  const result = planRebalance(input);
  if (result.status === "ready") throw new Error("not blocked");
  expect("legs" in result).toBe(false);
  return result.blockers;
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

const RULE: RebalanceRule = { trigger: "drift", driftThresholdBps: 500, minIntervalSeconds: 604_800 };
const NOW = 1_795_000_000;

describe("rebalanceEligibility", () => {
  // 56/44 against 50/50 is a drift of 600 bps, 54/46 is 400 bps.
  const drifted = valuePortfolio(dollars([5_000, 5_000], [56n, 44n]));
  const within = valuePortfolio(dollars([5_000, 5_000], [54n, 46n]));

  test("is due when the drift reaches the threshold and there was no rebalance", () => {
    expect(rebalanceEligibility({ rule: RULE, valuation: drifted, lastRebalanceAt: null, now: NOW })).toEqual({
      due: true,
      reason: "drift_threshold_reached",
      maxAbsDriftBps: 600,
    });
  });

  test("is due at exactly the threshold", () => {
    const atThreshold = valuePortfolio(dollars([5_000, 5_000], [55n, 45n]));
    expect(rebalanceEligibility({ rule: RULE, valuation: atThreshold, lastRebalanceAt: null, now: NOW }).due).toBe(
      true,
    );
  });

  test("is not due below the threshold, with the numbers compared", () => {
    expect(rebalanceEligibility({ rule: RULE, valuation: within, lastRebalanceAt: null, now: NOW })).toEqual({
      due: false,
      reason: "below_threshold",
      maxAbsDriftBps: 400,
      driftThresholdBps: 500,
    });
  });

  test("is due once exactly the minimum interval has elapsed", () => {
    const at = (elapsed: number) =>
      rebalanceEligibility({ rule: RULE, valuation: drifted, lastRebalanceAt: NOW - elapsed, now: NOW });
    expect(at(604_800)).toEqual({ due: true, reason: "drift_threshold_reached", maxAbsDriftBps: 600 });
    expect(at(604_801).due).toBe(true);
    expect(at(604_799)).toEqual({ due: false, reason: "min_interval_not_elapsed", secondsRemaining: 1 });
    expect(at(0)).toEqual({ due: false, reason: "min_interval_not_elapsed", secondsRemaining: 604_800 });
  });

  test("a last rebalance recorded after now is not elapsed", () => {
    expect(rebalanceEligibility({ rule: RULE, valuation: drifted, lastRebalanceAt: NOW + 10, now: NOW })).toEqual({
      due: false,
      reason: "min_interval_not_elapsed",
      secondsRemaining: 604_810,
    });
  });

  test("a zero minimum interval never delays", () => {
    const rule = { ...RULE, minIntervalSeconds: 0 };
    expect(rebalanceEligibility({ rule, valuation: drifted, lastRebalanceAt: NOW, now: NOW }).due).toBe(true);
  });

  test("below the threshold is reported before the interval", () => {
    const result = rebalanceEligibility({ rule: RULE, valuation: within, lastRebalanceAt: NOW - 1, now: NOW });
    expect(result.reason).toBe("below_threshold");
  });

  test("a first replication is always allowed", () => {
    const first = valuePortfolio(dollars([5_000, 5_000], [0n, 0n], 100_000_000n));
    expect(rebalanceEligibility({ rule: RULE, valuation: first, lastRebalanceAt: NOW - 1, now: NOW })).toEqual({
      due: true,
      reason: "first_replication",
    });
  });

  test("base units too small to have a value are still a first replication", () => {
    // One base unit of an 18-decimal token at 1.00 USD is worth 1e-18 USD, valued at zero.
    const dust = valuePortfolio({
      constituents: [{ token: A, weightBps: 10_000, decimals: 18 }],
      holdings: [{ token: A, balance: 1n, decimals: 18 }],
      prices: [price(A, USD_E8)],
      quoteBalance: 0n,
    });
    expect(dust.investedValueUsdE8).toBe(0n);
    expect(rebalanceEligibility({ rule: RULE, valuation: dust, lastRebalanceAt: NOW - 1, now: NOW })).toEqual({
      due: true,
      reason: "first_replication",
    });
  });

  test("a missing price is reported, also for a wallet that holds nothing", () => {
    const unpriced = valuePortfolio({ ...dollars([5_000, 5_000], [0n, 0n]), prices: [price(A, USD_E8)] });
    expect(rebalanceEligibility({ rule: RULE, valuation: unpriced, lastRebalanceAt: null, now: NOW })).toEqual({
      due: false,
      reason: "valuation_blocked",
      blockers: [{ code: "missing_price", severity: "blocker", token: B }],
    });
    const held = valuePortfolio({
      ...dollars([5_000, 5_000], [56n, 44n]),
      prices: [price(A, USD_E8), price(B, USD_E8, "unavailable")],
    });
    expect(rebalanceEligibility({ rule: RULE, valuation: held, lastRebalanceAt: null, now: NOW })).toEqual({
      due: false,
      reason: "valuation_blocked",
      blockers: [{ code: "price_unavailable", severity: "blocker", token: B }],
    });
  });

  test("a closed market does not hide the drift, with or without blockOnLastClose", () => {
    const closed = (blockOnLastClose: boolean) =>
      valuePortfolio({
        ...dollars([5_000, 5_000], [56n, 44n]),
        prices: [price(A, USD_E8, "last_close"), price(B, USD_E8)],
        blockOnLastClose,
      });
    for (const valuation of [closed(false), closed(true)]) {
      expect(rebalanceEligibility({ rule: RULE, valuation, lastRebalanceAt: null, now: NOW })).toEqual({
        due: true,
        reason: "drift_threshold_reached",
        maxAbsDriftBps: 600,
      });
    }
  });

  test("times must be non-negative integers of seconds", () => {
    const run = (now: number, lastRebalanceAt: number | null, minIntervalSeconds = 0) =>
      errorCode(() =>
        rebalanceEligibility({ rule: { ...RULE, minIntervalSeconds }, valuation: drifted, lastRebalanceAt, now }),
      );
    expect(run(-1, null)).toBe("invalid_time");
    expect(run(1.5, null)).toBe("invalid_time");
    expect(run(NOW, -1)).toBe("invalid_time");
    expect(run(NOW, Number.NaN)).toBe("invalid_time");
    expect(run(NOW, null, -1)).toBe("invalid_time");
    expect(run(NOW, null)).toBe("no error");
  });
});

describe("planRebalance: worked examples", () => {
  test("defaults", () => {
    expect(DEFAULT_RESERVE_BPS).toBe(50);
    expect(MAX_RESERVE_BPS).toBe(2_000);
    expect(DEFAULT_MIN_LEG_VALUE_USD_E8).toBe(USD_E8);
    const plan = planOf({ mode: "rebalance", ...dollars([5_000, 5_000], [60n, 40n]) });
    expect(plan.reserveBps).toBe(50);
    expect(plan.minLegValueUsdE8).toBe(100_000_000n);
  });

  test("an 8-decimal token above 1,000 USD and a token under 1 USD, with the default reserve", () => {
    // A: 0.8 tokens at 1,250.00 USD = 1,000.00 USD, target 60%. B: 1,000 tokens at 0.50 USD = 500.00 USD, target 40%.
    const input: RebalancePlanInput = {
      mode: "rebalance",
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
    // Deployable 1,500.00 USD: targets 900.00 and 600.00 USD.
    expect(planRebalance(input)).toEqual({
      status: "ready",
      warnings: [],
      valuation: valuePortfolio(input),
      mode: "rebalance",
      reserveBps: 50,
      minLegValueUsdE8: 100_000_000n,
      deployableValueUsdE8: 150_000_000_000n,
      availableQuote: 0n,
      // 100 USDC of proceeds less 0.5%.
      buyBudgetQuote: 99_500_000n,
      targets: [
        {
          token: A,
          targetWeightBps: 6_000,
          currentValueUsdE8: 100_000_000_000n,
          targetValueUsdE8: 90_000_000_000n,
          deltaUsdE8: -10_000_000_000n,
        },
        {
          token: B,
          targetWeightBps: 4_000,
          currentValueUsdE8: 50_000_000_000n,
          targetValueUsdE8: 60_000_000_000n,
          deltaUsdE8: 10_000_000_000n,
        },
      ],
      legs: [
        // 100.00 USD / 1,250.00 USD = 0.08 A.
        {
          side: "sell",
          token: A,
          exit: false,
          tokenQuantity: 8_000_000n,
          quoteAmount: 100_000_000n,
          valueUsdE8: 10_000_000_000n,
          priceE8: 125_000_000_000n,
        },
        // The buy wants 100 USDC and is capped at 99.50 USDC, which is 199 B at 0.50 USD.
        {
          side: "buy",
          token: B,
          exit: false,
          tokenQuantity: 199n * 10n ** 18n,
          quoteAmount: 99_500_000n,
          valueUsdE8: 9_950_000_000n,
          priceE8: 50_000_000n,
        },
      ],
      skipped: [],
      currentMaxAbsDriftBps: 667,
      projected: {
        positions: [
          // 900.00 of 1,499.50 USD is 6,002.0007 bps; 599.50 is 3,997.9993 bps and takes the missing basis point.
          {
            token: A,
            balance: 72_000_000n,
            valueUsdE8: 90_000_000_000n,
            targetWeightBps: 6_000,
            weightBps: 6_002,
            driftBps: 2,
          },
          {
            token: B,
            balance: 1_199n * 10n ** 18n,
            valueUsdE8: 59_950_000_000n,
            targetWeightBps: 4_000,
            weightBps: 3_998,
            driftBps: -2,
          },
        ],
        investedValueUsdE8: 149_950_000_000n,
        // The reserve: 0.50 USDC.
        quoteBalance: 500_000n,
        maxAbsDriftBps: 2,
      },
    });
  });

  test("every rounding step, on numbers that do not divide", () => {
    // 1.5 A (8 decimals) at 1,333.33333333 USD is 1,999.999999995 USD, valued 1,999.99999999. B is 0.07 USD.
    const plan = planOf(
      exact({
        constituents: [
          { token: A, weightBps: 5_000, decimals: 8 },
          { token: B, weightBps: 5_000, decimals: 18 },
        ],
        holdings: [{ token: A, balance: 150_000_000n, decimals: 8 }],
        prices: [price(A, 133_333_333_333n), price(B, 7_000_000n)],
        quoteBalance: 0n,
      }),
    );
    expect(plan.deployableValueUsdE8).toBe(199_999_999_999n);
    // Half of 199,999,999,999 is 99,999,999,999.5: both targets round down.
    expect(plan.targets.map(({ targetValueUsdE8 }) => targetValueUsdE8)).toEqual([99_999_999_999n, 99_999_999_999n]);
    expect(plan.targets.map(({ deltaUsdE8 }) => deltaUsdE8)).toEqual([-100_000_000_000n, 99_999_999_999n]);
    expect(plan.legs).toEqual([
      {
        side: "sell",
        token: A,
        exit: false,
        // 1,000.00 USD / 1,333.33333333 USD = 0.750000000001875 A, rounded down to 8 decimals.
        tokenQuantity: 75_000_000n,
        // 0.75 A is 999.9999999975 USD: value rounded down to 1e-8, proceeds rounded down to 1e-6.
        valueUsdE8: 99_999_999_999n,
        quoteAmount: 999_999_999n,
        priceE8: 133_333_333_333n,
      },
      {
        side: "buy",
        token: B,
        exit: false,
        // The shortfall of 999.99999999 USD is 999.999999 USDC, rounded down to 1e-6.
        // 999.999999 / 0.07 = 14,285.714271428571428571428... B, rounded down to 18 decimals.
        tokenQuantity: 14_285_714_271_428_571_428_571n,
        // That quantity costs 999.99999899999999999997 USD, rounded up to 1e-8 and then to 1e-6.
        quoteAmount: 999_999_999n,
        valueUsdE8: 99_999_999_900n,
        priceE8: 7_000_000n,
      },
    ]);
    expect(plan.projected.positions.map(({ balance, valueUsdE8 }) => [balance, valueUsdE8])).toEqual([
      [75_000_000n, 99_999_999_999n],
      [14_285_714_271_428_571_428_571n, 99_999_999_899n],
    ]);
    expect(plan.projected.positions.map(({ weightBps }) => weightBps)).toEqual([5_000, 5_000]);
    expect(plan.projected.quoteBalance).toBe(0n);
  });

  test("a first replication of about 20 USD", () => {
    // 20 USDC into A (8 decimals, 250.00 USD), B (18 decimals, 0.80 USD) and C (6 decimals, 12.50 USD).
    const plan = planOf({
      mode: "rebalance",
      constituents: [
        { token: A, weightBps: 3_334, decimals: 8 },
        { token: B, weightBps: 3_333, decimals: 18 },
        { token: C, weightBps: 3_333, decimals: 6 },
      ],
      holdings: [],
      prices: [price(A, 250n * USD_E8), price(B, 80_000_000n), price(C, 1_250_000_000n)],
      quoteBalance: 20_000_000n,
    });
    expect(plan.deployableValueUsdE8).toBe(2_000_000_000n);
    // 6.668, 6.666 and 6.666 USD.
    expect(plan.targets.map(({ targetValueUsdE8 }) => targetValueUsdE8)).toEqual([
      666_800_000n,
      666_600_000n,
      666_600_000n,
    ]);
    // 20 USDC less 0.5% is 19.90 USDC, and the buys want 20: each is scaled by 19.9 / 20.
    expect(plan.buyBudgetQuote).toBe(19_900_000n);
    expect(plan.legs).toEqual([
      {
        side: "buy",
        token: A,
        exit: false,
        quoteAmount: 6_634_660n,
        valueUsdE8: 663_466_000n,
        // 6.63466 / 250 = 0.02653864 A.
        tokenQuantity: 2_653_864n,
        priceE8: 25_000_000_000n,
      },
      {
        side: "buy",
        token: B,
        exit: false,
        quoteAmount: 6_632_670n,
        valueUsdE8: 663_267_000n,
        // 6.63267 / 0.80 = 8.2908375 B.
        tokenQuantity: 8_290_837_500_000_000_000n,
        priceE8: 80_000_000n,
      },
      {
        side: "buy",
        token: C,
        exit: false,
        // The share of 6.632670 USDC buys 0.5306136 C, rounded down to 0.530613 C. That costs 6.6326625 USD,
        // so the leg spends 6.632663 USDC and the other 0.000007 USDC stay in the wallet.
        tokenQuantity: 530_613n,
        quoteAmount: 6_632_663n,
        valueUsdE8: 663_266_300n,
        priceE8: 1_250_000_000n,
      },
    ]);
    expect(plan.skipped).toEqual([]);
    expect(plan.currentMaxAbsDriftBps).toBeNull();
    expect(plan.projected.positions.map(({ valueUsdE8 }) => valueUsdE8)).toEqual([
      663_466_000n,
      663_267_000n,
      663_266_250n,
    ]);
    expect(plan.projected.positions.map(({ weightBps }) => weightBps)).toEqual([3_334, 3_333, 3_333]);
    expect(plan.projected.maxAbsDriftBps).toBe(0);
    expect(plan.projected.quoteBalance).toBe(100_007n);
    expect(plan.warnings).toEqual([]);
  });

  test("an index with one constituent", () => {
    // 1,000 USDC into a token at 25.00 USD: 995 USDC after the reserve buys 39.8 tokens.
    const plan = planOf({
      mode: "rebalance",
      constituents: [{ token: A, weightBps: 10_000, decimals: 18 }],
      holdings: [],
      prices: [price(A, 25n * USD_E8)],
      quoteBalance: 1_000_000_000n,
    });
    expect(plan.targets[0]?.targetValueUsdE8).toBe(100_000_000_000n);
    expect(plan.legs).toEqual([
      {
        side: "buy",
        token: A,
        exit: false,
        quoteAmount: 995_000_000n,
        valueUsdE8: 99_500_000_000n,
        tokenQuantity: 39_800_000_000_000_000_000n,
        priceE8: 2_500_000_000n,
      },
    ]);
    expect(plan.projected.positions[0]).toMatchObject({ weightBps: 10_000, driftBps: 0 });
    expect(plan.projected.quoteBalance).toBe(5_000_000n);
  });

  /** 64 tokens of 8 decimals at 100.00 USD with equal weights: 157 bps sixteen times, then 156 bps. */
  function sixtyFour(depositUsdE8: bigint): RebalancePlanInput {
    const weights = computeEqualWeights(range(64).map((i) => address(0xb200 + i)));
    return {
      mode: "buy_only",
      constituents: weights.map((constituent) => ({ ...constituent, decimals: 8 })),
      holdings: [],
      prices: weights.map(({ token }) => price(token, 100n * USD_E8)),
      quoteBalance: 0n,
      depositUsdE8,
      reserveBps: 0,
    };
  }

  test("an index with 64 constituents", () => {
    // 10,000 USD: 157.00 USD is 1.57 tokens and 156.00 USD is 1.56 tokens.
    const plan = planOf(sixtyFour(10_000n * USD_E8));
    expect(plan.legs.length).toBe(64);
    expect(plan.legs.map(({ token }) => token)).toEqual(range(64).map((i) => address(0xb200 + i)));
    expect(plan.legs.map(({ quoteAmount }) => quoteAmount)).toEqual(
      range(64).map((i) => (i <= 16 ? 157_000_000n : 156_000_000n)),
    );
    expect(plan.legs.map(({ tokenQuantity }) => tokenQuantity)).toEqual(
      range(64).map((i) => (i <= 16 ? 157_000_000n : 156_000_000n)),
    );
    expect(plan.projected.investedValueUsdE8).toBe(10_000n * USD_E8);
    expect(plan.projected.positions.map(({ driftBps }) => driftBps)).toEqual(range(64).map(() => 0));
    expect(plan.projected.quoteBalance).toBe(0n);
  });

  test("about 20 USD cannot replicate 64 constituents, and the result says how much can", () => {
    // 20 USD: every buy would be 0.314 or 0.312 USD, below 1.00 USD.
    // The smallest weight is 156 bps: (1.00 USD + one base unit of 0.000001 USD + 0.000008 USD of rounding)
    // / 1.56% = 64.10314102... USD, rounded up.
    expect(blockersOf(sixtyFour(20n * USD_E8))).toEqual([
      {
        code: "below_minimum_portfolio_value",
        severity: "blocker",
        token: null,
        minimumDeployableValueUsdE8: 6_410_314_103n,
      },
    ]);
    expect(planOf(sixtyFour(6_410_314_103n)).legs.length).toBe(64);
    expect(blockersOf(sixtyFour(64n * USD_E8))).toMatchObject([{ code: "below_minimum_portfolio_value" }]);
  });

  test("a portfolio of about 10 million USD", () => {
    // 1,064.5 A at 4,321.00 = 4,599,704.50; 14,400 B at 187.50 = 2,700,000.00; 8,000,000 C at 0.25 = 2,000,000.00;
    // 11,300 D at 62.00 = 700,600.00. Total 10,000,304.50 USD against targets of 40%, 30%, 22.5% and 7.5%.
    const plan = planOf({
      mode: "rebalance",
      constituents: [
        { token: A, weightBps: 4_000, decimals: 8 },
        { token: B, weightBps: 3_000, decimals: 18 },
        { token: C, weightBps: 2_250, decimals: 18 },
        { token: D, weightBps: 750, decimals: 6 },
      ],
      holdings: [
        { token: A, balance: 106_450_000_000n, decimals: 8 },
        { token: B, balance: 14_400n * 10n ** 18n, decimals: 18 },
        { token: C, balance: 8_000_000n * 10n ** 18n, decimals: 18 },
        { token: D, balance: 11_300_000_000n, decimals: 6 },
      ],
      prices: [price(A, 4_321n * USD_E8), price(B, 18_750_000_000n), price(C, 25_000_000n), price(D, 62n * USD_E8)],
      quoteBalance: 0n,
    });
    expect(plan.valuation.positions.map(({ weightBps }) => weightBps)).toEqual([4_599, 2_700, 2_000, 701]);
    expect(plan.currentMaxAbsDriftBps).toBe(599);
    expect(plan.deployableValueUsdE8).toBe(1_000_030_450_000_000n);
    // 4,000,121.80, 3,000,091.35, 2,250,068.5125 and 750,022.8375 USD.
    expect(plan.targets.map(({ deltaUsdE8 }) => deltaUsdE8)).toEqual([
      -59_958_270_000_000n,
      30_009_135_000_000n,
      25_006_851_250_000n,
      4_942_283_750_000n,
    ]);
    // Sell 599,582.70 / 4,321 = 138.7601712566... A, rounded down to 138.76017125 A worth 599,582.69997125 USD.
    // Budget: 599,582.699971 USDC * 0.995 = 596,584.786471145, rounded down.
    expect(plan.buyBudgetQuote).toBe(596_584_786_471n);
    // The buys want 300,091.35 + 250,068.5125 + 49,422.8375 = 599,582.70 USDC and are scaled by budget / wanted.
    expect(plan.legs).toEqual([
      {
        side: "sell",
        token: A,
        exit: false,
        tokenQuantity: 13_876_017_125n,
        quoteAmount: 599_582_699_971n,
        valueUsdE8: 59_958_269_997_125n,
        priceE8: 432_100_000_000n,
      },
      {
        side: "buy",
        token: B,
        exit: false,
        tokenQuantity: 1_592_484_763_920_000_000_000n,
        quoteAmount: 298_590_893_235n,
        valueUsdE8: 29_859_089_323_500n,
        priceE8: 18_750_000_000n,
      },
      {
        side: "buy",
        token: C,
        exit: false,
        tokenQuantity: 995_272_679_700_000_000_000_000n,
        quoteAmount: 248_818_169_925n,
        valueUsdE8: 24_881_816_992_500n,
        priceE8: 25_000_000n,
      },
      {
        side: "buy",
        token: D,
        exit: false,
        // The share of 49,175.723310 USDC buys 793.156827 D, which costs 49,175.723274 USDC.
        tokenQuantity: 793_156_827n,
        quoteAmount: 49_175_723_274n,
        valueUsdE8: 4_917_572_327_400n,
        priceE8: 6_200_000_000n,
      },
    ]);
    expect(plan.projected.positions.map(({ weightBps }) => weightBps)).toEqual([4_001, 2_999, 2_250, 750]);
    expect(plan.projected.maxAbsDriftBps).toBe(1);
    // The reserve of 0.5% of the proceeds, plus the base units lost to rounding down.
    expect(plan.projected.quoteBalance).toBe(2_997_913_537n);
  });
});

describe("planRebalance: funds", () => {
  test("buys never spend more than the proceeds plus the quote balance", () => {
    // 60/40 USD against 50/50 with 10 USDC: deployable 110, sell 5 of A, buy 15 of B.
    const plan = planOf(exact(dollars([5_000, 5_000], [60n, 40n], 10_000_000n)));
    expect(plan.availableQuote).toBe(10_000_000n);
    expect(plan.buyBudgetQuote).toBe(15_000_000n);
    expect(plan.legs.map(({ side, token, quoteAmount }) => [side, token, quoteAmount])).toEqual([
      ["sell", A, 5_000_000n],
      ["buy", B, 15_000_000n],
    ]);
    expect(plan.projected.quoteBalance).toBe(0n);
    expect(plan.projected.positions.map(({ weightBps }) => weightBps)).toEqual([5_000, 5_000]);
  });

  test("the reserve is taken from the proceeds and the quote balance together", () => {
    const plan = planOf(exact(dollars([5_000, 5_000], [60n, 40n], 10_000_000n), { reserveBps: 1_000 }));
    // 15 USDC of funds less 10%: the single buy is capped at 13.50 USDC.
    expect(plan.buyBudgetQuote).toBe(13_500_000n);
    expect(plan.legs[1]).toMatchObject({ side: "buy", quoteAmount: 13_500_000n, tokenQuantity: 13_500_000n });
    expect(plan.projected.quoteBalance).toBe(1_500_000n);
  });

  test("the budget rounds down", () => {
    // 0.000199 USDC less 0.5% is 0.000198005 USDC.
    const plan = planOf(exact(dollars([10_000], [0n], 199n), { reserveBps: 50 }));
    expect(plan.buyBudgetQuote).toBe(198n);
  });

  test("when several buys exceed the budget each is scaled down and rounded down", () => {
    // 100 USDC into 10/30/60 with a 0.01% reserve: budget 99.99 USDC for buys that want 10, 30 and 60.
    const plan = planOf(exact(dollars([1_000, 3_000, 6_000], [0n, 0n, 0n], 100_000_001n), { reserveBps: 1 }));
    expect(plan.buyBudgetQuote).toBe(99_990_000n);
    // Wanted 10.000000, 30.000000 and 60.000000 of 100.000000 (the odd base unit is lost to the targets).
    expect(plan.legs.map(({ quoteAmount }) => quoteAmount)).toEqual([9_999_000n, 29_997_000n, 59_994_000n]);
    const uneven = planOf(exact(dollars([3_334, 3_333, 3_333], [0n, 0n, 0n], 10n), { reserveBps: 1_000 }));
    // 10 base units: targets 333, 333 and 333 USD E8 want 3 each; budget 9 covers them without scaling.
    expect(uneven.legs.map(({ quoteAmount }) => quoteAmount)).toEqual([3n, 3n, 3n]);
    const scaled = planOf(exact(dollars([3_334, 3_333, 3_333], [0n, 0n, 0n], 10n), { reserveBps: 2_000 }));
    // Budget 8 for 9 wanted: floor(3 * 8 / 9) = 2 each, 6 spent.
    expect(scaled.legs.map(({ quoteAmount }) => quoteAmount)).toEqual([2n, 2n, 2n]);
    expect(scaled.projected.quoteBalance).toBe(4n);
  });

  test("the reserve has a maximum of 20%", () => {
    const run = (reserveBps: number) =>
      errorCode(() => planRebalance(exact(dollars([5_000, 5_000], [60n, 40n]), { reserveBps })));
    expect(run(2_000)).toBe("no error");
    expect(run(2_001)).toBe("invalid_bps");
    expect(run(10_000)).toBe("invalid_bps");
    expect(run(-1)).toBe("invalid_bps");
    expect(run(0.5)).toBe("invalid_bps");
  });

  test("a deposit is added to the quote balance, rounded down to quote base units", () => {
    const plan = planOf(exact(dollars([10_000], [0n], 2_000_000n), { depositUsdE8: 300_000_099n }));
    expect(plan.availableQuote).toBe(5_000_000n);
    expect(plan.deployableValueUsdE8).toBe(500_000_000n);
    expect(plan.legs[0]?.quoteAmount).toBe(5_000_000n);
  });

  test("a buy spends what its whole base units cost, not everything it was given", () => {
    // One token of 0 decimals at 1,250.00 USD and 1,999 USDC: one unit is bought for 1,250 USDC.
    const plan = planOf(
      exact({
        constituents: [{ token: A, weightBps: 10_000, decimals: 0 }],
        holdings: [],
        prices: [price(A, 1_250n * USD_E8)],
        quoteBalance: 1_999_000_000n,
      }),
    );
    expect(plan.legs).toEqual([
      {
        side: "buy",
        token: A,
        exit: false,
        tokenQuantity: 1n,
        quoteAmount: 1_250_000_000n,
        valueUsdE8: 125_000_000_000n,
        priceE8: 125_000_000_000n,
      },
    ]);
    expect(plan.projected.quoteBalance).toBe(749_000_000n);
  });

  test("the amount a buy spends rounds up to cover its quantity", () => {
    // 1 USDC at 3.00 USD buys 0.333333 of a 6-decimal token, which costs 0.999999 USDC.
    const three = planOf(
      exact({
        constituents: [{ token: A, weightBps: 10_000, decimals: 6 }],
        holdings: [],
        prices: [price(A, 3n * USD_E8)],
        quoteBalance: 1_000_000n,
      }),
    );
    expect(three.legs[0]).toMatchObject({ tokenQuantity: 333_333n, quoteAmount: 999_999n, valueUsdE8: 99_999_900n });
    // 1 USDC at 0.00000007 USD buys 14,285,714.285714 tokens, which cost 0.99999999999998 USD: 1 USDC.
    const seven = planOf(
      exact({
        constituents: [{ token: A, weightBps: 10_000, decimals: 6 }],
        holdings: [],
        prices: [price(A, 7n)],
        quoteBalance: 1_000_000n,
      }),
    );
    expect(seven.legs[0]).toMatchObject({ tokenQuantity: 14_285_714_285_714n, quoteAmount: 1_000_000n });
  });
});

describe("planRebalance: order of legs", () => {
  test("sells come before buys even when the bought token has the lower address", () => {
    const plan = planOf(exact(dollars([5_000, 2_500, 2_500], [30n, 20n, 50n])));
    expect(plan.legs.map(({ side, token }) => [side, token])).toEqual([
      ["sell", C],
      ["buy", A],
      ["buy", B],
    ]);
  });

  test("each side is in ascending token order whatever the input order", () => {
    const input = dollars([2_500, 2_500, 2_500, 2_500], [40n, 10n, 40n, 10n]);
    const shuffled = {
      ...input,
      constituents: [...input.constituents].reverse(),
      holdings: [...input.holdings].reverse(),
      prices: [...input.prices].reverse(),
    };
    const plan = planOf(exact(shuffled));
    expect(plan.legs.map(({ side, token }) => [side, token])).toEqual([
      ["sell", A],
      ["sell", C],
      ["buy", B],
      ["buy", D],
    ]);
    expect(planRebalance(exact(shuffled))).toEqual(planRebalance(exact(input)));
  });

  test("skipped legs are listed in the same order", () => {
    const plan = planOf(
      exact(dollars([2_500, 2_500, 2_500, 2_500], [26n, 24n, 26n, 24n]), { minLegValueUsdE8: 5n * USD_E8 }),
    );
    expect(plan.skipped.map(({ side, token }) => [side, token])).toEqual([
      ["sell", A],
      ["sell", C],
      ["buy", B],
      ["buy", D],
    ]);
  });
});

describe("planRebalance: minimum leg value", () => {
  // 52/48 USD against 50/50: one sell and one buy of 2.00 USD.
  const input = dollars([5_000, 5_000], [52n, 48n]);

  test("a leg worth exactly the minimum is proposed", () => {
    const plan = planOf(exact(input, { minLegValueUsdE8: 200_000_000n }));
    expect(plan.legs.map(({ side, valueUsdE8 }) => [side, valueUsdE8])).toEqual([
      ["sell", 200_000_000n],
      ["buy", 200_000_000n],
    ]);
    expect(plan.skipped).toEqual([]);
  });

  test("a leg below the minimum is skipped, what it would have raised is not spent, and the drift stays", () => {
    const plan = planOf(exact(input, { minLegValueUsdE8: 200_000_001n }));
    expect(plan.legs).toEqual([]);
    expect(plan.skipped).toEqual([
      { side: "sell", token: A, exit: false, valueUsdE8: 200_000_000n, reason: "below_minimum" },
      // Without the proceeds of the skipped sell the budget is zero, and so is the buy.
      { side: "buy", token: B, exit: false, valueUsdE8: 0n, reason: "zero_quantity" },
    ]);
    expect(plan.buyBudgetQuote).toBe(0n);
    expect(plan.projected.positions.map(({ balance, driftBps }) => [balance, driftBps])).toEqual([
      [52_000_000n, 200],
      [48_000_000n, -200],
    ]);
    expect(plan.projected.maxAbsDriftBps).toBe(200);
    expect(plan.warnings).toEqual([]);
  });

  test("the default minimum is 1.00 USD", () => {
    // 50.99/49.01 against 50/50 is a leg of 0.99 USD; 51/49 is a leg of 1.00 USD.
    const cents = (a: bigint, b: bigint): PortfolioInput => ({
      ...input,
      holdings: [
        { token: A, balance: a * 10_000n, decimals: 6 },
        { token: B, balance: b * 10_000n, decimals: 6 },
      ],
    });
    expect(planOf({ mode: "rebalance", reserveBps: 0, ...cents(5_099n, 4_901n) }).legs).toEqual([]);
    expect(planOf({ mode: "rebalance", reserveBps: 0, ...cents(5_100n, 4_900n) }).legs.length).toBe(2);
  });

  test("a leg that rounds to zero base units is never proposed", () => {
    // A is a whole-unit token at 1,000.00 USD. The wallet holds 1 A against a target of 50%: the excess of
    // 500 USD is less than one unit, so nothing is sold and nothing funds the buy of B.
    const plan = planOf(
      exact({
        constituents: [
          { token: A, weightBps: 5_000, decimals: 0 },
          { token: B, weightBps: 5_000, decimals: 6 },
        ],
        holdings: [{ token: A, balance: 1n, decimals: 0 }],
        prices: [price(A, 1_000n * USD_E8), price(B, USD_E8)],
        quoteBalance: 0n,
      }),
    );
    expect(plan.skipped).toEqual([
      { side: "sell", token: A, exit: false, valueUsdE8: 50_000_000_000n, reason: "zero_quantity" },
      { side: "buy", token: B, exit: false, valueUsdE8: 0n, reason: "zero_quantity" },
    ]);
    expect(plan.legs).toEqual([]);
  });
});

describe("planRebalance: a skipped buy never pushes the others above target", () => {
  test("a deposit into a wallet on target is not spent when one buy is below the minimum", () => {
    // A 9.00 USD and B 1.00 USD against 90/10, with a deposit of 10 USD and every default. B would get
    // 0.995 USD, below 1.00 USD. Buying only A would move the wallet from 90/10 to 94.7/5.3.
    const plan = planOf({
      mode: "rebalance",
      constituents: [
        { token: A, weightBps: 9_000, decimals: 8 },
        { token: B, weightBps: 1_000, decimals: 8 },
      ],
      holdings: [
        { token: A, balance: 900_000_000n, decimals: 8 },
        { token: B, balance: 100_000_000n, decimals: 8 },
      ],
      prices: [price(A, USD_E8), price(B, USD_E8)],
      quoteBalance: 0n,
      depositUsdE8: 10n * USD_E8,
    });
    expect(plan.legs).toEqual([]);
    expect(plan.skipped).toEqual([
      { side: "buy", token: A, exit: false, valueUsdE8: 895_500_000n, reason: "above_target_weight" },
      { side: "buy", token: B, exit: false, valueUsdE8: 99_500_000n, reason: "below_minimum" },
    ]);
    expect(plan.currentMaxAbsDriftBps).toBe(0);
    expect(plan.projected.positions.map(({ weightBps }) => weightBps)).toEqual([9_000, 1_000]);
    expect(plan.projected.maxAbsDriftBps).toBe(0);
    // The whole deposit stays uninvested.
    expect(plan.projected.quoteBalance).toBe(10_000_000n);
    expect(plan.warnings).toEqual([]);
  });

  test("the remaining buy is capped at its target weight of the projected invested value", () => {
    // 40/30/20 USD against 50/30/20 with 10.50 USDC: targets 50.25, 30.15 and 20.10 USD. The buys of B (0.15)
    // and C (0.10) are below 1.00 USD. With B and C fixed at 50 USD together, A can hold 50 USD: it buys 10.
    const plan = planOf(
      exact(dollars([5_000, 3_000, 2_000], [40n, 30n, 20n], 10_500_000n), { minLegValueUsdE8: USD_E8 }),
    );
    expect(plan.legs.map(({ side, token, quoteAmount }) => [side, token, quoteAmount])).toEqual([
      ["buy", A, 10_000_000n],
    ]);
    expect(plan.skipped).toEqual([
      { side: "buy", token: B, exit: false, valueUsdE8: 15_000_000n, reason: "below_minimum" },
      { side: "buy", token: C, exit: false, valueUsdE8: 10_000_000n, reason: "below_minimum" },
    ]);
    expect(plan.currentMaxAbsDriftBps).toBe(555);
    expect(plan.projected.positions.map(({ weightBps }) => weightBps)).toEqual([5_000, 3_000, 2_000]);
    expect(plan.projected.quoteBalance).toBe(500_000n);
  });

  test("a cap that leaves a buy under the minimum skips it as above target weight", () => {
    // 99/1 USD against 99/1 with 100 USDC and a minimum of 1.01 USD: the buy of B is 1.00 USD.
    const plan = planOf(exact(dollars([9_900, 100], [99n, 1n], 100_000_000n), { minLegValueUsdE8: 101_000_000n }));
    expect(plan.legs).toEqual([]);
    expect(plan.skipped).toEqual([
      { side: "buy", token: A, exit: false, valueUsdE8: 9_900_000_000n, reason: "above_target_weight" },
      { side: "buy", token: B, exit: false, valueUsdE8: 100_000_000n, reason: "below_minimum" },
    ]);
    expect(plan.projected.quoteBalance).toBe(100_000_000n);
    expect(plan.projected.maxAbsDriftBps).toBe(0);
  });

  test("without a skipped buy nothing is capped", () => {
    const plan = planOf(exact(dollars([9_900, 100], [99n, 1n], 100_000_000n), { minLegValueUsdE8: USD_E8 }));
    expect(plan.legs.map(({ token, quoteAmount }) => [token, quoteAmount])).toEqual([
      [A, 99_000_000n],
      [B, 1_000_000n],
    ]);
    expect(plan.skipped).toEqual([]);
  });
});

describe("planRebalance: the cap on a buy rounds down", () => {
  test("a buy that would end a fraction above its target weight is not proposed", () => {
    // A (0.99%) holds nothing, B (98.01%) holds 0.0001 USD and C (1%) is a whole-unit token at 1,000.00 USD
    // that 0.000002 USDC cannot buy. With C skipped, A may hold 99/9901 of the 0.0001 USD of B: 0.99989...
    // millionths of a USD, less than the one quote base unit a buy needs.
    const plan = planOf({
      mode: "buy_only",
      reserveBps: 0,
      minLegValueUsdE8: 0n,
      constituents: [
        { token: A, weightBps: 99, decimals: 6 },
        { token: B, weightBps: 9_801, decimals: 6 },
        { token: C, weightBps: 100, decimals: 0 },
      ],
      holdings: [{ token: B, balance: 100n, decimals: 6 }],
      prices: [price(A, USD_E8), price(B, USD_E8), price(C, 1_000n * USD_E8)],
      quoteBalance: 2n,
    });
    expect(plan.legs).toEqual([]);
    expect(plan.skipped).toEqual([
      { side: "buy", token: A, exit: false, valueUsdE8: 100n, reason: "above_target_weight" },
      { side: "buy", token: C, exit: false, valueUsdE8: 100n, reason: "zero_quantity" },
    ]);
    expect(plan.projected.positions.map(({ weightBps }) => weightBps)).toEqual([0, 10_000, 0]);
    expect(plan.projected.quoteBalance).toBe(2n);
  });
});

describe("planRebalance: a first replication buys every constituent or nothing", () => {
  const ninetyTen: RebalancePlanInput = {
    mode: "rebalance",
    constituents: [
      { token: A, weightBps: 9_000, decimals: 8 },
      { token: B, weightBps: 1_000, decimals: 8 },
    ],
    holdings: [],
    prices: [price(A, USD_E8), price(B, USD_E8)],
    quoteBalance: 9_000_000n,
  };

  test("9 USD into 90/10 is blocked with the value that would be enough", () => {
    // B would get 0.8955 USD. It needs 1.00 USD plus one base unit (0.00000001 USD) plus 0.000008 USD of
    // rounding, at a weight of 10% after a reserve of 0.5%: 1.00000801 / (0.1 * 0.995) = 10.05033175... USD.
    const result = planRebalance(ninetyTen);
    expect(result).toEqual({
      status: "blocked",
      blockers: [
        {
          code: "below_minimum_portfolio_value",
          severity: "blocker",
          token: null,
          minimumDeployableValueUsdE8: 1_005_033_176n,
        },
      ],
      warnings: [],
      valuation: valuePortfolio(ninetyTen),
    });
    expect("legs" in result).toBe(false);
  });

  test("that value is enough", () => {
    // 10.050332 USDC, the minimum rounded up to a quote base unit.
    const plan = planOf({ ...ninetyTen, quoteBalance: 10_050_332n });
    expect(plan.legs.map(({ token, valueUsdE8 }) => [token, valueUsdE8])).toEqual([
      [A, 900_007_200n],
      [B, 100_000_700n],
    ]);
    expect(plan.projected.positions.map(({ weightBps }) => weightBps)).toEqual([9_000, 1_000]);
  });

  test("a whole-unit token needs the price of one unit", () => {
    // A is a whole-unit token at 1,000.00 USD with a weight of 50%: 1,000 USDC cannot buy a unit of it.
    const whole = (quoteBalance: bigint): RebalancePlanInput =>
      exact({
        constituents: [
          { token: A, weightBps: 5_000, decimals: 0 },
          { token: B, weightBps: 5_000, decimals: 6 },
        ],
        holdings: [],
        prices: [price(A, 1_000n * USD_E8), price(B, USD_E8)],
        quoteBalance,
      });
    // (1,000.00 USD + 0.000008 USD) / 50% = 2,000.000016 USD.
    expect(blockersOf(whole(1_000_000_000n))).toEqual([
      {
        code: "below_minimum_portfolio_value",
        severity: "blocker",
        token: null,
        minimumDeployableValueUsdE8: 200_000_001_600n,
      },
    ]);
    expect(planOf(whole(2_000_000_016n)).legs.map(({ token, tokenQuantity }) => [token, tokenQuantity])).toEqual([
      [A, 1n],
      [B, 1_000_000_008n],
    ]);
  });

  test("a wallet that only holds a removed token is not sold into the quote asset when the buys cannot follow", () => {
    // 2.00 USD of the removed token C: the sale passes the minimum, the buy of B (0.199 USD) does not.
    const migration: RebalancePlanInput = {
      ...ninetyTen,
      quoteBalance: 0n,
      holdings: [{ token: C, balance: 2_000_000n, decimals: 6 }],
      prices: [...ninetyTen.prices, price(C, USD_E8)],
      exitTokens: [C],
    };
    // One more quote base unit of rounding for the exit: 1.00000901 / (0.1 * 0.995) = 10.05034180... USD.
    expect(blockersOf(migration)).toEqual([
      {
        code: "below_minimum_portfolio_value",
        severity: "blocker",
        token: null,
        minimumDeployableValueUsdE8: 1_005_034_181n,
      },
    ]);
    const plan = planOf({ ...migration, minLegValueUsdE8: 0n });
    expect(plan.legs.map(({ side, token }) => [side, token])).toEqual([
      ["sell", C],
      ["buy", A],
      ["buy", B],
    ]);
  });
});

describe("planRebalance: sells are scaled to what the buys spend", () => {
  test("a sell whose proceeds no buy would spend is not proposed", () => {
    // 46/18/18/18 USD against 40/20/20/20 with a minimum of 3.00 USD: the sell of A is 6.00 USD and each buy
    // is 2.00 USD. Selling A alone would leave 6 USD idle and the three others further from target.
    const plan = planOf(
      exact(dollars([4_000, 2_000, 2_000, 2_000], [46n, 18n, 18n, 18n]), { minLegValueUsdE8: 3n * USD_E8 }),
    );
    expect(plan.legs).toEqual([]);
    expect(plan.skipped).toEqual([
      { side: "sell", token: A, exit: false, valueUsdE8: 600_000_000n, reason: "not_needed" },
      { side: "buy", token: B, exit: false, valueUsdE8: 200_000_000n, reason: "below_minimum" },
      { side: "buy", token: C, exit: false, valueUsdE8: 200_000_000n, reason: "below_minimum" },
      { side: "buy", token: D, exit: false, valueUsdE8: 200_000_000n, reason: "below_minimum" },
    ]);
    expect(plan.projected.maxAbsDriftBps).toBe(600);
    expect(plan.projected.quoteBalance).toBe(0n);
  });

  test("a sell is reduced to the proceeds the remaining buys need", () => {
    // 60.00/39.50/0.50 USD against 50/49/1: A sells 10.00, B wants 9.50 and C wants 0.50, below 1.00 USD.
    // With A at 50.00 and C at 0.50, B can hold 49/51 of 50.50 = 48.5196... USD: it buys 9.019607 USDC.
    // The sell is scaled to exactly those 9.019607 USDC.
    const plan = planOf(
      exact(
        {
          ...dollars([5_000, 4_900, 100], [60n, 0n, 0n]),
          holdings: [
            { token: A, balance: 60_000_000n, decimals: 6 },
            { token: B, balance: 39_500_000n, decimals: 6 },
            { token: C, balance: 500_000n, decimals: 6 },
          ],
        },
        { minLegValueUsdE8: USD_E8 },
      ),
    );
    expect(
      plan.legs.map(({ side, token, tokenQuantity, quoteAmount }) => [side, token, tokenQuantity, quoteAmount]),
    ).toEqual([
      ["sell", A, 9_019_607n, 9_019_607n],
      ["buy", B, 9_019_607n, 9_019_607n],
    ]);
    expect(plan.skipped).toEqual([
      { side: "buy", token: C, exit: false, valueUsdE8: 50_000_000n, reason: "below_minimum" },
    ]);
    expect(plan.buyBudgetQuote).toBe(9_019_607n);
    expect(plan.currentMaxAbsDriftBps).toBe(1_000);
    expect(plan.projected.positions.map(({ driftBps }) => driftBps)).toEqual([98, -48, -50]);
    expect(plan.projected.quoteBalance).toBe(0n);
  });

  test("with a reserve the sell raises the buys plus their reserve, rounded up", () => {
    // The same wallet with a reserve of 0.5%: B still buys 9.019607 USDC. That needs 9.019607 / 0.995 =
    // 9.064931658... USDC of proceeds, rounded up, so that the budget after the reserve covers the buy.
    const plan = planOf({
      mode: "rebalance",
      ...dollars([5_000, 4_900, 100], [60n, 0n, 0n]),
      holdings: [
        { token: A, balance: 60_000_000n, decimals: 6 },
        { token: B, balance: 39_500_000n, decimals: 6 },
        { token: C, balance: 500_000n, decimals: 6 },
      ],
    });
    expect(plan.legs.map(({ side, token, quoteAmount }) => [side, token, quoteAmount])).toEqual([
      ["sell", A, 9_064_932n],
      ["buy", B, 9_019_607n],
    ]);
    expect(plan.buyBudgetQuote).toBe(9_019_607n);
    expect(plan.projected.quoteBalance).toBe(45_325n);
  });

  test("several scaled sells together raise at least what the buys need", () => {
    // A and B (6 decimals, 3.00 USD) hold 30 USD each against 20% each, C holds 39 USD against 59% and D holds
    // 1 USD against 1%. C wants 20 and D wants nothing: both sells are needed in full.
    const input = (dBalance: bigint): RebalancePlanInput => ({
      mode: "rebalance",
      reserveBps: 0,
      constituents: [
        { token: A, weightBps: 2_000, decimals: 6 },
        { token: B, weightBps: 2_000, decimals: 6 },
        { token: C, weightBps: 5_900, decimals: 6 },
        { token: D, weightBps: 100, decimals: 6 },
      ],
      holdings: [
        { token: A, balance: 10_000_000n, decimals: 6 },
        { token: B, balance: 10_000_000n, decimals: 6 },
        { token: C, balance: 39_000_000n, decimals: 6 },
        { token: D, balance: dBalance, decimals: 6 },
      ],
      prices: [price(A, 3n * USD_E8), price(B, 3n * USD_E8), price(C, USD_E8), price(D, USD_E8)],
      quoteBalance: 0n,
    });
    const full = planOf(input(1_000_000n));
    expect(full.legs.map(({ side, quoteAmount }) => [side, quoteAmount])).toEqual([
      ["sell", 9_999_999n],
      ["sell", 9_999_999n],
      ["buy", 19_999_998n],
    ]);
    // With D at 0.50 USD, D wants 0.495 USD, below the minimum. A and B end at 19.900002 USD each after a
    // full sell, so C can hold 59/41 of 40.300004 = 57.992688... USD: it buys 18.992688 USDC. Each sell of
    // 3.366666 tokens is scaled by (18.992688 + 0.000001) / 20.199996 to 3.1654481..., rounded up to
    // 3.165449 tokens, worth 9.496347 USDC.
    const scaled = planOf(input(500_000n));
    expect(scaled.legs.map(({ side, tokenQuantity, quoteAmount }) => [side, tokenQuantity, quoteAmount])).toEqual([
      ["sell", 3_165_449n, 9_496_347n],
      ["sell", 3_165_449n, 9_496_347n],
      ["buy", 18_992_688n, 18_992_688n],
    ]);
    expect(scaled.buyBudgetQuote).toBe(18_992_694n);
    expect(scaled.projected.quoteBalance).toBe(6n);
  });

  test("a scaled sell is never smaller than the minimum leg value", () => {
    // 70/20/5/5 USD against 50/40/5/5 with 19.50 USDC: targets 59.75, 47.80, 5.975 and 5.975 USD. A sells
    // 10.25, B wants 27.80, C and D want 0.975 each. Without a minimum every buy goes through and the sell is
    // needed in full.
    const full = planOf(exact(dollars([5_000, 4_000, 500, 500], [70n, 20n, 5n, 5n], 19_500_000n)));
    expect(full.legs.map(({ side, quoteAmount }) => [side, quoteAmount])).toEqual([
      ["sell", 10_250_000n],
      ["buy", 27_800_000n],
      ["buy", 975_000n],
      ["buy", 975_000n],
    ]);
    // With a minimum of 5.00 USD the buys of C and D are skipped. A at 59.75 with C and D at 5.00 each is
    // 69.75 USD, so B can hold 40/60 of that, 46.50 USD: it buys 26.50 USDC, which needs 7.00 USDC of proceeds.
    const scaled = planOf(
      exact(dollars([5_000, 4_000, 500, 500], [70n, 20n, 5n, 5n], 19_500_000n), { minLegValueUsdE8: 5n * USD_E8 }),
    );
    expect(scaled.legs.map(({ side, quoteAmount }) => [side, quoteAmount])).toEqual([
      ["sell", 7_000_000n],
      ["buy", 26_500_000n],
    ]);
    // With a minimum of 9.00 USD the scaled sell would be 7.00 USD: it is raised to the minimum.
    const raised = planOf(
      exact(dollars([5_000, 4_000, 500, 500], [70n, 20n, 5n, 5n], 19_500_000n), { minLegValueUsdE8: 9n * USD_E8 }),
    );
    expect(raised.legs.map(({ side, quoteAmount }) => [side, quoteAmount])).toEqual([
      ["sell", 9_000_000n],
      ["buy", 26_500_000n],
    ]);
    expect(raised.projected.quoteBalance).toBe(2_000_000n);
  });
});

describe("planRebalance: buy only", () => {
  test("a deposit buys what is below target and sells nothing", () => {
    // 60/40 USD against 50/50 with a deposit of 10 USD: targets 55/55, B wants 15 and gets the 10 there are.
    const plan = planOf(exact(dollars([5_000, 5_000], [60n, 40n]), { mode: "buy_only", depositUsdE8: 10n * USD_E8 }));
    expect(plan.legs).toEqual([
      {
        side: "buy",
        token: B,
        exit: false,
        tokenQuantity: 10_000_000n,
        quoteAmount: 10_000_000n,
        valueUsdE8: 1_000_000_000n,
        priceE8: 100_000_000n,
      },
    ]);
    expect(plan.skipped).toEqual([]);
    expect(plan.currentMaxAbsDriftBps).toBe(1_000);
    // 60 and 50 of 110 USD: 5,454.5 and 4,545.5 bps.
    expect(plan.projected.positions.map(({ weightBps, driftBps }) => [weightBps, driftBps])).toEqual([
      [5_455, 455],
      [4_545, -455],
    ]);
    expect(plan.projected.maxAbsDriftBps).toBe(455);
    expect(plan.valuation.quoteBalance).toBe(0n);
  });

  test("the same wallet in rebalance mode sells the excess", () => {
    const plan = planOf(exact(dollars([5_000, 5_000], [60n, 40n]), { depositUsdE8: 10n * USD_E8 }));
    expect(plan.legs.map(({ side, token, quoteAmount }) => [side, token, quoteAmount])).toEqual([
      ["sell", A, 5_000_000n],
      ["buy", B, 15_000_000n],
    ]);
  });

  test("without quote asset there is nothing to do", () => {
    const plan = planOf(exact(dollars([5_000, 5_000], [60n, 40n]), { mode: "buy_only" }));
    expect(plan.legs).toEqual([]);
    expect(plan.projected.maxAbsDriftBps).toBe(1_000);
  });

  test("tokens to exit are not sold", () => {
    const input = dollars([10_000], [10n], 5_000_000n);
    const plan = planOf(
      exact(
        { ...input, holdings: [...input.holdings, { token: D, balance: 9_000_000n, decimals: 6 }] },
        { mode: "buy_only", exitTokens: [D] },
      ),
    );
    expect(plan.legs.map(({ side, token }) => [side, token])).toEqual([["buy", A]]);
    expect(plan.deployableValueUsdE8).toBe(1_500_000_000n);
  });

  test("an unknown mode is an input error, not a buy-only plan", () => {
    const input = { ...exact(dollars([5_000, 5_000], [60n, 40n], 10_000_000n)), mode: "sell_only" };
    expect(errorCode(() => planRebalance(input as unknown as RebalancePlanInput))).toBe("invalid_mode");
    const missing = { ...dollars([5_000, 5_000], [60n, 40n], 10_000_000n) };
    expect(errorCode(() => planRebalance(missing as unknown as RebalancePlanInput))).toBe("invalid_mode");
  });
});

describe("planRebalance: tokens to exit", () => {
  // The target version holds only A. The wallet holds 10 A, 30 of the removed token C and 7 of the unrelated D.
  const base = dollars([10_000], [10n]);
  const input: PortfolioInput = {
    ...base,
    holdings: [
      ...base.holdings,
      { token: C, balance: 30_000_000n, decimals: 6 },
      { token: D, balance: 7_000_000n, decimals: 6 },
    ],
    prices: [...base.prices, price(C, 2n * USD_E8), price(D, USD_E8)],
  };

  test("a token to exit is sold in full and its proceeds are deployed", () => {
    const plan = planOf(exact(input, { exitTokens: [C] }));
    // 10 USD of A plus 60 USD of C.
    expect(plan.deployableValueUsdE8).toBe(7_000_000_000n);
    expect(plan.legs).toEqual([
      {
        side: "sell",
        token: C,
        exit: true,
        tokenQuantity: 30_000_000n,
        quoteAmount: 60_000_000n,
        valueUsdE8: 6_000_000_000n,
        priceE8: 200_000_000n,
      },
      {
        side: "buy",
        token: A,
        exit: false,
        tokenQuantity: 60_000_000n,
        quoteAmount: 60_000_000n,
        valueUsdE8: 6_000_000_000n,
        priceE8: 100_000_000n,
      },
    ]);
  });

  test("a token outside the index that is not listed is never sold or counted", () => {
    const listed = planOf(exact(input, { exitTokens: [C] }));
    expect(listed.legs.some(({ token }) => token === D)).toBe(false);
    const none = planOf(exact(input));
    expect(none.legs).toEqual([]);
    expect(none.deployableValueUsdE8).toBe(1_000_000_000n);
    expect(none.valuation.outsideIndex.map(({ token }) => token)).toEqual([C, D]);
  });

  test("an exit sells in address order with the other sells", () => {
    const two = dollars([5_000, 5_000], [0n, 40n]);
    const plan = planOf(
      exact(
        {
          ...two,
          holdings: [...two.holdings, { token: C, balance: 20_000_000n, decimals: 6 }],
          prices: [...two.prices, price(C, USD_E8)],
        },
        { exitTokens: [C] },
      ),
    );
    expect(plan.legs.map(({ side, token, exit }) => [side, token, exit])).toEqual([
      ["sell", B, false],
      ["sell", C, true],
      ["buy", A, false],
    ]);
  });

  test("an exit below the minimum leg value is skipped and is not deployable", () => {
    const plan = planOf(exact(input, { exitTokens: [C], minLegValueUsdE8: 6_000_000_001n }));
    expect(plan.skipped).toEqual([
      { side: "sell", token: C, exit: true, valueUsdE8: 6_000_000_000n, reason: "below_minimum" },
    ]);
    expect(plan.legs).toEqual([]);
    // Only the 10 USD of A: the 60 USD of C stay in the wallet and do not raise any target.
    expect(plan.deployableValueUsdE8).toBe(1_000_000_000n);
    expect(plan.targets[0]).toMatchObject({ targetValueUsdE8: 1_000_000_000n, deltaUsdE8: 0n });
  });

  test("an exit is sold in full even when a buy is skipped", () => {
    // The target version is 50/50 of A and B. The wallet holds 60 USD of the removed C and 30 USD of A. B wants
    // 45 and A wants 15; with a minimum of 20 USD the buy of A is skipped, and B is capped at its weight.
    const two = dollars([5_000, 5_000], [30n, 0n]);
    const plan = planOf(
      exact(
        {
          ...two,
          holdings: [...two.holdings, { token: C, balance: 30_000_000n, decimals: 6 }],
          prices: [...two.prices, price(C, 2n * USD_E8)],
        },
        { exitTokens: [C], minLegValueUsdE8: 20n * USD_E8 },
      ),
    );
    expect(plan.legs.map(({ side, token, quoteAmount }) => [side, token, quoteAmount])).toEqual([
      ["sell", C, 60_000_000n],
      ["buy", B, 30_000_000n],
    ]);
    expect(plan.projected.positions.map(({ weightBps }) => weightBps)).toEqual([5_000, 5_000]);
    expect(plan.projected.quoteBalance).toBe(30_000_000n);
  });

  test("a listed token the wallet does not hold needs no price", () => {
    const plan = planOf(exact(base, { exitTokens: [C, D] }));
    expect(plan.legs).toEqual([]);
  });

  test("a held token to exit without a usable price blocks the plan", () => {
    const prices = (c: ReferencePrice[]) => exact({ ...input, prices: [...base.prices, ...c] }, { exitTokens: [C] });
    expect(blockersOf(prices([]))).toEqual([{ code: "missing_price", severity: "blocker", token: C }]);
    expect(blockersOf(prices([price(C, USD_E8, "unavailable")]))).toEqual([
      { code: "price_unavailable", severity: "blocker", token: C },
    ]);
    expect(blockersOf(prices([price(C, 0n)]))).toEqual([{ code: "zero_price", severity: "blocker", token: C }]);
    expect(planOf(prices([price(C, USD_E8, "last_close")])).warnings).toEqual([
      { code: "market_closed", severity: "warning", token: C },
    ]);
    expect(blockersOf({ ...prices([price(C, USD_E8, "last_close")]), blockOnLastClose: true })).toEqual([
      { code: "market_closed", severity: "blocker", token: C },
    ]);
  });

  test("a constituent, a repeated token or a malformed address cannot be listed", () => {
    expect(errorCode(() => planRebalance(exact(input, { exitTokens: [A] })))).toBe("exit_token_is_constituent");
    expect(errorCode(() => planRebalance(exact(input, { exitTokens: [C, C] })))).toBe("duplicate_token");
    expect(errorCode(() => planRebalance(exact(input, { exitTokens: ["0xC3"] })))).toBe("invalid_address");
  });
});

describe("planRebalance: blockers and warnings", () => {
  const input = dollars([5_000, 5_000], [60n, 40n]);
  const withPrices = (...prices: ReferencePrice[]) => exact({ ...input, prices });

  test("a blocked result has no legs and still returns the valuation", () => {
    const result = planRebalance(withPrices(price(A, USD_E8)));
    expect(result.status).toBe("blocked");
    expect(Object.keys(result).sort()).toEqual(["blockers", "status", "valuation", "warnings"]);
    expect(blockersOf(withPrices(price(A, USD_E8)))).toEqual([
      { code: "missing_price", severity: "blocker", token: B },
    ]);
    expect(result.valuation.positions[0]?.valueUsdE8).toBe(6_000_000_000n);
  });

  test("an unavailable price and a zero price block the plan", () => {
    expect(blockersOf(withPrices(price(A, USD_E8, "unavailable"), price(B, USD_E8)))).toEqual([
      { code: "price_unavailable", severity: "blocker", token: A },
    ]);
    expect(blockersOf(withPrices(price(A, USD_E8), price(B, 0n)))).toEqual([
      { code: "zero_price", severity: "blocker", token: B },
    ]);
  });

  test("a price without a status, or with an unknown one, is unavailable and never a number", () => {
    const noStatus = { token: B, priceE8: USD_E8 } as unknown as ReferencePrice;
    const stale = { token: B, priceE8: USD_E8, status: "stale" } as unknown as ReferencePrice;
    const garbage = { token: B, priceE8: "1", status: null } as unknown as ReferencePrice;
    for (const bad of [noStatus, stale, garbage]) {
      const result = planRebalance({
        mode: "buy_only",
        ...input,
        prices: [price(A, USD_E8), bad],
        quoteBalance: 50_000_000n,
      });
      expect(result.status).toBe("blocked");
      expect(blockersOf(withPrices(price(A, USD_E8), bad))).toEqual([
        { code: "price_unavailable", severity: "blocker", token: B },
      ]);
      expect(result.valuation.positions[1]).toMatchObject({
        priceE8: null,
        priceStatus: "unavailable",
        valueUsdE8: null,
      });
    }
  });

  test("an unavailable price is a blocker whatever value it carries", () => {
    expect(blockersOf(withPrices(price(A, USD_E8), price(B, -5n, "unavailable")))).toEqual([
      { code: "price_unavailable", severity: "blocker", token: B },
    ]);
    expect(errorCode(() => planRebalance(withPrices(price(A, USD_E8), price(B, -5n, "live"))))).toBe("negative_amount");
  });

  test("a decimals mismatch blocks the plan", () => {
    const mismatch = exact({ ...input, holdings: [{ token: A, balance: 60_000_000n, decimals: 8 }] });
    expect(blockersOf(mismatch)).toEqual([{ code: "decimals_mismatch", severity: "blocker", token: A }]);
  });

  test("nothing to deploy blocks the plan", () => {
    expect(blockersOf(exact(dollars([5_000, 5_000], [0n, 0n])))).toEqual([
      { code: "zero_deployable_value", severity: "blocker", token: null },
    ]);
    // A deposit below one quote base unit is still nothing.
    expect(blockersOf(exact(dollars([10_000], [0n]), { depositUsdE8: 99n }))).toMatchObject([
      { code: "zero_deployable_value" },
    ]);
    expect(planOf(exact(dollars([10_000], [0n]), { depositUsdE8: 100n })).legs.length).toBe(1);
  });

  test("a last_close price warns and the plan is still computed", () => {
    const plan = planOf(withPrices(price(A, USD_E8, "last_close"), price(B, USD_E8)));
    expect(plan.warnings).toEqual([{ code: "market_closed", severity: "warning", token: A }]);
    expect(plan.valuation.issues).toEqual([{ code: "market_closed", severity: "warning", token: A }]);
    expect(plan.legs.length).toBe(2);
  });

  test("blockOnLastClose turns that warning into a blocker everywhere it is reported", () => {
    const prices = withPrices(price(A, USD_E8, "last_close"), price(B, USD_E8, "delayed"));
    const result = planRebalance({ ...prices, blockOnLastClose: true });
    expect(result).toEqual({
      status: "blocked",
      blockers: [{ code: "market_closed", severity: "blocker", token: A }],
      warnings: [{ code: "price_delayed", severity: "warning", token: B }],
      valuation: valuePortfolio({ ...prices, blockOnLastClose: true }),
    });
    expect(result.valuation.issues).toEqual([
      { code: "market_closed", severity: "blocker", token: A },
      { code: "price_delayed", severity: "warning", token: B },
    ]);
    // The last close is a published value: the position is still valued.
    expect(result.valuation.positions.map(({ weightBps }) => weightBps)).toEqual([6_000, 4_000]);
    expect(planRebalance({ ...prices, blockOnLastClose: false }).status).toBe("ready");
    // Without a last_close price the option changes nothing.
    expect(planRebalance({ ...exact(input), blockOnLastClose: true }).status).toBe("ready");
  });

  test("a delayed price warns", () => {
    const plan = planOf(withPrices(price(A, USD_E8), price(B, USD_E8, "delayed")));
    expect(plan.warnings).toEqual([{ code: "price_delayed", severity: "warning", token: B }]);
  });

  test("a plan that would raise the maximum drift says so, with both numbers", () => {
    // Five constituents of 0.2% hold 110 USD each (2.2%), F of 89% holds 4,450 USD (89%), five of 2% hold
    // nothing: the widest drift is 200 bps. A buy-only plan with 5,000 USDC cannot sell the first five, so the
    // 5,000 are shared pro rata between F (shortfall 4,450) and the last five (200 each): F gets 4,082.57 and
    // ends at 85.33% of 10,000 USD, 367 bps under its target.
    const tokens = range(11).map((i) => address(0xa0 + i));
    const weights = [20, 20, 20, 20, 20, 8_900, 200, 200, 200, 200, 200];
    const held = [110n, 110n, 110n, 110n, 110n, 4_450n];
    const plan = planOf({
      mode: "buy_only",
      reserveBps: 0,
      minLegValueUsdE8: 0n,
      constituents: tokens.map((token, i) => ({ token, weightBps: weights[i] ?? 0, decimals: 6 })),
      holdings: held.map((balance, i) => ({ token: address(0xa1 + i), balance: balance * 1_000_000n, decimals: 6 })),
      prices: tokens.map((token) => price(token, USD_E8)),
      quoteBalance: 5_000_000_000n,
    });
    expect(plan.legs.map(({ quoteAmount }) => quoteAmount)).toEqual([
      4_082_568_807n,
      183_486_238n,
      183_486_238n,
      183_486_238n,
      183_486_238n,
      183_486_238n,
    ]);
    expect(plan.projected.positions.map(({ driftBps }) => driftBps)).toEqual([
      90, 90, 90, 90, 90, -367, -16, -16, -17, -17, -17,
    ]);
    expect(plan.warnings).toEqual([
      {
        code: "projected_drift_increase",
        severity: "warning",
        token: null,
        currentMaxAbsDriftBps: 200,
        projectedMaxAbsDriftBps: 367,
      },
    ]);
  });

  test("a first replication is compared against a drift of zero", () => {
    // 3 quote base units into 50/50 of a 6-decimal token at 1.00 USD: one unit each, and one unit left.
    // 0.000003 USDC into 60/40 buys one unit of A and one of B: 50/50 against 60/40.
    const plan = planOf(exact(dollars([6_000, 4_000], [0n, 0n], 3n)));
    expect(plan.legs.map(({ quoteAmount }) => quoteAmount)).toEqual([1n, 1n]);
    expect(plan.currentMaxAbsDriftBps).toBeNull();
    expect(plan.warnings).toEqual([
      {
        code: "projected_drift_increase",
        severity: "warning",
        token: null,
        currentMaxAbsDriftBps: null,
        projectedMaxAbsDriftBps: 1_000,
      },
    ]);
  });

  test("amounts that are not bigints and parameters out of range throw typed errors", () => {
    const run = (options: object) =>
      errorCode(() => planRebalance({ ...exact(input), ...options } as unknown as RebalancePlanInput));
    expect(run({ minLegValueUsdE8: -1n })).toBe("negative_amount");
    expect(run({ depositUsdE8: -1n })).toBe("negative_amount");
    expect(run({ quoteBalance: -1n })).toBe("negative_amount");
    expect(run({ minLegValueUsdE8: 100 })).toBe("invalid_amount");
    expect(run({ depositUsdE8: 10.5 })).toBe("invalid_amount");
    expect(run({ quoteBalance: 5 })).toBe("invalid_amount");
    expect(run({ quoteBalance: "5" })).toBe("invalid_amount");
    expect(run({ holdings: [{ token: A, balance: 60, decimals: 6 }] })).toBe("invalid_amount");
    expect(run({ prices: [{ token: A, priceE8: 1, status: "live" }, price(B, USD_E8)] })).toBe("invalid_amount");
    expect(run({ reserveBps: 2_000 })).toBe("no error");
  });
});

describe("planRebalance: a portfolio on target", () => {
  test("proposes nothing", () => {
    const plan = planOf({ mode: "rebalance", ...dollars([7_500, 2_500], [75n, 25n]) });
    expect(plan.legs).toEqual([]);
    expect(plan.skipped).toEqual([]);
    expect(plan.projected.maxAbsDriftBps).toBe(0);
  });

  test("the projection of an empty plan is the current portfolio", () => {
    // 0.000123 USDC next to 100 USD on target: both buys are far below the minimum.
    const plan = planOf({ mode: "buy_only", ...dollars([5_000, 5_000], [50n, 50n], 123n) });
    expect(plan.legs).toEqual([]);
    expect(plan.projected.quoteBalance).toBe(123n);
    expect(plan.projected.positions.map(({ balance }) => balance)).toEqual([50_000_000n, 50_000_000n]);
  });
});
