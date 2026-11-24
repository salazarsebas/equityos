import type { ApiErrorCode } from "@/server/api/errors";

/**
 * The HTTP status and the meaning of each error code of the API, as `docs/api/README.md` states them. Typed as a
 * record of every code, so a code added to the API does not compile until it is described here.
 */
export const ERROR_CODES: Readonly<Record<ApiErrorCode, { readonly status: number; readonly meaning: string }>> = {
  invalid_parameter: {
    status: 400,
    meaning: "A query parameter or body field is unknown, given twice or has a value that is not allowed.",
  },
  invalid_body: {
    status: 400,
    meaning: "A request body is not a JSON object sent as application/json, or is larger than 4096 bytes.",
  },
  invalid_address: { status: 400, meaning: "A path address is not 0x followed by 40 hex digits." },
  invalid_identifier: {
    status: 400,
    meaning: "An index identifier is neither an index id nor a slug with an index id prefix.",
  },
  asset_not_found: { status: 404, meaning: "The address is well formed and no listed asset has it." },
  index_not_found: { status: 404, meaning: "The registry holds no index with the identifier." },
  version_not_found: { status: 404, meaning: "The index has no version with the number." },
  registry_not_deployed: {
    status: 409,
    meaning: "The index registry has no code on the configured chain. A normal state, not an empty registry.",
  },
  version_not_conformant: {
    status: 409,
    meaning: "A composition or a comparison was asked of a version that fails verification.",
  },
  ineligible_token: { status: 409, meaning: "A value was requested that an ineligible token does not have." },
  token_paused: { status: 409, meaning: "The issuer paused transfers of the token." },
  missing_feed: { status: 409, meaning: "The token has no usable reference feed." },
  stale_feed: { status: 409, meaning: "The reference feed of the token missed its heartbeat." },
  execution_unavailable: {
    status: 409,
    meaning: "An execution plan was asked of a deployment that serves replayed market data.",
  },
  rate_limited: {
    status: 429,
    meaning: "Too many execution plans from one address. Carries Retry-After.",
  },
  service_misconfigured: { status: 500, meaning: "The server is not configured to read its data sources." },
  internal_error: { status: 500, meaning: "Anything unexpected. The cause is written to the server log only." },
  upstream_malformed: { status: 502, meaning: "A data source answered with a payload of an unexpected shape." },
  upstream_unavailable: {
    status: 503,
    meaning: "A data source did not answer and no recent copy is cached. Carries Retry-After.",
  },
  provider_rate_limited: {
    status: 503,
    meaning: "The quote provider's rate limit does not allow quoting an execution plan now. Carries Retry-After.",
  },
  deadline_exceeded: {
    status: 503,
    meaning: "An execution plan could not be built within the 20 second deadline of the request.",
  },
};
