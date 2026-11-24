import type { Hex } from "viem";
import type { TxFailure } from "./errors";
import type { TxEvent } from "./machine";

/** What a check on the effect of a mined transaction found. */
export type Verification<Result> =
  | { readonly ok: true; readonly result: Result }
  | { readonly ok: false; readonly reason: string };

export interface Replacement {
  /** `repriced`: the same transaction with another fee. Otherwise a different transaction took the nonce. */
  readonly reason: "repriced" | "cancelled" | "replaced";
  readonly hash: Hex;
}

/** Everything a transaction needs from the outside world. The hook wires these to the wallet and the chain. */
export interface TxDriver<Receipt extends { readonly status: "success" | "reverted" }, Result> {
  /** Asks the wallet to sign and broadcast. Resolves with the transaction hash. */
  send(): Promise<Hex>;
  /**
   * Waits for the receipt. Calls `onReplaced` when the nonce was used by another transaction.
   *
   * @returns the receipt, or `null` when none was found in time
   */
  wait(hash: Hex, onReplaced: (replacement: Replacement) => void): Promise<Receipt | null>;
  /** Establishes the effect of a successful receipt by reading the chain. */
  verify(receipt: Receipt): Promise<Verification<Result>>;
  /** Classifies an error thrown by `send`. */
  classify(error: unknown): TxFailure;
}

const UNREADABLE = "The chain could not be read to check the result. The transaction itself was mined.";

/** Runs `verify` and reports its outcome. A check that throws is a failed check, never a pass. */
export async function runVerification<Receipt extends { readonly status: "success" | "reverted" }, Result>(
  driver: Pick<TxDriver<Receipt, Result>, "verify">,
  receipt: Receipt,
  dispatch: (event: TxEvent<Result>) => void,
): Promise<void> {
  const outcome = await driver.verify(receipt).catch((): Verification<Result> => ({ ok: false, reason: UNREADABLE }));
  dispatch(
    outcome.ok ? { type: "verified", result: outcome.result } : { type: "verification_failed", reason: outcome.reason },
  );
}

/**
 * Sends one transaction and follows it to its end, reporting every step as an event of the state machine.
 * It is called from a click handler and from nowhere else.
 *
 * @returns the successful receipt, kept by the caller for a later recheck, or `null`
 */
export async function runTransaction<Receipt extends { readonly status: "success" | "reverted" }, Result>(
  driver: TxDriver<Receipt, Result>,
  dispatch: (event: TxEvent<Result>) => void,
): Promise<Receipt | null> {
  dispatch({ type: "request" });
  let hash: Hex;
  try {
    hash = await driver.send();
  } catch (error) {
    const failure = driver.classify(error);
    dispatch(failure.kind === "user_rejected" ? { type: "rejected" } : { type: "send_failed", failure });
    return null;
  }
  dispatch({ type: "submitted", hash });

  let taken = false;
  const receipt = await driver
    .wait(hash, (replacement) => {
      if (replacement.reason === "repriced") {
        hash = replacement.hash;
        dispatch({ type: "repriced", hash });
      } else {
        taken = true;
        dispatch({ type: "replaced", replacement: replacement.hash, reason: replacement.reason });
      }
    })
    .catch(() => null);
  // The receipt of a transaction that took the nonce says nothing about the one that was requested.
  if (taken) return null;
  if (receipt === null) {
    dispatch({ type: "dropped" });
    return null;
  }
  dispatch({ type: "receipt", status: receipt.status === "success" ? "success" : "reverted", hash });
  if (receipt.status !== "success") return null;
  await runVerification(driver, receipt, dispatch);
  return receipt;
}
