import "server-only";
import { mulDivUp, type PriceStatus } from "@equityos/core";
import type { Address } from "viem";
import type { Jurisdiction } from "@/server/jurisdiction";

/**
 * Outcome of one check. `pass` and `warn` let the plan proceed; a `warn` must be shown. `block` stops it.
 * `not_simulated` stops it unless the caller accepted unsimulated execution. `skipped` means a prerequisite
 * failed and is reported by its own check.
 */
export type CheckStatus = "pass" | "warn" | "block" | "not_simulated" | "skipped";

export type CheckId =
  | "jurisdiction"
  | "reference_plan"
  | "reference_freshness"
  | "quote"
  | "transfers_not_paused"
  | "policy_authorized"
  | "multiplier_window"
  | "price_deviation"
  | "balance"
  | "allowance"
  | "simulation"
  | "plan_expiry";

export interface CheckResult {
  readonly check: CheckId;
  readonly status: CheckStatus;
  /** Stable reason code within the check. */
  readonly reason: string;
  /** The token concerned, or `null` for the whole plan. */
  readonly token: Address | null;
  /** Index of the leg concerned in `legs`, or `null`. */
  readonly leg: number | null;
  /** Machine-readable context: failed scopes, a provider code, a time. `null` when there is none. */
  readonly detail: string | null;
}

export function result(
  check: CheckId,
  status: CheckStatus,
  reason: string,
  scope: { token?: Address; leg?: number; detail?: string | null } = {},
): CheckResult {
  return { check, status, reason, token: scope.token ?? null, leg: scope.leg ?? null, detail: scope.detail ?? null };
}

/**
 * Execution is withheld from restricted requests. A country that cannot be established in production is
 * restricted (fail closed). Outside production, where no platform sets the header, the request proceeds with
 * a warning that names the reason.
 */
export function jurisdictionCheck(jurisdiction: Jurisdiction): CheckResult {
  if (jurisdiction.restricted) return result("jurisdiction", "block", jurisdiction.reason);
  if (jurisdiction.reason === "development_no_geolocation") return result("jurisdiction", "warn", jurisdiction.reason);
  return result("jurisdiction", "pass", jurisdiction.reason, { detail: jurisdiction.country });
}

/**
 * Freshness of the reference price a leg is checked against. `live` passes. `delayed` warns: the feed
 * publishes on a 0.5% move, so a delayed value in an open session is within that move of its source.
 * `last_close` blocks: the market is closed, the value is hours or days old while onchain prices move, and a
 * deviation band against it bounds nothing. `unavailable` blocks: there is nothing to check against.
 */
export function freshnessCheck(status: PriceStatus, token: Address, leg: number): CheckResult {
  const outcome = status === "live" ? "pass" : status === "delayed" ? "warn" : "block";
  return result("reference_freshness", outcome, status, { token, leg });
}

/** Largest magnitude a reported deviation takes, in basis points (100 times the reference price). */
export const DEVIATION_REPORT_LIMIT_BPS = 1_000_000n;

/**
 * Deviation of the executable price from the reference price, signed, in basis points:
 * `(executable - reference) / reference`. Positive when the executable price is above the reference, which
 * receives more for a sell and pays more for a buy. Computed exactly from integers, then rounded away from
 * zero, so a deviation is never reported smaller than it is. `quoteAmount` is in USDC base units (6 decimals),
 * `tokenAmount` in base units of a token with `decimals`, `priceE8` in USD per token scaled by 1e8.
 */
export function deviationBps(quoteAmount: bigint, tokenAmount: bigint, decimals: number, priceE8: bigint): bigint {
  // Executable price in USD scaled by 1e8 per token is quoteAmount * 100 * 10^decimals / tokenAmount.
  const executable = quoteAmount * 100n * 10n ** BigInt(decimals);
  const reference = tokenAmount * priceE8;
  if (reference <= 0n) throw new RangeError("deviation needs a positive token amount and price");
  const difference = executable - reference;
  const magnitude = mulDivUp(difference < 0n ? -difference : difference, 10_000n, reference);
  return difference < 0n ? -magnitude : magnitude;
}

/** The deviation as a JSON-safe number, clamped to `DEVIATION_REPORT_LIMIT_BPS`. */
export function reportedDeviation(bps: bigint): number {
  return Number(bps > DEVIATION_REPORT_LIMIT_BPS ? DEVIATION_REPORT_LIMIT_BPS : bps);
}

/**
 * Both the quoted and the minimum-out prices must deviate from the reference by at most the band, in either
 * direction, so the worst outcome a plan accepts is within it. A price far better than the reference is as
 * suspect as one far worse: one of the two prices is wrong. `detail` is `quoted/minimum`, in bps.
 */
export function deviationCheck(quotedBps: bigint, minimumBps: bigint, bandBps: number, token: Address, leg: number) {
  const within = (bps: bigint) => (bps < 0n ? -bps : bps) <= BigInt(bandBps);
  const outcome = within(quotedBps) && within(minimumBps) ? "pass" : "block";
  return result("price_deviation", outcome, outcome === "pass" ? "within_band" : "outside_band", {
    token,
    leg,
    detail: `${reportedDeviation(quotedBps)}/${reportedDeviation(minimumBps)}`,
  });
}

/**
 * No multiplier update may take effect within `windowSeconds` from now. `effectiveAt` is the recorded time of
 * the latest update, `0` when none was ever recorded, `null` when it could not be read. An update dated at or
 * before the block is already in effect and is not pending.
 */
export function multiplierCheck(
  effectiveAt: number | null,
  blockTimestamp: number,
  now: number,
  windowSeconds: number,
  token: Address,
): CheckResult {
  if (effectiveAt === null) return result("multiplier_window", "block", "read_failed", { token });
  if (effectiveAt <= blockTimestamp) return result("multiplier_window", "pass", "none_pending", { token });
  const detail = String(effectiveAt);
  return effectiveAt <= now + windowSeconds
    ? result("multiplier_window", "block", "pending_within_window", { token, detail })
    : result("multiplier_window", "pass", "pending_outside_window", { token, detail });
}

export function pauseCheck(paused: boolean | null, token: Address): CheckResult {
  if (paused === null) return result("transfers_not_paused", "block", "read_failed", { token });
  return result("transfers_not_paused", paused ? "block" : "pass", paused ? "paused" : "not_paused", { token });
}

export interface Authorization {
  /** The account may send the token. */
  readonly sender: boolean | null;
  /** The account may receive the token. */
  readonly receiver: boolean | null;
  /** The router, which pulls the token from the account, may initiate transfers. */
  readonly executor: boolean | null;
}

export function policyCheck(authorization: Authorization, token: Address): CheckResult {
  const scopes = ["sender", "receiver", "executor"] as const;
  if (scopes.some((scope) => authorization[scope] === null)) {
    return result("policy_authorized", "block", "read_failed", { token });
  }
  const denied = scopes.filter((scope) => authorization[scope] === false);
  return denied.length === 0
    ? result("policy_authorized", "pass", "authorized", { token })
    : result("policy_authorized", "block", "not_authorized", { token, detail: denied.join(",") });
}

/** The approval a token needs toward the router: exactly what the plan swaps of it, never more. */
export interface Approval {
  readonly token: Address;
  readonly spender: Address;
  readonly currentAllowance: bigint;
  /** Total the plan swaps of the token. An approval, when required, is for exactly this amount. */
  readonly amount: bigint;
  /** The current allowance is below `amount`. */
  readonly required: boolean;
}

export function approvalFor(token: Address, spender: Address, amount: bigint, allowance: bigint): Approval {
  return { token, spender, currentAllowance: allowance, amount, required: allowance < amount };
}

/**
 * The allowance toward the router must be readable. One above what the plan swaps, unlimited included, is a
 * warning with the amount: the router could pull more than the plan if it were ever called with other calldata.
 */
export function allowanceCheck(allowance: bigint | null, amount: bigint, token: Address): CheckResult {
  if (allowance === null) return result("allowance", "block", "read_failed", { token });
  if (allowance > amount) return result("allowance", "warn", "above_plan", { token, detail: allowance.toString() });
  return result("allowance", "pass", "within_plan", { token, detail: allowance.toString() });
}

/** `balance >= needed`, with the amounts in the detail as `needed/balance`. */
export function balanceCheck(balance: bigint | null, needed: bigint, token: Address): CheckResult {
  if (balance === null) return result("balance", "block", "read_failed", { token });
  const outcome = balance >= needed ? "pass" : "block";
  return result("balance", outcome, outcome === "pass" ? "sufficient" : "insufficient", {
    token,
    detail: `${needed}/${balance}`,
  });
}

/** Whether a set of checks lets the plan proceed, and whether every check passed. */
export function verdict(checks: readonly CheckResult[], allowUnsimulated: boolean) {
  const blocking = checks.filter(
    ({ status }) => status === "block" || (status === "not_simulated" && !allowUnsimulated),
  );
  const executable = checks.every(({ status }) => status === "pass" || status === "warn");
  return { blocking, executable: blocking.length === 0 && executable };
}
