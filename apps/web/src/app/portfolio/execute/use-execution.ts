"use client";

import { rebalanceLogAbi } from "@equityos/contracts-abi";
import { useCallback, useReducer, useRef, useState } from "react";
import { type Abi, erc20Abi, type Hex, type TransactionReceipt } from "viem";
import { useConfig } from "wagmi";
import { getConnection, sendCalls, sendTransaction, waitForCallsStatus } from "wagmi/actions";
import {
  type BatchReceipt,
  type BatchState,
  batchOutcome,
  runSequential,
  type SequentialAction,
  type SequentialProgress,
  sequentialReducer,
  sequentialStart,
  type StepState,
} from "@/lib/execution/progress";
import { checkBatchReceipts, checkTransactionReceipt, type ReceiptsCheck } from "@/lib/execution/receipts";
import { type ExecutionRequest, type SequentialTransaction, sendPreconditions } from "@/lib/execution/request";
import type { ExecutionSnapshot } from "@/lib/execution/snapshot";
import type { VerifiedCall } from "@/lib/execution/verify";
import { classifyTxError } from "@/lib/tx/errors";
import { TX_IDLE, type TxEvent, txReducer } from "@/lib/tx/machine";
import { runTransaction, type TxDriver } from "@/lib/tx/run";
import { RECEIPT_TIMEOUT_MS, waitForReceipt } from "@/lib/tx/use-transaction";
import { readChainTime } from "./chain";

/** Errors of the contracts an execution calls, for decoding a refusal of the wallet or the node. */
const EXECUTION_ABI: Abi = [...erc20Abi, ...rebalanceLogAbi];

type Sequential = { readonly request: Extract<ExecutionRequest, { mode: "sequential" }> } & SequentialProgress;

export type ExecutionState =
  | { readonly mode: "none" }
  | {
      readonly mode: "atomic";
      readonly request: Extract<ExecutionRequest, { mode: "atomic" }>;
      readonly batch: BatchState;
    }
  | ({ readonly mode: "sequential" } & Sequential);

type Action =
  | { readonly type: "start_atomic"; readonly request: Extract<ExecutionRequest, { mode: "atomic" }> }
  | { readonly type: "start_sequential"; readonly request: Extract<ExecutionRequest, { mode: "sequential" }> }
  | { readonly type: "batch"; readonly event: TxEvent<ReceiptsCheck, string> }
  | { readonly type: "sequential"; readonly action: SequentialAction }
  | { readonly type: "reset" };

function reducer(state: ExecutionState, action: Action): ExecutionState {
  switch (action.type) {
    case "start_atomic":
      return { mode: "atomic", request: action.request, batch: TX_IDLE };
    case "start_sequential":
      return { mode: "sequential", request: action.request, ...sequentialStart(action.request.transactions.length) };
    case "batch":
      return state.mode === "atomic" ? { ...state, batch: txReducer(state.batch, action.event) } : state;
    case "sequential": {
      if (state.mode !== "sequential") return state;
      const { request, ...progress } = state;
      return { mode: "sequential", request, ...sequentialReducer(progress, action.action) };
    }
    case "reset":
      return { mode: "none" };
  }
}

const IN_FLIGHT: readonly StepState["status"][] = ["awaiting_signature", "submitted", "verifying"];

/** Whether anything of the execution is with the wallet or the chain now. */
export function executionInFlight(state: ExecutionState): boolean {
  if (state.mode === "atomic") return IN_FLIGHT.includes(state.batch.status);
  if (state.mode === "sequential") {
    return [...state.steps, state.attestation].some((step) => IN_FLIGHT.includes(step.status));
  }
  return false;
}

/**
 * Whether the snapshot was used: something reached the chain, or is with the wallet. A used snapshot is never
 * sent again; a plan whose request ended with nothing sent (declined, refused by the wallet) can be signed again.
 */
export function snapshotSpent(state: ExecutionState): boolean {
  const reached = (step: StepState | BatchState) =>
    step.status !== "idle" && step.status !== "rejected" && step.status !== "failed";
  if (state.mode === "atomic") return reached(state.batch);
  if (state.mode === "sequential") return state.stopped !== null || state.steps.some(reached);
  return false;
}

function callOf(snapshot: ExecutionSnapshot, index: number): VerifiedCall | null {
  return snapshot.verification.ok ? (snapshot.verification.calls[index] ?? null) : null;
}

/**
 * Sends an execution request and follows it. `execute` is called from the click handler of the button whose
 * label says what is signed, with the request `buildExecutionRequest` returned for that click; this hook never
 * sends on its own and never builds a request itself.
 */
export function useExecution(snapshot: ExecutionSnapshot) {
  const config = useConfig();
  const [state, dispatch] = useReducer(reducer, { mode: "none" });
  const [running, setRunning] = useState(false);
  const started = useRef(false);

  const transactionDriver = useCallback(
    (
      transaction: SequentialTransaction,
      expected: { readonly call: VerifiedCall | null; readonly attestation: boolean },
    ): TxDriver<TransactionReceipt, ReceiptsCheck> => ({
      send: () =>
        sendTransaction(config, {
          account: transaction.account,
          chainId: transaction.chainId,
          to: transaction.to,
          data: transaction.data,
          value: transaction.value,
        }),
      wait: (hash, onReplaced) => waitForReceipt(config, transaction.chainId, hash, onReplaced),
      verify: async (receipt) =>
        checkTransactionReceipt(receipt, {
          account: transaction.account,
          to: transaction.to,
          call: expected.call,
          attestation:
            expected.attestation && snapshot.attestation.status === "included" ? snapshot.attestation.call : null,
        }),
      classify: (error) => classifyTxError(EXECUTION_ABI, error),
    }),
    [config, snapshot],
  );

  const execute = useCallback(
    async (request: ExecutionRequest) => {
      if (started.current) return;
      started.current = true;
      setRunning(true);
      try {
        if (request.mode === "atomic") {
          dispatch({ type: "start_atomic", request });
          const calls = snapshot.verification.ok ? snapshot.verification.calls : [];
          const driver: TxDriver<BatchReceipt, ReceiptsCheck, string> = {
            send: async () => {
              const { sendCalls: parameters } = request;
              const { id } = await sendCalls(config, {
                account: parameters.account,
                chainId: parameters.chainId,
                calls: parameters.calls.map(({ to, data, value }) => ({ to, data, value })),
                forceAtomic: parameters.forceAtomic,
                ...(parameters.capabilities === undefined
                  ? {}
                  : { capabilities: { dataSuffix: { ...parameters.capabilities.dataSuffix } } }),
              });
              return id;
            },
            wait: async (id) => batchOutcome(await waitForCallsStatus(config, { id, timeout: RECEIPT_TIMEOUT_MS })),
            verify: async (outcome) =>
              checkBatchReceipts(outcome.receipts, {
                account: request.sendCalls.account,
                calls,
                attestation: snapshot.attestation.status === "included" ? snapshot.attestation.call : null,
              }),
            classify: (error) => classifyTxError(EXECUTION_ABI, error),
          };
          await runTransaction(driver, (event) => dispatch({ type: "batch", event }));
          return;
        }
        dispatch({ type: "start_sequential", request });
        await runSequential<TransactionReceipt>(request, {
          recheck: async () => {
            const chainTime = await readChainTime(config, request.chainId).catch(() => null);
            const connection = getConnection(config);
            return sendPreconditions(
              { account: request.account, chainId: request.chainId, expiresAt: request.expiresAt },
              connection.address ?? null,
              connection.chainId ?? null,
              chainTime,
            );
          },
          driver: (transaction, index) =>
            transactionDriver(transaction, { call: callOf(snapshot, index), attestation: false }),
          dispatch: (action) => dispatch({ type: "sequential", action }),
        });
      } finally {
        setRunning(false);
      }
    },
    [config, snapshot, transactionDriver],
  );

  /**
   * After a declined or refused request with nothing sent, lets the same verified plan be signed again. Never
   * after anything reached the chain.
   */
  const retry = useCallback(() => {
    if (snapshotSpent(state) || executionInFlight(state)) return;
    started.current = false;
    dispatch({ type: "reset" });
  }, [state]);

  /** Sends the optional attestation of the sequential path, with the transaction `buildAttestationRequest` returned. */
  const attest = useCallback(
    async (transaction: SequentialTransaction) => {
      setRunning(true);
      try {
        await runTransaction(transactionDriver(transaction, { call: null, attestation: true }), (event) =>
          dispatch({ type: "sequential", action: { type: "attestation", event } }),
        );
      } finally {
        setRunning(false);
      }
    },
    [transactionDriver],
  );

  return { state, execute, attest, retry, running };
}

/** The transactions of an execution that reached the chain, with what each did. */
export function sentTransactions(
  state: ExecutionState,
  label: (index: number) => string,
): { readonly hash: Hex; readonly label: string }[] {
  if (state.mode === "sequential") {
    const steps = state.steps.flatMap((step, index) =>
      "hash" in step ? [{ hash: step.hash, label: label(index) }] : [],
    );
    const attestation =
      "hash" in state.attestation ? [{ hash: state.attestation.hash, label: "Record the rebalance" }] : [];
    return [...steps, ...attestation];
  }
  if (state.mode === "atomic" && state.batch.status === "confirmed") {
    return state.batch.result.transactionHashes.map((hash) => ({ hash, label: "Batch" }));
  }
  return [];
}
