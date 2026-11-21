/**
 * Rebalance eligibility and rebalance plan of `equityos.calc/1`.
 *
 * A plan is arithmetic toward the published target weights at reference prices. It is an ordered list of legs
 * through the quote asset: sells of constituents first, then buys. It knows nothing about executable prices,
 * slippage, fees, gas or transfer restrictions, and a reference value in it is never the amount a trade will
 * settle for.
 *
 * Units: token quantities are token base units, quote amounts are base units of the quote asset
 * (`QUOTE_DECIMALS` decimals), values are USD scaled by 1e8, weights and drift are basis points.
 */

import { BPS, mulDivDown } from "./fixed-point.ts";
import {
  apportionBps,
  byToken,
  CalculationInputError,
  type CalculationIssue,
  checkAmount,
  checkBps,
  checkToken,
  computeDrift,
  type PortfolioInput,
  type PortfolioValuation,
  priceIssue,
  QUOTE_UNIT_VALUE_USD_E8,
  valuePortfolio,
  type WeightedPosition,
} from "./portfolio.ts";
import { positionValueUsdE8, USD_E8 } from "./position-value.ts";
import type { Address, IndexSpec } from "./spec.ts";

/**
 * Default share of the available funds that buys leave unspent. The reference feeds publish a new value on a
 * 0.5% deviation, so a reference price can trail the market by up to 50 bps while still being current: buys
 * sized on it can cost that much more by the time they execute. It is a buffer against price movement, not an
 * estimate of slippage or fees.
 */
export const DEFAULT_RESERVE_BPS = 50;

/**
 * Default reference value below which a leg is not proposed: 1.00 USD. Every leg is one swap with a fixed cost
 * (network fee, a signature, a minimum price increment in the pool) that does not shrink with the amount, so
 * below about this size a leg costs a material share of what it moves. A caller that knows the real cost of a
 * swap passes its own value; `0n` disables the rule.
 */
export const DEFAULT_MIN_LEG_VALUE_USD_E8 = USD_E8;

/** The rebalance rule of a spec. */
export type RebalanceRule = IndexSpec["rebalance"];

export interface EligibilityInput {
  readonly rule: RebalanceRule;
  readonly valuation: PortfolioValuation;
  /** Time of the last rebalance of this replication in Unix seconds, or `null` when there was none. */
  readonly lastRebalanceAt: number | null;
  /** Observation time in Unix seconds. */
  readonly now: number;
}

export type RebalanceEligibility =
  /** The wallet holds no constituent: a first replication is always allowed. */
  | { readonly due: true; readonly reason: "first_replication" }
  | { readonly due: true; readonly reason: "drift_threshold_reached"; readonly maxAbsDriftBps: number }
  | {
      readonly due: false;
      readonly reason: "below_threshold";
      readonly maxAbsDriftBps: number;
      readonly driftThresholdBps: number;
    }
  | { readonly due: false; readonly reason: "min_interval_not_elapsed"; readonly secondsRemaining: number }
  /** Drift is not defined: a blocker concerns a constituent, or the invested value is zero. */
  | { readonly due: false; readonly reason: "drift_unavailable" };

function checkSeconds(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new CalculationInputError("invalid_time", `${name} must be a non-negative integer of seconds`);
  }
}

/**
 * Whether the rebalance rule of the spec makes a rebalance due.
 *
 * In order: a wallet with a zero balance of every constituent is a first replication and is always due;
 * undefined drift is `drift_unavailable`; a maximum drift below the threshold is `below_threshold`; otherwise
 * the minimum interval applies, and a rebalance is due once `now - lastRebalanceAt >= minIntervalSeconds`.
 *
 * The rule says when the methodology calls for a rebalance. It does not gate `planRebalance`, and adding
 * quote asset to a replication is not a rebalance under the rule.
 *
 * @throws {CalculationInputError} if a time is not a non-negative safe integer or the threshold is out of range.
 */
export function rebalanceEligibility(input: EligibilityInput): RebalanceEligibility {
  const { rule, valuation, lastRebalanceAt, now } = input;
  checkSeconds(now, "now");
  checkSeconds(rule.minIntervalSeconds, "minIntervalSeconds");
  if (lastRebalanceAt !== null) checkSeconds(lastRebalanceAt, "lastRebalanceAt");
  const drift = computeDrift(valuation.positions, rule.driftThresholdBps);
  if (valuation.positions.every(({ balance }) => balance === 0n)) return { due: true, reason: "first_replication" };
  if (drift === null) return { due: false, reason: "drift_unavailable" };
  const { maxAbsDriftBps, driftThresholdBps } = drift;
  if (!drift.thresholdReached) return { due: false, reason: "below_threshold", maxAbsDriftBps, driftThresholdBps };
  if (lastRebalanceAt !== null) {
    // Positive when the interval has not elapsed, also for a last rebalance recorded after `now`.
    const secondsRemaining = lastRebalanceAt + rule.minIntervalSeconds - now;
    if (secondsRemaining > 0) return { due: false, reason: "min_interval_not_elapsed", secondsRemaining };
  }
  return { due: true, reason: "drift_threshold_reached", maxAbsDriftBps };
}

/**
 * - `rebalance`: sells constituents above their target value and tokens to exit, then buys.
 * - `buy_only`: never sells. Buys constituents below their target value with the quote asset available.
 */
export type PlanMode = "rebalance" | "buy_only";

export interface RebalancePlanInput extends PortfolioInput {
  readonly mode: PlanMode;
  /**
   * Quote asset that is added to the wallet before execution and is not part of `quoteBalance`, in USD scaled
   * by 1e8. Rounded down to whole base units of the quote asset. Defaults to zero.
   */
  readonly depositUsdE8?: bigint;
  /**
   * Tokens that left the index in the target version, typically the constituents of the previous version. A
   * listed token that the wallet holds is sold in full in `rebalance` mode. No other token outside the index
   * is ever sold. Ignored in `buy_only` mode.
   */
  readonly exitTokens?: readonly Address[];
  /** Share of the available funds that buys leave unspent, in `[0, 10_000]`. Defaults to `DEFAULT_RESERVE_BPS`. */
  readonly reserveBps?: number;
  /** Reference value below which a leg is skipped. Defaults to `DEFAULT_MIN_LEG_VALUE_USD_E8`. */
  readonly minLegValueUsdE8?: bigint;
  /** Turns the `market_closed` warning of a `last_close` price into a blocker. Defaults to `false`. */
  readonly blockOnLastClose?: boolean;
}

/** Target of one constituent. */
export interface ConstituentTarget {
  readonly token: Address;
  readonly targetWeightBps: number;
  readonly currentValueUsdE8: bigint;
  /** `floor(deployableValueUsdE8 * targetWeightBps / 10_000)`. */
  readonly targetValueUsdE8: bigint;
  /** `targetValueUsdE8 - currentValueUsdE8`: positive to buy, negative to sell. */
  readonly deltaUsdE8: bigint;
}

/** One swap between a token and the quote asset. */
export interface RebalanceLeg {
  /** `sell`: token to quote asset. `buy`: quote asset to token. */
  readonly side: "sell" | "buy";
  readonly token: Address;
  /** True for the full sale of a token listed in `exitTokens`. */
  readonly exit: boolean;
  /** Sell: the exact quantity to sell. Buy: the quantity `quoteAmount` buys at the reference price, rounded down. */
  readonly tokenQuantity: bigint;
  /** Sell: the proceeds at the reference price, rounded down. Buy: the exact amount of quote asset to spend. */
  readonly quoteAmount: bigint;
  /** Reference value of the leg. Sell: `floor(tokenQuantity * priceE8 / 10^decimals)`. Buy: value of `quoteAmount`. */
  readonly valueUsdE8: bigint;
  /** The reference price the leg was sized with. */
  readonly priceE8: bigint;
}

/** A leg that was computed and not proposed. */
export interface SkippedLeg {
  readonly side: "sell" | "buy";
  readonly token: Address;
  readonly exit: boolean;
  /** The reference value the leg would have had. */
  readonly valueUsdE8: bigint;
  /**
   * - `below_minimum`: the value is below `minLegValueUsdE8`.
   * - `zero_quantity`: the token quantity or the quote amount rounds down to zero.
   */
  readonly reason: "below_minimum" | "zero_quantity";
}

/** A constituent after every leg is applied at its reference price. */
export interface ProjectedPosition {
  readonly token: Address;
  readonly balance: bigint;
  readonly valueUsdE8: bigint;
  readonly targetWeightBps: number;
  /** Share of the projected invested value, or `null` when that value is zero. */
  readonly weightBps: number | null;
  /** `weightBps - targetWeightBps`: the drift that remains after the plan. */
  readonly driftBps: number | null;
}

export interface PlanProjection {
  /** One entry per constituent, in ascending token order. */
  readonly positions: readonly ProjectedPosition[];
  readonly investedValueUsdE8: bigint;
  /** Quote asset left after every leg, including the deposit and the reserve. */
  readonly quoteBalance: bigint;
  readonly maxAbsDriftBps: number | null;
}

export interface RebalancePlan {
  readonly mode: PlanMode;
  readonly reserveBps: number;
  readonly minLegValueUsdE8: bigint;
  /** Constituent values, plus the quote asset available, plus the value of the tokens to exit. */
  readonly deployableValueUsdE8: bigint;
  /** `quoteBalance` plus the deposit, in quote base units. */
  readonly availableQuote: bigint;
  /** Upper bound of the sum of `quoteAmount` over buys: available quote plus sell proceeds, less the reserve. */
  readonly buyBudgetQuote: bigint;
  /** One entry per constituent, in ascending token order. */
  readonly targets: readonly ConstituentTarget[];
  /** Execution order: every sell in ascending token order, then every buy in ascending token order. */
  readonly legs: readonly RebalanceLeg[];
  readonly skipped: readonly SkippedLeg[];
  /** Maximum absolute drift before the plan, or `null` when the invested value is zero. */
  readonly currentMaxAbsDriftBps: number | null;
  readonly projected: PlanProjection;
}

export interface RebalancePlanResult {
  /** Findings that prevent a plan. `plan` is `null` exactly when this list is not empty. */
  readonly blockers: readonly CalculationIssue[];
  readonly warnings: readonly CalculationIssue[];
  /** The wallet before the plan, without the deposit. */
  readonly valuation: PortfolioValuation;
  readonly plan: RebalancePlan | null;
}

function maxAbsDrift(positions: readonly WeightedPosition[]): number | null {
  let max: number | null = null;
  for (const { weightBps, targetWeightBps } of positions) {
    if (weightBps === null) return null;
    max = Math.max(max ?? 0, Math.abs(weightBps - targetWeightBps));
  }
  return max;
}

function skipReason(leg: RebalanceLeg, minLegValueUsdE8: bigint): SkippedLeg["reason"] | null {
  if (leg.valueUsdE8 < minLegValueUsdE8) return "below_minimum";
  if (leg.tokenQuantity === 0n || leg.quoteAmount === 0n) return "zero_quantity";
  return null;
}

/** A sell or a buy before it is sized into a leg. `amount` is token base units for a sell, quote base units for a buy. */
interface Candidate {
  readonly token: Address;
  readonly exit: boolean;
  readonly decimals: number;
  readonly priceE8: bigint;
  readonly amount: bigint;
}

/** Whole quote base units in a USD value, rounded down: a fraction of a base unit cannot be transferred. */
function quoteUnitsDown(valueUsdE8: bigint): bigint {
  return mulDivDown(valueUsdE8, 1n, QUOTE_UNIT_VALUE_USD_E8);
}

/**
 * Computes the legs that move a wallet toward the target weights at reference prices.
 *
 * 1. Deployable value: constituent values, plus `quoteBalance` and the deposit, plus the tokens to exit.
 * 2. Target value of a constituent: `floor(deployable * targetWeightBps / 10_000)`.
 * 3. Sells (`rebalance` mode): a constituent above its target sells `floor(excess * 10^decimals / price)`; a
 *    token to exit sells its whole balance. Proceeds are counted rounded down to quote base units.
 * 4. Buys: a constituent below its target wants `floor(shortfall / 100)` quote base units. The buy budget is
 *    `floor((availableQuote + proceeds of the proposed sells) * (10_000 - reserveBps) / 10_000)`. When the buys
 *    want more than the budget, each is scaled to `floor(wanted * budget / totalWanted)`.
 * 5. A leg worth less than `minLegValueUsdE8`, or with a zero quantity, is moved to `skipped`. What a skipped
 *    sell would have raised is not spent, and what a skipped buy would have spent stays in the quote asset.
 * 6. Projection: every leg applied at its reference price, then weights and drift as in `valuePortfolio`.
 *
 * Every rounding leaves value unspent instead of spending value that is not there. The projected value of each
 * constituent lies between its current value and its target value.
 *
 * Data-quality problems are returned in `blockers` and `warnings`. With any blocker, `plan` is `null`.
 *
 * @throws {CalculationInputError} for the input errors of `valuePortfolio`, a parameter out of range, or a
 * token to exit that is malformed, repeated or a constituent.
 */
export function planRebalance(input: RebalancePlanInput): RebalancePlanResult {
  const reserveBps = input.reserveBps ?? DEFAULT_RESERVE_BPS;
  const minLegValueUsdE8 = input.minLegValueUsdE8 ?? DEFAULT_MIN_LEG_VALUE_USD_E8;
  const depositUsdE8 = input.depositUsdE8 ?? 0n;
  checkBps(reserveBps, 0, "reserveBps");
  checkAmount(minLegValueUsdE8, "minLegValueUsdE8");
  checkAmount(depositUsdE8, "depositUsdE8");
  const valuation = valuePortfolio(input);

  const exitTokens = new Set<string>();
  for (const token of input.exitTokens ?? []) {
    checkToken(token, exitTokens, "exitTokens");
    if (valuation.positions.some((position) => position.token === token)) {
      throw new CalculationInputError("exit_token_is_constituent", `${token} is a constituent of the target version`);
    }
  }
  const exits =
    input.mode === "rebalance"
      ? valuation.outsideIndex.filter(({ token, balance }) => exitTokens.has(token) && balance > 0n)
      : [];

  const issues = [...valuation.issues];
  for (const { token, priceStatus, priceE8 } of exits) {
    const issue = priceIssue(token, priceStatus, priceE8);
    if (issue !== null) issues.push(issue);
  }
  // Rounds down: a fraction of a quote base unit cannot be deposited, so it is not counted.
  const availableQuote = input.quoteBalance + quoteUnitsDown(depositUsdE8);
  const exitValueUsdE8 = exits.reduce((sum, { valueUsdE8 }) => sum + (valueUsdE8 ?? 0n), 0n);
  const deployableValueUsdE8 =
    valuation.investedValueUsdE8 === null
      ? null
      : valuation.investedValueUsdE8 + availableQuote * QUOTE_UNIT_VALUE_USD_E8 + exitValueUsdE8;
  if (deployableValueUsdE8 === 0n) issues.push({ code: "zero_deployable_value", severity: "blocker", token: null });

  const classified = issues.map(
    (issue): CalculationIssue =>
      input.blockOnLastClose === true && issue.code === "market_closed" ? { ...issue, severity: "blocker" } : issue,
  );
  const blockers = classified.filter(({ severity }) => severity === "blocker");
  const warnings = classified.filter(({ severity }) => severity === "warning");
  if (blockers.length > 0 || deployableValueUsdE8 === null) return { blockers, warnings, valuation, plan: null };

  // Without blockers every constituent has a price above zero and a value.
  const positions = valuation.positions.flatMap((position) => {
    const { priceE8, valueUsdE8 } = position;
    if (priceE8 === null || valueUsdE8 === null) return [];
    // Rounds down: the targets never sum to more than the deployable value.
    const targetValueUsdE8 = mulDivDown(deployableValueUsdE8, BigInt(position.targetWeightBps), BPS);
    return [{ ...position, priceE8, valueUsdE8, targetValueUsdE8 }];
  });
  const targets = positions.map(({ token, targetWeightBps, valueUsdE8, targetValueUsdE8 }) => ({
    token,
    targetWeightBps,
    currentValueUsdE8: valueUsdE8,
    targetValueUsdE8,
    deltaUsdE8: targetValueUsdE8 - valueUsdE8,
  }));

  const legs: RebalanceLeg[] = [];
  const skipped: SkippedLeg[] = [];
  /** Signed change of each token balance: negative for a sell. */
  const balanceChange = new Map<Address, bigint>();
  const propose = (leg: RebalanceLeg): boolean => {
    const reason = skipReason(leg, minLegValueUsdE8);
    if (reason !== null) {
      skipped.push({ side: leg.side, token: leg.token, exit: leg.exit, valueUsdE8: leg.valueUsdE8, reason });
      return false;
    }
    legs.push(leg);
    balanceChange.set(leg.token, leg.side === "sell" ? -leg.tokenQuantity : leg.tokenQuantity);
    return true;
  };

  const sells: Candidate[] = [];
  if (input.mode === "rebalance") {
    for (const { token, decimals, priceE8, valueUsdE8, targetValueUsdE8 } of positions) {
      if (valueUsdE8 <= targetValueUsdE8) continue;
      // Rounds down: a sell never takes a constituent below its target value.
      const amount = mulDivDown(valueUsdE8 - targetValueUsdE8, 10n ** BigInt(decimals), priceE8);
      sells.push({ token, exit: false, decimals, priceE8, amount });
    }
    for (const { token, decimals, priceE8, balance } of exits) {
      if (priceE8 !== null) sells.push({ token, exit: true, decimals, priceE8, amount: balance });
    }
  }
  let proceedsQuote = 0n;
  for (const { token, exit, decimals, priceE8, amount } of byToken(sells)) {
    // Both round down: proceeds that may not arrive are not counted as funds for buys.
    const valueUsdE8 = positionValueUsdE8(amount, priceE8, decimals, "down");
    const quoteAmount = quoteUnitsDown(valueUsdE8);
    if (propose({ side: "sell", token, exit, tokenQuantity: amount, quoteAmount, valueUsdE8, priceE8 })) {
      proceedsQuote += quoteAmount;
    }
  }

  const buys: Candidate[] = [];
  for (const { token, decimals, priceE8, valueUsdE8, targetValueUsdE8 } of positions) {
    if (valueUsdE8 >= targetValueUsdE8) continue;
    // Rounds down: a buy never takes a constituent above its target value.
    const amount = quoteUnitsDown(targetValueUsdE8 - valueUsdE8);
    buys.push({ token, exit: false, decimals, priceE8, amount });
  }
  const wantedQuote = buys.reduce((sum, { amount }) => sum + amount, 0n);
  // Rounds down: the reserve is never smaller than asked.
  const buyBudgetQuote = mulDivDown(availableQuote + proceedsQuote, BPS - BigInt(reserveBps), BPS);
  let spentQuote = 0n;
  for (const { token, exit, decimals, priceE8, amount } of buys) {
    // Rounds down: the scaled buys never sum to more than the budget.
    const quoteAmount = wantedQuote > buyBudgetQuote ? mulDivDown(amount, buyBudgetQuote, wantedQuote) : amount;
    const valueUsdE8 = quoteAmount * QUOTE_UNIT_VALUE_USD_E8;
    // Rounds down: the plan never expects more tokens than the amount spent buys at the reference price.
    const tokenQuantity = mulDivDown(valueUsdE8, 10n ** BigInt(decimals), priceE8);
    if (propose({ side: "buy", token, exit, tokenQuantity, quoteAmount, valueUsdE8, priceE8 })) {
      spentQuote += quoteAmount;
    }
  }

  const projectedValues = positions.map(({ token, balance, decimals, priceE8, targetWeightBps }) => {
    const projectedBalance = balance + (balanceChange.get(token) ?? 0n);
    const valueUsdE8 = positionValueUsdE8(projectedBalance, priceE8, decimals, "down");
    return { token, balance: projectedBalance, valueUsdE8, targetWeightBps };
  });
  const projectedWeights = apportionBps(projectedValues.map(({ valueUsdE8 }) => valueUsdE8));
  const projectedPositions = projectedValues.map((position, index) => {
    const weightBps = projectedWeights?.[index] ?? null;
    return { ...position, weightBps, driftBps: weightBps === null ? null : weightBps - position.targetWeightBps };
  });
  const currentMaxAbsDriftBps = maxAbsDrift(valuation.positions);
  const projectedMaxAbsDriftBps = maxAbsDrift(projectedPositions);
  if (
    currentMaxAbsDriftBps !== null &&
    projectedMaxAbsDriftBps !== null &&
    projectedMaxAbsDriftBps > currentMaxAbsDriftBps
  ) {
    warnings.push({ code: "projected_drift_increase", severity: "warning", token: null });
  }

  return {
    blockers,
    warnings,
    valuation,
    plan: {
      mode: input.mode,
      reserveBps,
      minLegValueUsdE8,
      deployableValueUsdE8,
      availableQuote,
      buyBudgetQuote,
      targets,
      legs,
      skipped,
      currentMaxAbsDriftBps,
      projected: {
        positions: projectedPositions,
        investedValueUsdE8: projectedValues.reduce((sum, { valueUsdE8 }) => sum + valueUsdE8, 0n),
        quoteBalance: availableQuote + proceedsQuote - spentQuote,
        maxAbsDriftBps: projectedMaxAbsDriftBps,
      },
    },
  };
}
