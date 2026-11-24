import "server-only";
import { type Address, type Hex, isAddress, isHex } from "viem";
import { MissingConfigurationError } from "@/server/market";
import type { ProviderResult, QuoteContext, QuoteFailure, QuoteProvider, QuoteRequest } from "./provider";

/**
 * KyberSwap aggregator API. Keyless: requests carry only the `x-client-id` header, which the provider asks
 * for to identify the integrator. Its documentation names an API gateway with keys as the recommended
 * endpoint and states that this one stays available with stricter rate limits; it answered 10 requests per
 * 10 seconds per client when this module was written.
 */
export const KYBERSWAP_API = "https://aggregator-api.kyberswap.com/base/api/v1";
/** Client id sent when `KYBERSWAP_CLIENT_ID` is unset. */
export const DEFAULT_CLIENT_ID = "equityos";
const CLIENT_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const TIMEOUT_MS = 8_000;
/** Error code of the API for a pair and amount without a route. */
const ROUTE_NOT_FOUND = 4008;

/**
 * The client id from `KYBERSWAP_CLIENT_ID`, or `DEFAULT_CLIENT_ID` when it is unset.
 *
 * @throws {MissingConfigurationError} if the value is not 1 to 64 letters, digits, dots, hyphens or underscores.
 */
export function resolveClientId(env: Readonly<Record<string, string | undefined>> = process.env): string {
  const value = env.KYBERSWAP_CLIENT_ID?.trim() ?? "";
  if (value === "") return DEFAULT_CLIENT_ID;
  if (!CLIENT_ID_PATTERN.test(value)) throw new MissingConfigurationError("KYBERSWAP_CLIENT_ID", "is not a valid id");
  return value;
}

export interface KyberSwapOptions {
  readonly clientId: string;
  readonly fetch?: typeof fetch;
}

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A non-negative integer written in decimal digits, as the API writes amounts. */
function uint(value: unknown): bigint | null {
  return typeof value === "string" && /^(0|[1-9][0-9]{0,77})$/.test(value) ? BigInt(value) : null;
}

class Malformed extends Error {}

function field<T>(record: Json, name: string, parse: (value: unknown) => T | null): T {
  const parsed = parse(record[name]);
  if (parsed === null) throw new Malformed(name);
  return parsed;
}

const address = (value: unknown): Address | null =>
  typeof value === "string" && isAddress(value, { strict: false }) ? (value.toLowerCase() as Address) : null;
const hex = (value: unknown): Hex | null => (typeof value === "string" && isHex(value) ? value : null);
const text = (value: unknown): string | null => (typeof value === "string" && value.length <= 256 ? value : null);

type Attempt =
  | { readonly kind: "json"; readonly status: number; readonly body: unknown }
  | { readonly kind: "rate_limited"; readonly retryAfterSeconds: number }
  | { readonly kind: "transient" };

/** Seconds a 429 asks to wait: `x-ratelimit-reset-after`, or `Retry-After`, or 10, whole and at least 1. */
function rateLimitWait(response: Response): number {
  for (const name of ["x-ratelimit-reset-after", "retry-after"]) {
    const value = Number(response.headers.get(name) ?? "");
    if (Number.isFinite(value) && value > 0) return Math.min(Math.ceil(value), 60);
  }
  return 10;
}

/**
 * The KyberSwap implementation of `QuoteProvider`: `GET /routes`, then `POST /route/build` with the route it
 * returned. Each request has its own timeout and stops with the deadline of the request being served. A
 * transport failure, a timeout or a 5xx is retried once and at once, when the budget allows it. A 429 is never
 * retried and nothing sleeps: it is returned as `provider_rate_limited` with the wait the provider asks for.
 * Another 4xx is not retried, and an answer of an unexpected shape is never retried or defaulted.
 */
export function createKyberSwapProvider(options: KyberSwapOptions): QuoteProvider {
  const send = options.fetch ?? fetch;

  async function attempt(url: string, init: RequestInit, context: QuoteContext): Promise<Attempt> {
    let response: Response;
    try {
      const signal = AbortSignal.any([AbortSignal.timeout(TIMEOUT_MS), context.signal]);
      response = await send(url, { ...init, signal });
    } catch {
      return { kind: "transient" };
    }
    if (response.status === 429) return { kind: "rate_limited", retryAfterSeconds: rateLimitWait(response) };
    if (response.status >= 500) return { kind: "transient" };
    try {
      return { kind: "json", status: response.status, body: await response.json() };
    } catch {
      return { kind: "json", status: response.status, body: null };
    }
  }

  /** The `data` object of a successful answer, or the failure it stands for. */
  async function request(
    url: string,
    init: RequestInit,
    context: QuoteContext,
  ): Promise<{ status: "ok"; data: Json } | QuoteFailure> {
    let result = await attempt(url, init, context);
    if (result.kind === "transient" && !context.signal.aborted && context.takeRetry()) {
      result = await attempt(url, init, context);
    }
    if (result.kind === "rate_limited") {
      return { status: "failed", reason: "provider_rate_limited", detail: String(result.retryAfterSeconds) };
    }
    if (result.kind === "transient") return { status: "failed", reason: "provider_unavailable", detail: null };
    const { status, body } = result;
    const code = isRecord(body) && typeof body.code === "number" ? body.code : null;
    if (status !== 200) {
      if (code === ROUTE_NOT_FOUND) return { status: "failed", reason: "no_route", detail: String(code) };
      return { status: "failed", reason: "provider_rejected", detail: code === null ? `http_${status}` : String(code) };
    }
    if (code !== 0 || !isRecord(body) || !isRecord(body.data)) {
      return { status: "failed", reason: "provider_malformed", detail: "envelope" };
    }
    return { status: "ok", data: body.data };
  }

  const headers = { Accept: "application/json", "x-client-id": options.clientId };

  return {
    name: "kyberswap",
    requestsPerQuote: 2,
    async quote(input: QuoteRequest, context: QuoteContext): Promise<ProviderResult> {
      const query = new URLSearchParams({
        tokenIn: input.tokenIn,
        tokenOut: input.tokenOut,
        amountIn: input.amountIn.toString(),
      });
      const route = await request(`${KYBERSWAP_API}/routes?${query}`, { headers }, context);
      if (route.status !== "ok") return route;
      try {
        // The summary is sent back to the build endpoint unchanged, as the API requires. Only the fields read
        // here are checked; the rest is opaque to this module.
        const summary = field(route.data, "routeSummary", (value) => (isRecord(value) ? value : null));
        if (
          field(summary, "tokenIn", address) !== input.tokenIn.toLowerCase() ||
          field(summary, "tokenOut", address) !== input.tokenOut.toLowerCase() ||
          field(summary, "amountIn", uint) !== input.amountIn
        ) {
          return { status: "failed", reason: "provider_malformed", detail: "routeSummary" };
        }
        const build = await request(
          `${KYBERSWAP_API}/route/build`,
          {
            method: "POST",
            headers: { ...headers, "Content-Type": "application/json" },
            body: JSON.stringify({
              routeSummary: summary,
              sender: input.account,
              recipient: input.account,
              slippageTolerance: input.slippageBps,
              deadline: input.deadline,
              source: options.clientId,
            }),
          },
          context,
        );
        if (build.status !== "ok") return build;
        return {
          status: "ok",
          quote: {
            provider: "kyberswap",
            amountIn: field(build.data, "amountIn", uint),
            quotedAmountOut: field(build.data, "amountOut", uint),
            router: field(build.data, "routerAddress", address),
            calldata: field(build.data, "data", hex),
            value: field(build.data, "transactionValue", uint),
            gasEstimate: field(build.data, "gas", uint),
            routeId: field(summary, "routeID", text),
          },
        };
      } catch (error) {
        if (error instanceof Malformed)
          return { status: "failed", reason: "provider_malformed", detail: error.message };
        throw error;
      }
    },
  };
}
