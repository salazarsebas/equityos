import { describe, expect, test } from "bun:test";
import { DEPOSIT_ERRORS, MAX_DEPOSIT_USD_E8, parseDepositUsd } from "../../src/lib/portfolio/deposit";

describe("parseDepositUsd", () => {
  test("parses a decimal string to USD scaled by 1e8, exactly", () => {
    for (const [input, expected] of [
      ["250", 25_000_000_000n],
      ["0.5", 50_000_000n],
      [".5", 50_000_000n],
      ["12.", 1_200_000_000n],
      ["1,250.50", 125_050_000_000n],
      ["0.000001", 100n],
      ["1,250.123456", 125_012_345_600n],
      ["  7  ", 700_000_000n],
      ["0", 0n],
      ["1000000000", MAX_DEPOSIT_USD_E8],
      ["0.1", 10_000_000n],
      ["0.3", 30_000_000n],
    ] as const) {
      expect([input, parseDepositUsd(input)]).toEqual([input, { ok: true, usdE8: expected }]);
    }
  });

  test("accepts exactly the amounts USDC can hold: every result is a whole number of USDC base units", () => {
    for (const input of ["0.000001", "1.5", "250.123456", "999,999,999.999999"]) {
      const parsed = parseDepositUsd(input);
      expect(parsed.ok && parsed.usdE8 % 100n === 0n).toBe(true);
    }
    expect(DEPOSIT_ERRORS.precision).toContain("6 decimals");
  });

  test("refuses what it cannot represent exactly instead of rounding", () => {
    for (const [input, reason] of [
      ["", "empty"],
      ["   ", "empty"],
      [".", "format"],
      ["-1", "format"],
      ["1e3", "format"],
      ["12,50", "format"],
      ["1,2345", "format"],
      ["$5", "format"],
      ["1.2.3", "format"],
      ["0.000000001", "precision"],
      ["0.00000099", "precision"],
      ["0.0000001", "precision"],
      ["1.1234567", "precision"],
      ["1000000000.000001", "too_large"],
    ] as const) {
      expect([input, parseDepositUsd(input)]).toEqual([input, { ok: false, reason }]);
    }
  });
});
