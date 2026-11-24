/**
 * The JSON of `GET /api/v1/portfolio` and `GET /api/v1/portfolio/plan` as the browser receives it. Amounts are
 * decimal strings and are turned into `bigint` where they are formatted. The shapes are the OpenAPI schemas
 * `Portfolio`, `PortfolioPlan` and `CalculationIssue`.
 */
import type { CalculationIssueCode } from "@equityos/core";

export interface ApiPrice {
  readonly status: "live" | "delayed" | "last_close" | "unavailable";
  readonly priceE8: string | null;
  readonly updatedAt: string | null;
  readonly unavailableReason: string | null;
}

export interface ApiIssue {
  readonly code: CalculationIssueCode;
  readonly severity: "blocker" | "warning";
  readonly token: string | null;
  readonly minimumDeployableValueUsdE8: string | null;
  readonly uninvestedQuote: string | null;
  readonly currentMaxAbsDriftBps: number | null;
  readonly projectedMaxAbsDriftBps: number | null;
}

export interface ApiIndexRef {
  readonly identifier: string;
  readonly name: string;
  readonly version: number;
  readonly latestVersion: number;
  readonly isLatest: boolean;
  readonly driftThresholdBps: number;
}

export interface ApiPosition {
  readonly token: string;
  readonly symbol: string | null;
  readonly name: string | null;
  readonly decimals: number;
  readonly balance: string;
  readonly targetWeightBps: number;
  readonly currentWeightBps: number | null;
  readonly driftBps: number | null;
  readonly valueUsdE8: string | null;
  readonly referencePrice: ApiPrice;
}

export interface ApiPortfolio {
  readonly address: string;
  readonly index: ApiIndexRef;
  readonly constituents: readonly ApiPosition[];
  readonly totals: {
    readonly investedValueUsdE8: string | null;
    readonly quoteBalance: string;
    readonly deployableValueUsdE8: string | null;
  };
  readonly drift: { readonly maxAbsDriftBps: number; readonly maxDriftToken: string } | null;
  readonly outsideIndex: readonly Omit<ApiPosition, "targetWeightBps" | "currentWeightBps" | "driftBps">[];
  readonly issues: readonly ApiIssue[];
}

export interface ApiMeta {
  readonly marketPhase: string;
  readonly balances: { readonly blockNumber: string; readonly blockTimestamp: string };
  readonly datasets: { readonly onchain: { readonly blockNumber: string; readonly servedStale: boolean } };
}

export interface ApiLeg {
  readonly side: "sell" | "buy";
  readonly token: string;
  readonly symbol: string | null;
  readonly decimals: number | null;
  readonly tokenQuantity: string;
  readonly valueUsdE8: string;
}

export type ApiPlanResult =
  | { readonly status: "blocked"; readonly blockers: readonly ApiIssue[]; readonly warnings: readonly ApiIssue[] }
  | {
      readonly status: "ready";
      readonly warnings: readonly ApiIssue[];
      readonly legs: readonly ApiLeg[];
      readonly currentMaxAbsDriftBps: number | null;
      readonly projected: { readonly quoteBalance: string; readonly maxAbsDriftBps: number | null };
    };

/** A constituent whose issuer paused transfers: no leg in it can be executed while the pause lasts. */
export interface ApiTransferWarning {
  readonly code: "transfers_paused";
  readonly token: string;
  readonly symbol: string | null;
}

export interface ApiPlan {
  readonly statement: string;
  readonly plan: ApiPlanResult;
  readonly transferWarnings: readonly ApiTransferWarning[];
}

export interface ApiError {
  readonly status: number;
  readonly code: string;
  readonly message: string;
  readonly details: Readonly<Record<string, unknown>> | null;
}

/** What the page compares: the state the URL carries. */
export interface ComparisonState {
  readonly address: string;
  readonly index: string;
  readonly version: number | null;
}

export function comparisonQuery({ address, index, version }: ComparisonState): URLSearchParams {
  const query = new URLSearchParams({ address, index });
  if (version !== null) query.set("version", String(version));
  return query;
}

/**
 * Reads an API response: the `data` and `meta` of a success, or throws the `error` of the envelope with its
 * status. Anything else is an error with the status alone.
 */
export async function readEnvelope<T>(response: Response): Promise<{ data: T; meta: ApiMeta }> {
  const body: unknown = await response.json().catch(() => null);
  if (response.ok && typeof body === "object" && body !== null && "data" in body && "meta" in body) {
    return body as { data: T; meta: ApiMeta };
  }
  const error = typeof body === "object" && body !== null && "error" in body ? body.error : null;
  const fields = typeof error === "object" && error !== null ? (error as Partial<ApiError>) : {};
  throw Object.assign(new Error(fields.message ?? `The API answered ${response.status}.`), {
    status: response.status,
    code: fields.code ?? "unknown",
    details: fields.details ?? null,
  });
}

export function isApiError(error: unknown): error is Error & ApiError {
  return error instanceof Error && "status" in error && "code" in error;
}
