import { describe, expect, test } from "bun:test";
import {
  formatCompact,
  formatCount,
  formatFixed,
  formatPercent,
  formatPercentagePoints,
  formatPrice,
  formatRelativeTime,
  formatSignedPercent,
  formatTokenQuantity,
  formatUsd,
  formatUtcDate,
  formatUtcDateTime,
  formatUtcMinute,
  MINUS,
  shortenAddress,
  shortenHash,
  toIsoInstant,
} from "../src/lib/format";

const E18 = 10n ** 18n;

describe("formatFixed", () => {
  test("groups thousands and pads decimals", () => {
    expect(formatFixed(1_084_270_000n, 6, 2)).toBe("1,084.27");
    expect(formatFixed(5n, 2, 2)).toBe("0.05");
    expect(formatFixed(0n, 6, 2)).toBe("0.00");
    expect(formatFixed(7n, 0, 2)).toBe("7.00");
  });

  test("rounds half away from zero", () => {
    expect(formatFixed(1_005n, 3, 2)).toBe("1.01");
    expect(formatFixed(1_004n, 3, 2)).toBe("1.00");
    expect(formatFixed(-1_005n, 3, 2)).toBe(`${MINUS}1.01`);
    expect(formatFixed(999_995n, 3, 2)).toBe("1,000.00");
  });

  test("renders a value that rounds to zero without a sign", () => {
    expect(formatFixed(-4n, 3, 2)).toBe("0.00");
  });

  test("handles values far beyond the safe integer range exactly", () => {
    expect(formatFixed(123_456_789_012_345_678_901_234_567_890n * E18 + 5n * 10n ** 17n, 18, 2)).toBe(
      "123,456,789,012,345,678,901,234,567,890.50",
    );
  });

  test("rejects an invalid decimal count", () => {
    expect(() => formatFixed(1n, -1, 2)).toThrow(RangeError);
    expect(() => formatFixed(1n, 1.5, 2)).toThrow(RangeError);
  });
});

describe("formatCount", () => {
  test("uses separators and never abbreviates", () => {
    expect(formatCount(0n)).toBe("0");
    expect(formatCount(1_204n)).toBe("1,204");
    expect(formatCount(12_345_678n)).toBe("12,345,678");
    expect(formatCount(-1_000n)).toBe(`${MINUS}1,000`);
  });
});

describe("percent from basis points", () => {
  test("formatPercent always shows two decimals", () => {
    expect(formatPercent(1_500n)).toBe("15.00%");
    expect(formatPercent(10_000n)).toBe("100.00%");
    expect(formatPercent(1n)).toBe("0.01%");
    expect(formatPercent(0n)).toBe("0.00%");
    expect(formatPercent(-38n)).toBe(`${MINUS}0.38%`);
  });

  test("formatSignedPercent signs every non-zero value and leaves zero unsigned", () => {
    expect(formatSignedPercent(342n)).toBe("+3.42%");
    expect(formatSignedPercent(-38n)).toBe(`${MINUS}0.38%`);
    expect(formatSignedPercent(0n)).toBe("0.00%");
    expect(formatSignedPercent(1_234_567n)).toBe("+12,345.67%");
  });

  test("formatPercentagePoints uses the pp unit", () => {
    expect(formatPercentagePoints(321n)).toBe("+3.21 pp");
    expect(formatPercentagePoints(-200n)).toBe(`${MINUS}2.00 pp`);
    expect(formatPercentagePoints(0n)).toBe("0.00 pp");
  });
});

describe("formatUsd", () => {
  test("formats six-decimal amounts to cents", () => {
    expect(formatUsd(12_480_330_000n, 6)).toBe("12,480.33");
    expect(formatUsd(0n, 6)).toBe("0.00");
    expect(formatUsd(-250_000_000n, 6)).toBe(`${MINUS}250.00`);
  });

  test("rounds half away from zero at the cent", () => {
    expect(formatUsd(1_005_000n, 6)).toBe("1.01");
    expect(formatUsd(1_004_999n, 6)).toBe("1.00");
    expect(formatUsd(-1_005_000n, 6)).toBe(`${MINUS}1.01`);
  });

  test("marks non-zero amounts under one cent instead of rounding them", () => {
    expect(formatUsd(1n, 6)).toBe("<0.01");
    expect(formatUsd(9_999n, 6)).toBe("<0.01");
    expect(formatUsd(-9_999n, 6)).toBe(`${MINUS}<0.01`);
    expect(formatUsd(10_000n, 6)).toBe("0.01");
  });

  test("handles 18-decimal amounts far beyond the safe integer range", () => {
    expect(formatUsd(98_765_432_109_876_543_210n * E18, 18)).toBe("98,765,432,109,876,543,210.00");
  });
});

describe("formatPrice", () => {
  test("uses two decimals at or above 1.00 and four below", () => {
    expect(formatPrice(184_270_000n, 6)).toBe("184.27");
    expect(formatPrice(1_000_000n, 6)).toBe("1.00");
    expect(formatPrice(999_999n, 6)).toBe("1.0000");
    expect(formatPrice(412_350n, 6)).toBe("0.4124");
    expect(formatPrice(0n, 6)).toBe("0.0000");
  });
});

describe("formatTokenQuantity", () => {
  test("keeps up to six significant digits and trims trailing zeros", () => {
    expect(formatTokenQuantity(4_203_100_000_000_000_000n, 18)).toBe("4.2031");
    expect(formatTokenQuantity(412n, 6)).toBe("0.000412");
    expect(formatTokenQuantity(10n * E18, 18)).toBe("10");
    expect(formatTokenQuantity(1_500_000n, 6)).toBe("1.5");
    expect(formatTokenQuantity(0n, 18)).toBe("0");
  });

  test("rounds toward zero", () => {
    expect(formatTokenQuantity(1_999_999_999_999_999_999n, 18)).toBe("1.99999");
    expect(formatTokenQuantity(123_456_789n, 6)).toBe("123.456");
    expect(formatTokenQuantity(-123_456_789n, 6)).toBe(`${MINUS}123.456`);
  });

  test("never shortens the integer part and never uses scientific notation", () => {
    expect(formatTokenQuantity(1_234_567_890_000n, 3)).toBe("1,234,567,890");
    expect(formatTokenQuantity(123_456_700n, 2)).toBe("1,234,567");
    expect(formatTokenQuantity(1n, 18)).toBe("0.000000000000000001");
    expect(formatTokenQuantity(123_456_789n, 18)).toBe("0.000000000123456");
  });

  test("supports tokens with zero decimals", () => {
    expect(formatTokenQuantity(42n, 0)).toBe("42");
  });
});

describe("formatCompact", () => {
  test("renders values under one million in full", () => {
    expect(formatCompact(0n)).toBe("0");
    expect(formatCompact(999_999n)).toBe("999,999");
    expect(formatCompact(12_480_330_000n, 6)).toBe("12,480");
  });

  test("abbreviates from one million with one decimal", () => {
    expect(formatCompact(1_000_000n)).toBe("1.0M");
    expect(formatCompact(1_249_999n)).toBe("1.2M");
    expect(formatCompact(1_250_000n)).toBe("1.3M");
    expect(formatCompact(3_400_000_000n)).toBe("3.4B");
    expect(formatCompact(2_500_000_000_000n)).toBe("2.5T");
    expect(formatCompact(1_200_000_000_000n, 6)).toBe("1.2M");
    expect(formatCompact(-1_200_000n)).toBe(`${MINUS}1.2M`);
  });

  test("moves to the next unit when rounding reaches one thousand", () => {
    expect(formatCompact(999_949_999n)).toBe("999.9M");
    expect(formatCompact(999_950_000n)).toBe("1.0B");
    expect(formatCompact(999_950_000_000n)).toBe("1.0T");
  });

  test("keeps the largest unit for values beyond it", () => {
    expect(formatCompact(12_345_000_000_000_000n)).toBe("12,345.0T");
  });
});

describe("timestamps", () => {
  const instant = 1_795_208_400n; // 2026-11-20 21:00:00 UTC

  test("formats absolute UTC values", () => {
    expect(formatUtcDateTime(instant)).toBe("2026-11-20 21:00 UTC");
    expect(formatUtcMinute(instant)).toBe("2026-11-20 21:00");
    expect(formatUtcDate(instant)).toBe("2026-11-20");
    expect(toIsoInstant(instant)).toBe("2026-11-20T21:00:00.000Z");
    expect(formatUtcDateTime(0n)).toBe("1970-01-01 00:00 UTC");
    expect(formatUtcDate(-1n)).toBe("1969-12-31");
  });

  test("rejects timestamps outside the representable range", () => {
    expect(() => formatUtcDate(10n ** 16n)).toThrow(RangeError);
  });

  test("formats relative values in the largest whole unit, rounded down", () => {
    expect(formatRelativeTime(instant, instant)).toBe("now");
    expect(formatRelativeTime(instant - 4n, instant)).toBe("4 s ago");
    expect(formatRelativeTime(instant - 59n, instant)).toBe("59 s ago");
    expect(formatRelativeTime(instant - 60n, instant)).toBe("1 min ago");
    expect(formatRelativeTime(instant - 3_599n, instant)).toBe("59 min ago");
    expect(formatRelativeTime(instant - 7_200n, instant)).toBe("2 h ago");
    expect(formatRelativeTime(instant - 86_400n * 1_500n, instant)).toBe("1,500 d ago");
    expect(formatRelativeTime(instant + 90n, instant)).toBe("in 1 min");
  });
});

describe("shortenAddress", () => {
  test("keeps the first six and last four characters", () => {
    expect(shortenAddress("0x1234567890abcdef1234567890abcdef1234abcd")).toBe("0x1234...abcd");
  });

  test("rejects anything that is not a 20-byte hex address", () => {
    expect(() => shortenAddress("0x1234")).toThrow(TypeError);
    expect(() => shortenAddress("1234567890abcdef1234567890abcdef1234abcd00")).toThrow(TypeError);
    expect(() => shortenAddress("0xZZ34567890abcdef1234567890abcdef1234abcd")).toThrow(TypeError);
  });
});

describe("shortenHash", () => {
  test("keeps the first eight hexadecimal digits of a 32-byte value", () => {
    expect(shortenHash("0x90d5104e4313a341690a14046df6da168cd3c1924f5ceca79cdc8b3b51fe74f6")).toBe("0x90d5104e");
  });

  test("rejects anything that is not 32 bytes of hexadecimal", () => {
    expect(() => shortenHash("0x90d5104e")).toThrow(TypeError);
    expect(() => shortenHash("0x1234567890abcdef1234567890abcdef1234abcd")).toThrow(TypeError);
  });
});
