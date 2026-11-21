/**
 * Static weight calculation of `equityos.calc/1`.
 *
 * Integer arithmetic only. Exact weights are kept as fractions `share * poolBps / shareTotal` and are
 * rounded once, at the end, so the result does not depend on the order of the input or on the platform.
 */

import { BPS, mulDivDown } from "./fixed-point.ts";
import { type Address, type Constituent, type IndexSpec, isAddress, type WeightConstraints } from "./spec.ts";

export type WeightErrorCode =
  | "no_constituents"
  | "invalid_address"
  | "duplicate_token"
  | "non_positive_weight"
  /** A bound that is not an integer in [1, 10_000] bps. */
  | "invalid_bound"
  /** `maxWeightBps` times the number of constituents is below 10_000 bps. */
  | "cap_infeasible"
  /** `minWeightBps` times the number of constituents is above 10_000 bps. */
  | "floor_infeasible";

/**
 * Floor used when `minWeightBps` is absent: a constituent never has a weight of zero. It cannot bind for
 * a valid spec, whose weights before bounds are at least 1 bps and whose cap only raises the others.
 */
const MIN_WEIGHT_BPS = 1;

/** Thrown when the inputs of a weight calculation cannot produce a valid composition. */
export class WeightCalculationError extends RangeError {
  readonly code: WeightErrorCode;

  constructor(code: WeightErrorCode, message: string) {
    super(message);
    this.name = "WeightCalculationError";
    this.code = code;
  }
}

/** A token and its weight before normalization. */
export interface WeightInput {
  readonly token: Address;
  /** Relative weight in any unit, above zero. Only the ratios between the inputs matter. */
  readonly rawWeight: bigint;
}

/**
 * Exact weights after clamping at one bound: a pinned constituent weighs `boundBps`, and a free one
 * weighs `share * poolBps / shareTotal` bps.
 */
interface Allocation {
  readonly pinned: readonly boolean[];
  readonly boundBps: bigint;
  /** Basis points left for the free constituents. */
  readonly poolBps: bigint;
  /** Sum of the shares of the free constituents. */
  readonly shareTotal: bigint;
}

/**
 * Clamps at one bound and gives the difference to, or takes it from, the free constituents in
 * proportion to their weights, repeating until no free constituent is beyond the bound.
 *
 * Redistributing pro rata keeps the ratios between free constituents, so the state after any number
 * of rounds is the set of pinned constituents: no fraction has to be carried between rounds. All
 * constituents beyond the bound in a round are pinned together, from the weights of that round.
 */
function clamp(shares: readonly bigint[], boundBps: bigint, side: "max" | "min" | "none"): Allocation {
  const pinned = shares.map(() => false);
  for (;;) {
    let pinnedCount = 0n;
    let shareTotal = 0n;
    shares.forEach((share, i) => {
      if (pinned[i]) pinnedCount += 1n;
      else shareTotal += share;
    });
    const poolBps = BPS - pinnedCount * boundBps;
    let changed = false;
    shares.forEach((share, i) => {
      if (pinned[i] || side === "none") return;
      // Compares share * poolBps / shareTotal with boundBps without dividing.
      const scaledWeight = share * poolBps;
      const scaledBound = boundBps * shareTotal;
      if (side === "max" ? scaledWeight > scaledBound : scaledWeight < scaledBound) {
        pinned[i] = true;
        changed = true;
      }
    });
    if (!changed) return { pinned, boundBps, poolBps, shareTotal };
  }
}

function bound(
  valueBps: number | undefined,
  name: string,
  count: number,
  side: "max" | "min",
): { readonly boundBps: bigint; readonly side: "max" | "min" | "none" } {
  if (valueBps === undefined) return { boundBps: 0n, side: "none" };
  if (!Number.isSafeInteger(valueBps) || valueBps < 1 || BigInt(valueBps) > BPS) {
    throw new WeightCalculationError(
      "invalid_bound",
      `${name} must be an integer in [1, ${BPS}], received ${valueBps}`,
    );
  }
  const reachableBps = BigInt(valueBps) * BigInt(count);
  if (side === "max" && reachableBps < BPS) {
    throw new WeightCalculationError(
      "cap_infeasible",
      `${count} constituents capped at ${valueBps} bps sum below ${BPS}`,
    );
  }
  if (side === "min" && reachableBps > BPS) {
    throw new WeightCalculationError("floor_infeasible", `${count} constituents of ${valueBps} bps sum above ${BPS}`);
  }
  return { boundBps: BigInt(valueBps), side };
}

/**
 * Normalizes raw weights to basis points under optional bounds.
 *
 * 1. The exact weight of a constituent is `rawWeight * 10_000 / sum(rawWeight)`.
 * 2. Cap: constituents above `maxWeightBps` are set to it and the excess is redistributed pro rata
 *    over the others, until none is above.
 * 3. Floor: constituents below `minWeightBps` (1 bps when absent) are then set to it and the
 *    difference is taken pro rata from the others, until none is below. Weights only decrease here,
 *    so the cap still holds.
 * 4. Rounding: every weight is rounded down to a whole basis point, and the basis points still
 *    missing are given one each to the constituents with the largest remainder, ties going to the
 *    lowest token address.
 *
 * The result is in ascending token order, sums to exactly 10_000 and does not depend on input order.
 *
 * @throws {WeightCalculationError} if the inputs or the bounds are invalid.
 */
export function computeWeights(inputs: readonly WeightInput[], constraints: WeightConstraints = {}): Constituent[] {
  if (inputs.length === 0) throw new WeightCalculationError("no_constituents", "at least one constituent is required");
  // Lowercase hexadecimal strings of equal length order the same way as the addresses they encode.
  const sorted = [...inputs].sort((a, b) => (a.token < b.token ? -1 : a.token > b.token ? 1 : 0));
  sorted.forEach(({ token, rawWeight }, i) => {
    if (!isAddress(token)) throw new WeightCalculationError("invalid_address", `${token} is not a lowercase address`);
    if (token === sorted[i - 1]?.token) throw new WeightCalculationError("duplicate_token", `${token} is repeated`);
    if (rawWeight <= 0n)
      throw new WeightCalculationError("non_positive_weight", `the weight of ${token} is not above 0`);
  });
  const cap = bound(constraints.maxWeightBps, "maxWeightBps", sorted.length, "max");
  const floor = bound(constraints.minWeightBps ?? MIN_WEIGHT_BPS, "minWeightBps", sorted.length, "min");

  const capped = clamp(
    sorted.map(({ rawWeight }) => rawWeight),
    cap.boundBps,
    cap.side,
  );
  // The capped weights over the common denominator `capped.shareTotal`, used as shares of the next step.
  const entries = sorted.map(({ token, rawWeight }, i) => ({
    token,
    share: capped.pinned[i] ? capped.boundBps * capped.shareTotal : rawWeight * capped.poolBps,
  }));
  const floored = clamp(
    entries.map(({ share }) => share),
    floor.boundBps,
    floor.side,
  );

  const rows = entries.map(({ token, share }, index) => {
    if (floored.pinned[index]) return { token, index, weightBps: floored.boundBps, remainder: 0n };
    // Rounds down: the basis points lost here are handed out below by largest remainder.
    const weightBps = mulDivDown(share, floored.poolBps, floored.shareTotal);
    return { token, index, weightBps, remainder: (share * floored.poolBps) % floored.shareTotal };
  });
  const missingBps = BPS - rows.reduce((sum, row) => sum + row.weightBps, 0n);
  // `rows` is in ascending token order, so the index breaks ties in favor of the lowest address.
  const byRemainder = [...rows].sort((a, b) => {
    if (a.remainder !== b.remainder) return a.remainder > b.remainder ? -1 : 1;
    return a.index - b.index;
  });
  for (const row of byRemainder.slice(0, Number(missingBps))) row.weightBps += 1n;

  return rows.map(({ token, weightBps }) => ({ token, weightBps: Number(weightBps) }));
}

/** The constituents a valid spec implies: its tokens, in order, with the weights of `equityos.calc/1`. */
export function computeConstituents(spec: IndexSpec): Constituent[] {
  const { weighting } = spec;
  const inputs = spec.universe.tokens.map((token, i) => ({
    token,
    rawWeight: weighting.type === "fixed" ? BigInt(weighting.weightsBps[i] ?? 0) : 1n,
  }));
  return computeWeights(inputs, spec.constraints);
}
