import "server-only";
import type { Address } from "viem";

/**
 * Error taxonomy of the market data layer. Every failure a caller can act on has a stable `code`.
 * A condition of a single token (ineligible, paused, no feed, stale feed) is first reported as data on that
 * token; it becomes one of these errors only when a caller demands a value that does not exist.
 */
export type MarketDataErrorCode =
  | "upstream_failure"
  | "malformed_response"
  | "missing_configuration"
  | "ineligible_token"
  | "token_paused"
  | "missing_feed"
  | "stale_feed";

/** The external systems this layer reads. */
export type UpstreamSource = "coinbase_api" | "base_rpc";

export class MarketDataError extends Error {
  readonly code: MarketDataErrorCode;

  constructor(code: MarketDataErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
  }
}

/** The upstream did not answer, answered with an error status, or timed out. Retrying later may succeed. */
export class UpstreamError extends MarketDataError {
  readonly source: UpstreamSource;
  /** HTTP status, when the upstream answered with one. */
  readonly status: number | null;

  constructor(source: UpstreamSource, message: string, options?: ErrorOptions & { status?: number }) {
    super("upstream_failure", `${source}: ${message}`, options);
    this.source = source;
    this.status = options?.status ?? null;
  }
}

/** The upstream answered with a payload that does not have the expected shape. Never retried, never defaulted. */
export class MalformedResponseError extends MarketDataError {
  readonly source: UpstreamSource;
  /** Location of the offending value inside the payload. */
  readonly path: string;

  constructor(source: UpstreamSource, path: string, problem: string) {
    super("malformed_response", `${source}: ${path} ${problem}`);
    this.source = source;
    this.path = path;
  }
}

/** A required environment variable is absent or unusable. */
export class MissingConfigurationError extends MarketDataError {
  readonly variable: string;

  constructor(variable: string, problem: string) {
    super("missing_configuration", `${variable} ${problem}`);
    this.variable = variable;
  }
}

/** A value was demanded for a token that is not index-eligible. */
export class IneligibleTokenError extends MarketDataError {
  readonly token: Address;
  readonly reasons: readonly string[];

  constructor(token: Address, reasons: readonly string[]) {
    super("ineligible_token", `token ${token} is not index-eligible: ${reasons.join(", ")}`);
    this.token = token;
    this.reasons = reasons;
  }
}

/** Transfers of the token are paused by its issuer. */
export class TokenPausedError extends MarketDataError {
  readonly token: Address;

  constructor(token: Address) {
    super("token_paused", `transfers of token ${token} are paused`);
    this.token = token;
  }
}

/** The token has no usable reference feed: none is mapped, or the mapped feed could not be read or validated. */
export class MissingFeedError extends MarketDataError {
  readonly token: Address;

  constructor(token: Address, problem: string) {
    super("missing_feed", `no reference feed for token ${token}: ${problem}`);
    this.token = token;
  }
}

/** The reference feed of the token has not published within its heartbeat of trading time. */
export class StaleFeedError extends MarketDataError {
  readonly token: Address;
  /** Publication time of the last round, Unix seconds. */
  readonly updatedAt: number;

  constructor(token: Address, updatedAt: number) {
    super("stale_feed", `reference feed for token ${token} is stale, last updated at ${updatedAt}`);
    this.token = token;
    this.updatedAt = updatedAt;
  }
}
