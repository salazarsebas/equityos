import { describe, expect, test } from "bun:test";
import { BPS, DivisionByZeroError, mulDivDown, mulDivUp, NegativeOperandError } from "../src/index.ts";

const UINT256_MAX = 2n ** 256n - 1n;

describe("BPS", () => {
  test("is 10_000 so that one basis point is 0.01%", () => {
    expect(BPS).toBe(10_000n);
  });
});

describe("mulDivDown", () => {
  test("returns the exact quotient when the division has no remainder", () => {
    expect(mulDivDown(6n, 4n, 3n)).toBe(8n);
  });

  test("rounds toward zero when the division has a remainder", () => {
    expect(mulDivDown(10n, 1n, 3n)).toBe(3n);
    expect(mulDivDown(1n, 1n, 2n)).toBe(0n);
    expect(mulDivDown(2n, 5n, 3n)).toBe(3n);
  });

  test("returns zero when either factor is zero", () => {
    expect(mulDivDown(0n, 5n, 3n)).toBe(0n);
    expect(mulDivDown(5n, 0n, 3n)).toBe(0n);
  });

  test("applies a basis-point weight to an amount", () => {
    expect(mulDivDown(1_000_000n, 2_500n, BPS)).toBe(250_000n);
    expect(mulDivDown(999n, 3_333n, BPS)).toBe(332n);
  });

  test("does not lose precision when the product exceeds 256 bits", () => {
    expect(mulDivDown(UINT256_MAX, UINT256_MAX, UINT256_MAX)).toBe(UINT256_MAX);
    expect(mulDivDown(UINT256_MAX, 3n, 2n)).toBe((UINT256_MAX * 3n - 1n) / 2n);
  });
});

describe("mulDivUp", () => {
  test("returns the exact quotient when the division has no remainder", () => {
    expect(mulDivUp(6n, 4n, 3n)).toBe(8n);
  });

  test("rounds away from zero when the division has a remainder", () => {
    expect(mulDivUp(10n, 1n, 3n)).toBe(4n);
    expect(mulDivUp(1n, 1n, 2n)).toBe(1n);
    expect(mulDivUp(2n, 5n, 3n)).toBe(4n);
  });

  test("returns zero when either factor is zero", () => {
    expect(mulDivUp(0n, 5n, 3n)).toBe(0n);
    expect(mulDivUp(5n, 0n, 3n)).toBe(0n);
  });

  test("applies a basis-point weight to an amount", () => {
    expect(mulDivUp(1_000_000n, 2_500n, BPS)).toBe(250_000n);
    expect(mulDivUp(999n, 3_333n, BPS)).toBe(333n);
  });

  test("does not lose precision when the product exceeds 256 bits", () => {
    expect(mulDivUp(UINT256_MAX, UINT256_MAX, UINT256_MAX)).toBe(UINT256_MAX);
    expect(mulDivUp(UINT256_MAX, 3n, 2n)).toBe((UINT256_MAX * 3n + 1n) / 2n);
  });
});

describe("rounding relationship", () => {
  test("up and down agree on exact divisions and differ by one otherwise", () => {
    for (let a = 0n; a <= 12n; a++) {
      for (let b = 0n; b <= 12n; b++) {
        for (let denominator = 1n; denominator <= 7n; denominator++) {
          const down = mulDivDown(a, b, denominator);
          const up = mulDivUp(a, b, denominator);
          const exact = (a * b) % denominator === 0n;
          expect(up - down).toBe(exact ? 0n : 1n);
          expect(down * denominator <= a * b).toBe(true);
          expect(up * denominator >= a * b).toBe(true);
        }
      }
    }
  });
});

describe.each([
  ["mulDivDown", mulDivDown],
  ["mulDivUp", mulDivUp],
] as const)("%s operand validation", (_name, mulDiv) => {
  test("throws DivisionByZeroError when the denominator is zero", () => {
    expect(() => mulDiv(1n, 1n, 0n)).toThrow(DivisionByZeroError);
    expect(() => mulDiv(0n, 0n, 0n)).toThrow(DivisionByZeroError);
  });

  test("reports division by zero before a negative operand", () => {
    expect(() => mulDiv(-1n, 1n, 0n)).toThrow(DivisionByZeroError);
  });

  test("throws NegativeOperandError naming the negative operand", () => {
    expect(() => mulDiv(-1n, 1n, 1n)).toThrow(new NegativeOperandError("a", -1n));
    expect(() => mulDiv(1n, -2n, 1n)).toThrow(new NegativeOperandError("b", -2n));
    expect(() => mulDiv(1n, 1n, -3n)).toThrow(new NegativeOperandError("denominator", -3n));
  });

  test("errors are RangeError instances with a stable name", () => {
    const zero = new DivisionByZeroError();
    const negative = new NegativeOperandError("a", -1n);
    expect(zero).toBeInstanceOf(RangeError);
    expect(zero.name).toBe("DivisionByZeroError");
    expect(negative).toBeInstanceOf(RangeError);
    expect(negative.name).toBe("NegativeOperandError");
    expect(negative.message).toBe("a must not be negative, received -1");
  });
});
