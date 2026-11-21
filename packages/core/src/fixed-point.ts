/**
 * Fixed-point helpers on bigint.
 *
 * All financial math in EquityOS is done on integers with explicit units.
 * These helpers cover unsigned quantities only (token amounts, weights,
 * prices scaled to an integer): negative operands are rejected instead of
 * being rounded in a direction that depends on their sign.
 */

/** One whole expressed in basis points: 10_000 bps = 100%. */
export const BPS = 10_000n;

/** Thrown when a fixed-point division has a zero denominator. */
export class DivisionByZeroError extends RangeError {
  constructor() {
    super("division by zero");
    this.name = "DivisionByZeroError";
  }
}

/** Thrown when an operand of an unsigned fixed-point operation is negative. */
export class NegativeOperandError extends RangeError {
  constructor(operand: string, value: bigint) {
    super(`${operand} must not be negative, received ${value}`);
    this.name = "NegativeOperandError";
  }
}

function assertOperands(a: bigint, b: bigint, denominator: bigint): void {
  if (denominator === 0n) throw new DivisionByZeroError();
  if (a < 0n) throw new NegativeOperandError("a", a);
  if (b < 0n) throw new NegativeOperandError("b", b);
  if (denominator < 0n) throw new NegativeOperandError("denominator", denominator);
}

/**
 * Computes `floor(a * b / denominator)` without intermediate precision loss.
 *
 * @throws {DivisionByZeroError} if `denominator` is zero.
 * @throws {NegativeOperandError} if any operand is negative.
 */
export function mulDivDown(a: bigint, b: bigint, denominator: bigint): bigint {
  assertOperands(a, b, denominator);
  return (a * b) / denominator;
}

/**
 * Computes `ceil(a * b / denominator)` without intermediate precision loss.
 *
 * @throws {DivisionByZeroError} if `denominator` is zero.
 * @throws {NegativeOperandError} if any operand is negative.
 */
export function mulDivUp(a: bigint, b: bigint, denominator: bigint): bigint {
  assertOperands(a, b, denominator);
  const product = a * b;
  const quotient = product / denominator;
  return product % denominator === 0n ? quotient : quotient + 1n;
}
