/**
 * Staleness classification of a reference price.
 *
 * A reference price is a value published at `updatedAt`. Whether it may be shown as current depends on how old
 * it is and on what the market was doing in the meantime. The classification is a pure function of the
 * publication time, the observation time and the market session.
 */

import type { MarketSession } from "./market-calendar.ts";

/**
 * - `live`: published within `LIVE_MAX_AGE_SECONDS` while the market is in a trading session.
 * - `delayed`: published earlier in the current run of trading time and still within the feed heartbeat.
 * - `last_close`: the value the feed held when trading last stopped, or a value whose session cannot be
 *   established. It is a real published value, not a current one.
 * - `unavailable`: no usable value. The feed missed its heartbeat, or the timestamp is absent or invalid.
 */
export type StalenessStatus = "live" | "delayed" | "last_close" | "unavailable";

/**
 * Longest age at which a value is called `live`. The feeds publish on a 0.5% deviation, so a quiet market
 * legitimately produces gaps: over 125 consecutive rounds of one feed sampled on 2026-11-19 and 2026-11-20 the
 * median gap was 7 minutes and the 90th percentile 38 minutes. Thirty minutes keeps `live` to values that are
 * recent by wall clock. An older value in an open session is `delayed`, which is still within the deviation band
 * the feed guarantees.
 */
export const LIVE_MAX_AGE_SECONDS = 30 * 60;

/** Heartbeat of the feeds: during trading time a new round is published at least this often. */
export const FEED_HEARTBEAT_SECONDS = 24 * 60 * 60;

/**
 * Allowance on top of the heartbeat for the heartbeat transaction to be included. Beyond heartbeat plus grace
 * of trading time without a round, the feed is not doing what it promises (paused for a corporate action, or
 * broken) and its value is `unavailable`.
 */
export const HEARTBEAT_GRACE_SECONDS = 15 * 60;

/**
 * Tolerated lead of `updatedAt` over the local clock. The publication time is a block timestamp and the
 * observation time is a server clock: a small lead is clock skew, a larger one is a wrong clock or wrong data.
 */
export const CLOCK_SKEW_TOLERANCE_SECONDS = 120;

/**
 * Longest age accepted when the market calendar does not cover the interval. Four days is a three-day weekend
 * closure (Friday 20:00 ET to Monday 20:00 ET) plus one heartbeat. Within it the value is reported as
 * `last_close`, never `live` or `delayed`, because an open session cannot be established.
 */
export const UNCOVERED_MAX_AGE_SECONDS = 4 * 24 * 60 * 60;

export interface StalenessInput {
  /** Publication time of the value, Unix seconds. */
  readonly updatedAt: number;
  /** Observation time, Unix seconds. */
  readonly now: number;
  /** Market session for the interval from `updatedAt` to `now`, from `marketSession`. */
  readonly session: MarketSession;
}

/** Classifies a published value. See `StalenessStatus` for the meaning of each class. */
export function classifyStaleness({ updatedAt, now, session }: StalenessInput): StalenessStatus {
  if (!Number.isSafeInteger(updatedAt) || !Number.isSafeInteger(now) || updatedAt <= 0) return "unavailable";
  if (updatedAt > now + CLOCK_SKEW_TOLERANCE_SECONDS) return "unavailable";
  const age = Math.max(0, now - updatedAt);
  if (session.phase === "unknown") return age <= UNCOVERED_MAX_AGE_SECONDS ? "last_close" : "unavailable";
  if (session.tradingSecondsSinceUpdate > FEED_HEARTBEAT_SECONDS + HEARTBEAT_GRACE_SECONDS) return "unavailable";
  // A closure between publication and now means the value predates the current session.
  if (session.phase === "closed" || session.tradingSecondsSinceUpdate < age) return "last_close";
  return age <= LIVE_MAX_AGE_SECONDS ? "live" : "delayed";
}
