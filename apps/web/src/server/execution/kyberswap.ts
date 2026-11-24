import "server-only";
import { type Address, type Hex, isAddress, isHex } from "viem";
import { MissingConfigurationError } from "@/server/market";
import type { ProviderResult, QuoteFailure, QuoteProvider, QuoteRequest } from "./provider";

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
/** Longest wait before the one retry of a rate-limited request. */
const MAX_RETRY_WAIT_SECONDS = 10;
const RETRY_WAIT_MS = 500;
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
  readonly sleep?: (milliseconds: number) => Promise<void>;
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
  | { readonly kind: "transient"; readonly waitMs: number; readonly rateLimited: boolean };

/**
 * The KyberSwap implementation of `QuoteProvider`: `GET /routes`, then `POST /route/build` with the route it
 * returned. Each request has a timeout and at most one retry, made only after a transport failure, a timeout,
 * a 429 or a 5xx. A 4xx is not retried and an answer of an unexpected shape is never retried or defaulted.
 */
export function createKyberSwapProvider(options: KyberSwapOptions): QuoteProvider {
  const send = options.fetch ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  async function attempt(url: string, init: RequestInit): Promise<Attempt> {
    let response: Response;
    try {
      response = await send(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch {
      return { kind: "transient", waitMs: RETRY_WAIT_MS, rateLimited: false };
    }
    if (response.status === 429) {
      const after = Number(response.headers.get("x-ratelimit-reset-after") ?? "1");
      const seconds = Number.isFinite(after) ? Math.min(Math.max(after, 0), MAX_RETRY_WAIT_SECONDS) : 1;
      return { kind: "transient", waitMs: seconds * 1000, rateLimited: true };
    }
    if (response.status >= 500) return { kind: "transient", waitMs: RETRY_WAIT_MS, rateLimited: false };
    try {
      return { kind: "json", status: response.status, body: await response.json() };
    } catch {
      return { kind: "json", status: response.status, body: null };
    }
  }

  /** The `data` object of a successful answer, or the failure it stands for. */
  async function request(url: string, init: RequestInit): Promise<{ status: "ok"; data: Json } | QuoteFailure> {
    let result = await attempt(url, init);
    if (result.kind === "transient") {
      await sleep(result.waitMs);
      result = await attempt(url, init);
    }
    if (result.kind === "transient") {
      const reason = result.rateLimited ? "provider_rate_limited" : "provider_unavailable";
      return { status: "failed", reason, detail: null };
    }
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
    async quote(input: QuoteRequest): Promise<ProviderResult> {
      const query = new URLSearchParams({
        tokenIn: input.tokenIn,
        tokenOut: input.tokenOut,
        amountIn: input.amountIn.toString(),
      });
      const route = await request(`${KYBERSWAP_API}/routes?${query}`, { headers });
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
        const build = await request(`${KYBERSWAP_API}/route/build`, {
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
        });
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
