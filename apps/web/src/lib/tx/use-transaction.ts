"use client";

import { useCallback, useReducer, useRef } from "react";
import type { Abi, Hex, TransactionReceipt } from "viem";
import { useConfig } from "wagmi";
import { waitForTransactionReceipt } from "wagmi/actions";
import { classifyTxError } from "./errors";
import { TX_IDLE, type TxEvent, type TxState, txReducer } from "./machine";
import { runTransaction, runVerification, type Verification } from "./run";

/** How long a receipt is waited for before the transaction is reported as not found. */
export const RECEIPT_TIMEOUT_MS = 120_000;

export interface TransactionRequest<Result> {
  readonly chainId: number;
  /** ABI of the contract being called, used to decode a refusal. */
  readonly abi: Abi;
  /** Asks the wallet to sign and broadcast, and resolves with the hash. */
  readonly send: () => Promise<Hex>;
  /** Reads the chain to establish what the mined transaction did. Success is shown only if this passes. */
  readonly verify: (receipt: TransactionReceipt) => Promise<Verification<Result>>;
}

/**
 * State of one transaction and the two actions on it. `execute` must be called from the click handler of a
 * button whose label says what is sent: this hook never sends on its own.
 */
export function useTransaction<Result>() {
  const config = useConfig();
  const [state, dispatch] = useReducer(
    (current: TxState<Result>, event: TxEvent<Result>) => txReducer(current, event),
    TX_IDLE,
  );
  const last = useRef<{ request: TransactionRequest<Result>; receipt: TransactionReceipt } | null>(null);

  const execute = useCallback(
    async (request: TransactionRequest<Result>) => {
      last.current = null;
      const receipt = await runTransaction<TransactionReceipt, Result>(
        {
          send: request.send,
          wait: (hash, onReplaced) =>
            waitForTransactionReceipt(config, {
              hash,
              chainId: request.chainId,
              timeout: RECEIPT_TIMEOUT_MS,
              onReplaced: ({ reason, transaction }) => onReplaced({ reason, hash: transaction.hash }),
            }),
          verify: request.verify,
          classify: (error) => classifyTxError(request.abi, error),
        },
        dispatch,
      );
      if (receipt !== null) last.current = { request, receipt };
    },
    [config],
  );

  /** Repeats the check on the effect of a mined transaction, after one that failed or could not be made. */
  const recheck = useCallback(async () => {
    if (last.current === null) return;
    dispatch({ type: "recheck" });
    await runVerification(last.current.request, last.current.receipt, dispatch);
  }, []);

  const reset = useCallback(() => dispatch({ type: "reset" }), []);

  return { state, execute, recheck, reset };
}
