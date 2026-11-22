import "server-only";
import { type ApiError, toApiError, UPSTREAM_RETRY_AFTER_SECONDS } from "./errors";

/**
 * Version of the API contract, as in the OpenAPI document. The major version is the one in the path. Additive
 * changes raise the minor version and never break a client that ignores fields it does not know.
 */
export const API_VERSION = "1.1.0";
export const API_VERSION_HEADER = "X-EquityOS-Api-Version";

/** A response that must not be stored: errors, and data that depends on who asks or is already past its TTL. */
export const NO_STORE = "no-store";

/** A response any cache may reuse for `seconds`, the time its data stays current at the source of truth. */
export function publicCache(seconds: number): string {
  return seconds > 0 ? `public, max-age=${seconds}` : NO_STORE;
}

/**
 * Serializes a response body. A `bigint` becomes a decimal string, so no amount, price or identifier is ever
 * written as a JSON number. A number that is not a safe integer is a bug in a handler and throws: counts,
 * decimals and durations are the only numbers the API emits.
 *
 * @throws {TypeError} if the value holds a fractional, non-finite or unsafe number.
 */
export function serialize(body: unknown): string {
  return JSON.stringify(body, (key, value: unknown) => {
    if (typeof value === "bigint") return value.toString();
    if (typeof value === "number" && !Number.isSafeInteger(value)) {
      throw new TypeError(`"${key}" is a number that is not a safe integer: ${value}`);
    }
    return value;
  });
}

/** ISO 8601 UTC timestamp with second precision, the only time format of the API: `2026-11-21T19:10:55Z`. */
export function isoTimestamp(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString().replace(".000Z", "Z");
}

/** A JSON response with the headers every API response carries: open CORS, the API version, no sniffing. */
export function json(status: number, body: unknown, headers: Record<string, string>): Response {
  return new Response(serialize(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Expose-Headers": `${API_VERSION_HEADER}, Retry-After`,
      "X-Content-Type-Options": "nosniff",
      [API_VERSION_HEADER]: API_VERSION,
      ...headers,
    },
  });
}

/** Success envelope: `{ data, meta }`. */
export function ok(data: unknown, meta: unknown, cacheControl: string): Response {
  return json(200, { data, meta }, { "Cache-Control": cacheControl });
}

/** Error envelope: `{ error: { code, message, details } }`. Never cached. */
export function fail(error: ApiError): Response {
  const { status, code, message, details } = error;
  const retry: Record<string, string> = status === 503 ? { "Retry-After": String(UPSTREAM_RETRY_AFTER_SECONDS) } : {};
  return json(status, { error: { code, message, details } }, { "Cache-Control": NO_STORE, ...retry });
}

/** Answers a CORS preflight. The API is public and read-only, so any origin may send a GET. */
export function preflight(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
      "Access-Control-Allow-Headers": "Accept, Content-Type",
      "Access-Control-Max-Age": "86400",
      [API_VERSION_HEADER]: API_VERSION,
    },
  });
}

/**
 * Wraps a handler so that everything it throws leaves as an error envelope. A 500 is logged with its cause,
 * which the response never carries.
 */
export function route<Context>(
  handler: (request: Request, context: Context) => Response | Promise<Response>,
): (request: Request, context: Context) => Promise<Response> {
  return async (request, context) => {
    try {
      return await handler(request, context);
    } catch (error) {
      const apiError = toApiError(error);
      if (apiError.status === 500) console.error(`api ${new URL(request.url).pathname}: ${apiError.code}`, error);
      return fail(apiError);
    }
  };
}
