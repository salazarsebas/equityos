import "server-only";
import { marketPhaseAt } from "@equityos/core";
import { classifyJurisdiction, type Jurisdiction } from "@/server/jurisdiction";
import { BASE_CHAIN_ID, type MarketData, type MarketDataMode } from "@/server/market";
import { toApiDatasets } from "./assets";
import { toApiError } from "./errors";
import { API_VERSION, isoTimestamp, NO_STORE, ok, route } from "./http";
import { parseQuery } from "./params";

/**
 * Why execution is not available to the caller.
 * - `restricted_jurisdiction` and `jurisdiction_unknown`: the jurisdiction gate withholds it from this request.
 * - `not_released`: the gate would let the request through, and this release has no execution endpoint.
 */
type ExecutionUnavailableReason = "restricted_jurisdiction" | "jurisdiction_unknown" | "not_released";

/**
 * Execution availability for a request. No execution endpoint exists in this release, so the answer is `false`
 * for everyone. The reason already reflects the jurisdiction gate, which takes precedence.
 */
function executionAvailability(jurisdiction: Jurisdiction): {
  executionAvailable: boolean;
  executionUnavailableReason: ExecutionUnavailableReason | null;
} {
  if (!jurisdiction.restricted) return { executionAvailable: false, executionUnavailableReason: "not_released" };
  const reason = jurisdiction.reason === "restricted_country" ? "restricted_jurisdiction" : "jurisdiction_unknown";
  return { executionAvailable: false, executionUnavailableReason: reason };
}

export interface StatusOptions {
  readonly marketData: () => MarketData;
  readonly mode: () => MarketDataMode;
  /** Clock in Unix seconds, used when the market data cannot be loaded. */
  readonly now?: () => number;
}

/**
 * `GET /api/v1/status`: what the API is, what it reads and how current each dataset is. It answers 200 when a
 * source is down and reports the failure in the body, so that it stays usable as a diagnostic. It names sources
 * by identifier and never exposes an endpoint URL or any other configuration.
 */
export function statusHandler({ marketData, mode, now = () => Math.floor(Date.now() / 1000) }: StatusOptions) {
  return route(async (request: Request) => {
    parseQuery(request, []);
    const market = await marketData()
      .getSnapshot()
      .then(
        (snapshot) => ({ at: snapshot.observedAt, datasets: toApiDatasets(snapshot), error: null }),
        (error: unknown) => {
          const { code, details } = toApiError(error);
          return { at: now(), datasets: null, error: { code, details } };
        },
      );
    const data = {
      apiVersion: API_VERSION,
      chainId: BASE_CHAIN_ID,
      marketPhase: marketPhaseAt(market.at),
      ...executionAvailability(classifyJurisdiction(request.headers)),
      marketData: {
        mode: mode(),
        available: market.datasets !== null,
        referencePriceSource: "chainlink",
        datasets: market.datasets,
        error: market.error,
      },
    };
    // Never stored: the answer depends on where the request comes from and reports the state of this moment.
    return ok(data, { asOf: isoTimestamp(market.at) }, NO_STORE);
  });
}
