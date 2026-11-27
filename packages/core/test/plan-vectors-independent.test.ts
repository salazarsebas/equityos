/**
 * An independent implementation of `planRebalance`, written only from docs/architecture/calculation.md.
 *
 * It imports nothing from `packages/core/src`: the arithmetic, the valuation, the findings, the two candidates
 * and the projection are all recomputed here from the specification. Every published vector in
 * `packages/core/vectors/rebalance-plans.json` is recomputed from its `input` and compared with its whole
 * `expected` object, every bigint serialized as a decimal string. Amounts are bigints throughout: no floating
 * point touches a balance, a price, a value or a quote amount.
 */
import { describe, expect, test } from "bun:test";
import planVectors from "../vectors/rebalance-plans.json" with { type: "json" };

// ---------------------------------------------------------------------------------------------------------------
// Integer helpers. Every operand is non-negative; a negative one is a bug in this file and throws.
// ---------------------------------------------------------------------------------------------------------------

function assertNonNegative(...values: bigint[]): void {
  for (const value of values) {
    if (value < 0n) throw new Error(`negative operand ${value}`);
  }
}

/** floor(a * b / c), rounding toward zero, which is down for non-negative operands. */
function mulDivFloor(a: bigint, b: bigint, c: bigint): bigint {
  assertNonNegative(a, b, c);
  return (a * b) / c;
}

/** ceil(a * b / c), rounding up: the smallest integer at least the exact quotient. */
function mulDivCeil(a: bigint, b: bigint, c: bigint): bigint {
  assertNonNegative(a, b, c);
  return (a * b + c - 1n) / c;
}

/** ceil(a / b), rounding up. */
function divCeil(a: bigint, b: bigint): bigint {
  return mulDivCeil(a, 1n, b);
}

function pow10(decimals: number): bigint {
  return 10n ** BigInt(decimals);
}

function maxBig(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}

function minBig(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

const BPS = 10_000n;
/** One quote base unit is worth 100 units of USD scaled by 1e8 (one whole quote unit is exactly 1 USD). */
const QUOTE_UNIT_USD_E8 = 100n;
const QUOTE_PRICE_E8 = 100_000_000n;

// ---------------------------------------------------------------------------------------------------------------
// Input.
// ---------------------------------------------------------------------------------------------------------------

type Mode = "rebalance" | "buy_only";

interface Constituent {
  readonly token: string;
  readonly weightBps: number;
  readonly decimals: number;
}

interface Holding {
  readonly token: string;
  readonly balance: bigint;
  readonly decimals: number;
}

interface PriceEntry {
  readonly token: string;
  readonly priceE8: bigint;
  readonly status: string | undefined;
}

interface PlanInput {
  readonly mode: Mode;
  readonly constituents: readonly Constituent[];
  readonly holdings: readonly Holding[];
  readonly prices: readonly PriceEntry[];
  readonly quoteBalance: bigint;
  readonly depositUsdE8: bigint;
  readonly exitTokens: readonly string[];
  readonly reserveBps: number;
  readonly minLegValueUsdE8: bigint;
  readonly blockOnLastClose: boolean;
}

type RawInput = (typeof planVectors.vectors)[number]["input"];

/** Reads a vector input and applies the defaults of the specification to every absent optional property. */
function parseInput(raw: RawInput): PlanInput {
  if (raw.mode !== "rebalance" && raw.mode !== "buy_only") throw new Error(`${raw.mode} is not a mode`);
  return {
    mode: raw.mode,
    constituents: raw.constituents.map(({ token, weightBps, decimals }) => ({ token, weightBps, decimals })),
    holdings: raw.holdings.map(({ token, balance, decimals }) => ({ token, balance: BigInt(balance), decimals })),
    prices: raw.prices.map((entry) => ({
      token: entry.token,
      priceE8: BigInt(entry.priceE8),
      status: "status" in entry && typeof entry.status === "string" ? entry.status : undefined,
    })),
    quoteBalance: BigInt(raw.quoteBalance),
    depositUsdE8: raw.depositUsdE8 === undefined ? 0n : BigInt(raw.depositUsdE8),
    exitTokens: raw.exitTokens ?? [],
    reserveBps: raw.reserveBps ?? 50,
    minLegValueUsdE8: raw.minLegValueUsdE8 === undefined ? 100_000_000n : BigInt(raw.minLegValueUsdE8),
    blockOnLastClose: raw.blockOnLastClose ?? false,
  };
}

function byToken<T extends { readonly token: string }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => (a.token < b.token ? -1 : a.token > b.token ? 1 : 0));
}

// ---------------------------------------------------------------------------------------------------------------
// Findings and prices.
// ---------------------------------------------------------------------------------------------------------------

type Severity = "blocker" | "warning";

interface Finding {
  readonly code: string;
  readonly severity: Severity;
  readonly token: string | null;
  readonly [extra: string]: unknown;
}

const VALUED_STATUSES = new Set(["live", "delayed", "last_close"]);

interface ResolvedPrice {
  /** The published `priceE8`, or `null` when the status does not allow it to be read. */
  readonly shownPriceE8: bigint | null;
  readonly status: string;
  /** The price a value can be computed with: a valued status and above zero. */
  readonly usablePriceE8: bigint | null;
  readonly findings: Finding[];
}

function resolvePrice(
  prices: ReadonlyMap<string, PriceEntry>,
  token: string,
  blockOnLastClose: boolean,
): ResolvedPrice {
  const entry = prices.get(token);
  if (entry === undefined) {
    return {
      shownPriceE8: null,
      status: "missing",
      usablePriceE8: null,
      findings: [{ code: "missing_price", severity: "blocker", token }],
    };
  }
  if (entry.status === undefined || !VALUED_STATUSES.has(entry.status)) {
    return {
      shownPriceE8: null,
      status: "unavailable",
      usablePriceE8: null,
      findings: [{ code: "price_unavailable", severity: "blocker", token }],
    };
  }
  const findings: Finding[] = [];
  if (entry.priceE8 === 0n) findings.push({ code: "zero_price", severity: "blocker", token });
  if (entry.status === "last_close") {
    findings.push({ code: "market_closed", severity: blockOnLastClose ? "blocker" : "warning", token });
  }
  if (entry.status === "delayed") findings.push({ code: "price_delayed", severity: "warning", token });
  return {
    shownPriceE8: entry.priceE8,
    status: entry.status,
    usablePriceE8: entry.priceE8 > 0n ? entry.priceE8 : null,
    findings,
  };
}

/** floor(balance * priceE8 / 10^decimals): a position is never shown as worth more than its balance is. */
function positionValue(balance: bigint, priceE8: bigint, decimals: number): bigint {
  return mulDivFloor(balance, priceE8, pow10(decimals));
}

/**
 * Weights in bps of `values` against their sum: floor first, then the missing basis points one each by largest
 * remainder, ties by ascending token. `values` is in ascending token order. `null` when the sum is zero.
 */
function weightsOf(values: readonly bigint[]): (number | null)[] {
  const total = values.reduce((sum, value) => sum + value, 0n);
  if (total === 0n) return values.map(() => null);
  const floors = values.map((value) => mulDivFloor(value, BPS, total));
  const remainders = values.map((value) => (value * BPS) % total);
  let missing = BPS - floors.reduce((sum, value) => sum + value, 0n);
  const order = values.map((_, index) => index);
  // Stable sort: equal remainders keep ascending token order.
  order.sort((a, b) => {
    const ra = remainders[a] ?? 0n;
    const rb = remainders[b] ?? 0n;
    return ra > rb ? -1 : ra < rb ? 1 : 0;
  });
  const weights = [...floors];
  for (const index of order) {
    if (missing === 0n) break;
    weights[index] = (weights[index] ?? 0n) + 1n;
    missing -= 1n;
  }
  return weights.map((weight) => Number(weight));
}

function maxAbsDrift(weights: readonly (number | null)[], targets: readonly number[]): number | null {
  let max = 0;
  for (const [index, weight] of weights.entries()) {
    if (weight === null) return null;
    max = Math.max(max, Math.abs(weight - (targets[index] ?? 0)));
  }
  return max;
}

// ---------------------------------------------------------------------------------------------------------------
// Valuation.
// ---------------------------------------------------------------------------------------------------------------

interface Position {
  readonly token: string;
  readonly balance: bigint;
  readonly decimals: number;
  readonly targetWeightBps: number;
  readonly priceE8: bigint | null;
  readonly priceStatus: string;
  readonly valueUsdE8: bigint | null;
  readonly weightBps: number | null;
}

interface OutsidePosition {
  readonly token: string;
  readonly balance: bigint;
  readonly decimals: number;
  readonly priceE8: bigint | null;
  readonly priceStatus: string;
  readonly valueUsdE8: bigint | null;
}

interface Valuation {
  readonly positions: Position[];
  readonly outsideIndex: OutsidePosition[];
  readonly investedValueUsdE8: bigint | null;
  readonly quoteBalance: bigint;
  readonly quoteValueUsdE8: bigint;
  readonly quotePriceE8: bigint;
  readonly deployableValueUsdE8: bigint | null;
  readonly cashShareBps: number | null;
  readonly issues: Finding[];
}

function valuePortfolio(input: PlanInput): Valuation {
  const prices = new Map(input.prices.map((entry) => [entry.token, entry]));
  const holdings = new Map(input.holdings.map((holding) => [holding.token, holding]));
  const constituentTokens = new Set(input.constituents.map(({ token }) => token));
  const issues: Finding[] = [];

  const unweighted = byToken(input.constituents).map((constituent) => {
    const holding = holdings.get(constituent.token);
    const balance = holding?.balance ?? 0n;
    const price = resolvePrice(prices, constituent.token, input.blockOnLastClose);
    const mismatch = holding !== undefined && holding.decimals !== constituent.decimals;
    issues.push(...price.findings);
    if (mismatch) issues.push({ code: "decimals_mismatch", severity: "blocker", token: constituent.token });
    const valueUsdE8 =
      price.usablePriceE8 === null || mismatch
        ? null
        : positionValue(balance, price.usablePriceE8, constituent.decimals);
    return {
      token: constituent.token,
      balance,
      decimals: constituent.decimals,
      targetWeightBps: constituent.weightBps,
      priceE8: price.shownPriceE8,
      priceStatus: price.status,
      valueUsdE8,
    };
  });

  const values: bigint[] = [];
  for (const { valueUsdE8 } of unweighted) if (valueUsdE8 !== null) values.push(valueUsdE8);
  const complete = values.length === unweighted.length;
  const investedValueUsdE8 = complete ? values.reduce((sum, value) => sum + value, 0n) : null;
  const weights = complete ? weightsOf(values) : unweighted.map(() => null);
  const positions = unweighted.map((position, index) => ({ ...position, weightBps: weights[index] ?? null }));

  const outsideIndex = byToken(input.holdings.filter(({ token }) => !constituentTokens.has(token))).map((holding) => {
    // A token outside the index produces no finding.
    const price = resolvePrice(prices, holding.token, input.blockOnLastClose);
    return {
      token: holding.token,
      balance: holding.balance,
      decimals: holding.decimals,
      priceE8: price.shownPriceE8,
      priceStatus: price.status,
      valueUsdE8:
        price.usablePriceE8 === null ? null : positionValue(holding.balance, price.usablePriceE8, holding.decimals),
    };
  });

  const quoteValueUsdE8 = input.quoteBalance * QUOTE_UNIT_USD_E8;
  const deployableValueUsdE8 = investedValueUsdE8 === null ? null : investedValueUsdE8 + quoteValueUsdE8;
  const cashShareBps =
    deployableValueUsdE8 === null || deployableValueUsdE8 === 0n
      ? null
      : // Uninvested share: down, never above the exact ratio.
        Number(mulDivFloor(quoteValueUsdE8, BPS, deployableValueUsdE8));

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

// ---------------------------------------------------------------------------------------------------------------
// Legs.
// ---------------------------------------------------------------------------------------------------------------

type SkipReason = "zero_quantity" | "below_minimum" | "not_needed" | "above_target_weight";

interface Leg {
  readonly side: "sell" | "buy";
  readonly token: string;
  readonly exit: boolean;
  readonly tokenQuantity: bigint;
  readonly quoteAmount: bigint;
  readonly valueUsdE8: bigint;
  readonly priceE8: bigint;
}

interface Skip {
  readonly side: "sell" | "buy";
  readonly token: string;
  readonly exit: boolean;
  readonly valueUsdE8: bigint;
  readonly reason: SkipReason;
}

/** Step 9: a zero quantity or quote amount, then a value below the minimum. A leg worth the minimum passes. */
function minimumCheck(leg: Leg, minLegValueUsdE8: bigint): SkipReason | null {
  if (leg.tokenQuantity === 0n || leg.quoteAmount === 0n) return "zero_quantity";
  if (leg.valueUsdE8 < minLegValueUsdE8) return "below_minimum";
  return null;
}

/** A sell of `quantity` base units: value down, proceeds down to quote base units. */
function sellLeg(token: string, exit: boolean, quantity: bigint, priceE8: bigint, decimals: number): Leg {
  const valueUsdE8 = positionValue(quantity, priceE8, decimals);
  const quoteAmount = valueUsdE8 / QUOTE_UNIT_USD_E8; // Down: proceeds that may not arrive are not counted.
  return { side: "sell", token, exit, tokenQuantity: quantity, quoteAmount, valueUsdE8, priceE8 };
}

/** A buy of share `share` quote base units: the quantity down, the amount spent up from that quantity. */
function buyLeg(token: string, share: bigint, priceE8: bigint, decimals: number): Leg {
  // Buy token quantity: down, the plan never expects more tokens than the amount buys.
  const quantity = mulDivFloor(share * QUOTE_UNIT_USD_E8, pow10(decimals), priceE8);
  // Amount spent: up from the quantity, ceil(ceil(quantity * priceE8 / 10^decimals) / 100).
  const costUsdE8 = mulDivCeil(quantity, priceE8, pow10(decimals));
  const quoteAmount = divCeil(costUsdE8, QUOTE_UNIT_USD_E8);
  // The value of a buy is the amount it spends, exact. The specification does not say whether a buy's
  // `valueUsdE8` is the value of its quantity, its cost or its quote amount; this is the reading the vectors fix.
  const valueUsdE8 = quoteAmount * QUOTE_UNIT_USD_E8;
  return { side: "buy", token, exit: false, tokenQuantity: quantity, quoteAmount, valueUsdE8, priceE8 };
}

interface Sized {
  readonly constituent: Position;
  readonly priceE8: bigint;
  readonly leg: Leg;
  /** The value the leg was sized for, reported when it is skipped. */
  readonly sizedForUsdE8: bigint;
}

function skipOf(sized: Sized, reason: SkipReason): Skip {
  const { side, token, exit } = sized.leg;
  return { side, token, exit, valueUsdE8: sized.sizedForUsdE8, reason };
}

// ---------------------------------------------------------------------------------------------------------------
// Plan.
// ---------------------------------------------------------------------------------------------------------------

interface ProjectedPosition {
  readonly token: string;
  readonly balance: bigint;
  readonly valueUsdE8: bigint;
  readonly targetWeightBps: number;
  readonly weightBps: number | null;
  readonly driftBps: number | null;
}

interface Projection {
  readonly positions: ProjectedPosition[];
  readonly investedValueUsdE8: bigint;
  readonly maxAbsDriftBps: number | null;
  readonly quoteBalance: bigint;
}

interface Candidate {
  readonly name: "uncapped" | "capped";
  readonly sells: Leg[];
  readonly sellSkips: Skip[];
  readonly buys: Leg[];
  readonly buySkips: Skip[];
  readonly buyBudgetQuote: bigint;
  readonly projection: Projection;
}

type PlanResult =
  | { status: "blocked"; blockers: Finding[]; warnings: Finding[]; valuation: Valuation }
  | {
      status: "ready";
      warnings: Finding[];
      valuation: Valuation;
      mode: Mode;
      reserveBps: number;
      minLegValueUsdE8: bigint;
      deployableValueUsdE8: bigint;
      availableQuote: bigint;
      buyBudgetQuote: bigint;
      targets: {
        token: string;
        targetWeightBps: number;
        currentValueUsdE8: bigint;
        targetValueUsdE8: bigint;
        deltaUsdE8: bigint;
      }[];
      legs: Leg[];
      skipped: Skip[];
      currentMaxAbsDriftBps: number | null;
      candidate: "uncapped" | "capped";
      otherCandidateMaxAbsDriftBps: number | null;
      projected: Projection;
    };

function planRebalance(input: PlanInput): PlanResult {
  const valuation = valuePortfolio(input);
  const prices = new Map(input.prices.map((entry) => [entry.token, entry]));
  const holdings = new Map(input.holdings.map((holding) => [holding.token, holding]));
  const blockers = valuation.issues.filter(({ severity }) => severity === "blocker");
  const warnings = valuation.issues.filter(({ severity }) => severity === "warning");
  const reserve = BigInt(input.reserveBps);
  const minLeg = input.minLegValueUsdE8;
  const rebalance = input.mode === "rebalance";

  // Tokens to exit that the wallet holds (rebalance mode only): each needs a usable price.
  const heldExits: { token: string; balance: bigint; decimals: number; priceE8: bigint }[] = [];
  if (rebalance) {
    for (const token of [...input.exitTokens].sort()) {
      const holding = holdings.get(token);
      if (holding === undefined || holding.balance === 0n) continue;
      const price = resolvePrice(prices, token, input.blockOnLastClose);
      // The price is classified like a constituent's: a delayed or last_close price is a warning.
      blockers.push(...price.findings.filter(({ severity }) => severity === "blocker"));
      warnings.push(...price.findings.filter(({ severity }) => severity === "warning"));
      if (price.usablePriceE8 !== null) {
        heldExits.push({ token, balance: holding.balance, decimals: holding.decimals, priceE8: price.usablePriceE8 });
      }
    }
  }
  const invested = valuation.investedValueUsdE8;
  if (blockers.length > 0 || invested === null) return { status: "blocked", blockers, warnings, valuation };

  // Step 1: available quote. The deposit is converted down to quote base units.
  const depositQuote = input.depositUsdE8 / QUOTE_UNIT_USD_E8;
  const availableQuote = input.quoteBalance + depositQuote;

  // Step 2: exits sell their whole balance; one that fails the minimum stays in the wallet.
  const exitLegs: Leg[] = [];
  const exitSkips: Skip[] = [];
  for (const exit of heldExits) {
    const leg = sellLeg(exit.token, true, exit.balance, exit.priceE8, exit.decimals);
    const reason = minimumCheck(leg, minLeg);
    if (reason === null) exitLegs.push(leg);
    else exitSkips.push({ side: "sell", token: exit.token, exit: true, valueUsdE8: leg.valueUsdE8, reason });
  }
  const exitProceeds = exitLegs.reduce((sum, leg) => sum + leg.quoteAmount, 0n);
  const exitValues = exitLegs.reduce((sum, leg) => sum + leg.valueUsdE8, 0n);

  // Step 3: deployable value.
  const deployable = invested + availableQuote * QUOTE_UNIT_USD_E8 + exitValues;
  if (deployable === 0n) {
    blockers.push({ code: "zero_deployable_value", severity: "blocker", token: null });
    return { status: "blocked", blockers, warnings, valuation };
  }

  const positions = valuation.positions;
  const priceOf = (position: Position): bigint => {
    if (position.priceE8 === null || position.priceE8 === 0n) throw new Error("unpriced constituent in a plan");
    return position.priceE8;
  };
  const currentValue = (position: Position): bigint => {
    if (position.valueUsdE8 === null) throw new Error("unvalued constituent in a plan");
    return position.valueUsdE8;
  };

  // Step 4: target values, down.
  const targets = positions.map((position) => {
    const targetValueUsdE8 = mulDivFloor(deployable, BigInt(position.targetWeightBps), BPS);
    const currentValueUsdE8 = currentValue(position);
    return {
      token: position.token,
      targetWeightBps: position.targetWeightBps,
      currentValueUsdE8,
      targetValueUsdE8,
      deltaUsdE8: targetValueUsdE8 - currentValueUsdE8,
    };
  });

  // Step 5: full sells of the constituents above target, quantity down.
  const fullSells: Sized[] = [];
  const failedSells: Skip[] = [];
  if (rebalance) {
    for (const [index, position] of positions.entries()) {
      const target = targets[index];
      if (target === undefined || target.deltaUsdE8 >= 0n) continue;
      const priceE8 = priceOf(position);
      const excess = -target.deltaUsdE8;
      const quantity = mulDivFloor(excess, pow10(position.decimals), priceE8);
      const sized = {
        constituent: position,
        priceE8,
        leg: sellLeg(position.token, false, quantity, priceE8, position.decimals),
        sizedForUsdE8: excess,
      };
      const reason = minimumCheck(sized.leg, minLeg);
      if (reason === null) fullSells.push(sized);
      else failedSells.push(skipOf(sized, reason));
    }
  }
  const fullProceeds = fullSells.reduce((sum, { leg }) => sum + leg.quoteAmount, 0n);

  // Step 6: buys. Budget down, wanted down, pro rata share down.
  const budget = mulDivFloor(availableQuote + exitProceeds + fullProceeds, BPS - reserve, BPS);
  const wanted: { position: Position; amount: bigint }[] = [];
  for (const [index, position] of positions.entries()) {
    const target = targets[index];
    if (target === undefined || target.deltaUsdE8 <= 0n) continue;
    wanted.push({ position, amount: target.deltaUsdE8 / QUOTE_UNIT_USD_E8 });
  }
  const sumWanted = wanted.reduce((sum, { amount }) => sum + amount, 0n);
  const buys: Sized[] = [];
  const failedBuys: Skip[] = [];
  for (const { position, amount } of wanted) {
    const share = sumWanted > budget ? mulDivFloor(amount, budget, sumWanted) : amount;
    const priceE8 = priceOf(position);
    const sized = {
      constituent: position,
      priceE8,
      leg: buyLeg(position.token, share, priceE8, position.decimals),
      sizedForUsdE8: share * QUOTE_UNIT_USD_E8,
    };
    const reason = minimumCheck(sized.leg, minLeg);
    if (reason === null) buys.push(sized);
    else failedBuys.push(skipOf(sized, reason));
  }

  // A first replication that cannot buy every constituent is blocked with a sufficient deployable value.
  if (invested === 0n && failedBuys.length > 0) {
    const rounding = 100n * BigInt(8 + (rebalance ? input.exitTokens.length : 0));
    let minimum = 0n;
    for (const position of positions) {
      const unit = divCeil(priceOf(position), pow10(position.decimals));
      const needed = mulDivCeil(
        minLeg + unit + rounding,
        BPS * BPS,
        BigInt(position.targetWeightBps) * (BPS - reserve),
      );
      minimum = maxBig(minimum, needed);
    }
    blockers.push({
      code: "below_minimum_portfolio_value",
      severity: "blocker",
      token: null,
      minimumDeployableValueUsdE8: minimum,
    });
    return { status: "blocked", blockers, warnings, valuation };
  }

  /** Step 7: the sells scaled to what `buyLegs` spend. Exits are always sold in full. */
  const sellsFor = (buyLegs: readonly Leg[]): { sells: Leg[]; skips: Skip[] } => {
    const spent = buyLegs.reduce((sum, leg) => sum + leg.quoteAmount, 0n);
    // Proceeds needed: up, so the buys stay within the budget after the reserve.
    const needed = mulDivCeil(spent, BPS, BPS - reserve) - availableQuote - exitProceeds;
    if (needed <= 0n) {
      return { sells: [], skips: fullSells.map((sized) => skipOf(sized, "not_needed")) };
    }
    if (needed >= fullProceeds) return { sells: fullSells.map(({ leg }) => leg), skips: [] };
    const k = BigInt(fullSells.length);
    const sells = fullSells.map(({ constituent, priceE8, leg }) => {
      const scale = pow10(constituent.decimals);
      // Smallest quantity that passes the minimum: up.
      const smallest = mulDivCeil(maxBig(minLeg, 100n), scale, priceE8);
      // Scaled sell quantity: up, at most the full sell.
      const scaled = mulDivCeil(leg.tokenQuantity, needed + k - 1n, fullProceeds);
      const quantity = minBig(leg.tokenQuantity, maxBig(scaled, smallest));
      return sellLeg(constituent.token, false, quantity, priceE8, constituent.decimals);
    });
    return { sells, skips: [] };
  };

  const project = (sells: readonly Leg[], buyLegs: readonly Leg[]): Projection => {
    const delta = new Map<string, bigint>();
    for (const leg of sells) delta.set(leg.token, (delta.get(leg.token) ?? 0n) - leg.tokenQuantity);
    for (const leg of buyLegs) delta.set(leg.token, (delta.get(leg.token) ?? 0n) + leg.tokenQuantity);
    const balances = positions.map((position) => position.balance + (delta.get(position.token) ?? 0n));
    const values = positions.map((position, index) =>
      positionValue(balances[index] ?? 0n, priceOf(position), position.decimals),
    );
    const weights = weightsOf(values);
    const targetWeights = positions.map(({ targetWeightBps }) => targetWeightBps);
    const proceeds = [...exitLegs, ...sells].reduce((sum, leg) => sum + leg.quoteAmount, 0n);
    const spent = buyLegs.reduce((sum, leg) => sum + leg.quoteAmount, 0n);
    return {
      positions: positions.map((position, index) => {
        const weightBps = weights[index] ?? null;
        return {
          token: position.token,
          balance: balances[index] ?? 0n,
          valueUsdE8: values[index] ?? 0n,
          targetWeightBps: position.targetWeightBps,
          weightBps,
          driftBps: weightBps === null ? null : weightBps - position.targetWeightBps,
        };
      }),
      investedValueUsdE8: values.reduce((sum, value) => sum + value, 0n),
      maxAbsDriftBps: maxAbsDrift(weights, targetWeights),
      quoteBalance: availableQuote + proceeds - spent,
    };
  };

  const budgetFor = (sells: readonly Leg[]): bigint =>
    mulDivFloor(
      availableQuote + exitProceeds + sells.reduce((sum, leg) => sum + leg.quoteAmount, 0n),
      BPS - reserve,
      BPS,
    );

  const buildCandidate = (name: Candidate["name"], buyLegs: Leg[], buySkips: Skip[]): Candidate => {
    const { sells, skips } = sellsFor(buyLegs);
    return {
      name,
      sells,
      sellSkips: skips,
      buys: buyLegs,
      buySkips,
      buyBudgetQuote: budgetFor(sells),
      projection: project(sells, buyLegs),
    };
  };

  const uncapped = buildCandidate(
    "uncapped",
    buys.map(({ leg }) => leg),
    failedBuys,
  );

  // Step 8: the capped candidate, when a buy was skipped in step 6.
  let capped: Candidate | null = null;
  if (failedBuys.length > 0) {
    // Planned values after the uncapped candidate's sells and buys.
    const plannedValues = new Map(uncapped.projection.positions.map(({ token, valueUsdE8 }) => [token, valueUsdE8]));
    let remaining = [...buys];
    const capSkips: Skip[] = [];
    let cappedLegs = new Map<string, Leg>();
    for (let round = 0; round <= buys.length; round += 1) {
      // Planned value of a constituent whose buy was dropped is its current value.
      const remainingTokens = new Set(remaining.map(({ leg }) => leg.token));
      const dropped = new Set(buys.filter(({ leg }) => !remainingTokens.has(leg.token)).map(({ leg }) => leg.token));
      const planned = (position: Position): bigint =>
        dropped.has(position.token) ? currentValue(position) : (plannedValues.get(position.token) ?? 0n);
      const cappedSet = new Set<string>();
      const caps = new Map<string, bigint>();
      for (let pass = 0; pass <= positions.length; pass += 1) {
        let notCappedValue = 0n;
        let cappedWeight = 0n;
        for (const position of positions) {
          if (cappedSet.has(position.token)) cappedWeight += BigInt(position.targetWeightBps);
          else notCappedValue += planned(position);
        }
        let added = false;
        for (const { constituent } of remaining) {
          // Cap of a buy: down, a capped buy never ends above its target weight.
          const share = mulDivFloor(BigInt(constituent.targetWeightBps), notCappedValue, BPS - cappedWeight);
          caps.set(constituent.token, share);
          if (!cappedSet.has(constituent.token) && planned(constituent) > share) {
            cappedSet.add(constituent.token);
            added = true;
          }
        }
        if (!added) break;
      }
      const nextLegs = new Map<string, Leg>();
      const tooSmall: Sized[] = [];
      for (const sized of remaining) {
        const cap = caps.get(sized.leg.token);
        if (!cappedSet.has(sized.leg.token) || cap === undefined) {
          nextLegs.set(sized.leg.token, sized.leg);
          continue;
        }
        const room = cap - currentValue(sized.constituent);
        const share = room <= 0n ? 0n : minBig(room / QUOTE_UNIT_USD_E8, sized.leg.quoteAmount);
        const leg = buyLeg(sized.leg.token, share, sized.priceE8, sized.constituent.decimals);
        if (minimumCheck(leg, minLeg) === null) nextLegs.set(leg.token, leg);
        else tooSmall.push(sized);
      }
      cappedLegs = nextLegs;
      if (tooSmall.length === 0) break;
      for (const sized of tooSmall) capSkips.push(skipOf(sized, "above_target_weight"));
      const tooSmallTokens = new Set(tooSmall.map(({ leg }) => leg.token));
      remaining = remaining.filter(({ leg }) => !tooSmallTokens.has(leg.token));
    }
    const cappedBuyLegs = byToken([...cappedLegs.values()]);
    capped = buildCandidate("capped", cappedBuyLegs, byToken([...failedBuys, ...capSkips]));
  }

  const hasDeposit = depositQuote >= 1n;
  const tradeSize = (candidate: Candidate): bigint =>
    [...candidate.sells, ...candidate.buys].reduce((sum, leg) => sum + leg.quoteAmount, 0n);
  const drift = (candidate: Candidate): number => candidate.projection.maxAbsDriftBps ?? 0;

  let chosen = uncapped;
  let other: Candidate | null = null;
  if (capped !== null) {
    let pickUncapped: boolean;
    if (drift(uncapped) !== drift(capped)) pickUncapped = drift(uncapped) < drift(capped);
    else if (hasDeposit) pickUncapped = uncapped.projection.quoteBalance < capped.projection.quoteBalance;
    else pickUncapped = tradeSize(uncapped) < tradeSize(capped);
    chosen = pickUncapped ? uncapped : capped;
    other = pickUncapped ? capped : uncapped;
  }

  const legs = [...byToken([...exitLegs, ...chosen.sells]), ...chosen.buys];
  const skipped = [...byToken([...exitSkips, ...failedSells, ...chosen.sellSkips]), ...byToken(chosen.buySkips)];

  const currentMaxAbsDriftBps = maxAbsDrift(
    valuation.positions.map(({ weightBps }) => weightBps),
    valuation.positions.map(({ targetWeightBps }) => targetWeightBps),
  );
  const projectedMax = chosen.projection.maxAbsDriftBps ?? 0;
  if (projectedMax > (currentMaxAbsDriftBps ?? 0)) {
    warnings.push({
      code: "projected_drift_increase",
      severity: "warning",
      token: null,
      currentMaxAbsDriftBps,
      projectedMaxAbsDriftBps: projectedMax,
    });
  }
  const uninvestedQuote = chosen.buyBudgetQuote - chosen.buys.reduce((sum, leg) => sum + leg.quoteAmount, 0n);
  if (uninvestedQuote * QUOTE_UNIT_USD_E8 > minLeg) {
    warnings.push({ code: "uninvested_quote", severity: "warning", token: null, uninvestedQuote });
  } else if (legs.length === 0) {
    warnings.push({ code: "nothing_to_do", severity: "warning", token: null });
  }

  return {
    status: "ready",
    warnings,
    valuation,
    mode: input.mode,
    reserveBps: input.reserveBps,
    minLegValueUsdE8: minLeg,
    deployableValueUsdE8: deployable,
    availableQuote,
    buyBudgetQuote: chosen.buyBudgetQuote,
    targets,
    legs,
    skipped,
    currentMaxAbsDriftBps,
    candidate: chosen.name,
    otherCandidateMaxAbsDriftBps: other === null ? null : other.projection.maxAbsDriftBps,
    projected: chosen.projection,
  };
}

/** Every bigint as a decimal string, as in the published vectors. */
function toVectorJson(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (_key, item: unknown) => (typeof item === "bigint" ? item.toString() : item)),
  );
}

describe("published vectors, recomputed independently from the specification", () => {
  test("there are 60 vectors", () => {
    expect(planVectors.vectors.length).toBe(60);
  });

  for (const vector of planVectors.vectors) {
    test(`${vector.name}: the exact result`, () => {
      expect<unknown>(toVectorJson(planRebalance(parseInput(vector.input)))).toEqual(vector.expected);
    });
  }
});
