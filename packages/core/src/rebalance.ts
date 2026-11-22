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

import { BPS, mulDivDown, mulDivUp } from "./fixed-point.ts";
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
  type TokenIssue,
  valuePortfolio,
  type WeightedPosition,
} from "./portfolio.ts";
import { positionValueUsdE8, USD_E8 } from "./position-value.ts";
import { type Address, type IndexSpec, TOTAL_WEIGHT_BPS } from "./spec.ts";

/**
 * Default share of the available funds that buys leave unspent. The reference feeds publish a new value on a
 * 0.5% deviation, so a reference price can trail the market by up to 50 bps while still being current: buys
 * sized on it can cost that much more by the time they execute. It is a buffer against price movement, not an
 * estimate of slippage or fees.
 */
export const DEFAULT_RESERVE_BPS = 50;

/**
 * Largest reserve accepted: 20%. The reserve covers the movement of a reference price between plan and
 * execution. A caller that expects prices to move by more than a fifth has no usable reference, and the answer
 * to that is not to plan, which is what a blocker is for. A reserve near 100% would turn every plan into sales
 * that buy nothing.
 */
export const MAX_RESERVE_BPS = 2_000;

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
  /** A constituent has no usable price or mismatched decimals, so nothing can be said about the wallet. */
  | { readonly due: false; readonly reason: "valuation_blocked"; readonly blockers: readonly TokenIssue[] }
  /** Nothing is invested in the constituents: a first replication is always allowed. */
  | { readonly due: true; readonly reason: "first_replication" }
  | { readonly due: true; readonly reason: "drift_threshold_reached"; readonly maxAbsDriftBps: number }
  | {
      readonly due: false;
      readonly reason: "below_threshold";
      readonly maxAbsDriftBps: number;
      readonly driftThresholdBps: number;
    }
  | { readonly due: false; readonly reason: "min_interval_not_elapsed"; readonly secondsRemaining: number };

function checkSeconds(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new CalculationInputError("invalid_time", `${name} must be a non-negative integer of seconds`);
  }
}

/**
 * Whether the rebalance rule of the spec makes a rebalance due.
 *
 * In order: a valuation without an invested value is `valuation_blocked` with the findings that caused it; an
 * invested value of zero is a first replication and is always due, also when the wallet holds base units too
 * small to have a value; a maximum drift below the threshold is `below_threshold`; otherwise the minimum
 * interval applies, and a rebalance is due once `now - lastRebalanceAt >= minIntervalSeconds`.
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
  const blockers = valuation.issues.filter(({ severity }) => severity === "blocker");
  if (valuation.investedValueUsdE8 === null) return { due: false, reason: "valuation_blocked", blockers };
  if (valuation.investedValueUsdE8 === 0n) return { due: true, reason: "first_replication" };
  if (drift === null) return { due: false, reason: "valuation_blocked", blockers };
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
  /**
   * Share of the funds that buys leave unspent, an integer in `[0, MAX_RESERVE_BPS]`. Defaults to
   * `DEFAULT_RESERVE_BPS`.
   */
  readonly reserveBps?: number;
  /** Reference value below which a leg is skipped. Defaults to `DEFAULT_MIN_LEG_VALUE_USD_E8`. */
  readonly minLegValueUsdE8?: bigint;
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
  /** Sell: the exact quantity to sell. Buy: the quantity bought at the reference price. */
  readonly tokenQuantity: bigint;
  /**
   * Sell: the proceeds at the reference price, rounded down. Buy: the exact amount of quote asset to spend,
   * which is what `tokenQuantity` costs at the reference price, rounded up to a quote base unit.
   */
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
  /** The reference value the leg was sized for, before rounding to base units. */
  readonly valueUsdE8: bigint;
  /**
   * - `below_minimum`: the leg is worth less than `minLegValueUsdE8`.
   * - `zero_quantity`: the token quantity or the quote amount rounds down to zero.
   * - `above_target_weight`: a buy that would leave its token above its target weight, because another buy
   *   was skipped.
   * - `not_needed`: a sell whose proceeds no buy would spend.
   */
  readonly reason: "below_minimum" | "zero_quantity" | "above_target_weight" | "not_needed";
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
  /** Quote asset left uninvested after every leg: the reserve, and whatever skipped or capped buys did not spend. */
  readonly quoteBalance: bigint;
  readonly maxAbsDriftBps: number | null;
}

/** The result when at least one blocker prevents a plan. It has no legs. */
export interface BlockedPlan {
  readonly status: "blocked";
  /** Never empty. */
  readonly blockers: readonly CalculationIssue[];
  readonly warnings: readonly CalculationIssue[];
  /** The wallet before the plan, without the deposit. */
  readonly valuation: PortfolioValuation;
}

export interface RebalancePlan {
  readonly status: "ready";
  readonly warnings: readonly CalculationIssue[];
  /** The wallet before the plan, without the deposit. */
  readonly valuation: PortfolioValuation;
  readonly mode: PlanMode;
  readonly reserveBps: number;
  readonly minLegValueUsdE8: bigint;
  /** Constituent values, plus the quote asset available, plus the value of the tokens sold to exit. */
  readonly deployableValueUsdE8: bigint;
  /** `quoteBalance` plus the deposit, in quote base units. */
  readonly availableQuote: bigint;
  /** Upper bound of the sum of `quoteAmount` over buys: available quote plus sell proceeds, less the reserve. */
  readonly buyBudgetQuote: bigint;
  /** One entry per constituent, in ascending token order. */
  readonly targets: readonly ConstituentTarget[];
  /** Execution order: every sell in ascending token order, then every buy in ascending token order. */
  readonly legs: readonly RebalanceLeg[];
  /** Sells then buys, each in ascending token order. */
  readonly skipped: readonly SkippedLeg[];
  /** Maximum absolute drift before the plan, or `null` when the invested value is zero. */
  readonly currentMaxAbsDriftBps: number | null;
  /**
   * Which candidate was chosen. `uncapped`: every buy that passes the minimum gets its pro rata share.
   * `capped`: after a skipped buy, the others are held at their target weight. Without a skipped buy there is
   * one candidate, `uncapped`.
   */
  readonly candidate: "uncapped" | "capped";
  /** Projected maximum drift of the candidate that was not chosen, or `null` when there was only one. */
  readonly otherCandidateMaxAbsDriftBps: number | null;
  readonly projected: PlanProjection;
}

/** Discriminated by `status`: a blocked result has no `legs` property at all. */
export type RebalancePlanResult = BlockedPlan | RebalancePlan;

/** A constituent with a usable price, its value and its target value. */
interface Tradable {
  readonly token: Address;
  readonly balance: bigint;
  readonly decimals: number;
  readonly priceE8: bigint;
  readonly valueUsdE8: bigint;
  readonly targetWeightBps: number;
  readonly targetValueUsdE8: bigint;
}

function sum(values: readonly bigint[]): bigint {
  return values.reduce((total, value) => total + value, 0n);
}

/** `Math.min` and `Math.max` do not take a bigint. */
function smaller(a: bigint, b: bigint): bigint {
  if (a < b) return a;
  return b;
}

function larger(a: bigint, b: bigint): bigint {
  if (a > b) return a;
  return b;
}

function maxAbsDrift(positions: readonly WeightedPosition[]): number | null {
  let max: number | null = null;
  for (const { weightBps, targetWeightBps } of positions) {
    if (weightBps === null) return null;
    max = Math.max(max ?? 0, Math.abs(weightBps - targetWeightBps));
  }
  return max;
}

/** Sells before buys, each side in ascending token order. */
function inExecutionOrder<T extends { readonly side: "sell" | "buy"; readonly token: Address }>(items: T[]): T[] {
  return [
    ...byToken(items.filter(({ side }) => side === "sell")),
    ...byToken(items.filter(({ side }) => side === "buy")),
  ];
}

/** Whole quote base units in a USD value, rounded down: a fraction of a base unit cannot be transferred. */
function quoteUnitsDown(valueUsdE8: bigint): bigint {
  return mulDivDown(valueUsdE8, 1n, QUOTE_UNIT_VALUE_USD_E8);
}

function sellLeg(
  token: Address,
  exit: boolean,
  tokenQuantity: bigint,
  priceE8: bigint,
  decimals: number,
): RebalanceLeg {
  // Both round down: proceeds that may not arrive are not counted as funds for buys.
  const valueUsdE8 = positionValueUsdE8(tokenQuantity, priceE8, decimals, "down");
  return { side: "sell", token, exit, tokenQuantity, quoteAmount: quoteUnitsDown(valueUsdE8), valueUsdE8, priceE8 };
}

/** The buy that spends at most `maxQuote`. */
function buyLeg({ token, priceE8, decimals }: Tradable, maxQuote: bigint): RebalanceLeg {
  // Rounds down: the plan never expects more tokens than the amount spent buys at the reference price.
  const tokenQuantity = mulDivDown(maxQuote * QUOTE_UNIT_VALUE_USD_E8, 10n ** BigInt(decimals), priceE8);
  // Both round up: the amount to spend covers that quantity at the reference price, and is not above `maxQuote`
  // because the quantity was rounded down from it. What `maxQuote` cannot turn into a base unit stays unspent.
  const costUsdE8 = positionValueUsdE8(tokenQuantity, priceE8, decimals, "up");
  const quoteAmount = mulDivUp(costUsdE8, 1n, QUOTE_UNIT_VALUE_USD_E8);
  const valueUsdE8 = quoteAmount * QUOTE_UNIT_VALUE_USD_E8;
  return { side: "buy", token, exit: false, tokenQuantity, quoteAmount, valueUsdE8, priceE8 };
}

function skipReason(leg: RebalanceLeg, minLegValueUsdE8: bigint): "below_minimum" | "zero_quantity" | null {
  if (leg.tokenQuantity === 0n || leg.quoteAmount === 0n) return "zero_quantity";
  if (leg.valueUsdE8 < minLegValueUsdE8) return "below_minimum";
  return null;
}

/**
 * The largest value each bought constituent can reach without exceeding its target weight of the projected
 * invested value, for the constituents that would exceed it.
 *
 * `planned` holds the value of every constituent if every buy went through. With `N` the sum of the values
 * that are not capped and `W` the weights that are, a capped constituent of weight `w` is held at
 * `floor(w * N / (10_000 - W))`, which is its target share of the resulting total. Capping lowers that total,
 * so the constituents are checked again until none exceeds its share: at most one round per constituent.
 */
function weightCaps(
  positions: readonly Tradable[],
  planned: ReadonlyMap<Address, bigint>,
  bought: ReadonlySet<Address>,
) {
  const capped = new Set<Address>();
  for (;;) {
    let uncappedValue = 0n;
    let cappedBps = 0n;
    for (const { token, targetWeightBps } of positions) {
      if (capped.has(token)) cappedBps += BigInt(targetWeightBps);
      else uncappedValue += planned.get(token) ?? 0n;
    }
    const uncappedBps = BPS - cappedBps;
    const over = positions.filter(
      ({ token, targetWeightBps }) =>
        bought.has(token) &&
        !capped.has(token) &&
        (planned.get(token) ?? 0n) * uncappedBps > BigInt(targetWeightBps) * uncappedValue,
    );
    if (over.length === 0) {
      // Rounds down: a capped constituent never exceeds its target share.
      return new Map(
        positions
          .filter(({ token }) => capped.has(token))
          .map(({ token, targetWeightBps }) => [
            token,
            mulDivDown(uncappedValue, BigInt(targetWeightBps), uncappedBps),
          ]),
      );
    }
    for (const { token } of over) capped.add(token);
  }
}

/** The quote amount a buy may spend at most: its pro rata share of the budget. */
interface BuyShare {
  readonly position: Tradable;
  readonly shareQuote: bigint;
}

/**
 * Each constituent below its target wants its shortfall. When the buys want more than the budget, each gets
 * its share pro rata.
 */
function buyShares(positions: readonly Tradable[], budgetQuote: bigint): BuyShare[] {
  const wanted = positions.flatMap((position) =>
    position.valueUsdE8 < position.targetValueUsdE8
      ? // Rounds down: a buy never takes a constituent above its target value.
        [{ position, wantedQuote: quoteUnitsDown(position.targetValueUsdE8 - position.valueUsdE8) }]
      : [],
  );
  const totalWanted = sum(wanted.map(({ wantedQuote }) => wantedQuote));
  return wanted.map(({ position, wantedQuote }) => ({
    position,
    // Rounds down: the scaled buys never sum to more than the budget.
    shareQuote: totalWanted > budgetQuote ? mulDivDown(wantedQuote, budgetQuote, totalWanted) : wantedQuote,
  }));
}

/**
 * Turns shares into buy legs and skips the ones that fail the minimum. The amount of a skipped buy is not
 * given to the others.
 *
 * With `valueAfterSells`, the value of every constituent after the proposed sells, the buys are also capped by
 * `weightCaps` so that none ends above its target weight. A cap can push a buy under the minimum; it is then
 * skipped and the caps are derived again, at most once per buy because the set of buys only shrinks.
 */
function sizeBuys(
  positions: readonly Tradable[],
  shares: readonly BuyShare[],
  minLegValueUsdE8: bigint,
  valueAfterSells: ReadonlyMap<Address, bigint> | null,
): { legs: RebalanceLeg[]; kept: readonly BuyShare[]; skipped: SkippedLeg[] } {
  const skipped: SkippedLeg[] = [];
  for (let active: readonly BuyShare[] = shares; ; ) {
    let caps = new Map<Address, bigint>();
    if (valueAfterSells !== null) {
      const planned = new Map(valueAfterSells);
      for (const { position, shareQuote } of active) {
        planned.set(position.token, (planned.get(position.token) ?? 0n) + shareQuote * QUOTE_UNIT_VALUE_USD_E8);
      }
      caps = weightCaps(positions, planned, new Set(active.map(({ position }) => position.token)));
    }
    const sized = active.map(({ position, shareQuote }) => {
      const cap = caps.get(position.token);
      // Rounds down: a capped buy stays at or under its cap. A cap at or under the current value leaves no room.
      const room =
        cap === undefined ? shareQuote : quoteUnitsDown(larger(cap, position.valueUsdE8) - position.valueUsdE8);
      const maxQuote = smaller(room, shareQuote);
      const leg = buyLeg(position, maxQuote);
      const failed = skipReason(leg, minLegValueUsdE8);
      const reason: SkippedLeg["reason"] | null =
        failed !== null && maxQuote < shareQuote ? "above_target_weight" : failed;
      return { position, shareQuote, leg, reason };
    });
    const kept = sized.filter(({ reason }) => reason === null);
    for (const { position, shareQuote, reason } of sized) {
      if (reason === null) continue;
      const valueUsdE8 = shareQuote * QUOTE_UNIT_VALUE_USD_E8;
      skipped.push({ side: "buy", token: position.token, exit: false, valueUsdE8, reason });
    }
    active = kept.map(({ position, shareQuote }) => ({ position, shareQuote }));
    // Without caps the buys do not depend on each other, so one pass settles them.
    if (kept.length === sized.length || valueAfterSells === null) {
      return { legs: kept.map(({ leg }) => leg), kept: active, skipped };
    }
  }
}

/** The constituents after `legs` are applied at their reference prices, valued and weighed as in a valuation. */
function project(positions: readonly Tradable[], legs: readonly RebalanceLeg[]) {
  const change = new Map(
    legs.map(({ side, token, tokenQuantity }) => [token, side === "sell" ? -tokenQuantity : tokenQuantity]),
  );
  const values = positions.map(({ token, balance, decimals, priceE8, targetWeightBps }) => {
    const projectedBalance = balance + (change.get(token) ?? 0n);
    const valueUsdE8 = positionValueUsdE8(projectedBalance, priceE8, decimals, "down");
    return { token, balance: projectedBalance, valueUsdE8, targetWeightBps };
  });
  const weights = apportionBps(values.map(({ valueUsdE8 }) => valueUsdE8));
  const projected = values.map((position, index) => {
    const weightBps = weights?.[index] ?? null;
    return { ...position, weightBps, driftBps: weightBps === null ? null : weightBps - position.targetWeightBps };
  });
  return {
    positions: projected,
    investedValueUsdE8: sum(values.map(({ valueUsdE8 }) => valueUsdE8)),
    maxAbsDriftBps: maxAbsDrift(projected),
  };
}

/**
 * A deployable value from which a first replication buys every constituent. A constituent of weight `w` gets
 * about `value * w / 10_000 * (10_000 - reserveBps) / 10_000`, which has to reach the minimum leg value plus
 * what rounding can take away: one base unit of the token and a few quote base units. Rounds up, and takes the
 * largest requirement over the constituents. It is sufficient, not the exact minimum.
 */
function minimumDeployableValue(
  positions: readonly Tradable[],
  reserveBps: number,
  minLegValueUsdE8: bigint,
  exitCount: number,
): bigint {
  const roundingUsdE8 = QUOTE_UNIT_VALUE_USD_E8 * BigInt(8 + exitCount);
  let minimum = 0n;
  for (const { priceE8, decimals, targetWeightBps } of positions) {
    const unitUsdE8 = positionValueUsdE8(1n, priceE8, decimals, "up");
    const legUsdE8 = minLegValueUsdE8 + unitUsdE8 + roundingUsdE8;
    const required = mulDivUp(legUsdE8, BPS * BPS, BigInt(targetWeightBps) * (BPS - BigInt(reserveBps)));
    minimum = larger(minimum, required);
  }
  return minimum;
}

/**
 * Computes the legs that move a wallet toward the target weights at reference prices. Every rule and rounding
 * direction is specified in `docs/architecture/calculation.md`.
 *
 * Tokens to exit are sold in full. Targets are shares of the deployable value. Buys share the budget pro rata
 * and the ones that fail the minimum are skipped. Sells are scaled to what those buys spend. When a buy was
 * skipped there is a second candidate, in which the other buys are capped at their target weight, and the
 * candidate with the lower projected maximum drift is returned. Every rounding leaves value unspent.
 *
 * Data-quality problems are returned, not thrown: a result with any blocker has status `blocked` and no legs.
 *
 * @throws {CalculationInputError} for the input errors of `valuePortfolio`, an unknown mode, a parameter out of
 * range, or a token to exit that is malformed, repeated or a constituent.
 */
export function planRebalance(input: RebalancePlanInput): RebalancePlanResult {
  const { mode } = input;
  if (mode !== "rebalance" && mode !== "buy_only") {
    throw new CalculationInputError("invalid_mode", `mode must be "rebalance" or "buy_only", received ${String(mode)}`);
  }
  const reserveBps = input.reserveBps ?? DEFAULT_RESERVE_BPS;
  const minLegValueUsdE8 = input.minLegValueUsdE8 ?? DEFAULT_MIN_LEG_VALUE_USD_E8;
  const depositUsdE8 = input.depositUsdE8 ?? 0n;
  checkBps(reserveBps, 0, MAX_RESERVE_BPS, "reserveBps");
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
    mode === "rebalance"
      ? valuation.outsideIndex.filter(({ token, balance }) => exitTokens.has(token) && balance > 0n)
      : [];

  const issues: CalculationIssue[] = [...valuation.issues];
  for (const { token, priceStatus, priceE8 } of exits) {
    const issue = priceIssue(token, priceStatus, priceE8, input.blockOnLastClose === true);
    if (issue !== null) issues.push(issue);
  }
  const warnings = issues.filter(({ severity }) => severity === "warning");
  const blocked = (blockers: CalculationIssue[]): BlockedPlan => ({ status: "blocked", blockers, warnings, valuation });
  const blockers = issues.filter(({ severity }) => severity === "blocker");
  const investedValueUsdE8 = valuation.investedValueUsdE8;
  if (blockers.length > 0 || investedValueUsdE8 === null) return blocked(blockers);

  const skipped: SkippedLeg[] = [];
  /** Keeps a sell that passes the minimum and records one that does not. */
  const proposed = (leg: RebalanceLeg, intendedValueUsdE8: bigint): boolean => {
    const reason = skipReason(leg, minLegValueUsdE8);
    if (reason === null) return true;
    skipped.push({ side: leg.side, token: leg.token, exit: leg.exit, valueUsdE8: intendedValueUsdE8, reason });
    return false;
  };

  // Without blockers every token to exit has a price above zero.
  const exitLegs = exits.flatMap(({ token, balance, decimals, priceE8 }) => {
    if (priceE8 === null) return [];
    const leg = sellLeg(token, true, balance, priceE8, decimals);
    return proposed(leg, leg.valueUsdE8) ? [leg] : [];
  });
  const exitProceedsQuote = sum(exitLegs.map(({ quoteAmount }) => quoteAmount));
  // Rounds down: a fraction of a quote base unit cannot be deposited, so it is not counted.
  const availableQuote = input.quoteBalance + quoteUnitsDown(depositUsdE8);
  // An exit that is skipped stays in the wallet, so its value is not deployable.
  const deployableValueUsdE8 =
    investedValueUsdE8 + availableQuote * QUOTE_UNIT_VALUE_USD_E8 + sum(exitLegs.map(({ valueUsdE8 }) => valueUsdE8));
  if (deployableValueUsdE8 === 0n) {
    return blocked([{ code: "zero_deployable_value", severity: "blocker", token: null }]);
  }

  // Without blockers every constituent has a price above zero and a value.
  const positions: Tradable[] = valuation.positions.flatMap((position) => {
    const { priceE8, valueUsdE8 } = position;
    if (priceE8 === null || valueUsdE8 === null) return [];
    // Rounds down: the targets never sum to more than the deployable value.
    const targetValueUsdE8 = mulDivDown(deployableValueUsdE8, BigInt(position.targetWeightBps), BPS);
    return [{ ...position, priceE8, valueUsdE8, targetValueUsdE8 }];
  });

  const fullSells = positions.flatMap((position) => {
    const { token, decimals, priceE8, valueUsdE8, targetValueUsdE8 } = position;
    if (mode !== "rebalance" || valueUsdE8 <= targetValueUsdE8) return [];
    const excessUsdE8 = valueUsdE8 - targetValueUsdE8;
    // Rounds down: a sell never takes a constituent below its target value.
    const leg = sellLeg(token, false, mulDivDown(excessUsdE8, 10n ** BigInt(decimals), priceE8), priceE8, decimals);
    return proposed(leg, excessUsdE8) ? [{ position, leg }] : [];
  });
  const fullProceedsQuote = sum(fullSells.map(({ leg }) => leg.quoteAmount));
  const keptBps = BPS - BigInt(reserveBps);
  const fundsQuote = availableQuote + exitProceedsQuote;
  // Rounds down: the reserve is never smaller than asked.
  const fullBudgetQuote = mulDivDown(fundsQuote + fullProceedsQuote, keptBps, BPS);
  const uncapped = sizeBuys(positions, buyShares(positions, fullBudgetQuote), minLegValueUsdE8, null);

  if (investedValueUsdE8 === 0n && uncapped.legs.length < positions.length) {
    const minimumDeployableValueUsdE8 = minimumDeployableValue(positions, reserveBps, minLegValueUsdE8, exits.length);
    return blocked([
      { code: "below_minimum_portfolio_value", severity: "blocker", token: null, minimumDeployableValueUsdE8 },
    ]);
  }

  // Rounds up: the proceeds needed are the smallest amount whose share after the reserve covers the buys.
  const neededFundsQuote = mulDivUp(sum(uncapped.legs.map(({ quoteAmount }) => quoteAmount)), BPS, keptBps);
  const neededProceedsQuote = neededFundsQuote > fundsQuote ? neededFundsQuote - fundsQuote : 0n;
  let sellLegs = fullSells.map(({ leg }) => leg);
  if (neededProceedsQuote === 0n) {
    for (const { leg } of fullSells) {
      skipped.push({ side: "sell", token: leg.token, exit: false, valueUsdE8: leg.valueUsdE8, reason: "not_needed" });
    }
    sellLegs = [];
  } else if (neededProceedsQuote < fullProceedsQuote) {
    // Rounding a scaled sell down loses less than one quote base unit, so together the sells lose at most one
    // unit fewer than there are sells. Aiming that much higher makes them raise at least what is needed.
    const goalQuote = neededProceedsQuote + BigInt(fullSells.length) - 1n;
    const floorUsdE8 = larger(minLegValueUsdE8, QUOTE_UNIT_VALUE_USD_E8);
    sellLegs = fullSells.map(({ position, leg }) => {
      const { token, decimals, priceE8 } = position;
      // Both round up, and neither exceeds the full sell: together the scaled sells raise at least what the
      // buys need, and each stays a leg that passes the minimum.
      const scaled = mulDivUp(leg.tokenQuantity, goalQuote, fullProceedsQuote);
      const smallest = mulDivUp(floorUsdE8, 10n ** BigInt(decimals), priceE8);
      return sellLeg(token, false, smaller(larger(scaled, smallest), leg.tokenQuantity), priceE8, decimals);
    });
  }
  const sells = [...exitLegs, ...sellLegs];
  const proceedsQuote = sum(sells.map(({ quoteAmount }) => quoteAmount));

  // The sells are final here. The first candidate is the buys as they are. When a buy was skipped there is a
  // second one, whose buys are capped against the values the sells leave.
  const candidate = (name: RebalancePlan["candidate"], buys: RebalanceLeg[], skips: SkippedLeg[]) => {
    const projection = project(positions, [...sells, ...buys]);
    const spentQuote = sum(buys.map(({ quoteAmount }) => quoteAmount));
    return { name, buys, skips, projection, spentQuote, driftBps: projection.maxAbsDriftBps ?? TOTAL_WEIGHT_BPS + 1 };
  };
  let chosen = candidate("uncapped", uncapped.legs, uncapped.skipped);
  let otherCandidateMaxAbsDriftBps: number | null = null;
  if (uncapped.skipped.length > 0) {
    const afterSells = new Map(project(positions, sells).positions.map(({ token, valueUsdE8 }) => [token, valueUsdE8]));
    const capped = sizeBuys(positions, uncapped.kept, minLegValueUsdE8, afterSells);
    const other = candidate("capped", capped.legs, [...uncapped.skipped, ...capped.skipped]);
    // The lower projected maximum drift wins. On a tie, a call that carries a deposit takes the candidate
    // that leaves less of it uninvested, and any other call the candidate that trades less. A cap only ever
    // lowers a buy, so the capped candidate never spends more: it is the one that trades less, and with a
    // deposit it wins only when it spends as much as the other.
    const tie = other.driftBps === chosen.driftBps;
    const cappedWins =
      other.driftBps < chosen.driftBps || (tie && (depositUsdE8 === 0n || other.spentQuote >= chosen.spentQuote));
    otherCandidateMaxAbsDriftBps = (cappedWins ? chosen : other).projection.maxAbsDriftBps;
    if (cappedWins) chosen = other;
  }
  const { spentQuote } = chosen;
  const buyBudgetQuote = mulDivDown(availableQuote + proceedsQuote, keptBps, BPS);
  const legs = inExecutionOrder([...sells, ...chosen.buys]);

  const currentMaxAbsDriftBps = maxAbsDrift(valuation.positions);
  const projectedMaxAbsDriftBps = chosen.projection.maxAbsDriftBps;
  // A first replication has no drift yet: it is compared against the target itself, a drift of zero.
  if (projectedMaxAbsDriftBps !== null && projectedMaxAbsDriftBps > (currentMaxAbsDriftBps ?? 0)) {
    warnings.push({
      code: "projected_drift_increase",
      severity: "warning",
      token: null,
      currentMaxAbsDriftBps,
      projectedMaxAbsDriftBps,
    });
  }
  // What the buys leave of their budget is uninvested on top of the reserve.
  const uninvestedQuote = buyBudgetQuote - spentQuote;
  if (uninvestedQuote * QUOTE_UNIT_VALUE_USD_E8 > minLegValueUsdE8) {
    warnings.push({ code: "uninvested_quote", severity: "warning", token: null, uninvestedQuote });
  } else if (legs.length === 0) {
    warnings.push({ code: "nothing_to_do", severity: "warning", token: null });
  }

  return {
    status: "ready",
    warnings,
    valuation,
    mode,
    reserveBps,
    minLegValueUsdE8,
    deployableValueUsdE8,
    availableQuote,
    buyBudgetQuote,
    targets: positions.map(({ token, targetWeightBps, valueUsdE8, targetValueUsdE8 }) => ({
      token,
      targetWeightBps,
      currentValueUsdE8: valueUsdE8,
      targetValueUsdE8,
      deltaUsdE8: targetValueUsdE8 - valueUsdE8,
    })),
    legs,
    skipped: inExecutionOrder([...skipped, ...chosen.skips]),
    currentMaxAbsDriftBps,
    candidate: chosen.name,
    otherCandidateMaxAbsDriftBps,
    projected: { ...chosen.projection, quoteBalance: availableQuote + proceedsQuote - spentQuote },
  };
}
