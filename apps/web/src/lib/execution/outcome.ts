import { computeDrift, type ReferencePrice, valuePortfolio } from "@equityos/core";
import type { Address } from "viem";

/** A constituent of the compared version with the reference price the comparison valued it at. */
export interface ConstituentInput {
  readonly token: Address;
  readonly decimals: number;
  readonly targetWeightBps: number;
  /** USD per whole token scaled by 1e8, or `null` without a usable reference price. */
  readonly priceE8: bigint | null;
  readonly priceStatus: ReferencePrice["status"];
}

export interface PositionAfter {
  readonly token: Address;
  readonly balance: bigint;
  readonly weightBps: number | null;
  readonly driftBps: number | null;
}

export type DriftAfter =
  | {
      readonly status: "ready";
      readonly positions: readonly PositionAfter[];
      readonly usdcBalance: bigint;
      /** `null` when the weights are undefined: a constituent has no usable price, or nothing is invested. */
      readonly maxAbsDriftBps: number | null;
      readonly thresholdReached: boolean | null;
    }
  /** A balance could not be read. Nothing is computed from a partial read. */
  | { readonly status: "incomplete"; readonly unread: readonly Address[] };

/**
 * Drift of the account against the index after an execution, from balances read again on the chain and the
 * same reference prices the comparison used, with the calculation of `@equityos/core`. Reference prices are
 * not executable prices: this is the same arithmetic as the comparison, applied to the new balances.
 *
 * @param balances balance of each constituent, `null` when its read failed
 * @param usdcBalance balance of USDC, `null` when its read failed
 */
export function driftAfter(input: {
  readonly constituents: readonly ConstituentInput[];
  readonly driftThresholdBps: number;
  readonly balances: ReadonlyMap<string, bigint | null>;
  readonly usdcBalance: bigint | null;
}): DriftAfter {
  const { constituents, driftThresholdBps, balances, usdcBalance } = input;
  const read = constituents.map((constituent) => ({
    constituent,
    balance: balances.get(constituent.token.toLowerCase()) ?? null,
  }));
  const unread = read.flatMap(({ constituent, balance }) => (balance === null ? [constituent.token] : []));
  if (unread.length > 0 || usdcBalance === null) return { status: "incomplete", unread };
  const lower = (token: Address) => token.toLowerCase() as Address;
  const valuation = valuePortfolio({
    constituents: constituents.map(({ token, decimals, targetWeightBps }) => ({
      token: lower(token),
      decimals,
      weightBps: targetWeightBps,
    })),
    holdings: read.map(({ constituent, balance }) => ({
      token: lower(constituent.token),
      balance: balance ?? 0n,
      decimals: constituent.decimals,
    })),
    prices: constituents.flatMap(({ token, priceE8, priceStatus }) =>
      priceE8 === null ? [] : [{ token: lower(token), priceE8, status: priceStatus }],
    ),
    quoteBalance: usdcBalance,
  });
  const drift = computeDrift(valuation.positions, driftThresholdBps);
  const driftOf = new Map(drift?.constituents.map(({ token, driftBps }) => [token, driftBps]) ?? []);
  return {
    status: "ready",
    positions: valuation.positions.map(({ token, balance, weightBps }) => ({
      token,
      balance,
      weightBps,
      driftBps: driftOf.get(token) ?? null,
    })),
    usdcBalance,
    maxAbsDriftBps: drift?.maxAbsDriftBps ?? null,
    thresholdReached: drift?.thresholdReached ?? null,
  };
}
