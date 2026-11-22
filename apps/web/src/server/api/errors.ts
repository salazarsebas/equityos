import "server-only";
import { MarketDataError, type MarketDataErrorCode, MalformedResponseError, UpstreamError } from "@/server/market";

/**
 * Error codes of the public API. A code is stable: clients branch on it, never on the message.
 * The last four are conditions of one token, reported with the code the market data layer gives them.
 */
export const API_ERROR_CODES = [
  "invalid_parameter",
  "invalid_address",
  "asset_not_found",
  "upstream_unavailable",
  "upstream_malformed",
  "service_misconfigured",
  "internal_error",
  "ineligible_token",
  "token_paused",
  "missing_feed",
  "stale_feed",
] as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

export type ApiErrorDetails = Readonly<Record<string, string | number | boolean | null | readonly string[]>>;

/** An error with a decided HTTP status and a message that is safe to show to any caller. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode;
  readonly details: ApiErrorDetails | null;

  constructor(status: number, code: ApiErrorCode, message: string, details: ApiErrorDetails | null = null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/** Seconds a client should wait before retrying a failed upstream read: one TTL of the onchain cache. */
export const UPSTREAM_RETRY_AFTER_SECONDS = 15;

/**
 * Status, code and public message of every market data error. The message is written here and never taken
 * from the caught error, whose text can name an endpoint or an environment variable.
 *
 * - 503: a source did not answer. Nothing young enough is cached, and a retry may succeed.
 * - 502: a source answered with a payload this server refuses to interpret.
 * - 500: the server is not configured to read its sources. Not the caller's fault and not retryable by them.
 * - 409: the request is valid, and the current state of the token does not allow answering it.
 */
const MARKET_ERRORS: Record<MarketDataErrorCode, { status: number; code: ApiErrorCode; message: string }> = {
  upstream_failure: {
    status: 503,
    code: "upstream_unavailable",
    message: "A data source did not answer and no recent copy of its data is available. Retry shortly.",
  },
  malformed_response: {
    status: 502,
    code: "upstream_malformed",
    message: "A data source answered with a payload that does not have the expected shape.",
  },
  missing_configuration: {
    status: 500,
    code: "service_misconfigured",
    message: "The server is not configured to read its data sources.",
  },
  ineligible_token: { status: 409, code: "ineligible_token", message: "The token is not index-eligible." },
  token_paused: { status: 409, code: "token_paused", message: "Transfers of the token are paused by its issuer." },
  missing_feed: { status: 409, code: "missing_feed", message: "The token has no usable reference feed." },
  stale_feed: { status: 409, code: "stale_feed", message: "The reference feed of the token is stale." },
};

/** Every failure code of the market data layer, for the schema of the fields that report one. */
export const MARKET_ERROR_CODES = Object.keys(MARKET_ERRORS);

const INTERNAL_ERROR = "The request could not be completed because of an unexpected error.";

/** Maps anything a handler can throw to an `ApiError`. An unrecognized error becomes a 500 with no detail. */
export function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  if (!(error instanceof MarketDataError)) return new ApiError(500, "internal_error", INTERNAL_ERROR);
  const { status, code, message } = MARKET_ERRORS[error.code];
  const source = error instanceof UpstreamError || error instanceof MalformedResponseError ? error.source : null;
  return new ApiError(status, code, message, source === null ? null : { source });
}
