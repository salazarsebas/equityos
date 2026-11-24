import "server-only";
import type { Address, Hex } from "viem";

/** Chain id of Base mainnet, the only chain execution plans are built for. */
export const EXECUTION_CHAIN_ID = 8453;

/** One exact-input swap to quote. Amounts are base units of the token they are in. */
export interface QuoteRequest {
  readonly tokenIn: Address;
  readonly tokenOut: Address;
  /** Exact amount of `tokenIn` to swap. */
  readonly amountIn: bigint;
  /** The account that sends `tokenIn` and receives `tokenOut`. */
  readonly account: Address;
  /** Tolerance the provider applies to its quoted amount to derive the minimum amount out, in basis points. */
  readonly slippageBps: number;
  /** Unix seconds. Passed to the provider as the time after which its route must not execute. */
  readonly deadline: number;
}

/**
 * What a provider answered, before any verification. Nothing in it is trusted: `verifyQuote` decodes the
 * calldata and checks every field that can be checked before a caller sees an `ExecutableQuote`.
 */
export interface ProviderQuote {
  readonly provider: string;
  /** Amount out the provider quotes, base units of `tokenOut`. */
  readonly quotedAmountOut: bigint;
  /** Amount in the provider says the calldata swaps. Checked against the request. */
  readonly amountIn: bigint;
  /** Contract the calldata is addressed to. Checked against the router allowlist. */
  readonly router: Address;
  readonly calldata: Hex;
  /** Native value to send with the call, in wei. */
  readonly value: bigint;
  /** Gas the provider estimates for the swap. An estimate of the provider, never verified. */
  readonly gasEstimate: bigint;
  /** Identifier of the route at the provider, for support requests. */
  readonly routeId: string;
}

/**
 * Why there is no executable quote. Expected states, returned as data:
 * - `no_route`: the provider found no route for the pair and amount.
 * - `provider_rejected`: the provider refused the request (a 4xx other than rate limiting).
 * - `provider_rate_limited`: the provider still answered 429 after the one retry.
 * - `provider_unavailable`: transport failure, timeout or 5xx, after the one retry.
 * - `provider_malformed`: the answer does not have the documented shape.
 * - `router_not_allowed`: the calldata is addressed to a contract other than the allowlisted router.
 * - `unknown_selector`: the calldata calls a function that is not one of the allowed swap functions.
 * - `calldata_mismatch`: the decoded calldata does not swap what was requested, for whom it was requested,
 *   or with a minimum amount out at least the one recomputed from the quote.
 */
export type QuoteFailureReason =
  | "no_route"
  | "provider_rejected"
  | "provider_rate_limited"
  | "provider_unavailable"
  | "provider_malformed"
  | "router_not_allowed"
  | "unknown_selector"
  | "calldata_mismatch";

export interface QuoteFailure {
  readonly status: "failed";
  readonly reason: QuoteFailureReason;
  /** Machine-readable context: the provider error code, or the fields that did not verify. */
  readonly detail: string | null;
}

export type ProviderResult = { readonly status: "ok"; readonly quote: ProviderQuote } | QuoteFailure;

/** A source of executable swap quotes. Implementations never throw for an expected state: they return it. */
export interface QuoteProvider {
  readonly name: string;
  quote(request: QuoteRequest): Promise<ProviderResult>;
}
