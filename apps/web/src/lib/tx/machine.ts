import type { Hex } from "viem";
import type { TxFailure } from "./errors";

/**
 * Life of one transaction, from the click that requests it to the moment its effect is established.
 *
 * - `idle`: nothing was requested.
 * - `awaiting_signature`: the wallet is asking the user. Nothing has been sent.
 * - `rejected`: the user declined in the wallet. Nothing was sent. This is a choice, not an error.
 * - `failed`: the wallet or the node refused the transaction before it was broadcast. Nothing was sent.
 * - `submitted`: broadcast, not mined yet. `repriced` is true when the wallet resent it with another fee.
 * - `verifying`: mined with a successful receipt. Its effect is being checked against the chain.
 * - `confirmed`: mined, and every check on its effect passed. The only state that means success.
 * - `unverified`: mined with a successful receipt, but a check on its effect failed or could not be made.
 * - `reverted`: mined and reverted. The fee was paid and nothing changed.
 * - `replaced`: another transaction with the same nonce was mined instead.
 * - `dropped`: no receipt was found in time. The transaction may still be mined later.
 */
export type TxState<Result> =
  | { readonly status: "idle" }
  | { readonly status: "awaiting_signature" }
  | { readonly status: "rejected" }
  | { readonly status: "failed"; readonly failure: TxFailure }
  | { readonly status: "submitted"; readonly hash: Hex; readonly repriced: boolean }
  | { readonly status: "verifying"; readonly hash: Hex }
  | { readonly status: "confirmed"; readonly hash: Hex; readonly result: Result }
  | { readonly status: "unverified"; readonly hash: Hex; readonly reason: string }
  | { readonly status: "reverted"; readonly hash: Hex }
  | {
      readonly status: "replaced";
      readonly hash: Hex;
      readonly replacement: Hex;
      readonly reason: "cancelled" | "replaced";
    }
  | { readonly status: "dropped"; readonly hash: Hex };

export type TxEvent<Result> =
  | { readonly type: "request" }
  | { readonly type: "rejected" }
  | { readonly type: "send_failed"; readonly failure: TxFailure }
  | { readonly type: "submitted"; readonly hash: Hex }
  | { readonly type: "repriced"; readonly hash: Hex }
  | { readonly type: "replaced"; readonly replacement: Hex; readonly reason: "cancelled" | "replaced" }
  | { readonly type: "dropped" }
  | { readonly type: "receipt"; readonly status: "success" | "reverted"; readonly hash: Hex }
  | { readonly type: "verified"; readonly result: Result }
  | { readonly type: "verification_failed"; readonly reason: string }
  | { readonly type: "recheck" }
  | { readonly type: "reset" };

export const TX_IDLE = { status: "idle" } as const;

/** States in which a transaction is with the wallet or the chain: a second one must not be requested. */
export function isTxInFlight(state: TxState<unknown>): boolean {
  return state.status === "awaiting_signature" || state.status === "submitted" || state.status === "verifying";
}

/**
 * States a new request may start from. A transaction that was mined successfully is not one of them: sending
 * it again would be a second transaction, so the caller has to reset first, on purpose.
 */
function canRequest(state: TxState<unknown>): boolean {
  return ["idle", "rejected", "failed", "reverted", "replaced", "dropped"].includes(state.status);
}

/**
 * The transition function. An event that does not apply to the current state leaves it unchanged, so a late
 * callback (a receipt after a reset, a second click) can never move the machine to a state it did not reach.
 */
export function txReducer<Result>(state: TxState<Result>, event: TxEvent<Result>): TxState<Result> {
  switch (event.type) {
    case "request":
      return canRequest(state) ? { status: "awaiting_signature" } : state;
    case "rejected":
      return state.status === "awaiting_signature" ? { status: "rejected" } : state;
    case "send_failed":
      return state.status === "awaiting_signature" ? { status: "failed", failure: event.failure } : state;
    case "submitted":
      return state.status === "awaiting_signature" ? { status: "submitted", hash: event.hash, repriced: false } : state;
    case "repriced":
      return state.status === "submitted" ? { status: "submitted", hash: event.hash, repriced: true } : state;
    case "replaced":
      return state.status === "submitted"
        ? { status: "replaced", hash: state.hash, replacement: event.replacement, reason: event.reason }
        : state;
    case "dropped":
      return state.status === "submitted" ? { status: "dropped", hash: state.hash } : state;
    case "receipt":
      if (state.status !== "submitted") return state;
      // Only a receipt that says "success" moves on. Anything else is a revert: the hash alone proves nothing.
      return event.status === "success"
        ? { status: "verifying", hash: event.hash }
        : { status: "reverted", hash: event.hash };
    case "verified":
      return state.status === "verifying" ? { status: "confirmed", hash: state.hash, result: event.result } : state;
    case "verification_failed":
      return state.status === "verifying" ? { status: "unverified", hash: state.hash, reason: event.reason } : state;
    case "recheck":
      return state.status === "unverified" ? { status: "verifying", hash: state.hash } : state;
    case "reset":
      return isTxInFlight(state) ? state : TX_IDLE;
  }
}
