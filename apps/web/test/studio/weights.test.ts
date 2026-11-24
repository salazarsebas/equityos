import { describe, expect, test } from "bun:test";
import { type Address, computeEqualWeights } from "@equityos/core";
import { bpsToPercentText, distributeRemainder, percentTextToBps, sumBps } from "../../src/lib/studio/weights";

const token = (i: number): Address => `0xb2${i.toString(16).padStart(38, "0")}`;
const weights = (...bps: number[]) => bps.map((weightBps, i) => ({ token: token(i + 1), weightBps }));

describe("percentTextToBps", () => {
  test("maps percent text to basis points exactly", () => {
    expect(percentTextToBps("12.50")).toBe(1250);
    expect(percentTextToBps("12.5")).toBe(1250);
    expect(percentTextToBps("100")).toBe(10_000);
    expect(percentTextToBps("0.01")).toBe(1);
    expect(percentTextToBps(".5")).toBe(50);
    expect(percentTextToBps("7.")).toBe(700);
    expect(percentTextToBps("  33.33 ")).toBe(3333);
    expect(percentTextToBps("")).toBe(0);
  });

  test("is exact where binary floating point is not", () => {
    // 0.29 * 100, 0.57 * 100 and 1.15 * 100 are 28.999..., 56.999... and 114.999... as doubles.
    expect(percentTextToBps("0.29")).toBe(29);
    expect(percentTextToBps("0.57")).toBe(57);
    expect(percentTextToBps("1.15")).toBe(115);
    expect(percentTextToBps("8.07")).toBe(807);
    expect(percentTextToBps("16.37")).toBe(1637);
  });

  test("every basis point from 0 to 10,000 round-trips through text", () => {
    for (let bps = 0; bps <= 10_000; bps += 1) expect(percentTextToBps(bpsToPercentText(bps))).toBe(bps);
  });

  test("rejects what is not a percentage with at most two decimals, without rounding it", () => {
    for (const text of ["12.345", "1e2", "-5", "+5", "12,5", "abc", ".", "1.2.3", "0x10", "12 5", "12345678"]) {
      expect(percentTextToBps(text)).toBeNull();
    }
  });
});

describe("bpsToPercentText", () => {
  test("always writes two decimals", () => {
    expect(bpsToPercentText(0)).toBe("0.00");
    expect(bpsToPercentText(7)).toBe("0.07");
    expect(bpsToPercentText(1250)).toBe("12.50");
    expect(bpsToPercentText(10_000)).toBe("100.00");
  });
});

describe("distributeRemainder", () => {
  test("on empty weights it is exactly the equal split of core, for every count", () => {
    for (let count = 1; count <= 64; count += 1) {
      const tokens = Array.from({ length: count }, (_, i) => token(count - i));
      const result = distributeRemainder(tokens.map((address) => ({ token: address, weightBps: 0 })));
      expect(result).toEqual(computeEqualWeights(tokens));
    }
  });

  test("splits what is missing equally and gives the indivisible part to the lowest addresses", () => {
    // 100 bps missing over 3: 33 each, and 1 more for the lowest address.
    expect(distributeRemainder(weights(5000, 3000, 1900)).map((c) => c.weightBps)).toEqual([5034, 3033, 1933]);
    // 2 bps missing over 3: the two lowest addresses get one each.
    expect(distributeRemainder(weights(3333, 3333, 3332)).map((c) => c.weightBps)).toEqual([3334, 3334, 3332]);
  });

  test("the result is in ascending token order whatever the input order", () => {
    const shuffled = [weights(1000, 2000, 3000)[2], weights(1000, 2000, 3000)[0], weights(1000, 2000, 3000)[1]];
    const result = distributeRemainder(shuffled.flatMap((entry) => entry ?? []));
    expect(result.map((c) => c.token)).toEqual([token(1), token(2), token(3)]);
    expect(sumBps(result.map((c) => c.weightBps))).toBe(10_000);
  });

  test("removes an excess in equal parts and never takes a weight under 1 bps", () => {
    expect(distributeRemainder(weights(4000, 2500, 2500, 1500)).map((c) => c.weightBps)).toEqual([
      3875, 2375, 2375, 1375,
    ]);
    const result = distributeRemainder(weights(1, 10_000, 5)).map((c) => c.weightBps);
    expect(result).toEqual([1, 9997, 2]);
    const odd = distributeRemainder(weights(5001, 5001, 1)).map((c) => c.weightBps);
    expect(odd).toEqual([4999, 5000, 1]);
  });

  test("always totals exactly 10,000 with every weight at least 1 bps, for many inputs", () => {
    let seed = 7;
    const next = (bound: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % bound;
    };
    for (let round = 0; round < 500; round += 1) {
      const count = 1 + next(64);
      const input = Array.from({ length: count }, (_, i) => ({ token: token(i + 1), weightBps: next(10_001) }));
      const result = distributeRemainder(input).map((c) => c.weightBps);
      expect(sumBps(result)).toBe(10_000);
      expect(Math.min(...result)).toBeGreaterThanOrEqual(1);
    }
  });

  test("leaves weights that already total 10,000 untouched, and an empty list empty", () => {
    expect(distributeRemainder(weights(7000, 3000)).map((c) => c.weightBps)).toEqual([7000, 3000]);
    expect(distributeRemainder([])).toEqual([]);
  });
});
