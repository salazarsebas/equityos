/**
 * Portfolio valuation and drift of `equityos.calc/1`.
 *
 * Turns the constituents of a published index version, the holdings of one wallet and reference prices into
 * values, current weights and drift. Everything is integer arithmetic on `bigint`; nothing reads a chain, a
 * file or a clock.
 *
 * Units: balances are token base units, prices are USD per whole token scaled by 1e8, values are USD scaled by
 * 1e8, weights and drift are basis points. Reference prices are indications of value, not prices a trade will
 * execute at.
 */

import { BPS, mulDivDown } from "./fixed-point.ts";
import { MAX_TOKEN_DECIMALS, positionValueUsdE8, USD_E8 } from "./position-value.ts";
import { type Address, isAddress, MAX_CONSTITUENTS, TOTAL_WEIGHT_BPS } from "./spec.ts";
import type { StalenessStatus } from "./staleness.ts";

/** Decimals of the quote asset (USDC). */
export const QUOTE_DECIMALS = 6;

/**
 * Stated assumption: one whole unit of the quote asset is valued at exactly 1 USD. The quote asset has no
 * reference price input, so a depeg is not visible to this calculation.
 */
export const QUOTE_PRICE_E8 = USD_E8;

/** Value of one base unit of the quote asset in USD scaled by 1e8: `QUOTE_PRICE_E8 / 10^QUOTE_DECIMALS`. */
export const QUOTE_UNIT_VALUE_USD_E8 = 100n;

export type CalculationInputErrorCode =
  | "invalid_address"
  | "duplicate_token"
  | "negative_amount"
  /** A balance, price or value that is not a `bigint`. */
  | "invalid_amount"
  /** More constituents than `MAX_CONSTITUENTS`. */
  | "too_many_constituents"
  /** A plan mode that is not `rebalance` or `buy_only`. */
  | "invalid_mode"
  | "invalid_decimals"
  /** No constituent, a weight outside `[1, 10_000]`, or weights that do not sum to 10_000. */
  | "invalid_weights"
  /** A basis point parameter that is not an integer in its range, such as a reserve above `MAX_RESERVE_BPS`. */
  | "invalid_bps"
  /** A time or duration that is not a non-negative safe integer of seconds. */
  | "invalid_time"
  /** A token listed to exit that is a constituent of the target version. */
  | "exit_token_is_constituent";

/**
 * Thrown for inputs no correct caller produces. Data-quality problems (a missing or unusable price, a decimals
 * disagreement, nothing to deploy) are never thrown: they are returned as `CalculationIssue` values.
 */
export class CalculationInputError extends RangeError {
  readonly code: CalculationInputErrorCode;

  constructor(code: CalculationInputErrorCode, message: string) {
    super(message);
    this.name = "CalculationInputError";
    this.code = code;
  }
}

/** A constituent of the target index version, with the token decimals recorded for it in the asset list. */
export interface TargetConstituent {
  readonly token: Address;
  /** Target weight in basis points, an integer in `[1, 10_000]`. The weights of an index sum to 10_000. */
  readonly weightBps: number;
  readonly decimals: number;
}

/** A token balance of the wallet, with the decimals the token reports. */
export interface Holding {
  readonly token: Address;
  /** Token base units. */
  readonly balance: bigint;
  readonly decimals: number;
}

/**
 * A reference price with its staleness class. Prices come from outside the calculation: a `status` that is
 * absent or not one of the four classes is read as `unavailable`, and `priceE8` is then never read.
 */
export interface ReferencePrice {
  readonly token: Address;
  /** USD per whole token scaled by 1e8. */
  readonly priceE8: bigint;
  readonly status: StalenessStatus;
}

export interface PortfolioInput {
  readonly constituents: readonly TargetConstituent[];
  /** Any order. A constituent without an entry has a balance of zero. */
  readonly holdings: readonly Holding[];
  /** Any order. A token without an entry has no price. */
  readonly prices: readonly ReferencePrice[];
  /** Quote asset balance counted toward this replication, in base units of `QUOTE_DECIMALS` decimals. */
  readonly quoteBalance: bigint;
  /**
   * Makes a `last_close` price a blocker instead of a warning. Defaults to `false`: the calculation reports a
   * closed market and the layer above decides whether to act on it.
   */
  readonly blockOnLastClose?: boolean;
}

/** The staleness class of a price, or `missing` when no price was supplied for the token. */
export type PriceStatus = StalenessStatus | "missing";

/** A finding about the price or the decimals of one token. */
export interface TokenIssue {
  readonly code: /** No price was supplied for a token the calculation needs. */
    | "missing_price"
    /** The price has status `unavailable`, or a status that is not a known class: there is no usable value. */
    | "price_unavailable"
    /** The price is zero, which no listed token has. */
    | "zero_price"
    /** A holding reports different decimals than the constituent it is matched with. */
    | "decimals_mismatch"
    /** The price has status `last_close`: the market is closed and execution prices will differ. */
    | "market_closed"
    /** The price has status `delayed`. */
    | "price_delayed";
  readonly severity: "blocker" | "warning";
  readonly token: Address;
}

/** There is nothing to deploy: no constituent value, no quote asset and no proceeds from exits. */
export interface ZeroDeployableValueIssue {
  readonly code: "zero_deployable_value";
  readonly severity: "blocker";
  readonly token: null;
}

/**
 * A first replication that cannot buy every constituent, because a buy is below the minimum leg value or rounds
 * to zero base units. Buying only some constituents would not replicate the index, so nothing is proposed.
 */
export interface BelowMinimumPortfolioValueIssue {
  readonly code: "below_minimum_portfolio_value";
  readonly severity: "blocker";
  readonly token: null;
  /** A deployable value from which every constituent gets a buy leg with the same reserve and minimum. */
  readonly minimumDeployableValueUsdE8: bigint;
}

/** The projected maximum drift is above the current one. A first replication is compared against zero. */
export interface ProjectedDriftIncreaseIssue {
  readonly code: "projected_drift_increase";
  readonly severity: "warning";
  readonly token: null;
  /** Maximum absolute drift before the plan, or `null` when nothing is invested. */
  readonly currentMaxAbsDriftBps: number | null;
  readonly projectedMaxAbsDriftBps: number;
}

/**
 * The plan leaves more than the minimum leg value in the quote asset on top of the reserve: buys were skipped
 * or capped, or a sale raised more than the buys spend.
 */
export interface UninvestedQuoteIssue {
  readonly code: "uninvested_quote";
  readonly severity: "warning";
  readonly token: null;
  /** Quote base units left on top of the reserve: the buy budget less what the buys spend. */
  readonly uninvestedQuote: bigint;
}

/** The plan has no leg and leaves nothing to invest: every difference to the target is below the minimum. */
export interface NothingToDoIssue {
  readonly code: "nothing_to_do";
  readonly severity: "warning";
  readonly token: null;
}

/** A finding returned as data. A blocker prevents a plan. */
export type CalculationIssue =
  | TokenIssue
  | UninvestedQuoteIssue
  | NothingToDoIssue
  | ZeroDeployableValueIssue
  | BelowMinimumPortfolioValueIssue
  | ProjectedDriftIncreaseIssue;

export type CalculationIssueCode = CalculationIssue["code"];

/** A constituent of the index as held by the wallet. */
export interface PositionValuation {
  readonly token: Address;
  /** Token base units, zero when the wallet has no holding of the constituent. */
  readonly balance: bigint;
  readonly decimals: number;
  readonly targetWeightBps: number;
  /** The reference price, or `null` when it is missing or `unavailable`. */
  readonly priceE8: bigint | null;
  readonly priceStatus: PriceStatus;
  /** `floor(balance * priceE8 / 10^decimals)`, or `null` without a usable price or with a decimals mismatch. */
  readonly valueUsdE8: bigint | null;
  /** Share of `investedValueUsdE8` in basis points, or `null` when that value is unknown or zero. */
  readonly weightBps: number | null;
}

/** A token the wallet holds that is not a constituent. It takes no part in any total, weight or drift. */
export interface OutsideHolding {
  readonly token: Address;
  readonly balance: bigint;
  readonly decimals: number;
  readonly priceE8: bigint | null;
  readonly priceStatus: PriceStatus;
  /** Value at the reference price, or `null` without a usable price. */
  readonly valueUsdE8: bigint | null;
}

export interface PortfolioValuation {
  /** One entry per constituent, in ascending token order. */
  readonly positions: readonly PositionValuation[];
  /** Holdings outside the index, in ascending token order. */
  readonly outsideIndex: readonly OutsideHolding[];
  /** Sum of the constituent values: the denominator of every weight. `null` when a value is unknown. */
  readonly investedValueUsdE8: bigint | null;
  readonly quoteBalance: bigint;
  /** `quoteBalance * QUOTE_UNIT_VALUE_USD_E8`, exact. */
  readonly quoteValueUsdE8: bigint;
  /** The assumed price of the quote asset, always `QUOTE_PRICE_E8`. */
  readonly quotePriceE8: bigint;
  /** `investedValueUsdE8 + quoteValueUsdE8`, or `null` when the invested value is unknown. */
  readonly deployableValueUsdE8: bigint | null;
  /**
   * Uninvested share: `floor(quoteValueUsdE8 * 10_000 / deployableValueUsdE8)`, or `null` when the deployable
   * value is unknown or zero. It is not a constituent weight and is not part of the 10_000 they sum to.
   */
  readonly cashShareBps: number | null;
  /** Blockers and warnings, constituents in ascending token order. */
  readonly issues: readonly TokenIssue[];
}

function fail(code: CalculationInputErrorCode, message: string): never {
  throw new CalculationInputError(code, message);
}

/** @throws {CalculationInputError} if `token` is not a lowercase address or is already in `seen`. */
export function checkToken(token: string, seen: Set<string>, where: string): void {
  if (!isAddress(token)) fail("invalid_address", `${where}: ${token} is not a lowercase address`);
  if (seen.has(token)) fail("duplicate_token", `${where}: ${token} is repeated`);
  seen.add(token);
}

/** @throws {CalculationInputError} if `value` is not a `bigint` or is negative. */
export function checkAmount(value: bigint, name: string): void {
  // The type says bigint; a caller outside TypeScript can still pass a number, which must not reach the arithmetic.
  if (typeof value !== "bigint") fail("invalid_amount", `${name} must be a bigint`);
  if (value < 0n) fail("negative_amount", `${name} must not be negative, received ${value}`);
}

/** @throws {CalculationInputError} if `value` is not an integer in `[min, max]`. */
export function checkBps(value: number, min: number, max: number, name: string): void {
  if (!Number.isInteger(value) || value < min || value > max) {
    fail("invalid_bps", `${name} must be an integer between ${min} and ${max}, received ${value}`);
  }
}

/** True for the statuses whose price is a value: `live`, `delayed` and `last_close`. Anything else is not. */
function isUsableStatus(status: unknown): status is "live" | "delayed" | "last_close" {
  return status === "live" || status === "delayed" || status === "last_close";
}

function checkDecimals(decimals: number, where: string): void {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > MAX_TOKEN_DECIMALS) {
    fail("invalid_decimals", `${where}: decimals must be an integer between 0 and ${MAX_TOKEN_DECIMALS}`);
  }
}

function checkPortfolioInput(input: PortfolioInput): void {
  if (input.constituents.length === 0) fail("invalid_weights", "at least one constituent is required");
  if (input.constituents.length > MAX_CONSTITUENTS) {
    fail("too_many_constituents", `an index has at most ${MAX_CONSTITUENTS} constituents`);
  }
  const constituents = new Set<string>();
  let totalBps = 0;
  for (const { token, weightBps, decimals } of input.constituents) {
    checkToken(token, constituents, "constituents");
    checkDecimals(decimals, `constituent ${token}`);
    if (!Number.isInteger(weightBps) || weightBps < 1 || weightBps > TOTAL_WEIGHT_BPS) {
      fail("invalid_weights", `constituent ${token}: weight must be an integer between 1 and ${TOTAL_WEIGHT_BPS}`);
    }
    totalBps += weightBps;
  }
  if (totalBps !== TOTAL_WEIGHT_BPS) fail("invalid_weights", `weights sum to ${totalBps}, not ${TOTAL_WEIGHT_BPS}`);
  const holdings = new Set<string>();
  for (const { token, balance, decimals } of input.holdings) {
    checkToken(token, holdings, "holdings");
    checkDecimals(decimals, `holding ${token}`);
    checkAmount(balance, `balance of ${token}`);
  }
  const prices = new Set<string>();
  for (const { token, priceE8, status } of input.prices) {
    checkToken(token, prices, "prices");
    // A price that is not usable is a blocker whatever it holds, so its amount is not read.
    if (isUsableStatus(status)) checkAmount(priceE8, `price of ${token}`);
  }
  checkAmount(input.quoteBalance, "quoteBalance");
}

/** A copy of `items` in ascending token order, the order of every output list. */
export function byToken<T extends { readonly token: Address }>(items: readonly T[]): T[] {
  // Lowercase hexadecimal strings of equal length order the same way as the addresses they encode.
  return [...items].sort((a, b) => (a.token < b.token ? -1 : a.token > b.token ? 1 : 0));
}

/**
 * Splits 10_000 bps in proportion to `values`.
 *
 * Each value gets `floor(value * 10_000 / total)` bps. The basis points still missing, fewer than the number
 * of values, are given one each by largest remainder `value * 10_000 mod total`, ties broken by position.
 * Callers pass values in ascending token order, so a tie goes to the lower address. The result sums to exactly
 * 10_000. Returns `null` when the total is zero, because no share is defined.
 */
export function apportionBps(values: readonly bigint[]): number[] | null {
  const total = values.reduce((sum, value) => sum + value, 0n);
  if (total === 0n) return null;
  // Rounds down: the basis points lost here are the ones handed out by largest remainder.
  const shares = values.map((value, index) => ({
    index,
    bps: mulDivDown(value, BPS, total),
    remainder: (value * BPS) % total,
  }));
  const missing = BPS - shares.reduce((sum, { bps }) => sum + bps, 0n);
  const ranked = [...shares].sort((a, b) =>
    a.remainder > b.remainder ? -1 : a.remainder < b.remainder ? 1 : a.index - b.index,
  );
  const raised = new Set(ranked.slice(0, Number(missing)).map(({ index }) => index));
  return shares.map(({ index, bps }) => Number(bps) + (raised.has(index) ? 1 : 0));
}

/** The finding a price leads to, or `null` for a usable `live` price. */
export function priceIssue(
  token: Address,
  status: PriceStatus,
  priceE8: bigint | null,
  blockOnLastClose: boolean,
): TokenIssue | null {
  if (status === "missing") return { code: "missing_price", severity: "blocker", token };
  if (status === "unavailable") return { code: "price_unavailable", severity: "blocker", token };
  if (priceE8 === 0n) return { code: "zero_price", severity: "blocker", token };
  if (status === "last_close") {
    return { code: "market_closed", severity: blockOnLastClose ? "blocker" : "warning", token };
  }
  if (status === "delayed") return { code: "price_delayed", severity: "warning", token };
  return null;
}

/**
 * The price to show for a token. Only the three usable statuses carry a value: an `unavailable` price, and a
 * price whose status is absent or unknown, is reported as `unavailable` without a number.
 */
function readPrice(price: ReferencePrice | undefined): { priceE8: bigint | null; priceStatus: PriceStatus } {
  if (price === undefined) return { priceE8: null, priceStatus: "missing" };
  if (!isUsableStatus(price.status)) return { priceE8: null, priceStatus: "unavailable" };
  return { priceE8: price.priceE8, priceStatus: price.status };
}

/**
 * Values a wallet against an index version.
 *
 * The denominator of every weight is the invested value: the sum of the constituent values, without the quote
 * asset and without tokens outside the index. The quote asset is reported next to it as cash to deploy, and
 * `deployableValueUsdE8` is the sum of both. Position values round down, and weights follow `apportionBps`, so
 * they sum to exactly 10_000 whenever the invested value is above zero.
 *
 * A constituent needs a usable price even when its balance is zero. When a constituent has no usable price or
 * mismatched decimals, the totals and every weight are `null`; the values of the other constituents are still
 * returned.
 *
 * @throws {CalculationInputError} for malformed or repeated addresses, negative amounts, decimals out of range
 * or weights that are not a valid composition.
 */
export function valuePortfolio(input: PortfolioInput): PortfolioValuation {
  checkPortfolioInput(input);
  const prices = new Map(input.prices.map((price) => [price.token, price]));
  const holdings = new Map(input.holdings.map((holding) => [holding.token, holding]));
  const issues: TokenIssue[] = [];
  const blockOnLastClose = input.blockOnLastClose === true;

  const valued = byToken(input.constituents).map((constituent) => {
    const { token, decimals } = constituent;
    const holding = holdings.get(token);
    const { priceE8, priceStatus } = readPrice(prices.get(token));
    const issue = priceIssue(token, priceStatus, priceE8, blockOnLastClose);
    if (issue !== null) issues.push(issue);
    const mismatch = holding !== undefined && holding.decimals !== decimals;
    if (mismatch) issues.push({ code: "decimals_mismatch", severity: "blocker", token });
    const balance = holding?.balance ?? 0n;
    // A `last_close` price is a published value: it values the position even when it blocks a plan.
    const unusable = priceE8 === null || priceE8 === 0n || mismatch;
    // Rounds down: a position is never shown as worth more than its balance at the reference price.
    const valueUsdE8 = unusable ? null : positionValueUsdE8(balance, priceE8, decimals, "down");
    return { token, balance, decimals, targetWeightBps: constituent.weightBps, priceE8, priceStatus, valueUsdE8 };
  });

  const values = valued.flatMap(({ valueUsdE8 }) => (valueUsdE8 === null ? [] : [valueUsdE8]));
  const complete = values.length === valued.length;
  const weights = complete ? apportionBps(values) : null;
  const positions = valued.map((position, index) => ({ ...position, weightBps: weights?.[index] ?? null }));

  const constituentTokens = new Set<string>(valued.map(({ token }) => token));
  const outsideIndex = byToken(input.holdings.filter(({ token }) => !constituentTokens.has(token))).map(
    ({ token, balance, decimals }) => {
      const { priceE8, priceStatus } = readPrice(prices.get(token));
      const usable = priceE8 !== null && priceE8 > 0n;
      const valueUsdE8 = usable ? positionValueUsdE8(balance, priceE8, decimals, "down") : null;
      return { token, balance, decimals, priceE8, priceStatus, valueUsdE8 };
    },
  );

  const investedValueUsdE8 = complete ? values.reduce((sum, value) => sum + value, 0n) : null;
  const quoteValueUsdE8 = input.quoteBalance * QUOTE_UNIT_VALUE_USD_E8;
  const deployableValueUsdE8 = investedValueUsdE8 === null ? null : investedValueUsdE8 + quoteValueUsdE8;
  // Rounds down: the uninvested share is a single displayed ratio, never above the exact one.
  const cashShareBps =
    deployableValueUsdE8 === null || deployableValueUsdE8 === 0n
      ? null
      : Number(mulDivDown(quoteValueUsdE8, BPS, deployableValueUsdE8));

  return {
    positions,
    outsideIndex,
    investedValueUsdE8,
    quoteBalance: input.quoteBalance,
    quoteValueUsdE8,
    quotePriceE8: QUOTE_PRICE_E8,
    deployableValueUsdE8,
    cashShareBps,
    issues,
  };
}

/** Drift of one constituent. */
export interface ConstituentDrift {
  readonly token: Address;
  readonly currentWeightBps: number;
  readonly targetWeightBps: number;
  /** `currentWeightBps - targetWeightBps`: positive when the constituent is above its target weight. */
  readonly driftBps: number;
}

export interface DriftReport {
  /** One entry per constituent, in ascending token order. */
  readonly constituents: readonly ConstituentDrift[];
  /** Largest absolute drift of a constituent. */
  readonly maxAbsDriftBps: number;
  /** The constituent with the largest absolute drift, the lowest address on a tie. */
  readonly maxDriftToken: Address;
  /**
   * Half the sum of the absolute drifts: the share of the invested value that has to change hands to reach
   * the target weights. Current and target weights both sum to 10_000, so the sum is even and the half exact.
   */
  readonly turnoverBps: number;
  readonly driftThresholdBps: number;
  /**
   * `maxAbsDriftBps >= driftThresholdBps`. The spec defines the threshold as the deviation that makes a
   * rebalance due, so a drift equal to the threshold reaches it.
   */
  readonly thresholdReached: boolean;
}

/** The part of a position that drift is computed from. */
export interface WeightedPosition {
  readonly token: Address;
  readonly targetWeightBps: number;
  readonly weightBps: number | null;
}

/**
 * Drift of each constituent against its target weight.
 *
 * Returns `null` when the current weights are not defined: a constituent has no value, or the invested value
 * is zero. Zero is never substituted for an undefined weight.
 *
 * @param positions constituents in ascending token order, as returned by `valuePortfolio`
 * @param driftThresholdBps `rebalance.driftThresholdBps` of the spec, an integer in `[1, 10_000]`
 * @throws {CalculationInputError} if the threshold is out of range.
 */
export function computeDrift(positions: readonly WeightedPosition[], driftThresholdBps: number): DriftReport | null {
  checkBps(driftThresholdBps, 1, TOTAL_WEIGHT_BPS, "driftThresholdBps");
  const constituents: ConstituentDrift[] = [];
  for (const { token, targetWeightBps, weightBps } of positions) {
    if (weightBps === null) return null;
    constituents.push({ token, currentWeightBps: weightBps, targetWeightBps, driftBps: weightBps - targetWeightBps });
  }
  let widest: ConstituentDrift | undefined;
  let absoluteSumBps = 0;
  for (const drift of constituents) {
    absoluteSumBps += Math.abs(drift.driftBps);
    if (widest === undefined || Math.abs(drift.driftBps) > Math.abs(widest.driftBps)) widest = drift;
  }
  if (widest === undefined) return null;
  const maxAbsDriftBps = Math.abs(widest.driftBps);
  return {
    constituents,
    maxAbsDriftBps,
    maxDriftToken: widest.token,
    // An integer shift, not a division: the sum is even for weights that both sum to 10_000.
    turnoverBps: absoluteSumBps >> 1,
    driftThresholdBps,
    thresholdReached: maxAbsDriftBps >= driftThresholdBps,
  };
}
