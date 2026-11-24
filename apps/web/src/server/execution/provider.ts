import "server-only";
import type { ProviderQuote, QuoteFailure, QuoteRequest } from "@/lib/execution/calldata";

export type {
  ExecutableQuote,
  ProviderQuote,
  QuoteFailure,
  QuoteFailureReason,
  QuoteRequest,
} from "@/lib/execution/calldata";
export { EXECUTION_CHAIN_ID } from "@/lib/execution/calldata";

export type ProviderResult = { readonly status: "ok"; readonly quote: ProviderQuote } | QuoteFailure;

/** Limits that apply to one call of `quote`. */
export interface QuoteContext {
  /** Aborts the requests of the call: the overall deadline of the request being served. */
  readonly signal: AbortSignal;
  /**
   * Takes one provider request from the deployment's budget for a retry. A retry is made only when it returns
   * true; the first two requests of a quote are taken from the budget before quoting.
   */
  readonly takeRetry: () => boolean;
}

/** A source of executable swap quotes. Implementations never throw for an expected state: they return it. */
export interface QuoteProvider {
  readonly name: string;
  /** Provider requests one quote makes when nothing fails: a route and a build. */
  readonly requestsPerQuote: number;
  quote(request: QuoteRequest, context: QuoteContext): Promise<ProviderResult>;
}
