/**
 * The indexes the public seed publishes on Base Sepolia or Base mainnet, chosen from a live market snapshot by
 * the rules stated here. Pure: the snapshot is an input, nothing is read or sent.
 *
 * Every rule is reproducible from public data: the issuer's asset list, the token contracts and the reference
 * feeds on Base mainnet, at the block the snapshot was read at.
 */
import { BPS, mulDivDown, positionValueUsdE8 } from "@equityos/core";
import type { Address, Hex } from "viem";
import { REFERENCE_FEEDS } from "../../src/server/market/feeds";
import type { IneligibilityCode, MarketSnapshot } from "../../src/server/market/index";
import { buildVersion, type SeedVersion, salt } from "./indexes";

/**
 * The large technology names of the first two indexes, by the ticker in their reference feed description. The
 * list is fixed here, not derived: every name must be index-eligible when the seed runs, or nothing is sent.
 */
export const LARGE_TECHNOLOGY_TICKERS = ["AAPL", "AMZN", "GOOGL", "META", "MSFT", "NVDA"] as const;

/** Upper bound of a constituent weight of the capped index: 20%. */
export const CAPPED_MAX_WEIGHT_BPS = 2_000;

/**
 * Granularity of the capped weights: whole percent. Coarse on purpose: the weights are derived from values that
 * move with every price update, and whole percent keeps a dry run and the run that sends it on the same weights
 * unless the values moved by a visible amount. `SEED_PLAN_DIGEST` catches the case where they did.
 */
export const CAPPED_WEIGHT_STEP_BPS = 100;

/** Number of constituents of the third index. */
export const LARGEST_SUPPLY_COUNT = 5;

/** A token that cannot be a constituent, with the reasons the market data layer gives. */
export interface IneligibleConstituent {
  readonly token: Address;
  readonly ticker: string;
  readonly reasons: readonly (IneligibilityCode | "price_unavailable" | "not_in_snapshot")[];
}

/** A token's minted supply valued at its reference price. */
export interface SupplyValue {
  readonly token: Address;
  readonly ticker: string;
  /** Total supply in token base units, as read from the token contract. */
  readonly totalSupply: bigint;
  readonly decimals: number;
  /** Reference price, USD per whole token scaled by 1e8. Not an executable price. */
  readonly priceE8: bigint;
  /** Publication time of the feed round the price comes from, Unix seconds. */
  readonly priceUpdatedAt: number;
  /** `totalSupply * priceE8 / 10^decimals`, rounded down: USD scaled by 1e8. */
  readonly valueUsdE8: bigint;
}

export interface PublicSeedIndex {
  readonly key: "large-technology-equal" | "large-technology-capped" | "largest-minted-supply";
  /** Salt passed to `createIndex`. With the creator it determines the index id. */
  readonly salt: Hex;
  readonly version: SeedVersion;
  /** The rule that chose the constituents and weights, in one sentence, printed with the plan. */
  readonly rule: string;
}

export interface PublicSeedSelection {
  readonly indexes: readonly PublicSeedIndex[];
  /** Every index-eligible token with a usable reference price, by supply value, largest first. */
  readonly ranking: readonly SupplyValue[];
}

/** The constituents of the seed are not all usable. Nothing may be published. */
export class IneligibleConstituentsError extends Error {
  readonly ineligible: readonly IneligibleConstituent[];

  constructor(ineligible: readonly IneligibleConstituent[]) {
    const list = ineligible.map(({ ticker, token, reasons }) => `${ticker} ${token} (${reasons.join(", ")})`);
    super(`constituents are not index-eligible with a usable reference price: ${list.join("; ")}`);
    this.name = "IneligibleConstituentsError";
    this.ineligible = ineligible;
  }
}

/** The ticker of a feed-covered token, from the description of its reference feed. */
export function tickerOf(token: Address): string {
  const description = REFERENCE_FEEDS.get(token)?.description;
  const match = description === undefined ? null : /^Coinbase ([A-Z0-9.]+)(?: \/ USD)?$/.exec(description);
  if (match?.[1] === undefined) throw new Error(`no reference feed is mapped for ${token}`);
  return match[1];
}

/** The token whose reference feed names `ticker`. */
export function tokenOf(ticker: string): Address {
  for (const token of REFERENCE_FEEDS.keys()) if (tickerOf(token) === ticker) return token;
  throw new Error(`no reference feed is mapped for ${ticker}`);
}

/**
 * The supply value of `token` in the snapshot, or why it has none. A token is usable when the market data layer
 * says it is index-eligible and its reference price is usable (live, delayed or last close).
 */
function supplyValue(snapshot: MarketSnapshot, token: Address): SupplyValue | IneligibleConstituent {
  const ticker = tickerOf(token);
  const entry = snapshot.assets.get(token);
  if (entry === undefined) return { token, ticker, reasons: ["not_in_snapshot"] };
  if (!entry.eligibility.eligible) return { token, ticker, reasons: entry.eligibility.reasons };
  const price = entry.referencePrice;
  if (entry.token.status !== "ok" || price === null || price.status === "unavailable") {
    return { token, ticker, reasons: ["price_unavailable"] };
  }
  const { totalSupply, decimals } = entry.token.state;
  // Rounded down: a ranking key, never a displayed or traded amount.
  const valueUsdE8 = positionValueUsdE8(totalSupply, price.priceE8, decimals, "down");
  return { token, ticker, totalSupply, decimals, priceE8: price.priceE8, priceUpdatedAt: price.updatedAt, valueUsdE8 };
}

function isUsable(value: SupplyValue | IneligibleConstituent): value is SupplyValue {
  return "valueUsdE8" in value;
}

function isIneligible(value: SupplyValue | IneligibleConstituent): value is IneligibleConstituent {
  return "reasons" in value;
}

/**
 * Every index-eligible, feed-covered token of the snapshot with a usable reference price, ordered by supply value,
 * largest first, ties broken by the lower address. An eligible token without a usable price makes the ranking
 * undecidable, so it is reported instead of being left out silently.
 */
export function rankBySupplyValue(snapshot: MarketSnapshot): {
  ranking: SupplyValue[];
  unpriced: IneligibleConstituent[];
} {
  const ranking: SupplyValue[] = [];
  const unpriced: IneligibleConstituent[] = [];
  for (const [token, entry] of snapshot.assets) {
    if (!entry.eligibility.eligible || !REFERENCE_FEEDS.has(token)) continue;
    const value = supplyValue(snapshot, token);
    if (isUsable(value)) ranking.push(value);
    else unpriced.push(value);
  }
  ranking.sort((a, b) =>
    a.valueUsdE8 === b.valueUsdE8 ? (a.token < b.token ? -1 : 1) : a.valueUsdE8 > b.valueUsdE8 ? -1 : 1,
  );
  return { ranking, unpriced };
}

/**
 * Splits 10,000 bps in proportion to `values`, with no weight above `capBps`, in steps of `stepBps`.
 *
 * 1. Every value whose proportional share of what is left exceeds the cap is set to the cap, and the shares of
 *    the others are computed again over what remains, until no share exceeds the cap.
 * 2. Each uncapped share is rounded down to a whole step. The steps still missing go one each to the largest
 *    remainders, ties to the earlier position. No weight passes the cap: a share at exactly the cap has no
 *    remainder.
 *
 * Integer arithmetic on `bigint` only. The result sums to exactly 10,000 bps, in the order of `values`.
 *
 * @throws {RangeError} if the cap cannot be met by that many values, a value is not positive, or a weight
 *   would round to zero.
 */
export function cappedProportionalWeightsBps(values: readonly bigint[], capBps: number, stepBps: number): number[] {
  const whole = (value: number) => Number.isSafeInteger(value) && value > 0;
  if (!whole(capBps) || !whole(stepBps) || capBps % stepBps !== 0 || Number(BPS) % stepBps !== 0) {
    throw new RangeError("the cap and 10,000 bps must be whole multiples of the step");
  }
  const total = BPS / BigInt(stepBps);
  const cap = BigInt(capBps / stepBps);
  if (values.length === 0 || cap * BigInt(values.length) < total) {
    throw new RangeError(`${values.length} weights capped at ${capBps} bps cannot sum to 10,000 bps`);
  }
  if (values.some((value) => value <= 0n)) throw new RangeError("every value must be positive");

  const capped = new Set<number>();
  for (;;) {
    const remaining = total - cap * BigInt(capped.size);
    const open = values.flatMap((value, i) => (capped.has(i) ? [] : [{ value, i }]));
    const sum = open.reduce((acc, { value }) => acc + value, 0n);
    const over = open.filter(({ value }) => value * remaining > cap * sum);
    if (over.length === 0) break;
    for (const { i } of over) capped.add(i);
  }

  const remaining = total - cap * BigInt(capped.size);
  const open = values.flatMap((value, i) => (capped.has(i) ? [] : [{ value, i }]));
  const sum = open.reduce((acc, { value }) => acc + value, 0n);
  const steps = values.map((_, i) => (capped.has(i) ? cap : 0n));
  const remainders: { i: number; remainder: bigint }[] = [];
  for (const { value, i } of open) {
    // Rounded down here; the steps lost are handed out by largest remainder below.
    steps[i] = mulDivDown(value, remaining, sum);
    remainders.push({ i, remainder: (value * remaining) % sum });
  }
  let missing = total - steps.reduce((acc, step) => acc + step, 0n);
  remainders.sort((a, b) => (a.remainder === b.remainder ? a.i - b.i : a.remainder > b.remainder ? -1 : 1));
  for (const { i } of remainders) {
    if (missing === 0n) break;
    const step = steps[i] ?? 0n;
    if (step >= cap) continue;
    steps[i] = step + 1n;
    missing -= 1n;
  }
  if (missing !== 0n || steps.some((step) => step <= 0n)) {
    throw new RangeError("a weight rounds to zero at this step: the values are too far apart");
  }
  return steps.map((step) => Number(step * BigInt(stepBps)));
}

/**
 * The three public seed indexes for `chainId`, from a market snapshot.
 *
 * 1. Large Technology Equal Weight: `LARGE_TECHNOLOGY_TICKERS`, each at the same weight.
 * 2. Large Technology Capped: the same names at fixed weights in whole percent, proportional to the supply value
 *    of each token (total supply times reference price) in the snapshot, capped at 20%. The weights are frozen
 *    in the spec: they do not follow later prices.
 * 3. Largest Minted Supply Equal Weight: the `LARGEST_SUPPLY_COUNT` index-eligible tokens with the largest
 *    supply value in the snapshot, each at the same weight. Liquidity cannot be established onchain, so supply
 *    value is the stated, reproducible rule.
 *
 * Each spec declares `chainId`, the chain it is published on, because verification rejects a spec read from
 * another chain. The constituents and feeds are Base mainnet addresses, as in the local seed.
 *
 * @throws {IneligibleConstituentsError} listing every large technology name that is not index-eligible with a
 *   usable reference price, and every eligible token without one, since it makes the ranking undecidable.
 */
export function selectPublicSeed(snapshot: MarketSnapshot, chainId: number): PublicSeedSelection {
  const named = LARGE_TECHNOLOGY_TICKERS.map((ticker) => supplyValue(snapshot, tokenOf(ticker)));
  const { ranking, unpriced } = rankBySupplyValue(snapshot);
  const problems = [...named.filter(isIneligible), ...unpriced];
  const unique = [...new Map(problems.map((problem) => [problem.token, problem])).values()];
  if (unique.length > 0) throw new IneligibleConstituentsError(unique);
  const technology = named.filter(isUsable);

  const cappedWeights = cappedProportionalWeightsBps(
    technology.map(({ valueUsdE8 }) => valueUsdE8),
    CAPPED_MAX_WEIGHT_BPS,
    CAPPED_WEIGHT_STEP_BPS,
  );
  const largest = ranking.slice(0, LARGEST_SUPPLY_COUNT);
  if (largest.length < LARGEST_SUPPLY_COUNT) {
    throw new RangeError(`only ${largest.length} tokens are index-eligible with a usable reference price`);
  }
  return {
    ranking,
    indexes: [
      {
        key: "large-technology-equal",
        salt: salt("equityos.public.tech-equal"),
        rule: `the fixed list ${LARGE_TECHNOLOGY_TICKERS.join(", ")}, equal weights`,
        version: buildVersion(chainId, {
          name: "Large Technology Equal Weight",
          slug: "large-technology-equal",
          description: "Six large technology companies, each at the same weight.",
          holdings: LARGE_TECHNOLOGY_TICKERS.map((ticker) => ({ ticker })),
        }),
      },
      {
        key: "large-technology-capped",
        salt: salt("equityos.public.tech-capped"),
        rule:
          "the same list, fixed weights in whole percent proportional to minted supply value at reference prices, " +
          "capped at 20%",
        version: buildVersion(chainId, {
          name: "Large Technology Capped",
          slug: "large-technology-capped",
          description:
            "The same six companies at fixed weights in whole percent, proportional to the value of each token's " +
            "minted supply at reference prices when the index was published, each at most 20%.",
          holdings: technology.map(({ ticker }, i) => ({ ticker, weightBps: cappedWeights[i] ?? 0 })),
          constraints: { maxWeightBps: CAPPED_MAX_WEIGHT_BPS },
        }),
      },
      {
        key: "largest-minted-supply",
        salt: salt("equityos.public.largest-supply-5"),
        rule: `the ${LARGEST_SUPPLY_COUNT} index-eligible tokens with the largest minted supply value at reference prices, equal weights`,
        version: buildVersion(chainId, {
          name: "Largest Minted Supply Equal Weight",
          slug: "largest-minted-supply-equal",
          description:
            "The five index-eligible tokens with the largest minted supply value at reference prices when the " +
            "index was published, each at the same weight.",
          holdings: largest.map(({ ticker }) => ({ ticker })),
        }),
      },
    ],
  };
}
