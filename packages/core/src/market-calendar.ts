/**
 * US equity market calendar, as a pure function of time.
 *
 * The reference feeds for tokenized stocks follow the US equity "24/5" schedule: they publish from Sunday 20:00
 * to Friday 20:00 Eastern Time and hold their last value on weekends and market holidays. This module answers
 * two questions about that schedule: which phase the market is in at an instant, and how many seconds of trading
 * time elapsed between two instants.
 *
 * Model, deliberately simple:
 * - A trading day is a weekday that is not a full closure. Its window runs from 20:00 ET on the previous
 *   calendar day (the overnight session) to 20:00 ET on the day itself, or to 17:00 ET on an early-close day.
 * - The regular session is 09:30 to 16:00 ET, or 09:30 to 13:00 ET on an early-close day.
 * - Everything else is closed.
 *
 * The holiday table is static and bounded by `CALENDAR_FIRST_DATE` and `CALENDAR_LAST_DATE`. Outside those
 * bounds the answer is "unknown", never a guess. Unscheduled halts are not modelled.
 *
 * All instants are Unix seconds. No clock is read here: the caller passes the time.
 */

const SECONDS_PER_HOUR = 3_600;
const SECONDS_PER_DAY = 86_400;
const MILLISECONDS_PER_DAY = 86_400_000;

/** First and last Eastern Time calendar dates covered by the holiday table, inclusive. */
export const CALENDAR_FIRST_DATE = "2026-01-01";
export const CALENDAR_LAST_DATE = "2027-12-31";

/** Full-day closures published by NYSE for 2026 and 2027 (Eastern Time dates). */
const FULL_CLOSURES: readonly string[] = [
  "2026-01-01", // New Year's Day
  "2026-01-19", // Martin Luther King Jr. Day
  "2026-02-16", // Washington's Birthday
  "2026-04-03", // Good Friday
  "2026-05-25", // Memorial Day
  "2026-06-19", // Juneteenth
  "2026-07-03", // Independence Day, observed
  "2026-09-07", // Labor Day
  "2026-11-26", // Thanksgiving Day
  "2026-12-25", // Christmas Day
  "2027-01-01", // New Year's Day
  "2027-01-18", // Martin Luther King Jr. Day
  "2027-02-15", // Washington's Birthday
  "2027-03-26", // Good Friday
  "2027-05-31", // Memorial Day
  "2027-06-18", // Juneteenth, observed
  "2027-07-05", // Independence Day, observed
  "2027-09-06", // Labor Day
  "2027-11-25", // Thanksgiving Day
  "2027-12-24", // Christmas Day, observed
];

/** Days with a 13:00 ET close of the regular session and a 17:00 ET close of the late session. */
const EARLY_CLOSES: readonly string[] = [
  "2026-11-27", // day after Thanksgiving
  "2026-12-24", // Christmas Eve
  "2027-11-26", // day after Thanksgiving
];

const OVERNIGHT_OPEN = 20 * SECONDS_PER_HOUR;
const REGULAR_OPEN = 9 * SECONDS_PER_HOUR + 30 * 60;
const REGULAR_CLOSE = 16 * SECONDS_PER_HOUR;
const EXTENDED_CLOSE = 20 * SECONDS_PER_HOUR;
const EARLY_REGULAR_CLOSE = 13 * SECONDS_PER_HOUR;
const EARLY_EXTENDED_CLOSE = 17 * SECONDS_PER_HOUR;

/** Days since 1970-01-01 of an ISO calendar date. */
function dayNumber(isoDate: string): number {
  return Date.parse(`${isoDate}T00:00:00Z`) / MILLISECONDS_PER_DAY;
}

const FIRST_DAY = dayNumber(CALENDAR_FIRST_DATE);
const LAST_DAY = dayNumber(CALENDAR_LAST_DATE);
const FULL_CLOSURE_DAYS: ReadonlySet<number> = new Set(FULL_CLOSURES.map(dayNumber));
const EARLY_CLOSE_DAYS: ReadonlySet<number> = new Set(EARLY_CLOSES.map(dayNumber));

/** Day number of the `n`th Sunday of a month. 1970-01-01 was a Thursday. */
function nthSunday(year: number, monthIndex: number, n: number): number {
  const first = Date.UTC(year, monthIndex, 1) / MILLISECONDS_PER_DAY;
  const weekday = (((first + 4) % 7) + 7) % 7;
  return first + ((7 - weekday) % 7) + 7 * (n - 1);
}

/**
 * Offset of Eastern Time from UTC in seconds: daylight time (UTC-4) from the second Sunday of March at 02:00
 * local to the first Sunday of November at 02:00 local, standard time (UTC-5) otherwise.
 */
function easternOffset(unixSeconds: number): number {
  const year = new Date(unixSeconds * 1000).getUTCFullYear();
  const daylightStart = nthSunday(year, 2, 2) * SECONDS_PER_DAY + 7 * SECONDS_PER_HOUR;
  const daylightEnd = nthSunday(year, 10, 1) * SECONDS_PER_DAY + 6 * SECONDS_PER_HOUR;
  return unixSeconds >= daylightStart && unixSeconds < daylightEnd ? -4 * SECONDS_PER_HOUR : -5 * SECONDS_PER_HOUR;
}

/** Unix seconds of a wall-clock time in Eastern Time. Never called with a time inside a clock change. */
function easternToUnix(day: number, secondOfDay: number): number {
  const local = day * SECONDS_PER_DAY + secondOfDay;
  const daylight = local + 4 * SECONDS_PER_HOUR;
  return easternOffset(daylight) === -4 * SECONDS_PER_HOUR ? daylight : local + 5 * SECONDS_PER_HOUR;
}

/** The Eastern Time date whose trading window could contain the instant: the next date from 20:00 ET on. */
function tradingDate(unixSeconds: number): number {
  const local = unixSeconds + easternOffset(unixSeconds);
  const day = Math.floor(local / SECONDS_PER_DAY);
  return local - day * SECONDS_PER_DAY >= OVERNIGHT_OPEN ? day + 1 : day;
}

interface TradingWindow {
  readonly start: number;
  readonly end: number;
  readonly regularStart: number;
  readonly regularEnd: number;
}

/** The trading window of a date, "closed" for a weekend or holiday, "uncovered" outside the holiday table. */
function tradingWindow(day: number): TradingWindow | "closed" | "uncovered" {
  if (day < FIRST_DAY || day > LAST_DAY) return "uncovered";
  const weekday = (day + 4) % 7;
  if (weekday === 0 || weekday === 6 || FULL_CLOSURE_DAYS.has(day)) return "closed";
  const early = EARLY_CLOSE_DAYS.has(day);
  return {
    start: easternToUnix(day - 1, OVERNIGHT_OPEN),
    end: easternToUnix(day, early ? EARLY_EXTENDED_CLOSE : EXTENDED_CLOSE),
    regularStart: easternToUnix(day, REGULAR_OPEN),
    regularEnd: easternToUnix(day, early ? EARLY_REGULAR_CLOSE : REGULAR_CLOSE),
  };
}

/** Phase of the US equity market. "extended" covers the pre-market, post-market and overnight sessions. */
export type MarketPhase = "regular" | "extended" | "closed";

/**
 * Phase of the market at an instant, or "unknown" when the holiday table does not cover it.
 *
 * @param unixSeconds instant in Unix seconds
 */
export function marketPhaseAt(unixSeconds: number): MarketPhase | "unknown" {
  if (!Number.isSafeInteger(unixSeconds)) return "unknown";
  const window = tradingWindow(tradingDate(unixSeconds));
  if (window === "uncovered") return "unknown";
  if (window === "closed" || unixSeconds >= window.end) return "closed";
  return unixSeconds >= window.regularStart && unixSeconds < window.regularEnd ? "regular" : "extended";
}

/**
 * Seconds of trading time (regular and extended sessions) in the half-open interval `[from, to)`.
 * Returns `null` when any part of the interval falls outside the holiday table, and 0 when `to <= from`.
 *
 * @param from start instant in Unix seconds
 * @param to end instant in Unix seconds
 */
export function tradingSecondsBetween(from: number, to: number): number | null {
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to)) return null;
  const firstDay = tradingDate(from);
  const lastDay = tradingDate(to);
  if (firstDay < FIRST_DAY || lastDay > LAST_DAY) return null;
  let total = 0;
  for (let day = firstDay; day <= lastDay; day += 1) {
    const window = tradingWindow(day);
    if (window === "uncovered") return null;
    if (window === "closed") continue;
    total += Math.max(0, Math.min(to, window.end) - Math.max(from, window.start));
  }
  return total;
}

/**
 * The market context a staleness decision needs: the phase now, and how much trading time passed since the
 * value was published. "unknown" when the calendar cannot answer either question.
 */
export type MarketSession =
  | { readonly phase: MarketPhase; readonly tradingSecondsSinceUpdate: number }
  | { readonly phase: "unknown" };

/**
 * Market session for a value published at `updatedAt` and observed at `now`.
 *
 * @param updatedAt publication time in Unix seconds
 * @param now observation time in Unix seconds
 */
export function marketSession(updatedAt: number, now: number): MarketSession {
  const phase = marketPhaseAt(now);
  const tradingSecondsSinceUpdate = tradingSecondsBetween(updatedAt, now);
  if (phase === "unknown" || tradingSecondsSinceUpdate === null) return { phase: "unknown" };
  return { phase, tradingSecondsSinceUpdate };
}
