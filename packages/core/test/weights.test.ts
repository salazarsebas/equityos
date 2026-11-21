import { describe, expect, test } from "bun:test";
import {
  type Address,
  type Constituent,
  computeConstituents,
  computeEqualWeights,
  MAX_CONSTITUENTS,
  validateSpec,
  WeightCalculationError,
  type WeightErrorCode,
} from "../src/index.ts";
import { address, baseSpec, createRandom, range } from "./helpers.ts";

function equalBps(count: number): number[] {
  return computeEqualWeights(range(count).map(address)).map(({ weightBps }) => weightBps);
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

function constituentsOf(spec: Record<string, unknown>): Constituent[] {
  const validation = validateSpec(spec);
  if (!validation.ok) throw new Error(JSON.stringify(validation.errors));
  return computeConstituents(validation.spec);
}

describe("computeEqualWeights", () => {
  test("splits evenly when 10_000 is divisible by the count", () => {
    expect(equalBps(1)).toEqual([10_000]);
    expect(equalBps(4)).toEqual([2500, 2500, 2500, 2500]);
    expect(equalBps(10)).toEqual(range(10).map(() => 1000));
  });

  test("rounds down and gives the missing basis points to the lowest addresses", () => {
    expect(equalBps(3)).toEqual([3334, 3333, 3333]);
    expect(equalBps(6)).toEqual([1667, 1667, 1667, 1667, 1666, 1666]);
    expect(equalBps(7)).toEqual([1429, 1429, 1429, 1429, 1428, 1428, 1428]);
    // 10000 / 64 = 156 and 16 bps are missing.
    expect(equalBps(64)).toEqual([...range(16).map(() => 157), ...range(48).map(() => 156)]);
  });

  test("returns ascending token order whatever the input order", () => {
    const expected = [
      { token: address(1), weightBps: 3334 },
      { token: address(2), weightBps: 3333 },
      { token: address(3), weightBps: 3333 },
    ];
    expect(computeEqualWeights([address(3), address(1), address(2)])).toEqual(expected);
    expect(computeEqualWeights([address(2), address(3), address(1)])).toEqual(expected);
  });

  test("orders addresses numerically across digits and letters", () => {
    const low: Address = `0x1${"0".repeat(39)}`;
    const middle: Address = `0x9${"f".repeat(39)}`;
    const high: Address = `0xa${"0".repeat(39)}`;
    expect(computeEqualWeights([high, middle, low])).toEqual([
      { token: low, weightBps: 3334 },
      { token: middle, weightBps: 3333 },
      { token: high, weightBps: 3333 },
    ]);
  });

  test("does not modify its input", () => {
    const tokens = [address(2), address(1)];
    computeEqualWeights(tokens);
    expect(tokens).toEqual([address(2), address(1)]);
  });

  test("rejects inputs that cannot produce a composition", () => {
    expect(errorCode(() => computeEqualWeights([]))).toBe("no_constituents");
    expect(errorCode(() => computeEqualWeights([address(1), address(2), address(1)]))).toBe("duplicate_token");
    expect(errorCode(() => computeEqualWeights(["0x00000000000000000000000000000000000000AB"]))).toBe(
      "invalid_address",
    );
    expect(errorCode(() => computeEqualWeights(["0x1"]))).toBe("invalid_address");
    expect(errorCode(() => computeEqualWeights(range(10_000).map(address)))).toBe("no error");
    expect(errorCode(() => computeEqualWeights(range(10_001).map(address)))).toBe("too_many_constituents");
  });

  test("for every count up to 10_000: sum, spread of at most 1 bps, lowest addresses first", () => {
    for (let count = 1; count <= 10_000; count = count < 200 ? count + 1 : count + 197) {
      const weights = equalBps(count);
      const base = Math.floor(10_000 / count);
      const extra = 10_000 - base * count;
      expect(weights.reduce((total, weightBps) => total + weightBps, 0)).toBe(10_000);
      expect(base).toBeGreaterThanOrEqual(1);
      if (weights.some((weightBps, i) => weightBps !== (i < extra ? base + 1 : base))) {
        throw new Error(`n=${count}: the ${extra} missing bps are not on the lowest addresses`);
      }
    }
  });

  test("is deterministic and independent of input order on 500 random token sets", () => {
    const random = createRandom(10_000);
    for (let i = 0; i < 500; i++) {
      const values = new Set<number>();
      const count = 1 + random(MAX_CONSTITUENTS);
      while (values.size < count) values.add(1 + random(1_000_000));
      const tokens = [...values].map(address);
      const result = computeEqualWeights(tokens);
      expect(result.map(({ token }) => token)).toEqual([...tokens].sort());
      expect(computeEqualWeights(tokens)).toEqual(result);
      expect(computeEqualWeights([...tokens].reverse())).toEqual(result);
      expect(computeEqualWeights([...tokens.slice(count >> 1), ...tokens.slice(0, count >> 1)])).toEqual(result);
    }
  });
});

describe("equal weights and constraints", () => {
  // The validator accepts an equal-weight spec when maxWeightBps * n >= 10_000 and minWeightBps * n <= 10_000.
  // This proves, for every n a spec can have and every bound, that those two rules are exactly the
  // condition under which the rounded weights satisfy the bounds: the calculation never has to adjust.
  test("the rounded weights satisfy a bound exactly when the feasibility rule accepts it", () => {
    for (let count = 1; count <= MAX_CONSTITUENTS; count++) {
      const weights = equalBps(count);
      const largestBps = Math.max(...weights);
      const smallestBps = Math.min(...weights);
      for (let boundBps = 1; boundBps <= 10_000; boundBps++) {
        const capAccepted = boundBps * count >= 10_000;
        const floorAccepted = boundBps * count <= 10_000;
        if (capAccepted !== largestBps <= boundBps || floorAccepted !== smallestBps >= boundBps) {
          throw new Error(`n=${count} bound=${boundBps}: weights ${smallestBps}..${largestBps}`);
        }
      }
    }
  });

  test("the validator applies that rule at its boundary for every count", () => {
    for (let count = 1; count <= MAX_CONSTITUENTS; count++) {
      const smallestCap = Math.ceil(10_000 / count);
      const largestFloor = Math.floor(10_000 / count);
      const accepted = { ...baseSpec(count), constraints: { maxWeightBps: smallestCap, minWeightBps: largestFloor } };
      for (const { weightBps } of constituentsOf(accepted)) {
        expect(weightBps).toBeLessThanOrEqual(smallestCap);
        expect(weightBps).toBeGreaterThanOrEqual(largestFloor);
      }
      if (smallestCap > 1) {
        const capped = { ...baseSpec(count), constraints: { maxWeightBps: smallestCap - 1 } };
        expect(validateSpec(capped).ok).toBe(false);
      }
      const floored = { ...baseSpec(count), constraints: { minWeightBps: largestFloor + 1 } };
      expect(validateSpec(floored).ok).toBe(false);
    }
  });
});

describe("computeConstituents", () => {
  test("gives equal weights to the tokens of an equal-weight spec", () => {
    const result = constituentsOf(baseSpec(3));
    expect(result.map(({ weightBps }) => weightBps)).toEqual([3334, 3333, 3333]);
    expect(result.map(({ token }) => token)).toEqual(range(3).map((i) => address(0xb200 + i)));
  });

  test("returns fixed weights exactly as written, with or without constraints", () => {
    const fixed = { ...baseSpec(4), weighting: { type: "fixed", weightsBps: [6000, 2000, 1500, 500] } };
    expect(constituentsOf(fixed).map(({ weightBps }) => weightBps)).toEqual([6000, 2000, 1500, 500]);
    const bounded = { ...fixed, constraints: { maxWeightBps: 6000, minWeightBps: 500 } };
    expect(constituentsOf(bounded).map(({ weightBps }) => weightBps)).toEqual([6000, 2000, 1500, 500]);
    expect(constituentsOf(bounded).map(({ token }) => token)).toEqual(range(4).map((i) => address(0xb200 + i)));
  });

  test("never alters a fixed weight on 1000 random specs", () => {
    const random = createRandom(64);
    for (let i = 0; i < 1000; i++) {
      const count = 1 + random(MAX_CONSTITUENTS);
      const weightsBps = range(count).map(() => 1);
      for (let left = 10_000 - count; left > 0; ) {
        const step = Math.min(left, 1 + random(600));
        const at = random(count);
        weightsBps[at] = (weightsBps[at] ?? 0) + step;
        left -= step;
      }
      const constraints = { maxWeightBps: Math.max(...weightsBps), minWeightBps: Math.min(...weightsBps) };
      const spec = { ...baseSpec(count), weighting: { type: "fixed", weightsBps }, constraints };
      expect(constituentsOf(spec).map(({ weightBps }) => weightBps)).toEqual(weightsBps);
    }
  });

  test("gives a single constituent the whole index", () => {
    expect(constituentsOf(baseSpec(1))).toEqual([{ token: address(0xb201), weightBps: 10_000 }]);
  });

  test("refuses a fixed weighting without one weight per token instead of inventing a weight", () => {
    const validation = validateSpec({ ...baseSpec(2), weighting: { type: "fixed", weightsBps: [5000, 5000] } });
    if (!validation.ok) throw new Error("expected a valid spec");
    const inconsistent = { ...validation.spec, weighting: { type: "fixed" as const, weightsBps: [10_000] } };
    expect(errorCode(() => computeConstituents(inconsistent))).toBe("length_mismatch");
  });
});
