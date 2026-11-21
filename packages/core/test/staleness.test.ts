import { describe, expect, test } from "bun:test";
import {
  CLOCK_SKEW_TOLERANCE_SECONDS,
  classifyStaleness,
  FEED_HEARTBEAT_SECONDS,
  HEARTBEAT_GRACE_SECONDS,
  LIVE_MAX_AGE_SECONDS,
  type MarketPhase,
  marketSession,
  type StalenessStatus,
  UNCOVERED_MAX_AGE_SECONDS,
} from "../src/index.ts";

function at(iso: string): number {
  return Date.parse(iso) / 1000;
}

/** Classifies with the real calendar. */
function classifyAt(updatedAt: number, now: number): StalenessStatus {
  return classifyStaleness({ updatedAt, now, session: marketSession(updatedAt, now) });
}

const NOW = at("2026-11-18T16:00:00Z"); // Wednesday 11:00 ET, regular session
const STALE_AFTER = FEED_HEARTBEAT_SECONDS + HEARTBEAT_GRACE_SECONDS;

function open(phase: MarketPhase, age: number, tradingSecondsSinceUpdate = age): StalenessStatus {
  return classifyStaleness({ updatedAt: NOW - age, now: NOW, session: { phase, tradingSecondsSinceUpdate } });
}

describe("thresholds", () => {
  test("are the documented values", () => {
    expect(LIVE_MAX_AGE_SECONDS).toBe(1_800);
    expect(FEED_HEARTBEAT_SECONDS).toBe(86_400);
    expect(HEARTBEAT_GRACE_SECONDS).toBe(900);
    expect(CLOCK_SKEW_TOLERANCE_SECONDS).toBe(120);
    expect(UNCOVERED_MAX_AGE_SECONDS).toBe(345_600);
  });
});

describe("classifyStaleness with an explicit session", () => {
  test("live up to and including the live threshold, in the regular and the extended session", () => {
    expect(open("regular", 0)).toBe("live");
    expect(open("regular", LIVE_MAX_AGE_SECONDS)).toBe("live");
    expect(open("extended", LIVE_MAX_AGE_SECONDS)).toBe("live");
  });

  test("delayed one second past the live threshold, up to heartbeat plus grace", () => {
    expect(open("regular", LIVE_MAX_AGE_SECONDS + 1)).toBe("delayed");
    expect(open("extended", LIVE_MAX_AGE_SECONDS + 1)).toBe("delayed");
    expect(open("regular", STALE_AFTER)).toBe("delayed");
  });

  test("unavailable one second past heartbeat plus grace of trading time, open or closed", () => {
    expect(open("regular", STALE_AFTER + 1)).toBe("unavailable");
    expect(open("extended", STALE_AFTER + 1)).toBe("unavailable");
    expect(open("closed", 10 * 86_400, STALE_AFTER)).toBe("last_close");
    expect(open("closed", 10 * 86_400, STALE_AFTER + 1)).toBe("unavailable");
  });

  test("a closed market is last_close however recent the value is", () => {
    expect(open("closed", 0)).toBe("last_close");
    expect(open("closed", 60, 60)).toBe("last_close");
  });

  test("a value from before a closure is last_close after the reopen, not delayed", () => {
    // 49 hours old by wall clock, 1 hour of it trading time.
    expect(open("extended", 49 * 3_600, 3_600)).toBe("last_close");
    expect(open("regular", LIVE_MAX_AGE_SECONDS, LIVE_MAX_AGE_SECONDS - 1)).toBe("last_close");
  });

  test("an unknown session is never live or delayed", () => {
    const unknown = (age: number) =>
      classifyStaleness({ updatedAt: NOW - age, now: NOW, session: { phase: "unknown" } });
    expect(unknown(0)).toBe("last_close");
    expect(unknown(UNCOVERED_MAX_AGE_SECONDS)).toBe("last_close");
    expect(unknown(UNCOVERED_MAX_AGE_SECONDS + 1)).toBe("unavailable");
  });

  test("a timestamp ahead of the clock is tolerated up to the skew allowance only", () => {
    const ahead = (lead: number) =>
      classifyStaleness({
        updatedAt: NOW + lead,
        now: NOW,
        session: { phase: "regular", tradingSecondsSinceUpdate: 0 },
      });
    expect(ahead(CLOCK_SKEW_TOLERANCE_SECONDS)).toBe("live");
    expect(ahead(CLOCK_SKEW_TOLERANCE_SECONDS + 1)).toBe("unavailable");
  });

  test("a missing or malformed timestamp is unavailable", () => {
    const session = { phase: "regular", tradingSecondsSinceUpdate: 0 } as const;
    expect(classifyStaleness({ updatedAt: 0, now: NOW, session })).toBe("unavailable");
    expect(classifyStaleness({ updatedAt: -1, now: NOW, session })).toBe("unavailable");
    expect(classifyStaleness({ updatedAt: 1.5, now: NOW, session })).toBe("unavailable");
    expect(classifyStaleness({ updatedAt: Number.NaN, now: NOW, session })).toBe("unavailable");
    expect(classifyStaleness({ updatedAt: NOW, now: Number.NaN, session })).toBe("unavailable");
  });
});

describe("classifyStaleness with the market calendar", () => {
  test("regular session: live, then delayed", () => {
    expect(classifyAt(NOW - 60, NOW)).toBe("live");
    expect(classifyAt(NOW - LIVE_MAX_AGE_SECONDS, NOW)).toBe("live");
    expect(classifyAt(NOW - LIVE_MAX_AGE_SECONDS - 1, NOW)).toBe("delayed");
    expect(classifyAt(NOW - 6 * 3_600, NOW)).toBe("delayed");
  });

  test("overnight session: a fresh round is live", () => {
    const overnight = at("2026-11-18T06:00:00Z"); // Wednesday 01:00 ET
    expect(classifyAt(overnight - 300, overnight)).toBe("live");
  });

  test("weekend: the Friday evening value is last_close on Saturday and Sunday", () => {
    // Recorded round of the NVDA feed: updated Friday 2026-11-20 23:42:40 UTC.
    const updatedAt = 1_795_218_160;
    expect(classifyAt(updatedAt, at("2026-11-21T01:00:00Z"))).toBe("last_close");
    expect(classifyAt(updatedAt, at("2026-11-21T18:57:00Z"))).toBe("last_close");
    expect(classifyAt(updatedAt, at("2026-11-23T00:59:59Z"))).toBe("last_close");
  });

  test("weekend: a value published one minute before the Friday close is last_close one minute after it", () => {
    expect(classifyAt(at("2026-11-21T00:59:00Z"), at("2026-11-21T00:59:30Z"))).toBe("live");
    expect(classifyAt(at("2026-11-21T00:59:00Z"), at("2026-11-21T01:01:00Z"))).toBe("last_close");
  });

  test("Sunday reopen: the Friday value stays last_close until the feed publishes, then goes unavailable", () => {
    const updatedAt = 1_795_218_160; // 4,640 s of trading time before the Friday close
    const reopen = at("2026-11-23T01:00:00Z");
    expect(classifyAt(updatedAt, reopen + 3_600)).toBe("last_close");
    expect(classifyAt(updatedAt, reopen + STALE_AFTER - 4_640)).toBe("last_close");
    expect(classifyAt(updatedAt, reopen + STALE_AFTER - 4_640 + 1)).toBe("unavailable");
  });

  test("holiday: the Wednesday value is last_close on Thanksgiving and the feed is not called stale", () => {
    const updatedAt = at("2026-11-25T21:30:00Z"); // Wednesday 16:30 ET
    expect(classifyAt(updatedAt, at("2026-11-26T17:00:00Z"))).toBe("last_close");
    // 36 hours old by wall clock, well past one heartbeat, but only 3.5 hours of trading time.
    expect(classifyAt(updatedAt, at("2026-11-27T00:30:00Z"))).toBe("last_close");
  });

  test("a feed frozen through a full trading day is unavailable", () => {
    // Updated Monday 10:00 ET, read Tuesday 10:16 ET: 24 h 16 min of trading time.
    expect(classifyAt(at("2026-11-16T15:00:00Z"), at("2026-11-17T15:15:00Z"))).toBe("delayed");
    expect(classifyAt(at("2026-11-16T15:00:00Z"), at("2026-11-17T15:15:01Z"))).toBe("unavailable");
  });

  test("outside the calendar a fresh value degrades to last_close, never live", () => {
    const now = at("2028-03-01T16:00:00Z"); // a Wednesday in a year the table does not cover
    expect(classifyAt(now - 60, now)).toBe("last_close");
    expect(classifyAt(now - UNCOVERED_MAX_AGE_SECONDS - 1, now)).toBe("unavailable");
  });
});
