import { describe, expect, test } from "bun:test";
import {
  type Address,
  type Holding,
  type PlanMode,
  planRebalance,
  positionValueUsdE8,
  type RebalancePlanInput,
  type ReferencePrice,
  type StalenessStatus,
  type TargetConstituent,
  USD_E8,
  valuePortfolio,
} from "../src/index.ts";
import { address, createRandom } from "./helpers.ts";

type Random = (bound: number) => number;

const CASES = 4_000;
const DECIMALS = [0, 2, 6, 8, 8, 18, 18, 18];
const STATUSES: StalenessStatus[] = ["live", "live", "delayed", "last_close"];

function pick<T>(random: Random, items: readonly T[]): T {
  const item = items[random(items.length)];
  if (item === undefined) throw new Error("empty list");
  return item;
}

/** A non-negative bigint below `10^digits`, built from 32-bit draws. */
function amount(random: Random, digits: number): bigint {
  let value = 0n;
  for (let i = 0; i < digits; i += 9) value = value * 1_000_000_000n + BigInt(random(1_000_000_000));
  return value % 10n ** BigInt(digits);
}

function shuffled<T>(random: Random, items: readonly T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = random(i + 1);
    const a = copy[i];
    const b = copy[j];
    if (a !== undefined && b !== undefined) {
      copy[i] = b;
      copy[j] = a;
    }
  }
  return copy;
}

/** `count` weights of at least 1 bps that sum to 10,000. */
function weights(random: Random, count: number): number[] {
  const result = Array.from({ length: count }, () => 1);
  let left = 10_000 - count;
  for (let i = 0; i < count - 1 && left > 0; i += 1) {
    const share = random(left + 1);
    result[i] = 1 + share;
    left -= share;
  }
  result[count - 1] = 1 + left;
  return shuffled(random, result);
}

/** A reference price between 0.0001 USD and about 100,000 USD. */
function referencePrice(random: Random): bigint {
  return 1n + amount(random, 4 + random(10));
}

interface Case {
  readonly input: RebalancePlanInput;
  readonly decimals: Map<Address, number>;
  readonly prices: Map<Address, bigint>;
}

function randomCase(seed: number): Case {
  const random = createRandom(seed);
  const count = random(20) === 0 ? 64 : 1 + random(12);
  const tokens = shuffled(
    random,
    Array.from({ length: count + 3 }, (_, i) => address(0xc000 + i * 7)),
  );
  const constituentTokens = tokens.slice(0, count);
  const outsideTokens = tokens.slice(count);
  const targetWeights = weights(random, count);
  const decimals = new Map<Address, number>(tokens.map((token) => [token, pick(random, DECIMALS)]));
  const prices = new Map<Address, bigint>(tokens.map((token) => [token, referencePrice(random)]));
  const decimalsOf = (token: Address): number => decimals.get(token) ?? 0;
  const priceOf = (token: Address): bigint => prices.get(token) ?? 1n;

  /** A balance worth up to about `10^digits` USD E8 at the reference price. */
  const balance = (token: Address, digits: number): bigint =>
    (amount(random, digits) * 10n ** BigInt(decimalsOf(token))) / priceOf(token);
  const size = 6 + random(11);

  const constituents: TargetConstituent[] = constituentTokens.map((token, i) => ({
    token,
    weightBps: targetWeights[i] ?? 0,
    decimals: decimalsOf(token),
  }));
  const holdings: Holding[] = [];
  for (const token of constituentTokens) {
    if (random(4) > 0) holdings.push({ token, balance: balance(token, size), decimals: decimalsOf(token) });
  }
  const exitTokens: Address[] = [];
  for (const token of outsideTokens) {
    if (random(2) === 0) holdings.push({ token, balance: balance(token, size), decimals: decimalsOf(token) });
    if (random(2) === 0) exitTokens.push(token);
  }
  const referencePrices: ReferencePrice[] = tokens.map((token) => ({
    token,
    priceE8: priceOf(token),
    status: pick(random, STATUSES),
  }));
  const mode: PlanMode = random(3) === 0 ? "buy_only" : "rebalance";
  const input: RebalancePlanInput = {
    mode,
    constituents,
    holdings: shuffled(random, holdings),
    prices: shuffled(random, referencePrices),
    quoteBalance: random(3) === 0 ? 0n : amount(random, size - 2),
    depositUsdE8: random(3) === 0 ? amount(random, size) : 0n,
    exitTokens,
    reserveBps: pick(random, [0, 0, 50, 50, random(10_001)]),
    minLegValueUsdE8: pick(random, [0n, 0n, USD_E8, USD_E8, amount(random, size - 1)]),
  };
  return { input, decimals, prices };
}

/** Value of one base unit of a token in USD E8, rounded up: the granularity of its legs. */
function unitValue({ decimals, prices }: Case, token: Address): bigint {
  return positionValueUsdE8(1n, prices.get(token) ?? 0n, decimals.get(token) ?? 0, "up");
}

function sum(values: readonly bigint[]): bigint {
  return values.reduce((total, value) => total + value, 0n);
}

function ceilDiv(a: bigint, b: bigint): bigint {
  return (a + b - 1n) / b;
}

const generated = Array.from({ length: CASES }, (_, i) => randomCase(0x51ab + i));
/** The generated cases that have a plan. The others hold nothing at all, which the first test checks. */
const cases = generated.filter(({ input }) => planRebalance(input).plan !== null);

describe("planRebalance over random portfolios", () => {
  test("the generator covers both modes, skipped legs, exits and every index size up to 64", () => {
    const blocked = generated.map(({ input }) => planRebalance(input)).filter(({ plan }) => plan === null);
    expect(blocked.length).toBeLessThan(CASES / 20);
    for (const { blockers } of blocked) {
      expect(blockers).toEqual([{ code: "zero_deployable_value", severity: "blocker", token: null }]);
    }
    const results = cases.map(({ input }) => ({ input, ...planRebalance(input) }));
    expect(results.every(({ blockers }) => blockers.length === 0)).toBe(true);
    expect(results.filter(({ input }) => input.mode === "buy_only").length).toBeGreaterThan(1_000);
    expect(results.filter(({ plan }) => (plan?.skipped.length ?? 0) > 0).length).toBeGreaterThan(1_000);
    expect(results.filter(({ plan }) => plan?.legs.some(({ exit }) => exit)).length).toBeGreaterThan(500);
    expect(results.filter(({ plan }) => plan?.legs.some(({ side }) => side === "sell")).length).toBeGreaterThan(1_500);
    expect(results.filter(({ plan }) => plan?.legs.some(({ side }) => side === "buy")).length).toBeGreaterThan(1_500);
    expect(results.filter(({ input }) => input.constituents.length === 64).length).toBeGreaterThan(100);
    expect(
      results.filter(({ warnings }) => warnings.some(({ code }) => code === "projected_drift_increase")).length,
    ).toBeGreaterThan(0);
  });

  test("value is conserved: never created, and lost only to the stated rounding", () => {
    for (const item of cases) {
      const { valuation, plan } = planRebalance(item.input);
      if (plan === null) throw new Error("blocked");
      const sold = new Set(plan.legs.filter(({ exit }) => exit).map(({ token }) => token));
      const exits = valuation.outsideIndex.filter(({ token }) => sold.has(token));
      const before =
        (valuation.investedValueUsdE8 ?? 0n) + plan.availableQuote * 100n + sum(exits.map((e) => e.valueUsdE8 ?? 0n));
      const after = plan.projected.investedValueUsdE8 + plan.projected.quoteBalance * 100n;
      // A sell loses less than one quote base unit plus one value unit; a buy less than one token base unit.
      const sells = BigInt(plan.legs.filter(({ side }) => side === "sell").length);
      const buys = plan.legs.filter(({ side }) => side === "buy").map(({ token }) => unitValue(item, token));
      expect(after).toBeLessThanOrEqual(before);
      expect(before - after).toBeLessThanOrEqual(sells * 100n + sum(buys));
    }
  });

  test("buys never exceed the proceeds plus the quote available, less the reserve", () => {
    for (const { input } of cases) {
      const { plan } = planRebalance(input);
      if (plan === null) throw new Error("blocked");
      const proceeds = sum(plan.legs.filter(({ side }) => side === "sell").map(({ quoteAmount }) => quoteAmount));
      const spent = sum(plan.legs.filter(({ side }) => side === "buy").map(({ quoteAmount }) => quoteAmount));
      const funds = plan.availableQuote + proceeds;
      expect(plan.buyBudgetQuote).toBe((funds * BigInt(10_000 - plan.reserveBps)) / 10_000n);
      expect(spent).toBeLessThanOrEqual(plan.buyBudgetQuote);
      expect(plan.projected.quoteBalance).toBe(funds - spent);
      // The reserve is at least the share asked for.
      expect(plan.projected.quoteBalance * 10_000n).toBeGreaterThanOrEqual(funds * BigInt(plan.reserveBps));
    }
  });

  test("no leg has a zero quantity, is below the minimum, sells more than is held or expects more than it pays for", () => {
    for (const item of cases) {
      const { valuation, plan } = planRebalance(item.input);
      if (plan === null) throw new Error("blocked");
      const held = new Map<Address, bigint>(
        [...valuation.positions, ...valuation.outsideIndex].map(({ token, balance }) => [token, balance]),
      );
      for (const leg of plan.legs) {
        expect(leg.tokenQuantity).toBeGreaterThan(0n);
        expect(leg.quoteAmount).toBeGreaterThan(0n);
        expect(leg.valueUsdE8).toBeGreaterThanOrEqual(plan.minLegValueUsdE8);
        expect(leg.priceE8).toBe(item.prices.get(leg.token) ?? 0n);
        const decimals = item.decimals.get(leg.token) ?? 0;
        const tokenValue = positionValueUsdE8(leg.tokenQuantity, leg.priceE8, decimals, "down");
        if (leg.side === "sell") {
          expect(leg.tokenQuantity).toBeLessThanOrEqual(held.get(leg.token) ?? 0n);
          expect(leg.valueUsdE8).toBe(tokenValue);
          expect(leg.quoteAmount).toBe(leg.valueUsdE8 / 100n);
        } else {
          expect(leg.valueUsdE8).toBe(leg.quoteAmount * 100n);
          expect(tokenValue).toBeLessThanOrEqual(leg.valueUsdE8);
          expect(leg.valueUsdE8 - tokenValue).toBeLessThanOrEqual(unitValue(item, leg.token));
        }
      }
      for (const { valueUsdE8, reason } of plan.skipped) {
        if (reason === "below_minimum") expect(valueUsdE8).toBeLessThan(plan.minLegValueUsdE8);
      }
    }
  });

  test("sells come first and each side is in ascending token order", () => {
    for (const { input } of cases) {
      const { plan } = planRebalance(input);
      if (plan === null) throw new Error("blocked");
      const order = plan.legs.map(({ side, token }) => `${side === "sell" ? 0 : 1}${token}`);
      expect(order).toEqual([...order].sort());
      expect(new Set(order).size).toBe(order.length);
    }
  });

  test("current and projected weights sum to 10,000 whenever the invested value is above zero", () => {
    for (const { input } of cases) {
      const { valuation, plan } = planRebalance(input);
      if (plan === null) throw new Error("blocked");
      const total = (weightsBps: (number | null)[]) => weightsBps.reduce<number>((a, b) => a + (b ?? 0), 0);
      const current = valuation.positions.map(({ weightBps }) => weightBps);
      const projected = plan.projected.positions.map(({ weightBps }) => weightBps);
      expect(total(current)).toBe(valuation.investedValueUsdE8 === 0n ? 0 : 10_000);
      expect(total(projected)).toBe(plan.projected.investedValueUsdE8 === 0n ? 0 : 10_000);
      expect(current.includes(null)).toBe(valuation.investedValueUsdE8 === 0n);
      expect(projected.includes(null)).toBe(plan.projected.investedValueUsdE8 === 0n);
    }
  });

  test("the projection is the legs applied at their reference prices", () => {
    for (const item of cases) {
      const { valuation, plan } = planRebalance(item.input);
      if (plan === null) throw new Error("blocked");
      for (const [index, position] of valuation.positions.entries()) {
        const change = sum(
          plan.legs
            .filter(({ token }) => token === position.token)
            .map(({ side, tokenQuantity }) => (side === "sell" ? -tokenQuantity : tokenQuantity)),
        );
        const projected = plan.projected.positions[index];
        expect(projected?.balance).toBe(position.balance + change);
        expect(projected?.valueUsdE8).toBe(
          positionValueUsdE8(position.balance + change, position.priceE8 ?? 0n, position.decimals, "down"),
        );
      }
      expect(plan.projected.investedValueUsdE8).toBe(sum(plan.projected.positions.map((p) => p.valueUsdE8)));
    }
  });

  test("every constituent ends between its current value and its target value", () => {
    for (const { input } of cases) {
      const { plan } = planRebalance(input);
      if (plan === null) throw new Error("blocked");
      for (const [index, target] of plan.targets.entries()) {
        const projected = plan.projected.positions[index]?.valueUsdE8 ?? -1n;
        const low = target.deltaUsdE8 < 0n ? target.targetValueUsdE8 : target.currentValueUsdE8;
        const high = target.deltaUsdE8 < 0n ? target.currentValueUsdE8 : target.targetValueUsdE8;
        expect(projected).toBeGreaterThanOrEqual(low);
        expect(projected).toBeLessThanOrEqual(high);
      }
      expect(sum(plan.targets.map(({ targetValueUsdE8 }) => targetValueUsdE8))).toBeLessThanOrEqual(
        plan.deployableValueUsdE8,
      );
    }
  });

  test("a full rebalance without reserve or minimum brings every drift within the stated bound and never raises the maximum above it", () => {
    let tight = 0;
    for (const item of cases) {
      if (item.input.mode !== "rebalance") continue;
      const { plan, warnings } = planRebalance({ ...item.input, reserveBps: 0, minLegValueUsdE8: 0n });
      if (plan === null) throw new Error("blocked");
      const invested = plan.projected.investedValueUsdE8;
      if (invested === 0n) continue;
      const count = BigInt(plan.targets.length);
      const exits = BigInt(item.input.exitTokens?.length ?? 0);
      // Largest distance of a projected value from its exact target: one base unit of every constituent, one
      // quote base unit per leg and per rounding step, and one value unit for the rounded target.
      const valueBound =
        sum(plan.targets.map(({ token }) => unitValue(item, token))) + 100n * (count + exits + 2n) + 1n;
      const boundBps = Number(ceilDiv(10_000n * (count + 1n) * valueBound, invested)) + 1;
      const projectedMax = plan.projected.maxAbsDriftBps ?? Number.NaN;
      for (const { driftBps } of plan.projected.positions)
        expect(Math.abs(driftBps ?? Number.NaN)).toBeLessThanOrEqual(boundBps);
      expect(projectedMax).toBeLessThanOrEqual(Math.max(plan.currentMaxAbsDriftBps ?? 0, boundBps));
      if (boundBps <= 2) {
        tight += 1;
        expect(projectedMax).toBeLessThanOrEqual(2);
      }
      if (projectedMax <= (plan.currentMaxAbsDriftBps ?? projectedMax)) {
        expect(warnings.some(({ code }) => code === "projected_drift_increase")).toBe(false);
      }
    }
    // Most random portfolios are large against the granularity of their tokens, where the bound is 2 bps.
    expect(tight).toBeGreaterThan(1_000);
  });

  test("a rise of the projected maximum drift is always reported, and only then", () => {
    for (const { input } of cases) {
      const { plan, warnings } = planRebalance(input);
      if (plan === null) throw new Error("blocked");
      const current = plan.currentMaxAbsDriftBps;
      const projected = plan.projected.maxAbsDriftBps;
      const rises = current !== null && projected !== null && projected > current;
      expect(warnings.some(({ code }) => code === "projected_drift_increase")).toBe(rises);
    }
  });

  test("buy only never sells", () => {
    for (const { input } of cases) {
      const { valuation, plan } = planRebalance({ ...input, mode: "buy_only" });
      if (plan === null) continue;
      expect(plan.legs.every(({ side, exit }) => side === "buy" && !exit)).toBe(true);
      expect(plan.skipped.every(({ side }) => side === "buy")).toBe(true);
      for (const [index, position] of plan.projected.positions.entries()) {
        expect(position.balance).toBeGreaterThanOrEqual(valuation.positions[index]?.balance ?? position.balance + 1n);
      }
    }
  });

  test("the order of constituents, holdings, prices and tokens to exit does not change the result", () => {
    for (const [index, { input }] of cases.entries()) {
      const random = createRandom(0x0d3 + index);
      const reordered: RebalancePlanInput = {
        ...input,
        constituents: shuffled(random, input.constituents),
        holdings: shuffled(random, input.holdings),
        prices: shuffled(random, input.prices),
        exitTokens: shuffled(random, input.exitTokens ?? []),
      };
      expect(planRebalance(reordered)).toEqual(planRebalance(input));
      expect(valuePortfolio(reordered)).toEqual(valuePortfolio(input));
    }
  });

  test("the same input gives the same output", () => {
    for (const { input } of cases.slice(0, 200)) expect(planRebalance(input)).toEqual(planRebalance(input));
  });
});
