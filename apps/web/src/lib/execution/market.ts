/**
 * What the browser reads on the plan's chain itself before it lets a plan be signed, and the checks on it.
 * Pure: the reads are made by the review and passed in.
 *
 * The plan's quotes, minimums, reference prices and decimals all come from the API. These checks make the
 * browser independent of it for the two things that bound what a swap can lose: the decimals of every token,
 * read with `decimals()`, and a reference price for every leg, read from the pinned Chainlink feed of the token
 * with the same validity and staleness rules as the server. Every leg's minimum out must be within
 * `CLIENT_PRICE_BOUND_BPS` of that reference, in the direction that costs the user.
 */
import { CLOCK_SKEW_TOLERANCE_SECONDS, classifyStaleness, marketSession, type StalenessStatus } from "@equityos/core";
import type { Address } from "viem";
import { isExpectedFeed, REFERENCE_FEEDS } from "@/lib/market/feeds";
import { PLAN_DEFAULT_MAX_DEVIATION_BPS, PLAN_DEFAULT_SLIPPAGE_BPS } from "./calldata";
import type { ExecutionPlanView, PlanLeg } from "./response";
import type { VerificationFailure, VerifiedSwap } from "./verify";

/** Decimals of USDC, which the plan does not state: read on the chain and required to be exactly this. */
export const USDC_DECIMALS = 6;

/**
 * Largest adverse deviation of a minimum amount out from the browser's reference, in basis points: the server's
 * default deviation band plus its default slippage, the parameters the page requests plans with. Beyond it the
 * swap could return less than the reference price allows for, and the browser refuses to send.
 */
export const CLIENT_PRICE_BOUND_BPS = PLAN_DEFAULT_MAX_DEVIATION_BPS + PLAN_DEFAULT_SLIPPAGE_BPS;

/** One read of a feed proxy: `null` fields failed to read. */
export interface FeedReading {
  readonly decimals: number | null;
  readonly description: string | null;
  readonly round: {
    readonly roundId: bigint;
    readonly answer: bigint;
    readonly updatedAt: bigint;
    readonly answeredInRound: bigint;
  } | null;
}

/** What the review read on the plan's chain, keyed by lowercase token address. */
export interface ChainReads {
  /** Timestamp of the block the reads were made at, Unix seconds: the clock of the staleness rules. */
  readonly chainTime: number;
  /** `decimals()` of USDC and of every leg token, `null` when the read failed. */
  readonly decimals: ReadonlyMap<string, number | null>;
  /** The feed of every leg token that has one. */
  readonly feeds: ReadonlyMap<string, FeedReading>;
}

/**
 * A reference price read by the browser, or why there is none.
 * - `no_feed`: the token has no pinned feed.
 * - `feed_read_failed`, `feed_mismatch`, `invalid_round`, `stale_feed`: as on the server.
 */
export type BrowserReference =
  | { readonly status: Exclude<StalenessStatus, "unavailable">; readonly priceE8: bigint; readonly updatedAt: number }
  | {
      readonly status: "unavailable";
      readonly reason: "no_feed" | "feed_read_failed" | "feed_mismatch" | "invalid_round" | "stale_feed";
    };

/** The reference price of `token` from its pinned feed, by the server's rules, at `chainTime`. */
export function browserReference(
  token: Address,
  reading: FeedReading | undefined,
  chainTime: number,
): BrowserReference {
  const feed = REFERENCE_FEEDS.get(token.toLowerCase() as Address);
  if (feed === undefined) return { status: "unavailable", reason: "no_feed" };
  if (reading === undefined || reading.round === null || reading.decimals === null || reading.description === null) {
    return { status: "unavailable", reason: "feed_read_failed" };
  }
  if (!isExpectedFeed(feed, { decimals: reading.decimals, description: reading.description })) {
    return { status: "unavailable", reason: "feed_mismatch" };
  }
  const { roundId, answer, updatedAt, answeredInRound } = reading.round;
  const updated = Number(updatedAt);
  if (
    answer <= 0n ||
    updatedAt <= 0n ||
    updatedAt > BigInt(Number.MAX_SAFE_INTEGER) ||
    answeredInRound < roundId ||
    updated > chainTime + CLOCK_SKEW_TOLERANCE_SECONDS
  ) {
    return { status: "unavailable", reason: "invalid_round" };
  }
  const status = classifyStaleness({ updatedAt: updated, now: chainTime, session: marketSession(updated, chainTime) });
  return status === "unavailable"
    ? { status: "unavailable", reason: "stale_feed" }
    : { status, priceE8: answer, updatedAt: updated };
}

/**
 * Deviation of a swap's worst price (its minimum out) from the reference, in basis points, positive when it
 * costs the user: a sell that returns less USDC, or a buy that pays more per token. Exact integers, rounded
 * up, so it is never reported smaller than it is.
 */
export function adverseDeviationBps(swap: VerifiedSwap, decimals: number, priceE8: bigint): bigint {
  const scale = 100n * 10n ** BigInt(decimals);
  // Both sides in USD scaled by 1e8 times 10^decimals: USDC has 6 decimals, the price 8.
  const usdc = swap.side === "sell" ? swap.minAmountOut : swap.amountIn;
  const tokens = swap.side === "sell" ? swap.amountIn : swap.minAmountOut;
  const executable = usdc * scale;
  const reference = tokens * priceE8;
  if (reference === 0n) return 10_000n;
  const difference = swap.side === "sell" ? reference - executable : executable - reference;
  if (difference <= 0n) return -((-difference * 10_000n) / reference);
  return (difference * 10_000n + reference - 1n) / reference;
}

export interface LegMarket {
  readonly leg: number;
  readonly reference: BrowserReference;
  /** Adverse deviation of the minimum out from the browser's reference, `null` without a usable reference. */
  readonly adverseBps: bigint | null;
}

function failure(code: VerificationFailure["code"], leg: number | null, detail: string): VerificationFailure {
  return { code, call: null, leg, detail };
}

/**
 * Checks the decimals and bounds the prices of a plan whose calls verified. Returns the failures, each a typed
 * reason, and what was found for each leg, for the review to show.
 */
export function checkMarket(
  plan: ExecutionPlanView,
  swaps: readonly VerifiedSwap[],
  reads: ChainReads,
  usdc: Address,
): { readonly failures: VerificationFailure[]; readonly legs: LegMarket[] } {
  const failures: VerificationFailure[] = [];
  const decimalsOf = (token: Address) => reads.decimals.get(token.toLowerCase()) ?? null;
  if (decimalsOf(usdc) !== USDC_DECIMALS) failures.push(failure("decimals_mismatch", null, usdc));
  const legs = plan.legs.map((leg: PlanLeg, index): LegMarket => {
    const onchain = decimalsOf(leg.token);
    if (onchain !== leg.decimals) failures.push(failure("decimals_mismatch", index, leg.token));
    const reference = browserReference(leg.token, reads.feeds.get(leg.token.toLowerCase()), reads.chainTime);
    if (reference.status === "unavailable" || reference.status === "last_close") {
      const why = reference.status === "unavailable" ? reference.reason : "last_close";
      failures.push(failure("reference_unusable", index, why));
      return { leg: index, reference, adverseBps: null };
    }
    const swap = swaps.find((entry) => entry.leg === index);
    if (swap === undefined || onchain === null) return { leg: index, reference, adverseBps: null };
    const adverseBps = adverseDeviationBps(swap, onchain, reference.priceE8);
    if (adverseBps > BigInt(CLIENT_PRICE_BOUND_BPS)) {
      failures.push(failure("price_out_of_bounds", index, adverseBps.toString()));
    }
    return { leg: index, reference, adverseBps };
  });
  return { failures, legs };
}
