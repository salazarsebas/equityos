import type { AttestationOmission } from "./attestation";
import type { AttestationRefusal, ExecutionRefusal, SequentialStop } from "./request";
import type { VerificationFailure, VerificationFailureCode } from "./verify";

/** One sentence per refusal of the send decision. Each says what is true now and that nothing was sent. */
export function refusalMessage(refusal: ExecutionRefusal): string {
  switch (refusal.reason) {
    case "no_plan":
      return "There is no plan to sign. Prepare one first.";
    case "execution_unavailable":
      return "Execution is not available here, so nothing can be signed.";
    case "busy":
      return "A request is already with the wallet or the network. Wait for it to finish.";
    case "verification_failed":
      return "This browser could not verify the calls of the plan, so it will not send them. Nothing was sent.";
    case "hash_mismatch":
      return "The plan hash computed in this browser differs from the one the server sent, so nothing will be sent.";
    case "wrong_account":
      return "The connected account is not the one this plan was built for. Nothing was sent.";
    case "wrong_network":
      return "The wallet is on another network than this plan. Switch the wallet to it. Nothing was sent.";
    case "chain_time_unknown":
      return "The time of the latest block could not be read, so the plan's expiry cannot be checked. Nothing was sent.";
    case "expired":
      return "The plan expired by the time of the latest block. Get a new plan. Nothing was sent.";
    case "warnings_not_acknowledged":
      return `Acknowledge every warning above before signing (${refusal.missing.length} left).`;
  }
}

/** Why a sequential run stopped before a transaction, in words. */
export function stopMessage(stop: SequentialStop): string {
  return stop.reason === "left_page"
    ? "You left the page, so this transaction and the ones after it were not sent."
    : refusalMessage(stop);
}

const FAILURES: Record<VerificationFailureCode, string> = {
  not_ready: "The plan is not ready to execute.",
  check_not_passed: "A pre-trade check did not pass.",
  unsupported_chain: "This site does not send plans on the plan's network.",
  account_mismatch: "The plan was built for another address than the connected account.",
  router_mismatch: "The plan names a router other than the one this site allows.",
  leg_invalid: "A leg does not swap a constituent of the index against USDC as planned.",
  call_order: "The calls are not the approvals followed by one swap per leg, sells first.",
  approval_not_exact: "An approval is not for exactly the amount swapped, toward the allowed router.",
  swap_not_verified: "A swap's calldata does not verify against its leg and your address.",
  swap_mismatch: "A swap's decoded minimum or deadline differs from what the plan states.",
  deadline_out_of_range: "A swap's deadline does not match the plan's expiry.",
  totals_mismatch: "The plan's totals differ from the totals recomputed from its calls.",
  index_mismatch: "The plan names another index or version than the comparison on this page.",
  decimals_mismatch: "A token's decimals read on the chain differ from the plan's, or could not be read.",
  reference_unusable:
    "This browser could not read a current reference price for a leg from its feed, so it cannot bound the price.",
  price_out_of_bounds:
    "A swap's minimum out is further from the reference price read in this browser than this site allows.",
};

/** A failure of the client verification in words, with its code and detail for developers. */
export function verificationFailureText(failure: VerificationFailure): string {
  const where = [
    failure.call === null ? null : `call ${failure.call + 1}`,
    failure.leg === null ? null : `leg ${failure.leg + 1}`,
  ].filter((part) => part !== null);
  return where.length === 0 ? FAILURES[failure.code] : `${FAILURES[failure.code]} (${where.join(", ")})`;
}

/** Why the plan carries no attestation call, in words. */
export const ATTESTATION_OMISSIONS: Record<AttestationOmission, string> = {
  not_deployed: "The rebalance log is not deployed on this network, so no attestation is recorded.",
  registry_elsewhere:
    "The index was read from a registry on another network, so an attestation here could not name it. None is recorded.",
  no_code: "There is no contract at the rebalance log address on this network, so no attestation is recorded.",
  unreadable: "The rebalance log could not be checked on this network, so no attestation is recorded.",
};

export function attestationRefusalMessage(refusal: AttestationRefusal): string {
  switch (refusal.reason) {
    case "not_included":
      return "This plan has no attestation call.";
    case "swaps_not_confirmed":
      return "The attestation is offered only after every swap confirmed.";
    case "busy":
      return "A request is already with the wallet or the network.";
    case "wrong_account":
      return "The connected account is not the one that executed the plan.";
    case "wrong_network":
      return "The wallet is on another network than the plan.";
  }
}

/** The three statements every review carries. */
export const EXECUTION_STATEMENTS = [
  "Executable prices come from the aggregator's quotes and differ from the reference prices of the comparison. Each swap returns at least its minimum or reverts.",
  "Nothing here is advice. The plan is arithmetic toward the published target weights of the index.",
  "You sign every call in your own wallet. This site holds no key and cannot sign or send anything for you.",
] as const;
