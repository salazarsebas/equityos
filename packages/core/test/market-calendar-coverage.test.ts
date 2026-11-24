import { describe, expect, test } from "bun:test";
import { CALENDAR_LAST_DATE } from "../src/market-calendar.ts";

/**
 * The market calendar is a static table of NYSE holidays. Outside it no price is ever `live` or `delayed`, so a
 * table that runs out degrades every reference price to `last_close` and then `unavailable`. This guard makes
 * the gap visible a quarter ahead: from October 1 of a year, the table must cover the whole of the next year.
 * NYSE publishes its holidays years ahead, so the table can always be extended before the guard fires.
 *
 * It reads the clock on purpose: it starts failing on 2027-10-01 while the table ends on 2027-12-31.
 */
function coverageProblem(today: string, lastDate: string): string | null {
  const year = Number(today.slice(0, 4));
  if (today < `${year}-10-01`) return null;
  const required = `${year + 1}-12-31`;
  if (lastDate >= required) return null;
  return `The market calendar in packages/core/src/market-calendar.ts ends on ${lastDate}. From ${year}-10-01 it must cover ${year + 1} through ${required}: add the NYSE full closures and early closes of ${year + 1}, set CALENDAR_LAST_DATE, and extend the time zone test to the new year.`;
}

describe("market calendar coverage", () => {
  test("covers the whole of the next year from October 1 of each year", () => {
    const today = new Date().toISOString().slice(0, 10);
    expect(coverageProblem(today, CALENDAR_LAST_DATE)).toBeNull();
  });

  test("the guard fires on October 1 of the last covered year and not a day before", () => {
    expect(coverageProblem("2027-09-30", "2027-12-31")).toBeNull();
    expect(coverageProblem("2027-10-01", "2027-12-31")).toContain("must cover 2028 through 2028-12-31");
    expect(coverageProblem("2027-12-31", "2027-12-31")).toContain("ends on 2027-12-31");
    expect(coverageProblem("2027-10-01", "2028-12-31")).toBeNull();
    expect(coverageProblem("2026-11-24", "2027-12-31")).toBeNull();
    expect(coverageProblem("2026-10-01", "2027-12-31")).toBeNull();
    expect(coverageProblem("2026-10-01", "2026-12-31")).not.toBeNull();
  });
});
