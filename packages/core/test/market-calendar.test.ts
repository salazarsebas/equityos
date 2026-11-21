import { describe, expect, test } from "bun:test";
import {
  CALENDAR_FIRST_DATE,
  CALENDAR_LAST_DATE,
  marketPhaseAt,
  marketSession,
  tradingSecondsBetween,
} from "../src/index.ts";

/** Unix seconds of an ISO instant. Every instant in this file is written in UTC with the ET time in a comment. */
function at(iso: string): number {
  return Date.parse(iso) / 1000;
}

const HOUR = 3_600;
const DAY = 86_400;

describe("marketPhaseAt", () => {
  test("regular session boundaries in standard time (UTC-5)", () => {
    // Friday 2026-11-20, 09:30 and 16:00 ET.
    expect(marketPhaseAt(at("2026-11-20T14:29:59Z"))).toBe("extended");
    expect(marketPhaseAt(at("2026-11-20T14:30:00Z"))).toBe("regular");
    expect(marketPhaseAt(at("2026-11-20T20:59:59Z"))).toBe("regular");
    expect(marketPhaseAt(at("2026-11-20T21:00:00Z"))).toBe("extended");
  });

  test("regular session boundaries in daylight time (UTC-4)", () => {
    // Wednesday 2026-07-08, 09:30 and 16:00 ET.
    expect(marketPhaseAt(at("2026-07-08T13:29:59Z"))).toBe("extended");
    expect(marketPhaseAt(at("2026-07-08T13:30:00Z"))).toBe("regular");
    expect(marketPhaseAt(at("2026-07-08T19:59:59Z"))).toBe("regular");
    expect(marketPhaseAt(at("2026-07-08T20:00:00Z"))).toBe("extended");
  });

  test("the week closes on Friday 20:00 ET and reopens on Sunday 20:00 ET", () => {
    expect(marketPhaseAt(at("2026-11-21T00:59:59Z"))).toBe("extended");
    expect(marketPhaseAt(at("2026-11-21T01:00:00Z"))).toBe("closed");
    expect(marketPhaseAt(at("2026-11-21T18:00:00Z"))).toBe("closed");
    expect(marketPhaseAt(at("2026-11-23T00:59:59Z"))).toBe("closed");
    expect(marketPhaseAt(at("2026-11-23T01:00:00Z"))).toBe("extended");
  });

  test("the overnight session between two trading days is extended", () => {
    // Tuesday 2026-11-17 20:00 ET to Wednesday 04:00 ET.
    expect(marketPhaseAt(at("2026-11-18T01:00:00Z"))).toBe("extended");
    expect(marketPhaseAt(at("2026-11-18T06:00:00Z"))).toBe("extended");
  });

  test("a holiday is closed from 20:00 ET the evening before to 20:00 ET on the day", () => {
    // Thanksgiving, Thursday 2026-11-26.
    expect(marketPhaseAt(at("2026-11-26T00:59:59Z"))).toBe("extended");
    expect(marketPhaseAt(at("2026-11-26T01:00:00Z"))).toBe("closed");
    expect(marketPhaseAt(at("2026-11-26T17:00:00Z"))).toBe("closed");
    expect(marketPhaseAt(at("2026-11-27T00:59:59Z"))).toBe("closed");
    expect(marketPhaseAt(at("2026-11-27T01:00:00Z"))).toBe("extended");
  });

  test("an early-close day ends the regular session at 13:00 ET and the late session at 17:00 ET", () => {
    // Friday 2026-11-27.
    expect(marketPhaseAt(at("2026-11-27T17:59:59Z"))).toBe("regular");
    expect(marketPhaseAt(at("2026-11-27T18:00:00Z"))).toBe("extended");
    expect(marketPhaseAt(at("2026-11-27T21:59:59Z"))).toBe("extended");
    expect(marketPhaseAt(at("2026-11-27T22:00:00Z"))).toBe("closed");
  });

  test("a Monday holiday keeps the market closed through the long weekend", () => {
    // Martin Luther King Jr. Day, Monday 2027-01-18. Reopens Monday 20:00 ET.
    expect(marketPhaseAt(at("2027-01-18T15:00:00Z"))).toBe("closed");
    expect(marketPhaseAt(at("2027-01-19T00:59:59Z"))).toBe("closed");
    expect(marketPhaseAt(at("2027-01-19T01:00:00Z"))).toBe("extended");
  });

  test("is unknown outside the holiday table and for a non-integer instant", () => {
    expect(marketPhaseAt(at("2025-12-31T17:00:00Z"))).toBe("unknown");
    // 2027-12-31 20:00 ET belongs to the trading window of 2028-01-01, which is not covered.
    expect(marketPhaseAt(at("2028-01-01T00:59:59Z"))).toBe("extended");
    expect(marketPhaseAt(at("2028-01-01T01:00:00Z"))).toBe("unknown");
    expect(marketPhaseAt(at("2028-06-01T15:00:00Z"))).toBe("unknown");
    expect(marketPhaseAt(1.5)).toBe("unknown");
    expect(marketPhaseAt(Number.NaN)).toBe("unknown");
  });

  test("agrees with the IANA time zone database for every hour of the covered years", () => {
    const format = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      weekday: "short",
    });
    const holidays = new Set([
      "2026-01-01",
      "2026-01-19",
      "2026-02-16",
      "2026-04-03",
      "2026-05-25",
      "2026-06-19",
      "2026-07-03",
      "2026-09-07",
      "2026-11-26",
      "2026-12-25",
      "2027-01-01",
      "2027-01-18",
      "2027-02-15",
      "2027-03-26",
      "2027-05-31",
      "2027-06-18",
      "2027-07-05",
      "2027-09-06",
      "2027-11-25",
      "2027-12-24",
    ]);
    const earlyCloses = new Set(["2026-11-27", "2026-12-24", "2027-11-26"]);
    const isTradingDay = (date: string, weekday: string) =>
      weekday !== "Sat" && weekday !== "Sun" && !holidays.has(date);
    const local = (unixSeconds: number) => {
      const parts = Object.fromEntries(format.formatToParts(unixSeconds * 1000).map((part) => [part.type, part.value]));
      return {
        date: `${parts.year}-${parts.month}-${parts.day}`,
        weekday: parts.weekday ?? "",
        minutes: Number(parts.hour) * 60 + Number(parts.minute),
      };
    };
    // Sampled at half past each hour, so that 09:30 ET is a sample and no sample sits on an hour boundary twice.
    const mismatches: string[] = [];
    for (let t = at("2026-01-02T00:30:00Z"); t < at("2027-12-31T00:00:00Z"); t += HOUR) {
      const here = local(t);
      // Twelve hours ahead of an evening instant is always the next calendar date, also across a clock change.
      const next = local(t + 12 * HOUR);
      let expected: string;
      if (here.minutes >= 20 * 60) {
        expected = isTradingDay(next.date, next.weekday) ? "extended" : "closed";
      } else if (!isTradingDay(here.date, here.weekday)) {
        expected = "closed";
      } else {
        const early = earlyCloses.has(here.date);
        if (here.minutes >= (early ? 17 : 20) * 60) expected = "closed";
        else expected = here.minutes >= 9 * 60 + 30 && here.minutes < (early ? 13 : 16) * 60 ? "regular" : "extended";
      }
      const actual = marketPhaseAt(t);
      if (actual !== expected) mismatches.push(`${new Date(t * 1000).toISOString()}: ${actual} != ${expected}`);
    }
    expect(mismatches).toEqual([]);
  });

  test("the published bounds match the table", () => {
    expect(CALENDAR_FIRST_DATE).toBe("2026-01-01");
    expect(CALENDAR_LAST_DATE).toBe("2027-12-31");
  });
});

describe("tradingSecondsBetween", () => {
  test("equals wall-clock time inside one trading week", () => {
    expect(tradingSecondsBetween(at("2026-11-17T15:00:00Z"), at("2026-11-19T15:00:00Z"))).toBe(2 * DAY);
  });

  test("excludes the weekend", () => {
    // Friday 18:42:40 ET to Monday 10:00 ET: 4,640 s to the Friday close, then 14 h from the Sunday open.
    const updatedAt = at("2026-11-20T23:42:40Z");
    expect(tradingSecondsBetween(updatedAt, at("2026-11-21T18:00:00Z"))).toBe(4_640);
    expect(tradingSecondsBetween(updatedAt, at("2026-11-23T15:00:00Z"))).toBe(4_640 + 14 * HOUR);
  });

  test("excludes a holiday and the hours after an early close", () => {
    // Wednesday 2026-11-25 19:00 ET to Sunday 2026-11-29 21:00 ET:
    // 1 h on Wednesday, Thursday closed, 21 h in the Friday window (Thursday 20:00 to Friday 17:00 ET), 1 h Sunday.
    expect(tradingSecondsBetween(at("2026-11-26T00:00:00Z"), at("2026-11-30T02:00:00Z"))).toBe(23 * HOUR);
  });

  test("is zero for an empty or reversed interval", () => {
    const t = at("2026-11-18T15:00:00Z");
    expect(tradingSecondsBetween(t, t)).toBe(0);
    expect(tradingSecondsBetween(t + 60, t)).toBe(0);
  });

  test("is null when the interval leaves the holiday table", () => {
    expect(tradingSecondsBetween(at("2025-12-30T15:00:00Z"), at("2026-01-05T15:00:00Z"))).toBeNull();
    expect(tradingSecondsBetween(at("2027-12-30T15:00:00Z"), at("2028-01-03T15:00:00Z"))).toBeNull();
    expect(tradingSecondsBetween(0, at("2026-11-18T15:00:00Z"))).toBeNull();
    expect(tradingSecondsBetween(Number.NaN, at("2026-11-18T15:00:00Z"))).toBeNull();
  });

  test("counts 23 or 25 hours across a clock change without drifting", () => {
    // Daylight time starts Sunday 2026-03-08: the Monday window opens Sunday 20:00 EDT, which is 00:00 UTC.
    expect(marketPhaseAt(at("2026-03-08T23:59:59Z"))).toBe("closed");
    expect(marketPhaseAt(at("2026-03-09T00:00:00Z"))).toBe("extended");
    // Daylight time ends Sunday 2026-11-01: the Monday window opens Sunday 20:00 EST, which is 01:00 UTC.
    expect(marketPhaseAt(at("2026-11-02T00:59:59Z"))).toBe("closed");
    expect(marketPhaseAt(at("2026-11-02T01:00:00Z"))).toBe("extended");
  });
});

describe("marketSession", () => {
  test("combines the phase now with the trading time since the update", () => {
    expect(marketSession(at("2026-11-20T23:42:40Z"), at("2026-11-21T18:00:00Z"))).toEqual({
      phase: "closed",
      tradingSecondsSinceUpdate: 4_640,
    });
    expect(marketSession(at("2026-11-20T15:00:00Z"), at("2026-11-20T15:10:00Z"))).toEqual({
      phase: "regular",
      tradingSecondsSinceUpdate: 600,
    });
  });

  test("is unknown when either the phase or the trading time is unknown", () => {
    expect(marketSession(at("2027-12-30T15:00:00Z"), at("2028-01-03T15:00:00Z"))).toEqual({ phase: "unknown" });
    expect(marketSession(0, at("2026-11-20T15:00:00Z"))).toEqual({ phase: "unknown" });
  });
});
