import { describe, expect, test } from "bun:test";
import {
  EXECUTION_STATUS_UNAVAILABLE,
  EXECUTION_UNAVAILABLE_MESSAGES,
  parseExecutionAvailability,
} from "../../src/lib/wallet/execution";

const body = (data: unknown) => ({ data, meta: { asOf: "2026-11-21T19:10:55Z" } });

describe("parseExecutionAvailability", () => {
  test("reads each reason the status endpoint states", () => {
    for (const reason of ["restricted_jurisdiction", "jurisdiction_unknown", "not_released"] as const) {
      expect(
        parseExecutionAvailability(body({ executionAvailable: false, executionUnavailableReason: reason })),
      ).toEqual({ executionAvailable: false, reason });
    }
  });

  test("reads availability", () => {
    expect(parseExecutionAvailability(body({ executionAvailable: true, executionUnavailableReason: null }))).toEqual({
      executionAvailable: true,
      reason: null,
    });
  });

  test("fails closed on anything unexpected", () => {
    const bodies = [
      null,
      "ok",
      {},
      { data: null },
      body({}),
      body({ executionAvailable: "true" }),
      body({ executionAvailable: false }),
      body({ executionAvailable: false, executionUnavailableReason: "maintenance" }),
      { error: { code: "internal_error" } },
    ];
    for (const unexpected of bodies) {
      expect(parseExecutionAvailability(unexpected)).toEqual(EXECUTION_STATUS_UNAVAILABLE);
    }
  });

  test("every reason has a sentence that names execution and uses no advice language", () => {
    for (const message of Object.values(EXECUTION_UNAVAILABLE_MESSAGES)) {
      expect(message.toLowerCase()).toContain("execution");
      expect(message.endsWith(".")).toBe(true);
    }
  });
});
