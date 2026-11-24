/** Largest deposit the plan endpoint accepts: 1,000,000,000 USD, scaled by 1e8. */
export const MAX_DEPOSIT_USD_E8 = 10n ** 17n;

const USD_E8_DECIMALS = 8;
const PLAIN = /^(\d*)(?:\.(\d*))?$/;
const GROUPED = /^(\d{1,3}(?:,\d{3})+)(?:\.(\d*))?$/;

export type DepositParse =
  | { readonly ok: true; readonly usdE8: bigint }
  | { readonly ok: false; readonly reason: "empty" | "format" | "precision" | "too_large" };

/**
 * Parses a USD amount typed by a person into USD scaled by 1e8, exactly: digits, an optional decimal point and
 * at most 8 decimals, with optional thousands separators in groups of three. Nothing passes through a
 * floating-point number, and an amount that does not fit exactly is refused, never rounded.
 */
export function parseDepositUsd(input: string): DepositParse {
  const text = input.trim();
  if (text === "") return { ok: false, reason: "empty" };
  const match = PLAIN.exec(text) ?? GROUPED.exec(text);
  const whole = match?.[1];
  const fraction = match?.[2] ?? "";
  if (whole === undefined || (whole === "" && fraction === "")) return { ok: false, reason: "format" };
  if (fraction.length > USD_E8_DECIMALS) return { ok: false, reason: "precision" };
  const usdE8 = BigInt(whole.replaceAll(",", "") + fraction.padEnd(USD_E8_DECIMALS, "0"));
  return usdE8 > MAX_DEPOSIT_USD_E8 ? { ok: false, reason: "too_large" } : { ok: true, usdE8 };
}

export const DEPOSIT_ERRORS: Record<Exclude<DepositParse, { ok: true }>["reason"], string> = {
  empty: "Enter an amount in USD.",
  format: "Use digits with an optional decimal point, for example 250 or 1,250.50.",
  precision: "Use at most 8 decimals.",
  too_large: "The largest amount is 1,000,000,000 USD.",
};
