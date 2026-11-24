import { describe, expect, test } from "bun:test";
import {
  ATTESTATION_OMISSIONS,
  attestationRefusalMessage,
  EXECUTION_STATEMENTS,
  refusalMessage,
  verificationFailureText,
} from "../../src/lib/execution/messages";
import type { AttestationRefusal, ExecutionRefusal } from "../../src/lib/execution/request";
import type { VerificationFailureCode } from "../../src/lib/execution/verify";

const REFUSALS: ExecutionRefusal[] = [
  { reason: "no_plan" },
  { reason: "execution_unavailable" },
  { reason: "busy" },
  { reason: "verification_failed", failures: [] },
  { reason: "hash_mismatch" },
  { reason: "wrong_account" },
  { reason: "wrong_network", walletChainId: 1, chainId: 8453 },
  { reason: "chain_time_unknown" },
  { reason: "expired", expiresAt: 1, chainTime: 2 },
  { reason: "warnings_not_acknowledged", missing: ["a", "b"] },
];
const ATTESTATION_REFUSALS: AttestationRefusal[] = [
  { reason: "not_included" },
  { reason: "swaps_not_confirmed" },
  { reason: "busy" },
  { reason: "wrong_account" },
  { reason: "wrong_network", walletChainId: 1, chainId: 8453 },
];
const CODES: VerificationFailureCode[] = [
  "not_ready",
  "check_not_passed",
  "unsupported_chain",
  "account_mismatch",
  "router_mismatch",
  "leg_invalid",
  "call_order",
  "approval_not_exact",
  "swap_not_verified",
  "swap_mismatch",
  "deadline_out_of_range",
  "totals_mismatch",
];

/** Words that would turn a state into a recommendation or an urge to trade. */
const FORBIDDEN = /\b(should|recommend|now!|don't miss|opportunity|profit|best|guarantee[ds]? returns?)\b/i;

const sentences = [
  ...REFUSALS.map(refusalMessage),
  ...ATTESTATION_REFUSALS.map(attestationRefusalMessage),
  ...CODES.map((code) => verificationFailureText({ code, call: null, leg: null, detail: null })),
  ...Object.values(ATTESTATION_OMISSIONS),
  ...EXECUTION_STATEMENTS,
];

describe("execution messages", () => {
  test("every state has a full sentence without advice or trading encouragement", () => {
    for (const sentence of sentences) {
      expect(sentence.endsWith(".")).toBe(true);
      expect(FORBIDDEN.test(sentence)).toBe(false);
    }
  });

  test("a refusal at the click says that nothing was sent where something could have been", () => {
    for (const reason of ["verification_failed", "wrong_account", "wrong_network", "expired"] as const) {
      const refusal = REFUSALS.find((candidate) => candidate.reason === reason);
      if (refusal === undefined) throw new Error(reason);
      expect(refusalMessage(refusal)).toContain("Nothing was sent.");
    }
  });

  test("a failure names the call and the leg it concerns", () => {
    expect(verificationFailureText({ code: "swap_mismatch", call: 2, leg: 0, detail: null })).toEndWith(
      "(call 3, leg 1)",
    );
  });
});
