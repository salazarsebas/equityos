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

function toStatus(value: string): StalenessStatus {
  if (value === "live" || value === "delayed" || value === "last_close" || value === "unavailable") return value;
  throw new Error(`${value} is not a staleness class`);
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
    prices: raw.prices.map(({ token, priceE8, status }) => ({
      token: toAddress(token),
      priceE8: BigInt(priceE8),
      status: toStatus(status),
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

  test("they are for this calculation, at least 20, with unique names", () => {
    expect<string>(planVectors.calc).toBe(CALC_ID);
    expect(vectors.length).toBeGreaterThanOrEqual(20);
    expect(new Set(vectors.map(({ name }) => name)).size).toBe(vectors.length);
  });

  test("they cover both modes, blocked plans, skipped legs, an exit, the defaults and 64 constituents", () => {
    expect(vectors.some(({ input }) => input.mode === "buy_only")).toBe(true);
    expect(vectors.filter(({ expected }) => expected.plan === null).length).toBeGreaterThanOrEqual(5);
    expect(vectors.some(({ expected }) => expected.warnings.length > 0 && expected.plan !== null)).toBe(true);
    expect(vectors.some(({ expected }) => (expected.plan?.skipped.length ?? 0) > 0)).toBe(true);
    expect(vectors.some(({ expected }) => expected.plan?.legs.some(({ exit }) => exit))).toBe(true);
    expect(vectors.some(({ input }) => input.reserveBps === undefined)).toBe(true);
    expect(vectors.some(({ input }) => input.constituents.length === 64)).toBe(true);
  });

  for (const vector of vectors) {
    test(`${vector.name}: blockers, warnings, valuation and plan`, () => {
      expect<unknown>(toVectorJson(planRebalance(parseInput(vector.input)))).toEqual(vector.expected);
    });
  }

  test("a plan exists exactly when there is no blocker", () => {
    for (const { expected } of vectors) expect(expected.plan === null).toBe(expected.blockers.length > 0);
  });
});
