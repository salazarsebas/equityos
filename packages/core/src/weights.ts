/**
 * Static weight calculation of `equityos.calc/1`.
 *
 * A published weight is either exactly what the author wrote (`fixed`) or exactly equal (`equal`). The
 * calculation never adjusts a weight to satisfy a constraint: `constraints` are checked when the spec is
 * validated, and a spec that breaks them is invalid. Integer arithmetic only.
 */

import { BPS, mulDivDown } from "./fixed-point.ts";
import { type Address, type Constituent, type IndexSpec, isAddress } from "./spec.ts";

export type WeightErrorCode =
  | "no_constituents"
  /** More constituents than basis points, so an equal weight would round to zero. */
  | "too_many_constituents"
  | "invalid_address"
  | "duplicate_token"
  /** A fixed weighting without exactly one weight per token. A valid spec never has this. */
  | "length_mismatch";

/** Thrown when the inputs of a weight calculation cannot produce a valid composition. */
export class WeightCalculationError extends RangeError {
  readonly code: WeightErrorCode;

  constructor(code: WeightErrorCode, message: string) {
    super(message);
    this.name = "WeightCalculationError";
    this.code = code;
  }
}

/**
 * Splits 10_000 bps equally between tokens.
 *
 * Every token gets `floor(10_000 / n)` bps. The basis points still missing are given one each by largest
 * remainder; all remainders are equal here, so the tie-break decides: the lowest token addresses get them.
 *
 * The result is in ascending token order, sums to exactly 10_000 and does not depend on input order.
 *
 * @throws {WeightCalculationError} if the tokens are empty, repeated, malformed or more than 10_000.
 */
export function computeEqualWeights(tokens: readonly Address[]): Constituent[] {
  const count = BigInt(tokens.length);
  if (count === 0n) throw new WeightCalculationError("no_constituents", "at least one constituent is required");
  if (count > BPS) {
    throw new WeightCalculationError("too_many_constituents", `${count} constituents cannot each have 1 bps`);
  }
  // Lowercase hexadecimal strings of equal length order the same way as the addresses they encode.
  const sorted = [...tokens].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  sorted.forEach((token, i) => {
    if (!isAddress(token)) throw new WeightCalculationError("invalid_address", `${token} is not a lowercase address`);
    if (token === sorted[i - 1]) throw new WeightCalculationError("duplicate_token", `${token} is repeated`);
  });
  // Rounds down: the basis points lost here are handed out to the lowest addresses.
  const baseBps = mulDivDown(BPS, 1n, count);
  const missingBps = BPS - baseBps * count;
  return sorted.map((token, i) => ({ token, weightBps: Number(BigInt(i) < missingBps ? baseBps + 1n : baseBps) }));
}

/**
 * The constituents a valid spec implies: its tokens, in order, with the weights of `equityos.calc/1`.
 * Fixed weights are returned exactly as written in the spec.
 */
export function computeConstituents(spec: IndexSpec): Constituent[] {
  const { weighting } = spec;
  if (weighting.type === "equal") return computeEqualWeights(spec.universe.tokens);
  const { tokens } = spec.universe;
  if (weighting.weightsBps.length !== tokens.length) {
    throw new WeightCalculationError("length_mismatch", "a fixed weighting needs one weight per token");
  }
  return tokens.flatMap((token, i) => {
    const weightBps = weighting.weightsBps[i];
    return weightBps === undefined ? [] : [{ token, weightBps }];
  });
}
