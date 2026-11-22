import { describe, expect, test } from "bun:test";
import {
  type Address,
  type Holding,
  MAX_RESERVE_BPS,
  type PlanMode,
  planRebalance,
  positionValueUsdE8,
  type RebalancePlan,
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
  // One case in four holds nothing, one in four holds exactly the target proportions, the others are random.
  const kind = pick(random, ["first", "on_target", "random", "random"]);
  const total = 1n + amount(random, size);

  const constituents: TargetConstituent[] = constituentTokens.map((token, i) => ({
    token,
    weightBps: targetWeights[i] ?? 0,
    decimals: decimalsOf(token),
  }));
  const holdings: Holding[] = [];
  for (const [i, token] of constituentTokens.entries()) {
    if (kind === "random" && random(4) > 0) {
      holdings.push({ token, balance: balance(token, size), decimals: decimalsOf(token) });
    } else if (kind === "on_target") {
      const held =
        (((total * BigInt(targetWeights[i] ?? 0)) / 10_000n) * 10n ** BigInt(decimalsOf(token))) / priceOf(token);
      holdings.push({ token, balance: held, decimals: decimalsOf(token) });
    }
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
    reserveBps: pick(random, [0, 0, 50, 50, random(MAX_RESERVE_BPS + 1)]),
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

interface Planned extends Case {
  readonly plan: RebalancePlan;
}

const generated = Array.from({ length: CASES }, (_, i) => randomCase(0x51ab + i));
const results = generated.map((item) => ({ ...item, result: planRebalance(item.input) }));
/** The generated cases that have a plan. */
const cases: Planned[] = results.flatMap(({ result, ...item }) =>
  result.status === "ready" ? [{ ...item, plan: result }] : [],
);

function legsOf(plan: RebalancePlan, side: "sell" | "buy") {
  return plan.legs.filter((leg) => leg.side === side);
}

/**
 * Largest distance, in USD E8, that rounding can put between a projected value and the value the rules aim
 * at: one base unit of every constituent, and a few quote base units per constituent and per token to exit.
 */
function roundingValue(item: Planned): bigint {
  const count = BigInt(item.plan.targets.length);
  const exits = BigInt(item.input.exitTokens?.length ?? 0);
  return sum(item.plan.targets.map(({ token }) => unitValue(item, token))) + 100n * (count + exits + 2n) + 1n;
}

/** The share of the projected invested value that `roundingValue` can move, in bps, rounded up. */
function roundingBps(item: Planned, factor: bigint): number {
  const count = BigInt(item.plan.targets.length);
  return Number(ceilDiv(10_000n * (count + 1n) * factor * roundingValue(item), item.plan.projected.investedValueUsdE8));
}

describe("planRebalance over random portfolios", () => {
  test("the generator covers both modes, every kind of skipped leg, exits and every index size up to 64", () => {
    const count = (matches: (item: Planned) => boolean) => cases.filter(matches).length;
    const skips = (reason: string) => count(({ plan }) => plan.skipped.some((leg) => leg.reason === reason));
    expect(cases.length).toBeGreaterThan(3_000);
    expect(count(({ input }) => input.mode === "buy_only")).toBeGreaterThan(800);
    expect(skips("below_minimum")).toBeGreaterThan(500);
    expect(skips("zero_quantity")).toBeGreaterThan(500);
    expect(skips("above_target_weight")).toBeGreaterThan(200);
    expect(skips("not_needed")).toBeGreaterThan(100);
    expect(count(({ plan }) => plan.legs.some(({ exit }) => exit))).toBeGreaterThan(400);
    expect(count(({ plan }) => legsOf(plan, "sell").length > 0)).toBeGreaterThan(1_000);
    expect(count(({ plan }) => legsOf(plan, "buy").length > 0)).toBeGreaterThan(1_500);
    expect(count(({ input }) => input.constituents.length === 64)).toBeGreaterThan(100);
    expect(count(({ plan }) => plan.currentMaxAbsDriftBps === null)).toBeGreaterThan(300);
    expect(count(({ plan }) => plan.currentMaxAbsDriftBps === 0)).toBeGreaterThan(500);
    expect(count(({ plan }) => plan.warnings.some(({ code }) => code === "projected_drift_increase"))).toBeGreaterThan(
      20,
    );
  });

  test("a blocked result has no legs, and is blocked for nothing to deploy or a first replication that is too small", () => {
    const blocked = results.flatMap(({ result }) => (result.status === "blocked" ? [result] : []));
    expect(blocked.length).toBeGreaterThan(100);
    expect(blocked.some(({ blockers }) => blockers[0]?.code === "zero_deployable_value")).toBe(true);
    for (const result of blocked) {
      expect(Object.keys(result).sort()).toEqual(["blockers", "status", "valuation", "warnings"]);
      expect(result.blockers.length).toBe(1);
      const blocker = result.blockers[0];
      if (blocker?.code === "below_minimum_portfolio_value") {
        expect(result.valuation.investedValueUsdE8).toBe(0n);
        expect(blocker.minimumDeployableValueUsdE8).toBeGreaterThan(0n);
      } else {
        expect(blocker?.code).toBe("zero_deployable_value");
      }
    }
  });

  test("value is conserved: never created, and lost only to the stated rounding", () => {
    for (const { plan } of cases) {
      const sold = new Set(plan.legs.filter(({ exit }) => exit).map(({ token }) => token));
      const exits = plan.valuation.outsideIndex.filter(({ token }) => sold.has(token));
      const before =
        (plan.valuation.investedValueUsdE8 ?? 0n) +
        plan.availableQuote * 100n +
        sum(exits.map((e) => e.valueUsdE8 ?? 0n));
      const after = plan.projected.investedValueUsdE8 + plan.projected.quoteBalance * 100n;
      // Every leg loses less than one quote base unit plus one value unit.
      expect(after).toBeLessThanOrEqual(before);
      expect(before - after).toBeLessThanOrEqual(100n * BigInt(plan.legs.length));
    }
  });

  test("buys never exceed the proceeds plus the quote available, less the reserve", () => {
    for (const { plan } of cases) {
      const proceeds = sum(legsOf(plan, "sell").map(({ quoteAmount }) => quoteAmount));
      const spent = sum(legsOf(plan, "buy").map(({ quoteAmount }) => quoteAmount));
      const funds = plan.availableQuote + proceeds;
      expect(plan.buyBudgetQuote).toBe((funds * BigInt(10_000 - plan.reserveBps)) / 10_000n);
      expect(spent).toBeLessThanOrEqual(plan.buyBudgetQuote);
      expect(plan.projected.quoteBalance).toBe(funds - spent);
      // The reserve is at least the share asked for.
      expect(plan.projected.quoteBalance * 10_000n).toBeGreaterThanOrEqual(funds * BigInt(plan.reserveBps));
    }
  });

  test("no leg has a zero quantity, is below the minimum or sells more than is held, and a buy spends exactly what its quantity costs", () => {
    for (const item of cases) {
      const { plan } = item;
      const held = new Map<Address, bigint>(
        [...plan.valuation.positions, ...plan.valuation.outsideIndex].map(({ token, balance }) => [token, balance]),
      );
      for (const leg of plan.legs) {
        expect(leg.tokenQuantity).toBeGreaterThan(0n);
        expect(leg.quoteAmount).toBeGreaterThan(0n);
        expect(leg.valueUsdE8).toBeGreaterThanOrEqual(plan.minLegValueUsdE8);
        expect(leg.priceE8).toBe(item.prices.get(leg.token) ?? 0n);
        const decimals = item.decimals.get(leg.token) ?? 0;
        if (leg.side === "sell") {
          expect(leg.tokenQuantity).toBeLessThanOrEqual(held.get(leg.token) ?? 0n);
          expect(leg.valueUsdE8).toBe(positionValueUsdE8(leg.tokenQuantity, leg.priceE8, decimals, "down"));
          expect(leg.quoteAmount).toBe(leg.valueUsdE8 / 100n);
          if (leg.exit) expect(leg.tokenQuantity).toBe(held.get(leg.token) ?? 0n);
        } else {
          const cost = positionValueUsdE8(leg.tokenQuantity, leg.priceE8, decimals, "up");
          expect(leg.quoteAmount).toBe(ceilDiv(cost, 100n));
          expect(leg.valueUsdE8).toBe(leg.quoteAmount * 100n);
          expect(leg.exit).toBe(false);
        }
      }
    }
  });

  test("sells come first and each side is in ascending token order, for legs and for skipped legs", () => {
    for (const { plan } of cases) {
      for (const list of [plan.legs, plan.skipped]) {
        const order = list.map(({ side, token }) => `${side === "sell" ? 0 : 1}${token}`);
        expect(order).toEqual([...order].sort());
        expect(new Set(order).size).toBe(order.length);
      }
      const traded = new Set(plan.legs.map(({ side, token }) => `${side}${token}`));
      expect(plan.skipped.some(({ side, token }) => traded.has(`${side}${token}`))).toBe(false);
    }
  });

  test("current and projected weights sum to 10,000 whenever the invested value is above zero", () => {
    for (const { plan } of cases) {
      const total = (weightsBps: (number | null)[]) => weightsBps.reduce<number>((a, b) => a + (b ?? 0), 0);
      const current = plan.valuation.positions.map(({ weightBps }) => weightBps);
      const projected = plan.projected.positions.map(({ weightBps }) => weightBps);
      expect(total(current)).toBe(plan.valuation.investedValueUsdE8 === 0n ? 0 : 10_000);
      expect(total(projected)).toBe(plan.projected.investedValueUsdE8 === 0n ? 0 : 10_000);
      expect(current.includes(null)).toBe(plan.valuation.investedValueUsdE8 === 0n);
      expect(projected.includes(null)).toBe(plan.projected.investedValueUsdE8 === 0n);
    }
  });

  test("the projection is the legs applied at their reference prices", () => {
    for (const { plan } of cases) {
      for (const [index, position] of plan.valuation.positions.entries()) {
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
    for (const { plan } of cases) {
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

  test("when a buy is skipped, no bought constituent ends above its target weight", () => {
    let checked = 0;
    for (const item of cases) {
      const { plan } = item;
      if (!plan.skipped.some(({ side }) => side === "buy")) continue;
      const invested = plan.projected.investedValueUsdE8;
      const slack = roundingValue(item);
      for (const { token } of legsOf(plan, "buy")) {
        const position = plan.projected.positions.find((projected) => projected.token === token);
        if (position === undefined) throw new Error("a bought token is not a constituent");
        checked += 1;
        // value / invested <= weight / 10,000, with the invested value allowed to be short by the rounding.
        expect(position.valueUsdE8 * 10_000n).toBeLessThanOrEqual(
          BigInt(position.targetWeightBps) * (invested + slack),
        );
        expect(position.driftBps ?? Number.NaN).toBeLessThanOrEqual(1 + roundingBps(item, 1n));
      }
    }
    expect(checked).toBeGreaterThan(1_000);
  });

  test("a plan never moves a wallet that is on target off it by more than the stated bound", () => {
    let checked = 0;
    let tight = 0;
    for (const item of cases) {
      const { plan } = item;
      if (plan.currentMaxAbsDriftBps !== 0 || plan.projected.maxAbsDriftBps === null) continue;
      const granularityBps = roundingBps(item, 2n);
      checked += 1;
      expect(plan.projected.maxAbsDriftBps).toBeLessThanOrEqual(plan.targets.length + 4 + granularityBps);
      if (granularityBps <= 1) {
        // Against the granularity of its tokens the wallet is large: it does not move at all.
        tight += 1;
        expect(plan.projected.maxAbsDriftBps).toBe(0);
      }
    }
    expect(checked).toBeGreaterThan(500);
    expect(tight).toBeGreaterThan(200);
  });

  test("a sale never only adds to the quote balance: sells raise what the buys spend, and no more", () => {
    for (const item of cases) {
      const { plan } = item;
      const sells = legsOf(plan, "sell").filter(({ exit }) => !exit);
      const exitProceeds = sum(plan.legs.filter(({ exit }) => exit).map(({ quoteAmount }) => quoteAmount));
      const spent = sum(legsOf(plan, "buy").map(({ quoteAmount }) => quoteAmount));
      if (spent === 0n) expect(sells).toEqual([]);
      const needed = ceilDiv(spent * 10_000n, BigInt(10_000 - plan.reserveBps)) - plan.availableQuote - exitProceeds;
      // Each sell can exceed its share by one base unit of its token, the minimum leg value and two quote units.
      const allowance = sum(sells.map(({ token }) => (unitValue(item, token) + plan.minLegValueUsdE8) / 100n + 3n));
      expect(sum(sells.map(({ quoteAmount }) => quoteAmount))).toBeLessThanOrEqual(
        (needed > 0n ? needed : 0n) + allowance,
      );
    }
  });

  test("a full rebalance without reserve or minimum, when every buy goes through, brings every drift within the stated bound", () => {
    let checked = 0;
    let tight = 0;
    for (const item of generated) {
      if (item.input.mode !== "rebalance") continue;
      const plan = planRebalance({ ...item.input, reserveBps: 0, minLegValueUsdE8: 0n });
      if (plan.status === "blocked" || plan.projected.investedValueUsdE8 === 0n) continue;
      if (plan.skipped.some(({ side }) => side === "buy")) continue;
      const boundBps = roundingBps({ ...item, plan }, 2n) + 1;
      const projectedMax = plan.projected.maxAbsDriftBps ?? Number.NaN;
      checked += 1;
      for (const { driftBps } of plan.projected.positions) {
        expect(Math.abs(driftBps ?? Number.NaN)).toBeLessThanOrEqual(boundBps);
      }
      expect(projectedMax).toBeLessThanOrEqual(Math.max(plan.currentMaxAbsDriftBps ?? 0, boundBps));
      if (boundBps <= 2) {
        tight += 1;
        expect(projectedMax).toBeLessThanOrEqual(2);
      }
    }
    expect(checked).toBeGreaterThan(1_000);
    // Most random portfolios are large against the granularity of their tokens, where the bound is 2 bps.
    expect(tight).toBeGreaterThan(500);
  });

  test("a rise of the projected maximum drift is always reported with both numbers, and only then", () => {
    for (const { plan } of cases) {
      const current = plan.currentMaxAbsDriftBps;
      const projected = plan.projected.maxAbsDriftBps;
      const reported = plan.warnings.filter(({ code }) => code === "projected_drift_increase");
      if (projected !== null && projected > (current ?? 0)) {
        expect<unknown>(reported).toEqual([
          {
            code: "projected_drift_increase",
            severity: "warning",
            token: null,
            currentMaxAbsDriftBps: current,
            projectedMaxAbsDriftBps: projected,
          },
        ]);
      } else {
        expect(reported).toEqual([]);
      }
    }
  });

  test("a first replication buys every constituent or is blocked, and the stated minimum is enough", () => {
    let blocked = 0;
    for (const { input, result } of results) {
      if (result.valuation.investedValueUsdE8 !== 0n) continue;
      if (result.status === "ready") {
        expect(legsOf(result, "buy").length).toBe(input.constituents.length);
        continue;
      }
      // The same index, reserve and minimum with nothing but quote asset: one base unit is never enough.
      const fresh = { ...input, holdings: [], exitTokens: [], depositUsdE8: 0n };
      const small = planRebalance({ ...fresh, quoteBalance: 1n });
      if (small.status === "ready") continue;
      const blocker = small.blockers[0];
      if (blocker?.code !== "below_minimum_portfolio_value") throw new Error("unexpected blocker");
      blocked += 1;
      const enough = planRebalance({ ...fresh, quoteBalance: ceilDiv(blocker.minimumDeployableValueUsdE8, 100n) });
      if (enough.status === "blocked") throw new Error("the stated minimum is not enough");
      expect(legsOf(enough, "buy").length).toBe(input.constituents.length);
    }
    expect(blocked).toBeGreaterThan(100);
  });

  test("buy only never sells", () => {
    for (const { input } of generated) {
      const plan = planRebalance({ ...input, mode: "buy_only" });
      if (plan.status === "blocked") continue;
      expect(plan.legs.every(({ side, exit }) => side === "buy" && !exit)).toBe(true);
      expect(plan.skipped.every(({ side }) => side === "buy")).toBe(true);
      for (const [index, position] of plan.projected.positions.entries()) {
        expect(position.balance).toBeGreaterThanOrEqual(
          plan.valuation.positions[index]?.balance ?? position.balance + 1n,
        );
      }
    }
  });

  test("the order of constituents, holdings, prices and tokens to exit does not change the result", () => {
    for (const [index, { input }] of generated.entries()) {
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
    for (const { input } of generated.slice(0, 200)) expect(planRebalance(input)).toEqual(planRebalance(input));
  });
});
