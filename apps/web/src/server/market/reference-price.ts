import "server-only";
import {
  CLOCK_SKEW_TOLERANCE_SECONDS,
  classifyStaleness,
  type MarketPhase,
  marketSession,
  type StalenessStatus,
} from "@equityos/core";
import { isExpectedFeed, type ReferenceFeed } from "./feeds";
import type { FeedRead } from "./onchain";

/** A value a reference feed published. */
export interface PricePoint {
  /**
   * USD per one whole token, scaled by 1e8. It is the feed answer, unchanged: the feed already includes the
   * token's share multiplier, so the multiplier is never applied here or downstream.
   */
  readonly priceE8: bigint;
  /** Publication time of the round, Unix seconds. */
  readonly updatedAt: number;
  readonly roundId: bigint;
}

/**
 * Why there is no usable reference price.
 * - `feed_read_failed`: the feed proxy could not be read.
 * - `feed_mismatch`: the proxy does not answer with the decimals and description recorded for it.
 * - `invalid_round`: the latest round is incomplete, not positive, carried over, or dated in the future.
 * - `stale_feed`: the feed has not published within its heartbeat of trading time.
 */
export type PriceUnavailableReason = "feed_read_failed" | "feed_mismatch" | "invalid_round" | "stale_feed";

/** A reference price that may be used, with its staleness class. */
export interface UsableReferencePrice extends PricePoint {
  readonly status: Exclude<StalenessStatus, "unavailable">;
  readonly source: "chainlink";
  /** Phase of the US equity market at observation time. */
  readonly marketPhase: MarketPhase | "unknown";
}

/**
 * An absent reference price. It carries no top-level price, so it cannot be used by accident. `lastObserved` is
 * the stale round, for display next to its age only.
 */
export interface UnavailableReferencePrice {
  readonly status: "unavailable";
  readonly source: "chainlink";
  readonly reason: PriceUnavailableReason;
  readonly lastObserved: PricePoint | null;
}

/**
 * A reference price is an indication of value. It is not an executable price: no trade is guaranteed at it.
 */
export type ReferencePrice = UsableReferencePrice | UnavailableReferencePrice;

function unavailable(reason: PriceUnavailableReason, lastObserved: PricePoint | null = null): ReferencePrice {
  return { status: "unavailable", source: "chainlink", reason, lastObserved };
}

export interface ReferencePriceInput {
  readonly feed: ReferenceFeed;
  readonly read: FeedRead | undefined;
  /** Observation time, Unix seconds. */
  readonly now: number;
  /**
   * Whether the read was served from cache after a failed refresh. A newer round may exist that was not seen,
   * so such a read is never reported as `live`.
   */
  readonly servedStale: boolean;
  /**
   * Whether the read is a replayed recording. A recorded value is never current, so a usable one is reported as
   * `last_close`, never `live` or `delayed`, whatever its age at the recorded block.
   */
  readonly recorded: boolean;
}

/**
 * Builds the reference price of a token from the read of its feed. The only source is the mapped feed: when
 * it cannot provide a usable value the result is `unavailable`, never a value from elsewhere.
 */
export function buildReferencePrice({ feed, read, now, servedStale, recorded }: ReferencePriceInput): ReferencePrice {
  if (read === undefined || read.status !== "ok") return unavailable("feed_read_failed");
  if (!isExpectedFeed(feed, read)) return unavailable("feed_mismatch");
  const { roundId, answer, updatedAt, answeredInRound } = read.round;
  if (answer <= 0n || updatedAt <= 0 || answeredInRound < roundId || updatedAt > now + CLOCK_SKEW_TOLERANCE_SECONDS) {
    return unavailable("invalid_round");
  }
  const point: PricePoint = { priceE8: answer, updatedAt, roundId };
  const session = marketSession(updatedAt, now);
  const status = classifyStaleness({ updatedAt, now, session });
  if (status === "unavailable") return unavailable("stale_feed", point);
  return {
    ...point,
    status: recorded ? "last_close" : status === "live" && servedStale ? "delayed" : status,
    source: "chainlink",
    marketPhase: session.phase,
  };
}
