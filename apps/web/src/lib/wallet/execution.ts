/**
 * Why execution is not available to this visitor.
 * - `restricted_jurisdiction`, `jurisdiction_unknown`: stated by `GET /api/v1/status`.
 * - `checking`: the status has not been read yet.
 * - `status_unavailable`: the status could not be read or understood. Unavailable, because the gate fails closed.
 */
export type ExecutionUnavailableReason =
  | "restricted_jurisdiction"
  | "jurisdiction_unknown"
  | "checking"
  | "status_unavailable";

export type ExecutionAvailability =
  | { readonly executionAvailable: true; readonly reason: null }
  | { readonly executionAvailable: false; readonly reason: ExecutionUnavailableReason };

export const EXECUTION_CHECKING: ExecutionAvailability = { executionAvailable: false, reason: "checking" };
export const EXECUTION_STATUS_UNAVAILABLE: ExecutionAvailability = {
  executionAvailable: false,
  reason: "status_unavailable",
};

const STATED_REASONS = ["restricted_jurisdiction", "jurisdiction_unknown"] as const;

/** Reads the execution fields of a `GET /api/v1/status` body. Anything unexpected is `status_unavailable`. */
export function parseExecutionAvailability(body: unknown): ExecutionAvailability {
  if (typeof body !== "object" || body === null || !("data" in body)) return EXECUTION_STATUS_UNAVAILABLE;
  const { data } = body;
  if (typeof data !== "object" || data === null || !("executionAvailable" in data)) {
    return EXECUTION_STATUS_UNAVAILABLE;
  }
  if (data.executionAvailable === true) return { executionAvailable: true, reason: null };
  const stated = "executionUnavailableReason" in data ? data.executionUnavailableReason : undefined;
  const reason = STATED_REASONS.find((known) => known === stated);
  return data.executionAvailable === false && reason !== undefined
    ? { executionAvailable: false, reason }
    : EXECUTION_STATUS_UNAVAILABLE;
}

/** One sentence per reason, for the note next to a wallet and for the stated reason of a disabled action. */
export const EXECUTION_UNAVAILABLE_MESSAGES: Record<ExecutionUnavailableReason, string> = {
  restricted_jurisdiction: "Execution is not available in your region. Connecting and reading work everywhere.",
  jurisdiction_unknown:
    "Your region could not be determined, so execution is not available. Connecting and reading still work.",
  checking: "Checking whether execution is available.",
  status_unavailable: "Execution availability could not be checked, so it is treated as unavailable.",
};
