/**
 * Value of a token position at a reference price.
 *
 * Units: `balance` is in token base units (10^decimals base units are one token), `priceE8` is USD per one
 * whole token scaled by 1e8, and the result is USD scaled by 1e8.
 */

import { mulDivDown, mulDivUp } from "./fixed-point.ts";

/** Scale of USD prices and values: 1e8 is 1.00 USD. */
export const USD_E8 = 100_000_000n;

/** Largest token decimal count accepted. Token standards in scope use at most 18. */
export const MAX_TOKEN_DECIMALS = 36;

/** Thrown when a token decimal count is not an integer in `[0, MAX_TOKEN_DECIMALS]`. */
export class InvalidDecimalsError extends RangeError {
  constructor(decimals: number) {
    super(`token decimals must be an integer between 0 and ${MAX_TOKEN_DECIMALS}, received ${decimals}`);
    this.name = "InvalidDecimalsError";
  }
}

/** Rounding direction of the single division in a value computation. */
export type Rounding = "down" | "up";

/**
 * Computes `balance * priceE8 / 10^decimals` in USD scaled by 1e8.
 *
 * The rounding direction has no default. Round "down" when the value is credited to the holder (a displayed
 * position value, a weight numerator), and "up" when it is an amount the holder must cover.
 *
 * The price must already be the price of one token. For tokens whose reference price includes a share
 * multiplier, do not apply the multiplier here.
 *
 * @param balance token base units, non-negative
 * @param priceE8 USD per whole token scaled by 1e8, non-negative
 * @param decimals decimals of the token
 * @param rounding direction of the division
 * @throws {InvalidDecimalsError} if `decimals` is out of range.
 * @throws {NegativeOperandError} if `balance` or `priceE8` is negative.
 */
export function positionValueUsdE8(balance: bigint, priceE8: bigint, decimals: number, rounding: Rounding): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > MAX_TOKEN_DECIMALS) {
    throw new InvalidDecimalsError(decimals);
  }
  const unit = 10n ** BigInt(decimals);
  return rounding === "up" ? mulDivUp(balance, priceE8, unit) : mulDivDown(balance, priceE8, unit);
}
