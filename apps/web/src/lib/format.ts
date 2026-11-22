/**
 * Number and time formatting for rendered UI.
 *
 * Every quantity enters as a bigint in an explicit unit (basis points, base units with a decimal count, Unix
 * seconds) and leaves as a string. No value passes through a floating-point number. Negative values use the true
 * minus sign (U+2212) so that signed columns align; CSV and API output must not use these helpers.
 */

export const MINUS = "−";

/** Rendered in place of a value that is missing. Never substitute zero. */
export const MISSING = "-";

type Rounding = "half-up" | "down";

function assertDecimals(decimals: number): void {
  if (!Number.isInteger(decimals) || decimals < 0) throw new RangeError(`invalid decimal count: ${decimals}`);
}

function pow10(exponent: number): bigint {
  assertDecimals(exponent);
  return 10n ** BigInt(exponent);
}

function group(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+$)/g, ",");
}

/** Rescales a non-negative fixed-point magnitude to `toDecimals`. "half-up" rounds ties away from zero. */
function rescale(magnitude: bigint, fromDecimals: number, toDecimals: number, rounding: Rounding): bigint {
  assertDecimals(fromDecimals);
  assertDecimals(toDecimals);
  if (toDecimals >= fromDecimals) return magnitude * pow10(toDecimals - fromDecimals);
  const divisor = pow10(fromDecimals - toDecimals);
  const quotient = magnitude / divisor;
  return rounding === "half-up" && (magnitude % divisor) * 2n >= divisor ? quotient + 1n : quotient;
}

/** Renders a non-negative integer that carries `fractionDigits` implied decimals, with thousands separators. */
function renderUnsigned(scaled: bigint, fractionDigits: number): string {
  const digits = scaled.toString().padStart(fractionDigits + 1, "0");
  const whole = group(digits.slice(0, digits.length - fractionDigits));
  return fractionDigits === 0 ? whole : `${whole}.${digits.slice(digits.length - fractionDigits)}`;
}

function abs(value: bigint): bigint {
  return value < 0n ? -value : value;
}

/**
 * Formats a fixed-point value with a fixed number of decimals and thousands separators.
 * Rounds half away from zero. A value that rounds to zero is rendered unsigned.
 *
 * @param value integer in base units
 * @param decimals number of decimals `value` is scaled by
 * @param fractionDigits number of decimals to render
 */
export function formatFixed(value: bigint, decimals: number, fractionDigits: number): string {
  const scaled = rescale(abs(value), decimals, fractionDigits, "half-up");
  const text = renderUnsigned(scaled, fractionDigits);
  return value < 0n && scaled !== 0n ? `${MINUS}${text}` : text;
}

/** Integer count with thousands separators: `1,204`. */
export function formatCount(count: bigint): string {
  return formatFixed(count, 0, 0);
}

/** Percent from basis points, always 2 decimals: `1500n` is `15.00%`. Exact, since 1 bp is 0.01%. */
export function formatPercent(bps: bigint): string {
  return `${formatFixed(bps, 2, 2)}%`;
}

function sign(value: bigint): string {
  return value > 0n ? "+" : "";
}

/** Signed percent change from basis points: `+3.42%`, `−0.38%`. Zero is unsigned: `0.00%`. */
export function formatSignedPercent(bps: bigint): string {
  return `${sign(bps)}${formatPercent(bps)}`;
}

/** Signed difference between two percentages, in percentage points, from basis points: `+3.21 pp`. */
export function formatPercentagePoints(bps: bigint): string {
  return `${sign(bps)}${formatFixed(bps, 2, 2)} pp`;
}

/**
 * USD amount from a fixed-point bigint: 2 decimals, thousands separators, half away from zero.
 * A non-zero amount smaller than one cent renders as `<0.01` instead of rounding to `0.00` or `0.01`.
 * The unit belongs in the column header or after the value, so no currency symbol is added.
 */
export function formatUsd(amount: bigint, decimals: number): string {
  const magnitude = abs(amount);
  if (magnitude !== 0n && magnitude * 100n < pow10(decimals)) return `${amount < 0n ? MINUS : ""}<0.01`;
  return formatFixed(amount, decimals, 2);
}

/** Reference or quote price in USD: 2 decimals, or 4 when the price is under 1.00. Half away from zero. */
export function formatPrice(price: bigint, decimals: number): string {
  return formatFixed(price, decimals, abs(price) < pow10(decimals) ? 4 : 2);
}

const SIGNIFICANT_DIGITS = 6;

/**
 * Token quantity from base units: up to 6 significant digits, trailing zeros trimmed, never scientific.
 * Rounds toward zero so a displayed balance never exceeds the real one. The integer part is never shortened.
 *
 * @param amount integer in token base units
 * @param decimals decimals of the token
 */
export function formatTokenQuantity(amount: bigint, decimals: number): string {
  const magnitude = abs(amount);
  if (magnitude === 0n) return "0";
  const unit = pow10(decimals);
  const wholeDigits = magnitude >= unit ? (magnitude / unit).toString().length : 0;
  // Below 1, leading fractional zeros are not significant: 0.000412 has three of them.
  const leadingZeros = wholeDigits === 0 ? decimals - magnitude.toString().length : 0;
  const fractionDigits = Math.min(decimals, Math.max(0, SIGNIFICANT_DIGITS - wholeDigits) + leadingZeros);
  const text = renderUnsigned(rescale(magnitude, decimals, fractionDigits, "down"), fractionDigits);
  const trimmed = text.includes(".") ? text.replace(/\.?0+$/, "") : text;
  return amount < 0n ? `${MINUS}${trimmed}` : trimmed;
}

const COMPACT_UNITS = [
  { suffix: "M", exponent: 6 },
  { suffix: "B", exponent: 9 },
  { suffix: "T", exponent: 12 },
] as const;

/**
 * Compact form for stat rows: values of one million and above are abbreviated to one decimal (`1.2M`),
 * smaller values render as a full integer. Half away from zero. Do not use in tables.
 */
export function formatCompact(value: bigint, decimals = 0): string {
  const magnitude = abs(value);
  const prefix = value < 0n ? MINUS : "";
  if (magnitude < pow10(decimals + 6)) return formatFixed(value, decimals, 0);
  for (const [index, { suffix, exponent }] of COMPACT_UNITS.entries()) {
    const tenths = rescale(magnitude, decimals + exponent, 1, "half-up");
    // 999.95M rounds to 1000.0M: move to the next unit instead.
    if (tenths < 10_000n || index === COMPACT_UNITS.length - 1) return `${prefix}${renderUnsigned(tenths, 1)}${suffix}`;
  }
  return formatFixed(value, decimals, 0);
}

const MAX_UNIX_SECONDS = 8_640_000_000_000n;

function toDate(unixSeconds: bigint): Date {
  if (abs(unixSeconds) > MAX_UNIX_SECONDS) throw new RangeError(`timestamp out of range: ${unixSeconds}`);
  return new Date(Number(unixSeconds) * 1000);
}

/** ISO 8601 instant for the `dateTime` attribute of a `<time>` element. */
export function toIsoInstant(unixSeconds: bigint): string {
  return toDate(unixSeconds).toISOString();
}

/** Calendar date in UTC, ISO form: `2026-11-21`. */
export function formatUtcDate(unixSeconds: bigint): string {
  return toIsoInstant(unixSeconds).slice(0, 10);
}

/** Timestamp in UTC to the minute, zone not stated: `2026-11-20 21:00`. For a column whose header says UTC. */
export function formatUtcMinute(unixSeconds: bigint): string {
  const iso = toIsoInstant(unixSeconds);
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}

/** Absolute timestamp in UTC, 24-hour, zone stated: `2026-11-20 21:00 UTC`. */
export function formatUtcDateTime(unixSeconds: bigint): string {
  return `${formatUtcMinute(unixSeconds)} UTC`;
}

const RELATIVE_UNITS = [
  { label: "d", seconds: 86_400n },
  { label: "h", seconds: 3_600n },
  { label: "min", seconds: 60n },
  { label: "s", seconds: 1n },
] as const;

/**
 * Relative time between two instants, in the largest whole unit, rounded down: `4 s ago`, `3 min ago`, `in 2 h`.
 * The current time is an argument so the result is deterministic. Use only for live status, never in data lines.
 */
export function formatRelativeTime(unixSeconds: bigint, nowUnixSeconds: bigint): string {
  const delta = nowUnixSeconds - unixSeconds;
  const magnitude = abs(delta);
  if (magnitude === 0n) return "now";
  for (const { label, seconds } of RELATIVE_UNITS) {
    if (magnitude >= seconds) {
      const amount = `${formatCount(magnitude / seconds)} ${label}`;
      return delta > 0n ? `${amount} ago` : `in ${amount}`;
    }
  }
  return "now";
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** Shortens a 20-byte hex address to its first 6 and last 4 characters: `0x1234...abcd`. */
export function shortenAddress(address: string): string {
  if (!ADDRESS.test(address)) throw new TypeError(`not a 20-byte hex address: ${address}`);
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

const HASH = /^0x[0-9a-fA-F]{64}$/;

/** Shortens a 32-byte hash or id to its first 8 hexadecimal digits: `0x90d5104e`. */
export function shortenHash(hash: string): string {
  if (!HASH.test(hash)) throw new TypeError(`not a 32-byte hex value: ${hash}`);
  return hash.slice(0, 10);
}
