import { type Address, type Constituent, TOTAL_WEIGHT_BPS } from "@equityos/core";

/**
 * Percent text and basis points. A weight is typed as a percentage with at most two decimals and stored in
 * basis points, 1 bps = 0.01%, so the two map onto each other exactly. The text is parsed digit by digit: it
 * never becomes a floating-point number, which could turn 0.29 into 28.999999 bps.
 */
const PERCENT_PATTERN = /^(\d{0,7})(?:\.(\d{0,2}))?$/;

/**
 * Basis points of a percentage written with at most two decimals, or `null` when the text is not one.
 * Blank text is 0 bps: nothing was assigned.
 */
export function percentTextToBps(text: string): number | null {
  const trimmed = text.trim();
  const match = PERCENT_PATTERN.exec(trimmed);
  if (match === null || trimmed === ".") return null;
  const whole = BigInt(match[1] || "0");
  const hundredths = BigInt((match[2] ?? "").padEnd(2, "0") || "0");
  return Number(whole * 100n + hundredths);
}

/** A weight in basis points as percent text with two decimals and no separators: 1250 is `12.50`. */
export function bpsToPercentText(bps: number): string {
  const value = BigInt(bps);
  return `${value / 100n}.${(value % 100n).toString().padStart(2, "0")}`;
}

function byToken(a: Constituent, b: Constituent): number {
  return a.token < b.token ? -1 : a.token > b.token ? 1 : 0;
}

/** The sum of weights in basis points. */
export function sumBps(weightsBps: readonly number[]): number {
  return Number(weightsBps.reduce((sum, weightBps) => sum + BigInt(weightBps), 0n));
}

/**
 * Moves the weights to a total of exactly 10,000 bps with the rule `equityos.calc/1` uses for equal weights.
 *
 * - Under 10,000: the missing basis points are split equally between all constituents, rounded down, and what
 *   is still missing is given one each to the lowest token addresses. On weights that are all zero this is
 *   exactly `computeEqualWeights`.
 * - Over 10,000: the excess is taken in equal parts, rounded down, from the constituents above 1 bps, lowest
 *   token address first for what does not divide, and no weight goes under 1 bps.
 *
 * The result is in ascending token order, the order of a spec.
 */
export function distributeRemainder(weights: readonly Constituent[]): Constituent[] {
  const sorted = [...weights].sort(byToken).map(({ token, weightBps }) => ({ token, weightBps: BigInt(weightBps) }));
  const total = BigInt(TOTAL_WEIGHT_BPS);
  const count = BigInt(sorted.length);
  let sum = sorted.reduce((acc, { weightBps }) => acc + weightBps, 0n);
  if (count > 0n && sum < total) {
    const missing = total - sum;
    const share = missing / count;
    const extra = missing - share * count;
    sorted.forEach((entry, i) => {
      entry.weightBps += share + (BigInt(i) < extra ? 1n : 0n);
    });
  }
  while (sum > total) {
    const givers = sorted.filter(({ weightBps }) => weightBps > 1n);
    if (givers.length === 0) break;
    const excess = sum - total;
    const share = excess / BigInt(givers.length) || 1n;
    for (const entry of givers) {
      const taken = [share, entry.weightBps - 1n, sum - total].reduce((min, value) => (value < min ? value : min));
      entry.weightBps -= taken;
      sum -= taken;
    }
  }
  return sorted.map(({ token, weightBps }) => ({ token, weightBps: Number(weightBps) }));
}

/** Tokens in the order a spec lists them: ascending by address. */
export function sortTokens(tokens: readonly Address[]): Address[] {
  return [...tokens].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}
