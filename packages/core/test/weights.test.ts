import { describe, expect, test } from "bun:test";
import {
  type Address,
  type Constituent,
  computeConstituents,
  computeWeights,
  validateSpec,
  WeightCalculationError,
  type WeightConstraints,
  type WeightErrorCode,
  type WeightInput,
} from "../src/index.ts";
import { address, baseSpec, createRandom, range } from "./helpers.ts";

function inputs(rawWeights: readonly (number | bigint)[]): WeightInput[] {
  return rawWeights.map((rawWeight, i) => ({ token: address(i + 1), rawWeight: BigInt(rawWeight) }));
}

function weightsBps(rawWeights: readonly (number | bigint)[], constraints?: WeightConstraints): number[] {
  return computeWeights(inputs(rawWeights), constraints).map(({ weightBps }) => weightBps);
}

function errorCode(run: () => unknown): WeightErrorCode | "no error" {
  try {
    run();
  } catch (error) {
    if (error instanceof WeightCalculationError) return error.code;
    throw error;
  }
  return "no error";
}

/** An exact fraction, for the reference implementation below. */
interface Fraction {
  readonly numerator: bigint;
  readonly denominator: bigint;
}
const gcd = (a: bigint, b: bigint): bigint => (b === 0n ? (a < 0n ? -a : a) : gcd(b, a % b));
const fraction = (numerator: bigint, denominator = 1n): Fraction => {
  const divisor = gcd(numerator, denominator);
  return { numerator: numerator / divisor, denominator: denominator / divisor };
};
const add = (a: Fraction, b: Fraction) =>
  fraction(a.numerator * b.denominator + b.numerator * a.denominator, a.denominator * b.denominator);
const subtract = (a: Fraction, b: Fraction) => add(a, fraction(-b.numerator, b.denominator));
const multiply = (a: Fraction, b: Fraction) => fraction(a.numerator * b.numerator, a.denominator * b.denominator);
const divide = (a: Fraction, b: Fraction) => fraction(a.numerator * b.denominator, a.denominator * b.numerator);
const compare = (a: Fraction, b: Fraction) => {
  const difference = a.numerator * b.denominator - b.numerator * a.denominator;
  return difference > 0n ? 1 : difference < 0n ? -1 : 0;
};
const sum = (values: readonly Fraction[]) => values.reduce(add, fraction(0n));

/**
 * Reference implementation that follows the written rule literally, round by round, with exact
 * fractions. It shares no code and no representation with `computeWeights`.
 */
function referenceWeights(entries: readonly WeightInput[], constraints: WeightConstraints): Constituent[] {
  const sorted = [...entries].sort((a, b) => (BigInt(a.token) < BigInt(b.token) ? -1 : 1));
  const total = sorted.reduce((accumulator, { rawWeight }) => accumulator + rawWeight, 0n);
  const weights = sorted.map(({ rawWeight }) => fraction(rawWeight * 10_000n, total));
  const clampAt = (boundBps: number | undefined, direction: 1 | -1) => {
    if (boundBps === undefined) return;
    const bound = fraction(BigInt(boundBps));
    const pinned = new Set<number>();
    for (;;) {
      const beyond = weights.flatMap((weight, i) =>
        !pinned.has(i) && compare(weight, bound) === direction ? [i] : [],
      );
      if (beyond.length === 0) return;
      // Positive when weight is released by a cap, negative when it is consumed by a floor.
      const released = sum(beyond.map((i) => subtract(weights[i] ?? bound, bound)));
      for (const i of beyond) {
        weights[i] = bound;
        pinned.add(i);
      }
      const free = weights.flatMap((_, i) => (pinned.has(i) ? [] : [i]));
      const freeTotal = sum(free.map((i) => weights[i] ?? bound));
      for (const i of free) {
        const weight = weights[i] ?? bound;
        weights[i] = add(weight, multiply(released, divide(weight, freeTotal)));
      }
    }
  };
  clampAt(constraints.maxWeightBps, 1);
  clampAt(constraints.minWeightBps ?? 1, -1);
  const floors = weights.map(({ numerator, denominator }) => numerator / denominator);
  const remainders = weights.map((weight, i) => subtract(weight, fraction(floors[i] ?? 0n)));
  let missing = 10_000n - floors.reduce((accumulator, floor) => accumulator + floor, 0n);
  const order = floors
    .map((_, i) => i)
    .sort((a, b) => compare(remainders[b] ?? fraction(0n), remainders[a] ?? fraction(0n)) || a - b);
  for (const i of order) {
    if (missing === 0n) break;
    floors[i] = (floors[i] ?? 0n) + 1n;
    missing -= 1n;
  }
  return sorted.map(({ token }, i) => ({ token, weightBps: Number(floors[i]) }));
}

describe("computeWeights rounding", () => {
  test("splits evenly when 10_000 is divisible by the count", () => {
    expect(weightsBps([1, 1, 1, 1])).toEqual([2500, 2500, 2500, 2500]);
    expect(weightsBps([7])).toEqual([10_000]);
  });

  test("gives the missing basis points to the lowest addresses when remainders tie", () => {
    expect(weightsBps([1, 1, 1])).toEqual([3334, 3333, 3333]);
    expect(weightsBps([1, 1, 1, 1, 1, 1, 1])).toEqual([1429, 1429, 1429, 1429, 1428, 1428, 1428]);
    expect(weightsBps([1, 1, 1, 1, 1, 1])).toEqual([1667, 1667, 1667, 1667, 1666, 1666]);
  });

  test("gives the missing basis points to the largest remainders before the lowest addresses", () => {
    // Exact weights 1666.67, 3333.33, 5000: the only missing basis point belongs to the first.
    expect(weightsBps([1, 2, 3])).toEqual([1667, 3333, 5000]);
    // Exact weights 3333.33, 1666.67, 5000: now it belongs to the second, not to the lowest address.
    expect(weightsBps([2, 1, 3])).toEqual([3333, 1667, 5000]);
    // Exact weights 1428.57, 2857.14, 5714.29: one missing basis point, largest remainder first.
    expect(weightsBps([1, 2, 4])).toEqual([1429, 2857, 5714]);
  });

  test("never gives a constituent a weight of zero", () => {
    // Exact weights 9999.9 and 0.1: largest remainder alone would give 10000 and 0.
    expect(weightsBps([99_999, 1])).toEqual([9999, 1]);
    expect(weightsBps([10n ** 30n, 1, 1])).toEqual([9998, 1, 1]);
  });

  test("reproduces weights that are already whole basis points", () => {
    expect(weightsBps([4000, 2500, 2000, 1000, 500])).toEqual([4000, 2500, 2000, 1000, 500]);
    expect(weightsBps([1, 9999])).toEqual([1, 9999]);
  });

  test("depends only on the ratios between raw weights", () => {
    const scale = 10n ** 30n;
    expect(weightsBps([3n * scale, 5n * scale, 11n * scale])).toEqual(weightsBps([3, 5, 11]));
  });
});

describe("computeWeights cap", () => {
  test("clamps and redistributes the excess pro rata", () => {
    // 2000 bps of excess over weights 2000, 1500, 500: factor 1.5.
    expect(weightsBps([6000, 2000, 1500, 500], { maxWeightBps: 4000 })).toEqual([4000, 3000, 2250, 750]);
  });

  test("repeats while redistribution pushes more constituents above the cap", () => {
    // Round 1 caps the first two, round 2 the third, round 3 the fourth; then 763.64 and 436.36 are rounded.
    const result = weightsBps([4500, 2500, 1300, 1150, 350, 200], { maxWeightBps: 2200 });
    expect(result).toEqual([2200, 2200, 2200, 2200, 764, 436]);
  });

  test("redistributes over uncapped constituents only", () => {
    // A redistribution over all four would leave the first above the cap.
    expect(weightsBps([7000, 1000, 1000, 1000], { maxWeightBps: 4001 })).toEqual([4001, 2000, 2000, 1999]);
  });

  test("does not bind when it equals the largest weight", () => {
    expect(weightsBps([1, 1, 1, 1], { maxWeightBps: 2500 })).toEqual([2500, 2500, 2500, 2500]);
    expect(weightsBps([6000, 4000], { maxWeightBps: 6000 })).toEqual([6000, 4000]);
  });

  test("reaches the cap on every constituent when the cap is exactly feasible", () => {
    expect(weightsBps([9000, 500, 300, 200], { maxWeightBps: 2500 })).toEqual([2500, 2500, 2500, 2500]);
  });

  test("never rounds a constituent above the cap", () => {
    // Exact weights after the cap: 3334, 3333.5, 3332.5 would be wrong; the cap leaves 3334, 3333, 3333.
    expect(weightsBps([5000, 2500, 2500], { maxWeightBps: 3334 })).toEqual([3334, 3333, 3333]);
    expect(weightsBps([1, 1, 1], { maxWeightBps: 3334 })).toEqual([3334, 3333, 3333]);
  });
});

describe("computeWeights floor", () => {
  test("raises to the floor and takes the difference pro rata from the others", () => {
    // 1300 bps are taken from 6000 and 3300: 5161.29 and 2838.71.
    expect(weightsBps([6000, 3300, 400, 300], { minWeightBps: 1000 })).toEqual([5161, 2839, 1000, 1000]);
  });

  test("repeats while taking weight pushes more constituents below the floor", () => {
    expect(weightsBps([5000, 3360, 1040, 600], { minWeightBps: 1000 })).toEqual([4785, 3215, 1000, 1000]);
  });

  test("is applied after the cap", () => {
    expect(weightsBps([9000, 1000], { maxWeightBps: 6000, minWeightBps: 4500 })).toEqual([5500, 4500]);
    const result = weightsBps([5500, 2500, 1500, 300, 200], { maxWeightBps: 3500, minWeightBps: 700 });
    expect(result).toEqual([3254, 3254, 2092, 700, 700]);
  });

  test("holds every constituent at the floor when the floor is exactly feasible", () => {
    expect(weightsBps([9000, 500, 300, 200], { minWeightBps: 2500 })).toEqual([2500, 2500, 2500, 2500]);
  });
});

describe("computeWeights inputs", () => {
  test("returns ascending token order whatever the input order", () => {
    const shuffled = [
      { token: address(3), rawWeight: 3n },
      { token: address(1), rawWeight: 1n },
      { token: address(2), rawWeight: 2n },
    ];
    expect(computeWeights(shuffled)).toEqual([
      { token: address(1), weightBps: 1667 },
      { token: address(2), weightBps: 3333 },
      { token: address(3), weightBps: 5000 },
    ]);
  });

  test("orders addresses numerically across digits and letters", () => {
    const tokens: Address[] = [`0xa${"0".repeat(39)}`, `0x9${"f".repeat(39)}`, `0x1${"0".repeat(39)}`];
    const result = computeWeights(tokens.map((token) => ({ token, rawWeight: 1n })));
    expect(result.map(({ token }) => token)).toEqual([tokens[2], tokens[1], tokens[0]].flatMap((token) => token ?? []));
    expect(result.map(({ weightBps }) => weightBps)).toEqual([3334, 3333, 3333]);
  });

  test("does not modify its input", () => {
    const entries = [
      { token: address(2), rawWeight: 1n },
      { token: address(1), rawWeight: 2n },
    ];
    computeWeights(entries);
    expect(entries.map(({ token }) => token)).toEqual([address(2), address(1)]);
  });

  test("rejects inputs that cannot produce a composition", () => {
    expect(errorCode(() => computeWeights([]))).toBe("no_constituents");
    expect(errorCode(() => weightsBps([1, 0]))).toBe("non_positive_weight");
    expect(errorCode(() => weightsBps([1, -1]))).toBe("non_positive_weight");
    const duplicated = [...inputs([1, 1]), { token: address(1), rawWeight: 1n }];
    expect(errorCode(() => computeWeights(duplicated))).toBe("duplicate_token");
    const checksummed: Address = "0x00000000000000000000000000000000000000AB";
    expect(errorCode(() => computeWeights([{ token: checksummed, rawWeight: 1n }]))).toBe("invalid_address");
    expect(errorCode(() => computeWeights([{ token: "0x1", rawWeight: 1n }]))).toBe("invalid_address");
  });

  test("rejects bounds that are invalid or infeasible", () => {
    expect(errorCode(() => weightsBps([1, 1, 1], { maxWeightBps: 3333 }))).toBe("cap_infeasible");
    expect(errorCode(() => weightsBps([1, 1, 1], { maxWeightBps: 3334 }))).toBe("no error");
    expect(errorCode(() => weightsBps([1, 1, 1], { minWeightBps: 3334 }))).toBe("floor_infeasible");
    expect(errorCode(() => weightsBps([1, 1, 1], { minWeightBps: 3333 }))).toBe("no error");
    for (const invalid of [0, -1, 10_001, 2500.5, Number.NaN]) {
      expect(errorCode(() => weightsBps([1, 1], { maxWeightBps: invalid }))).toBe("invalid_bound");
      expect(errorCode(() => weightsBps([1, 1], { minWeightBps: invalid }))).toBe("invalid_bound");
    }
  });
});

describe("computeWeights properties", () => {
  /** A random case: token set, raw weights and feasible bounds, some of them tight. */
  function randomCase(random: (bound: number) => number) {
    const count = 1 + random(random(4) === 0 ? 128 : 12);
    const used = new Set<number>();
    while (used.size < count) used.add(1 + random(1_000_000));
    const skew = random(3);
    const entries = [...used].map((value) => ({
      token: address(value),
      rawWeight: BigInt(skew === 0 ? 1 + random(3) : skew === 1 ? 1 + random(10_000) : (1 + random(100)) ** 3),
    }));
    const equalBps = Math.ceil(10_000 / count);
    const constraints: { maxWeightBps?: number; minWeightBps?: number } = {};
    if (random(4) !== 0) constraints.maxWeightBps = Math.min(10_000, equalBps + random(random(2) === 0 ? 3 : 3000));
    if (random(3) === 0)
      constraints.minWeightBps = Math.max(1, Math.floor(10_000 / count) - random(random(2) === 0 ? 3 : 300));
    return { entries, constraints };
  }

  test("sum, bounds, order, determinism and agreement with the reference on 4000 random cases", () => {
    const random = createRandom(10_000);
    let capBound = 0;
    let floorBound = 0;
    for (let i = 0; i < 4000; i++) {
      const { entries, constraints } = randomCase(random);
      const result = computeWeights(entries, constraints);
      const { maxWeightBps = 10_000, minWeightBps = 1 } = constraints;

      expect(result.reduce((total, { weightBps }) => total + weightBps, 0)).toBe(10_000);
      for (const { weightBps } of result) {
        expect(Number.isInteger(weightBps)).toBe(true);
        expect(weightBps).toBeGreaterThanOrEqual(minWeightBps);
        expect(weightBps).toBeLessThanOrEqual(maxWeightBps);
      }
      const tokens = result.map(({ token }) => token);
      expect(tokens).toEqual([...entries.map(({ token }) => token)].sort());
      expect(computeWeights(entries, constraints)).toEqual(result);
      expect(computeWeights([...entries].reverse(), constraints)).toEqual(result);
      const rotated = [...entries.slice(entries.length >> 1), ...entries.slice(0, entries.length >> 1)];
      expect(computeWeights(rotated, constraints)).toEqual(result);
      expect(result).toEqual(referenceWeights(entries, constraints));

      if (result.some(({ weightBps }) => weightBps === constraints.maxWeightBps)) capBound++;
      if (result.some(({ weightBps }) => weightBps === constraints.minWeightBps)) floorBound++;
    }
    // The generator must actually exercise the bounds, otherwise the assertions above prove little.
    expect(capBound).toBeGreaterThan(1000);
    expect(floorBound).toBeGreaterThan(300);
  });

  test("the cap binds over several rounds in the reference comparison", () => {
    // Geometric weights under a tight cap: each round pushes the next constituent above the cap.
    for (const count of [5, 8, 13, 40]) {
      const entries = inputs(range(count).map((i) => 3n ** BigInt(count - i)));
      const maxWeightBps = Math.ceil(10_000 / count) + 7;
      const result = computeWeights(entries, { maxWeightBps });
      expect(result).toEqual(referenceWeights(entries, { maxWeightBps }));
      expect(result.filter(({ weightBps }) => weightBps === maxWeightBps).length).toBeGreaterThanOrEqual(count - 2);
      expect(result.reduce((total, { weightBps }) => total + weightBps, 0)).toBe(10_000);
    }
  });

  test("preserves the order of the raw weights", () => {
    const random = createRandom(77);
    for (let i = 0; i < 1000; i++) {
      const { entries, constraints } = randomCase(random);
      const byToken = new Map(computeWeights(entries, constraints).map(({ token, weightBps }) => [token, weightBps]));
      for (const a of entries) {
        for (const b of entries) {
          // A larger raw weight never ends more than the 1 bps of rounding below a smaller one.
          if (a.rawWeight > b.rawWeight) {
            expect((byToken.get(a.token) ?? 0) + 1).toBeGreaterThanOrEqual(byToken.get(b.token) ?? 0);
          }
        }
      }
    }
  });
});

describe("computeConstituents", () => {
  function constituentsOf(spec: Record<string, unknown>): Constituent[] {
    const validation = validateSpec(spec);
    if (!validation.ok) throw new Error(JSON.stringify(validation.errors));
    return computeConstituents(validation.spec);
  }

  test("gives equal weights to the tokens of an equal-weight spec", () => {
    const result = constituentsOf(baseSpec(3));
    expect(result.map(({ weightBps }) => weightBps)).toEqual([3334, 3333, 3333]);
    expect(result.map(({ token }) => token)).toEqual(range(3).map((i) => address(0xb200 + i)));
  });

  test("reproduces fixed weights and applies the constraints of the spec", () => {
    const fixed = { ...baseSpec(4), weighting: { type: "fixed", weightsBps: [6000, 2000, 1500, 500] } };
    expect(constituentsOf(fixed).map(({ weightBps }) => weightBps)).toEqual([6000, 2000, 1500, 500]);
    const capped = { ...fixed, constraints: { maxWeightBps: 4000 } };
    expect(constituentsOf(capped).map(({ weightBps }) => weightBps)).toEqual([4000, 3000, 2250, 750]);
  });

  test("gives a single constituent the whole index", () => {
    expect(constituentsOf(baseSpec(1))).toEqual([{ token: address(0xb201), weightBps: 10_000 }]);
  });
});
