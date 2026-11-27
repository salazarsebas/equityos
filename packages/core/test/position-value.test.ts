import { describe, expect, test } from "bun:test";
import {
  InvalidDecimalsError,
  MAX_TOKEN_DECIMALS,
  NegativeOperandError,
  positionValueUsdE8,
  USD_E8,
} from "../src/index.ts";

describe("positionValueUsdE8", () => {
  test("one whole token is worth exactly its price", () => {
    expect(positionValueUsdE8(100_000_000n, 12_982_480_034n, 8, "down")).toBe(12_982_480_034n);
    expect(positionValueUsdE8(10n ** 18n, 12_982_480_034n, 18, "up")).toBe(12_982_480_034n);
  });

  test("uses the token decimals, not the price scale", () => {
    // 2.5 tokens at 100.00 USD.
    expect(positionValueUsdE8(2_500_000n, 100n * USD_E8, 6, "down")).toBe(250n * USD_E8);
    expect(positionValueUsdE8(25n * 10n ** 17n, 100n * USD_E8, 18, "down")).toBe(250n * USD_E8);
    expect(positionValueUsdE8(250n, 100n * USD_E8, 2, "down")).toBe(250n * USD_E8);
    expect(positionValueUsdE8(3n, 100n * USD_E8, 0, "down")).toBe(300n * USD_E8);
  });

  test("rounds down or up by exactly one unit when the division is inexact", () => {
    // 0.00000001 token (1 base unit, 8 decimals) at 129.82480034 USD is 0.0000012982480034 USD.
    expect(positionValueUsdE8(1n, 12_982_480_034n, 8, "down")).toBe(129n);
    expect(positionValueUsdE8(1n, 12_982_480_034n, 8, "up")).toBe(130n);
    expect(positionValueUsdE8(1n, 1n, 18, "down")).toBe(0n);
    expect(positionValueUsdE8(1n, 1n, 18, "up")).toBe(1n);
  });

  test("both directions agree when the division is exact", () => {
    expect(positionValueUsdE8(50_000_000n, 2n * USD_E8, 8, "down")).toBe(USD_E8);
    expect(positionValueUsdE8(50_000_000n, 2n * USD_E8, 8, "up")).toBe(USD_E8);
  });

  test("a zero balance or a zero price is worth zero in both directions", () => {
    expect(positionValueUsdE8(0n, 12_982_480_034n, 8, "up")).toBe(0n);
    expect(positionValueUsdE8(123n, 0n, 8, "up")).toBe(0n);
  });

  test("does not lose precision on a full supply", () => {
    // Recorded total supply of one token (6,201,973,777,574 base units) at its recorded price.
    expect(positionValueUsdE8(6_201_973_777_574n, 12_982_480_034n, 8, "down")).toBe(805_170_007_387_460n);
    expect(positionValueUsdE8(6_201_973_777_574n, 12_982_480_034n, 8, "up")).toBe(805_170_007_387_461n);
  });

  test("rejects negative operands", () => {
    expect(() => positionValueUsdE8(-1n, 1n, 8, "down")).toThrow(NegativeOperandError);
    expect(() => positionValueUsdE8(1n, -1n, 8, "up")).toThrow(NegativeOperandError);
  });

  test("rejects a decimal count that is not an integer in range", () => {
    for (const decimals of [-1, 1.5, MAX_TOKEN_DECIMALS + 1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => positionValueUsdE8(1n, 1n, decimals, "down")).toThrow(InvalidDecimalsError);
    }
    expect(() => positionValueUsdE8(1n, 1n, 37, "down")).toThrow(
      "token decimals must be an integer between 0 and 36, received 37",
    );
    expect(new InvalidDecimalsError(37).name).toBe("InvalidDecimalsError");
    expect(positionValueUsdE8(10n ** 36n, 7n, MAX_TOKEN_DECIMALS, "down")).toBe(7n);
  });
});
