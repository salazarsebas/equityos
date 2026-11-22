import { describe, expect, test } from "bun:test";
import {
  type Address,
  CALC_ID,
  isAddress,
  planRebalance,
  type RebalancePlanInput,
  type StalenessStatus,
} from "../src/index.ts";
import planVectors from "../vectors/rebalance-plans.json" with { type: "json" };
import { toVectorJson } from "./helpers.ts";

type VectorInput = (typeof planVectors.vectors)[number]["input"];

function toAddress(value: string): Address {
  if (!isAddress(value)) throw new Error(`${value} is not an address`);
  return value;
}

/** Reads a vector input: amounts are decimal strings, and an absent optional property stays absent. */
function parseInput(raw: VectorInput): RebalancePlanInput {
  if (raw.mode !== "rebalance" && raw.mode !== "buy_only") throw new Error(`${raw.mode} is not a mode`);
  return {
    mode: raw.mode,
    constituents: raw.constituents.map((constituent) => ({ ...constituent, token: toAddress(constituent.token) })),
    holdings: raw.holdings.map(({ token, balance, decimals }) => ({
      token: toAddress(token),
      balance: BigInt(balance),
      decimals,
    })),
    // The status is passed as published: two vectors carry a status that is absent or not a known class.
    prices: raw.prices.map(({ token, priceE8, status }) => ({
      token: toAddress(token),
      priceE8: BigInt(priceE8),
      status: status as StalenessStatus,
    })),
    quoteBalance: BigInt(raw.quoteBalance),
    ...(raw.depositUsdE8 === undefined ? {} : { depositUsdE8: BigInt(raw.depositUsdE8) }),
    ...(raw.exitTokens === undefined ? {} : { exitTokens: raw.exitTokens.map(toAddress) }),
    ...(raw.reserveBps === undefined ? {} : { reserveBps: raw.reserveBps }),
    ...(raw.minLegValueUsdE8 === undefined ? {} : { minLegValueUsdE8: BigInt(raw.minLegValueUsdE8) }),
    ...(raw.blockOnLastClose === undefined ? {} : { blockOnLastClose: raw.blockOnLastClose }),
  };
}

describe("published vectors: rebalance plans", () => {
  const { vectors } = planVectors;

  test("they are for this calculation, at least 30, with unique names", () => {
    expect<string>(planVectors.calc).toBe(CALC_ID);
    expect(vectors.length).toBeGreaterThanOrEqual(30);
    expect(new Set(vectors.map(({ name }) => name)).size).toBe(vectors.length);
  });

  test("they cover both modes, every blocker, warning and skip reason, an exit, the defaults and 64 constituents", () => {
    const ready = vectors.flatMap(({ expected }) => (expected.status === "ready" ? [expected] : []));
    const blocked = vectors.flatMap(({ expected }) => (expected.status === "blocked" ? [expected] : []));
    expect(ready.length + blocked.length).toBe(vectors.length);
    expect(vectors.some(({ input }) => input.mode === "buy_only")).toBe(true);
    const blockers = new Set(blocked.flatMap((result) => (result.blockers ?? []).map(({ code }) => code)));
    expect([...blockers].sort()).toEqual([
      "below_minimum_portfolio_value",
      "decimals_mismatch",
      "market_closed",
      "missing_price",
      "price_unavailable",
      "zero_deployable_value",
      "zero_price",
    ]);
    const warnings = new Set(ready.flatMap((result) => result.warnings.map(({ code }) => code)));
    expect([...warnings].sort()).toEqual(["market_closed", "price_delayed", "projected_drift_increase"]);
    const reasons = new Set(ready.flatMap((result) => (result.skipped ?? []).map(({ reason }) => reason)));
    expect([...reasons].sort()).toEqual(["above_target_weight", "below_minimum", "not_needed", "zero_quantity"]);
    expect(ready.some((result) => result.legs?.some(({ exit }) => exit))).toBe(true);
    expect(vectors.some(({ input }) => input.reserveBps === undefined)).toBe(true);
    expect(vectors.some(({ input }) => input.constituents.length === 64)).toBe(true);
    expect(vectors.some(({ input }) => input.prices.some((price) => !("status" in price)))).toBe(true);
  });

  for (const vector of vectors) {
    test(`${vector.name}: the exact result`, () => {
      expect<unknown>(toVectorJson(planRebalance(parseInput(vector.input)))).toEqual(vector.expected);
    });
  }

  test("a blocked result has blockers and no legs", () => {
    for (const { expected } of vectors) {
      expect("legs" in expected && expected.legs !== undefined).toBe(expected.status === "ready");
      expect("blockers" in expected && expected.blockers !== undefined).toBe(expected.status === "blocked");
    }
  });
});
