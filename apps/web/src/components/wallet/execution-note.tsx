"use client";

import { EXECUTION_UNAVAILABLE_MESSAGES } from "@/lib/wallet/execution";
import { useExecutionAvailability } from "./hooks";

/**
 * One line saying that execution is not available to this visitor, and why. Nothing while the answer is being
 * read or when execution is available.
 *
 * @param enabled whether the region showing the note is open, so that a closed one makes no request
 */
export function ExecutionNote({ enabled }: { enabled: boolean }) {
  const { executionAvailable, reason } = useExecutionAvailability(enabled);
  if (!enabled || executionAvailable || reason === "checking") return null;
  return <p className="text-xs text-secondary">{EXECUTION_UNAVAILABLE_MESSAGES[reason]}</p>;
}
